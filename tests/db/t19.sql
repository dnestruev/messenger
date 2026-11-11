\set ON_ERROR_STOP 0
-- update-19: магазин лимиток
insert into auth.users (id, raw_user_meta_data) values
 ('11111111-1111-1111-1111-111111111111', '{"username":"alice"}'),
 ('22222222-2222-2222-2222-222222222222', '{"username":"bobby"}'),
 ('33333333-3333-3333-3333-333333333333', '{"username":"carol"}');
update public.profiles set role = 'creator' where username = 'bobby';
set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
select '1 каталог 20' as t, count(*) from public.limited_catalog();
select '2 заявка' as t, public.limited_order('l_absolute', null, 'донат от alice 20:00') > 0;
select '3 вторая такая же — ошибка' as t; select public.limited_order('l_absolute', null, 'ещё раз');
select '4 сама себе выдать — ошибка' as t; select public.limited_decide(1, true);
select '5 чужие заявки — ошибка' as t; select * from public.limited_orders_admin();
select set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', false);
select '6 тираж 1 занят заявкой — ошибка' as t; select public.limited_order('l_absolute', null, 'carol хочет');
select '7 короткое подтверждение — ошибка' as t; select public.limited_order('l_spark', null, 'x');
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', false);
select '8 создатель видит 1 заявку' as t, count(*), min(buyer) from public.limited_orders_admin();
select public.limited_decide(1, true);
select '9 продано 1' as t, sold from public.limited_catalog() where kind = 'l_absolute';
select '10 значок в badges_list' as t, count(*) from public.badges_list() where kind = 'l_absolute';
select '11 повторно решить — ошибка' as t; select public.limited_decide(1, true);
select set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', false);
select '12 распродано — ошибка' as t; select public.limited_order('l_absolute', null, 'carol хочет');
select '13 чужой экземпляр выставить — ошибка' as t; select public.limited_sell(1, 30000);
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
select public.limited_sell(1, 30000);
select '14 на рынке' as t, price, reserved from public.limited_market();
select '15 свой купить — ошибка' as t; select public.limited_order(null, 1, 'сам у себя');
select set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', false);
select '16 заявка с рук' as t, public.limited_order(null, 1, '') > 0;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
select '17 снять с продажи при заявке — ошибка' as t; select public.limited_sell(1, null);
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', false);
select '18 создателю заявки с рук не видны' as t, count(*) from public.limited_orders_admin();
select '18a создатель чужую сделку не решает — ошибка' as t; select public.limited_decide(2, true);
select set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', false);
select '18b покупатель сам себе — ошибка' as t; select public.limited_decide(2, true);
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
select '19 продавец видит заявку' as t, count(*), min(price) from public.limited_requests();
select public.limited_decide(2, true);
select '20 у alice пусто' as t, count(*) from public.limited_mine();
select '21 заявок больше нет' as t, count(*) from public.limited_requests();
select set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', false);
select '21a у carol №1, не продаётся' as t, serial, sale_price from public.limited_mine();
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', false);
select '22 тираж ниже проданного — ошибка' as t; select public.limited_set('l_absolute', 20000, 0);
select public.limited_set('l_spark', 800, 5);
select '23 цена изменена' as t, price, total from public.limited_catalog() where kind = 'l_spark';
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
select '24 не создатель меняет цену — ошибка' as t; select public.limited_set('l_spark', 1, 5);
select public.limited_order('l_spark', null, 'донат 800');
select public.limited_cancel((select id from public.limited_my_orders() where status = 'pending'));
select '25 отменена' as t, status from public.limited_my_orders() where kind = 'l_spark';
update public.profiles set hidden_badges = array['l_absolute', 'bee'] where id = '11111111-1111-1111-1111-111111111111';
select '26 скрыть лимитку можно' as t, hidden_badges from public.profiles where username = 'alice';
select '27 таблицы напрямую — ошибка' as t; select * from public.limited_orders;
