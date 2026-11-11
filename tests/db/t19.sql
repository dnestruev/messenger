\set ON_ERROR_STOP 0
-- update-19: бан снимает любой из администрации
insert into auth.users (id, raw_user_meta_data) values
 ('11111111-1111-1111-1111-111111111111', '{"username":"alice"}'),
 ('22222222-2222-2222-2222-222222222222', '{"username":"bobby"}'),
 ('33333333-3333-3333-3333-333333333333', '{"username":"carol"}'),
 ('44444444-4444-4444-4444-444444444444', '{"username":"dave"}');
update public.profiles set role = 'creator' where username = 'bobby';
set role authenticated;
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', false);
select public.set_moderator('alice', 'moderator', null); select public.set_moderator('carol', 'senior', null);
select public.ban_user('dave', 0, 'создатель');
select set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', false);
select public.unban_user('dave');
select '1 старший снял бан создателя: f' as t, banned from public.admin_users('dave');
select public.ban_user('dave', 0, 'старший');
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
select public.unban_user('dave');
select '2 модератор снял бан старшего: f' as t, banned from public.admin_users('dave');
select '3 модератор: навсегда — ошибка' as t; select public.ban_user('dave', 0, 'x');
select '4 модератор: старшего — ошибка' as t; select public.ban_user('carol', 1, 'x');
select set_config('request.jwt.claim.sub', '44444444-4444-4444-4444-444444444444', false);
select '5 обычный: разбан — ошибка' as t; select public.unban_user('alice');
