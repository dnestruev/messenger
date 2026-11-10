\set ON_ERROR_STOP 0
-- двое пользователей и личный чат
insert into auth.users (id, raw_user_meta_data) values
 ('11111111-1111-1111-1111-111111111111', '{"username":"alice"}'),
 ('22222222-2222-2222-2222-222222222222', '{"username":"bobby"}');
set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
select public.get_or_create_dm('22222222-2222-2222-2222-222222222222') as conv \gset
-- 1) подделка времени: просим 2099 год
insert into public.messages (conversation_id, sender_id, iv, ct, ct_hash, created_at, edited_at, push_sent)
values (:'conv', '11111111-1111-1111-1111-111111111111', 'aaaaaaaaaaaaaaaa', 'x', repeat('a',64), '2099-01-01', '2099-01-01', true)
returning extract(year from created_at) as year, edited_at is null as no_edit, push_sent;
-- обычная правка всё ещё работает
update public.messages set ct = 'y' where conversation_id = :'conv' returning edited_at is not null as edited;
-- 3) ник не меняется
update public.profiles set username = 'alice2' where id = '11111111-1111-1111-1111-111111111111';
-- а имя меняется
update public.profiles set display_name = 'Алиса' where id = '11111111-1111-1111-1111-111111111111' returning display_name;
-- 2) удаление своего вложения в центре
reset role;
insert into storage.objects (bucket_id, name, owner_id) values
 ('chat-images', :'conv' || '/a.bin', '11111111-1111-1111-1111-111111111111'),
 ('chat-images', :'conv' || '/b.bin', '22222222-2222-2222-2222-222222222222');
set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
delete from storage.objects where bucket_id = 'chat-images' returning name like '%/a.bin' as deleted_own_only;
-- служебная роль (set_role создателя) ник менять может
reset role;
update public.profiles set username = 'alice_x' where id = '11111111-1111-1111-1111-111111111111' returning username;
-- старые проверки: нельзя вписать себя в чужой чат, нельзя стать создателем
set role authenticated;
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', false);
update public.profiles set role = 'creator' where id = '22222222-2222-2222-2222-222222222222';
update public.messages set conversation_id = conversation_id where false;
