\set ON_ERROR_STOP 0
insert into auth.users (id, raw_user_meta_data) values
 ('11111111-1111-1111-1111-111111111111', '{"username":"sp_89"}'),
 ('22222222-2222-2222-2222-222222222222', '{"username":"other"}');
\i update-25.sql
select '1 выдан sp_89' as t, count(*) from public.badge_grants g join public.profiles p on p.id = g.user_id where p.username = 'sp_89' and kind = 'football';
select '2 второй такой нельзя — ошибка' as t; insert into public.badge_grants (user_id, kind) values ('22222222-2222-2222-2222-222222222222', 'football');
select '3 повторное применение — без ошибок' as t;
\i update-25.sql
select '4 в списке значков' as t, kind from public.badges_list() where kind = 'football';
select '5 можно скрыть у себя' as t; update public.profiles set hidden_badges = array['football'] where username = 'sp_89';
select hidden_badges from public.profiles where username = 'sp_89';
set role authenticated;
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', false);
select '6 set_badge не принимает — ошибка' as t; select public.set_badge('other', 'football', true);
