-- update-31: все узлы Пятёрочки — на его основной аккаунт @peteroxhka,
-- и у него снят предел «3 узла на аккаунт» (узлы с peteroxhka_v2…v4, pidoras, rec0i1 — его же проекты Supabase)
begin;
-- личный предел узлов: строки нет — 3; max_nodes = null — без ограничения
create table if not exists public.node_limits (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  max_nodes int check (max_nodes is null or max_nodes between 0 and 1000)
);
alter table public.node_limits enable row level security;

create or replace function public.register_node(p_url text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare nid uuid; lim int := 3;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if exists (select 1 from public.node_limits l where l.user_id = auth.uid()) then
    select l.max_nodes into lim from public.node_limits l where l.user_id = auth.uid();
  end if;
  if public.is_creator(auth.uid()) then lim := null; end if;
  if lim is not null and (select count(*) from public.nodes where owner = auth.uid()) >= lim then raise exception 'too many nodes'; end if;
  insert into public.nodes (url, owner) values (lower(trim(trailing '/' from trim(p_url))), auth.uid())
    on conflict (url) do nothing returning id into nid;
  if nid is null then raise exception 'node already registered'; end if;
  return nid;
end;
$$;
revoke execute on function public.register_node(text) from public, anon;
grant execute on function public.register_node(text) to authenticated;

insert into public.node_limits (user_id, max_nodes)
  select id, null from public.profiles where username = 'peteroxhka'
  on conflict (user_id) do update set max_nodes = null;

update public.nodes set owner = (select id from public.profiles where username = 'peteroxhka')
where owner in (select id from public.profiles where username in ('peteroxhka_v2', 'peteroxhka_v3', 'peteroxhka_v4', 'pidoras', 'rec0i1'))
  and exists (select 1 from public.profiles where username = 'peteroxhka');
select public.refresh_partners();
select public.log_event('node_up', 'Узлы с запасных аккаунтов Пятёрочки перенесены на @peteroxhka, предел узлов у него снят', null);
commit;
