-- =====================================================================
--  018_self_order.sql — employees order from their phone (app).
--   * Each phone signs in anonymously and is tied to one person (name + code),
--     with its IP and user-agent. A phone switching to someone else is flagged.
--   * Orders from the app always go through preparation: NEW → PREPARING → SERVED,
--     so the employee sees "N orders before you" and is told when theirs starts.
--   * Payment: on the account, or cash paid to the buffet on delivery.
--  Before running: Supabase → Authentication → Sign In / Providers →
--  enable "Allow anonymous sign-ins".   Run once after 017.
-- =====================================================================
set search_path = public, extensions;

-- ---------- orders: where they came from ----------
alter table orders add column if not exists source text not null default 'STAFF' check (source in ('STAFF','SELF'));
alter table orders add column if not exists pay_request text check (pay_request in ('ACCOUNT','CASH'));
alter table orders add column if not exists device_uid uuid;
alter table orders add column if not exists cash_collected_at timestamptz;

-- ---------- devices ----------
create table if not exists self_devices (
  device_uid    uuid primary key,                 -- the phone's anonymous auth user
  customer_id   bigint not null references customers(id),
  first_ip      text, last_ip text,
  user_agent    text,
  first_seen    timestamptz not null default now(),
  last_seen     timestamptz not null default now(),
  blocked       boolean not null default false,
  orders_count  int not null default 0
);
create index if not exists self_devices_customer_idx on self_devices (customer_id);

create table if not exists self_device_events (
  id           bigint generated always as identity primary key,
  device_uid   uuid,
  customer_id  bigint references customers(id),
  event        text not null check (event in ('REGISTER','NEW_DEVICE','SWITCH','REJECTED','BLOCKED_ATTEMPT')),
  typed_name   text, typed_code text,
  ip           text, user_agent text,
  details      text,
  reviewed     boolean not null default false,
  created_at   timestamptz not null default now()
);
create index if not exists self_device_events_time_idx on self_device_events (created_at desc);

alter table self_devices enable row level security;
alter table self_device_events enable row level security;
drop policy if exists self_devices_read on self_devices;
create policy self_devices_read on self_devices for select to authenticated using (has_perm('customers.manage') or has_perm('users.manage'));
drop policy if exists self_device_events_read on self_device_events;
create policy self_device_events_read on self_device_events for select to authenticated using (has_perm('customers.manage') or has_perm('users.manage'));

-- caller IP as seen by Supabase (company network or mobile carrier)
create or replace function _req_ip() returns text language sql stable as $$
  select nullif(trim(split_part(coalesce(
           current_setting('request.headers', true)::json->>'cf-connecting-ip',
           current_setting('request.headers', true)::json->>'x-forwarded-for',
           current_setting('request.headers', true)::json->>'x-real-ip', ''), ',', 1)), '');
$$;

-- loose Arabic/English name match: first word of the typed name must appear in the stored name
create or replace function _norm_name(t text) returns text language sql immutable as $$
  select regexp_replace(translate(lower(coalesce(t, '')), 'أإآىةؤئ', 'اااياوي'), '\s+', ' ', 'g');
$$;

