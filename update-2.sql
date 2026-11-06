-- Обновление 2: сквозное шифрование и push-уведомления.
-- Запускать ОДИН раз в Supabase → SQL Editor, после update-1.sql.
-- ВНИМАНИЕ: удаляет все старые (незашифрованные) сообщения. Чаты и группы остаются.

begin;

-- ---------- 1. Чистый лист: удаляем старые сообщения ----------
delete from public.messages;
update public.conversations set last_message_at = created_at;

-- ---------- 2. Сообщения теперь хранят только шифр ----------
alter table public.messages drop constraint messages_body_check;
alter table public.messages
  add column ct text,                                  -- зашифрованный текст/фото (base64)
  add column iv text,                                  -- случайный вектор AES-GCM
  add column push_sent boolean not null default false; -- чтобы push ушёл ровно один раз
alter table public.messages add constraint messages_e2ee_check
  check (content = '' and image_path is null and ct is not null and iv is not null
         and char_length(ct) <= 60000 and char_length(iv) between 12 and 32);

-- ---------- 3. Публичные ключи пользователей ----------
create table public.user_keys (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  public_key jsonb not null,
  fingerprint text not null,
  updated_at timestamptz not null default now()
);
alter table public.user_keys enable row level security;
create policy "user_keys: read" on public.user_keys for select to authenticated using (true);
create policy "user_keys: insert own" on public.user_keys for insert to authenticated
  with check (user_id = auth.uid());
create policy "user_keys: update own" on public.user_keys for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---------- 4. Резервная копия секретного ключа (зашифрована вашим кодом) ----------
create table public.key_backups (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  backup jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.key_backups enable row level security;
create policy "key_backups: read own" on public.key_backups for select to authenticated
  using (user_id = auth.uid());
create policy "key_backups: insert own" on public.key_backups for insert to authenticated
  with check (user_id = auth.uid());
create policy "key_backups: update own" on public.key_backups for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---------- 5. Ключ каждого чата, зашифрованный для каждого участника ----------
create table public.conversation_keys (
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  for_fingerprint text not null,       -- для какого публичного ключа зашифровано
  wrapped jsonb not null,
  wrapped_by uuid default auth.uid() references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (conversation_id, user_id)
);
alter table public.conversation_keys enable row level security;
create policy "conversation_keys: members read" on public.conversation_keys for select to authenticated
  using (public.is_member(conversation_id));
create policy "conversation_keys: members share" on public.conversation_keys for insert to authenticated
  with check (
    public.is_member(conversation_id)
    and exists (select 1 from public.conversation_members m
                where m.conversation_id = conversation_keys.conversation_id and m.user_id = conversation_keys.user_id)
  );
create policy "conversation_keys: members reshare" on public.conversation_keys for update to authenticated
  using (public.is_member(conversation_id))
  with check (
    public.is_member(conversation_id)
    and exists (select 1 from public.conversation_members m
                where m.conversation_id = conversation_keys.conversation_id and m.user_id = conversation_keys.user_id)
  );

-- Кто первым создаёт ключ чата (чтобы два человека не создали разные ключи)
create table public.conversation_key_claims (
  conversation_id uuid primary key references public.conversations(id) on delete cascade,
  claimed_by uuid not null references public.profiles(id) on delete cascade,
  claimed_at timestamptz not null default now()
);
alter table public.conversation_key_claims enable row level security;

create or replace function public.claim_conversation_key(conv uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare w uuid;
begin
  if not public.is_member(conv) then raise exception 'not a member'; end if;
  if exists (select 1 from public.conversation_keys where conversation_id = conv) then return false; end if;
  insert into public.conversation_key_claims as k (conversation_id, claimed_by)
    values (conv, auth.uid())
  on conflict (conversation_id) do update
    set claimed_by = excluded.claimed_by, claimed_at = now()
    where k.claimed_at < now() - interval '30 seconds'
  returning claimed_by into w;
  if w = auth.uid() then return true; end if;
  return exists (select 1 from public.conversation_key_claims
                 where conversation_id = conv and claimed_by = auth.uid());
end;
$$;

-- ---------- 6. Подписки на push ----------
create table public.push_subscriptions (
  endpoint text primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
);
alter table public.push_subscriptions enable row level security;
create policy "push: read own" on public.push_subscriptions for select to authenticated
  using (user_id = auth.uid());
create policy "push: delete own" on public.push_subscriptions for delete to authenticated
  using (user_id = auth.uid());

create or replace function public.save_push_subscription(p_endpoint text, p_p256dh text, p_auth text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if p_endpoint !~ '^https://' then raise exception 'bad endpoint'; end if;
  insert into public.push_subscriptions (endpoint, user_id, p256dh, auth)
    values (p_endpoint, auth.uid(), p_p256dh, p_auth)
  on conflict (endpoint) do update
    set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, created_at = now();
end;
$$;

-- ---------- 7. Список чатов отдаёт шифр последнего сообщения ----------
drop function public.my_chats();
create function public.my_chats()
returns table (
  id uuid, is_group boolean, title text, last_message_at timestamptz, last_read_at timestamptz,
  last_ct text, last_iv text, last_sender uuid, member_ids uuid[]
) language sql security definer set search_path = '' stable as $$
  select c.id, c.is_group, c.title, c.last_message_at, cm.last_read_at,
         lm.ct, lm.iv, lm.sender_id,
         (select array_agg(x.user_id) from public.conversation_members x where x.conversation_id = c.id)
  from public.conversation_members cm
  join public.conversations c on c.id = cm.conversation_id
  left join lateral (
    select m.ct, m.iv, m.sender_id from public.messages m
    where m.conversation_id = c.id order by m.created_at desc limit 1
  ) lm on true
  where cm.user_id = auth.uid()
  order by c.last_message_at desc;
$$;

revoke execute on function public.my_chats() from anon;
revoke execute on function public.claim_conversation_key(uuid) from anon;
revoke execute on function public.save_push_subscription(text, text, text) from anon;

-- Мгновенно узнавать о новых ключах (чтобы делиться ключом чата с новыми участниками)
alter publication supabase_realtime add table public.conversation_keys;
alter publication supabase_realtime add table public.user_keys;

-- ---------- 8. Фото теперь тоже зашифрованы (хранятся как набор байт) ----------
update storage.buckets
  set allowed_mime_types = array['application/octet-stream'], file_size_limit = 6291456
  where id = 'chat-images';

commit;
