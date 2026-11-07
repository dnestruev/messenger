-- Обновление 3: стандартный набор функций и команда.
--   * изменение и удаление своих сообщений
--   * блокировка людей, архив чатов, удаление личного чата и аккаунта
--   * создатели и тестеры, официальные чаты
--   * закрыта дыра: участник не может «перепрыгнуть» в чужой чат
-- Запускать ОДИН раз в Supabase → SQL Editor, после update-2.sql.

begin;

-- ---------- Безопасность: в своей строке участника можно менять только «прочитано» и «архив» ----------
alter table public.conversation_members add column archived boolean not null default false;

create or replace function public.protect_member_update()
returns trigger language plpgsql as $$
begin
  if current_user in ('authenticated', 'anon')
     and (new.conversation_id <> old.conversation_id or new.user_id <> old.user_id or new.joined_at <> old.joined_at) then
    raise exception 'only read state and archive can be changed';
  end if;
  return new;
end;
$$;

create trigger members_protect_update
  before update on public.conversation_members
  for each row execute function public.protect_member_update();

-- ---------- Изменить и удалить своё сообщение ----------
alter table public.messages add column edited_at timestamptz;

create or replace function public.protect_message_update()
returns trigger language plpgsql as $$
begin
  if current_user in ('authenticated', 'anon') then
    if new.sender_id <> old.sender_id or new.conversation_id <> old.conversation_id
       or new.created_at <> old.created_at or new.push_sent <> old.push_sent then
      raise exception 'only the text can be edited';
    end if;
    new.edited_at := now();
  end if;
  return new;
end;
$$;

create trigger messages_protect_update
  before update on public.messages
  for each row execute function public.protect_message_update();

create policy "messages: edit own" on public.messages for update to authenticated
  using (sender_id = auth.uid()) with check (sender_id = auth.uid());
create policy "messages: delete own" on public.messages for delete to authenticated
  using (sender_id = auth.uid());

-- ---------- Блокировка ----------
create table public.blocks (
  blocker uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  blocked uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker, blocked),
  check (blocker <> blocked)
);
alter table public.blocks enable row level security;
create policy "blocks: own" on public.blocks for all to authenticated
  using (blocker = auth.uid()) with check (blocker = auth.uid());

create or replace function public.is_blocked_between(a uuid, b uuid)
returns boolean language sql security definer set search_path = '' stable as $$
  select exists (select 1 from public.blocks where (blocker = a and blocked = b) or (blocker = b and blocked = a));
$$;

