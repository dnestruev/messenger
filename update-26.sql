-- update-26: ивент «Фортуна» — рулетка редких статусов на 4 недели.
--   Призы — обычные лимитки (номер, «С рук», «Мои»): Клевер, Подкова, Кости, Джекпот и сверхредкая «Удача» (3 шт., не продаётся).
--   3 бесплатные крутки в день (полночь по Москве) + платные (заявка донатом → создатель начисляет).
--   Что выпало, решает сервер (fortune_spin). Купить напрямую можно всё, кроме «Удачи», и только пока идёт ивент.
--   Безопасно применять повторно (срок ивента не сбрасывается).
begin;

-- статусы ивента в общей таблице лимиток
alter table public.limited_kinds add column if not exists buyable boolean not null default true;
alter table public.limited_kinds add column if not exists event text;
insert into public.limited_kinds (kind, price, total, sort, buyable, event) values
  ('l_clover', 500, 300, 101, true, 'fortune'),
  ('l_horseshoe', 1500, 150, 102, true, 'fortune'),
  ('l_dice', 4000, 60, 103, true, 'fortune'),
  ('l_jackpot', 15000, 20, 104, true, 'fortune'),
  ('l_luck', 500000, 3, 105, false, 'fortune')
  on conflict (kind) do nothing;

create table if not exists public.fortune_config (
  id int primary key default 1 check (id = 1),
  starts_at timestamptz not null default now(),
  ends_at timestamptz not null default now() + interval '28 days',
  free_per_day int not null default 3 check (free_per_day between 0 and 100),
  spin_price int not null default 100 check (spin_price > 0),
  pack_size int not null default 10 check (pack_size > 1),
  pack_price int not null default 900 check (pack_price > 0)
);
insert into public.fortune_config (id) values (1) on conflict (id) do nothing;

-- шансы в сотых долях процента (10000 = 100%); остальное — «пусто»
create table if not exists public.fortune_prizes (
  kind text primary key references public.limited_kinds(kind),
  chance_bp int not null check (chance_bp between 0 and 10000)
);
insert into public.fortune_prizes (kind, chance_bp) values
  ('l_clover', 2500), ('l_horseshoe', 1200), ('l_dice', 600), ('l_jackpot', 190), ('l_luck', 10)
  on conflict (kind) do nothing;

