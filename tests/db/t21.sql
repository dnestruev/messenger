\set ON_ERROR_STOP 0
-- update-21: Премиум
insert into auth.users (id, raw_user_meta_data) values
 ('11111111-1111-1111-1111-111111111111', '{"username":"alice"}'),
 ('22222222-2222-2222-2222-222222222222', '{"username":"bobby"}'),
 ('33333333-3333-3333-3333-333333333333', '{"username":"carol"}');
update public.profiles set role = 'creator' where username = 'bobby';
set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
select '1 цены' as t, price_month, price_year, until from public.premium_me();
select '2 рамка без плюса — ошибка' as t; update public.profiles set frame = 'gold' where id = '11111111-1111-1111-1111-111111111111';
select '3 цвет ника без премиума — ошибка' as t; select public.set_nick_color('gold');
select '4 срок 3 мес — ошибка' as t; select public.premium_order(3, 'донат 2000');
select '5 заявка на месяц' as t, public.premium_order(1, 'донат 2000 от alice') > 0;
select '6 вторая — ошибка' as t; select public.premium_order(12, 'ещё донат');
select '7 сама себе — ошибка' as t; select public.premium_decide(1, true);
select '8 сама себе подарить — ошибка' as t; select public.premium_grant('alice', 30);
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', false);
select '9 создатель видит заявку' as t, buyer, months, price from public.premium_orders_admin();
select public.premium_decide(1, true);
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
select '10 премиум ~1 мес' as t, until > now() + interval '27 days' and until < now() + interval '32 days' as ok from public.premium_me();
select '11 значок premium' as t, count(*) from public.badges_list() where kind = 'premium';
update public.profiles set frame = 'fire' where id = '11111111-1111-1111-1111-111111111111';
select '12 премиум-рамка стоит' as t, frame from public.profiles where username = 'alice';
select public.set_nick_color('rainbow');
select '13 цвет ника' as t, nick_color from public.premium_list();
select '14 плохой цвет — ошибка' as t; select public.set_nick_color('pink');
select '15 скидка 10% на лимитку: 630' as t, public.limited_order('l_spark', null, 'донат 630') > 0, (select price from public.limited_my_orders() limit 1);
select public.premium_order(12, 'донат 24000');
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', false);
select public.premium_decide(2, true);
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
select '16 год прибавился к месяцу (~13 мес)' as t, until > now() + interval '385 days' as ok from public.premium_me();
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', false);
select public.premium_grant('carol', 7);
select '17 подарок на 7 дней' as t, count(*) from public.premium_list();
select public.premium_grant('alice', 0);
select '18 сняли у alice' as t, count(*) from public.premium_list();
select set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', false);
select '19 обычная рамка у премиума (плюс включён)' as t; update public.profiles set frame = 'gold' where id = '33333333-3333-3333-3333-333333333333';
select frame from public.profiles where username = 'carol';
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
select '20 без премиума премиум-рамку не поставить — ошибка' as t; update public.profiles set frame = 'prism' where id = '11111111-1111-1111-1111-111111111111';
select '21 таблица напрямую — ошибка' as t; select * from public.premium;
