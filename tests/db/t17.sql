\set ON_ERROR_STOP 0
insert into auth.users (id, raw_user_meta_data) values ('11111111-1111-1111-1111-111111111111', '{"username":"alice"}'), ('22222222-2222-2222-2222-222222222222', '{"username":"bobby"}');
set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
update public.profiles set hidden_badges = '{tester,donor}' where id = '11111111-1111-1111-1111-111111111111';
select 'скрыла два' as t, hidden_badges from public.profiles where username = 'alice';
select 'неизвестный значок — ошибка' as t; update public.profiles set hidden_badges = '{admin}' where id = '11111111-1111-1111-1111-111111111111';
select 'чужой профиль не меняется (0 строк)' as t; update public.profiles set hidden_badges = '{tester}' where id = '22222222-2222-2222-2222-222222222222';
reset role; select 'у bobby пусто' as t, hidden_badges from public.profiles where username = 'bobby'; set role authenticated;
select public.change_username('alice_new');
select 'сбросить дату смены ника — ошибка' as t; update public.profiles set username_changed_at = null where id = '11111111-1111-1111-1111-111111111111';
select 'второй раз сразу — ошибка' as t; select public.change_username('alice_two');
