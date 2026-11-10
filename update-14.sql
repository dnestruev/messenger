-- Обновление 14: уровни партнёров, TURN от партнёров, донаты.
--   Бронза — держит узел сети (как раньше «Партнёр»).
--   Серебро — узел + свой TURN-сервер для звонков (через него идут звонки, если основной кончился).
--   Золото — серебро 30 дней подряд.
--   Донаты — ссылка «Поддержать проект» (ставит создатель), значок «Донатер» выдаёт создатель вручную.
-- Запускать ОДИН раз в Supabase (центр) → SQL Editor, после update-13.sql.

begin;

-- ---------- TURN-серверы партнёров ----------
create table if not exists public.turn_providers (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null references public.profiles(id) on delete cascade,
  urls text[] not null check (array_length(urls, 1) between 1 and 4),
  username text not null check (char_length(username) between 1 and 256),
  credential text not null check (char_length(credential) between 1 and 256),
  status text not null default 'pending' check (status in ('pending', 'active', 'failing', 'disabled')),
  last_ok timestamptz,
  last_check timestamptz,
  last_error text check (char_length(last_error) <= 200),
  created_at timestamptz not null default now()
);
create index if not exists turn_providers_owner on public.turn_providers (owner);
alter table public.turn_providers enable row level security;
-- Пароль TURN не видит никто из пользователей (даже владелец): его отдаёт только функция turn-credentials
revoke all on public.turn_providers from anon, authenticated;
grant select (id, owner, urls, status, last_ok, last_check, last_error, created_at) on public.turn_providers to authenticated;
drop policy if exists "turn_providers: own or creator" on public.turn_providers;
create policy "turn_providers: own or creator" on public.turn_providers for select to authenticated
  using (owner = (select auth.uid()) or public.is_creator((select auth.uid())));