-- ---------- register this phone ----------
create or replace function self_register(p_code text, p_name text, p_user_agent text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_ip text := _req_ip(); c customers; d self_devices;
        v_code text := trim(translate(coalesce(p_code, ''), '٠١٢٣٤٥٦٧٨٩', '0123456789'));
        v_first text;
begin
  if v_uid is null then raise exception 'SELF_NO_SESSION'; end if;
  if coalesce(v_code, '') = '' or coalesce(trim(p_name), '') = '' then raise exception 'SELF_CODE_NAME_REQUIRED'; end if;
  select * into c from customers where lower(code) = lower(v_code) and customer_type <> 'DEPARTMENT';
  v_first := split_part(_norm_name(trim(p_name)), ' ', 1);
  if not found or c.status <> 'ACTIVE' or length(v_first) < 2 or position(v_first in _norm_name(c.full_name)) = 0 then
    insert into self_device_events (device_uid, customer_id, event, typed_name, typed_code, ip, user_agent, details)
    values (v_uid, c.id, 'REJECTED', p_name, v_code, v_ip, left(p_user_agent, 300),
            case when c.id is null then 'code not found' when c.status <> 'ACTIVE' then 'person not active' else 'name does not match' end);
    return jsonb_build_object('error', 'SELF_NOT_MATCHED');        -- returned (not raised) so the attempt stays logged
  end if;

  select * into d from self_devices where device_uid = v_uid for update;
  if found then
    if d.blocked then
      insert into self_device_events (device_uid, customer_id, event, typed_name, typed_code, ip, user_agent)
      values (v_uid, c.id, 'BLOCKED_ATTEMPT', p_name, v_code, v_ip, left(p_user_agent, 300));
      return jsonb_build_object('error', 'SELF_DEVICE_BLOCKED');
    end if;
    if d.customer_id <> c.id then
      -- same phone, different person → keep the history and flag it
      insert into self_device_events (device_uid, customer_id, event, typed_name, typed_code, ip, user_agent, details)
      values (v_uid, c.id, 'SWITCH', p_name, v_code, v_ip, left(p_user_agent, 300), 'previous customer_id=' || d.customer_id);
    end if;
    update self_devices set customer_id = c.id, last_ip = v_ip, user_agent = left(p_user_agent, 300), last_seen = now() where device_uid = v_uid;
  else
    insert into self_devices (device_uid, customer_id, first_ip, last_ip, user_agent) values (v_uid, c.id, v_ip, v_ip, left(p_user_agent, 300));
    insert into self_device_events (device_uid, customer_id, event, typed_name, typed_code, ip, user_agent, details)
    values (v_uid, c.id,
            case when exists (select 1 from self_devices x where x.customer_id = c.id and x.device_uid <> v_uid) then 'NEW_DEVICE' else 'REGISTER' end,
            p_name, v_code, v_ip, left(p_user_agent, 300), null);
  end if;
  return self_me();
end $$;

create or replace function _self_customer() returns bigint language plpgsql stable security definer set search_path = public as $$
declare d self_devices;
begin
  select * into d from self_devices where device_uid = auth.uid();
  if not found then raise exception 'SELF_NOT_REGISTERED'; end if;
  if d.blocked then raise exception 'SELF_DEVICE_BLOCKED'; end if;
  return d.customer_id;
end $$;

-- ---------- what the employee sees ----------
create or replace function self_me() returns jsonb language plpgsql security definer set search_path = public as $$
declare v_cid bigint := _self_customer(); d date := business_today();
begin
  update self_devices set last_seen = now(), last_ip = coalesce(_req_ip(), last_ip) where device_uid = auth.uid();
  return jsonb_build_object(
    'person', (select jsonb_build_object('id', c.id, 'code', c.code, 'full_name', c.full_name, 'type', c.customer_type,
                                         'department_ar', dp.name_ar, 'company', c.company, 'status', c.status, 'balance', a.balance)
                 from customers c join customer_accounts a on a.customer_id = c.id left join departments dp on dp.id = c.department_id
                where c.id = v_cid),
    'orders', (select coalesce(jsonb_agg(jsonb_build_object(
                  'id', o.id, 'order_no', o.order_no, 'status', o.fulfillment_status, 'payment_status', o.payment_status,
                  'pay_request', o.pay_request, 'source', o.source, 'total', o.total, 'created_at', o.created_at,
                  'items', (select string_agg(i.qty || '× ' || i.product_name_ar_snap ||
                                   case when coalesce(i.variant_name_en_snap, '') <> 'Regular' then ' ' || i.variant_name_ar_snap else '' end, '، ' order by i.id)
                              from order_items i where i.order_id = o.id),
                  'ahead', case when o.fulfillment_status in ('NEW','PREPARING') then
                             (select count(*) from orders q where q.business_date = o.business_date and q.id < o.id
                                 and q.fulfillment_status in ('NEW','PREPARING')) end)
                  order by o.id desc), '[]')
                 from orders o where o.consumer_id = v_cid and o.business_date >= d - 1
                  and (o.business_date = d or o.fulfillment_status in ('NEW','PREPARING','READY'))),
    'self_enabled', coalesce((select value::text from app_settings where key = 'self_order_enabled'), 'true') <> 'false');
end $$;

create or replace function self_menu() returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform _self_customer();
  return jsonb_build_object(
    'categories', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name_ar', name_ar) order by sort, id), '[]') from product_categories where active),
    'products', (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'category_id', p.category_id, 'name_ar', p.name_ar,
                    'variants', (select jsonb_agg(jsonb_build_object('id', v.id, 'name_ar', v.name_ar, 'name_en', v.name_en, 'price', v.price) order by v.sort, v.id)
                                   from product_variants v where v.product_id = p.id and v.active and not v.open_price)) order by p.sort, p.id), '[]')
                   from products p where p.active and exists (select 1 from product_variants v where v.product_id = p.id and v.active and not v.open_price)),
    'addons', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name_ar', name_ar, 'price', price) order by sort), '[]') from addons where active),
    'variant_addons', (select coalesce(jsonb_agg(jsonb_build_object('variant_id', variant_id, 'addon_id', addon_id)), '[]') from variant_addons));
