-- update-20: 21-й лимитированный статус «Абсолют синема» (l_cinema). Цена и тираж правятся создателем в магазине.
--   Безопасно применять повторно.
begin;

insert into public.limited_kinds (kind, price, total, sort) values ('l_cinema', 10000, 10, 21)
  on conflict (kind) do nothing;

alter table public.profiles drop constraint if exists profiles_hidden_badges_check;
alter table public.profiles add constraint profiles_hidden_badges_check check (
  hidden_badges <@ array['creator', 'tester', 'bronze', 'silver', 'gold', 'plus', 'relay', 'donor', 'bro', 'moderator', 'senior', 'bee', 'l_spark', 'l_owl', 'l_coffee', 'l_pond', 'l_bug', 'l_vibe', 'l_neon', 'l_comet', 'l_storm', 'l_ice', 'l_flame', 'l_ghost', 'l_diamond', 'l_eclipse', 'l_legend', 'l_astro', 'l_phoenix', 'l_emperor', 'l_hole', 'l_absolute', 'l_cinema']::text[]
  and coalesce(array_length(hidden_badges, 1), 0) <= 40);

commit;
