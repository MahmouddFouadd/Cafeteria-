-- =====================================================================
--  021_staff_push.sql — the buffet is notified when an order arrives from
--  the employee app (push, even when the staff app is closed).
--  Run once after 020, then redeploy the Edge Function "send-push" with the
--  new code (it now also sends "new order" notifications to the buffet).
-- =====================================================================
set search_path = public, extensions;

-- ---------- staff devices subscribed to push ----------
create table if not exists staff_push_subscriptions (
  endpoint     text primary key,
  user_id      uuid not null references app_users(id),
  p256dh       text not null,
  auth         text not null,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz
);
alter table staff_push_subscriptions enable row level security;   -- server code only

create or replace function staff_push_subscribe(p_endpoint text, p_p256dh text, p_auth text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_active_user() then raise exception 'USER_INACTIVE' using errcode = '42501'; end if;
  perform require_perm('orders.queue');
  if coalesce(p_endpoint, '') = '' or coalesce(p_p256dh, '') = '' or coalesce(p_auth, '') = '' then raise exception 'PUSH_INVALID'; end if;
  -- one tablet can be used by several people: the endpoint follows whoever signed in last
  insert into staff_push_subscriptions (endpoint, user_id, p256dh, auth) values (p_endpoint, auth.uid(), p_p256dh, p_auth)
  on conflict (endpoint) do update set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth;
end $$;
revoke execute on function staff_push_subscribe(text, text, text) from public, anon;
grant execute on function staff_push_subscribe(text, text, text) to authenticated;

-- who gets "new order" pushes (role codes); default: the cafeteria role
insert into app_settings (key, value) values ('new_order_push_roles', '["BARISTA"]') on conflict (key) do nothing;

-- targets for the Edge Function (read with the service role)
create or replace view v_staff_push_targets as
select s.endpoint, s.p256dh, s.auth, r.code as role_code
  from staff_push_subscriptions s
  join app_users u on u.id = s.user_id and u.active
  join roles r on r.id = u.role_id
 where r.code in (select jsonb_array_elements_text(coalesce((select value from app_settings where key = 'new_order_push_roles'), '["BARISTA"]')));
revoke all on v_staff_push_targets from anon, authenticated;

-- ---------- new app order → push to the buffet ----------
-- self_create_order marks the order as SELF right after creating it, so we watch that change.
create or replace function notify_new_self_order() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare v_url text; v_secret text;
begin
  if new.source <> 'SELF' or old.source = 'SELF' then return new; end if;
  select value into v_url from private_config where key = 'push_url';
  select value into v_secret from private_config where key = 'push_secret';
  begin
    perform net.http_post(
      url := v_url,
      body := jsonb_build_object('order_id', new.id, 'status', 'NEW_SELF'),
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-push-secret', v_secret));
  exception when others then null;
  end;
  return new;
end $$;

drop trigger if exists orders_new_self_push on orders;
create trigger orders_new_self_push after update of source on orders
  for each row execute function notify_new_self_order();
