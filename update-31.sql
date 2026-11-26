-- update-31: все узлы Пятёрочки — на его основной аккаунт @peteroxhka
-- (узлы с запасных аккаунтов peteroxhka_v2…v4, pidoras, rec0i1 — это его же проекты Supabase)
begin;
update public.nodes set owner = (select id from public.profiles where username = 'peteroxhka')
where owner in (select id from public.profiles where username in ('peteroxhka_v2', 'peteroxhka_v3', 'peteroxhka_v4', 'pidoras', 'rec0i1'))
  and exists (select 1 from public.profiles where username = 'peteroxhka');
select public.refresh_partners();
select public.log_event('node_up', 'Узлы с запасных аккаунтов Пятёрочки перенесены на @peteroxhka', null);
commit;
