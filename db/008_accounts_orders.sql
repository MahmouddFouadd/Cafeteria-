-- =====================================================================
--  008_accounts_orders.sql — customers' wallet, POS orders, daily closing
--  Run once after 007.
--  Single wallet per customer: balance > 0 prepaid, < 0 amount due.
--  An order's non-cash part is always charged to the wallet; the part the
--  wallet already covered counts as paid, the rest is settled by later
--  deposits (oldest order first).
-- =====================================================================
set search_path = public, extensions;

insert into doc_sequences (doc_type, prefix) values ('ADJUST', 'AJ-')
on conflict (doc_type) do nothing;

insert into permissions (code, module, name_ar, name_en) values
  ('orders.queue', 'orders', 'شاشة التحضير', 'Preparation queue')
on conflict (code) do nothing;
insert into role_permissions (role_id, permission_code)
select r.id, 'orders.queue' from roles r where r.code in ('BARISTA','RECEPTION','MANAGER')
on conflict do nothing;

-- ---------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------
create or replace function _setting(p_key text) returns jsonb
language sql stable security definer set search_path = public as $$
  select value from app_settings where key = p_key;
$$;

-- Effective credit limit: NULL = unlimited
create or replace function _credit_limit(p_customer bigint) returns numeric
language sql stable security definer set search_path = public as $$
  select coalesce(c.credit_limit,
                  case when jsonb_typeof(_setting('default_credit_limit')) = 'number'
                       then (_setting('default_credit_limit'))::text::numeric end)
    from customers c where c.id = p_customer;
$$;

create or replace function _active_account(p_customer bigint) returns customer_accounts
language plpgsql security definer set search_path = public as $$
declare a customer_accounts; v_status text;
begin
  select status into v_status from customers where id = p_customer;
  if v_status is null then raise exception 'CUSTOMER_NOT_FOUND'; end if;
  if v_status <> 'ACTIVE' then raise exception 'CUSTOMER_NOT_ACTIVE'; end if;
  select * into a from customer_accounts where customer_id = p_customer for update;
  if a.status <> 'OPEN' then raise exception 'ACCOUNT_CLOSED'; end if;
  return a;
end $$;

-- Apply a wallet credit to the customer's unpaid orders, oldest first.
create or replace function _auto_settle(p_customer bigint, p_txn bigint, p_amount numeric)
returns int language plpgsql security definer set search_path = public as $$
declare o record; v_left numeric := p_amount; v_take numeric; v_n int := 0;
begin
  if coalesce((_setting('auto_settle_on_deposit'))::text, 'true') <> 'true' then return 0; end if;
  for o in select id, total - paid_amount as due
             from orders
            where customer_id = p_customer and fulfillment_status <> 'CANCELLED'
              and payment_status in ('UNPAID','PARTIALLY_PAID')
            order by id
            for update loop
    exit when v_left <= 0;
    v_take := least(v_left, o.due);
    if v_take > 0 then
      insert into order_payments (order_id, method, amount, account_txn_id)
      values (o.id, 'ACCOUNT', v_take, p_txn);
      v_left := v_left - v_take;
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end $$;

