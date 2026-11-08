-- Обновление 4: сеть партнёров (этап 1).
--   * центр хранит указатели на сообщения, а зашифрованное содержимое лежит на узлах-партнёрах (2 копии)
--   * хеш содержимого и подпись отправителя: узел не может ни подделать, ни подменить данные
--   * жалобы на узлы и автоотключение после жалоб от 3 разных людей за сутки
-- Запускать ОДИН раз в Supabase (центр) → SQL Editor, после update-3.sql.

begin;

create or replace function public.is_creator(uid uuid)
returns boolean language sql security definer set search_path = '' stable as $$
  select exists (select 1 from public.profiles where id = uid and role = 'creator');
$$;

-- ---------- Узлы ----------
create table public.nodes (
  id uuid primary key default gen_random_uuid(),
  url text not null unique check (url ~ '^https://[a-z0-9]{20}\.supabase\.co$'),
  owner uuid default auth.uid() references public.profiles(id) on delete set null,
  status text not null default 'pending' check (status in ('pending', 'active', 'disabled')),
  disabled_reason text,
  created_at timestamptz not null default now()
);
alter table public.nodes enable row level security;
create policy "nodes: read" on public.nodes for select to authenticated
  using (status = 'active' or owner = auth.uid() or public.is_creator(auth.uid()));

create or replace function public.register_node(p_url text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare nid uuid;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if (select count(*) from public.nodes where owner = auth.uid()) >= 3 then raise exception 'too many nodes'; end if;
  insert into public.nodes (url, owner) values (lower(trim(trailing '/' from trim(p_url))), auth.uid())
    on conflict (url) do nothing returning id into nid;
  if nid is null then raise exception 'node already registered'; end if;
  return nid;
end;
$$;

create or replace function public.set_node_status(p_node uuid, p_status text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_creator(auth.uid()) then raise exception 'only creators manage nodes'; end if;
  update public.nodes set status = p_status,
    disabled_reason = case when p_status = 'disabled' then 'вручную' else null end
    where id = p_node;
  if p_status = 'active' then delete from public.node_reports where node_id = p_node; end if;
end;
$$;

create or replace function public.delete_node(p_node uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  delete from public.nodes where id = p_node and (owner = auth.uid() or public.is_creator(auth.uid()));
end;
$$;

-- ---------- Жалобы ----------
create table public.node_reports (
  node_id uuid not null references public.nodes(id) on delete cascade,
  reporter uuid not null references public.profiles(id) on delete cascade,
  reason text check (char_length(reason) <= 120),
  created_at timestamptz not null default now(),
  primary key (node_id, reporter)
);
alter table public.node_reports enable row level security;
create policy "node_reports: creators read" on public.node_reports for select to authenticated
  using (public.is_creator(auth.uid()));

create or replace function public.report_node(p_node uuid, p_reason text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  insert into public.node_reports (node_id, reporter, reason) values (p_node, auth.uid(), left(p_reason, 120))
    on conflict (node_id, reporter) do update set reason = excluded.reason, created_at = now();
  if (select count(*) from public.node_reports
      where node_id = p_node and created_at > now() - interval '24 hours') >= 3 then
    update public.nodes set status = 'disabled', disabled_reason = 'автоматически: жалобы'
      where id = p_node and status = 'active';
  end if;
end;
$$;

create or replace function public.node_stats()
returns table (id uuid, url text, status text, disabled_reason text, owner_username text, reports_24h bigint, created_at timestamptz)
language sql security definer set search_path = '' stable as $$
  select n.id, n.url, n.status, n.disabled_reason, p.username,
         (select count(*) from public.node_reports r where r.node_id = n.id and r.created_at > now() - interval '24 hours'),
         n.created_at
  from public.nodes n left join public.profiles p on p.id = n.owner
  where public.is_creator(auth.uid()) or n.owner = auth.uid()
  order by n.created_at;
$$;

-- ---------- Ключ подписи ----------
alter table public.user_keys add column signing_key jsonb;
alter table public.key_backups add column signing_wrapped jsonb;

-- ---------- Сообщения: указатель + хеш + подпись ----------
alter table public.messages
  add column cid uuid,
  add column ct_hash text check (ct_hash ~ '^[0-9a-f]{64}$'),
  add column sig text check (char_length(sig) <= 200),
  add column nodes uuid[];
create unique index messages_cid_idx on public.messages (cid) where cid is not null;

alter table public.messages drop constraint messages_e2ee_check;
alter table public.messages add constraint messages_e2ee_check check (
  content = '' and image_path is null
  and iv is not null and char_length(iv) between 12 and 32
  and (
    (ct is not null and char_length(ct) <= 60000)
    or (ct is null and ct_hash is not null and coalesce(array_length(nodes, 1), 0) between 1 and 5)
  )
);

create or replace function public.protect_message_update()
returns trigger language plpgsql as $$
begin
  if current_user in ('authenticated', 'anon') then
    if new.sender_id <> old.sender_id or new.conversation_id <> old.conversation_id
       or new.created_at <> old.created_at or new.push_sent <> old.push_sent
       or new.cid is distinct from old.cid then
      raise exception 'only the text can be edited';
    end if;
    new.edited_at := now();
  end if;
  return new;
end;
$$;

-- Список чатов: для последнего сообщения отдаём и указатель на узлы
drop function public.my_chats();
create function public.my_chats()
returns table (
  id uuid, is_group boolean, title text, is_official boolean, archived boolean,
  last_message_at timestamptz, last_read_at timestamptz,
  last_ct text, last_iv text, last_sender uuid, last_hash text, last_nodes uuid[], last_cid uuid, last_sig text,
  member_ids uuid[]
) language sql security definer set search_path = '' stable as $$
  select c.id, c.is_group, c.title, c.is_official, cm.archived, c.last_message_at, cm.last_read_at,
         lm.ct, lm.iv, lm.sender_id, lm.ct_hash, lm.nodes, lm.cid, lm.sig,
         (select array_agg(x.user_id) from public.conversation_members x where x.conversation_id = c.id)
  from public.conversation_members cm
  join public.conversations c on c.id = cm.conversation_id
  left join lateral (
    select m.ct, m.iv, m.sender_id, m.ct_hash, m.nodes, m.cid, m.sig from public.messages m
    where m.conversation_id = c.id order by m.created_at desc limit 1
  ) lm on true
  where cm.user_id = auth.uid()
  order by c.is_official desc, c.last_message_at desc;
$$;

revoke execute on function public.my_chats() from anon;
revoke execute on function public.register_node(text) from anon;
revoke execute on function public.set_node_status(uuid, text) from anon;
revoke execute on function public.delete_node(uuid) from anon;
revoke execute on function public.report_node(uuid, text) from anon;
revoke execute on function public.node_stats() from anon;

commit;
