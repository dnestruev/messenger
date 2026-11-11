-- update-18: server-enforced moderation and expiring senior access.
-- Existing creator/tester role is preserved; expiry reveals it automatically.
begin;
alter table public.profiles drop constraint if exists profiles_hidden_badges_check;
alter table public.profiles add constraint profiles_hidden_badges_check check (
 hidden_badges <@ array['creator','tester','moderator','senior_moderator','bronze','silver','gold','plus','relay','donor','bro']::text[]
 and coalesce(array_length(hidden_badges,1),0) <= 11);
create table if not exists public.moderation_roles (
 user_id uuid primary key references public.profiles(id) on delete cascade,
 role text not null check (role in ('moderator', 'senior_moderator')),
 expires_at timestamptz,
 granted_by uuid references public.profiles(id) on delete set null,
 created_at timestamptz not null default now()
);
alter table public.moderation_roles enable row level security;
revoke all on public.moderation_roles from public, anon, authenticated;
grant select on public.moderation_roles to authenticated;
drop policy if exists "moderation roles read" on public.moderation_roles;
create policy "moderation roles read" on public.moderation_roles for select to authenticated using (true);

create or replace function public.staff_rank(uid uuid)
returns int language sql stable security definer set search_path = '' as $$
 select case when public.is_banned(uid) then 0 when public.is_creator(uid) then 3 else
 coalesce((select case when r.role = 'senior_moderator' then 2 else 1 end
 from public.moderation_roles r where r.user_id = uid and (r.expires_at is null or r.expires_at > now())), 0) end;
$$;
revoke all on function public.staff_rank(uuid) from public, anon;
grant execute on function public.staff_rank(uuid) to authenticated;

create or replace function public.set_moderation_role(p_username text, p_role text, p_minutes int default null)
returns void language plpgsql security definer set search_path = '' as $$
declare target uuid; actor_rank int;
begin
 actor_rank := public.staff_rank(auth.uid());
 if actor_rank < 2 then raise exception 'only senior moderators or creators'; end if;
 if p_role is not null and p_role not in ('moderator', 'senior_moderator') then raise exception 'invalid role'; end if;
 if p_minutes is not null and (p_minutes < 1 or p_minutes > 525600) then raise exception 'invalid duration'; end if;
 select id into target from public.profiles where username = lower(trim(both '@ ' from p_username)) for update;
 if target is null then raise exception 'user not found'; end if;
 if target = auth.uid() or public.is_creator(target) then raise exception 'protected account'; end if;
 if actor_rank = 2 and (exists(select 1 from public.moderation_roles r where r.user_id = target and r.role = 'senior_moderator' and (r.expires_at is null or r.expires_at > now())) or p_role = 'senior_moderator') then raise exception 'cannot manage peers or higher roles'; end if;
 if p_role is null then delete from public.moderation_roles where user_id = target;
 else
 insert into public.moderation_roles(user_id, role, expires_at, granted_by)
 values(target, p_role, case when p_minutes is null then null else now() + make_interval(mins => p_minutes) end, auth.uid())
 on conflict(user_id) do update set role = excluded.role, expires_at = excluded.expires_at, granted_by = excluded.granted_by, created_at = now();
 end if;
end;
$$;
revoke all on function public.set_moderation_role(text,text,int) from public, anon;
grant execute on function public.set_moderation_role(text,text,int) to authenticated;
create or replace function public.ban_user(p_username text, p_days int, p_reason text)
returns void language plpgsql security definer set search_path = '' as $$
declare uid uuid; till timestamptz;
begin
  if public.staff_rank(auth.uid()) < 1 then raise exception 'moderator required'; end if;
  select id into uid from public.profiles where username = lower(trim(both '@ ' from p_username));
  if uid is null then raise exception 'user not found'; end if;
  if uid = auth.uid() or public.is_creator(uid) or (public.staff_rank(auth.uid()) < 3 and exists(select 1 from public.moderation_roles r where r.user_id = uid and (r.expires_at is null or r.expires_at > now()) and (r.role = 'senior_moderator' or public.staff_rank(auth.uid()) = 1))) then raise exception 'protected account'; end if;
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
  if public.staff_rank(auth.uid()) < 1 then raise exception 'moderator required'; end if;
  select id into uid from public.profiles where username = lower(trim(both '@ ' from p_username));
  if uid is null then raise exception 'user not found'; end if;
  if uid = auth.uid() or public.is_creator(uid) or (public.staff_rank(auth.uid()) < 3 and exists(select 1 from public.moderation_roles r where r.user_id = uid and (r.expires_at is null or r.expires_at > now()) and (r.role = 'senior_moderator' or public.staff_rank(auth.uid()) = 1))) then raise exception 'protected account'; end if;
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
  if public.staff_rank(auth.uid()) < 1 then raise exception 'moderator required'; end if;
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
  if public.staff_rank(auth.uid()) < 1 then raise exception 'moderator required'; end if;
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

create or replace function public.set_app_setting(p_key text, p_value text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if public.staff_rank(auth.uid()) < 2 then raise exception 'only creators change settings'; end if;
  if public.staff_rank(auth.uid()) = 2 and (p_key is null or p_key not in ('donate_url', 'donate_text')) then raise exception 'unsupported setting'; end if;
  if p_key = 'donate_url' and coalesce(p_value, '') <> '' and (p_value !~ '^https://[^[:space:]]+$' or char_length(p_value) < 12) then raise exception 'bad donate url'; end if;
  if coalesce(trim(p_value), '') = '' then
    delete from public.app_settings where key = p_key;
  else
    insert into public.app_settings (key, value) values (p_key, trim(p_value))
      on conflict (key) do update set value = excluded.value, updated_at = now();
  end if;
end;
$$;

revoke all on function public.set_app_setting(text,text) from public, anon;
grant execute on function public.set_app_setting(text,text) to authenticated;
-- Existing tester-management endpoint must also respect the hierarchy.
create or replace function public.set_role(p_username text, p_role text)
returns void language plpgsql security definer set search_path = '' as $$
declare target uuid;
begin
 if public.staff_rank(auth.uid()) < 2 then raise exception 'senior moderator required'; end if;
 if p_role is not null and p_role <> 'tester' then raise exception 'invalid role'; end if;
 select id into target from public.profiles where username = lower(trim(both '@ ' from p_username)) for update;
 if target is null then raise exception 'user not found'; end if;
 if target = auth.uid() or public.is_creator(target) then raise exception 'protected account'; end if;
 if public.staff_rank(auth.uid()) = 2 and exists(select 1 from public.moderation_roles r where r.user_id = target and r.role = 'senior_moderator' and (r.expires_at is null or r.expires_at > now())) then raise exception 'protected account'; end if;
 update public.profiles set role = p_role where id = target;
end;
$$;
revoke all on function public.set_role(text,text) from public, anon;
grant execute on function public.set_role(text,text) to authenticated;
commit;
