-- =====================================================================
--  013_payer.sql — who drank vs. who pays; guests, trainees, department
--  accounts. Run once after 012.
-- =====================================================================
set search_path = public, extensions;

-- ---------- People: more types + company ----------
alter table customers drop constraint if exists customers_customer_type_check;
alter table customers add constraint customers_customer_type_check
  check (customer_type in ('EMPLOYEE','VISITOR','TRAINEE','CONTRACTOR','DEPARTMENT','OTHER'));
alter table customers add column if not exists company text;
-- one account per department
create unique index if not exists customers_one_dept_account
  on customers (department_id) where customer_type = 'DEPARTMENT';

-- ---------- Orders: the consumer (payer stays in customer_id) ----------
alter table orders add column if not exists consumer_id bigint references customers(id);
update orders set consumer_id = customer_id where consumer_id is null and customer_id is not null;
create index if not exists orders_consumer_idx on orders (consumer_id, business_date);

-- ---------- Department account (created on first use) ----------
create or replace function department_account(p_department_id bigint)
returns jsonb language plpgsql security definer set search_path = public as $$
declare d departments; v_id bigint;
begin
  if not (has_perm('pos.create_order') or has_perm('customers.manage')) then
    raise exception 'PERMISSION_DENIED:pos.create_order' using errcode = '42501';
  end if;
  select * into d from departments where id = p_department_id;
  if not found then raise exception 'DEPARTMENT_NOT_FOUND'; end if;
  select id into v_id from customers where customer_type = 'DEPARTMENT' and department_id = d.id;
  if v_id is null then
    insert into customers (code, full_name, customer_type, department_id, notes)
    values ('DEPT-' || d.id, 'حساب إدارة ' || d.name_ar, 'DEPARTMENT', d.id, coalesce(d.name_en, d.name_ar))
    returning id into v_id;
  end if;
  return (select to_jsonb(s) from v_customer_summary s where s.id = v_id);
end $$;
revoke execute on function department_account(bigint) from public, anon;
grant execute on function department_account(bigint) to authenticated;

-- ---------- Quick add: type + company ----------
drop function if exists quick_add_customer(text, text, text);
create or replace function quick_add_customer(p_code text, p_full_name text, p_department text default null,
                                              p_type text default 'EMPLOYEE', p_company text default null)
returns jsonb language plpgsql security definer set search_path = public as $q$
declare v_code text := nullif(trim(p_code), ''); v_name text := nullif(trim(p_full_name), '');
        v_dept_name text := nullif(trim(p_department), ''); v_dept bigint; v_id bigint; v_new_dept boolean := false;
        v_type text := upper(coalesce(nullif(trim(p_type), ''), 'EMPLOYEE'));
begin
  if not (has_perm('customers.quick_add') or has_perm('customers.manage')) then
    raise exception 'PERMISSION_DENIED:customers.quick_add' using errcode = '42501';
  end if;
  if v_type not in ('EMPLOYEE','VISITOR','TRAINEE','CONTRACTOR') then raise exception 'TYPE_INVALID:%', v_type; end if;
  if v_name is null then raise exception 'NAME_REQUIRED'; end if;
  -- guests often have no ID: generate one
  if v_code is null then
    if v_type = 'EMPLOYEE' then raise exception 'CODE_REQUIRED'; end if;
    v_code := left(v_type, 1) || '-' || to_char(now() at time zone 'Africa/Cairo', 'YYMMDD') || '-' || lpad((floor(random() * 10000))::text, 4, '0');
  end if;
  if exists (select 1 from customers where lower(code) = lower(v_code)) then
    raise exception 'CUSTOMER_CODE_EXISTS:%', v_code;
  end if;
  if v_dept_name is not null then
    select id into v_dept from departments
     where lower(name_ar) = lower(v_dept_name) or lower(coalesce(name_en, '')) = lower(v_dept_name)
     order by active desc, id limit 1;
    if v_dept is null then
      insert into departments (name_ar) values (v_dept_name) returning id into v_dept;
      v_new_dept := true;
    end if;
  end if;
  insert into customers (code, full_name, department_id, customer_type, company)
  values (v_code, v_name, v_dept, v_type, nullif(trim(p_company), ''))
  returning id into v_id;
  perform log_audit('QUICK_ADD_CUSTOMER', 'customers', v_id::text, null,
                    jsonb_build_object('code', v_code, 'name', v_name, 'type', v_type,
                                       'department', v_dept_name, 'company', p_company, 'new_department', v_new_dept));
  return jsonb_build_object('id', v_id, 'code', v_code, 'department_id', v_dept, 'new_department', v_new_dept);
