-- Обновление 5: закрываем дыры в управлении ключами.
--   1. Ключ чата меняется автоматически, когда участник выходит или его удаляют:
--      бывший участник не получит новый ключ и не прочитает новые сообщения.
--   2. Чужой действующий ключ нельзя перезаписать. Новый можно выдать только для актуального
--      публичного ключа получателя. Свой испорченный ключ можно удалить, чтобы получить заново.
--   3. Контроль ключа: при создании ключа чата сохраняется его «отпечаток». Приложение отвергает
--      ключ, который не совпадает с отпечатком, поэтому подсунуть чужой ключ нельзя.
--   4. Писать можно только актуальной версией ключа.
-- Запускать ОДИН раз в Supabase (центр) → SQL Editor, после update-4.sql.

begin;

-- ---------- Версии ключа чата ----------
alter table public.conversations
  add column key_version int not null default 1,
  add column key_checks jsonb not null default '{}'::jsonb;    -- версия -> sha-256 отпечаток ключа

alter table public.conversation_keys add column version int not null default 1;
alter table public.conversation_keys drop constraint conversation_keys_pkey;
alter table public.conversation_keys add primary key (conversation_id, user_id, version);

alter table public.conversation_key_claims add column version int not null default 1;
alter table public.conversation_key_claims drop constraint conversation_key_claims_pkey;
alter table public.conversation_key_claims add primary key (conversation_id, version);

alter table public.messages add column key_version int not null default 1;

-- Участник вышел или удалён из группы → новая версия ключа
create or replace function public.rotate_on_leave()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update public.conversations set key_version = key_version + 1
    where id = old.conversation_id and is_group;
  return old;
end;
$$;
create trigger members_rotate_on_leave
  after delete on public.conversation_members
  for each row execute function public.rotate_on_leave();

-- ---------- Кто может выдавать ключи ----------
create or replace function public.current_fingerprint(uid uuid)
returns text language sql security definer set search_path = '' stable as $$
  select fingerprint from public.user_keys where user_id = uid;
$$;
create or replace function public.current_key_version(conv uuid)
returns int language sql security definer set search_path = '' stable as $$
  select key_version from public.conversations where id = conv;
$$;

-- wrapped_by всегда = тот, кто выдал
create or replace function public.stamp_wrapped_by()
returns trigger language plpgsql as $$
begin
  if current_user in ('authenticated', 'anon') then new.wrapped_by := auth.uid(); end if;
  return new;
end;
$$;
create trigger conversation_keys_stamp
  before insert or update on public.conversation_keys
  for each row execute function public.stamp_wrapped_by();

drop policy "conversation_keys: members share" on public.conversation_keys;
drop policy "conversation_keys: members reshare" on public.conversation_keys;

-- Выдать: только участнику, только для его текущего публичного ключа, только существующей версии
create policy "conversation_keys: share" on public.conversation_keys for insert to authenticated
  with check (
    public.is_member(conversation_id)
    and exists (select 1 from public.conversation_members m
                where m.conversation_id = conversation_keys.conversation_id and m.user_id = conversation_keys.user_id)
    and for_fingerprint = public.current_fingerprint(user_id)
    and version between 1 and public.current_key_version(conversation_id)
  );
-- Перевыдать: только устаревшую запись (получатель сменил ключ), и только для его нового ключа
create policy "conversation_keys: reshare stale" on public.conversation_keys for update to authenticated
  using (
    public.is_member(conversation_id)
    and for_fingerprint is distinct from public.current_fingerprint(user_id)
  )
  with check (
    public.is_member(conversation_id)
    and for_fingerprint = public.current_fingerprint(user_id)
  );
-- Удалить свою запись (если ключ оказался испорченным — его выдадут заново)
create policy "conversation_keys: delete own" on public.conversation_keys for delete to authenticated
  using (user_id = auth.uid());

-- Создать ключ новой версии: только один участник, вместе с отпечатком ключа
drop function public.claim_conversation_key(uuid);
create or replace function public.claim_conversation_key(conv uuid, p_check text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v int;
  w uuid;
begin
  if not public.is_member(conv) then raise exception 'not a member'; end if;
  if p_check !~ '^[0-9a-f]{64}$' then raise exception 'bad check'; end if;
  select key_version into v from public.conversations where id = conv for update;
  if exists (select 1 from public.conversation_keys where conversation_id = conv and version = v) then return false; end if;
  insert into public.conversation_key_claims as k (conversation_id, version, claimed_by)
    values (conv, v, auth.uid())
  on conflict (conversation_id, version) do update
    set claimed_by = excluded.claimed_by, claimed_at = now()
    where k.claimed_at < now() - interval '30 seconds'
  returning claimed_by into w;
  if w is distinct from auth.uid()
     and not exists (select 1 from public.conversation_key_claims
                     where conversation_id = conv and version = v and claimed_by = auth.uid()) then
    return false;
  end if;
  update public.conversations set key_checks = key_checks || jsonb_build_object(v::text, p_check) where id = conv;
  return true;
end;
$$;
revoke execute on function public.claim_conversation_key(uuid, text) from anon;

-- ---------- Писать — только актуальной версией ключа ----------
drop policy "messages: members send" on public.messages;
create policy "messages: members send"
  on public.messages for insert to authenticated
  with check (
    sender_id = auth.uid()
    and public.is_member(conversation_id)
    and key_version = public.current_key_version(conversation_id)
    and (image_path is null or image_path like conversation_id::text || '/%')
    and (
      public.is_staff(auth.uid())
      or not exists (select 1 from public.conversations c where c.id = conversation_id and c.is_official)
    )
    and not exists (
      select 1 from public.conversations c
      join public.conversation_members m on m.conversation_id = c.id
      where c.id = conversation_id and not c.is_group
        and m.user_id <> auth.uid() and public.is_blocked_between(auth.uid(), m.user_id)
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
    if new.key_version <> public.current_key_version(new.conversation_id) then
      raise exception 'stale key version';
    end if;
    new.edited_at := now();
  end if;
  return new;
end;
$$;

-- ---------- Список чатов: версия ключа и отпечатки ----------
drop function public.my_chats();
create function public.my_chats()
returns table (
  id uuid, is_group boolean, title text, is_official boolean, archived boolean,
  key_version int, key_checks jsonb,
  last_message_at timestamptz, last_read_at timestamptz,
  last_ct text, last_iv text, last_sender uuid, last_hash text, last_nodes uuid[], last_cid uuid, last_sig text,
  last_key_version int,
  member_ids uuid[]
) language sql security definer set search_path = '' stable as $$
  select c.id, c.is_group, c.title, c.is_official, cm.archived, c.key_version, c.key_checks,
         c.last_message_at, cm.last_read_at,
         lm.ct, lm.iv, lm.sender_id, lm.ct_hash, lm.nodes, lm.cid, lm.sig, lm.key_version,
         (select array_agg(x.user_id) from public.conversation_members x where x.conversation_id = c.id)
  from public.conversation_members cm
  join public.conversations c on c.id = cm.conversation_id
  left join lateral (
    select m.ct, m.iv, m.sender_id, m.ct_hash, m.nodes, m.cid, m.sig, m.key_version from public.messages m
    where m.conversation_id = c.id order by m.created_at desc limit 1
  ) lm on true
  where cm.user_id = auth.uid()
  order by c.is_official desc, c.last_message_at desc;
$$;
revoke execute on function public.my_chats() from anon;

commit;
