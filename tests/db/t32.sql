\set ON_ERROR_STOP 0
insert into auth.users (id, raw_user_meta_data) values
 ('11111111-1111-1111-1111-111111111111', '{"username":"alice"}'),
 ('22222222-2222-2222-2222-222222222222', '{"username":"bobby"}');
set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
select public.get_or_create_dm('22222222-2222-2222-2222-222222222222') as c \gset
select '1 первый захват — да' as t, public.claim_conversation_key(:'c', repeat('a', 64));
select '2 повторно тем же (второе устройство) — нет' as t, public.claim_conversation_key(:'c', repeat('b', 64));
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', false);
select '3 собеседник — нет' as t, public.claim_conversation_key(:'c', repeat('c', 64));
reset role;
select '4 отпечаток остался первым' as t, key_checks->>'1' = repeat('a', 64) as ok from public.conversations where id = :'c';
update public.conversation_key_claims set claimed_at = now() - interval '1 minute';
set role authenticated;
select '5 через 30 с можно перехватить (завис первый)' as t, public.claim_conversation_key(:'c', repeat('d', 64));
