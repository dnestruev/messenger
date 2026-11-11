-- Run ONCE after update-18, in the SQL Editor. Exact usernames, no alias matching.
-- Re-running does NOT extend the 30-minute trial or overwrite later assignments.
begin;
do $$
declare sk uuid; peter uuid;
begin
 select id into strict sk from public.profiles where username = 'skitle';
 select id into strict peter from public.profiles where username = 'peteroxhka';
 if public.is_creator(sk) or public.is_creator(peter) then raise exception 'target is a creator: check usernames'; end if;
 insert into public.moderation_roles(user_id, role, expires_at) values
 (sk, 'moderator', null), (peter, 'senior_moderator', now() + interval '30 minutes')
 on conflict (user_id) do nothing;
end $$;
select p.username, r.role, r.expires_at from public.moderation_roles r join public.profiles p on p.id=r.user_id
 where p.username in ('skitle','peteroxhka');
commit;
