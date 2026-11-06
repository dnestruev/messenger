-- Обновление 1: групповые чаты, картинки, настройки профиля, непрочитанные.
-- Запускать ОДИН раз в Supabase → SQL Editor, после schema.sql.
-- Старые переписки сохраняются: они превращаются в личные чаты.

begin;

-- ---------- Профиль: имя и цвет аватарки ----------
alter table public.profiles
  add column display_name text check (char_length(display_name) <= 40),
  add column avatar_hue int check (avatar_hue between 0 and 359);

create policy "profiles: update own"
  on public.profiles for update to authenticated
  using (auth.uid() = id) with check (auth.uid() = id);

-- ---------- Чаты и участники ----------
create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  is_group boolean not null default false,
  title text check (char_length(title) <= 60),
  dm_key text unique,                         -- только для личных чатов: "id1:id2"
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  last_message_at timestamptz not null default now()
);

create table public.conversation_members (
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  joined_at timestamptz not null default now(),
  last_read_at timestamptz not null default now(),
  primary key (conversation_id, user_id)
);
create index conversation_members_user_idx on public.conversation_members (user_id);

create or replace function public.is_member(conv uuid)
returns boolean language sql security definer set search_path = '' stable as $$
  select exists (
    select 1 from public.conversation_members
    where conversation_id = conv and user_id = auth.uid()
  );
$$;

alter table public.conversations enable row level security;
alter table public.conversation_members enable row level security;

create policy "conversations: members read"
  on public.conversations for select to authenticated using (public.is_member(id));

create policy "members: members read"
  on public.conversation_members for select to authenticated
  using (public.is_member(conversation_id));

create policy "members: mark read"
  on public.conversation_members for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "members: leave group"
  on public.conversation_members for delete to authenticated
  using (
    user_id = auth.uid()
    and exists (select 1 from public.conversations c where c.id = conversation_id and c.is_group)
  );

-- ---------- Перенос старых сообщений в личные чаты ----------
alter table public.messages
  add column conversation_id uuid references public.conversations(id) on delete cascade,
  add column image_path text;

insert into public.conversations (is_group, dm_key, created_at, last_message_at)
select false, k, min(created_at), max(created_at)
from (
  select least(sender_id::text, receiver_id::text) || ':' || greatest(sender_id::text, receiver_id::text) as k,
         created_at
  from public.messages
) t
group by k;

insert into public.conversation_members (conversation_id, user_id)
select id, split_part(dm_key, ':', 1)::uuid from public.conversations where dm_key is not null
union
select id, split_part(dm_key, ':', 2)::uuid from public.conversations where dm_key is not null;

update public.messages m
set conversation_id = c.id
from public.conversations c
where c.dm_key = least(m.sender_id::text, m.receiver_id::text) || ':' || greatest(m.sender_id::text, m.receiver_id::text);

drop policy "messages: read own" on public.messages;
drop policy "messages: send as self" on public.messages;
alter table public.messages drop column receiver_id;
alter table public.messages alter column conversation_id set not null;
alter table public.messages drop constraint messages_content_check;
alter table public.messages alter column content set default '';
alter table public.messages add constraint messages_body_check
  check (char_length(content) <= 4000 and (char_length(content) > 0 or image_path is not null));
create index messages_conv_idx on public.messages (conversation_id, created_at desc);

create policy "messages: members read"
  on public.messages for select to authenticated
  using (public.is_member(conversation_id));

create policy "messages: members send"
  on public.messages for insert to authenticated
  with check (
    sender_id = auth.uid()
    and public.is_member(conversation_id)
    and (image_path is null or image_path like conversation_id::text || '/%')
  );

-- Время последнего сообщения в чате (для сортировки и непрочитанных)
create or replace function public.touch_conversation()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update public.conversations set last_message_at = new.created_at where id = new.conversation_id;
  update public.conversation_members set last_read_at = new.created_at
    where conversation_id = new.conversation_id and user_id = new.sender_id;
  return new;
end;
$$;

create trigger on_message_created
  after insert on public.messages
  for each row execute function public.touch_conversation();

-- ---------- Функции для приложения ----------

-- Открыть (или создать) личный чат с человеком
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
  k := least(me::text, other::text) || ':' || greatest(me::text, other::text);
  insert into public.conversations (is_group, dm_key, created_by) values (false, k, me)
    on conflict (dm_key) do nothing;
  select id into conv from public.conversations where dm_key = k;
  insert into public.conversation_members (conversation_id, user_id)
    values (conv, me), (conv, other) on conflict do nothing;
  return conv;
end;
$$;

-- Создать группу: название + список ников
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
      where p.username = any (select lower(trim(u)) from unnest(usernames) u);
  return conv;
end;
$$;

-- Добавить людей в группу (может любой участник)
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
    on conflict do nothing;
  get diagnostics added = row_count;
  return added;
end;
$$;

-- Переименовать группу
create or replace function public.rename_group(conv uuid, new_title text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_member(conv) then raise exception 'not a member'; end if;
  if coalesce(trim(new_title), '') = '' then raise exception 'empty title'; end if;
  update public.conversations set title = left(trim(new_title), 60) where id = conv and is_group;
end;
$$;

-- Список моих чатов с последним сообщением
create or replace function public.my_chats()
returns table (
  id uuid, is_group boolean, title text, last_message_at timestamptz, last_read_at timestamptz,
  last_content text, last_sender uuid, last_image boolean, member_ids uuid[]
) language sql security definer set search_path = '' stable as $$
  select c.id, c.is_group, c.title, c.last_message_at, cm.last_read_at,
         lm.content, lm.sender_id, lm.image_path is not null,
         (select array_agg(x.user_id) from public.conversation_members x where x.conversation_id = c.id)
  from public.conversation_members cm
  join public.conversations c on c.id = cm.conversation_id
  left join lateral (
    select m.content, m.sender_id, m.image_path from public.messages m
    where m.conversation_id = c.id order by m.created_at desc limit 1
  ) lm on true
  where cm.user_id = auth.uid()
  order by c.last_message_at desc;
$$;

revoke execute on function public.get_or_create_dm(uuid) from anon;
revoke execute on function public.create_group(text, text[]) from anon;
revoke execute on function public.add_group_members(uuid, text[]) from anon;
revoke execute on function public.rename_group(uuid, text) from anon;
revoke execute on function public.my_chats() from anon;

-- ---------- Мгновенная доставка: новые чаты тоже ----------
alter publication supabase_realtime add table public.conversation_members;

-- ---------- Картинки (Storage) ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('chat-images', 'chat-images', false, 5242880,
        array['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
on conflict (id) do nothing;

create policy "chat images: members read"
  on storage.objects for select to authenticated
  using (bucket_id = 'chat-images' and public.is_member(((storage.foldername(name))[1])::uuid));

create policy "chat images: members upload"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'chat-images' and public.is_member(((storage.foldername(name))[1])::uuid));

commit;
