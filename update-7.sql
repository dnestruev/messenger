-- Обновление 7: награды партнёрам.
--   * центр сам проверяет узлы каждые 10 минут (pg_cron + pg_net), никто не может «назваться» партнёром
--   * статус «Партнёр» и «Плюс» (подарок партнёра друзьям, до 5 человек)
--   * лимиты групп: обычные 20 групп × 100 человек, с Плюсом 100 групп × 500 человек
--   * рамки аватарок только с Плюсом
--   * рейтинг партнёров
-- Запускать ОДИН раз в Supabase (центр) → SQL Editor, после update-5.sql.

create extension if not exists pg_cron;
create extension if not exists pg_net;

begin;

-- ---------- Проверка узлов ----------
create table if not exists public.node_health (
  node_id uuid primary key references public.nodes(id) on delete cascade,
  last_ok timestamptz,
  last_check timestamptz,
  fails int not null default 0,
  request_id bigint
);
alter table public.node_health enable row level security;     -- только для функций центра

-- ---------- Статус партнёров ----------
create table if not exists public.partner_state (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  active boolean not null default false,
  since timestamptz,                    -- с какого момента узел непрерывно в сети
  msgs int not null default 0,          -- сколько сообщений хранит узел
  score int not null default 0,
  updated_at timestamptz not null default now()
);
alter table public.partner_state enable row level security;
drop policy if exists "partner_state: read" on public.partner_state;
create policy "partner_state: read" on public.partner_state for select to authenticated using (true);

create table if not exists public.partner_gifts (
  partner_id uuid not null references public.profiles(id) on delete cascade,
  friend_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (partner_id, friend_id),
  check (partner_id <> friend_id)
);
alter table public.partner_gifts enable row level security;
drop policy if exists "partner_gifts: read own" on public.partner_gifts;
create policy "partner_gifts: read own" on public.partner_gifts for select to authenticated
  using (partner_id = auth.uid() or friend_id = auth.uid());

create index if not exists messages_nodes_gin on public.messages using gin (nodes);

-- Есть ли у человека «Плюс»: он сам активный партнёр или подарок от активного партнёра
create or replace function public.has_plus(uid uuid)
returns boolean language sql security definer set search_path = '' stable as $$
  select exists (select 1 from public.partner_state where user_id = uid and active)
      or exists (select 1 from public.partner_gifts g join public.partner_state s on s.user_id = g.partner_id and s.active
                 where g.friend_id = uid);
$$;

-- Кто сейчас с наградами (для значков)
create or replace function public.perks_list()
returns table (user_id uuid, kind text)
language sql security definer set search_path = '' stable as $$
  select s.user_id, 'partner' from public.partner_state s where s.active
  union
  select g.friend_id, 'plus' from public.partner_gifts g join public.partner_state s on s.user_id = g.partner_id and s.active
  where not exists (select 1 from public.partner_state s2 where s2.user_id = g.friend_id and s2.active);
$$;

-- Рейтинг: активные партнёры, лучшие сверху
create or replace function public.partner_top()
returns table (user_id uuid, username text, display_name text, msgs int, days int, score int)
language sql security definer set search_path = '' stable as $$
  select s.user_id, p.username, p.display_name, s.msgs,
         coalesce(extract(day from now() - s.since)::int, 0), s.score
  from public.partner_state s join public.profiles p on p.id = s.user_id
  where s.active
  order by s.score desc, s.since asc
  limit 20;
$$;

-- Подарить «Плюс» другу (до 5 друзей)
create or replace function public.gift_plus(p_username text)
returns void language plpgsql security definer set search_path = '' as $$
declare friend uuid;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if not exists (select 1 from public.partner_state where user_id = auth.uid() and active) then
    raise exception 'only partners can gift';
  end if;
  select id into friend from public.profiles where username = lower(trim(both '@ ' from p_username));
  if friend is null then raise exception 'user not found'; end if;
  if friend = auth.uid() then raise exception 'cannot gift yourself'; end if;
  if (select count(*) from public.partner_gifts where partner_id = auth.uid()) >= 5 then
    raise exception 'gift limit reached';
  end if;
  insert into public.partner_gifts (partner_id, friend_id) values (auth.uid(), friend) on conflict do nothing;
