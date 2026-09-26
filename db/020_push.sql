-- =====================================================================
--  020_push.sql — real push notifications for the employee app
--  (they arrive even when the app is closed).
--   * The phone subscribes to push; the subscription is stored here.
--   * When an app order moves to "preparing" / "ready" / "cancelled",
--     the database calls the Edge Function "send-push" (pg_net), which
--     sends the notification.
--  Before running: Database → Extensions → enable "pg_net".
--  Run once after 019. The last SELECT shows the PUSH_SECRET to copy
--  into the Edge Function secrets.
-- =====================================================================
set search_path = public, extensions;

create extension if not exists pg_net;

-- ---------- subscriptions ----------
create table if not exists self_push_subscriptions (
  endpoint     text primary key,
  device_uid   uuid not null,
  customer_id  bigint not null references customers(id),
  p256dh       text not null,
  auth         text not null,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz
);
create index if not exists self_push_customer_idx on self_push_subscriptions (customer_id);
alter table self_push_subscriptions enable row level security;   -- no policies: only server code reads it

-- ---------- private config (never readable from the apps) ----------
create table if not exists private_config (key text primary key, value text not null);
alter table private_config enable row level security;
revoke all on private_config from anon, authenticated;
insert into private_config (key, value) values
  ('push_url', 'https://zbvfggvwoatnznqcbxff.supabase.co/functions/v1/send-push'),
  ('push_secret', replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''))
on conflict (key) do nothing;

-- public VAPID key (safe to share; the private key lives only in the Edge Function secrets)
insert into app_settings (key, value) values ('vapid_public_key', to_jsonb('BE_VuH5rhkLOifYRDIR_cE5pxnkpPqiAYkiW-1_l5sciBVx4wgBRegFd7Iw5YX2iv8iaF12AkJ0_s7Bu62nGn2Q'::text))
on conflict (key) do update set value = excluded.value;

-- ---------- the phone registers its push subscription ----------
create or replace function self_push_subscribe(p_endpoint text, p_p256dh text, p_auth text)
returns void language plpgsql security definer set search_path = public as $$
declare v_cid bigint := _self_customer();
begin
  if coalesce(p_endpoint, '') = '' or coalesce(p_p256dh, '') = '' or coalesce(p_auth, '') = '' then raise exception 'PUSH_INVALID'; end if;
  insert into self_push_subscriptions (endpoint, device_uid, customer_id, p256dh, auth)
  values (p_endpoint, auth.uid(), v_cid, p_p256dh, p_auth)
  on conflict (endpoint) do update set device_uid = excluded.device_uid, customer_id = excluded.customer_id,
                                      p256dh = excluded.p256dh, auth = excluded.auth;
end $$;
revoke execute on function self_push_subscribe(text, text, text) from public, anon;
grant execute on function self_push_subscribe(text, text, text) to authenticated;

-- self_me also hands the app the public key
create or replace function self_vapid_key() returns text language sql stable security definer set search_path = public as $$
  select value #>> '{}' from app_settings where key = 'vapid_public_key';
$$;
grant execute on function self_vapid_key() to authenticated;

-- ---------- order status → push ----------
create or replace function notify_order_push() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare v_url text; v_secret text;
begin
  if new.source <> 'SELF' or new.fulfillment_status is not distinct from old.fulfillment_status
     or new.fulfillment_status not in ('PREPARING','READY','CANCELLED') then
    return new;
  end if;
  select value into v_url from private_config where key = 'push_url';
  select value into v_secret from private_config where key = 'push_secret';
  begin
    -- asynchronous HTTP call: never slows down or blocks the status change
    perform net.http_post(
      url := v_url,
      body := jsonb_build_object('order_id', new.id, 'status', new.fulfillment_status),
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-push-secret', v_secret));
  exception when others then
    null;   -- a push problem must never stop the buffet
  end;
  return new;
end $$;

drop trigger if exists orders_push on orders;
create trigger orders_push after update of fulfillment_status on orders
  for each row execute function notify_order_push();

-- copy this value into the Edge Function secret PUSH_SECRET
select value as push_secret_copy_this from private_config where key = 'push_secret';
