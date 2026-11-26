\set ON_ERROR_STOP 0
-- update-26: ивент «Фортуна»
insert into auth.users (id, raw_user_meta_data) values
 ('11111111-1111-1111-1111-111111111111', '{"username":"alice"}'),
 ('22222222-2222-2222-2222-222222222222', '{"username":"boss"}'),
 ('33333333-3333-3333-3333-333333333333', '{"username":"carol"}');
update public.profiles set role = 'creator' where username = 'boss';
\i update-26.sql
select '0 повторное применение без ошибок' as t;
\i update-26.sql
set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
select '1 состояние: идёт, 3 бесплатных, 0 платных' as t, active, free_left, paid_left, spin_price, pack_price, pack_size from public.fortune_state();
select '2 призы и шансы (сумма 48% с Бурмалдой)' as t, string_agg(kind || ':' || chance_bp || ':' || buyable, ' ' order by chance_bp desc), sum(chance_bp) from public.fortune_prizes_list();
select '3 три бесплатные крутки проходят' as t, count(*) from (select public.fortune_spin() from generate_series(1,3)) x;
select '4 четвёртая — ошибка (нет попыток)' as t; select public.fortune_spin();
select '5 осталось 0/0' as t, free_left, paid_left from public.fortune_state();
reset role;
select '6 каждый выигрыш — экземпляр с номером' as t, (select count(*) from public.fortune_spins where kind is not null) = (select count(*) from public.limited_items where kind like 'l_f%' or kind in ('l_clover','l_horseshoe','l_dice','l_jackpot','l_luck')) as same;
-- заявка на платные крутки
set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
select public.fortune_order(25, 'донат 2300 от alice') as oid \gset
select '7 заявка 25 круток — цена 2*900+5*100=2300' as t, price from public.fortune_my_orders() where id = :oid;
select '8 0 круток — ошибка' as t; select public.fortune_order(0, 'донат');
select '9 чужой не одобрит — ошибка' as t; select public.fortune_decide(:oid, true, null);
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', false);
select '10 создатель видит заявку' as t, buyer, spins, price, status from public.fortune_orders_admin();
select public.fortune_decide(:oid, true, null);
select '11 повторно одобрить — ошибка' as t; select public.fortune_decide(:oid, true, null);
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
select '12 начислено 25 платных' as t, paid_left from public.fortune_state();
select '13 платные крутки идут (25)' as t, count(*) from (select public.fortune_spin() from generate_series(1,25)) x;
select '14 платные кончились' as t, paid_left from public.fortune_state();
-- прямая покупка
select '15 Удачу купить нельзя — ошибка' as t; select public.limited_order('l_luck', null, 'донат 500000');
select '16 Клевер купить можно' as t, public.limited_order('l_clover', null, 'донат 500 от alice') > 0 as ok;
reset role;
-- сверхредкий: подкручиваем шанс, чтобы проверить тираж 3 и новость
update public.fortune_prizes set chance_bp = 10000 where kind = 'l_luck';
update public.fortune_prizes set chance_bp = 0 where kind <> 'l_luck';
insert into public.fortune_balance (user_id, paid_left) values ('33333333-3333-3333-3333-333333333333', 10) on conflict (user_id) do update set paid_left = 10;
set role authenticated;
select set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', false);
select '17 выбил Удачу 3 раза, четвёртая — пусто (тираж 3)' as t, string_agg(coalesce(r.kind, 'пусто') || '#' || coalesce(r.serial::text, '-'), ' ') from (select (public.fortune_spin()).* from generate_series(1,4)) r;
reset role;
select '18 новость о каждой Удаче' as t, count(*) from public.news where body like '%Удач%';
select '19 события создателю' as t, count(*) from public.admin_events where kind = 'fortune_luck';
select '20 значок в списке' as t, count(*) from public.badges_list() where kind = 'l_luck';
-- конец ивента
update public.fortune_config set ends_at = now() - interval '1 minute';
set role authenticated;
select set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', false);
select '21 ивент кончился — неактивен' as t, active from public.fortune_state();
select '22 крутить нельзя — ошибка' as t; select public.fortune_spin();
select '23 купить напрямую нельзя — ошибка' as t; select public.limited_order('l_dice', null, 'донат 4000 от carol');
select '24 заявку на крутки нельзя — ошибка' as t; select public.fortune_order(1, 'донат 100');
select '25 anon ничего — ошибка' as t;
reset role; set role anon; select public.fortune_spin();
reset role;
select '26 скрыть значок Удачи можно' as t; update public.profiles set hidden_badges = array['l_luck','l_clover'] where username = 'carol';
select hidden_badges from public.profiles where username = 'carol';
select '27 напрямую писать в таблицы нельзя — ошибка' as t;
set role authenticated; insert into public.fortune_balance (user_id, paid_left) values ('11111111-1111-1111-1111-111111111111', 999);
