-- update-24: приложение для iPhone (TrollStore).
-- Приложение в фоне раз в ~20 с спрашивает «есть новые сообщения?» по секрету устройства
-- (без токенов входа). Отвечаем только «от кого и сколько» — текст зашифрован и серверу не известен.

create table if not exists public.app_devices (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  secret_hash text not null unique,
  last_check timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index if not exists app_devices_user_idx on public.app_devices (user_id, created_at);
alter table public.app_devices enable row level security;
revoke all on public.app_devices from anon, authenticated;

create or replace function public.app_register()
returns text language plpgsql security definer set search_path = '' as $$
declare me uuid := auth.uid(); s text;
begin
  if me is null then raise exception 'not signed in'; end if;
  s := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  insert into public.app_devices (user_id, secret_hash) values (me, encode(sha256(convert_to(s, 'UTF8')), 'hex'));
  -- не больше 10 устройств на человека: старые удаляем
  delete from public.app_devices where user_id = me and id not in
    (select id from public.app_devices where user_id = me order by created_at desc, id desc limit 10);
  return s;
end $$;
revoke all on function public.app_register() from public, anon;
grant execute on function public.app_register() to authenticated;

create or replace function public.app_unregister(p_secret text)
returns void language sql security definer set search_path = '' as $$
  delete from public.app_devices where secret_hash = encode(sha256(convert_to(coalesce(p_secret, ''), 'UTF8')), 'hex');
$$;
revoke all on function public.app_unregister(text) from public;
grant execute on function public.app_unregister(text) to anon, authenticated;

create or replace function public.app_poll(p_secret text)
returns table (conv uuid, nick text, n int, last_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare d public.app_devices; t timestamptz := now();
begin
  select * into d from public.app_devices where secret_hash = encode(sha256(convert_to(coalesce(p_secret, ''), 'UTF8')), 'hex');
  if d.id is null then return; end if;
  update public.app_devices set last_check = t where id = d.id;
  return query
    select m.conversation_id,
           (select p.username from public.profiles p where p.id = (array_agg(m.sender_id order by m.created_at desc))[1]),
           count(*)::int, max(m.created_at)
    from public.messages m
    join public.conversation_members cm on cm.conversation_id = m.conversation_id and cm.user_id = d.user_id
    where m.created_at > d.last_check and m.created_at <= t
      and m.sender_id <> d.user_id
      and not exists (select 1 from public.blocks b where b.blocker = d.user_id and b.blocked = m.sender_id)
    group by m.conversation_id;
end $$;
revoke all on function public.app_poll(text) from public;
grant execute on function public.app_poll(text) to anon, authenticated;
