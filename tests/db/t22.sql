\set ON_ERROR_STOP 0
-- update-22: refresh_partners работает и с safeupdate (как при вызове через API)
select '1 refresh_partners без ошибки' as t; select public.refresh_partners();
select '2 готово' as t;
