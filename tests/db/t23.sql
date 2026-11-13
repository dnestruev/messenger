\set ON_ERROR_STOP 0
-- update-23: лента событий для создателя
insert into auth.users (id, raw_user_meta_data) values
 ('11111111-1111-1111-1111-111111111111', '{"username":"alice"}'),
 ('22222222-2222-2222-2222-222222222222', '{"username":"bobby"}'),
 ('33333333-3333-3333-3333-333333333333', '{"username":"carol"}'),
 ('44444444-4444-4444-4444-444444444444', '{"username":"dave"}');
update public.profiles set role = 'creator' where username = 'bobby';
select '0 регистрации: 4 события user_new' as t, count(*) from public.admin_events where kind = 'user_new';
delete from public.admin_events;
set role authenticated;
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', false);
select public.set_moderator('carol', 'senior', null);
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
select public.limited_order('l_spark', null, 'донат 700 от alice') > 0 as ordered;
select public.premium_order(1, 'донат 2000 от alice') > 0 as ordered;
reset role;
select '1 заявка на лимитку' as t, kind, text, go from public.admin_events where kind = 'order_limited';
select '2 заявка на Премиум' as t, kind, text, go from public.admin_events where kind = 'order_premium';
-- сделка с рук
reset role;
insert into public.limited_items (kind, serial, owner, sale_price) values ('l_owl', 1, '11111111-1111-1111-1111-111111111111', 5000);
select id as owl from public.limited_items where kind = 'l_owl' \gset
set role authenticated;
select set_config('request.jwt.claim.sub', '44444444-4444-4444-4444-444444444444', false);
select public.limited_order(null, :owl, '') > 0 as asked;
reset role;
select id as ro from public.limited_orders where resale \gset
set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
select public.limited_decide(:ro, true);
reset role;
select '3 сделка с рук (заявка с рук сама события не даёт: 1)' as t, count(*) filter (where kind = 'resale') as resale, count(*) filter (where kind = 'order_limited') as orders, max(text) filter (where kind = 'resale') as text from public.admin_events;
-- узлы и TURN
insert into public.nodes (url, owner, status) values ('https://abcdefghijklmnopqrst.supabase.co', '11111111-1111-1111-1111-111111111111', 'pending');
update public.nodes set status = 'active'; update public.nodes set status = 'disabled'; update public.nodes set status = 'active';
update public.nodes set disabled_reason = 'x';
insert into public.turn_providers (owner, urls, username, credential) values ('11111111-1111-1111-1111-111111111111', array['turn:t.example:3478'], 'u', 'p');
select '4 узлы: new, up, down, up + turn_new' as t, string_agg(kind, ',' order by id) from public.admin_events where kind like 'node%' or kind = 'turn_new';
-- баны
set role authenticated;
select set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', false);
select public.ban_user('dave', 3, 'спам'); select public.unban_user('dave');
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', false);
select public.ban_user('dave', 1, 'сам создатель'); select public.unban_user('dave');
select '7 создатель читает' as t, count(*) > 5 as many from public.admin_events;
select '6 бан/разбан модератором есть, создателем — нет' as t, string_agg(kind || ':' || text, ' | ' order by id) from public.admin_events where kind in ('ban', 'unban');
select set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', false);
select '8 старший модератор: 0 строк' as t, count(*) from public.admin_events;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
select '8 обычный: 0 строк' as t, count(*) from public.admin_events;
select '8 вставить самому — ошибка' as t; insert into public.admin_events (kind, text) values ('x', 'подделка');
select '8 log_event напрямую — ошибка' as t; select public.log_event('x', 'подделка');
reset role;
-- сбой записи не ломает действие
alter table public.admin_events add constraint boom check (kind <> 'order_premium') not valid;
set role authenticated;
select set_config('request.jwt.claim.sub', '44444444-4444-4444-4444-444444444444', false);
select '9 заявка проходит при сломанной ленте' as t, public.premium_order(12, 'донат 24000 от dave') > 0 as ordered;
reset role;
alter table public.admin_events drop constraint if exists boom;
select '10 длинный/странный ник не ломает' as t; insert into auth.users (id, raw_user_meta_data) values ('55555555-5555-5555-5555-555555555555', '{"username":"eve"}');
select count(*) as eve from public.admin_events where kind = 'user_new' and go = 'user:eve';
