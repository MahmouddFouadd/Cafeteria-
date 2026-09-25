-- =====================================================================
--  010_dashboard.sql — one call that feeds the home dashboard.
--  Each section is returned only if the caller has the matching permission.
--  Run once after 009.
-- =====================================================================
set search_path = public, extensions;

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
        'refunds',      coalesce(sum(amount) filter (where direction = 'OUT'), 0),
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

revoke execute on function dashboard_summary(date) from public, anon;
grant execute on function dashboard_summary(date) to authenticated;
