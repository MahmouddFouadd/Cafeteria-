-- =====================================================================
--  016_machine_cash.sql — coffee-machine drinks + two cash drawers.
--   * A drink bought from the coffee machine is sold at the price typed at the
--     counter, charged like any drink, and its cost leaves the buffet's cash.
--   * Every cash movement belongs to a drawer: BUFFET (cafeteria staff) or RECEPTION.
--   * Handover: reception receives the buffet's cash (moves between drawers).
--  Run once after 015.
-- =====================================================================
set search_path = public, extensions;

-- ---------- open-price product for the machine ----------
alter table product_variants add column if not exists open_price boolean not null default false;

insert into product_categories (name_ar, name_en, sort)
select 'ماكينة القهوة', 'Coffee machine', 90
 where not exists (select 1 from product_categories where name_en = 'Coffee machine');

insert into products (code, category_id, name_ar, name_en, sort)
select 'MACHINE', (select id from product_categories where name_en = 'Coffee machine'), 'من ماكينة القهوة', 'From the coffee machine', 999
 where not exists (select 1 from products where code = 'MACHINE');

insert into product_variants (code, product_id, name_ar, name_en, price, sort, active, open_price)
select 'MACHINE', (select id from products where code = 'MACHINE'), 'مشروب من الماكينة', 'Machine drink', 0, 1, true, true
 where not exists (select 1 from product_variants where code = 'MACHINE');

-- ---------- drawers and new cash purposes ----------
alter table payments drop constraint if exists payments_purpose_check;
alter table payments add constraint payments_purpose_check
  check (purpose in ('ORDER','DEPOSIT','REFUND','MACHINE','HANDOVER'));
alter table payments add column if not exists drawer text check (drawer in ('BUFFET','RECEPTION'));

create or replace function set_payment_drawer() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.drawer is null then
    select case when r.code = 'BARISTA' then 'BUFFET' else 'RECEPTION' end into new.drawer
      from app_users u join roles r on r.id = u.role_id where u.id = coalesce(new.created_by, auth.uid());
    new.drawer := coalesce(new.drawer, 'RECEPTION');
  end if;
  return new;
end $$;
drop trigger if exists payments_drawer on payments;
create trigger payments_drawer before insert on payments for each row execute function set_payment_drawer();

-- existing rows (the table is append-only, so the guard is lifted for this one backfill)
alter table payments disable trigger payments_immutable;
update payments p set drawer = case when r.code = 'BARISTA' then 'BUFFET' else 'RECEPTION' end
  from app_users u join roles r on r.id = u.role_id
 where u.id = p.created_by and p.drawer is null;
update payments set drawer = 'RECEPTION' where drawer is null;
alter table payments enable trigger payments_immutable;
alter table payments alter column drawer set not null;

-- ---------- handover between drawers ----------
-- p_to = 'RECEPTION': the buffet hands its cash to reception (end of shift)
-- p_to = 'BUFFET'   : reception gives the buffet change / float for the machine
create or replace function cash_handover(p_amount numeric, p_notes text default null, p_to text default 'RECEPTION')
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_amt numeric := round(coalesce(p_amount, 0), 2); v_no text;
        v_to text := upper(coalesce(p_to, 'RECEPTION')); v_from text;
begin
  perform require_perm('closing.perform');
  if v_amt <= 0 then raise exception 'AMOUNT_INVALID'; end if;
  if v_to not in ('RECEPTION','BUFFET') then raise exception 'DRAWER_INVALID'; end if;
  v_from := case v_to when 'RECEPTION' then 'BUFFET' else 'RECEPTION' end;
  v_no := next_doc_no('PAYMENT');
  insert into payments (receipt_no, direction, purpose, amount, drawer, notes)
  values (v_no, 'OUT', 'HANDOVER', v_amt, v_from, nullif(trim(p_notes), ''));
  insert into payments (receipt_no, direction, purpose, amount, drawer, notes)
  values (next_doc_no('PAYMENT'), 'IN', 'HANDOVER', v_amt, v_to, v_no);
  perform log_audit('CASH_HANDOVER', 'payments', v_no, null, jsonb_build_object('amount', v_amt, 'to', v_to), p_notes);
  return closing_preview(business_today());
