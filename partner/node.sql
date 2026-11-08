-- Узел-партнёр мессенджера. Запускать ОДИН раз в СВОЁМ проекте Supabase → SQL Editor.
-- Узел хранит только зашифрованные данные: прочитать или подделать их он не может.

begin;

-- Публичная корзина: файлы зашифрованы, а их имена — это хеши содержимого
insert into storage.buckets (id, name, public, file_size_limit)
values ('blobs', 'blobs', true, 7340032)
on conflict (id) do nothing;

-- Что и кем загружено (нужно, чтобы удалять могли только авторы)
create table if not exists public.node_objects (
  key text primary key,
  owner uuid not null,
  bytes int not null,
  created_at timestamptz not null default now()
);
alter table public.node_objects enable row level security;   -- доступ только у функции node

-- Суточные лимиты на человека, чтобы узел не забили мусором
create table if not exists public.node_usage (
  user_id uuid not null,
  day date not null default current_date,
  bytes bigint not null default 0,
  objects int not null default 0,
  primary key (user_id, day)
);
alter table public.node_usage enable row level security;

create or replace function public.node_use(p_user uuid, p_bytes int, p_max_bytes bigint, p_max_objects int)
returns boolean language plpgsql security definer set search_path = '' as $$
declare ok boolean;
begin
  insert into public.node_usage (user_id, bytes, objects) values (p_user, p_bytes, 1)
  on conflict (user_id, day) do update
    set bytes = public.node_usage.bytes + excluded.bytes, objects = public.node_usage.objects + 1
    where public.node_usage.bytes + excluded.bytes <= p_max_bytes and public.node_usage.objects < p_max_objects
  returning true into ok;
  return coalesce(ok, false);
end;
$$;
revoke execute on function public.node_use(uuid, int, bigint, int) from public, anon, authenticated;

commit;