-- ---------------------------------------------------------------------
-- Wallet: deposit, adjustment, refund
-- ---------------------------------------------------------------------
create or replace function deposit(p_customer_id bigint, p_amount numeric, p_notes text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare a customer_accounts; v_txn bigint; v_pay bigint; v_no text; v_n int; v_bal numeric;
begin
  perform require_perm('accounts.deposit');
  if coalesce(p_amount, 0) <= 0 then raise exception 'AMOUNT_INVALID'; end if;
  a := _active_account(p_customer_id);

  insert into account_transactions (account_id, txn_type, credit, reference_type, notes)
  values (a.id, 'DEPOSIT', p_amount, 'PAYMENT', p_notes)
  returning id, balance_after into v_txn, v_bal;

  v_no := next_doc_no('PAYMENT');
  insert into payments (receipt_no, customer_id, direction, purpose, amount, account_txn_id, notes)
  values (v_no, p_customer_id, 'IN', 'DEPOSIT', p_amount, v_txn, p_notes)
  returning id into v_pay;

  v_n := _auto_settle(p_customer_id, v_txn, p_amount);
  perform log_audit('DEPOSIT', 'customers', p_customer_id::text, null,
                    jsonb_build_object('receipt_no', v_no, 'amount', p_amount, 'settled_orders', v_n));
  return jsonb_build_object('receipt_no', v_no, 'payment_id', v_pay, 'balance', v_bal, 'settled_orders', v_n);
end $$;

-- p_amount > 0 credits the customer, < 0 debits. p_type: ADJUSTMENT | OPENING
create or replace function account_adjust(p_customer_id bigint, p_amount numeric, p_reason text,
                                          p_type text default 'ADJUSTMENT')
returns jsonb language plpgsql security definer set search_path = public as $$
declare a customer_accounts; v_txn bigint; v_bal numeric; v_n int := 0; v_no text;
begin
  perform require_perm('accounts.adjust');
  if coalesce(p_amount, 0) = 0 then raise exception 'AMOUNT_INVALID'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'REASON_REQUIRED'; end if;
  if p_type not in ('ADJUSTMENT','OPENING') then raise exception 'TYPE_INVALID'; end if;
  a := _active_account(p_customer_id);
  if p_type = 'OPENING' and exists (select 1 from account_transactions where account_id = a.id) then
    raise exception 'OPENING_BALANCE_EXISTS';
  end if;

  v_no := next_doc_no('ADJUST');
  insert into account_transactions (account_id, txn_type, debit, credit, reference_type, notes)
  values (a.id, p_type, greatest(-p_amount, 0), greatest(p_amount, 0), 'ADJUST', v_no || ' ' || p_reason)
  returning id, balance_after into v_txn, v_bal;

  if p_amount > 0 then v_n := _auto_settle(p_customer_id, v_txn, p_amount); end if;
  perform log_audit('ACCOUNT_' || p_type, 'customers', p_customer_id::text, null,
                    jsonb_build_object('doc_no', v_no, 'amount', p_amount), p_reason);
  return jsonb_build_object('doc_no', v_no, 'balance', v_bal, 'settled_orders', v_n);
end $$;

-- Cash back from a positive wallet balance
create or replace function refund_balance(p_customer_id bigint, p_amount numeric, p_reason text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare a customer_accounts; v_txn bigint; v_bal numeric; v_no text;
begin
  perform require_perm('payments.refund');
  if coalesce(p_amount, 0) <= 0 then raise exception 'AMOUNT_INVALID'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'REASON_REQUIRED'; end if;
  select * into a from customer_accounts where customer_id = p_customer_id for update;
  if not found then raise exception 'CUSTOMER_NOT_FOUND'; end if;
  if a.balance < p_amount then raise exception 'BALANCE_NOT_ENOUGH:%', a.balance; end if;

  insert into account_transactions (account_id, txn_type, debit, reference_type, notes)
  values (a.id, 'REFUND', p_amount, 'PAYMENT', p_reason)
  returning id, balance_after into v_txn, v_bal;
  v_no := next_doc_no('PAYMENT');
  insert into payments (receipt_no, customer_id, direction, purpose, amount, account_txn_id, notes)
  values (v_no, p_customer_id, 'OUT', 'REFUND', p_amount, v_txn, p_reason);

  perform log_audit('REFUND', 'customers', p_customer_id::text, null,
                    jsonb_build_object('receipt_no', v_no, 'amount', p_amount), p_reason);
  return jsonb_build_object('receipt_no', v_no, 'balance', v_bal);
end $$;

-- ---------------------------------------------------------------------
-- Orders
-- p_items: [{variant_id, qty, addons:[addon_id,...], notes}]
-- p_cash:  cash taken now (capped at the total; change is handed back)
-- Customer orders: the rest goes to the wallet. Quick cash sale: cash must cover the total.
-- ---------------------------------------------------------------------
create or replace function create_order(p_items jsonb, p_customer_id bigint default null,
                                        p_guest_name text default null, p_cash numeric default 0,
                                        p_notes text default null, p_idempotency_key uuid default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_existing orders; v_loc bigint; v_order bigint; v_no text; it record; v jsonb;
  pv product_variants; p products; v_recipe bigint; v_addons_total numeric; v_unit_cost numeric;
  v_line numeric; v_total numeric := 0; v_cost numeric := 0; v_item bigint; ad record;
  m record; a customer_accounts; v_cash numeric; v_rest numeric; v_limit numeric;
  v_txn bigint; v_bal_before numeric; v_cover numeric; v_pay bigint; v_mats bigint[] := '{}';
  v_bal_after numeric;
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

  select id into v_loc from stock_locations where is_consumption and active;
  if v_loc is null then raise exception 'NO_CONSUMPTION_LOCATION'; end if;

  v_no := next_doc_no('ORDER');
  insert into orders (order_no, customer_id, guest_name, location_id, notes, idempotency_key)
  values (v_no, p_customer_id, case when p_customer_id is null then nullif(trim(p_guest_name), '') end,
          v_loc, p_notes, p_idempotency_key)
  returning id into v_order;

  for v in select * from jsonb_array_elements(p_items) loop
    if coalesce((v->>'qty')::int, 0) <= 0 then raise exception 'QTY_INVALID'; end if;
    select * into pv from product_variants where id = (v->>'variant_id')::bigint;
    if not found or not pv.active then raise exception 'VARIANT_NOT_AVAILABLE:%', v->>'variant_id'; end if;
    select * into p from products where id = pv.product_id;
    if not p.active then raise exception 'VARIANT_NOT_AVAILABLE:%', pv.code; end if;
    select id into v_recipe from recipes where variant_id = pv.id and is_current;

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

    v_line := (v->>'qty')::int * (pv.price + v_addons_total);
    insert into order_items (order_id, variant_id, product_name_ar_snap, product_name_en_snap,
                             variant_name_ar_snap, variant_name_en_snap, qty, unit_price, addons_total,
                             line_total, recipe_id, unit_cost_snap, notes)
    values (v_order, pv.id, p.name_ar, p.name_en, pv.name_ar, pv.name_en, (v->>'qty')::int, pv.price,
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

  perform log_audit('CREATE_ORDER', 'orders', v_order::text, null,
                    jsonb_build_object('order_no', v_no, 'total', v_total, 'cash', v_cash, 'account', v_rest));
  return jsonb_build_object('order_id', v_order, 'order_no', v_no, 'total', v_total,
                            'cash', v_cash, 'account', v_rest,
                            'paid', (select paid_amount from orders where id = v_order),
                            'balance', v_bal_after,
                            'warnings', _negative_warnings(v_loc, v_mats));
end $$;

create or replace function set_order_status(p_order_id bigint, p_status text)
returns void language plpgsql security definer set search_path = public as $$
declare o orders; v_rank_old int; v_rank_new int;
begin
  perform require_perm('orders.update_status');
  select * into o from orders where id = p_order_id for update;
  if not found then raise exception 'ORDER_NOT_FOUND'; end if;
  if o.fulfillment_status = 'CANCELLED' then raise exception 'ORDER_CANCELLED'; end if;
  v_rank_old := array_position(array['NEW','PREPARING','READY','SERVED'], o.fulfillment_status);
  v_rank_new := array_position(array['NEW','PREPARING','READY','SERVED'], p_status);
  if v_rank_new is null or v_rank_new <= v_rank_old then raise exception 'STATUS_INVALID:%', p_status; end if;
  update orders set
    fulfillment_status = p_status,
    prepared_by = case when p_status = 'PREPARING' or (prepared_by is null and v_rank_new >= 2) then coalesce(prepared_by, auth.uid()) else prepared_by end,
    prepared_at = case when prepared_at is null and v_rank_new >= 2 then now() else prepared_at end,
    ready_at    = case when ready_at is null and v_rank_new >= 3 then now() else ready_at end,
    served_by   = case when p_status = 'SERVED' then auth.uid() else served_by end,
    served_at   = case when p_status = 'SERVED' then now() else served_at end
  where id = p_order_id;
end $$;

-- Cancel: never deletes. Stock comes back (or becomes waste if it was prepared),
-- cash is refunded, wallet charge is reversed.
create or replace function cancel_order(p_order_id bigint, p_reason text, p_was_prepared boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare o orders; t record; op record; v_waste bigint; v_wno text; v_refund numeric := 0; v_pay bigint;
        v_rev bigint;
begin
  perform require_perm('orders.cancel');
  if coalesce(trim(p_reason), '') = '' then raise exception 'REASON_REQUIRED'; end if;
  select * into o from orders where id = p_order_id for update;
  if not found then raise exception 'ORDER_NOT_FOUND'; end if;
  if o.fulfillment_status = 'CANCELLED' then raise exception 'ORDER_CANCELLED'; end if;
  if o.paid_amount > 0 or exists (select 1 from account_transactions
                                   where reference_type = 'ORDER' and reference_id = o.id) then
    perform require_perm('orders.cancel_paid');
  end if;
  if is_day_closed(o.business_date) then perform require_perm('closing.override'); end if;

  update orders set fulfillment_status = 'CANCELLED', cancelled_by = auth.uid(), cancelled_at = now(),
                    cancel_reason = p_reason where id = o.id;

  -- stock
  if p_was_prepared and exists (select 1 from inventory_transactions where reference_type = 'ORDER' and reference_id = o.id) then
    v_wno := next_doc_no('WASTE');
    insert into waste_records (doc_no, location_id, reason_code, notes)
    values (v_wno, o.location_id, 'PREPARED_CANCELLED', o.order_no || ': ' || p_reason)
    returning id into v_waste;
  end if;
  for t in select * from inventory_transactions
            where reference_type = 'ORDER' and reference_id = o.id and reversal_of is null loop
    perform _inv_move(t.material_id, t.location_id, t.movement_type, -t.qty_base, null, null,
                      t.unit_cost, 'ORDER', o.id, 'CANCEL: ' || p_reason, t.id);
    if v_waste is not null then
      insert into waste_items (waste_id, material_id, qty, unit_id, qty_base, unit_cost)
      select v_waste, t.material_id, -t.qty_base, m.base_unit_id, -t.qty_base, t.unit_cost
        from materials m where m.id = t.material_id;
      perform _inv_move(t.material_id, t.location_id, 'WASTE', t.qty_base, null, null,
                        t.unit_cost, 'WASTE', v_waste, 'PREPARED_CANCELLED');
    end if;
  end loop;

  -- cash back
  for op in select payment_id, sum(amount) as amt from order_payments
             where order_id = o.id and method = 'CASH' group by payment_id having sum(amount) > 0 loop
    insert into payments (receipt_no, customer_id, direction, purpose, amount, reversal_of, notes)
    values (next_doc_no('PAYMENT'), o.customer_id, 'OUT', 'REFUND', op.amt, op.payment_id, o.order_no || ': ' || p_reason)
    returning id into v_pay;
    insert into order_payments (order_id, method, amount, payment_id) values (o.id, 'CASH', -op.amt, v_pay);
    v_refund := v_refund + op.amt;
  end loop;

  -- wallet charge reversed (the customer gets back what the order took)
  for t in select * from account_transactions
            where reference_type = 'ORDER' and reference_id = o.id and txn_type = 'ORDER_CHARGE'
              and not exists (select 1 from account_transactions x where x.reversal_of = account_transactions.id) loop
    insert into account_transactions (account_id, txn_type, credit, reference_type, reference_id, reversal_of, notes)
    values (t.account_id, 'REVERSAL', t.debit, 'ORDER', o.id, t.id, o.order_no || ': ' || p_reason)
    returning id into v_rev;
    if (select coalesce(sum(amount), 0) from order_payments where order_id = o.id and method = 'ACCOUNT') > 0 then
      insert into order_payments (order_id, method, amount, account_txn_id)
      select o.id, 'ACCOUNT', -sum(amount), v_rev from order_payments where order_id = o.id and method = 'ACCOUNT';
    end if;
  end loop;

  perform log_audit('CANCEL_ORDER', 'orders', o.id::text,
                    jsonb_build_object('status', o.fulfillment_status, 'paid', o.paid_amount),
                    jsonb_build_object('cash_refund', v_refund, 'waste_doc', v_wno), p_reason);
  return jsonb_build_object('order_no', o.order_no, 'cash_refund', v_refund, 'waste_doc', v_wno);
end $$;

-- ---------------------------------------------------------------------
-- Daily closing (single cashier)
-- ---------------------------------------------------------------------
create or replace function closing_preview(p_date date default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare d date := coalesce(p_date, business_today()); c daily_closings;
        v_sales numeric; v_dep numeric; v_ref numeric; v_open numeric;
begin
  perform require_perm('closing.perform');
  select * into c from daily_closings where business_date = d;
  v_open := coalesce(c.opening_cash, 0);
  select coalesce(sum(amount) filter (where direction = 'IN' and purpose = 'ORDER'), 0),
         coalesce(sum(amount) filter (where direction = 'IN' and purpose = 'DEPOSIT'), 0),
         coalesce(sum(amount) filter (where direction = 'OUT'), 0)
    into v_sales, v_dep, v_ref
    from payments where business_date = d and method = 'CASH';
  return jsonb_build_object(
    'business_date', d, 'status', coalesce(c.status, 'NOT_OPENED'),
    'opening_cash', v_open, 'cash_sales', v_sales, 'deposits_cash', v_dep, 'refunds_cash', v_ref,
    'expected_cash', v_open + v_sales + v_dep - v_ref,
    'actual_cash', c.actual_cash, 'difference', c.difference,
    'orders_count', (select count(*) from orders where business_date = d and fulfillment_status <> 'CANCELLED'),
    'orders_total', (select coalesce(sum(total), 0) from orders where business_date = d and fulfillment_status <> 'CANCELLED'),
    'account_sales', (select coalesce(sum(debit), 0) - coalesce(sum(credit), 0) from account_transactions
                       where business_date = d and reference_type = 'ORDER'),
    'cancelled_count', (select count(*) from orders where business_date = d and fulfillment_status = 'CANCELLED'),
    'unclosed_before', (select min(business_date) from daily_closings where business_date < d and status <> 'CLOSED'));
end $$;

create or replace function open_day(p_opening_cash numeric default 0)
returns jsonb language plpgsql security definer set search_path = public as $$
declare d date := business_today();
begin
  perform require_perm('closing.perform');
  if coalesce(p_opening_cash, 0) < 0 then raise exception 'AMOUNT_INVALID'; end if;
  if exists (select 1 from daily_closings where business_date = d) then raise exception 'DAY_ALREADY_OPENED'; end if;
  insert into daily_closings (business_date, opening_cash) values (d, coalesce(p_opening_cash, 0));
  perform log_audit('OPEN_DAY', 'daily_closings', d::text, null, jsonb_build_object('opening_cash', p_opening_cash));
  return closing_preview(d);
end $$;

create or replace function close_day(p_date date, p_actual_cash numeric, p_notes text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare pv jsonb;
begin
  perform require_perm('closing.perform');
  if p_actual_cash is null or p_actual_cash < 0 then raise exception 'AMOUNT_INVALID'; end if;
  if exists (select 1 from daily_closings where business_date = p_date and status = 'CLOSED') then
    raise exception 'DAY_CLOSED:%', p_date;
  end if;
  insert into daily_closings (business_date) values (p_date) on conflict (business_date) do nothing;
  pv := closing_preview(p_date);
  update daily_closings set
    cash_sales = (pv->>'cash_sales')::numeric, deposits_cash = (pv->>'deposits_cash')::numeric,
    refunds_cash = (pv->>'refunds_cash')::numeric, expected_cash = (pv->>'expected_cash')::numeric,
    actual_cash = p_actual_cash, difference = p_actual_cash - (pv->>'expected_cash')::numeric,
    status = 'CLOSED', closed_by = auth.uid(), closed_at = now(),
    notes = coalesce(p_notes, notes)
  where business_date = p_date;
  perform log_audit('CLOSE_DAY', 'daily_closings', p_date::text, null,
                    jsonb_build_object('expected', pv->'expected_cash', 'actual', p_actual_cash), p_notes);
  return closing_preview(p_date);
end $$;

create or replace function reopen_day(p_date date, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform require_perm('closing.override');
  if coalesce(trim(p_reason), '') = '' then raise exception 'REASON_REQUIRED'; end if;
  update daily_closings set status = 'REOPENED', reopened_by = auth.uid(), reopened_at = now(), reopen_reason = p_reason
   where business_date = p_date and status = 'CLOSED';
  if not found then raise exception 'DAY_NOT_CLOSED'; end if;
  perform log_audit('REOPEN_DAY', 'daily_closings', p_date::text, null, null, p_reason);
end $$;

-- ---------------------------------------------------------------------
-- Views for the UI (security_invoker: caller's RLS applies)
-- ---------------------------------------------------------------------
create or replace view v_customer_summary with (security_invoker = true) as
select c.id, c.code, c.full_name, c.customer_type, c.department_id, c.phone, c.status, c.credit_limit, c.notes,
       d.name_ar as department_ar, d.name_en as department_en,
       a.id as account_id, a.balance,
       greatest(a.balance, 0) as available_balance, greatest(-a.balance, 0) as amount_due,
       coalesce(u.unpaid, 0) as unpaid_amount, coalesce(u.unpaid_count, 0) as unpaid_count,
       coalesce(td.cnt, 0) as today_orders, coalesce(td.amt, 0) as today_amount
  from customers c
  join customer_accounts a on a.customer_id = c.id
  left join departments d on d.id = c.department_id
  left join lateral (select sum(o.total - o.paid_amount) as unpaid, count(*) as unpaid_count
                       from orders o where o.customer_id = c.id and o.fulfillment_status <> 'CANCELLED'
                        and o.payment_status in ('UNPAID','PARTIALLY_PAID')) u on true
  left join lateral (select count(*) as cnt, sum(o.total) as amt from orders o
                      where o.customer_id = c.id and o.business_date = business_today()
                        and o.fulfillment_status <> 'CANCELLED') td on true;

create or replace view v_orders with (security_invoker = true) as
select o.*, o.total - o.paid_amount as due,
       c.code as customer_code, c.full_name as customer_name,
       uc.full_name as created_by_name, us.full_name as served_by_name, up.full_name as paid_by_name,
       ux.full_name as cancelled_by_name,
       (select coalesce(sum(qty), 0) from order_items i where i.order_id = o.id) as items_qty
  from orders o
  left join customers c on c.id = o.customer_id
  left join v_user_names uc on uc.id = o.created_by
  left join v_user_names us on us.id = o.served_by
  left join v_user_names up on up.id = o.paid_by
  left join v_user_names ux on ux.id = o.cancelled_by;

create or replace view v_account_ledger with (security_invoker = true) as
select t.id, t.account_id, a.customer_id, t.txn_type, t.debit, t.credit, t.balance_after,
       t.reference_type, t.reference_id, t.business_date, t.created_at, t.notes, t.reversal_of,
       case when t.reference_type = 'ORDER' then o.order_no
            else (select p.receipt_no from payments p where p.account_txn_id = t.id limit 1) end as reference_no,
       u.full_name as created_by_name
  from account_transactions t
  join customer_accounts a on a.id = t.account_id
  left join orders o on t.reference_type = 'ORDER' and o.id = t.reference_id
  left join v_user_names u on u.id = t.created_by;

create or replace view v_order_lines with (security_invoker = true) as
select i.id, i.order_id, o.order_no, o.business_date, o.created_at, o.customer_id, o.fulfillment_status,
       o.payment_status, i.variant_id, pv.product_id,
       i.product_name_ar_snap, i.product_name_en_snap, i.variant_name_ar_snap, i.variant_name_en_snap,
       i.qty, i.unit_price, i.addons_total, i.line_total, i.unit_cost_snap, i.notes,
       (select coalesce(jsonb_agg(jsonb_build_object('name_ar', a.name_ar_snap, 'name_en', a.name_en_snap,
                                                     'price', a.price_snap)), '[]')
          from order_item_addons a where a.order_item_id = i.id) as addons
  from order_items i
  join orders o on o.id = i.order_id
  join product_variants pv on pv.id = i.variant_id;

create or replace view v_payments with (security_invoker = true) as
select p.*, c.code as customer_code, c.full_name as customer_name, u.full_name as created_by_name
  from payments p
  left join customers c on c.id = p.customer_id
  left join v_user_names u on u.id = p.created_by;

-- ---------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------
revoke execute on function _setting(text), _credit_limit(bigint), _active_account(bigint),
  _auto_settle(bigint,bigint,numeric) from public, anon, authenticated;

revoke execute on function deposit(bigint,numeric,text), account_adjust(bigint,numeric,text,text),
  refund_balance(bigint,numeric,text), create_order(jsonb,bigint,text,numeric,text,uuid),
  set_order_status(bigint,text), cancel_order(bigint,text,boolean), closing_preview(date),
  open_day(numeric), close_day(date,numeric,text), reopen_day(date,text) from public, anon;
grant execute on function deposit(bigint,numeric,text), account_adjust(bigint,numeric,text,text),
  refund_balance(bigint,numeric,text), create_order(jsonb,bigint,text,numeric,text,uuid),
  set_order_status(bigint,text), cancel_order(bigint,text,boolean), closing_preview(date),
  open_day(numeric), close_day(date,numeric,text), reopen_day(date,text) to authenticated;
