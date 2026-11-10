-- update-15: закреплённые чаты (свой порядок, синхронно на всех устройствах) и канал «Новости» для всех.
--   conversation_members.pin_order — место закреплённого чата (1, 2, 3…), null — не закреплён. До 10 закреплённых.
--   set_pins(ids) — одним вызовом задать закреплённые чаты в нужном порядке.
--   news — новости: пишет только создатель, читают все вошедшие; news_reactions — реакции (свои ставит каждый).
-- Безопасно применять повторно.
begin;

-- ---------- Закреплённые чаты ----------
alter table public.conversation_members add column if not exists pin_order int check (pin_order between 1 and 10);
grant update (pin_order) on public.conversation_members to authenticated;

create or replace function public.set_pins(p_ids uuid[])
returns void language plpgsql security definer set search_path = '' as $$
declare i int := 0; cid uuid;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if coalesce(array_length(p_ids, 1), 0) > 10 then raise exception 'too many pins'; end if;
  update public.conversation_members set pin_order = null
    where user_id = auth.uid() and pin_order is not null and not (conversation_id = any (coalesce(p_ids, '{}')));
  foreach cid in array coalesce(p_ids, '{}') loop
    i := i + 1;
    update public.conversation_members set pin_order = i where user_id = auth.uid() and conversation_id = cid;
  end loop;
end;
$$;
revoke execute on function public.set_pins(uuid[]) from public, anon;
grant execute on function public.set_pins(uuid[]) to authenticated;

-- my_chats: + pin_order (тип результата меняется — пересоздаём)
drop function if exists public.my_chats();
create function public.my_chats()
returns table (id uuid, is_group boolean, title text, is_official boolean, archived boolean, key_version integer, key_checks jsonb,
  last_message_at timestamptz, last_read_at timestamptz, last_ct text, last_iv text, last_sender uuid, last_hash text,
  last_nodes uuid[], last_cid uuid, last_sig text, last_key_version integer, member_ids uuid[], pin_order integer)
language sql stable security definer set search_path = '' as $$
  select c.id, c.is_group, c.title, c.is_official, cm.archived, c.key_version, c.key_checks,
         c.last_message_at, cm.last_read_at,
         lm.ct, lm.iv, lm.sender_id, lm.ct_hash, lm.nodes, lm.cid, lm.sig, lm.key_version,
         (select array_agg(x.user_id) from public.conversation_members x where x.conversation_id = c.id),
         cm.pin_order
  from public.conversation_members cm
  join public.conversations c on c.id = cm.conversation_id
  left join lateral (
    select m.ct, m.iv, m.sender_id, m.ct_hash, m.nodes, m.cid, m.sig, m.key_version from public.messages m
    where m.conversation_id = c.id order by m.created_at desc limit 1
  ) lm on true
  where cm.user_id = auth.uid()
  order by c.is_official desc, c.last_message_at desc;
$$;
revoke execute on function public.my_chats() from public, anon;
grant execute on function public.my_chats() to authenticated;

-- ---------- Канал «Новости» ----------
create table if not exists public.news (
  id bigint generated always as identity primary key,
  author uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  body text not null check (char_length(body) between 1 and 4000),
  created_at timestamptz not null default now(),
  edited_at timestamptz
);
create index if not exists news_created on public.news (created_at desc);
alter table public.news enable row level security;
revoke all on public.news from anon, authenticated;
grant select, insert, delete on public.news to authenticated;
grant update (body) on public.news to authenticated;
drop policy if exists "news: read" on public.news;
create policy "news: read" on public.news for select to authenticated using (true);
drop policy if exists "news: creator writes" on public.news;
create policy "news: creator writes" on public.news for insert to authenticated
  with check (author = (select auth.uid()) and public.is_creator((select auth.uid())));
drop policy if exists "news: creator edits" on public.news;
create policy "news: creator edits" on public.news for update to authenticated
  using (public.is_creator((select auth.uid()))) with check (public.is_creator((select auth.uid())));
drop policy if exists "news: creator deletes" on public.news;
create policy "news: creator deletes" on public.news for delete to authenticated
  using (public.is_creator((select auth.uid())));

-- время ставит сервер; правка отмечается сама
create or replace function public.protect_news()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then new.created_at := now(); new.edited_at := null;
  elsif new.body is distinct from old.body then new.edited_at := now(); new.created_at := old.created_at; new.author := old.author;
  end if;
  return new;
end;
$$;
revoke execute on function public.protect_news() from public, anon, authenticated;
drop trigger if exists news_protect on public.news;
create trigger news_protect before insert or update on public.news for each row execute function public.protect_news();

create table if not exists public.news_reactions (
  news_id bigint not null references public.news(id) on delete cascade,
  user_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  emoji text not null check (char_length(emoji) between 1 and 16),
  created_at timestamptz not null default now(),
  primary key (news_id, user_id, emoji)
);
alter table public.news_reactions enable row level security;
revoke all on public.news_reactions from anon, authenticated;
grant select, insert, delete on public.news_reactions to authenticated;
drop policy if exists "news_reactions: read" on public.news_reactions;
create policy "news_reactions: read" on public.news_reactions for select to authenticated using (true);
drop policy if exists "news_reactions: own" on public.news_reactions;
create policy "news_reactions: own" on public.news_reactions for insert to authenticated
  with check (user_id = (select auth.uid()) and (select count(*) from public.news_reactions r where r.news_id = news_reactions.news_id and r.user_id = (select auth.uid())) < 3);
drop policy if exists "news_reactions: remove own" on public.news_reactions;
create policy "news_reactions: remove own" on public.news_reactions for delete to authenticated
  using (user_id = (select auth.uid()));

-- новости и реакции приходят сразу (Realtime). У реакций ключ = все поля, поэтому DELETE тоже несёт смысл.
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'news') then
      alter publication supabase_realtime add table public.news;
    end if;
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'news_reactions') then
      alter publication supabase_realtime add table public.news_reactions;
    end if;
  end if;
end $$;

commit;