create table if not exists public.fortune_balance (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  paid_left int not null default 0 check (paid_left >= 0)
);
create table if not exists public.fortune_spins (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  paid boolean not null,
  kind text references public.limited_kinds(kind),
  item_id bigint references public.limited_items(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists fortune_spins_user_idx on public.fortune_spins (user_id, created_at desc);
create table if not exists public.fortune_orders (
  id bigint generated always as identity primary key,
  buyer uuid not null references public.profiles(id) on delete cascade,
  spins int not null check (spins between 1 and 10000),
  price int not null,
  proof text not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  note text,
  created_at timestamptz not null default now(),
  decided_at timestamptz
);
create index if not exists fortune_orders_status_idx on public.fortune_orders (status, created_at desc);

alter table public.fortune_config enable row level security;
alter table public.fortune_prizes enable row level security;
alter table public.fortune_balance enable row level security;
alter table public.fortune_spins enable row level security;
alter table public.fortune_orders enable row level security;
revoke all on public.fortune_config, public.fortune_prizes, public.fortune_balance, public.fortune_spins, public.fortune_orders from anon, authenticated;

create or replace function public.fortune_active() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.fortune_config where now() between starts_at and ends_at)
$$;

create or replace function public.fortune_free_left(uid uuid) returns int
language sql stable security definer set search_path = '' as $$
  select greatest(0, (select free_per_day from public.fortune_config) - (select count(*)::int from public.fortune_spins s
    where s.user_id = uid and not s.paid
      and s.created_at >= (date_trunc('day', now() at time zone 'Europe/Moscow') at time zone 'Europe/Moscow')))
$$;

create or replace function public.fortune_state()
returns table (active boolean, starts_at timestamptz, ends_at timestamptz, free_left int, paid_left int,
               spin_price int, pack_size int, pack_price int, next_free timestamptz)
language sql stable security definer set search_path = '' as $$
  select public.fortune_active(), c.starts_at, c.ends_at, public.fortune_free_left(auth.uid()),
    coalesce((select b.paid_left from public.fortune_balance b where b.user_id = auth.uid()), 0),
    c.spin_price, c.pack_size, c.pack_price,
    (date_trunc('day', now() at time zone 'Europe/Moscow') + interval '1 day') at time zone 'Europe/Moscow'
  from public.fortune_config c where auth.uid() is not null
$$;

create or replace function public.fortune_prizes_list()
returns table (kind text, chance_bp int, total int, given int, price int, buyable boolean)
language sql stable security definer set search_path = '' as $$
  select p.kind, p.chance_bp, k.total,
    (select count(*)::int from public.limited_items i where i.kind = p.kind)
      + (select count(*)::int from public.limited_orders o where o.kind = p.kind and o.status = 'pending' and not o.resale),
    k.price, k.buyable
  from public.fortune_prizes p join public.limited_kinds k on k.kind = p.kind
  where auth.uid() is not null order by k.sort
$$;

-- крутка: сначала бесплатные, потом платные. Возвращает приз (или null) и остаток попыток.
create or replace function public.fortune_spin()
returns table (kind text, serial int, item_id bigint, free_left int, paid_left int)
language plpgsql security definer set search_path = '' as $$
declare me uuid := auth.uid(); is_paid boolean; roll int; acc int := 0; won text; pr record;
        k public.limited_kinds; n int; new_item bigint; left_paid int; nick text; creator uuid;
begin
  if me is null then raise exception 'not signed in'; end if;
  if public.is_banned(me) then raise exception 'banned'; end if;
  if not public.fortune_active() then raise exception 'fortune is over'; end if;
  insert into public.fortune_balance (user_id) values (me) on conflict (user_id) do nothing;
  perform 1 from public.fortune_balance b where b.user_id = me for update;          -- одна крутка за раз у человека
  if public.fortune_free_left(me) > 0 then is_paid := false;
  elsif (select b.paid_left from public.fortune_balance b where b.user_id = me) > 0 then
    is_paid := true;
    update public.fortune_balance b set paid_left = b.paid_left - 1 where b.user_id = me;
  else raise exception 'no spins left'; end if;
  -- случайное число 0..9999 из gen_random_uuid (криптостойкий генератор)
  roll := (('x' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8))::bit(32)::bigint % 10000)::int;
  for pr in select p.kind, p.chance_bp from public.fortune_prizes p join public.limited_kinds lk on lk.kind = p.kind order by lk.sort desc loop
    acc := acc + pr.chance_bp;
    if roll < acc then won := pr.kind; exit; end if;
  end loop;
  if won is not null then
    select * into k from public.limited_kinds lk where lk.kind = won for update;
    if (select count(*) from public.limited_items i where i.kind = won)
       + (select count(*) from public.limited_orders o where o.kind = won and o.status = 'pending' and not o.resale) >= k.total then
      won := null;                                                                     -- тираж кончился — «пусто»
    else
      select coalesce(max(i.serial), 0) + 1 into n from public.limited_items i where i.kind = won;
      insert into public.limited_items (kind, serial, owner) values (won, n, me) returning id into new_item;
    end if;
  end if;
  insert into public.fortune_spins (user_id, paid, kind, item_id) values (me, is_paid, won, new_item);
  if won = 'l_luck' then
    select '@' || p.username into nick from public.profiles p where p.id = me;
    select p.id into creator from public.profiles p where p.role = 'creator' order by p.created_at limit 1;
    if creator is not null then
      insert into public.news (author, body) values (creator,
        '✨ **' || nick || ' выбил «Удачу» №' || n || '!** Сверхредкий статус из «Фортуны» — всего 3 на весь мессенджер. Шанс был 0,1%. Поздравляем! 🎰');
    end if;
    perform public.log_event('fortune_luck', nick || ' выбил «Удачу» №' || n || ' в «Фортуне»', 'user:' || substr(nick, 2));
  elsif won = 'l_jackpot' then
    select '@' || p.username into nick from public.profiles p where p.id = me;
    perform public.log_event('fortune_win', nick || ' выбил «Джекпот» №' || n || ' в «Фортуне»', 'user:' || substr(nick, 2));
  end if;
  select b.paid_left into left_paid from public.fortune_balance b where b.user_id = me;
  return query select won, case when won is null then null else n end, new_item, public.fortune_free_left(me), left_paid;
end $$;