-- Личный чат с заблокированным не создаётся
create or replace function public.get_or_create_dm(other uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  k text;
  conv uuid;
begin
  if me is null then raise exception 'not signed in'; end if;
  if other = me then raise exception 'cannot chat with yourself'; end if;
  if not exists (select 1 from public.profiles where id = other) then raise exception 'user not found'; end if;
  if public.is_blocked_between(me, other) then raise exception 'blocked'; end if;
  k := least(me::text, other::text) || ':' || greatest(me::text, other::text);
  insert into public.conversations (is_group, dm_key, created_by) values (false, k, me)
    on conflict (dm_key) do nothing;
  select id into conv from public.conversations where dm_key = k;
  insert into public.conversation_members (conversation_id, user_id)
    values (conv, me), (conv, other) on conflict do nothing;
  return conv;
end;
$$;

-- В группу нельзя добавить того, с кем есть блокировка
create or replace function public.create_group(group_title text, usernames text[])
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  conv uuid;
begin
  if me is null then raise exception 'not signed in'; end if;
  if coalesce(trim(group_title), '') = '' then raise exception 'empty title'; end if;
  insert into public.conversations (is_group, title, created_by)
    values (true, left(trim(group_title), 60), me) returning id into conv;
  insert into public.conversation_members (conversation_id, user_id)
    select conv, me
    union
    select conv, p.id from public.profiles p
      where p.username = any (select lower(trim(u)) from unnest(usernames) u)
        and not public.is_blocked_between(me, p.id);
  return conv;
end;
$$;

create or replace function public.add_group_members(conv uuid, usernames text[])
returns int language plpgsql security definer set search_path = '' as $$
declare added int;
begin
  if not public.is_member(conv) then raise exception 'not a member'; end if;
  if not exists (select 1 from public.conversations where id = conv and is_group) then
    raise exception 'not a group';
  end if;
  insert into public.conversation_members (conversation_id, user_id)
    select conv, p.id from public.profiles p
    where p.username = any (select lower(trim(u)) from unnest(usernames) u)
      and not public.is_blocked_between(auth.uid(), p.id)
    on conflict do nothing;
  get diagnostics added = row_count;
  return added;
end;
$$;

-- ---------- Удалить личный чат (у обоих) и аккаунт ----------
create or replace function public.delete_dm(conv uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_member(conv) then raise exception 'not a member'; end if;
  delete from public.conversations where id = conv and not is_group;
end;
$$;

create or replace function public.delete_account()
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  delete from auth.users where id = auth.uid();
end;
$$;

revoke execute on function public.delete_dm(uuid) from anon;
revoke execute on function public.delete_account() from anon;

-- ---------- Роли ----------
alter table public.profiles
  add column role text check (role in ('creator', 'tester'));

-- Роль нельзя поставить себе самому: менять её может только база (SQL Editor) или создатель через set_role
create or replace function public.protect_role()
returns trigger language plpgsql as $$
begin
  if new.role is distinct from old.role and current_user in ('authenticated', 'anon') then
    raise exception 'role can only be changed by a creator';
  end if;
  return new;
end;
$$;

create trigger profiles_protect_role
  before update on public.profiles
  for each row execute function public.protect_role();

create or replace function public.is_staff(uid uuid)
returns boolean language sql security definer set search_path = '' stable as $$
  select exists (select 1 from public.profiles where id = uid and role is not null);
$$;

-- Создатель назначает и снимает тестеров по нику
create or replace function public.set_role(p_username text, p_role text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.profiles where id = auth.uid() and role = 'creator') then
    raise exception 'only creators can change roles';
  end if;
  if p_role is not null and p_role <> 'tester' then raise exception 'creators can only assign testers'; end if;
  update public.profiles set role = p_role
    where username = lower(trim(p_username)) and role is distinct from 'creator';
  if not found then raise exception 'user not found or is a creator'; end if;
end;
$$;

-- ---------- Официальные чаты ----------
alter table public.conversations
  add column is_official boolean not null default false;

create or replace function public.set_official(conv uuid, value boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.profiles where id = auth.uid() and role = 'creator') then
    raise exception 'only creators can mark chats official';
  end if;
  if not public.is_member(conv) then raise exception 'not a member'; end if;
  update public.conversations set is_official = value where id = conv and is_group;
end;
$$;

-- В официальный чат пишет только команда, остальные читают
drop policy "messages: members send" on public.messages;
create policy "messages: members send"
  on public.messages for insert to authenticated
  with check (
    sender_id = auth.uid()
    and public.is_member(conversation_id)
    and (image_path is null or image_path like conversation_id::text || '/%')
    and (
      public.is_staff(auth.uid())
      or not exists (select 1 from public.conversations c where c.id = conversation_id and c.is_official)
    )
    and not exists (
      select 1 from public.conversations c
      join public.conversation_members m on m.conversation_id = c.id
      where c.id = conversation_id and not c.is_group
        and m.user_id <> auth.uid() and public.is_blocked_between(auth.uid(), m.user_id)
    )
  );

-- Список чатов теперь знает, какой чат официальный
drop function public.my_chats();
create function public.my_chats()
returns table (
  id uuid, is_group boolean, title text, is_official boolean, archived boolean,
  last_message_at timestamptz, last_read_at timestamptz,
  last_ct text, last_iv text, last_sender uuid, member_ids uuid[]
) language sql security definer set search_path = '' stable as $$
  select c.id, c.is_group, c.title, c.is_official, cm.archived, c.last_message_at, cm.last_read_at,
         lm.ct, lm.iv, lm.sender_id,
         (select array_agg(x.user_id) from public.conversation_members x where x.conversation_id = c.id)
  from public.conversation_members cm
  join public.conversations c on c.id = cm.conversation_id
  left join lateral (
    select m.ct, m.iv, m.sender_id from public.messages m
    where m.conversation_id = c.id order by m.created_at desc limit 1
  ) lm on true
  where cm.user_id = auth.uid()
  order by c.is_official desc, c.last_message_at desc;
$$;

revoke execute on function public.my_chats() from anon;
revoke execute on function public.set_role(text, text) from anon;
revoke execute on function public.set_official(uuid, boolean) from anon;

-- ---------- Вы — создатель ----------
update public.profiles set role = 'creator' where username = 'deltaofishal';

commit;
