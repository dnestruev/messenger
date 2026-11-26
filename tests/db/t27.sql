\set ON_ERROR_STOP 0
insert into auth.users (id, raw_user_meta_data) values ('11111111-1111-1111-1111-111111111111', '{"username":"alice"}');
\i update-27.sql
select '0 повторно без ошибок' as t;
set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
select '1 призы по порядку и сумма 48%' as t, string_agg(kind || ':' || chance_bp, ' '), sum(chance_bp) from public.fortune_prizes_list();
select '2 Бурмалду можно купить' as t, public.limited_order('l_burmalda', null, 'донат 2500 от alice') > 0 as ok;
reset role;
update public.fortune_prizes set chance_bp = case when kind = 'l_burmalda' then 10000 else 0 end;
set role authenticated;
select '3 выпадает' as t, (public.fortune_spin()).kind;
reset role;
select '4 можно скрыть' as t; update public.profiles set hidden_badges = array['l_burmalda'] where username = 'alice';
