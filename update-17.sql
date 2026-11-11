-- update-17: какие значки показывать у ника (profiles.hidden_badges) + защита даты смены ника.
--   hidden_badges — список значков, которые человек сам скрыл у себя (видят все: скрытые не показываются никому).
--   username_changed_at теперь нельзя править напрямую (иначе лимит «раз в 30 дней» обходился).
-- Безопасно применять повторно.
begin;

alter table public.profiles add column if not exists hidden_badges text[] not null default '{}';
alter table public.profiles drop constraint if exists profiles_hidden_badges_check;
alter table public.profiles add constraint profiles_hidden_badges_check check (
  hidden_badges <@ array['creator', 'tester', 'bronze', 'silver', 'gold', 'plus', 'relay', 'donor', 'bro']::text[]
  and coalesce(array_length(hidden_badges, 1), 0) <= 9);

create or replace function public.protect_username()
returns trigger language plpgsql set search_path = '' as $$
begin
  if current_user in ('authenticated', 'anon') then
    if new.username is distinct from old.username then raise exception 'username cannot be changed'; end if;
    if new.username_changed_at is distinct from old.username_changed_at then raise exception 'username cannot be changed'; end if;
  end if;
  return new;
end;
$$;

commit;
