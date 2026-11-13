-- update-23: лента «События» для создателя.
-- Заявки (лимитки, Премиум), сделки с рук, узлы, TURN, регистрации, баны модераторов
-- сами записываются в admin_events. Читает только создатель. Запись события никогда
-- не ломает само действие (ошибка внутри log_event глотается).

create table if not exists public.admin_events (
  id bigint generated always as identity primary key,
  kind text not null,
  text text not null,
  go text,
  created_at timestamptz not null default now()
);
create index if not exists admin_events_created_idx on public.admin_events (created_at desc);
alter table public.admin_events enable row level security;
revoke all on public.admin_events from anon, authenticated;
grant select on public.admin_events to authenticated;
drop policy if exists "creator reads events" on public.admin_events;
create policy "creator reads events" on public.admin_events for select to authenticated
  using (public.is_creator((select auth.uid())));

create or replace function public.log_event(p_kind text, p_text text, p_go text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.admin_events (kind, text, go)
  values (left(p_kind, 40), left(coalesce(p_text, ''), 300), left(p_go, 80));
exception when others then null;
end $$;
revoke all on function public.log_event(text, text, text) from public, anon, authenticated;

create or replace function public.ev_nick(uid uuid) returns text
language sql stable security definer set search_path = public as $$
  select coalesce((select '@' || username from public.profiles where id = uid), 'кто-то')
$$;
revoke all on function public.ev_nick(uuid) from public, anon, authenticated;

create or replace function public.ev_money(n int) returns text
language sql immutable as $$ select replace(trim(to_char(n, 'FM999G999G999')), ',', ' ') || ' ₽' $$;

-- заявки на лимитки и сделки с рук
create or replace function public.ev_limited_orders() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' and not new.resale then
    perform public.log_event('order_limited',
      'Заявка на лимитку ' || new.kind || ' от ' || public.ev_nick(new.buyer) || ' — ' || public.ev_money(new.price), 'orders');
  elsif tg_op = 'UPDATE' and new.resale and new.status = 'approved' and old.status is distinct from 'approved' then
    perform public.log_event('resale',
      'Сделка с рук: ' || new.kind || ', ' || public.ev_nick(new.seller) || ' → ' || public.ev_nick(new.buyer) || ' за ' || public.ev_money(new.price), null);
  end if;
  return null;
exception when others then return null;
end $$;
drop trigger if exists ev_limited_orders on public.limited_orders;
create trigger ev_limited_orders after insert or update on public.limited_orders
  for each row execute function public.ev_limited_orders();

-- заявки на Премиум
create or replace function public.ev_premium_orders() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform public.log_event('order_premium',
    'Заявка на Премиум (' || (case when new.months = 12 then 'год' else 'месяц' end) || ') от ' || public.ev_nick(new.buyer) || ' — ' || public.ev_money(new.price), 'orders');
  return null;
exception when others then return null;
end $$;
drop trigger if exists ev_premium_orders on public.premium_orders;
create trigger ev_premium_orders after insert on public.premium_orders
  for each row execute function public.ev_premium_orders();

-- узлы
create or replace function public.ev_nodes() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    perform public.log_event('node_new', 'Новая заявка узла от ' || public.ev_nick(new.owner), 'nodes');
  elsif new.status is distinct from old.status then
    if new.status = 'disabled' then
      perform public.log_event('node_down', 'Узел ' || public.ev_nick(new.owner) || ' отключён', 'nodes');
    elsif new.status = 'active' then
      perform public.log_event('node_up', 'Узел ' || public.ev_nick(new.owner) || ' работает', 'nodes');
    end if;
  end if;
  return null;
exception when others then return null;
end $$;
drop trigger if exists ev_nodes on public.nodes;
create trigger ev_nodes after insert or update on public.nodes
  for each row execute function public.ev_nodes();

-- TURN партнёров
create or replace function public.ev_turn() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform public.log_event('turn_new', 'Новый TURN от ' || public.ev_nick(new.owner), 'nodes');
  return null;
exception when others then return null;
end $$;
drop trigger if exists ev_turn on public.turn_providers;
create trigger ev_turn after insert on public.turn_providers
  for each row execute function public.ev_turn();

-- регистрации
create or replace function public.ev_profiles() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform public.log_event('user_new', 'Новый человек: @' || new.username, 'user:' || new.username);
  return null;
exception when others then return null;
end $$;
drop trigger if exists ev_profiles on public.profiles;
create trigger ev_profiles after insert on public.profiles
  for each row execute function public.ev_profiles();

-- баны и разбаны модераторов (свои создатель и так знает)
create or replace function public.ev_bans() returns trigger
language plpgsql security definer set search_path = public as $$
declare who uuid; target text;
begin
  if tg_op = 'DELETE' then
    who := auth.uid();
    if who is null or public.is_creator(who) then return null; end if;
    select username into target from public.profiles where id = old.user_id;
    if target is null then return null; end if;
    perform public.log_event('unban', public.ev_nick(who) || ' разбанил @' || target, 'user:' || target);
  else
    who := new.by_user;
    if who is null or public.is_creator(who) then return null; end if;
    if tg_op = 'UPDATE' and new.until is not distinct from old.until and new.reason is not distinct from old.reason then return null; end if;
    select username into target from public.profiles where id = new.user_id;
    perform public.log_event('ban', public.ev_nick(who) || ' забанил @' || target
      || (case when new.until is null then ' навсегда' else ' до ' || to_char(new.until at time zone 'Europe/Moscow', 'DD.MM HH24:MI') end)
      || (case when coalesce(new.reason, '') <> '' then ': ' || new.reason else '' end), 'user:' || target);
  end if;
  return null;
exception when others then return null;
end $$;
drop trigger if exists ev_bans on public.bans;
create trigger ev_bans after insert or update or delete on public.bans
  for each row execute function public.ev_bans();

-- Realtime
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'admin_events') then
    alter publication supabase_realtime add table public.admin_events;
  end if;
end $$;

-- чистка: старше 60 дней
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('events-cleanup', '41 3 * * *',
      $q$delete from public.admin_events where created_at < now() - interval '60 days'$q$);
  end if;
end $$;
