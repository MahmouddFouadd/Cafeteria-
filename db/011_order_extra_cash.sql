-- =====================================================================
--  011_order_extra_cash.sql — cash above the order total can go to the
--  employee's account: it pays off what they owe (oldest orders first)
--  and the rest stays as prepaid balance. Run once after 010.
-- =====================================================================
set search_path = public, extensions;

drop function if exists create_order(jsonb, bigint, text, numeric, text, uuid);

create or replace function create_order(p_items jsonb, p_customer_id bigint default null,
                                        p_guest_name text default null, p_cash numeric default 0,
                                        p_notes text default null, p_idempotency_key uuid default null,
                                        p_extra_to_account boolean default false)
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


revoke execute on function create_order(jsonb, bigint, text, numeric, text, uuid, boolean) from public, anon;
grant execute on function create_order(jsonb, bigint, text, numeric, text, uuid, boolean) to authenticated;
