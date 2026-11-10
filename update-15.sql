-- update-15: закреплённые чаты (свой порядок, синхронно на всех устройствах) и канал «Новости» для всех.
--   conversation_members.pin_order — место закреплённого чата (1, 2, 3…), null — не закреплён. До 10 закреплённых.
--   set_pins(ids) — одним вызовом задать закреплённые чаты в нужном порядке.
--   news — новости: пишет только создатель, читают все вошедшие; news_reactions — реакции (свои ставит каждый).
--   Админка создателя: admin_users() / admin_stats(), любые значки любому (set_badge), бан (ban_user / unban_user).
--   Смена ника раз в 30 дней (change_username); старый ник ещё 30 дней ведёт на человека (username_aliases).
-- Безопасно применять повторно.
begin;

-- ---------- Закреплённые чаты ----------
alter table public.conversation_members add column if not exists pin_order int check (pin_order between 1 and 10);
grant update (pin_order) on public.conversation_members to authenticated;

create or replace function public.set_pins(p_ids uuid[])
returns void language plpgsql security definer set search_path = '' as $$
declare i int := 0; cid uuid;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if coalesce(array_length(p_ids, 1), 0) > 10 then raise exception 'too many pins'; end if;
  update public.conversation_members set pin_order = null
    where user_id = auth.uid() and pin_order is not null and not (conversation_id = any (coalesce(p_ids, '{}')));
  foreach cid in array coalesce(p_ids, '{}') loop
    i := i + 1;
    update public.conversation_members set pin_order = i where user_id = auth.uid() and conversation_id = cid;
  end loop;
end;
$$;
revoke execute on function public.set_pins(uuid[]) from public, anon;
grant execute on function public.set_pins(uuid[]) to authenticated;

-- my_chats: + pin_order (тип результата меняется — пересоздаём)
drop function if exists public.my_chats();
create function public.my_chats()
returns table (id uuid, is_group boolean, title text, is_official boolean, archived boolean, key_version integer, key_checks jsonb,
  last_message_at timestamptz, last_read_at timestamptz, last_ct text, last_iv text, last_sender uuid, last_hash text,
  last_nodes uuid[], last_cid uuid, last_sig text, last_key_version integer, member_ids uuid[], pin_order integer)
language sql stable security definer set search_path = '' as $$
  select c.id, c.is_group, c.title, c.is_official, cm.archived, c.key_version, c.key_checks,
         c.last_message_at, cm.last_read_at,
         lm.ct, lm.iv, lm.sender_id, lm.ct_hash, lm.nodes, lm.cid, lm.sig, lm.key_version,
         (select array_agg(x.user_id) from public.conversation_members x where x.conversation_id = c.id),
         cm.pin_order
  from public.conversation_members cm
  join public.conversations c on c.id = cm.conversation_id
  left join lateral (
    select m.ct, m.iv, m.sender_id, m.ct_hash, m.nodes, m.cid, m.sig, m.key_version from public.messages m
    where m.conversation_id = c.id order by m.created_at desc limit 1
  ) lm on true
  where cm.user_id = auth.uid()
  order by c.is_official desc, c.last_message_at desc;
$$;
revoke execute on function public.my_chats() from public, anon;
grant execute on function public.my_chats() to authenticated;

-- ---------- Канал «Новости» ----------
create table if not exists public.news (
  id bigint generated always as identity primary key,
  author uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  body text not null check (char_length(body) between 1 and 4000),
  created_at timestamptz not null default now(),
  edited_at timestamptz
);
create index if not exists news_created on public.news (created_at desc);
alter table public.news enable row level security;
revoke all on public.news from anon, authenticated;
grant select, insert, delete on public.news to authenticated;
grant update (body) on public.news to authenticated;
drop policy if exists "news: read" on public.news;
create policy "news: read" on public.news for select to authenticated using (true);
drop policy if exists "news: creator writes" on public.news;
create policy "news: creator writes" on public.news for insert to authenticated
  with check (author = (select auth.uid()) and public.is_creator((select auth.uid())));
drop policy if exists "news: creator edits" on public.news;
create policy "news: creator edits" on public.news for update to authenticated
  using (public.is_creator((select auth.uid()))) with check (public.is_creator((select auth.uid())));
drop policy if exists "news: creator deletes" on public.news;
create policy "news: creator deletes" on public.news for delete to authenticated
  using (public.is_creator((select auth.uid())));

-- время ставит сервер; правка отмечается сама
create or replace function public.protect_news()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then new.created_at := now(); new.edited_at := null;
  elsif new.body is distinct from old.body then new.edited_at := now(); new.created_at := old.created_at; new.author := old.author;
  end if;
  return new;
end;
$$;
revoke execute on function public.protect_news() from public, anon, authenticated;
drop trigger if exists news_protect on public.news;
create trigger news_protect before insert or update on public.news for each row execute function public.protect_news();

