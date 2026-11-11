-- update-21: платная подписка «Премиум» (месяц 2000 ₽, год 24000 ₽).
--   premium — у кого и до какого числа (+ цвет ника); premium_orders — заявки (оплата донатом, выдаёт создатель).
--   Премиум даёт всё из Плюса (has_plus), свои рамки fire/prism, цветной ник, скидку 10% на лимитки из магазина.
--   Цены — в premium_price(). Безопасно применять повторно.
begin;

create table if not exists public.premium (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  until timestamptz not null,
  nick_color text check (nick_color in ('gold', 'fire', 'ocean', 'mint', 'violet', 'rose', 'rainbow')),
  since timestamptz not null default now()
);
create table if not exists public.premium_orders (
  id bigint generated always as identity primary key,
  buyer uuid not null references public.profiles(id) on delete cascade,
  months int not null check (months in (1, 12)),
  price int not null,
  proof text not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  note text,
  created_at timestamptz not null default now(),
  decided_at timestamptz
);
create index if not exists premium_orders_status_idx on public.premium_orders (status, created_at desc);
alter table public.premium enable row level security;
alter table public.premium_orders enable row level security;
revoke all on public.premium, public.premium_orders from anon, authenticated;

create or replace function public.is_premium(uid uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.premium p where p.user_id = uid and p.until > now());
$$;
revoke execute on function public.is_premium(uuid) from public, anon, authenticated;

create or replace function public.premium_price(p_months int)
returns int language sql immutable set search_path = '' as $$
  select case p_months when 12 then 24000 else 2000 end;
$$;
revoke execute on function public.premium_price(int) from public, anon;
grant execute on function public.premium_price(int) to authenticated;

-- Плюс: партнёр, подарок партнёра или Премиум
create or replace function public.has_plus(uid uuid)
returns boolean language sql security definer set search_path = '' stable as $$
  select exists (select 1 from public.partner_state where user_id = uid and active)
      or exists (select 1 from public.partner_gifts g join public.partner_state s on s.user_id = g.partner_id and s.active
                 where g.friend_id = uid)
      or public.is_premium(uid);
$$;

-- у кого сейчас Премиум и какой цвет ника (видят все — для значка и ника)
create or replace function public.premium_list()
returns table (user_id uuid, nick_color text) language sql stable security definer set search_path = '' as $$
  select p.user_id, p.nick_color from public.premium p where auth.uid() is not null and p.until > now();
$$;
create or replace function public.premium_me()
returns table (until timestamptz, nick_color text, price_month int, price_year int)
language sql stable security definer set search_path = '' as $$
  select (select p.until from public.premium p where p.user_id = auth.uid()),
         (select p.nick_color from public.premium p where p.user_id = auth.uid()),
         public.premium_price(1), public.premium_price(12)
  where auth.uid() is not null;
$$;

create or replace function public.premium_order(p_months int, p_proof text)
returns bigint language plpgsql security definer set search_path = '' as $$
declare me uuid := auth.uid(); proof text := trim(coalesce(p_proof, '')); oid bigint;
begin
  if me is null then raise exception 'not signed in'; end if;
  if public.is_banned(me) then raise exception 'banned'; end if;
  if p_months not in (1, 12) then raise exception 'bad premium term'; end if;
  if char_length(proof) < 5 or char_length(proof) > 300 then raise exception 'bad proof'; end if;
  if exists (select 1 from public.premium_orders o where o.buyer = me and o.status = 'pending') then
    raise exception 'order already pending';
  end if;
  insert into public.premium_orders (buyer, months, price, proof) values (me, p_months, public.premium_price(p_months), proof) returning id into oid;
  return oid;
end;
$$;
create or replace function public.premium_cancel(p_id bigint)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.premium_orders set status = 'cancelled', decided_at = now() where id = p_id and buyer = auth.uid() and status = 'pending';
  if not found then raise exception 'order not found'; end if;
