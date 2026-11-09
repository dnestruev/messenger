-- Обновление 8: аватарки-фото и «Избранное».
-- Запускать ОДИН раз в Supabase (центр) → SQL Editor, после update-7.sql.

begin;

-- ---------- Аватарки ----------
-- В профиле хранится только путь к картинке: «<id пользователя>/<случайное имя>.jpg»
alter table public.profiles add column if not exists avatar_path text;
alter table public.profiles drop constraint if exists profiles_avatar_path_check;
alter table public.profiles add constraint profiles_avatar_path_check
  check (avatar_path is null or avatar_path ~ ('^' || id::text || '/[0-9a-f]{32}\.jpg$'));

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', true, 300000, array['image/jpeg'])
on conflict (id) do update set public = true, file_size_limit = 300000, allowed_mime_types = array['image/jpeg'];

-- Загружать и удалять можно только в своей папке; смотреть — всем (картинка публичная, как в любом мессенджере)
drop policy if exists "avatars: upload own" on storage.objects;
create policy "avatars: upload own" on storage.objects for insert to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "avatars: read own" on storage.objects;
create policy "avatars: read own" on storage.objects for select to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "avatars: delete own" on storage.objects;
create policy "avatars: delete own" on storage.objects for delete to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

-- ---------- Избранное: чат с самим собой ----------
create or replace function public.get_or_create_saved()
returns uuid language plpgsql security definer set search_path = '' as $$
declare me uuid := auth.uid(); k text; conv uuid;
begin
  if me is null then raise exception 'not signed in'; end if;
  k := 'saved:' || me::text;
  insert into public.conversations (is_group, dm_key, created_by) values (false, k, me)
    on conflict (dm_key) do nothing;
  select id into conv from public.conversations where dm_key = k;
  insert into public.conversation_members (conversation_id, user_id) values (conv, me) on conflict do nothing;
  return conv;
end;
$$;
revoke execute on function public.get_or_create_saved() from public, anon;
grant execute on function public.get_or_create_saved() to authenticated;

commit;
