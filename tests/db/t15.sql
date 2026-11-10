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
-- ---------- админка, бан, смена ника ----------
reset role;
insert into auth.users (id, raw_user_meta_data) values ('33333333-3333-3333-3333-333333333333', '{"username":"carol"}');
set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
select 'не создатель: админка — ошибка' as t; select count(*) from public.admin_users();
select 'не создатель: бан — ошибка' as t; select public.ban_user('carol', 1, 'x');
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', false);
select 'админка: 3 человека' as t, count(*) from public.admin_users();
select 'поиск car' as t, username from public.admin_users('car');
select 'статистика' as t, (public.admin_stats()->>'users')::int as users;
select public.set_badge('carol', 'gold', true);
select 'значок другому' as t, badges from public.admin_users('carol');
select public.ban_user('carol', 7, 'спам');
select 'забанен' as t, banned, ban_reason, ban_until > now() + interval '6 days' as week from public.admin_users('carol');
reset role; select 'вход закрыт' as t, banned_until is not null as ok from auth.users where id = '33333333-3333-3333-3333-333333333333'; set role authenticated;
select set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', false);
select 'забаненный не ставит реакции на новости — ошибка' as t; insert into public.news_reactions (news_id, emoji) select id, '👍' from public.news limit 1;
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', false);
select 'создателя не забанить — ошибка' as t; select public.ban_user('bobby', 0, 'x');
select public.unban_user('carol');
select 'разбанен' as t, banned from public.admin_users('carol');
-- смена ника
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
select 'плохой ник — ошибка' as t; select public.change_username('A!');
select 'занятый — ошибка' as t; select public.change_username('carol');
select public.change_username('alice_new');
select 'старый ник ведёт на Алису' as t, user_id = '11111111-1111-1111-1111-111111111111' as ok from public.username_aliases where alias = 'alice';
select 'старый ник занят для других' as t, public.username_available('alice') as available;
select 'второй раз сразу — ошибка' as t; select public.change_username('alice_two');
select set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', false);
select 'чужой старый ник не взять — ошибка' as t; select public.change_username('alice');
