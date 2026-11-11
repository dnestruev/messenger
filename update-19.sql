-- update-19: магазин лимитированных статусов + уникальный значок «Любитель пчёлок».
--   limited_kinds — 20 статусов (цена, тираж; правит создатель через limited_set);
--   limited_items — выпущенные экземпляры (номер, владелец, цена перепродажи);
--   limited_orders — заявки: человек платит донатом и присылает подтверждение, создатель проверяет и выдаёт.
--   Перепродажа: владелец выставляет цену, покупатель шлёт заявку ПРОДАВЦУ, рассчитываются они сами,
--   продавец подтверждает — статус переходит. Комиссии нет, создатель в этом не участвует.
--   Деньги приложение не видит — только заявки. Безопасно применять повторно.
begin;

alter table public.badge_grants drop constraint if exists badge_grants_kind_check;
alter table public.badge_grants add constraint badge_grants_kind_check
  check (kind in ('donor', 'tester', 'bronze', 'silver', 'gold', 'plus', 'relay', 'bro', 'bee'));
create unique index if not exists badge_grants_bee_once on public.badge_grants (kind) where kind = 'bee';
insert into public.badge_grants (user_id, kind)
  select id, 'bee' from public.profiles where username = 'skitle'
  on conflict do nothing;

create table if not exists public.limited_kinds (
  kind text primary key check (kind ~ '^l_[a-z]+$' and char_length(kind) <= 16),
  price int not null check (price between 1 and 10000000),
  total int not null check (total between 0 and 100000),
  sort int not null
);
insert into public.limited_kinds (kind, price, total, sort) values
  ('l_spark', 700, 100, 1),
  ('l_owl', 900, 90, 2),
  ('l_coffee', 1200, 80, 3),
  ('l_pond', 1500, 70, 4),
  ('l_bug', 1800, 60, 5),
  ('l_vibe', 2200, 50, 6),
  ('l_neon', 2700, 45, 7),
  ('l_comet', 3200, 40, 8),
  ('l_storm', 3800, 35, 9),
  ('l_ice', 4500, 30, 10),
  ('l_flame', 5200, 25, 11),
  ('l_ghost', 6000, 20, 12),
  ('l_diamond', 7000, 15, 13),
  ('l_eclipse', 8000, 12, 14),
  ('l_legend', 9500, 10, 15),
  ('l_astro', 11000, 8, 16),
  ('l_phoenix', 13000, 6, 17),
  ('l_emperor', 15000, 5, 18),
  ('l_hole', 17500, 3, 19),
  ('l_absolute', 20000, 1, 20)
  on conflict (kind) do nothing;

create table if not exists public.limited_items (
  id bigint generated always as identity primary key,
  kind text not null references public.limited_kinds(kind),
  serial int not null,
  owner uuid not null references public.profiles(id) on delete cascade,
  sale_price int check (sale_price is null or sale_price between 100 and 10000000),
  acquired_at timestamptz not null default now(),
  unique (kind, serial)
);
create index if not exists limited_items_owner_idx on public.limited_items (owner);

create table if not exists public.limited_orders (
  id bigint generated always as identity primary key,
  kind text not null references public.limited_kinds(kind),
  item_id bigint references public.limited_items(id) on delete set null,
  buyer uuid not null references public.profiles(id) on delete cascade,
  seller uuid references public.profiles(id) on delete set null,
  resale boolean not null default false,
  price int not null,
  proof text not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  note text,
  created_at timestamptz not null default now(),
  decided_at timestamptz
);
create index if not exists limited_orders_status_idx on public.limited_orders (status, created_at desc);
create index if not exists limited_orders_buyer_idx on public.limited_orders (buyer);

alter table public.limited_kinds enable row level security;
alter table public.limited_items enable row level security;
alter table public.limited_orders enable row level security;
revoke all on public.limited_kinds, public.limited_items, public.limited_orders from anon, authenticated;

-- витрина: цена, тираж, сколько продано и сколько в заявках
create or replace function public.limited_catalog()
returns table (kind text, price int, total int, sold int, pending int)
language sql stable security definer set search_path = '' as $$
  select k.kind, k.price, k.total,
    (select count(*)::int from public.limited_items i where i.kind = k.kind),
    (select count(*)::int from public.limited_orders o where o.kind = k.kind and o.status = 'pending' and not o.resale)
  from public.limited_kinds k where auth.uid() is not null order by k.sort;
$$;

-- «с рук»: что выставлено на перепродажу
create or replace function public.limited_market()
returns table (item_id bigint, kind text, serial int, seller uuid, price int, reserved boolean)
language sql stable security definer set search_path = '' as $$
  select i.id, i.kind, i.serial, i.owner, i.sale_price,
    exists (select 1 from public.limited_orders o where o.item_id = i.id and o.status = 'pending')
  from public.limited_items i join public.limited_kinds k on k.kind = i.kind
  where auth.uid() is not null and i.sale_price is not null
  order by k.sort desc, i.sale_price;
