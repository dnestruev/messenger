-- update-25: уникальный значок «Футбольный мастер» (football) — один навсегда у @sp_89, как «Любитель пчёлок».
-- set_badge его не принимает (выдать/снять через приложение нельзя). Безопасно применять повторно.
begin;
alter table public.badge_grants drop constraint if exists badge_grants_kind_check;
alter table public.badge_grants add constraint badge_grants_kind_check
  check (kind in ('donor', 'tester', 'bronze', 'silver', 'gold', 'plus', 'relay', 'bro', 'bee', 'football'));
create unique index if not exists badge_grants_football_once on public.badge_grants (kind) where kind = 'football';
insert into public.badge_grants (user_id, kind)
  select id, 'football' from public.profiles where username = 'sp_89'
  on conflict do nothing;
alter table public.profiles drop constraint if exists profiles_hidden_badges_check;
alter table public.profiles add constraint profiles_hidden_badges_check check (
  hidden_badges <@ array['creator', 'tester', 'bronze', 'silver', 'gold', 'plus', 'relay', 'donor', 'bro', 'moderator', 'senior', 'bee', 'football', 'premium', 'l_spark', 'l_owl', 'l_coffee', 'l_pond', 'l_bug', 'l_vibe', 'l_neon', 'l_comet', 'l_storm', 'l_ice', 'l_flame', 'l_ghost', 'l_diamond', 'l_eclipse', 'l_legend', 'l_astro', 'l_phoenix', 'l_emperor', 'l_hole', 'l_absolute', 'l_cinema']::text[]
  and coalesce(array_length(hidden_badges, 1), 0) <= 40);
commit;
