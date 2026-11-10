create or replace function public.notify_push() returns trigger language plpgsql security definer set search_path = '' as $$
begin perform net.http_post(url := 'x', body := jsonb_build_object('id', new.id)); return new; end; $$;
create trigger on_message_push after insert on public.messages for each row execute function public.notify_push();
