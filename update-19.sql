-- update-19: бан может снять или изменить любой из администрации (модератор, старший, создатель) —
--   неважно, кто его поставил. Остальное как было: модератор банит на 1–7 дней, банить можно только тех, кто ниже.
begin;

create or replace function public.ban_user(p_username text, p_days int, p_reason text)
returns void language plpgsql security definer set search_path = '' as $$
declare uid uuid; till timestamptz; lvl int := public.mod_level(auth.uid());
begin
  if lvl < 1 then raise exception 'only creators can ban'; end if;
  select id into uid from public.profiles where username = lower(trim(both '@ ' from p_username));
  if uid is null then raise exception 'user not found'; end if;
  if public.is_creator(uid) then raise exception 'cannot ban a creator'; end if;
  if uid = auth.uid() or public.mod_level(uid) >= lvl then
    raise exception 'cannot ban your level or higher';
  end if;
  if lvl = 1 and (p_days is null or p_days < 1 or p_days > 7) then raise exception 'moderators ban for 1 to 7 days'; end if;
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
declare uid uuid;
begin
  if public.mod_level(auth.uid()) < 1 then raise exception 'only creators can ban'; end if;
  select id into uid from public.profiles where username = lower(trim(both '@ ' from p_username));
  if uid is null then raise exception 'user not found'; end if;
  if not exists (select 1 from public.bans b where b.user_id = uid) then return; end if;
  delete from public.bans where user_id = uid;
  update auth.users set banned_until = null where id = uid;
  insert into public.mod_log (actor, action, target) values (auth.uid(), 'unban', uid);
end;
$$;

commit;
