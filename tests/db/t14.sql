\set ON_ERROR_STOP 0
-- update-14: уровни партнёров, TURN партнёров, донаты
insert into auth.users (id, raw_user_meta_data) values
 ('11111111-1111-1111-1111-111111111111', '{"username":"alice"}'),
 ('22222222-2222-2222-2222-222222222222', '{"username":"bobby"}');
update public.profiles set role = 'creator' where username = 'bobby';
-- у Алисы активный узел
insert into public.nodes (id, url, owner, status) values ('aaaaaaaa-0000-0000-0000-000000000001', 'https://abcdefghijklmnopqrst.supabase.co', '11111111-1111-1111-1111-111111111111', 'active');
insert into public.node_health (node_id, last_ok) values ('aaaaaaaa-0000-0000-0000-000000000001', now());
select public.refresh_partners();
select 'ожидаем bronze' as t, tier from public.partner_state;
set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
select 'плохой адрес — ошибка' as t; select public.register_turn(array['http://evil.com'], 'u', 'p');
select public.register_turn(array['turn:relay1.expressturn.com:3478', 'turn:relay1.expressturn.com:3478?transport=tcp'], 'user1', 'secret1') is not null as registered;
select 'пароль не виден даже владельцу — ошибка' as t; select credential from public.turn_providers;
select urls, status from public.turn_providers;
select public.register_turn(array['turn:a.example.com'], 'u', 'p') is not null as second_ok;
select 'третий — ошибка' as t; select public.register_turn(array['turn:b.example.com'], 'u', 'p');
select 'не создатель — ошибки' as t; select public.set_app_setting('donate_url', 'https://boosty.to/x'); select public.set_donor('alice', true);
reset role;
update public.turn_providers set status = 'active', last_ok = now() where urls[1] like '%expressturn%';
select public.refresh_partners();
select 'ожидаем silver' as t, tier, turn_active from public.partner_state;
update public.partner_state set silver_since = now() - interval '31 days';
select public.refresh_partners();
select 'ожидаем gold' as t, tier from public.partner_state;
update public.turn_providers set last_ok = now() - interval '3 days';
select public.refresh_partners();
select 'TURN давно не проверялся — ожидаем bronze и сброс стажа' as t, tier, silver_since from public.partner_state;
set role authenticated;
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', false);
select 'javascript-ссылка — ошибка' as t; select public.set_app_setting('donate_url', 'javascript:alert(1)');
select public.set_app_setting('donate_url', 'https://boosty.to/messenger');
select public.set_donor('@alice', true);
select key, value from public.app_settings;
select count(*) as donors from public.donors;
select * from public.perks_list();
select count(*) as creator_sees_turn from public.turn_providers;
select public.delete_turn((select id from public.turn_providers limit 1));
select count(*) as after_delete from public.turn_providers;