end;
$$;

create or replace function public.ungift_plus(p_friend uuid)
returns void language sql security definer set search_path = '' as $$
  delete from public.partner_gifts where partner_id = auth.uid() and friend_id = p_friend;
$$;

-- Пересчёт статусов
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
  -- очки: каждое сообщение — 1, каждый день непрерывной работы — 50
  update public.partner_state set score = msgs + coalesce(extract(day from now() - since)::int, 0) * 50;
end;
$$;

-- Пинг узлов: ответ на прошлый пинг разбираем, новый отправляем
create or replace function public.check_nodes()
returns void language plpgsql security definer set search_path = '' as $$
declare r record; code int; body text; got boolean;
begin
  insert into public.node_health (node_id) select id from public.nodes on conflict do nothing;

  for r in select * from public.node_health where request_id is not null loop
    select true, x.status_code, x.content into got, code, body from net._http_response x where x.id = r.request_id;
    if got then
      if code = 200 and body like '%"ok":true%' then
        update public.node_health set last_ok = now(), fails = 0, request_id = null where node_id = r.node_id;
      else
        update public.node_health set fails = fails + 1, request_id = null where node_id = r.node_id;
      end if;
    elsif r.last_check < now() - interval '5 minutes' then
      update public.node_health set fails = fails + 1, request_id = null where node_id = r.node_id;
    end if;
    got := null;
  end loop;

  for r in select n.id, n.url from public.nodes n join public.node_health h on h.node_id = n.id
           where n.status = 'active' and h.request_id is null loop
    update public.node_health
      set request_id = net.http_get(url := r.url || '/functions/v1/node?op=health', timeout_milliseconds := 10000),
          last_check = now()
      where node_id = r.id;
  end loop;

  perform public.refresh_partners();
end;
$$;

-- ---------- Лимиты групп ----------
create or replace function public.limit_groups()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.is_group and new.created_by is not null and
     (select count(*) from public.conversations where created_by = new.created_by and is_group)
       >= (case when public.has_plus(new.created_by) then 100 else 20 end) then
    raise exception 'group limit reached';
  end if;
  return new;
end;
$$;
drop trigger if exists conversations_limit_groups on public.conversations;
create trigger conversations_limit_groups before insert on public.conversations
  for each row execute function public.limit_groups();

create or replace function public.limit_members()
returns trigger language plpgsql security definer set search_path = '' as $$
declare c record;
begin
  select is_group, created_by into c from public.conversations where id = new.conversation_id;
  if c.is_group and
     (select count(*) from public.conversation_members where conversation_id = new.conversation_id)
       >= (case when public.has_plus(c.created_by) then 500 else 100 end) then
    raise exception 'group is full';
  end if;
  return new;
end;
$$;
drop trigger if exists members_limit on public.conversation_members;
create trigger members_limit before insert on public.conversation_members
  for each row execute function public.limit_members();

-- ---------- Рамка аватарки ----------
alter table public.profiles add column if not exists frame text
  check (frame in ('gold', 'aurora', 'neon', 'dots'));

-- без security definer: проверке нужен настоящий current_user
create or replace function public.protect_frame()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.frame is distinct from old.frame and new.frame is not null
     and current_user in ('authenticated', 'anon') and not public.has_plus(new.id) then
    raise exception 'frame needs plus';
  end if;
  return new;
end;
$$;
drop trigger if exists profiles_protect_frame on public.profiles;
create trigger profiles_protect_frame before update on public.profiles
  for each row execute function public.protect_frame();

-- ---------- Права ----------
revoke execute on function public.check_nodes() from public, anon, authenticated;
revoke execute on function public.refresh_partners() from public, anon, authenticated;
revoke execute on function public.limit_groups() from public, anon, authenticated;
revoke execute on function public.limit_members() from public, anon, authenticated;
revoke execute on function public.protect_frame() from public, anon, authenticated;
do $$
declare f text;
begin
  foreach f in array array['has_plus(uuid)', 'perks_list()', 'partner_top()', 'gift_plus(text)', 'ungift_plus(uuid)'] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

commit;

-- Проверка узлов каждые 10 минут
select cron.schedule('check-nodes', '*/10 * * * *', 'select public.check_nodes()');
select public.check_nodes();
