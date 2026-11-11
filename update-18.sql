-- update-18: модераторы.
--   Два уровня: «модератор» (список людей, бан на 1–7 дней, разбан) и «старший модератор»
--   (то же + бан на любой срок и навсегда, статистика, может банить модераторов).
--   Выдаёт и снимает только создатель (set_moderator), можно на время (p_minutes) — потом права пропадают сами.
--   Никто, кроме создателя, не может: роли, значки, донаты, новости, узлы. Создателя забанить нельзя.
--   Всё, что делают модераторы, пишется в журнал mod_log (читает только создатель).
--   В конце: @skitle — модератор, @peteroxhka — старший модератор на 30 минут (проверка).
--   Повторное применение безопасно, но заново отсчитает 30 минут.
begin;

create table if not exists public.moderators (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  level text not null check (level in ('moderator', 'senior')),
  until timestamptz,                                   -- null = без срока
  by_user uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
alter table public.moderators enable row level security;
revoke all on public.moderators from anon, authenticated;

create table if not exists public.mod_log (
  id bigint generated always as identity primary key,
  actor uuid references public.profiles(id) on delete set null,
  action text not null,
  target uuid references public.profiles(id) on delete set null,
  details text,
  created_at timestamptz not null default now()
);
create index if not exists mod_log_created_idx on public.mod_log (created_at desc);
alter table public.mod_log enable row level security;
revoke all on public.mod_log from anon, authenticated;

-- 3 — создатель, 2 — старший модератор, 1 — модератор, 0 — никто (в т.ч. если срок вышел или сам забанен)
create or replace function public.mod_level(uid uuid)
returns int language sql stable security definer set search_path = '' as $$
  select case
    when uid is null or public.is_banned(uid) then 0
    when public.is_creator(uid) then 3
    else coalesce((select case m.level when 'senior' then 2 else 1 end from public.moderators m
                   where m.user_id = uid and (m.until is null or m.until > now())), 0)
  end;
$$;
revoke execute on function public.mod_level(uuid) from public, anon, authenticated;

create or replace function public.set_moderator(p_username text, p_level text, p_minutes int default null)
returns void language plpgsql security definer set search_path = '' as $$
declare uid uuid; till timestamptz;
begin
  if not public.is_creator(auth.uid()) then raise exception 'only creators manage moderators'; end if;
  select id into uid from public.profiles where username = lower(trim(both '@ ' from p_username));
  if uid is null then raise exception 'user not found'; end if;
  if public.is_creator(uid) then raise exception 'creator is already above moderators'; end if;
  if p_level is null then
    delete from public.moderators where user_id = uid;
    insert into public.mod_log (actor, action, target) values (auth.uid(), 'mod_off', uid);
    return;
  end if;
  if p_level not in ('moderator', 'senior') then raise exception 'bad moderator level'; end if;
  till := case when p_minutes is null or p_minutes <= 0 then null else now() + make_interval(mins => least(p_minutes, 525600)) end;
  insert into public.moderators (user_id, level, until, by_user) values (uid, p_level, till, auth.uid())
    on conflict (user_id) do update set level = excluded.level, until = excluded.until, by_user = excluded.by_user, created_at = now();
  insert into public.mod_log (actor, action, target, details)
    values (auth.uid(), 'mod_on', uid, p_level || coalesce(' на ' || p_minutes || ' мин', ''));
end;
$$;
revoke execute on function public.set_moderator(text, text, int) from public, anon;
grant execute on function public.set_moderator(text, text, int) to authenticated;

-- ---------- Бан: теперь и модераторы, каждый — только тех, кто ниже ----------
create or replace function public.ban_user(p_username text, p_days int, p_reason text)
returns void language plpgsql security definer set search_path = '' as $$
declare uid uuid; till timestamptz; lvl int := public.mod_level(auth.uid()); old public.bans;
begin
  if lvl < 1 then raise exception 'only creators can ban'; end if;
  select id into uid from public.profiles where username = lower(trim(both '@ ' from p_username));
  if uid is null then raise exception 'user not found'; end if;
  if public.is_creator(uid) then raise exception 'cannot ban a creator'; end if;
  if uid = auth.uid() or public.mod_level(uid) >= lvl then
    raise exception 'cannot ban your level or higher';
  end if;
  if lvl = 1 and (p_days is null or p_days < 1 or p_days > 7) then raise exception 'moderators ban for 1 to 7 days'; end if;
  select * into old from public.bans b where b.user_id = uid and (b.until is null or b.until > now());
  if old.user_id is not null and old.by_user is distinct from auth.uid() and public.mod_level(old.by_user) > lvl then
    raise exception 'ban was set by someone higher';
  end if;
  till := case when p_days is null or p_days <= 0 then null else now() + make_interval(days => least(p_days, 3650)) end;
  insert into public.bans (user_id, reason, until, by_user) values (uid, left(p_reason, 200), till, auth.uid())
    on conflict (user_id) do update set reason = excluded.reason, until = excluded.until, by_user = excluded.by_user, created_at = now();
  update auth.users set banned_until = coalesce(till, 'infinity'::timestamptz) where id = uid;
  insert into public.mod_log (actor, action, target, details)
    values (auth.uid(), 'ban', uid, (case when till is null then 'навсегда' else p_days || ' дн.' end) || coalesce(': ' || left(p_reason, 200), ''));
end;
$$;
create or replace function public.unban_user(p_username text)
returns void language plpgsql security definer set search_path = '' as $$
declare uid uuid; lvl int := public.mod_level(auth.uid()); old public.bans;
begin
  if lvl < 1 then raise exception 'only creators can ban'; end if;
  select id into uid from public.profiles where username = lower(trim(both '@ ' from p_username));
  if uid is null then raise exception 'user not found'; end if;
  select * into old from public.bans b where b.user_id = uid;
  if old.user_id is null then return; end if;
  if old.by_user is distinct from auth.uid() and public.mod_level(old.by_user) > lvl then
    raise exception 'ban was set by someone higher';
  end if;
  delete from public.bans where user_id = uid;
  update auth.users set banned_until = null where id = uid;
  insert into public.mod_log (actor, action, target) values (auth.uid(), 'unban', uid);
end;
$$;
revoke execute on function public.ban_user(text, int, text), public.unban_user(text) from public, anon;
grant execute on function public.ban_user(text, int, text), public.unban_user(text) to authenticated;

-- ---------- Админка: список людей — всем модераторам, статистика — от старшего ----------
drop function if exists public.admin_users(text, int, int);
create function public.admin_users(p_q text default '', p_limit int default 50, p_offset int default 0)
returns table (id uuid, username text, display_name text, role text, created_at timestamptz, seen_at timestamptz,
  banned boolean, ban_until timestamptz, ban_reason text, badges text[], nodes int, turns int, msgs bigint, tier text,
  mod text, mod_until timestamptz, banned_by text)
language plpgsql stable security definer set search_path = '' as $$
begin
  if public.mod_level(auth.uid()) < 1 then raise exception 'only creators'; end if;
  return query
  select p.id, p.username, p.display_name, p.role, p.created_at, ls.seen_at,
         (b.user_id is not null and (b.until is null or b.until > now())), b.until, b.reason,
         coalesce((select array_agg(g.kind order by g.kind) from public.badge_grants g where g.user_id = p.id), '{}'),
         (select count(*)::int from public.nodes n where n.owner = p.id and n.status = 'active'),
         (select count(*)::int from public.turn_providers t where t.owner = p.id and t.status = 'active'),
         (select count(*) from public.messages m where m.sender_id = p.id),
         ps.tier,
         mo.level, mo.until,
         (select bp.username from public.profiles bp where bp.id = b.by_user)
  from public.profiles p
  left join public.last_seen ls on ls.user_id = p.id
  left join public.bans b on b.user_id = p.id
  left join public.partner_state ps on ps.user_id = p.id and ps.active
  left join public.moderators mo on mo.user_id = p.id and (mo.until is null or mo.until > now())
  where coalesce(p_q, '') = '' or p.username ilike '%' || p_q || '%' or p.display_name ilike '%' || p_q || '%'
  order by ls.seen_at desc nulls last, p.created_at desc
  limit least(greatest(p_limit, 1), 200) offset greatest(p_offset, 0);
end;
$$;
revoke execute on function public.admin_users(text, int, int) from public, anon;
grant execute on function public.admin_users(text, int, int) to authenticated;

-- admin_stats: то же тело, что в update-15, но пускает и старшего модератора
do $$
declare src text;
begin
  select pg_get_functiondef('public.admin_stats()'::regprocedure) into src;
  if position('public.mod_level(auth.uid()) < 2' in src) = 0 then
    src := replace(src, 'not public.is_creator(auth.uid())', 'public.mod_level(auth.uid()) < 2');
    execute src;
  end if;
end $$;

create or replace function public.mod_log_list(p_limit int default 100)
returns table (id bigint, actor text, action text, target text, details text, created_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_creator(auth.uid()) then raise exception 'only creators'; end if;
  return query
  select l.id, a.username, l.action, t.username, l.details, l.created_at
  from public.mod_log l
  left join public.profiles a on a.id = l.actor
  left join public.profiles t on t.id = l.target
  order by l.created_at desc limit least(greatest(p_limit, 1), 500);
end;
$$;
revoke execute on function public.mod_log_list(int) from public, anon;
grant execute on function public.mod_log_list(int) to authenticated;

-- ---------- Значок модератора виден всем (через badges_list) ----------
create or replace function public.badges_list()
returns table (user_id uuid, kind text, granted boolean) language sql stable security definer set search_path = '' as $$
  select distinct t.owner, 'relay'::text, false from public.turn_providers t
    where t.status = 'active' and t.last_ok > now() - interval '2 days'
  union all
  select g.user_id, g.kind, true from public.badge_grants g
    where not (g.kind = 'relay' and exists (select 1 from public.turn_providers t
      where t.owner = g.user_id and t.status = 'active' and t.last_ok > now() - interval '2 days'))
  union all
  select m.user_id, m.level, true from public.moderators m
    where (m.until is null or m.until > now()) and not public.is_banned(m.user_id);
$$;

alter table public.profiles drop constraint if exists profiles_hidden_badges_check;
alter table public.profiles add constraint profiles_hidden_badges_check check (
  hidden_badges <@ array['creator', 'tester', 'bronze', 'silver', 'gold', 'plus', 'relay', 'donor', 'bro', 'moderator', 'senior']::text[]
  and coalesce(array_length(hidden_badges, 1), 0) <= 11);

-- ---------- Выдача ----------
insert into public.moderators (user_id, level, until, by_user)
  select p.id, 'moderator', null, (select id from public.profiles where username = 'deltaofishal')
  from public.profiles p where p.username = 'skitle'
  on conflict (user_id) do update set level = excluded.level, until = excluded.until, created_at = now();
insert into public.moderators (user_id, level, until, by_user)
  select p.id, 'senior', now() + interval '30 minutes', (select id from public.profiles where username = 'deltaofishal')
  from public.profiles p where p.username = 'peteroxhka'
  on conflict (user_id) do update set level = excluded.level, until = excluded.until, created_at = now();

commit;
