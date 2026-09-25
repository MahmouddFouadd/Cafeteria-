-- =====================================================================
--  014_collection.sql — reception collection list + reception runs the store.
--  Run once after 013.
-- =====================================================================
set search_path = public, extensions;

-- Everyone (people and department accounts) who owes money, with the age of the debt
create or replace view v_receivables with (security_invoker = true) as
select s.id, s.code, s.full_name, s.customer_type, s.department_id, s.department_ar, s.department_en,
       s.company, s.status, s.balance, -s.balance as due,
       s.unpaid_count, s.unpaid_amount,
       u.oldest_unpaid, u.last_order_at,
       (business_today() - u.oldest_unpaid) as days_open
  from v_customer_summary s
  left join lateral (
    select min(o.business_date) filter (where o.payment_status in ('UNPAID','PARTIALLY_PAID')) as oldest_unpaid,
           max(o.created_at) as last_order_at
      from orders o
     where o.customer_id = s.id and o.fulfillment_status <> 'CANCELLED') u on true
 where s.balance < 0;

grant select on v_receivables to authenticated;

-- Reception (Mary) also keeps the store
insert into role_permissions (role_id, permission_code)
select r.id, p from roles r,
       unnest(array['inventory.view','inventory.materials','inventory.purchase','inventory.transfer',
                    'inventory.issue','inventory.waste','inventory.adjust','reports.inventory']) as p
 where r.code = 'RECEPTION'
on conflict do nothing;