$$;

create or replace function public.limited_mine()
returns table (item_id bigint, kind text, serial int, sale_price int, acquired_at timestamptz, reserved boolean)
language sql stable security definer set search_path = '' as $$
  select i.id, i.kind, i.serial, i.sale_price, i.acquired_at,
    exists (select 1 from public.limited_orders o where o.item_id = i.id and o.status = 'pending')
  from public.limited_items i join public.limited_kinds k on k.kind = i.kind
  where i.owner = auth.uid() order by k.sort desc, i.serial;
$$;

create or replace function public.limited_my_orders()
returns table (id bigint, kind text, resale boolean, price int, status text, note text, created_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select o.id, o.kind, o.resale, o.price, o.status, o.note, o.created_at
  from public.limited_orders o where o.buyer = auth.uid() order by o.created_at desc limit 50;
$$;

-- заявка на покупку: p_item пуст — из магазина, иначе — экземпляр «с рук»
create or replace function public.limited_order(p_kind text, p_item bigint, p_proof text)
returns bigint language plpgsql security definer set search_path = '' as $$
declare me uuid := auth.uid(); k public.limited_kinds; it public.limited_items; proof text := trim(coalesce(p_proof, '')); oid bigint;
begin
  if me is null then raise exception 'not signed in'; end if;
  if public.is_banned(me) then raise exception 'banned'; end if;
  if char_length(proof) > 300 or (p_item is null and char_length(proof) < 5) then raise exception 'bad proof'; end if;
  if (select count(*) from public.limited_orders o where o.buyer = me and o.status = 'pending') >= 3 then
    raise exception 'too many pending orders';
  end if;
  if p_item is null then
    select * into k from public.limited_kinds where kind = p_kind for update;
    if k.kind is null then raise exception 'no such limited'; end if;
    if exists (select 1 from public.limited_orders o where o.buyer = me and o.kind = k.kind and o.status = 'pending' and not o.resale) then
      raise exception 'order already pending';
    end if;
    if (select count(*) from public.limited_items i where i.kind = k.kind)
       + (select count(*) from public.limited_orders o where o.kind = k.kind and o.status = 'pending' and not o.resale) >= k.total then
      raise exception 'limited sold out';
    end if;
    insert into public.limited_orders (kind, buyer, price, proof) values (k.kind, me, k.price, proof) returning id into oid;
  else
    select * into it from public.limited_items where id = p_item for update;
    if it.id is null or it.sale_price is null then raise exception 'not for sale'; end if;
    if it.owner = me then raise exception 'own item'; end if;
    if exists (select 1 from public.limited_orders o where o.item_id = it.id and o.status = 'pending') then
      raise exception 'item reserved';
    end if;
    insert into public.limited_orders (kind, item_id, buyer, seller, resale, price, proof)
      values (it.kind, it.id, me, it.owner, true, it.sale_price, proof) returning id into oid;
  end if;
  return oid;
end;
$$;

create or replace function public.limited_cancel(p_id bigint)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.limited_orders set status = 'cancelled', decided_at = now()
    where id = p_id and buyer = auth.uid() and status = 'pending';
  if not found then raise exception 'order not found'; end if;
end;
$$;

-- выставить на продажу (p_price пусто — снять с продажи)
create or replace function public.limited_sell(p_item bigint, p_price int)
returns void language plpgsql security definer set search_path = '' as $$
declare it public.limited_items;
begin
  select * into it from public.limited_items where id = p_item and owner = auth.uid() for update;
  if it.id is null then raise exception 'item not found'; end if;
  if public.is_banned(auth.uid()) then raise exception 'banned'; end if;
  if exists (select 1 from public.limited_orders o where o.item_id = it.id and o.status = 'pending') then
    raise exception 'item reserved';
  end if;
  if p_price is not null and (p_price < 100 or p_price > 10000000) then raise exception 'bad price'; end if;
  update public.limited_items set sale_price = p_price where id = it.id;
end;
$$;

-- создателю: заявки на покупку из магазина
create or replace function public.limited_orders_admin(p_all boolean default false)
returns table (id bigint, kind text, buyer text, price int, proof text, status text, note text, created_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_creator(auth.uid()) then raise exception 'only creators'; end if;
  return query
  select o.id, o.kind, b.username, o.price, o.proof, o.status, o.note, o.created_at
  from public.limited_orders o left join public.profiles b on b.id = o.buyer
  where not o.resale and (p_all or o.status = 'pending')
  order by (o.status = 'pending') desc, o.created_at desc limit 200;
end;
$$;

-- продавцу: кто хочет купить мои экземпляры
create or replace function public.limited_requests()
returns table (id bigint, kind text, serial int, buyer uuid, price int, proof text, created_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select o.id, o.kind, i.serial, o.buyer, o.price, o.proof, o.created_at
  from public.limited_orders o join public.limited_items i on i.id = o.item_id
  where o.resale and o.status = 'pending' and o.seller = auth.uid() and i.owner = auth.uid()
  order by o.created_at;
$$;

-- решение по заявке: из магазина — создатель (проверил донат), с рук — продавец (получил деньги)
create or replace function public.limited_decide(p_id bigint, p_ok boolean, p_note text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare o public.limited_orders; k public.limited_kinds; it public.limited_items; n int; new_id bigint;
begin
  select * into o from public.limited_orders where id = p_id for update;
  if o.id is null or o.status <> 'pending' then raise exception 'order not found'; end if;
  if not (case when o.resale then o.seller = auth.uid() else public.is_creator(auth.uid()) end) then raise exception 'order not found'; end if;
  if public.is_banned(auth.uid()) then raise exception 'banned'; end if;
  if not p_ok then
    update public.limited_orders set status = 'rejected', note = left(p_note, 200), decided_at = now() where id = o.id;
    return;
  end if;
  if not o.resale then
    select * into k from public.limited_kinds where kind = o.kind for update;
    if (select count(*) from public.limited_items i where i.kind = o.kind) >= k.total then raise exception 'limited sold out'; end if;
    select coalesce(max(serial), 0) + 1 into n from public.limited_items where kind = o.kind;
    insert into public.limited_items (kind, serial, owner) values (o.kind, n, o.buyer) returning id into new_id;
    update public.limited_orders set status = 'approved', item_id = new_id, decided_at = now() where id = o.id;
  else
    select * into it from public.limited_items where id = o.item_id for update;
    if it.id is null or it.owner is distinct from o.seller or it.sale_price is null then raise exception 'listing changed'; end if;
    update public.limited_items set owner = o.buyer, sale_price = null, acquired_at = now() where id = it.id;
    update public.limited_orders set status = 'approved', decided_at = now() where id = o.id;
  end if;
end;
$$;

-- создатель меняет цену и тираж
create or replace function public.limited_set(p_kind text, p_price int, p_total int)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_creator(auth.uid()) then raise exception 'only creators'; end if;
  if p_total < (select count(*) from public.limited_items i where i.kind = p_kind) then raise exception 'total below sold'; end if;
  update public.limited_kinds set price = p_price, total = p_total where kind = p_kind;
  if not found then raise exception 'no such limited'; end if;
end;
$$;

revoke execute on function public.limited_catalog(), public.limited_market(), public.limited_mine(), public.limited_my_orders(),
  public.limited_order(text, bigint, text), public.limited_cancel(bigint), public.limited_sell(bigint, int),
  public.limited_orders_admin(boolean), public.limited_decide(bigint, boolean, text), public.limited_requests(),
  public.limited_set(text, int, int) from public, anon;
grant execute on function public.limited_catalog(), public.limited_market(), public.limited_mine(), public.limited_my_orders(),
  public.limited_order(text, bigint, text), public.limited_cancel(bigint), public.limited_sell(bigint, int),
  public.limited_orders_admin(boolean), public.limited_decide(bigint, boolean, text), public.limited_requests(),
  public.limited_set(text, int, int) to authenticated;

-- значки: лимитки видны у ника
create or replace function public.badges_list()
returns table (user_id uuid, kind text, granted boolean) language sql stable security definer set search_path = '' as $$
  select distinct t.owner, 'relay'::text, false from public.turn_providers t
    where t.status = 'active' and t.last_ok > now() - interval '2 days'
  union all
  select g.user_id, g.kind, true from public.badge_grants g
    where not (g.kind = 'relay' and exists (select 1 from public.turn_providers t
      where t.owner = g.user_id and t.status = 'active' and t.last_ok > now() - interval '2 days'))
  union all
  select m.user_id, m.level, true from public.moderators m
    where (m.until is null or m.until > now()) and not public.is_banned(m.user_id)
  union all
  select distinct i.owner, i.kind, false from public.limited_items i;
$$;

alter table public.profiles drop constraint if exists profiles_hidden_badges_check;
alter table public.profiles add constraint profiles_hidden_badges_check check (
  hidden_badges <@ array['creator', 'tester', 'bronze', 'silver', 'gold', 'plus', 'relay', 'donor', 'bro', 'moderator', 'senior', 'bee', 'l_spark', 'l_owl', 'l_coffee', 'l_pond', 'l_bug', 'l_vibe', 'l_neon', 'l_comet', 'l_storm', 'l_ice', 'l_flame', 'l_ghost', 'l_diamond', 'l_eclipse', 'l_legend', 'l_astro', 'l_phoenix', 'l_emperor', 'l_hole', 'l_absolute']::text[]
  and coalesce(array_length(hidden_badges, 1), 0) <= 40);

commit;