end $q$;
revoke execute on function quick_add_customer(text, text, text, text, text) from public, anon;
grant execute on function quick_add_customer(text, text, text, text, text) to authenticated;

-- ---------- Views ----------
create or replace view v_customer_summary with (security_invoker = true) as
select c.id, c.code, c.full_name, c.customer_type, c.department_id, c.phone, c.status, c.credit_limit, c.notes,
       d.name_ar as department_ar, d.name_en as department_en,
       a.id as account_id, a.balance,
       greatest(a.balance, 0) as available_balance, greatest(-a.balance, 0) as amount_due,
       coalesce(u.unpaid, 0) as unpaid_amount, coalesce(u.unpaid_count, 0) as unpaid_count,
       coalesce(td.cnt, 0) as today_orders, coalesce(td.amt, 0) as today_amount,
       c.company
  from customers c
  join customer_accounts a on a.customer_id = c.id
  left join departments d on d.id = c.department_id
  left join lateral (select sum(o.total - o.paid_amount) as unpaid, count(*) as unpaid_count
                       from orders o where o.customer_id = c.id and o.fulfillment_status <> 'CANCELLED'
                        and o.payment_status in ('UNPAID','PARTIALLY_PAID')) u on true
  left join lateral (select count(*) as cnt, sum(o.total) as amt from orders o
                      where o.customer_id = c.id and o.business_date = business_today()
                        and o.fulfillment_status <> 'CANCELLED') td on true;

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

-- ---------- POS hints follow the consumer ----------
create or replace function pos_hints(p_customer_id bigint default null)
returns jsonb language plpgsql stable security definer set search_path = public as $h$
declare res jsonb; v_last bigint;
begin
  perform require_perm('pos.create_order');
  res := jsonb_build_object(
    'popular', (select coalesce(jsonb_agg(jsonb_build_object('variant_id', variant_id, 'qty', q) order by q desc), '[]')
                  from (select i.variant_id, sum(i.qty) as q
                          from order_items i join orders o on o.id = i.order_id
                         where o.business_date >= business_today() - 30 and o.fulfillment_status <> 'CANCELLED'
                         group by i.variant_id order by 2 desc limit 30) x),
    'recent_customers', (select coalesce(jsonb_agg(to_jsonb(s) order by x.last_id desc), '[]')
                           from (select consumer_id, max(id) as last_id from orders
                                  where consumer_id is not null and business_date >= business_today() - 7
                                    and fulfillment_status <> 'CANCELLED'
                                  group by consumer_id order by max(id) desc limit 8) x
                           join v_customer_summary s on s.id = x.consumer_id
                          where s.status = 'ACTIVE' and s.customer_type <> 'DEPARTMENT'));
  if p_customer_id is not null then
    select id into v_last from orders
     where consumer_id = p_customer_id and fulfillment_status <> 'CANCELLED'
     order by id desc limit 1;
    if v_last is not null then
      res := res || jsonb_build_object('last_order', (
        select jsonb_build_object('order_no', o.order_no, 'created_at', o.created_at,
                 'payer_id', o.customer_id,
                 'items', (select coalesce(jsonb_agg(jsonb_build_object(
                                   'variant_id', i.variant_id, 'qty', i.qty, 'notes', i.notes,
                                   'addons', (select coalesce(jsonb_agg(ia.addon_id), '[]') from order_item_addons ia where ia.order_item_id = i.id))
                                   order by i.id), '[]')
                             from order_items i where i.order_id = o.id))
          from orders o where o.id = v_last));
    end if;
  end if;
  return res;
end $h$;

-- ---------- Buffet may take cash (can be switched off in Settings) ----------
insert into app_settings (key, value) values ('buffet_cash', 'true') on conflict (key) do nothing;

-- ---------- create_order with p_consumer_id ----------
drop function if exists create_order(jsonb, bigint, text, numeric, text, uuid, boolean);

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
  v_bal_after numeric; v_extra numeric := 0; v_dep_txn bigint; v_dep_no text; v_settled int := 0;
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
                                       'deposit', v_extra, 'deposit_receipt', v_dep_no));
  return jsonb_build_object('order_id', v_order, 'order_no', v_no, 'total', v_total,
                            'cash', v_cash, 'account', v_rest,
                            'deposit', v_extra, 'deposit_receipt', v_dep_no, 'settled_orders', v_settled,
                            'paid', (select paid_amount from orders where id = v_order),
                            'balance', v_bal_after,
                            'warnings', _negative_warnings(v_loc, v_mats));
end $$;



revoke execute on function create_order(jsonb, bigint, text, numeric, text, uuid, boolean, bigint) from public, anon;
grant execute on function create_order(jsonb, bigint, text, numeric, text, uuid, boolean, bigint) to authenticated;
