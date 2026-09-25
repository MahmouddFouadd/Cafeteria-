-- =====================================================================
--  012_easier.sql — quicker daily use. Run once after 011.
--   * PIN sign-in flags on users
--   * POS hints: most ordered, recent employees, "same as last time"
--   * Cafeteria role can take cash, record receiving from the main store and waste
-- =====================================================================
set search_path = public, extensions;

-- ---------- PIN flags ----------
alter table app_users add column if not exists pin_enabled boolean not null default false;
alter table app_users add column if not exists pin_length  smallint;

create or replace function my_profile() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
           'id', u.id, 'username', u.username, 'full_name', u.full_name, 'locale', u.locale,
           'pin_enabled', u.pin_enabled, 'pin_length', u.pin_length,
           'role', r.code, 'role_name_ar', r.name_ar, 'role_name_en', r.name_en,
           'permissions',
             case when r.code = 'ADMIN'
                  then (select coalesce(jsonb_agg(code order by code), '[]') from permissions)
                  else (select coalesce(jsonb_agg(permission_code order by permission_code), '[]')
                          from role_permissions where role_id = r.id)
             end)
    from app_users u join roles r on r.id = u.role_id
   where u.id = auth.uid() and u.active;
$$;

-- Called by the app right after the user changes their own password to a PIN.
create or replace function set_my_pin_flag(p_enabled boolean, p_length int default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_active_user() then raise exception 'USER_INACTIVE' using errcode = '42501'; end if;
  if p_enabled and (p_length is null or p_length not between 4 and 6) then raise exception 'PIN_LENGTH'; end if;
  update app_users set pin_enabled = p_enabled, pin_length = case when p_enabled then p_length end
   where id = auth.uid();
  perform log_audit(case when p_enabled then 'PIN_SET' else 'PIN_CLEARED' end, 'app_users', auth.uid()::text);
end $$;

revoke execute on function set_my_pin_flag(boolean, int) from public, anon;
grant execute on function set_my_pin_flag(boolean, int), my_profile() to authenticated;

-- ---------- POS hints ----------
create or replace function pos_hints(p_customer_id bigint default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare res jsonb; v_last bigint;
begin
  perform require_perm('pos.create_order');

  res := jsonb_build_object(
    'popular', (select coalesce(jsonb_agg(jsonb_build_object('variant_id', variant_id, 'qty', q) order by q desc), '[]')
                  from (select i.variant_id, sum(i.qty) as q
                          from order_items i join orders o on o.id = i.order_id
                         where o.business_date >= business_today() - 30 and o.fulfillment_status <> 'CANCELLED'
                         group by i.variant_id order by 2 desc limit 30) x),
    'recent_customers', (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'code', c.code, 'full_name', c.full_name,
                                                                      'balance', a.balance) order by x.last_id desc), '[]')
                           from (select customer_id, max(id) as last_id from orders
                                  where customer_id is not null and business_date >= business_today() - 7
                                    and fulfillment_status <> 'CANCELLED'
                                  group by customer_id order by max(id) desc limit 8) x
                           join customers c on c.id = x.customer_id and c.status = 'ACTIVE'
                           join customer_accounts a on a.customer_id = c.id));

  if p_customer_id is not null then
    select id into v_last from orders
     where customer_id = p_customer_id and fulfillment_status <> 'CANCELLED'
     order by id desc limit 1;
    if v_last is not null then
      res := res || jsonb_build_object('last_order', (
        select jsonb_build_object('order_no', o.order_no, 'created_at', o.created_at,
                 'items', (select coalesce(jsonb_agg(jsonb_build_object(
                                   'variant_id', i.variant_id, 'qty', i.qty, 'notes', i.notes,
                                   'addons', (select coalesce(jsonb_agg(ia.addon_id), '[]') from order_item_addons ia where ia.order_item_id = i.id))
                                   order by i.id), '[]')
                             from order_items i where i.order_id = o.id))
          from orders o where o.id = v_last));
    end if;
  end if;
  return res;
end $$;

revoke execute on function pos_hints(bigint) from public, anon;
grant execute on function pos_hints(bigint) to authenticated;

-- ---------- Cafeteria role: cash + simple stock ----------
insert into role_permissions (role_id, permission_code)
select r.id, p from roles r,
       unnest(array['payments.receive','payments.view','accounts.deposit','accounts.view',
                    'inventory.view','inventory.transfer','inventory.waste']) as p
 where r.code = 'BARISTA'
on conflict do nothing;

-- ---------- Default: order is served in the same tap? (off) ----------
insert into app_settings (key, value) values ('serve_on_create', 'false')
on conflict (key) do nothing;