create table if not exists public.news_reactions (
  news_id bigint not null references public.news(id) on delete cascade,
  user_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  emoji text not null check (char_length(emoji) between 1 and 16),
  created_at timestamptz not null default now(),
  primary key (news_id, user_id, emoji)
);
alter table public.news_reactions enable row level security;
revoke all on public.news_reactions from anon, authenticated;
grant select, insert, delete on public.news_reactions to authenticated;
drop policy if exists "news_reactions: read" on public.news_reactions;
create policy "news_reactions: read" on public.news_reactions for select to authenticated using (true);
drop policy if exists "news_reactions: own" on public.news_reactions;
create policy "news_reactions: own" on public.news_reactions for insert to authenticated
  with check (user_id = (select auth.uid()) and (select count(*) from public.news_reactions r where r.news_id = news_reactions.news_id and r.user_id = (select auth.uid())) < 3);
drop policy if exists "news_reactions: remove own" on public.news_reactions;
create policy "news_reactions: remove own" on public.news_reactions for delete to authenticated
  using (user_id = (select auth.uid()));

-- новости и реакции приходят сразу (Realtime). У реакций ключ = все поля, поэтому DELETE тоже несёт смысл.
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'news') then
      alter publication supabase_realtime add table public.news;
    end if;
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'news_reactions') then
      alter publication supabase_realtime add table public.news_reactions;
    end if;
  end if;
end $$;


