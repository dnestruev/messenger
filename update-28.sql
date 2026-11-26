-- update-28: личный буст «Фортуны» — создатель попросил себе 90% на «Удачу».
--   Таблица fortune_boost (человек → приз → шанс). Буст проверяется первым; как только приз выпал — запись удаляется сама.
--   Выигрыш с бустом НЕ публикуется в новостях (там пишется «шанс был 0,1%» — было бы неправдой), в «События» — пометка.
--   Выдать/снять буст можно только SQL-ом (через приложение нельзя). Безопасно применять повторно.
begin;
create table if not exists public.fortune_boost (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  kind text not null references public.limited_kinds(kind),
  chance_bp int not null check (chance_bp between 1 and 10000),
  created_at timestamptz not null default now()
);
alter table public.fortune_boost enable row level security;
revoke all on public.fortune_boost from anon, authenticated;

create or replace function public.fortune_spin()
returns table (kind text, serial int, item_id bigint, free_left int, paid_left int)
language plpgsql security definer set search_path = '' as $$
declare me uuid := auth.uid(); is_paid boolean; roll int; acc int := 0; won text; pr record;
        k public.limited_kinds; n int; new_item bigint; left_paid int; nick text; creator uuid; bst public.fortune_boost; boosted boolean := false;
begin
  if me is null then raise exception 'not signed in'; end if;
  if public.is_banned(me) then raise exception 'banned'; end if;
  if not public.fortune_active() then raise exception 'fortune is over'; end if;
  insert into public.fortune_balance (user_id) values (me) on conflict (user_id) do nothing;
  perform 1 from public.fortune_balance b where b.user_id = me for update;          -- одна крутка за раз у человека
  if public.fortune_free_left(me) > 0 then is_paid := false;
  elsif (select b.paid_left from public.fortune_balance b where b.user_id = me) > 0 then
    is_paid := true;
    update public.fortune_balance b set paid_left = b.paid_left - 1 where b.user_id = me;
  else raise exception 'no spins left'; end if;
  -- случайное число 0..9999 из gen_random_uuid (криптостойкий генератор)
  roll := (('x' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8))::bit(32)::bigint % 10000)::int;
  select * into bst from public.fortune_boost b where b.user_id = me;
  if bst.user_id is not null and roll < bst.chance_bp then
    won := bst.kind; boosted := true;                                                  -- личный буст (выдал создатель)
  else
    if bst.user_id is not null then roll := (('x' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8))::bit(32)::bigint % 10000)::int; end if;
    for pr in select p.kind, p.chance_bp from public.fortune_prizes p join public.limited_kinds lk on lk.kind = p.kind order by lk.sort desc loop
      acc := acc + pr.chance_bp;
      if roll < acc then won := pr.kind; exit; end if;
    end loop;
  end if;
  if won is not null then
    select * into k from public.limited_kinds lk where lk.kind = won for update;
    if (select count(*) from public.limited_items i where i.kind = won)
       + (select count(*) from public.limited_orders o where o.kind = won and o.status = 'pending' and not o.resale) >= k.total then
      won := null;                                                                     -- тираж кончился — «пусто»
    else
      select coalesce(max(i.serial), 0) + 1 into n from public.limited_items i where i.kind = won;
      insert into public.limited_items (kind, serial, owner) values (won, n, me) returning id into new_item;
    end if;
  end if;
  insert into public.fortune_spins (user_id, paid, kind, item_id) values (me, is_paid, won, new_item);
  if bst.user_id is not null and won = bst.kind and new_item is not null then
    delete from public.fortune_boost b where b.user_id = me;                          -- выпало — буст снимается сам
    boosted := true;
  end if;
  if boosted then
    perform public.log_event('fortune_boost', 'Буст сработал: ' || public.ev_nick(me) || ' получил ' || won || ' №' || n || ' (без новости)', null);
  elsif won = 'l_luck' then
    select '@' || p.username into nick from public.profiles p where p.id = me;
    select p.id into creator from public.profiles p where p.role = 'creator' order by p.created_at limit 1;
    if creator is not null then
      insert into public.news (author, body) values (creator,
        '✨ **' || nick || ' выбил «Удачу» №' || n || '!** Сверхредкий статус из «Фортуны» — всего 3 на весь мессенджер. Шанс был 0,1%. Поздравляем! 🎰');
    end if;
    perform public.log_event('fortune_luck', nick || ' выбил «Удачу» №' || n || ' в «Фортуне»', 'user:' || substr(nick, 2));
  elsif won = 'l_jackpot' then
    select '@' || p.username into nick from public.profiles p where p.id = me;
    perform public.log_event('fortune_win', nick || ' выбил «Джекпот» №' || n || ' в «Фортуне»', 'user:' || substr(nick, 2));
  end if;
  select b.paid_left into left_paid from public.fortune_balance b where b.user_id = me;
  return query select won, case when won is null then null else n end, new_item, public.fortune_free_left(me), left_paid;
end $$;
revoke all on function public.fortune_spin() from public, anon;
grant execute on function public.fortune_spin() to authenticated;

insert into public.fortune_boost (user_id, kind, chance_bp)
  select p.id, 'l_luck', 9000 from public.profiles p where p.username = 'deltaofishal'
  on conflict (user_id) do nothing;
commit;
