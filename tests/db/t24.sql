\set ON_ERROR_STOP 0
-- update-24: устройства приложения для iPhone
insert into auth.users (id, raw_user_meta_data) values
 ('11111111-1111-1111-1111-111111111111', '{"username":"alice"}'),
 ('22222222-2222-2222-2222-222222222222', '{"username":"bobby"}'),
 ('33333333-3333-3333-3333-333333333333', '{"username":"carol"}');
set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
select public.app_register() as s \gset
select '1 секрет длинный' as t, char_length(:'s') >= 40 as ok;
select public.get_or_create_dm('22222222-2222-2222-2222-222222222222') as dm \gset
select public.get_or_create_dm('33333333-3333-3333-3333-333333333333') as dm2 \gset
reset role;
select '2 в базе только хеш' as t, count(*) filter (where secret_hash = :'s') as plain, count(*) as all from public.app_devices;
set role anon;
select '3 пусто сначала' as t, count(*) from public.app_poll(:'s');
reset role;
insert into public.messages (conversation_id, sender_id, iv, ct) values
 (:'dm', '22222222-2222-2222-2222-222222222222', 'aaaaaaaaaaaaaaaa', 'bbbb'),
 (:'dm', '22222222-2222-2222-2222-222222222222', 'aaaaaaaaaaaaaaaa', 'bbbb'),
 (:'dm', '11111111-1111-1111-1111-111111111111', 'aaaaaaaaaaaaaaaa', 'bbbb'),
 (:'dm2', '33333333-3333-3333-3333-333333333333', 'aaaaaaaaaaaaaaaa', 'bbbb');
insert into public.blocks (blocker, blocked) values ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333');
set role anon;
select '4 два от bobby, свои и заблокированный не считаются' as t, nick, n from public.app_poll(:'s');
select '5 повторно пусто' as t, count(*) from public.app_poll(:'s');
select '6 чужой секрет — пусто' as t, count(*) from public.app_poll('нет такого');
select '7 anon не регистрирует' as t; select public.app_register();
select public.app_unregister(:'s');
reset role;
select '8 выход удаляет' as t, count(*) from public.app_devices;
set role anon;
select '9 таблицу не читать' as t; select * from public.app_devices;
