-- update-16: уникальный значок «Реальный бро проекта» (kind = 'bro').
--   Ровно один владелец навсегда — @peteroxhka (Пятёрочка). Второму не выдать (уникальный индекс),
--   снять через приложение нельзя: set_badge 'bro' не принимает, а прав на badge_grants у клиентов нет.
--   Безопасно применять повторно.
begin;

alter table public.badge_grants drop constraint if exists badge_grants_kind_check;
alter table public.badge_grants add constraint badge_grants_kind_check
  check (kind in ('donor', 'tester', 'bronze', 'silver', 'gold', 'plus', 'relay', 'bro'));
create unique index if not exists badge_grants_bro_once on public.badge_grants (kind) where kind = 'bro';

insert into public.badge_grants (user_id, kind)
  select id, 'bro' from public.profiles where username = 'peteroxhka'
  on conflict do nothing;

commit;
