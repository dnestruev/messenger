\set ON_ERROR_STOP 0
insert into auth.users (id, raw_user_meta_data) values
 ('11111111-1111-1111-1111-111111111111', '{"username":"deltaofishal"}'),
 ('22222222-2222-2222-2222-222222222222', '{"username":"alice"}');
update public.profiles set role = 'creator' where username = 'deltaofishal';
\i update-28.sql
\i update-28.sql
select '1 буст выдан один' as t, count(*), max(chance_bp) from public.fortune_boost;
insert into public.fortune_balance (user_id, paid_left) values ('11111111-1111-1111-1111-111111111111', 200), ('22222222-2222-2222-2222-222222222222', 200);
set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
create temp table r1 as select g, (public.fortune_spin()).kind from generate_series(1, 30) g;
reset role;
select '2 Удача выпала у создателя ровно 1 раз за 30 круток (дальше буста нет)' as t, count(*) filter (where kind = 'l_luck') from r1;
select '3 первая Удача — в первых круток (90%)' as t, min(g) <= 5 as early from r1 where kind = 'l_luck';
select '4 буст снят' as t, count(*) from public.fortune_boost;
select '5 новости нет' as t, count(*) from public.news;
select '6 событие с пометкой' as t, count(*) from public.admin_events where kind = 'fortune_boost';
set role authenticated;
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', false);
select '7 у других — обычные шансы (Удачи почти нет за 100)' as t, count(*) filter (where k = 'l_luck') <= 1 as ok from (select (public.fortune_spin()).kind k from generate_series(1, 100)) x;
select '8 читать буст нельзя — ошибка' as t; select * from public.fortune_boost;
