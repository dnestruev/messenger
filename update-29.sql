-- update-29: подарки (как в Telegram) + закрытие мелких дыр из советника Supabase
-- Подарок: человек выбирает подарок и получателя, платит донатом, создатель подтверждает —
-- подарок с номером появляется в профиле получателя. Создатель дарит без оплаты.
begin;

create table if not exists public.gift_kinds (
  kind text primary key check (kind ~ '^[a-z0-9_]{2,24}$'),
  name text not null check (char_length(name) between 1 and 40),
  price int not null check (price between 1 and 10000000),
  total int check (total is null or total between 1 and 1000000),   -- null — без ограничения тиража
  sort int not null default 0,
  active boolean not null default true
);
alter table public.gift_kinds enable row level security;

create table if not exists public.gifts (
  id bigserial primary key,
  kind text not null references public.gift_kinds(kind) on update cascade,
  serial int,                                        -- номер экземпляра, ставится при выдаче
  sender uuid references public.profiles(id) on delete set null,
  recipient uuid not null references public.profiles(id) on delete cascade,
  message text check (message is null or char_length(message) <= 200),
  anonymous boolean not null default false,
  hidden boolean not null default false,             -- получатель убрал с витрины профиля
  status text not null default 'pending' check (status in ('pending', 'sent', 'rejected', 'cancelled')),
  price int not null default 0,
  proof text check (proof is null or char_length(proof) <= 300),
  note text check (note is null or char_length(note) <= 200),
  created_at timestamptz not null default now(),
  decided_at timestamptz
);
alter table public.gifts enable row level security;
create unique index if not exists gifts_kind_serial on public.gifts (kind, serial) where serial is not null;
create index if not exists gifts_recipient on public.gifts (recipient) where status = 'sent';
create index if not exists gifts_sender on public.gifts (sender, status);

insert into public.gift_kinds (kind, name, price, total, sort) values
  ('whisky', 'Виски «Дельта»', 300, 777, 10)
on conflict (kind) do nothing;

-- каталог: цена, сколько осталось
create or replace function public.gifts_catalog()
returns table (kind text, name text, price int, total int, sold int, active boolean)
language sql stable security definer set search_path = '' as $$
  select k.kind, k.name, k.price, k.total,
    (select count(*)::int from public.gifts g where g.kind = k.kind and g.status in ('sent', 'pending')),
    k.active
  from public.gift_kinds k
  where k.active or public.is_creator(auth.uid())
  order by k.sort, k.price;
$$;

-- подарить: обычный человек — заявка с подтверждением доната, создатель — сразу
create or replace function public.gift_send(p_kind text, p_to text, p_message text, p_anon boolean, p_proof text)
returns bigint language plpgsql security definer set search_path = '' as $$
declare me uuid := auth.uid(); k public.gift_kinds; rid uuid; proof text := trim(coalesce(p_proof, ''));
  msg text := nullif(trim(coalesce(p_message, '')), ''); creator boolean; gid bigint; n int;
begin
  if me is null then raise exception 'not signed in'; end if;
  if public.is_banned(me) then raise exception 'banned'; end if;
  creator := public.is_creator(me);
  select * into k from public.gift_kinds where kind = p_kind for update;
  if k.kind is null or not k.active then raise exception 'no such gift'; end if;
  select id into rid from public.profiles where username = lower(trim(both '@' from trim(coalesce(p_to, ''))));
  if rid is null then raise exception 'user not found'; end if;
  if char_length(coalesce(msg, '')) > 200 then raise exception 'gift message too long'; end if;
  if not creator and (char_length(proof) < 5 or char_length(proof) > 300) then raise exception 'bad proof'; end if;
  if not creator and (select count(*) from public.gifts g where g.sender = me and g.status = 'pending') >= 3 then
    raise exception 'too many pending orders';
  end if;
  if k.total is not null and (select count(*) from public.gifts g where g.kind = k.kind and g.status in ('sent', 'pending')) >= k.total then
    raise exception 'gift sold out';
  end if;
  if creator then
    select coalesce(max(serial), 0) + 1 into n from public.gifts where kind = k.kind;
    insert into public.gifts (kind, serial, sender, recipient, message, anonymous, status, price, decided_at)
      values (k.kind, n, me, rid, msg, coalesce(p_anon, false), 'sent', 0, now()) returning id into gid;
  else
    insert into public.gifts (kind, sender, recipient, message, anonymous, price, proof)
      values (k.kind, me, rid, msg, coalesce(p_anon, false), k.price, proof) returning id into gid;
    perform public.log_event('gift_order', public.ev_nick(me) || ' хочет подарить «' || k.name || '» ' || public.ev_nick(rid) || ' · ' || public.ev_money(k.price), 'orders');
  end if;
  return gid;
end;
$$;

