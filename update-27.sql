-- update-27: ещё один приз «Фортуны» — «Бурмалда» (l_burmalda): шанс 3%, тираж 100, купить напрямую 2 500 ₽.
-- Встаёт между «Костями» и «Джекпотом». №1 — @deltaofishal, №2 — @peteroxhka (выдал создатель). Безопасно применять повторно.
begin;
insert into public.limited_kinds (kind, price, total, sort, buyable, event) values ('l_burmalda', 2500, 100, 104, true, 'fortune')
  on conflict (kind) do nothing;
update public.limited_kinds set sort = 105 where kind = 'l_jackpot' and sort = 104;
update public.limited_kinds set sort = 106 where kind = 'l_luck' and sort = 105;
insert into public.fortune_prizes (kind, chance_bp) values ('l_burmalda', 300) on conflict (kind) do nothing;
insert into public.limited_items (kind, serial, owner)
  select 'l_burmalda', x.n, p.id from (values ('deltaofishal', 1), ('peteroxhka', 2)) x(nick, n)
  join public.profiles p on p.username = x.nick
  where not exists (select 1 from public.limited_items i where i.kind = 'l_burmalda' and (i.owner = p.id or i.serial = x.n));
alter table public.profiles drop constraint if exists profiles_hidden_badges_check;
alter table public.profiles add constraint profiles_hidden_badges_check check (
  hidden_badges <@ array['creator', 'tester', 'bronze', 'silver', 'gold', 'plus', 'relay', 'donor', 'bro', 'moderator', 'senior', 'bee', 'football', 'premium', 'l_spark', 'l_owl', 'l_coffee', 'l_pond', 'l_bug', 'l_vibe', 'l_neon', 'l_comet', 'l_storm', 'l_ice', 'l_flame', 'l_ghost', 'l_diamond', 'l_eclipse', 'l_legend', 'l_astro', 'l_phoenix', 'l_emperor', 'l_hole', 'l_absolute', 'l_cinema', 'l_clover', 'l_horseshoe', 'l_dice', 'l_burmalda', 'l_jackpot', 'l_luck']::text[]
  and coalesce(array_length(hidden_badges, 1), 0) <= 45);
commit;
