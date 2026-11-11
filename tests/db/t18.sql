\set ON_ERROR_STOP 0
-- update-18: модераторы
insert into auth.users (id, raw_user_meta_data) values
 ('11111111-1111-1111-1111-111111111111', '{"username":"alice"}'),
 ('22222222-2222-2222-2222-222222222222', '{"username":"bobby"}'),
 ('33333333-3333-3333-3333-333333333333', '{"username":"carol"}'),
 ('44444444-4444-4444-4444-444444444444', '{"username":"dave"}'),
 ('55555555-5555-5555-5555-555555555555', '{"username":"erin"}');
update public.profiles set role = 'creator' where username = 'bobby';
set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
select '1 не создатель не назначает — ошибка' as t; select public.set_moderator('alice', 'senior', null);
select '2 обычный: список — ошибка' as t; select count(*) from public.admin_users();
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', false);
select public.set_moderator('alice', 'moderator', null);
select public.set_moderator('carol', 'senior', 30);
select '3 плохой уровень — ошибка' as t; select public.set_moderator('dave', 'god', null);
select '4 создателя не назначить — ошибка' as t; select public.set_moderator('bobby', 'senior', null);
select '5 значки видны: moderator + senior' as t, kind from public.badges_list() order by kind;
select '6 в списке: уровни и срок' as t, username, mod, mod_until is not null as timed from public.admin_users() where mod is not null order by username;
-- модератор
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
select '7 модератор видит список: 5' as t, count(*) from public.admin_users();
select '8 модератор: статистика — ошибка' as t; select public.admin_stats();
select '9 модератор: журнал — ошибка' as t; select count(*) from public.mod_log_list();
select '10 модератор: навсегда — ошибка' as t; select public.ban_user('dave', 0, 'x');
select '11 модератор: 30 дней — ошибка' as t; select public.ban_user('dave', 30, 'x');
select '12 модератор: создателя — ошибка' as t; select public.ban_user('bobby', 1, 'x');
select '13 модератор: старшего — ошибка' as t; select public.ban_user('carol', 1, 'x');
select '14 модератор: себя — ошибка' as t; select public.ban_user('alice', 1, 'x');
select '15 модератор: значок — ошибка' as t; select public.set_badge('dave', 'gold', true);
select '16 модератор: роль — ошибка' as t; select public.set_role('dave', 'tester');
select public.ban_user('dave', 7, 'спам');
select '17 dave забанен на 7 дней' as t, banned, banned_by from public.admin_users('dave');
select public.unban_user('dave');
select '18 dave разбанен' as t, banned from public.admin_users('dave');
-- старший
select set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', false);
select '19 старший: статистика' as t, (public.admin_stats()->>'users')::int as users;
select public.ban_user('dave', 0, 'навсегда');
select '20 старший: бан навсегда' as t, banned, ban_until is null as forever from public.admin_users('dave');
select '21 старший: создателя — ошибка' as t; select public.ban_user('bobby', 1, 'x');
select '22 старший: назначать — ошибка' as t; select public.set_moderator('dave', 'moderator', null);
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
select '23 модератор не снимает бан старшего — ошибка' as t; select public.unban_user('dave');
select '24 модератор не перебивает бан старшего — ошибка' as t; select public.ban_user('dave', 1, 'x');
select set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', false);
select public.ban_user('alice', 1, 'плохой модератор');
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
select '25 забаненный модератор без прав — ошибка' as t; select count(*) from public.admin_users();
-- срок вышел
reset role; update public.moderators set until = now() - interval '1 minute' where level = 'senior'; set role authenticated;
select set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', false);
select '26 срок вышел: список — ошибка' as t; select count(*) from public.admin_users();
select '27 срок вышел: бан — ошибка' as t; select public.ban_user('erin', 1, 'x');
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', false);
select '28 значков модерации не осталось (alice забанена, carol просрочена)' as t, count(*) from public.badges_list() where kind in ('moderator', 'senior');
select '29 создатель снимает любой бан' as t; select public.unban_user('dave'); select public.unban_user('alice');
select banned from public.admin_users('dave');
select public.set_moderator('alice', null, null);
select '30 журнал' as t, actor, action, target, details from public.mod_log_list() order by id;
select '31 скрыть значок moderator можно' as t; update public.profiles set hidden_badges = '{moderator,senior}' where id = '22222222-2222-2222-2222-222222222222' returning hidden_badges;
reset role;
select '32 клиент не читает таблицы напрямую' as t, has_table_privilege('authenticated', 'public.moderators', 'select') as mods, has_table_privilege('authenticated', 'public.mod_log', 'select') as log;
