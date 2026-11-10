\set ON_ERROR_STOP 0
-- update-15: закреплённые чаты и новости
insert into auth.users (id, raw_user_meta_data) values
 ('11111111-1111-1111-1111-111111111111', '{"username":"alice"}'),
 ('22222222-2222-2222-2222-222222222222', '{"username":"bobby"}');
update public.profiles set role = 'creator' where username = 'bobby';
insert into public.conversations (id, is_group, title) values
 ('c0000000-0000-0000-0000-000000000001', true, 'g1'), ('c0000000-0000-0000-0000-000000000002', true, 'g2'), ('c0000000-0000-0000-0000-000000000003', true, 'g3');
insert into public.conversation_members (conversation_id, user_id) select c, '11111111-1111-1111-1111-111111111111' from unnest(array['c0000000-0000-0000-0000-000000000001','c0000000-0000-0000-0000-000000000002','c0000000-0000-0000-0000-000000000003']::uuid[]) c;
set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
select public.set_pins(array['c0000000-0000-0000-0000-000000000003','c0000000-0000-0000-0000-000000000001']::uuid[]);
select 'ожидаем g3=1, g1=2, g2=null' as t; select title, pin_order from public.my_chats() order by title;
select public.set_pins(array['c0000000-0000-0000-0000-000000000002']::uuid[]);
select 'ожидаем только g2=1' as t; select title, pin_order from public.my_chats() order by title;
select 'чужой чат не закрепить (тихо пропускаем)' as t; select public.set_pins(array['c0000000-0000-0000-0000-00000000dead']::uuid[]);
select 'ожидаем 0 закреплённых' as t; select count(*) from public.my_chats() where pin_order is not null;
select 'Алиса не может писать новости — ошибка' as t; insert into public.news (body) values ('взлом');
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', false);
insert into public.news (body, created_at) values ('**Привет!** первая новость', now() - interval '5 years');
select 'время ставит сервер (не 5 лет назад)' as t, created_at > now() - interval '1 minute' as ok from public.news;
update public.news set body = 'исправлено';
select 'правка отмечена' as t, edited_at is not null as ok, body from public.news;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
select 'Алиса видит новость' as t, count(*) from public.news;
select 'Алиса не правит/не удаляет' as t; update public.news set body = 'x'; delete from public.news; select body from public.news;
insert into public.news_reactions (news_id, emoji) select id, '🔥' from public.news;
insert into public.news_reactions (news_id, emoji) select id, '❤️' from public.news;
insert into public.news_reactions (news_id, emoji) select id, '👍' from public.news;
select 'четвёртая реакция — ошибка' as t; insert into public.news_reactions (news_id, emoji) select id, '😂' from public.news;
select 'чужой реакцией нельзя' as t; insert into public.news_reactions (news_id, user_id, emoji) select id, '22222222-2222-2222-2222-222222222222', '😂' from public.news;
select 'реакций 3' as t, count(*) from public.news_reactions;
delete from public.news_reactions where emoji = '🔥';
select 'после снятия 2' as t, count(*) from public.news_reactions;
