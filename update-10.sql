-- Обновление 10: реакции на сообщения.
-- Эмодзи зашифрован ключом чата: сервер видит только, что кто-то отреагировал, но не чем.
-- Запускать ОДИН раз в Supabase (центр) → SQL Editor, после update-9.sql.

begin;

create table if not exists public.reactions (
  message_id bigint not null references public.messages(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  user_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  ct text not null check (length(ct) < 400),
  iv text not null check (length(iv) < 40),
  kv int not null default 1,
  created_at timestamptz not null default now(),
  primary key (message_id, user_id)                -- одна реакция от человека на сообщение
);
create index if not exists reactions_conv on public.reactions (conversation_id, message_id);
alter table public.reactions enable row level security;

drop policy if exists "reactions: read in my chats" on public.reactions;
create policy "reactions: read in my chats" on public.reactions for select to authenticated
  using (public.is_member(conversation_id));

drop policy if exists "reactions: add own" on public.reactions;
create policy "reactions: add own" on public.reactions for insert to authenticated
  with check (
    user_id = auth.uid() and public.is_member(conversation_id)
    and exists (select 1 from public.messages m where m.id = message_id and m.conversation_id = reactions.conversation_id)
  );

drop policy if exists "reactions: change own" on public.reactions;
create policy "reactions: change own" on public.reactions for update to authenticated
  using (user_id = auth.uid())
  with check (
    user_id = auth.uid() and public.is_member(conversation_id)
    and exists (select 1 from public.messages m where m.id = message_id and m.conversation_id = reactions.conversation_id)
  );

drop policy if exists "reactions: remove own" on public.reactions;
create policy "reactions: remove own" on public.reactions for delete to authenticated
  using (user_id = auth.uid());

-- чтобы реакции прилетали сразу
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'reactions') then
    alter publication supabase_realtime add table public.reactions;
  end if;
end $$;
-- replica identity по умолчанию: при удалении рассылается только (message_id, user_id), без лишнего

commit;
