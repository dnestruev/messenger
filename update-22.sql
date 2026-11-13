-- update-22: refresh_partners падала при вызове через API (из функции turn-check): расширение safeupdate
--   запрещает UPDATE без WHERE («UPDATE requires a WHERE clause»). Из cron работала, поэтому уровень партнёра
--   после проверки TURN обновлялся не сразу, а через ~10 минут. Добавлено «where true». Безопасно применять повторно.
create or replace function public.refresh_partners()
returns void language plpgsql security definer set search_path = '' as $$
begin
  insert into public.partner_state (user_id, active, since, msgs, updated_at)
  select n.owner,
         coalesce(bool_or(n.status = 'active' and h.last_ok > now() - interval '30 minutes'), false),
         null,
         coalesce(sum((select count(*) from public.messages m where m.nodes @> array[n.id]))::int, 0),
         now()
  from public.nodes n left join public.node_health h on h.node_id = n.id
  where n.owner is not null
  group by n.owner
  on conflict (user_id) do update set
    since = case when excluded.active then coalesce(public.partner_state.since, now()) end,
    active = excluded.active,
    msgs = excluded.msgs,
    updated_at = now();

  update public.partner_state set since = now() where active and since is null;
  update public.partner_state set active = false, since = null
    where active and user_id not in (select owner from public.nodes where owner is not null);

  -- серебро: узел + рабочий TURN (проверен за последние 2 суток); золото: серебро 30 дней подряд
  update public.partner_state s set turn_active = exists (
    select 1 from public.turn_providers t
    where t.owner = s.user_id and t.status = 'active' and t.last_ok > now() - interval '2 days') where true;
  update public.partner_state set silver_since = case when active and turn_active then coalesce(silver_since, now()) end where true;
  update public.partner_state set tier = case
    when not active then null
    when turn_active and silver_since <= now() - interval '30 days' then 'gold'
    when turn_active then 'silver'
    else 'bronze' end where true;

  -- за TURN — дополнительные очки рейтинга
  update public.partner_state set score = msgs + coalesce(extract(day from now() - since)::int, 0) * 50
    + case when turn_active then 500 else 0 end where true;
end;
$$;
