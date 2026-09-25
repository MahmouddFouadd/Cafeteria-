-- =====================================================================
--  015_reports.sql — one reporting function for the Reports screen.
--  report(kind, from, to) → jsonb array of rows. Each kind checks its permission.
--  Run once after 014.
-- =====================================================================
set search_path = public, extensions;

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
             sum(amount) filter (where direction = 'OUT')                        as refunds
        from payments where business_date between f and t group by created_by),
    ids as (select uid from created union select uid from served union select uid from cash)
    select coalesce(jsonb_agg(jsonb_build_object(
             'name', coalesce(u.full_name, '—'), 'orders', coalesce(c.orders, 0), 'qty', coalesce(c.qty, 0),
             'amount', coalesce(c.amount, 0), 'served', coalesce(s.served, 0),
             'cash_orders', coalesce(k.cash_orders, 0), 'deposits', coalesce(k.deposits, 0), 'refunds', coalesce(k.refunds, 0))
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
             'cash_orders', coalesce(p.cash_orders, 0), 'deposits', coalesce(p.deposits, 0), 'refunds', coalesce(p.refunds, 0),
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
                        sum(amount) filter (where direction = 'OUT')                        as refunds
                   from payments where business_date between f and t group by business_date) p on p.business_date = g.day::date;

  elsif p_kind = 'collections' then
    select coalesce(jsonb_agg(jsonb_build_object(
             'at', p.created_at, 'day', p.business_date, 'receipt_no', p.receipt_no, 'purpose', p.purpose,
             'direction', p.direction, 'amount', p.amount, 'customer', c.full_name, 'code', c.code,
             'user', u.full_name, 'notes', p.notes) order by p.id desc), '[]') into res
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

revoke execute on function report(text, date, date) from public, anon;
grant execute on function report(text, date, date) to authenticated;
