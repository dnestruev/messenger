-- update-32: один ключ на новый чат. Раньше тот же человек (второе устройство или двойной вызов)
-- мог «занять» создание ключа повторно и перезаписать отпечаток — первое сообщение нового чата
-- становилось нечитаемым, а ключи у участников удалялись как «не сходятся».
begin;
create or replace function public.claim_conversation_key(conv uuid, p_check text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v int;
  w uuid;
begin
  if not public.is_member(conv) then raise exception 'not a member'; end if;
  if p_check !~ '^[0-9a-f]{64}$' then raise exception 'bad check'; end if;
  select key_version into v from public.conversations where id = conv for update;
  if exists (select 1 from public.conversation_keys where conversation_id = conv and version = v) then return false; end if;
  insert into public.conversation_key_claims as k (conversation_id, version, claimed_by)
    values (conv, v, auth.uid())
  on conflict (conversation_id, version) do update
    set claimed_by = excluded.claimed_by, claimed_at = now()
    where k.claimed_at < now() - interval '30 seconds'
  returning claimed_by into w;
  if w is null then return false; end if;          -- уже занято (кем угодно, даже мной с другого устройства) меньше 30 с назад
  update public.conversations set key_checks = key_checks || jsonb_build_object(v::text, p_check) where id = conv;
  return true;
end;
$$;
revoke execute on function public.claim_conversation_key(uuid, text) from public, anon;
grant execute on function public.claim_conversation_key(uuid, text) to authenticated;
commit;
