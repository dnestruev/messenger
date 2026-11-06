-- Вставьте весь этот файл в Supabase → SQL Editor → New query и нажмите Run.

-- 1. Профили пользователей (ник)
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text unique not null
    check (char_length(username) between 3 and 24 and username ~ '^[a-z0-9_]+$'),
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "profiles: read for signed-in users"
  on public.profiles for select to authenticated using (true);

-- Профиль создаётся автоматически при регистрации
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, username)
  values (new.id, lower(new.raw_user_meta_data->>'username'));
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Проверка, свободен ли ник (доступна до входа)
create or replace function public.username_available(name text)
returns boolean language sql security definer set search_path = '' stable as $$
  select not exists (select 1 from public.profiles where username = lower(name));
$$;

grant execute on function public.username_available(text) to anon, authenticated;

-- 2. Личные сообщения
create table public.messages (
  id bigint generated always as identity primary key,
  sender_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  receiver_id uuid not null references public.profiles(id) on delete cascade,
  content text not null check (char_length(content) between 1 and 4000),
  created_at timestamptz not null default now()
);

create index messages_pair_idx on public.messages (sender_id, receiver_id, created_at);
create index messages_pair_rev_idx on public.messages (receiver_id, sender_id, created_at);

alter table public.messages enable row level security;

-- Читать можно только свои переписки
create policy "messages: read own"
  on public.messages for select to authenticated
  using (auth.uid() = sender_id or auth.uid() = receiver_id);

-- Отправлять можно только от своего имени и не самому себе
create policy "messages: send as self"
  on public.messages for insert to authenticated
  with check (auth.uid() = sender_id and sender_id <> receiver_id);

-- 3. Мгновенная доставка новых сообщений
alter publication supabase_realtime add table public.messages;