-- ---------- Админка: значки любому ----------
create or replace function public.set_badge(p_username text, p_kind text, p_on boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare uid uuid;
begin
  if not public.is_creator(auth.uid()) then raise exception 'only creators can grant badges'; end if;
  if p_kind not in ('donor', 'tester', 'bronze', 'silver', 'gold', 'plus', 'relay') then raise exception 'bad badge'; end if;
  select id into uid from public.profiles where username = lower(trim(both '@ ' from p_username));
  if uid is null then raise exception 'user not found'; end if;
  if p_on then insert into public.badge_grants (user_id, kind) values (uid, p_kind) on conflict do nothing;
  else delete from public.badge_grants where user_id = uid and kind = p_kind; end if;
end;
$$;

-- ---------- Бан ----------
create table if not exists public.bans (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  reason text check (char_length(reason) <= 200),
  until timestamptz,                      -- null = навсегда
  by_user uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
alter table public.bans enable row level security;
revoke all on public.bans from anon, authenticated;

create or replace function public.is_banned(uid uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.bans b where b.user_id = uid and (b.until is null or b.until > now()));
$$;
revoke execute on function public.is_banned(uuid) from public, anon;
grant execute on function public.is_banned(uuid) to authenticated;

-- забаненный не пишет сообщения, реакции и не создаёт чаты (ограничивающие правила поверх обычных)
drop policy if exists "messages: not banned" on public.messages;
create policy "messages: not banned" on public.messages as restrictive for insert to authenticated with check (not public.is_banned((select auth.uid())));
drop policy if exists "reactions: not banned" on public.reactions;
create policy "reactions: not banned" on public.reactions as restrictive for insert to authenticated with check (not public.is_banned((select auth.uid())));
drop policy if exists "news_reactions: not banned" on public.news_reactions;
create policy "news_reactions: not banned" on public.news_reactions as restrictive for insert to authenticated with check (not public.is_banned((select auth.uid())));

create or replace function public.ban_user(p_username text, p_days int, p_reason text)
returns void language plpgsql security definer set search_path = '' as $$
declare uid uuid; till timestamptz;
begin
  if not public.is_creator(auth.uid()) then raise exception 'only creators can ban'; end if;
  select id into uid from public.profiles where username = lower(trim(both '@ ' from p_username));
  if uid is null then raise exception 'user not found'; end if;
  if public.is_creator(uid) then raise exception 'cannot ban a creator'; end if;
  till := case when p_days is null or p_days <= 0 then null else now() + make_interval(days => least(p_days, 3650)) end;
  insert into public.bans (user_id, reason, until, by_user) values (uid, left(p_reason, 200), till, auth.uid())
    on conflict (user_id) do update set reason = excluded.reason, until = excluded.until, by_user = excluded.by_user, created_at = now();
  -- вход тоже закрываем (Supabase Auth не выдаст новые токены)
  update auth.users set banned_until = coalesce(till, 'infinity'::timestamptz) where id = uid;
end;
$$;
create or replace function public.unban_user(p_username text)
returns void language plpgsql security definer set search_path = '' as $$
declare uid uuid;
begin
  if not public.is_creator(auth.uid()) then raise exception 'only creators can ban'; end if;
  select id into uid from public.profiles where username = lower(trim(both '@ ' from p_username));
  if uid is null then raise exception 'user not found'; end if;
  delete from public.bans where user_id = uid;
  update auth.users set banned_until = null where id = uid;
end;
$$;
revoke execute on function public.ban_user(text, int, text), public.unban_user(text) from public, anon;
grant execute on function public.ban_user(text, int, text), public.unban_user(text) to authenticated;

-- ---------- Админка: люди и статистика ----------
create or replace function public.admin_users(p_q text default '', p_limit int default 50, p_offset int default 0)
returns table (id uuid, username text, display_name text, role text, created_at timestamptz, seen_at timestamptz,
  banned boolean, ban_until timestamptz, ban_reason text, badges text[], nodes int, turns int, msgs bigint, tier text)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_creator(auth.uid()) then raise exception 'only creators'; end if;
  return query
  select p.id, p.username, p.display_name, p.role, p.created_at, ls.seen_at,
         (b.user_id is not null and (b.until is null or b.until > now())), b.until, b.reason,
         coalesce((select array_agg(g.kind order by g.kind) from public.badge_grants g where g.user_id = p.id), '{}'),
         (select count(*)::int from public.nodes n where n.owner = p.id and n.status = 'active'),
         (select count(*)::int from public.turn_providers t where t.owner = p.id and t.status = 'active'),
         (select count(*) from public.messages m where m.sender_id = p.id),
         ps.tier
  from public.profiles p
  left join public.last_seen ls on ls.user_id = p.id
  left join public.bans b on b.user_id = p.id
  left join public.partner_state ps on ps.user_id = p.id and ps.active
  where coalesce(p_q, '') = '' or p.username ilike '%' || p_q || '%' or p.display_name ilike '%' || p_q || '%'
  order by ls.seen_at desc nulls last, p.created_at desc
  limit least(greatest(p_limit, 1), 200) offset greatest(p_offset, 0);
end;
$$;
create or replace function public.admin_stats()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_creator(auth.uid()) then raise exception 'only creators'; end if;
  return jsonb_build_object(
    'users', (select count(*) from public.profiles),
    'new_week', (select count(*) from public.profiles where created_at > now() - interval '7 days'),
    'active_day', (select count(*) from public.last_seen where seen_at > now() - interval '1 day'),
    'active_week', (select count(*) from public.last_seen where seen_at > now() - interval '7 days'),
    'messages', (select count(*) from public.messages),
    'messages_day', (select count(*) from public.messages where created_at > now() - interval '1 day'),
    'chats', (select count(*) from public.conversations),
    'groups', (select count(*) from public.conversations where is_group),
    'db_bytes', pg_database_size(current_database()),
    'storage_bytes', (select coalesce(sum((o.metadata->>'size')::bigint), 0) from storage.objects o),
    'nodes_active', (select count(*) from public.nodes where status = 'active'),
    'nodes_total', (select count(*) from public.nodes),
    'turn_active', (select count(*) from public.turn_providers where status = 'active' and last_ok > now() - interval '2 days'),
    'turn_total', (select count(*) from public.turn_providers),
    'calls_day', (select count(distinct call_id) from public.call_reports where created_at > now() - interval '1 day'),
    'calls_ok_day', (select count(distinct call_id) from public.call_reports where created_at > now() - interval '1 day' and status = 'ok'),
    'banned', (select count(*) from public.bans where until is null or until > now())
  );
end;
$$;
revoke execute on function public.admin_users(text, int, int), public.admin_stats() from public, anon;
grant execute on function public.admin_users(text, int, int), public.admin_stats() to authenticated;

-- ---------- Смена ника: раз в 30 дней, старый ник 30 дней ведёт на человека ----------
alter table public.profiles add column if not exists username_changed_at timestamptz;
create table if not exists public.username_aliases (
  alias text primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  until timestamptz not null
);
alter table public.username_aliases enable row level security;
revoke all on public.username_aliases from anon, authenticated;
grant select on public.username_aliases to authenticated;
drop policy if exists "aliases: read active" on public.username_aliases;
create policy "aliases: read active" on public.username_aliases for select to authenticated using (until > now());

create or replace function public.username_available(name text)
returns boolean language sql stable security definer set search_path = '' as $$
  select not exists (select 1 from public.profiles where username = lower(name))
     and not exists (select 1 from public.username_aliases where alias = lower(name) and until > now());
$$;

create or replace function public.change_username(p_new text)
returns text language plpgsql security definer set search_path = '' as $$
declare u text := lower(trim(both '@ ' from p_new)); old text; last timestamptz;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if public.is_banned(auth.uid()) then raise exception 'banned'; end if;
  if u !~ '^[a-z0-9_]{3,24}$' then raise exception 'bad username'; end if;
  select username, username_changed_at into old, last from public.profiles where id = auth.uid();
  if u = old then return u; end if;
  if last is not null and last > now() - interval '30 days' and not public.is_creator(auth.uid()) then
    raise exception 'username change too soon: %', to_char(last + interval '30 days', 'DD.MM.YYYY');
  end if;
  if exists (select 1 from public.profiles where username = u)
     or exists (select 1 from public.username_aliases where alias = u and until > now() and user_id <> auth.uid()) then
    raise exception 'username taken';
  end if;
  delete from public.username_aliases where alias = u;          -- свой же старый ник можно вернуть
  insert into public.username_aliases (alias, user_id, until) values (old, auth.uid(), now() + interval '30 days')
    on conflict (alias) do update set user_id = excluded.user_id, until = excluded.until;
  update public.profiles set username = u, username_changed_at = now() where id = auth.uid();
  return u;
end;
$$;
revoke execute on function public.change_username(text) from public, anon;
grant execute on function public.change_username(text) to authenticated;

commit;