end $$;

-- ---------- order from the app ----------
create or replace function self_create_order(p_items jsonb, p_pay text default 'ACCOUNT', p_notes text default null,
                                             p_idempotency_key uuid default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_cid bigint := _self_customer(); v_pay text := upper(coalesce(p_pay, 'ACCOUNT')); res jsonb;
begin
  if coalesce((select value::text from app_settings where key = 'self_order_enabled'), 'true') = 'false' then
    raise exception 'SELF_ORDERING_OFF';
  end if;
  if v_pay not in ('ACCOUNT','CASH') then raise exception 'SELF_PAY_INVALID'; end if;
  if exists (select 1 from jsonb_array_elements(coalesce(p_items, '[]')) e
              join product_variants v on v.id = (e->>'variant_id')::bigint where v.open_price) then
    raise exception 'SELF_ITEM_NOT_ALLOWED';
  end if;
  if (select count(*) from orders where consumer_id = v_cid and source = 'SELF'
        and fulfillment_status in ('NEW','PREPARING','READY')) >= 3 then
    raise exception 'SELF_TOO_MANY_OPEN';
  end if;
  perform set_config('app.self_order', '1', true);        -- lets create_order run for this one call
  res := create_order(p_items, v_cid, null, 0, p_notes, p_idempotency_key, false, v_cid);
  perform set_config('app.self_order', '', true);
  update orders set source = 'SELF', pay_request = v_pay, device_uid = auth.uid()
   where id = (res->>'order_id')::bigint and source = 'STAFF';
  update self_devices set orders_count = orders_count + 1, last_seen = now() where device_uid = auth.uid();
  return res || jsonb_build_object('pay_request', v_pay);
end $$;

-- ---------- buffet: cash handed over on delivery ----------
create or replace function self_cash_served(p_order_id bigint) returns jsonb
language plpgsql security definer set search_path = public as $$
declare o orders; v_amt numeric := 0;
begin
  perform require_perm('orders.update_status');
  select * into o from orders where id = p_order_id for update;
  if not found then raise exception 'ORDER_NOT_FOUND'; end if;
  -- the employee hands the full price in cash: it goes into their account (settling this order,
  -- or giving back the balance it used), once only
  if o.pay_request = 'CASH' and o.cash_collected_at is null and o.customer_id is not null and o.total > 0 then
    v_amt := o.total;
    perform deposit(o.customer_id, v_amt, 'كاش عند التسليم ' || o.order_no);
    update orders set cash_collected_at = now() where id = p_order_id;
  end if;
  if o.fulfillment_status not in ('SERVED','CANCELLED') then perform set_order_status(p_order_id, 'SERVED'); end if;
  return jsonb_build_object('order_id', p_order_id, 'cash', v_amt);
end $$;

-- ---------- admin: devices ----------
create or replace view v_self_devices with (security_invoker = true) as
select d.device_uid, d.customer_id, c.code, c.full_name, dp.name_ar as department_ar, d.first_ip, d.last_ip, d.user_agent,
       d.first_seen, d.last_seen, d.blocked, d.orders_count,
       (select count(*) from self_device_events e where e.device_uid = d.device_uid and e.event in ('SWITCH','REJECTED','BLOCKED_ATTEMPT')) as flags
  from self_devices d join customers c on c.id = d.customer_id left join departments dp on dp.id = c.department_id;

create or replace view v_self_device_events with (security_invoker = true) as
select e.*, c.code as customer_code, c.full_name as customer_name
  from self_device_events e left join customers c on c.id = e.customer_id;

create or replace function set_device_blocked(p_device uuid, p_blocked boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not (has_perm('customers.manage') or has_perm('users.manage')) then raise exception 'PERMISSION_DENIED:customers.manage' using errcode = '42501'; end if;
  update self_devices set blocked = p_blocked where device_uid = p_device;
  perform log_audit(case when p_blocked then 'DEVICE_BLOCK' else 'DEVICE_UNBLOCK' end, 'self_devices', p_device::text);
end $$;

create or replace function mark_device_events_reviewed() returns void
language plpgsql security definer set search_path = public as $$
begin
  if not (has_perm('customers.manage') or has_perm('users.manage')) then raise exception 'PERMISSION_DENIED:customers.manage' using errcode = '42501'; end if;
  update self_device_events set reviewed = true where not reviewed;
end $$;

insert into app_settings (key, value) values ('self_order_enabled', 'true') on conflict (key) do nothing;

-- v_orders again so it carries the new order columns (source, pay_request, cash_collected_at)
drop view if exists v_orders;
create view v_orders with (security_invoker = true) as
select o.*, o.total - o.paid_amount as due,
       c.code as customer_code, c.full_name as customer_name,
       uc.full_name as created_by_name, us.full_name as served_by_name, up.full_name as paid_by_name,
       ux.full_name as cancelled_by_name,
       (select coalesce(sum(qty), 0) from order_items i where i.order_id = o.id) as items_qty,
       cn.code as consumer_code, cn.full_name as consumer_name, cn.customer_type as consumer_type,
       cn.company as consumer_company, c.customer_type as customer_type
  from orders o
  left join customers c on c.id = o.customer_id
  left join customers cn on cn.id = o.consumer_id
  left join v_user_names uc on uc.id = o.created_by
  left join v_user_names us on us.id = o.served_by
  left join v_user_names up on up.id = o.paid_by
  left join v_user_names ux on ux.id = o.cancelled_by;



-- ---------- create_order: allow the app path ----------
drop function if exists create_order(jsonb, bigint, text, numeric, text, uuid, boolean, bigint);
create or replace function create_order(p_items jsonb, p_customer_id bigint default null,
                                        p_guest_name text default null, p_cash numeric default 0,
                                        p_notes text default null, p_idempotency_key uuid default null,
                                        p_extra_to_account boolean default false,
                                        p_consumer_id bigint default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_existing orders; v_loc bigint; v_order bigint; v_no text; it record; v jsonb;
  pv product_variants; p products; v_recipe bigint; v_addons_total numeric; v_unit_cost numeric;
  v_line numeric; v_total numeric := 0; v_cost numeric := 0; v_item bigint; ad record;
  m record; a customer_accounts; v_cash numeric; v_rest numeric; v_limit numeric;
  v_txn bigint; v_bal_before numeric; v_cover numeric; v_pay bigint; v_mats bigint[] := '{}';
  v_bal_after numeric; v_extra numeric := 0; v_price numeric; v_vname_ar text; v_vname_en text; v_machine numeric := 0; v_dep_txn bigint; v_dep_no text; v_settled int := 0;
begin
  -- staff with the POS permission, or an employee ordering from the app (flag set by self_create_order only)
  if not (has_perm('pos.create_order') or coalesce(current_setting('app.self_order', true), '') = '1') then
    raise exception 'PERMISSION_DENIED:pos.create_order' using errcode = '42501';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'ITEMS_REQUIRED';
  end if;

  if p_idempotency_key is not null then
    select * into v_existing from orders where idempotency_key = p_idempotency_key;
    if found then
      return jsonb_build_object('order_id', v_existing.id, 'order_no', v_existing.order_no,
                                'total', v_existing.total, 'paid', v_existing.paid_amount,
                                'duplicate', true, 'warnings', '[]'::jsonb);
    end if;
  end if;

  if p_customer_id is not null then a := _active_account(p_customer_id); end if;
  -- who drank it (the payer can be their department, a host employee, or cash)
  if p_consumer_id is not null and not exists (select 1 from customers where id = p_consumer_id and status = 'ACTIVE') then
    raise exception 'CUSTOMER_INACTIVE';
  end if;

  select id into v_loc from stock_locations where is_consumption and active;
  if v_loc is null then raise exception 'NO_CONSUMPTION_LOCATION'; end if;

  v_no := next_doc_no('ORDER');
  insert into orders (order_no, customer_id, consumer_id, guest_name, location_id, notes, idempotency_key)
  values (v_no, p_customer_id, coalesce(p_consumer_id, p_customer_id),
          case when p_customer_id is null and p_consumer_id is null then nullif(trim(p_guest_name), '') end,
          v_loc, p_notes, p_idempotency_key)
  returning id into v_order;

  for v in select * from jsonb_array_elements(p_items) loop
    if coalesce((v->>'qty')::int, 0) <= 0 then raise exception 'QTY_INVALID'; end if;
    select * into pv from product_variants where id = (v->>'variant_id')::bigint;
    if not found or not pv.active then raise exception 'VARIANT_NOT_AVAILABLE:%', v->>'variant_id'; end if;
    select * into p from products where id = pv.product_id;
    if not p.active then raise exception 'VARIANT_NOT_AVAILABLE:%', pv.code; end if;
    select id into v_recipe from recipes where variant_id = pv.id and is_current;
    v_price := pv.price; v_vname_ar := pv.name_ar; v_vname_en := pv.name_en;
    if pv.open_price then
      -- bought from the coffee machine with buffet cash: price and name typed at the counter, no stock
      v_price := round(coalesce((v->>'price')::numeric, 0), 2);
      if v_price <= 0 or v_price > 1000 then raise exception 'PRICE_INVALID'; end if;
      v_vname_ar := coalesce(nullif(trim(v->>'name'), ''), pv.name_ar);
      v_vname_en := coalesce(nullif(trim(v->>'name'), ''), pv.name_en);
      v_recipe := null;
      if jsonb_array_length(coalesce(v->'addons', '[]')) > 0 then raise exception 'ADDON_NOT_ALLOWED:%', pv.code; end if;
    end if;

    -- add-ons (must be active and allowed for this variant)
    select coalesce(sum(ad2.price), 0) into v_addons_total
      from addons ad2
     where ad2.id in (select (x)::bigint from jsonb_array_elements_text(coalesce(v->'addons', '[]')) x);
    if exists (select 1 from jsonb_array_elements_text(coalesce(v->'addons', '[]')) x
                where not exists (select 1 from addons ad3 join variant_addons va on va.addon_id = ad3.id
                                   where ad3.id = (x)::bigint and ad3.active and va.variant_id = pv.id)) then
      raise exception 'ADDON_NOT_ALLOWED:%', pv.code;
    end if;

    -- material need per unit: recipe + add-ons, floored at zero
    v_unit_cost := 0;
    for m in
      select mat.id as material_id, mat.track_stock, mat.avg_cost, greatest(sum(x.qty_base), 0) as per_unit
        from (
          select ri.material_id, to_base_qty(ri.material_id, ri.unit_id, ri.quantity) as qty_base
            from recipe_items ri where ri.recipe_id = v_recipe
          union all
          select ari.material_id,
                 sign(ari.quantity) * to_base_qty(ari.material_id, ari.unit_id, abs(ari.quantity))
            from addon_recipe_items ari
           where ari.addon_id in (select (x)::bigint from jsonb_array_elements_text(coalesce(v->'addons', '[]')) x)
        ) x join materials mat on mat.id = x.material_id
       group by mat.id
    loop
      if m.track_stock and m.per_unit > 0 then
        perform _inv_move(m.material_id, v_loc, 'CONSUMPTION', -(m.per_unit * (v->>'qty')::int), null, null,
                          m.avg_cost, 'ORDER', v_order);
        v_unit_cost := v_unit_cost + m.per_unit * m.avg_cost;
        v_mats := v_mats || m.material_id;
      end if;
    end loop;

    v_line := (v->>'qty')::int * (v_price + v_addons_total);
    if pv.open_price then v_machine := v_machine + v_line; end if;
    insert into order_items (order_id, variant_id, product_name_ar_snap, product_name_en_snap,
                             variant_name_ar_snap, variant_name_en_snap, qty, unit_price, addons_total,
                             line_total, recipe_id, unit_cost_snap, notes)
    values (v_order, pv.id, p.name_ar, p.name_en, v_vname_ar, v_vname_en, (v->>'qty')::int, v_price,
            v_addons_total, v_line, v_recipe, round(v_unit_cost, 4), nullif(trim(v->>'notes'), ''))
    returning id into v_item;

    insert into order_item_addons (order_item_id, addon_id, name_ar_snap, name_en_snap, price_snap)
    select v_item, ad4.id, ad4.name_ar, ad4.name_en, ad4.price
      from addons ad4
     where ad4.id in (select (x)::bigint from jsonb_array_elements_text(coalesce(v->'addons', '[]')) x);

    v_total := v_total + v_line;
    v_cost := v_cost + v_unit_cost * (v->>'qty')::int;
  end loop;

  update orders set subtotal = v_total, total = v_total, material_cost = round(v_cost, 4) where id = v_order;

  -- payment
  -- cash above the total: change handed back, or (customer + p_extra_to_account) deposited to the wallet
  if p_customer_id is not null and coalesce(p_extra_to_account, false) then
    v_extra := greatest(coalesce(p_cash, 0) - v_total, 0);
  end if;
  v_cash := least(greatest(coalesce(p_cash, 0), 0), v_total);
  v_rest := v_total - v_cash;
  if p_customer_id is null and v_rest > 0 then raise exception 'CASH_REQUIRED:%', v_total; end if;
  if v_cash > 0 then perform require_perm('payments.receive'); end if;   -- single cashier

  if v_cash > 0 then
    insert into payments (receipt_no, customer_id, direction, purpose, amount, notes)
    values (next_doc_no('PAYMENT'), p_customer_id, 'IN', 'ORDER', v_cash, v_no)
    returning id into v_pay;
    insert into order_payments (order_id, method, amount, payment_id) values (v_order, 'CASH', v_cash, v_pay);
  end if;

  if v_rest > 0 then
    v_bal_before := a.balance;
    v_limit := _credit_limit(p_customer_id);
    if v_limit is not null and v_bal_before - v_rest < -v_limit and not has_perm('accounts.credit_override') then
      raise exception 'CREDIT_LIMIT_EXCEEDED:%', v_limit;
    end if;
    insert into account_transactions (account_id, txn_type, debit, reference_type, reference_id, notes)
    values (a.id, 'ORDER_CHARGE', v_rest, 'ORDER', v_order, v_no)
    returning id, balance_after into v_txn, v_bal_after;
    v_cover := least(v_rest, greatest(v_bal_before, 0));
    if v_cover > 0 then
      insert into order_payments (order_id, method, amount, account_txn_id)
      values (v_order, 'ACCOUNT', v_cover, v_txn);
    end if;
  elsif p_customer_id is not null then
    v_bal_after := a.balance;
  end if;

  if v_total = 0 then update orders set payment_status = 'PAID', paid_at = now(), paid_by = auth.uid() where id = v_order; end if;

  -- the machine was paid from the buffet's cash: record the cash that left the drawer
  if v_machine > 0 then
    insert into payments (receipt_no, customer_id, direction, purpose, amount, notes)
    values (next_doc_no('PAYMENT'), null, 'OUT', 'MACHINE', v_machine, v_no);
  end if;

  -- extra cash → wallet deposit; it settles older unpaid orders first (oldest first)
  if v_extra > 0 then
    perform require_perm('accounts.deposit');
    insert into account_transactions (account_id, txn_type, credit, reference_type, notes)
    values (a.id, 'DEPOSIT', v_extra, 'PAYMENT', v_no)
    returning id, balance_after into v_dep_txn, v_bal_after;
    v_dep_no := next_doc_no('PAYMENT');
    insert into payments (receipt_no, customer_id, direction, purpose, amount, account_txn_id, notes)
    values (v_dep_no, p_customer_id, 'IN', 'DEPOSIT', v_extra, v_dep_txn, v_no);
    v_settled := _auto_settle(p_customer_id, v_dep_txn, v_extra);
  end if;

  perform log_audit('CREATE_ORDER', 'orders', v_order::text, null,
                    jsonb_build_object('order_no', v_no, 'total', v_total, 'cash', v_cash, 'account', v_rest,
                                       'deposit', v_extra, 'deposit_receipt', v_dep_no, 'machine', v_machine));
  return jsonb_build_object('order_id', v_order, 'order_no', v_no, 'total', v_total,
                            'cash', v_cash, 'account', v_rest,
                            'deposit', v_extra, 'deposit_receipt', v_dep_no, 'settled_orders', v_settled, 'machine', v_machine,
                            'paid', (select paid_amount from orders where id = v_order),
                            'balance', v_bal_after,
                            'warnings', _negative_warnings(v_loc, v_mats));
end $$;





revoke execute on function create_order(jsonb, bigint, text, numeric, text, uuid, boolean, bigint) from public, anon;
grant execute on function create_order(jsonb, bigint, text, numeric, text, uuid, boolean, bigint) to authenticated;

revoke execute on function _req_ip(), _self_customer(), self_register(text, text, text), self_me(), self_menu(),
  self_create_order(jsonb, text, text, uuid), self_cash_served(bigint), set_device_blocked(uuid, boolean),
  mark_device_events_reviewed() from public, anon;
grant execute on function self_register(text, text, text), self_me(), self_menu(), self_create_order(jsonb, text, text, uuid),
  self_cash_served(bigint), set_device_blocked(uuid, boolean), mark_device_events_reviewed() to authenticated;
grant select on v_self_devices, v_self_device_events to authenticated;
