\set ON_ERROR_STOP 0
insert into auth.users (id, raw_user_meta_data) values
 ('11111111-1111-1111-1111-111111111111', '{"username":"deltaofishal"}'),
 ('22222222-2222-2222-2222-222222222222', '{"username":"tester1"}'),
 ('33333333-3333-3333-3333-333333333333', '{"username":"senior1"}'),
 ('44444444-4444-4444-4444-444444444444', '{"username":"modjunior"}'),
 ('55555555-5555-5555-5555-555555555555', '{"username":"normal"}');
update public.profiles set role = 'creator' where username = 'deltaofishal';
update public.profiles set role = 'tester' where username = 'tester1';
insert into public.moderators (user_id, level) values ('33333333-3333-3333-3333-333333333333', 'senior'), ('44444444-4444-4444-4444-444444444444', 'moderator');
\i update-30.sql
set role authenticated;
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', false);
select '1 запускать может только создатель' as t; select public.exam_launch('python-1', 24, 30);
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
select '2 шаблон: 10 вопросов' as t, * from public.exam_templates_list();
select '3 запуск' as t, public.exam_launch('python-1', 24, 30) as id \gset
select '4 назначено: тестер и старший (2), младший и обычный — нет' as t, string_agg(username, ',' order by username) from public.exam_results(:id);
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', false);
select '5 у тестера задание' as t, status, questions, has_task from public.exam_mine();
select attempt_id as aid from public.exam_mine() \gset
select '6 сохранить до начала — ошибка' as t; select public.exam_save(:aid, '[1]', null, false);
select '7 старт: вопросы без ключа' as t, (questions -> 0 ? 'q') q, (questions::text like '%answer%') leak, status from public.exam_start(:aid);
select '8 ответы: 9 из 10 верно' as t, public.exam_save(:aid, '[2,1,3,1,2,1,3,1,2,0]', 'print(1)', false);
select '9 сдать' as t, public.exam_save(:aid, '[2,1,3,1,2,1,3,1,2,0]', 'n = int(input())', true);
select '10 повторно — ошибка' as t; select public.exam_save(:aid, '[]', null, true);
select '11 ключ таблицы не читается' as t, count(*) from public.exam_templates;
select '12 чужой результат — нельзя' as t; select * from public.exam_attempt_detail(:aid);
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
select '13 создатель: балл 9/10 и код' as t, score, code, solution is not null, answer_key from public.exam_attempt_detail(:aid);
select '14 список тестов' as t, total, waiting from public.exams_list();
select (select attempt_id from public.exam_results(:id) where username = 'senior1') as sid \gset
select '15 провалил + снять права' as t; select public.exam_verdict(:sid, false, true, 'не начал');
select public.exam_verdict(:aid, true, false, null);
reset role;
select '16 у senior1 права сняты, у tester1 роль осталась' as t, (select count(*) from public.moderators where user_id = '33333333-3333-3333-3333-333333333333') mods, (select role from public.profiles where username = 'tester1') role;
update public.exam_attempts set started_at = now() - interval '1 hour', due_at = now() - interval '10 minutes', submitted_at = null, verdict = null where id = :aid;
set role authenticated;
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', false);
select '17 время вышло — сохранить нельзя' as t; select public.exam_save(:aid, '[]', null, true);
select '18 статус timeout' as t, status from public.exam_mine();
reset role;
select '19 событие' as t, count(*) from public.admin_events where kind = 'exam';
set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
select '20 свой тест сохраняется' as t, public.exam_template_save(null, 'Мой тест', '[{"q":"2+2?","opts":["3","4"]}]', '[1]', null, null) like 't%' as ok;
select '21 без ответа — ошибка' as t; select public.exam_template_save(null, 'X', '[{"q":"2+2?","opts":["3","4"]}]', '[null]', null, null);
select '22 ответ вне вариантов — ошибка' as t; select public.exam_template_save(null, 'X', '[{"q":"2+2?","opts":["3","4"]}]', '[5]', null, null);
select '23 в списке 2 шаблона' as t, count(*) from public.exam_templates_list();
select '24 занятый шаблон не удалить' as t; select public.exam_template_delete('python-1');
select '25 свой удаляется' as t; select public.exam_template_delete((select code from public.exam_templates_list() where title = 'Мой тест'));
select '26 осталось 1' as t, count(*) from public.exam_templates_list();
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', false);
select '27 не создатель — нельзя' as t; select public.exam_template_save(null, 'X', '[{"q":"a","opts":["1","2"]}]', '[0]', null, null);
