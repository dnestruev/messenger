-- update-30: проверочные тесты для команды (старшие модераторы и тестеры)
-- Создатель запускает тест → каждому из команды приходит задание с обратным отсчётом.
-- Начал — пошло время на прохождение. Ответы сохраняются по ходу; время вышло — засчитывается то, что успел.
-- Создатель видит ответы рядом с правильными, код задачи и эталонное решение, ставит «сдал» / «провалил»
-- (по желанию сразу снимает роль тестера и права модератора).
begin;

create table if not exists public.exam_templates (
  code text primary key check (code ~ '^[a-z0-9_-]{2,32}$'),
  title text not null check (char_length(title) between 1 and 80),
  questions jsonb not null,           -- [{ "q": "...", "opts": ["...", ...] }, ...]
  answer_key jsonb not null,          -- [2, 1, ...] — номер правильного варианта (с нуля); клиентам не отдаётся
  task text,                          -- практическое задание
  solution text                       -- эталонное решение (видит только создатель)
);
alter table public.exam_templates enable row level security;

create table if not exists public.exams (
  id bigserial primary key,
  template text not null references public.exam_templates(code),
  title text not null,
  deadline timestamptz not null,      -- до какого времени надо начать
  minutes int not null check (minutes between 5 and 600),
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
alter table public.exams enable row level security;

create table if not exists public.exam_attempts (
  id bigserial primary key,
  exam_id bigint not null references public.exams(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  started_at timestamptz,
  due_at timestamptz,
  submitted_at timestamptz,
  answers jsonb not null default '[]'::jsonb,
  code text check (code is null or char_length(code) <= 20000),
  verdict text check (verdict in ('pass', 'fail')),
  note text check (note is null or char_length(note) <= 300),
  checked_at timestamptz,
  unique (exam_id, user_id)
);
alter table public.exam_attempts enable row level security;

-- состояние попытки — считается на лету
create or replace function public.exam_status(a public.exam_attempts, e public.exams) returns text
language sql stable set search_path = '' as $$
  select case
    when a.verdict is not null then a.verdict
    when a.submitted_at is not null then 'submitted'
    when a.started_at is not null and now() > a.due_at then 'timeout'
    when a.started_at is not null then 'in_progress'
    when now() > e.deadline then 'missed'
    else 'assigned' end;
$$;
create or replace function public.exam_score(answers jsonb, answer_key jsonb) returns int
language sql immutable set search_path = '' as $$
  select count(*)::int from jsonb_array_elements(answer_key) with ordinality k(v, i)
  where (answers -> (k.i::int - 1)) = k.v;
$$;

-- создателю: шаблоны и запуск
create or replace function public.exam_templates_list()
returns table (code text, title text, questions int)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_creator(auth.uid()) then raise exception 'only creators'; end if;
  return query select t.code, t.title, jsonb_array_length(t.questions) from public.exam_templates t order by t.title;
end;
$$;

create or replace function public.exam_launch(p_template text, p_hours int, p_minutes int)
returns bigint language plpgsql security definer set search_path = '' as $$
declare t public.exam_templates; eid bigint; n int;
begin
  if not public.is_creator(auth.uid()) then raise exception 'only creators'; end if;
  select * into t from public.exam_templates where code = p_template;
  if t.code is null then raise exception 'no such exam'; end if;
  if p_hours is null or p_hours < 1 or p_hours > 720 then raise exception 'bad exam deadline'; end if;
  if p_minutes is null or p_minutes < 5 or p_minutes > 600 then raise exception 'bad exam time'; end if;
  insert into public.exams (template, title, deadline, minutes, created_by)
    values (t.code, t.title, now() + make_interval(hours => p_hours), p_minutes, auth.uid()) returning id into eid;
  insert into public.exam_attempts (exam_id, user_id)
    select eid, p.id from public.profiles p
    where not public.is_banned(p.id) and not public.is_creator(p.id)
      and (p.role = 'tester' or exists (select 1 from public.moderators m where m.user_id = p.id and m.level = 'senior' and (m.until is null or m.until > now())))
    on conflict do nothing;
  get diagnostics n = row_count;
  perform public.log_event('exam', 'Запущен тест «' || t.title || '»: ' || n || ' чел., срок ' || p_hours || ' ч, на прохождение ' || p_minutes || ' мин', 'exams');
  return eid;
end;
$$;

-- мне: назначенные тесты (для плашки с отсчётом)
create or replace function public.exam_mine()
returns table (attempt_id bigint, title text, deadline timestamptz, minutes int, started_at timestamptz, due_at timestamptz, status text, questions int, has_task boolean)
language sql stable security definer set search_path = '' as $$
  select a.id, e.title, e.deadline, e.minutes, a.started_at, a.due_at, public.exam_status(a, e),
    jsonb_array_length(t.questions), t.task is not null
  from public.exam_attempts a join public.exams e on e.id = a.exam_id join public.exam_templates t on t.code = e.template
  where a.user_id = auth.uid() and e.created_at > now() - interval '30 days'
  order by e.created_at desc;
$$;

-- начать (или продолжить): вопросы без ответов, задание, сохранённое
create or replace function public.exam_start(p_attempt bigint)
returns table (title text, questions jsonb, task text, due_at timestamptz, answers jsonb, code text, status text)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare a public.exam_attempts; e public.exams; t public.exam_templates;
begin
  select * into a from public.exam_attempts where id = p_attempt and user_id = auth.uid() for update;
  if a.id is null then raise exception 'exam not found'; end if;
  select * into e from public.exams where id = a.exam_id;
  select * into t from public.exam_templates where code = e.template;
  if a.started_at is null then
    if now() > e.deadline then raise exception 'exam missed'; end if;
    update public.exam_attempts set started_at = now(), due_at = now() + make_interval(mins => e.minutes) where id = a.id
      returning * into a;
  end if;
  return query select e.title, (select jsonb_agg(jsonb_build_object('q', x -> 'q', 'opts', x -> 'opts')) from jsonb_array_elements(t.questions) x),
    t.task, a.due_at, a.answers, a.code, public.exam_status(a, e);
end;
$$;

-- сохранить ответы по ходу; p_final — «Сдать»
create or replace function public.exam_save(p_attempt bigint, p_answers jsonb, p_code text, p_final boolean)
returns text language plpgsql security definer set search_path = '' as $$
declare a public.exam_attempts; e public.exams;
begin
  select * into a from public.exam_attempts where id = p_attempt and user_id = auth.uid() for update;
  if a.id is null then raise exception 'exam not found'; end if;
  select * into e from public.exams where id = a.exam_id;
  if a.started_at is null then raise exception 'exam not started'; end if;
  if a.submitted_at is not null or a.verdict is not null then raise exception 'exam already submitted'; end if;
  if now() > a.due_at + interval '30 seconds' then raise exception 'exam time is over'; end if;
  if jsonb_typeof(coalesce(p_answers, '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p_answers, '[]'::jsonb)) > 100 then raise exception 'bad answers'; end if;
  if char_length(coalesce(p_code, '')) > 20000 then raise exception 'exam code too long'; end if;
  update public.exam_attempts set answers = coalesce(p_answers, '[]'::jsonb), code = p_code,
    submitted_at = case when p_final then now() end
  where id = a.id returning * into a;
  return public.exam_status(a, e);
end;
$$;

-- создателю: результаты
create or replace function public.exams_list()
returns table (id bigint, title text, deadline timestamptz, minutes int, created_at timestamptz, total int, done int, waiting int)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_creator(auth.uid()) then raise exception 'only creators'; end if;
  return query select e.id, e.title, e.deadline, e.minutes, e.created_at,
    (select count(*)::int from public.exam_attempts a where a.exam_id = e.id),
    (select count(*)::int from public.exam_attempts a where a.exam_id = e.id and a.verdict is not null),
    (select count(*)::int from public.exam_attempts a where a.exam_id = e.id and a.verdict is null and (a.submitted_at is not null or now() > a.due_at))
  from public.exams e order by e.created_at desc limit 50;
end;
$$;

create or replace function public.exam_results(p_exam bigint)
returns table (attempt_id bigint, user_id uuid, username text, mod_level text, role text, status text, score int, questions int, started_at timestamptz, submitted_at timestamptz, verdict text)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_creator(auth.uid()) then raise exception 'only creators'; end if;
  return query select a.id, a.user_id, p.username, m.level, p.role, public.exam_status(a, e),
    case when a.started_at is not null then public.exam_score(a.answers, t.answer_key) end, jsonb_array_length(t.answer_key),
    a.started_at, a.submitted_at, a.verdict
  from public.exam_attempts a join public.exams e on e.id = a.exam_id join public.exam_templates t on t.code = e.template
    join public.profiles p on p.id = a.user_id left join public.moderators m on m.user_id = a.user_id
  where a.exam_id = p_exam order by p.username;
end;
$$;

create or replace function public.exam_attempt_detail(p_attempt bigint)
returns table (username text, title text, status text, questions jsonb, answer_key jsonb, answers jsonb, score int, task text, code text, solution text, started_at timestamptz, submitted_at timestamptz, verdict text, note text)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_creator(auth.uid()) then raise exception 'only creators'; end if;
  return query select p.username, e.title, public.exam_status(a, e), t.questions, t.answer_key, a.answers,
    public.exam_score(a.answers, t.answer_key), t.task, a.code, t.solution, a.started_at, a.submitted_at, a.verdict, a.note
  from public.exam_attempts a join public.exams e on e.id = a.exam_id join public.exam_templates t on t.code = e.template
    join public.profiles p on p.id = a.user_id
  where a.id = p_attempt;
end;
$$;

-- вердикт; p_strip — заодно снять роль тестера и права модератора
create or replace function public.exam_verdict(p_attempt bigint, p_pass boolean, p_strip boolean, p_note text)
returns void language plpgsql security definer set search_path = '' as $$
declare a public.exam_attempts;
begin
  if not public.is_creator(auth.uid()) then raise exception 'only creators'; end if;
  select * into a from public.exam_attempts where id = p_attempt for update;
  if a.id is null then raise exception 'exam not found'; end if;
  update public.exam_attempts set verdict = case when p_pass then 'pass' else 'fail' end, checked_at = now(), note = left(nullif(trim(p_note), ''), 300)
    where id = a.id;
  if not p_pass and p_strip then
    update public.profiles set role = null where id = a.user_id and role = 'tester';
    if exists (select 1 from public.moderators where user_id = a.user_id) then
      delete from public.moderators where user_id = a.user_id;
      insert into public.mod_log (actor, action, target, details) values (auth.uid(), 'mod_off', a.user_id, 'не сдал тест');
    end if;
  end if;
end;
$$;

revoke all on function public.exam_status(public.exam_attempts, public.exams), public.exam_score(jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.exam_templates_list(), public.exam_launch(text, int, int), public.exam_mine(), public.exam_start(bigint),
  public.exam_save(bigint, jsonb, text, boolean), public.exams_list(), public.exam_results(bigint), public.exam_attempt_detail(bigint),
  public.exam_verdict(bigint, boolean, boolean, text) from public, anon;
grant execute on function public.exam_templates_list(), public.exam_launch(text, int, int), public.exam_mine(), public.exam_start(bigint),
  public.exam_save(bigint, jsonb, text, boolean), public.exams_list(), public.exam_results(bigint), public.exam_attempt_detail(bigint),
  public.exam_verdict(bigint, boolean, boolean, text) to authenticated;

-- тест «Основы Python» (из присланного файла, вариант 2); ответы проверены
insert into public.exam_templates (code, title, questions, answer_key, task, solution) values ('python-1', 'Основы Python', $j$[
 {"q": "Какой тип данных в Python является неизменяемым (immutable)?", "opts": ["list (список)", "dict (словарь)", "tuple (кортеж)", "set (множество)"]},
 {"q": "Что выведет следующий код: print(type(10 / 2))?", "opts": ["<class 'int'>", "<class 'float'>", "<class 'str'>", "<class 'bool'>"]},
 {"q": "Какое ключевое слово используется для создания функции в Python?", "opts": ["func", "function", "define", "def"]},
 {"q": "Какой оператор используется для возведения числа в степень?", "opts": ["^", "**", "//", "%"]},
 {"q": "Как правильно добавить элемент 'apple' в конец списка fruits?", "opts": ["fruits.add('apple')", "fruits.insert('apple')", "fruits.append('apple')", "fruits.push('apple')"]},
 {"q": "Что выведет код: print('Python'[1:4])?", "opts": ["Pyt", "yth", "ytho", "tho"]},
 {"q": "Какая функция используется для получения данных от пользователя с клавиатуры?", "opts": ["scan()", "read()", "get()", "input()"]},
 {"q": "Что вернет выражение bool('') (пустая строка)?", "opts": ["True", "False", "None", "Ошибку TypeError"]},
 {"q": "Как в Python обозначаются однострочные комментарии?", "opts": ["// комментарий", "/* комментарий */", "# комментарий", "-- комментарий"]},
 {"q": "Сколько раз выполнится цикл: for i in range(3):?", "opts": ["2 раза", "3 раза", "4 раза", "Бесконечно"]}
]$j$::jsonb, '[2, 1, 3, 1, 2, 1, 3, 1, 2, 1]'::jsonb,
$t$«Подсчёт чётных чисел». Напишите программу на Python, которая запрашивает у пользователя целое положительное число N, а затем выводит на экран все чётные числа от 1 до N включительно и их общую сумму.

Требования:
• input() для ввода N и перевод в целое число (int);
• цикл (for или while) и if для проверки чётности;
• вывести сами чётные числа и их сумму в понятном виде.

Пример:
Введите число N: 6
Чётные числа: 2 4 6
Сумма чётных чисел: 12$t$,
$s$n = int(input('Введите число N: '))
evens = []
total = 0
for i in range(1, n + 1):
    if i % 2 == 0:
        evens.append(i)
        total += i
print('Чётные числа:', *evens)
print('Сумма чётных чисел:', total)$s$)
on conflict (code) do update set title = excluded.title, questions = excluded.questions, answer_key = excluded.answer_key,
  task = excluded.task, solution = excluded.solution;

commit;
