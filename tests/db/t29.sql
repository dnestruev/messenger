\set ON_ERROR_STOP 0
insert into auth.users (id, raw_user_meta_data) values
 ('11111111-1111-1111-1111-111111111111', '{"username":"deltaofishal"}'),
 ('22222222-2222-2222-2222-222222222222', '{"username":"alice"}'),
 ('33333333-3333-3333-3333-333333333333', '{"username":"bob"}');
update public.profiles set role = 'creator' where username = 'deltaofishal';
\i update-29.sql
select '0 повторное применение без ошибок' as t;
set role authenticated;
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', false);
select '1 каталог: виски 300 ₽ / 777' as t, kind, price, total, sold from public.gifts_catalog();
select '2 без доната — ошибка bad proof' as t; select public.gift_send('whisky', 'bob', 'с др', false, '');
select '3 нет получателя — user not found' as t; select public.gift_send('whisky', '@nobody', null, false, 'донат 300');
select '4 заявка alice → bob' as t, public.gift_send('whisky', '@Bob', 'С днём рождения!', true, 'донат 300 от alice') is not null;
select '5 у bob пока пусто' as t, count(*) from public.gifts_of('33333333-3333-3333-3333-333333333333');
select '6 мои заявки: 1 pending' as t, status, recipient from public.gifts_my_orders();
select '7 чужая заявка создателю недоступна' as t; select * from public.gifts_orders_admin();
select '8 таблицу напрямую не читать' as t; select * from public.gifts;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
select '9 у создателя заявка' as t, sender, recipient, price, anonymous from public.gifts_orders_admin();
select public.gift_decide((select id from public.gifts_orders_admin() limit 1), true, null);
select '10 повторное решение — order not pending' as t; select public.gift_decide(1, true, null);
select '11 создатель дарит сам бесплатно' as t, public.gift_send('whisky', 'alice', null, false, null) is not null;
select '12 создатель видит дарителя анонимного' as t, sender is not null from public.gifts_of('33333333-3333-3333-3333-333333333333');
select set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', false);
select '13 bob видит подарок №1, текст и кто подарил' as t, serial, message, sender is not null from public.gifts_of('33333333-3333-3333-3333-333333333333');
select '14 bob прячет' as t; select public.gift_hide((select id from public.gifts_of('33333333-3333-3333-3333-333333333333') limit 1), true);
select '15 сам видит спрятанный' as t, hidden from public.gifts_of('33333333-3333-3333-3333-333333333333');
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', false);
select '16 alice не видит спрятанный у bob' as t, count(*) from public.gifts_of('33333333-3333-3333-3333-333333333333');
select '17 у alice подарок №2 от создателя' as t, serial from public.gifts_of('22222222-2222-2222-2222-222222222222');
select '18 чужой подарок не спрятать' as t; select public.gift_hide(1, false);
select '19 3 заявки максимум' as t; select public.gift_send('whisky', 'bob', null, false, 'донат 1'), public.gift_send('whisky', 'bob', null, false, 'донат 2'), public.gift_send('whisky', 'bob', null, false, 'донат 3');
select public.gift_send('whisky', 'bob', null, false, 'донат 4');
select '20 отмена своей заявки' as t; select public.gift_cancel((select id from public.gifts_my_orders() where status = 'pending' limit 1));
select '21 осталось 2 pending' as t, count(*) from public.gifts_my_orders() where status = 'pending';
reset role;
update public.gift_kinds set total = 4;
set role authenticated;
select '22 тираж кончился — gift sold out' as t; select public.gift_send('whisky', 'bob', null, false, 'донат 5');
select '23 цену правит только создатель' as t; select public.gift_set('whisky', 500, 1000, true);
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
select public.gift_set('whisky', 500, 1000, true);
select '24 цена 500, тираж 1000' as t, price, total from public.gifts_catalog();
select '25 тираж меньше выданного — ошибка' as t; select public.gift_set('whisky', 500, 1, true);
reset role;
select '26 функции-триггеры закрыты для API' as t, has_function_privilege('authenticated', 'public.ev_bans()', 'execute') as ev, has_function_privilege('anon', 'public.fortune_active()', 'execute') as fa;
select '27 событие о заявке' as t, count(*) from public.admin_events where kind = 'gift_order';