end $$;
revoke execute on function cash_handover(numeric, text, text) from public, anon;
grant execute on function cash_handover(numeric, text, text) to authenticated;

-- ---------- closing preview: per drawer, machine, handover ----------
create or replace function closing_preview(p_date date default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare d date := coalesce(p_date, business_today()); c daily_closings;
        v_sales numeric; v_dep numeric; v_ref numeric; v_mach numeric; v_open numeric; v_in numeric; v_out numeric;
        b_in numeric; b_out numeric; r_in numeric; r_out numeric; v_hand numeric;
begin
  perform require_perm('closing.perform');
  select * into c from daily_closings where business_date = d;
  v_open := coalesce(c.opening_cash, 0);
  select coalesce(sum(amount) filter (where direction = 'IN' and purpose = 'ORDER'), 0),
         coalesce(sum(amount) filter (where direction = 'IN' and purpose = 'DEPOSIT'), 0),
         coalesce(sum(amount) filter (where direction = 'OUT' and purpose = 'REFUND'), 0),
         coalesce(sum(amount) filter (where direction = 'OUT' and purpose = 'MACHINE'), 0),
         coalesce(sum(amount) filter (where direction = 'IN'), 0),
         coalesce(sum(amount) filter (where direction = 'OUT'), 0),
         coalesce(sum(amount) filter (where drawer = 'BUFFET' and direction = 'IN'), 0),
         coalesce(sum(amount) filter (where drawer = 'BUFFET' and direction = 'OUT'), 0),
         coalesce(sum(amount) filter (where drawer = 'RECEPTION' and direction = 'IN'), 0),
         coalesce(sum(amount) filter (where drawer = 'RECEPTION' and direction = 'OUT'), 0),
         coalesce(sum(amount) filter (where purpose = 'HANDOVER' and direction = 'IN' and drawer = 'RECEPTION'), 0)
    into v_sales, v_dep, v_ref, v_mach, v_in, v_out, b_in, b_out, r_in, r_out, v_hand
    from payments where business_date = d and method = 'CASH';
  return jsonb_build_object(
    'business_date', d, 'status', coalesce(c.status, 'NOT_OPENED'),
    'opening_cash', v_open, 'cash_sales', v_sales, 'deposits_cash', v_dep, 'refunds_cash', v_ref,
    'machine_cash', v_mach, 'handover_cash', v_hand,
    'expected_cash', v_open + v_in - v_out,
    'buffet_cash', b_in - b_out,                       -- what should still be upstairs
    'reception_cash', v_open + r_in - r_out,           -- what should be in the reception drawer
    'actual_cash', c.actual_cash, 'difference', c.difference,
    'orders_count', (select count(*) from orders where business_date = d and fulfillment_status <> 'CANCELLED'),
    'orders_total', (select coalesce(sum(total), 0) from orders where business_date = d and fulfillment_status <> 'CANCELLED'),
    'account_sales', (select coalesce(sum(debit), 0) - coalesce(sum(credit), 0) from account_transactions
                       where business_date = d and reference_type = 'ORDER'),
    'cancelled_count', (select count(*) from orders where business_date = d and fulfillment_status = 'CANCELLED'),
    'unclosed_before', (select min(business_date) from daily_closings where business_date < d and status <> 'CLOSED'));
end $$;

-- ---------- create_order: machine items ----------
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
  perform require_perm('pos.create_order');
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




-- ---------- dashboard & reports: machine is not a refund ----------
create or replace function dashboard_summary(p_date date default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  d date := coalesce(p_date, business_today());
  res jsonb := jsonb_build_object('business_date', d);
  c daily_closings;
begin
  if not is_active_user() then raise exception 'USER_INACTIVE' using errcode = '42501'; end if;

  -- ---------- Sales ----------
  if has_perm('orders.view') then
    res := res || jsonb_build_object('sales', (
      select jsonb_build_object(
        'orders_count',   count(*) filter (where fulfillment_status <> 'CANCELLED'),
        'orders_total',   coalesce(sum(total)       filter (where fulfillment_status <> 'CANCELLED'), 0),
        'paid_total',     coalesce(sum(paid_amount) filter (where fulfillment_status <> 'CANCELLED'), 0),
        'unpaid_total',   coalesce(sum(total - paid_amount) filter (where fulfillment_status <> 'CANCELLED'), 0),
        'cancelled_count', count(*) filter (where fulfillment_status = 'CANCELLED'),
        'guest_orders',   count(*) filter (where fulfillment_status <> 'CANCELLED' and customer_id is null),
        'customers_served', count(distinct customer_id) filter (where fulfillment_status <> 'CANCELLED'),
        'items_qty', coalesce((select sum(i.qty) from order_items i join orders o2 on o2.id = i.order_id
                                where o2.business_date = d and o2.fulfillment_status <> 'CANCELLED'), 0))
        from orders where business_date = d));

    res := res || jsonb_build_object('queue', (
      select jsonb_build_object(
        'NEW',       count(*) filter (where fulfillment_status = 'NEW'),
        'PREPARING', count(*) filter (where fulfillment_status = 'PREPARING'),
        'READY',     count(*) filter (where fulfillment_status = 'READY'))
        from orders where fulfillment_status in ('NEW','PREPARING','READY')
                      and business_date >= d - 1));

    res := res || jsonb_build_object('hourly', (
      select coalesce(jsonb_agg(jsonb_build_object('h', hh, 'n', n, 'amount', amt) order by hh), '[]')
        from (select extract(hour from created_at at time zone 'Africa/Cairo')::int as hh,
                     count(*) as n, sum(total) as amt
                from orders where business_date = d and fulfillment_status <> 'CANCELLED'
               group by 1) x));

    res := res || jsonb_build_object('last7', (
      select jsonb_agg(jsonb_build_object('d', g.day::date, 'n', coalesce(x.n, 0), 'amount', coalesce(x.amt, 0)) order by g.day)
        from generate_series(d - 6, d, interval '1 day') as g(day)
        left join (select business_date, count(*) as n, sum(total) as amt
                     from orders where business_date between d - 6 and d and fulfillment_status <> 'CANCELLED'
                    group by 1) x on x.business_date = g.day::date));

    res := res || jsonb_build_object('top_today', (
      select coalesce(jsonb_agg(r order by (r->>'qty')::numeric desc), '[]') from (
        select jsonb_build_object('product_ar', i.product_name_ar_snap, 'product_en', i.product_name_en_snap,
                                  'variant_ar', i.variant_name_ar_snap, 'variant_en', i.variant_name_en_snap,
                                  'qty', sum(i.qty), 'amount', sum(i.line_total)) as r
          from order_items i join orders o on o.id = i.order_id
         where o.business_date = d and o.fulfillment_status <> 'CANCELLED'
         group by i.product_name_ar_snap, i.product_name_en_snap, i.variant_name_ar_snap, i.variant_name_en_snap
         order by sum(i.qty) desc limit 6) t));

    res := res || jsonb_build_object('top_7d', (
      select coalesce(jsonb_agg(r order by (r->>'qty')::numeric desc), '[]') from (
        select jsonb_build_object('product_ar', i.product_name_ar_snap, 'product_en', i.product_name_en_snap,
                                  'variant_ar', i.variant_name_ar_snap, 'variant_en', i.variant_name_en_snap,
                                  'qty', sum(i.qty), 'amount', sum(i.line_total)) as r
          from order_items i join orders o on o.id = i.order_id
         where o.business_date between d - 6 and d and o.fulfillment_status <> 'CANCELLED'
         group by i.product_name_ar_snap, i.product_name_en_snap, i.variant_name_ar_snap, i.variant_name_en_snap
         order by sum(i.qty) desc limit 6) t));
  end if;

  -- ---------- Cash & accounts ----------
  if has_perm('closing.perform') or has_perm('reports.financial') then
    select * into c from daily_closings where business_date = d;
    res := res || jsonb_build_object('cash', (
      select jsonb_build_object(
        'day_status',   coalesce(c.status, 'NOT_OPENED'),
        'opening_cash', coalesce(c.opening_cash, 0),
        'cash_sales',   coalesce(sum(amount) filter (where direction = 'IN' and purpose = 'ORDER'), 0),
        'deposits',     coalesce(sum(amount) filter (where direction = 'IN' and purpose = 'DEPOSIT'), 0),
        'refunds',      coalesce(sum(amount) filter (where direction = 'OUT' and purpose = 'REFUND'), 0),
        'machine',      coalesce(sum(amount) filter (where direction = 'OUT' and purpose = 'MACHINE'), 0),
        'buffet_cash',  coalesce(sum(case when drawer = 'BUFFET' then case direction when 'IN' then amount else -amount end end), 0),
        'expected',     coalesce(c.opening_cash, 0)
                        + coalesce(sum(amount) filter (where direction = 'IN'), 0)
                        - coalesce(sum(amount) filter (where direction = 'OUT'), 0),
        'unclosed_before', (select min(business_date) from daily_closings where business_date < d and status <> 'CLOSED'))
        from payments where business_date = d and method = 'CASH'));
  end if;

  if has_perm('accounts.view') then
    res := res || jsonb_build_object('accounts', (
      select jsonb_build_object(
        'receivables',   coalesce(sum(-a.balance) filter (where a.balance < 0), 0),
        'debtors_count', count(*) filter (where a.balance < 0),
        'prepaid',       coalesce(sum(a.balance) filter (where a.balance > 0), 0),
        'active_customers', count(*) filter (where cu.status = 'ACTIVE'),
        'top_debtors', (select coalesce(jsonb_agg(jsonb_build_object('id', c2.id, 'code', c2.code, 'name', c2.full_name,
                                                                     'due', -a2.balance) order by a2.balance), '[]')
                          from (select * from customer_accounts where balance < 0 order by balance limit 5) a2
                          join customers c2 on c2.id = a2.customer_id))
        from customer_accounts a join customers cu on cu.id = a.customer_id));
  end if;

  -- ---------- Inventory ----------
  if has_perm('inventory.view') then
    res := res || jsonb_build_object('inventory', jsonb_build_object(
      'low_count', (select count(*) from v_material_stock where stock_status = 'LOW'),
      'out_count', (select count(*) from v_material_stock where stock_status = 'OUT'),
      'stock_value', (select coalesce(sum(stock_value), 0) from v_material_stock),
      'alerts', (select coalesce(jsonb_agg(x order by (x->>'location_code') = 'BUFFET' desc, x->>'status' desc, x->>'name_ar'), '[]') from (
                   select jsonb_build_object('material_id', material_id, 'name_ar', name_ar, 'name_en', name_en,
                                             'location_code', location_code, 'location_ar', location_name_ar,
                                             'location_en', location_name_en, 'qty', qty, 'min', min_qty,
                                             'unit', base_unit, 'status', stock_status) as x
                     from v_material_stock where stock_status in ('LOW','OUT')
                    order by case location_code when 'BUFFET' then 0 else 1 end, stock_status desc, name_ar
                    limit 8) t),
      'waste_value_today', (select coalesce(round(sum(-qty_base * unit_cost), 2), 0) from inventory_transactions
                             where business_date = d and movement_type = 'WASTE'),
      'waste_docs_today',  (select count(*) from waste_records where (created_at at time zone 'Africa/Cairo')::date = d and status = 'POSTED'),
      'consumption_value_today', (select coalesce(round(sum(-qty_base * unit_cost), 2), 0) from inventory_transactions
                                   where business_date = d and movement_type = 'CONSUMPTION')));
  end if;

  -- ---------- Cost & margin ----------
  if has_perm('reports.cost') then
    res := res || jsonb_build_object('margin', (
      select jsonb_build_object(
        'material_cost', coalesce(round(sum(material_cost), 2), 0),
        'gross_margin',  coalesce(round(sum(total - material_cost), 2), 0))
        from orders where business_date = d and fulfillment_status <> 'CANCELLED'));
  end if;

  return res;
end $$;


create or replace function report(p_kind text, p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare f date := coalesce(p_from, business_today()); t date := coalesce(p_to, business_today()); res jsonb;
begin
  if not is_active_user() then raise exception 'USER_INACTIVE' using errcode = '42501'; end if;
  if t < f then raise exception 'PERIOD_INVALID'; end if;
  if t - f > 366 then raise exception 'PERIOD_TOO_LONG'; end if;

  if p_kind in ('by_person','by_department','by_company','staff','top_items','daily') then
    perform require_perm('reports.sales');
  elsif p_kind in ('collections','receivables') then
    perform require_perm('reports.financial');
  elsif p_kind = 'materials' then
    perform require_perm('reports.inventory');
  elsif p_kind = 'margin' then
    perform require_perm('reports.cost');
  else
    raise exception 'REPORT_UNKNOWN:%', p_kind;
  end if;

  if p_kind = 'by_person' then
    select coalesce(jsonb_agg(r order by (r->>'amount')::numeric desc), '[]') into res from (
      select jsonb_build_object(
               'id', c.id, 'name', coalesce(c.full_name, nullif(o.guest_name, ''), '—'), 'code', c.code,
               'type', coalesce(c.customer_type, 'GUEST'), 'dept_ar', d.name_ar, 'dept_en', d.name_en, 'company', c.company,
               'orders', count(distinct o.id), 'qty', sum(i.qty), 'amount', sum(i.line_total)) as r
        from orders o
        join order_items i on i.order_id = o.id
        left join customers c on c.id = o.consumer_id
        left join departments d on d.id = c.department_id
       where o.business_date between f and t and o.fulfillment_status <> 'CANCELLED'
       group by c.id, coalesce(c.full_name, nullif(o.guest_name, ''), '—'), c.code, c.customer_type, d.name_ar, d.name_en, c.company) x;

  elsif p_kind = 'by_department' then
    select coalesce(jsonb_agg(r order by (r->>'amount')::numeric desc), '[]') into res from (
      select jsonb_build_object(
               'id', d.id, 'dept_ar', d.name_ar, 'dept_en', d.name_en,
               'people', count(distinct o.consumer_id), 'orders', count(distinct o.id),
               'qty', sum(i.qty), 'amount', sum(i.line_total)) as r
        from orders o
        join order_items i on i.order_id = o.id
        left join customers c on c.id = o.consumer_id
        left join departments d on d.id = c.department_id
       where o.business_date between f and t and o.fulfillment_status <> 'CANCELLED'
       group by d.id, d.name_ar, d.name_en) x;

  elsif p_kind = 'by_company' then
    select coalesce(jsonb_agg(r order by (r->>'amount')::numeric desc), '[]') into res from (
      select jsonb_build_object(
               'company', coalesce(nullif(c.company, ''), '—'), 'type', c.customer_type,
               'people', count(distinct o.consumer_id), 'orders', count(distinct o.id),
               'qty', sum(i.qty), 'amount', sum(i.line_total)) as r
        from orders o
        join order_items i on i.order_id = o.id
        join customers c on c.id = o.consumer_id
       where o.business_date between f and t and o.fulfillment_status <> 'CANCELLED'
         and (c.customer_type in ('VISITOR','TRAINEE','CONTRACTOR') or c.company is not null)
       group by coalesce(nullif(c.company, ''), '—'), c.customer_type) x;

  elsif p_kind = 'staff' then
    with created as (
      select o.created_by as uid, count(distinct o.id) as orders, sum(i.qty) as qty, sum(i.line_total) as amount
        from orders o join order_items i on i.order_id = o.id
       where o.business_date between f and t and o.fulfillment_status <> 'CANCELLED'
       group by o.created_by),
    served as (
      select served_by as uid, count(*) as served from orders
       where business_date between f and t and fulfillment_status = 'SERVED' and served_by is not null
       group by served_by),
    cash as (
      select created_by as uid,
             sum(amount) filter (where direction = 'IN' and purpose = 'ORDER')   as cash_orders,
             sum(amount) filter (where direction = 'IN' and purpose = 'DEPOSIT') as deposits,
             sum(amount) filter (where direction = 'OUT' and purpose = 'REFUND')  as refunds,
             sum(amount) filter (where direction = 'OUT' and purpose = 'MACHINE') as machine
        from payments where business_date between f and t group by created_by),
    ids as (select uid from created union select uid from served union select uid from cash)
    select coalesce(jsonb_agg(jsonb_build_object(
             'name', coalesce(u.full_name, '—'), 'orders', coalesce(c.orders, 0), 'qty', coalesce(c.qty, 0),
             'amount', coalesce(c.amount, 0), 'served', coalesce(s.served, 0),
             'cash_orders', coalesce(k.cash_orders, 0), 'deposits', coalesce(k.deposits, 0), 'refunds', coalesce(k.refunds, 0), 'machine', coalesce(k.machine, 0))
           order by coalesce(c.amount, 0) desc), '[]') into res
      from ids
      left join created c on c.uid = ids.uid
      left join served s on s.uid = ids.uid
      left join cash k on k.uid = ids.uid
      left join app_users u on u.id = ids.uid
     where ids.uid is not null;

  elsif p_kind = 'top_items' then
    select coalesce(jsonb_agg(r order by (r->>'qty')::numeric desc), '[]') into res from (
      select jsonb_build_object(
               'product_ar', i.product_name_ar_snap, 'product_en', i.product_name_en_snap,
               'variant_ar', i.variant_name_ar_snap, 'variant_en', i.variant_name_en_snap,
               'orders', count(distinct o.id), 'qty', sum(i.qty), 'amount', sum(i.line_total)) as r
        from orders o join order_items i on i.order_id = o.id
       where o.business_date between f and t and o.fulfillment_status <> 'CANCELLED'
       group by i.product_name_ar_snap, i.product_name_en_snap, i.variant_name_ar_snap, i.variant_name_en_snap) x;

  elsif p_kind = 'daily' then
    select coalesce(jsonb_agg(jsonb_build_object(
             'day', g.day::date, 'orders', coalesce(o.n, 0), 'qty', coalesce(o.qty, 0), 'amount', coalesce(o.amt, 0),
             'cash_orders', coalesce(p.cash_orders, 0), 'deposits', coalesce(p.deposits, 0), 'refunds', coalesce(p.refunds, 0), 'machine', coalesce(p.machine, 0),
             'cancelled', coalesce(o.cancelled, 0)) order by g.day), '[]') into res
      from generate_series(f, t, interval '1 day') as g(day)
      left join (select business_date,
                        count(*) filter (where fulfillment_status <> 'CANCELLED') as n,
                        count(*) filter (where fulfillment_status = 'CANCELLED') as cancelled,
                        sum(total) filter (where fulfillment_status <> 'CANCELLED') as amt,
                        (select sum(i.qty) from order_items i join orders o2 on o2.id = i.order_id
                          where o2.business_date = orders.business_date and o2.fulfillment_status <> 'CANCELLED') as qty
                   from orders where business_date between f and t group by business_date) o on o.business_date = g.day::date
      left join (select business_date,
                        sum(amount) filter (where direction = 'IN' and purpose = 'ORDER')   as cash_orders,
                        sum(amount) filter (where direction = 'IN' and purpose = 'DEPOSIT') as deposits,
                        sum(amount) filter (where direction = 'OUT' and purpose = 'REFUND')  as refunds,
                        sum(amount) filter (where direction = 'OUT' and purpose = 'MACHINE') as machine
                   from payments where business_date between f and t group by business_date) p on p.business_date = g.day::date;

  elsif p_kind = 'collections' then
    select coalesce(jsonb_agg(jsonb_build_object(
             'at', p.created_at, 'day', p.business_date, 'receipt_no', p.receipt_no, 'purpose', p.purpose,
             'direction', p.direction, 'amount', p.amount, 'customer', c.full_name, 'code', c.code,
             'user', u.full_name, 'notes', p.notes, 'drawer', p.drawer) order by p.id desc), '[]') into res
      from payments p
      left join customers c on c.id = p.customer_id
      left join app_users u on u.id = p.created_by
     where p.business_date between f and t;

  elsif p_kind = 'receivables' then
    select coalesce(jsonb_agg(jsonb_build_object(
             'id', r.id, 'name', r.full_name, 'code', r.code, 'type', r.customer_type,
             'dept_ar', r.department_ar, 'dept_en', r.department_en, 'company', r.company,
             'due', r.due, 'unpaid_count', r.unpaid_count, 'oldest_unpaid', r.oldest_unpaid, 'days_open', r.days_open)
           order by r.due desc), '[]') into res
      from v_receivables r;

  elsif p_kind = 'materials' then
    select coalesce(jsonb_agg(r order by r->>'name_ar'), '[]') into res from (
      select jsonb_build_object(
               'material_id', m.id, 'code', m.code, 'name_ar', m.name_ar, 'name_en', m.name_en, 'unit', u.code, 'unit_ar', u.name_ar,
               'purchased', coalesce(sum(x.qty_base) filter (where x.movement_type = 'PURCHASE'), 0),
               'consumed',  coalesce(-sum(x.qty_base) filter (where x.movement_type = 'CONSUMPTION'), 0),
               'waste',     coalesce(-sum(x.qty_base) filter (where x.movement_type = 'WASTE'), 0),
               'adjusted',  coalesce(sum(x.qty_base) filter (where x.movement_type in ('ADJUSTMENT','OPENING_BALANCE')), 0),
               'consumed_value', round(coalesce(-sum(x.qty_base * x.unit_cost) filter (where x.movement_type = 'CONSUMPTION'), 0), 2),
               'waste_value',    round(coalesce(-sum(x.qty_base * x.unit_cost) filter (where x.movement_type = 'WASTE'), 0), 2),
               'stock_now', (select coalesce(sum(qty), 0) from material_stock s where s.material_id = m.id)) as r
        from materials m
        join units u on u.id = m.base_unit_id
        left join inventory_transactions x on x.material_id = m.id and x.business_date between f and t
       where m.track_stock
       group by m.id, u.code, u.name_ar) q
     where (r->>'purchased')::numeric <> 0 or (r->>'consumed')::numeric <> 0 or (r->>'waste')::numeric <> 0
        or (r->>'adjusted')::numeric <> 0 or (r->>'stock_now')::numeric <> 0;

  elsif p_kind = 'margin' then
    select coalesce(jsonb_agg(r order by (r->>'margin')::numeric desc), '[]') into res from (
      select jsonb_build_object(
               'product_ar', i.product_name_ar_snap, 'product_en', i.product_name_en_snap,
               'variant_ar', i.variant_name_ar_snap, 'variant_en', i.variant_name_en_snap,
               'qty', sum(i.qty), 'sales', sum(i.line_total),
               'cost', round(sum(i.qty * i.unit_cost_snap), 2),
               'margin', round(sum(i.line_total) - sum(i.qty * i.unit_cost_snap), 2),
               'margin_pct', case when sum(i.line_total) > 0
                                  then round((sum(i.line_total) - sum(i.qty * i.unit_cost_snap)) / sum(i.line_total) * 100, 1) end) as r
        from orders o join order_items i on i.order_id = o.id
       where o.business_date between f and t and o.fulfillment_status <> 'CANCELLED'
       group by i.product_name_ar_snap, i.product_name_en_snap, i.variant_name_ar_snap, i.variant_name_en_snap) x;
  end if;

  return res;
end $$;