end;
$$;
create or replace function public.premium_my_orders()
returns table (id bigint, months int, price int, status text, note text, created_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select o.id, o.months, o.price, o.status, o.note, o.created_at from public.premium_orders o
  where o.buyer = auth.uid() order by o.created_at desc limit 30;
$$;
create or replace function public.premium_orders_admin()
returns table (id bigint, buyer text, months int, price int, proof text, created_at timestamptz, has_until timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_creator(auth.uid()) then raise exception 'only creators'; end if;
  return query
  select o.id, b.username, o.months, o.price, o.proof, o.created_at, (select p.until from public.premium p where p.user_id = o.buyer)
  from public.premium_orders o left join public.profiles b on b.id = o.buyer
  where o.status = 'pending' order by o.created_at;
end;
$$;

-- продлить/включить: срок прибавляется к оставшемуся
create or replace function public.premium_extend(uid uuid, p_span interval)
returns void language sql security definer set search_path = '' as $$
  insert into public.premium (user_id, until) values (uid, now() + p_span)
  on conflict (user_id) do update set until = greatest(public.premium.until, now()) + p_span;
$$;
revoke execute on function public.premium_extend(uuid, interval) from public, anon, authenticated;

create or replace function public.premium_decide(p_id bigint, p_ok boolean, p_note text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare o public.premium_orders;
begin
  if not public.is_creator(auth.uid()) then raise exception 'only creators'; end if;
  select * into o from public.premium_orders where id = p_id for update;
  if o.id is null or o.status <> 'pending' then raise exception 'order not found'; end if;
  if p_ok then
    perform public.premium_extend(o.buyer, make_interval(months => o.months));
    update public.premium_orders set status = 'approved', decided_at = now() where id = o.id;
  else
    update public.premium_orders set status = 'rejected', note = left(p_note, 200), decided_at = now() where id = o.id;
  end if;
end;
$$;

-- создатель: подарить на N дней (0 или пусто — снять)
create or replace function public.premium_grant(p_username text, p_days int)
returns void language plpgsql security definer set search_path = '' as $$
declare uid uuid;
begin
  if not public.is_creator(auth.uid()) then raise exception 'only creators'; end if;
  select id into uid from public.profiles where username = lower(trim(both '@ ' from p_username));
  if uid is null then raise exception 'user not found'; end if;
  if p_days is null or p_days <= 0 then delete from public.premium where user_id = uid;
  else perform public.premium_extend(uid, make_interval(days => least(p_days, 3650)));
  end if;
end;
$$;

create or replace function public.set_nick_color(p_color text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_premium(auth.uid()) then raise exception 'premium only'; end if;
  update public.premium set nick_color = p_color where user_id = auth.uid();
end;
$$;

revoke execute on function public.premium_list(), public.premium_me(), public.premium_order(int, text), public.premium_cancel(bigint),
  public.premium_my_orders(), public.premium_orders_admin(), public.premium_decide(bigint, boolean, text),
  public.premium_grant(text, int), public.set_nick_color(text) from public, anon;
grant execute on function public.premium_list(), public.premium_me(), public.premium_order(int, text), public.premium_cancel(bigint),
  public.premium_my_orders(), public.premium_orders_admin(), public.premium_decide(bigint, boolean, text),
  public.premium_grant(text, int), public.set_nick_color(text) to authenticated;

-- рамки: fire и prism — только с Премиумом
alter table public.profiles drop constraint if exists profiles_frame_check;
alter table public.profiles add constraint profiles_frame_check check (frame in ('gold', 'aurora', 'neon', 'dots', 'fire', 'prism'));
create or replace function public.protect_frame()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.frame is distinct from old.frame and new.frame is not null and current_user in ('authenticated', 'anon') then
    if new.frame in ('fire', 'prism') and not public.is_premium_pub(new.id) then raise exception 'frame needs premium'; end if;
    if not public.has_plus(new.id) then raise exception 'frame needs plus'; end if;
  end if;
  return new;
end;
$$;
-- protect_frame идёт без security definer — ему нужна вызываемая проверка
create or replace function public.is_premium_pub(uid uuid)
returns boolean language sql stable security definer set search_path = '' as $$ select public.is_premium(uid); $$;
revoke execute on function public.is_premium_pub(uuid) from public, anon;
grant execute on function public.is_premium_pub(uuid) to authenticated;

-- скидка 10% на лимитки из магазина для Премиума
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
    insert into public.limited_orders (kind, buyer, price, proof)
      values (k.kind, me, case when public.is_premium(me) then round(k.price * 0.9)::int else k.price end, proof) returning id into oid;
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
  select distinct i.owner, i.kind, false from public.limited_items i
  union all
  select p.user_id, 'premium'::text, false from public.premium p where p.until > now();
$$;

alter table public.profiles drop constraint if exists profiles_hidden_badges_check;
alter table public.profiles add constraint profiles_hidden_badges_check check (
  hidden_badges <@ array['creator', 'tester', 'bronze', 'silver', 'gold', 'plus', 'relay', 'donor', 'bro', 'moderator', 'senior', 'bee', 'premium', 'l_spark', 'l_owl', 'l_coffee', 'l_pond', 'l_bug', 'l_vibe', 'l_neon', 'l_comet', 'l_storm', 'l_ice', 'l_flame', 'l_ghost', 'l_diamond', 'l_eclipse', 'l_legend', 'l_astro', 'l_phoenix', 'l_emperor', 'l_hole', 'l_absolute', 'l_cinema']::text[]
  and coalesce(array_length(hidden_badges, 1), 0) <= 40);

commit;
