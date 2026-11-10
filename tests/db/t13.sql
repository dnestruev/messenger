\set ON_ERROR_STOP 0
insert into auth.users (id, raw_user_meta_data) values
 ('11111111-1111-1111-1111-111111111111', '{"username":"alice"}'),
 ('22222222-2222-2222-2222-222222222222', '{"username":"bobby"}');
update public.profiles set role = 'creator' where username = 'bobby';
set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
-- свой отчёт пишется, время ставит база
insert into public.call_reports (call_id, dir, status, report, created_at) values (gen_random_uuid(), 'out', 'failed', 'тест', '2000-01-01');  -- без returning, как в приложении
-- чужой — нельзя
insert into public.call_reports (user_id, call_id, dir, status, report) values ('22222222-2222-2222-2222-222222222222', gen_random_uuid(), 'out', 'x', 'подделка');
-- читать отчёты обычному человеку нельзя (видит 0)
select count(*) as alice_sees from public.call_reports;
-- лимит 60 в час
do $$ begin for i in 1..60 loop insert into public.call_reports (call_id, dir, status, report) values (gen_random_uuid(), 'in', 'ok', 'x'); end loop; end $$;
-- создатель видит
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', false);
select count(*) as creator_sees from public.call_reports;