create or replace function public.register_turn(p_urls text[], p_username text, p_credential text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare nid uuid; u text;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if p_urls is null or array_length(p_urls, 1) is null or array_length(p_urls, 1) > 4 then raise exception 'bad turn urls'; end if;
  foreach u in array p_urls loop
    if u !~ '^turns?:[A-Za-z0-9.-]{3,253}(:[0-9]{2,5})?(\?transport=(udp|tcp))?$' then raise exception 'bad turn urls'; end if;
  end loop;
  if coalesce(trim(p_username), '') = '' or coalesce(p_credential, '') = '' then raise exception 'empty turn login'; end if;
  if (select count(*) from public.turn_providers where owner = auth.uid()) >= 2 then raise exception 'too many turn servers'; end if;
  insert into public.turn_providers (owner, urls, username, credential)
    values (auth.uid(), p_urls, trim(p_username), p_credential) returning id into nid;
  return nid;
end;
$$;
create or replace function public.delete_turn(p_id uuid)
returns void language sql security definer set search_path = '' as $$
  delete from public.turn_providers where id = p_id and (owner = auth.uid() or public.is_creator(auth.uid()));
$$;
create or replace function public.set_turn_status(p_id uuid, p_status text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_creator(auth.uid()) then raise exception 'only creators manage turn servers'; end if;
  if p_status not in ('pending', 'disabled') then raise exception 'bad status'; end if;
  update public.turn_providers set status = p_status where id = p_id;
end;
$$;
revoke execute on function public.register_turn(text[], text, text), public.delete_turn(uuid), public.set_turn_status(uuid, text) from public, anon;
grant execute on function public.register_turn(text[], text, text), public.delete_turn(uuid), public.set_turn_status(uuid, text) to authenticated;

-- ---------- Уровни партнёров ----------
alter table public.partner_state add column if not exists turn_active boolean not null default false;
alter table public.partner_state add column if not exists silver_since timestamptz;
alter table public.partner_state add column if not exists tier text check (tier in ('bronze', 'silver', 'gold'));

create or replace function public.refresh_partners()
returns void language plpgsql security definer set search_path = '' as $$
begin
  insert into public.partner_state (user_id, active, since, msgs, updated_at)
  select n.owner,
         coalesce(bool_or(n.status = 'active' and h.last_ok > now() - interval '30 minutes'), false),
         null,
         coalesce(sum((select count(*) from public.messages m where m.nodes @> array[n.id]))::int, 0),
         now()
  from public.nodes n left join public.node_health h on h.node_id = n.id
  where n.owner is not null
  group by n.owner
  on conflict (user_id) do update set
    since = case when excluded.active then coalesce(public.partner_state.since, now()) end,
    active = excluded.active,
    msgs = excluded.msgs,
    updated_at = now();

  update public.partner_state set since = now() where active and since is null;
  update public.partner_state set active = false, since = null
    where active and user_id not in (select owner from public.nodes where owner is not null);

  -- серебро: узел + рабочий TURN (проверен за последние 2 суток); золото: серебро 30 дней подряд
  update public.partner_state s set turn_active = exists (
    select 1 from public.turn_providers t
    where t.owner = s.user_id and t.status = 'active' and t.last_ok > now() - interval '2 days');
  update public.partner_state set silver_since = case when active and turn_active then coalesce(silver_since, now()) end;
  update public.partner_state set tier = case
    when not active then null
    when turn_active and silver_since <= now() - interval '30 days' then 'gold'
    when turn_active then 'silver'
    else 'bronze' end;

  -- за TURN — дополнительные очки рейтинга
  update public.partner_state set score = msgs + coalesce(extract(day from now() - since)::int, 0) * 50
    + case when turn_active then 500 else 0 end;
end;
$$;
revoke execute on function public.refresh_partners() from public, anon, authenticated;

drop function if exists public.perks_list();
create function public.perks_list()
returns table (user_id uuid, kind text, tier text) language sql stable security definer set search_path = '' as $$
  select s.user_id, 'partner'::text, coalesce(s.tier, 'bronze') from public.partner_state s where s.active
  union
  select g.friend_id, 'plus'::text, null::text from public.partner_gifts g
    join public.partner_state s on s.user_id = g.partner_id and s.active
  where not exists (select 1 from public.partner_state s2 where s2.user_id = g.friend_id and s2.active);
$$;
revoke execute on function public.perks_list() from public, anon;
grant execute on function public.perks_list() to authenticated;

-- ---------- Донаты ----------
create table if not exists public.app_settings (
  key text primary key check (key in ('donate_url', 'donate_text')),
  value text not null check (char_length(value) <= 500),
  updated_at timestamptz not null default now()
);
alter table public.app_settings enable row level security;
revoke all on public.app_settings from anon, authenticated;
grant select on public.app_settings to authenticated;
drop policy if exists "app_settings: read" on public.app_settings;
create policy "app_settings: read" on public.app_settings for select to authenticated using (true);

create or replace function public.set_app_setting(p_key text, p_value text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_creator(auth.uid()) then raise exception 'only creators change settings'; end if;
  if p_key = 'donate_url' and coalesce(p_value, '') <> '' and (p_value !~ '^https://[^[:space:]]+$' or char_length(p_value) < 12) then raise exception 'bad donate url'; end if;
  if coalesce(trim(p_value), '') = '' then
    delete from public.app_settings where key = p_key;
  else
    insert into public.app_settings (key, value) values (p_key, trim(p_value))
      on conflict (key) do update set value = excluded.value, updated_at = now();
  end if;
end;
$$;

create table if not exists public.donors (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  since timestamptz not null default now()
);
alter table public.donors enable row level security;
revoke all on public.donors from anon, authenticated;
grant select on public.donors to authenticated;
drop policy if exists "donors: read" on public.donors;
create policy "donors: read" on public.donors for select to authenticated using (true);

create or replace function public.set_donor(p_username text, p_on boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare uid uuid;
begin
  if not public.is_creator(auth.uid()) then raise exception 'only creators can mark donors'; end if;
  select id into uid from public.profiles where username = lower(trim(both '@ ' from p_username));
  if uid is null then raise exception 'user not found'; end if;
  if p_on then insert into public.donors (user_id) values (uid) on conflict do nothing;
  else delete from public.donors where user_id = uid; end if;
end;
$$;
revoke execute on function public.set_app_setting(text, text), public.set_donor(text, boolean) from public, anon;
grant execute on function public.set_app_setting(text, text), public.set_donor(text, boolean) to authenticated;

-- ---------- Проверка TURN-серверов партнёров раз в 6 часов (функция turn-check) ----------
do $$ begin
  if exists (select 1 from pg_namespace where nspname = 'cron') then
    perform cron.schedule('turn-check', '23 */6 * * *', $q$
      select net.http_post(
        url := 'https://jlyuqsqlvhytvsijpejr.supabase.co/functions/v1/turn-check',
        body := '{}'::jsonb,
        headers := '{"Content-Type": "application/json"}'::jsonb)
    $q$);
  end if;
end $$;

commit;
