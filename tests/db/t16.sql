\set ON_ERROR_STOP 0
insert into auth.users (id, raw_user_meta_data) values
 ('11111111-1111-1111-1111-111111111111', '{"username":"peteroxhka"}'),
 ('22222222-2222-2222-2222-222222222222', '{"username":"bobby"}');
update public.profiles set role = 'creator' where username = 'bobby';
\i update-16.sql
select 'у Пятёрочки бро' as t, p.username, b.kind, b.granted from public.badges_list() b join public.profiles p on p.id = b.user_id;
set role authenticated;
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', false);
select 'выдать бро себе — ошибка' as t; select public.set_badge('bobby', 'bro', true);
select 'снять бро — ошибка' as t; select public.set_badge('peteroxhka', 'bro', false);
reset role;
select 'второй бро в базе — ошибка уникальности' as t; insert into public.badge_grants (user_id, kind) values ('22222222-2222-2222-2222-222222222222', 'bro');
select 'бро по-прежнему один' as t, count(*) from public.badge_grants where kind = 'bro';