-- подарки человека: скрытые видит только он сам; от кого — не видно, если анонимно (кроме получателя и создателя);
-- текст открытки — только получателю и дарителю
create or replace function public.gifts_of(p_user uuid)
returns table (id bigint, kind text, serial int, sender uuid, message text, anonymous boolean, hidden boolean, created_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select g.id, g.kind, g.serial,
    case when not g.anonymous or auth.uid() in (g.recipient, g.sender) or public.is_creator(auth.uid()) then g.sender end,
    case when auth.uid() in (g.recipient, g.sender) then g.message end,
    g.anonymous, g.hidden, coalesce(g.decided_at, g.created_at)
  from public.gifts g
  where g.recipient = p_user and g.status = 'sent' and (not g.hidden or g.recipient = auth.uid())
  order by coalesce(g.decided_at, g.created_at) desc limit 200;
$$;

create or replace function public.gift_hide(p_id bigint, p_hidden boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.gifts set hidden = coalesce(p_hidden, false) where id = p_id and recipient = auth.uid() and status = 'sent';
  if not found then raise exception 'gift not found'; end if;
end;
$$;

-- мои заявки на подарки (что я дарю)
create or replace function public.gifts_my_orders()
returns table (id bigint, kind text, recipient text, price int, status text, note text, created_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select g.id, g.kind, p.username, g.price, g.status, g.note, g.created_at
  from public.gifts g left join public.profiles p on p.id = g.recipient
  where g.sender = auth.uid() and g.price > 0
  order by g.created_at desc limit 50;
$$;

create or replace function public.gift_cancel(p_id bigint)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.gifts set status = 'cancelled', decided_at = now() where id = p_id and sender = auth.uid() and status = 'pending';
  if not found then raise exception 'order not pending'; end if;
end;
$$;

-- создателю: заявки
create or replace function public.gifts_orders_admin()
returns table (id bigint, kind text, sender text, recipient text, price int, proof text, message text, anonymous boolean, created_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_creator(auth.uid()) then raise exception 'only creators'; end if;
  return query
  select g.id, g.kind, s.username, r.username, g.price, g.proof, g.message, g.anonymous, g.created_at
  from public.gifts g left join public.profiles s on s.id = g.sender left join public.profiles r on r.id = g.recipient
  where g.status = 'pending' order by g.created_at limit 200;
end;
$$;

create or replace function public.gift_decide(p_id bigint, p_ok boolean, p_note text)
returns void language plpgsql security definer set search_path = '' as $$
declare g public.gifts; n int;
begin
  if not public.is_creator(auth.uid()) then raise exception 'only creators'; end if;
  select * into g from public.gifts where id = p_id and status = 'pending' for update;
  if g.id is null then raise exception 'order not pending'; end if;
  if p_ok then
    perform 1 from public.gift_kinds where kind = g.kind for update;
    select coalesce(max(serial), 0) + 1 into n from public.gifts where kind = g.kind;
    update public.gifts set status = 'sent', serial = n, decided_at = now(), note = left(p_note, 200) where id = g.id;
  else
    update public.gifts set status = 'rejected', decided_at = now(), note = left(p_note, 200) where id = g.id;
  end if;
end;
$$;

-- создателю: цена, тираж, вкл/выкл
create or replace function public.gift_set(p_kind text, p_price int, p_total int, p_active boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare sold int;
begin
  if not public.is_creator(auth.uid()) then raise exception 'only creators'; end if;
  select count(*) into sold from public.gifts where kind = p_kind and status in ('sent', 'pending');
  if p_total is not null and p_total < sold then raise exception 'total below sold'; end if;
  if p_price is null or p_price < 1 or p_price > 10000000 then raise exception 'bad price'; end if;
  update public.gift_kinds set price = p_price, total = p_total, active = coalesce(p_active, active) where kind = p_kind;
  if not found then raise exception 'no such gift'; end if;
end;
$$;

revoke all on function public.gifts_catalog(), public.gift_send(text, text, text, boolean, text), public.gifts_of(uuid),
  public.gift_hide(bigint, boolean), public.gifts_my_orders(), public.gift_cancel(bigint), public.gifts_orders_admin(),
  public.gift_decide(bigint, boolean, text), public.gift_set(text, int, int, boolean) from public, anon;
grant execute on function public.gifts_catalog(), public.gift_send(text, text, text, boolean, text), public.gifts_of(uuid),
  public.gift_hide(bigint, boolean), public.gifts_my_orders(), public.gift_cancel(bigint), public.gifts_orders_admin(),
  public.gift_decide(bigint, boolean, text), public.gift_set(text, int, int, boolean) to authenticated;

-- ---------- безопасность (советник Supabase) ----------
-- служебные функции-триггеры и помощники не должны вызываться через API
do $$
declare f text;
begin
  foreach f in array array['public.ev_bans()', 'public.ev_limited_orders()', 'public.ev_nodes()', 'public.ev_premium_orders()',
    'public.ev_profiles()', 'public.ev_turn()', 'public.fortune_guard_order()', 'public.fortune_active()', 'public.fortune_free_left(uuid)'] loop
    if to_regprocedure(f) is not null then execute format('revoke all on function %s from public, anon, authenticated', f); end if;
  end loop;
end $$;
alter function public.ev_money(int) set search_path = '';
revoke all on function public.ev_money(int) from public, anon, authenticated;

commit;
