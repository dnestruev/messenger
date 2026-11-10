-- Обновление 12: исправления после полной проверки кода.
--   1. Время сообщения ставит сервер. Раньше его можно было подделать из браузера: например,
--      отправить сообщение «из 2099 года», и чат навсегда застрял бы наверху списка у всех участников.
--   2. Фото, голосовые и файлы, которые лежат в хранилище центра (когда узлов не было),
--      теперь можно удалить: при удалении сообщения и при автоочистке через 30 дней.
--      Удалить можно только то, что загрузил сам.
--   3. Ник после регистрации меняется только через создателя (в приложении смены ника нет,
--      а через API раньше можно было переименоваться и сломать чужие ссылки «#u=ник»).
-- Запускать ОДИН раз в Supabase (центр) → SQL Editor, после update-11.sql.

begin;

-- 1. Новое сообщение: время, «изменено» и отметку push выставляет база, а не браузер
create or replace function public.protect_message_insert()
returns trigger language plpgsql set search_path = '' as $$
begin
  -- без security definer: current_user здесь — тот, кто вставляет (служебные роли не трогаем)
  if current_user in ('authenticated', 'anon') then
    new.created_at := now();
    new.edited_at := null;
    new.push_sent := false;
  end if;
  return new;
end;
$$;
revoke execute on function public.protect_message_insert() from public, anon, authenticated;

drop trigger if exists messages_protect_insert on public.messages;
create trigger messages_protect_insert
  before insert on public.messages
  for each row execute function public.protect_message_insert();

-- 2. Своё вложение в хранилище центра можно удалить
drop policy if exists "chat images: delete own" on storage.objects;
create policy "chat images: delete own" on storage.objects for delete to authenticated
  using (bucket_id = 'chat-images' and owner_id = (select auth.uid())::text);

-- 3. Ник не меняется сам по себе
create or replace function public.protect_username()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.username is distinct from old.username and current_user in ('authenticated', 'anon') then
    raise exception 'username cannot be changed';
  end if;
  return new;
end;
$$;
revoke execute on function public.protect_username() from public, anon, authenticated;

drop trigger if exists profiles_protect_username on public.profiles;
create trigger profiles_protect_username
  before update on public.profiles
  for each row execute function public.protect_username();

commit;
