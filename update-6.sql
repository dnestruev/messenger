-- Обновление 6: укрепление по замечаниям советника безопасности Supabase.
--   * служебные функции нельзя вызвать через API; остальные — только после входа
--   * зафиксирован search_path у триггерных функций
--   (перенос pg_net в схему extensions убран: на нём держатся push и проверка узлов)
-- Запускать ОДИН раз в Supabase (центр), после update-5.sql.

begin;

-- Триггерные функции: через API их вызывать незачем
revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.notify_push() from public, anon, authenticated;
revoke execute on function public.rotate_on_leave() from public, anon, authenticated;
revoke execute on function public.touch_conversation() from public, anon, authenticated;

-- Функции приложения и проверки прав: только для вошедших
do $$
declare f text;
begin
  foreach f in array array[
    'add_group_members(uuid, text[])', 'claim_conversation_key(uuid, text)', 'create_group(text, text[])',
    'current_fingerprint(uuid)', 'current_key_version(uuid)', 'delete_account()', 'delete_dm(uuid)',
    'delete_node(uuid)', 'get_or_create_dm(uuid)', 'is_blocked_between(uuid, uuid)', 'is_creator(uuid)',
    'is_member(uuid)', 'is_staff(uuid)', 'my_chats()', 'node_stats()', 'register_node(text)',
    'rename_group(uuid, text)', 'report_node(uuid, text)', 'save_push_subscription(text, text, text)',
    'set_node_status(uuid, text)', 'set_official(uuid, boolean)', 'set_role(text, text)'
  ] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

-- Проверка ника при регистрации нужна до входа
grant execute on function public.username_available(text) to anon, authenticated;

-- search_path у триггерных функций
alter function public.protect_message_update() set search_path = '';
alter function public.protect_member_update() set search_path = '';
alter function public.protect_role() set search_path = '';
alter function public.stamp_wrapped_by() set search_path = '';

commit;