-- последние крутки человека (для ленты «Мои выигрыши»)
create or replace function public.fortune_my_spins()
returns table (kind text, serial int, paid boolean, created_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select s.kind, i.serial, s.paid, s.created_at from public.fortune_spins s left join public.limited_items i on i.id = s.item_id
  where s.user_id = auth.uid() order by s.id desc limit 30
$$;

-- заявка на платные крутки: пачки по pack_size дешевле
create or replace function public.fortune_order(p_spins int, p_proof text)
returns bigint language plpgsql security definer set search_path = '' as $$
declare me uuid := auth.uid(); c public.fortune_config; proof text := trim(coalesce(p_proof, '')); oid bigint; cost int;
begin
  if me is null then raise exception 'not signed in'; end if;
  if public.is_banned(me) then raise exception 'banned'; end if;
  if not public.fortune_active() then raise exception 'fortune is over'; end if;
  if p_spins is null or p_spins < 1 or p_spins > 10000 then raise exception 'bad spins count'; end if;
  if char_length(proof) < 5 or char_length(proof) > 300 then raise exception 'bad proof'; end if;
  if (select count(*) from public.fortune_orders o where o.buyer = me and o.status = 'pending') >= 3 then raise exception 'too many pending orders'; end if;
  select * into c from public.fortune_config;
  cost := (p_spins / c.pack_size) * c.pack_price + (p_spins % c.pack_size) * c.spin_price;
  insert into public.fortune_orders (buyer, spins, price, proof) values (me, p_spins, cost, proof) returning id into oid;
  perform public.log_event('order_fortune', 'Заявка на ' || p_spins || ' круток «Фортуны» от ' || public.ev_nick(me) || ' — ' || public.ev_money(cost), 'orders');
  return oid;
end $$;

create or replace function public.fortune_my_orders()
returns table (id bigint, spins int, price int, status text, note text, created_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select o.id, o.spins, o.price, o.status, o.note, o.created_at from public.fortune_orders o
  where o.buyer = auth.uid() order by o.created_at desc limit 50
$$;

create or replace function public.fortune_cancel(p_id bigint)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.fortune_orders o set status = 'cancelled', decided_at = now()
  where o.id = p_id and o.buyer = auth.uid() and o.status = 'pending';
end $$;

create or replace function public.fortune_orders_admin(p_all boolean default false)
returns table (id bigint, buyer text, spins int, price int, proof text, status text, note text, created_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_creator(auth.uid()) then raise exception 'only creators'; end if;
  return query select o.id, b.username, o.spins, o.price, o.proof, o.status, o.note, o.created_at
  from public.fortune_orders o left join public.profiles b on b.id = o.buyer
  where p_all or o.status = 'pending' order by (o.status = 'pending') desc, o.created_at desc limit 200;
end $$;

create or replace function public.fortune_decide(p_id bigint, p_ok boolean, p_note text)
returns void language plpgsql security definer set search_path = '' as $$
declare o public.fortune_orders;
begin
  if not public.is_creator(auth.uid()) then raise exception 'only creators'; end if;
  select * into o from public.fortune_orders x where x.id = p_id for update;
  if o.id is null or o.status <> 'pending' then raise exception 'order not pending'; end if;
  update public.fortune_orders x set status = case when p_ok then 'approved' else 'rejected' end,
    note = left(nullif(trim(coalesce(p_note, '')), ''), 200), decided_at = now() where x.id = p_id;
  if p_ok then
    insert into public.fortune_balance (user_id, paid_left) values (o.buyer, o.spins)
      on conflict (user_id) do update set paid_left = public.fortune_balance.paid_left + excluded.paid_left;
  end if;
end $$;

-- прямая покупка статусов ивента: «Удачу» — нельзя, остальные — только пока идёт ивент
create or replace function public.fortune_guard_order() returns trigger
language plpgsql security definer set search_path = '' as $$
declare k public.limited_kinds;
begin
  if new.resale then return new; end if;
  select * into k from public.limited_kinds where kind = new.kind;
  if not k.buyable then raise exception 'not for sale'; end if;
  if k.event = 'fortune' and not public.fortune_active() then raise exception 'fortune is over'; end if;
  return new;
end $$;
drop trigger if exists fortune_guard_order on public.limited_orders;
create trigger fortune_guard_order before insert on public.limited_orders
  for each row execute function public.fortune_guard_order();

revoke all on function public.fortune_active(), public.fortune_free_left(uuid), public.fortune_state(), public.fortune_prizes_list(),
  public.fortune_spin(), public.fortune_my_spins(), public.fortune_order(int, text), public.fortune_my_orders(), public.fortune_cancel(bigint),
  public.fortune_orders_admin(boolean), public.fortune_decide(bigint, boolean, text), public.fortune_guard_order() from public, anon;
grant execute on function public.fortune_state(), public.fortune_prizes_list(), public.fortune_spin(), public.fortune_my_spins(),
  public.fortune_order(int, text), public.fortune_my_orders(), public.fortune_cancel(bigint),
  public.fortune_orders_admin(boolean), public.fortune_decide(bigint, boolean, text) to authenticated;

alter table public.profiles drop constraint if exists profiles_hidden_badges_check;
alter table public.profiles add constraint profiles_hidden_badges_check check (
  hidden_badges <@ array['creator', 'tester', 'bronze', 'silver', 'gold', 'plus', 'relay', 'donor', 'bro', 'moderator', 'senior', 'bee', 'football', 'premium', 'l_spark', 'l_owl', 'l_coffee', 'l_pond', 'l_bug', 'l_vibe', 'l_neon', 'l_comet', 'l_storm', 'l_ice', 'l_flame', 'l_ghost', 'l_diamond', 'l_eclipse', 'l_legend', 'l_astro', 'l_phoenix', 'l_emperor', 'l_hole', 'l_absolute', 'l_cinema', 'l_clover', 'l_horseshoe', 'l_dice', 'l_jackpot', 'l_luck']::text[]
  and coalesce(array_length(hidden_badges, 1), 0) <= 45);
commit;
