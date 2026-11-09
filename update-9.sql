-- Обновление 9: «был(а) в сети …» и приватность.
-- «В сети сейчас» работает без базы (Realtime Presence). Здесь — только время последнего визита.
-- Запускать ОДИН раз в Supabase (центр) → SQL Editor, после update-8.sql.

begin;

-- Отдельная таблица без прямого доступа: читать можно только через seen_of, которая прячет время у скрывающих
create table if not exists public.last_seen (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  seen_at timestamptz not null default now(),
  hidden boolean not null default false
);
alter table public.last_seen enable row level security;

-- Отметиться «я здесь» (приложение вызывает раз в пару минут, пока открыто)
create or replace function public.touch_seen()
returns void language sql security definer set search_path = '' as $$
  insert into public.last_seen (user_id, seen_at) values (auth.uid(), now())
  on conflict (user_id) do update set seen_at = now();
$$;

-- Скрывать своё время. Как в Telegram: кто скрывает своё, тот не видит чужое.
create or replace function public.set_hide_seen(p_hidden boolean)
returns void language sql security definer set search_path = '' as $$
  insert into public.last_seen (user_id, hidden) values (auth.uid(), p_hidden)
  on conflict (user_id) do update set hidden = p_hidden;
$$;

-- Когда были в сети. seen_at = null — время скрыто (показываем «был(а) недавно», если был за последние 3 дня)
create or replace function public.seen_of(p_ids uuid[])
returns table (user_id uuid, seen_at timestamptz, recently boolean, hidden boolean)
language sql security definer set search_path = '' stable as $$
  with me as (select coalesce((select hidden from public.last_seen where user_id = auth.uid()), false) as hides)
  select s.user_id,
         case when s.user_id = auth.uid() or (not s.hidden and not me.hides) then s.seen_at end,
         s.seen_at > now() - interval '3 days',
         s.hidden
  from public.last_seen s, me
  where s.user_id = any(p_ids) and auth.uid() is not null
  limit 500;
$$;

do $$
declare f text;
begin
  foreach f in array array['touch_seen()', 'set_hide_seen(boolean)', 'seen_of(uuid[])'] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

commit;
