-- Обновление 13: отчёты о звонках.
-- Каждое устройство после звонка присылает короткий отчёт: этапы, типы сетевых адресов (без самих адресов),
-- ошибки, модель браузера. Без этого причину «не соединилось» на чужих телефонах не узнать.
-- Писать может только сам участник звонка (про себя), читать — только создатель. Старше 30 дней удаляется.
-- Запускать ОДИН раз в Supabase (центр) → SQL Editor, после update-12.sql.

begin;

create table if not exists public.call_reports (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  call_id uuid not null,
  dir text not null check (dir in ('in', 'out')),
  status text not null check (char_length(status) <= 20),
  report text not null check (char_length(report) <= 4000),
  ua text check (char_length(ua) <= 300),
  created_at timestamptz not null default now()
);
create index if not exists call_reports_created on public.call_reports (created_at desc);
alter table public.call_reports enable row level security;

drop policy if exists "call_reports: insert own" on public.call_reports;
create policy "call_reports: insert own" on public.call_reports for insert to authenticated
  with check (user_id = (select auth.uid()));
drop policy if exists "call_reports: creators read" on public.call_reports;
create policy "call_reports: creators read" on public.call_reports for select to authenticated
  using (public.is_creator((select auth.uid())));

-- сколько своих отчётов за последний час (сама таблица вызывающему не видна — считаем с правами владельца)
create or replace function public.my_recent_call_reports()
returns int language sql stable security definer set search_path = '' as $$
  select count(*)::int from public.call_reports where user_id = auth.uid() and created_at > now() - interval '1 hour';
$$;
revoke execute on function public.my_recent_call_reports() from public, anon;
grant execute on function public.my_recent_call_reports() to authenticated;

-- время ставит база; не больше 60 отчётов в час с одного аккаунта (защита от мусора).
-- Без security definer: проверка current_user работает только так (см. грабли в CLAUDE.md).
create or replace function public.protect_call_report()
returns trigger language plpgsql set search_path = '' as $$
begin
  if current_user in ('authenticated', 'anon') then
    new.created_at := now();
    if public.my_recent_call_reports() >= 60 then
      raise exception 'too many call reports';
    end if;
  end if;
  return new;
end;
$$;
revoke execute on function public.protect_call_report() from public, anon, authenticated;
drop trigger if exists call_reports_protect on public.call_reports;
create trigger call_reports_protect before insert on public.call_reports
  for each row execute function public.protect_call_report();

-- уборка раз в сутки
do $$ begin
  if exists (select 1 from pg_namespace where nspname = 'cron') then
    perform cron.schedule('call-reports-cleanup', '17 3 * * *',
      $q$delete from public.call_reports where created_at < now() - interval '30 days'$q$);
  end if;
end $$;

commit;
