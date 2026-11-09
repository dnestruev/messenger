-- Обновление 11 (Протокол 2.0): исправления, найденные при полной проверке.
--   1. Правило отправки сообщений: из-за пропущенного условия любая блокировка в ЛЮБОМ личном чате
--      запрещала человеку писать вообще везде. Теперь проверяется только этот чат.
--   2. is_blocked_between: раньше любой мог узнать, кто кого заблокировал. Теперь — только о себе.
--   3. Индекс для автоочистки старых фото (поиск своих сообщений по дате).
-- Запускать ОДИН раз в Supabase (центр) → SQL Editor, после update-10.sql.

begin;

drop policy if exists "messages: members send" on public.messages;
create policy "messages: members send" on public.messages for insert to authenticated
  with check (
    sender_id = (select auth.uid())
    and public.is_member(conversation_id)
    and key_version = public.current_key_version(conversation_id)
    and (image_path is null or image_path like conversation_id::text || '/%')
    and (public.is_staff((select auth.uid()))
         or not exists (select 1 from public.conversations c where c.id = messages.conversation_id and c.is_official))
    and not exists (
      select 1 from public.conversations c
      join public.conversation_members m on m.conversation_id = c.id
      where c.id = messages.conversation_id            -- ← именно этот чат (раньше условия не было)
        and not c.is_group
        and m.user_id <> (select auth.uid())
        and public.is_blocked_between((select auth.uid()), m.user_id)
    )
  );

create or replace function public.is_blocked_between(a uuid, b uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select auth.uid() in (a, b)
     and exists (select 1 from public.blocks where (blocker = a and blocked = b) or (blocker = b and blocked = a));
$$;

create index if not exists messages_sender_created on public.messages (sender_id, created_at);

commit;
