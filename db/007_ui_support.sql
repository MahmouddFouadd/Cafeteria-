-- =====================================================================
--  007_ui_support.sql — views & small RPCs used by the web UI
--  Run once after 006.
-- =====================================================================
set search_path = public, extensions;

-- ---------- User names (visible to any logged-in user; id + name only) ----------
create or replace view v_user_names as
select id, username, full_name from app_users where is_active_user();
grant select on v_user_names to authenticated;

-- ---------- Stock movements with readable names ----------
create or replace view v_inventory_movements with (security_invoker = true) as
select it.id, it.business_date, it.created_at, it.movement_type, it.reference_type, it.reference_id,
       it.qty_base, it.qty_entered, it.unit_cost, round(it.qty_base * it.unit_cost, 2) as value,
       it.notes, it.reversal_of,
       it.material_id, m.code as material_code, m.name_ar as material_name_ar, m.name_en as material_name_en,
       bu.code as base_unit, it.unit_id as entered_unit_id,
       it.location_id, l.code as location_code,
       u.full_name as created_by_name
  from inventory_transactions it
  join materials m        on m.id = it.material_id
  join units bu           on bu.id = m.base_unit_id
  join stock_locations l  on l.id = it.location_id
  left join v_user_names u on u.id = it.created_by;

-- ---------- All stock documents in one list ----------
create or replace view v_stock_documents with (security_invoker = true) as
select d.*, (d.created_at at time zone 'Africa/Cairo')::date as doc_date, u.full_name as created_by_name
  from (
    select 'PURCHASE'::text as doc_type, p.id, p.doc_no, p.created_at, p.status,
           p.location_id, null::bigint as to_location_id, p.total, p.notes, p.created_by,
           (select count(*) from purchase_items i where i.purchase_id = p.id) as lines,
           s.name as party
      from purchases p left join suppliers s on s.id = p.supplier_id
    union all
    select 'TRANSFER', t.id, t.doc_no, t.created_at, t.status,
           t.from_location_id, t.to_location_id, null, t.notes, t.created_by,
           (select count(*) from stock_transfer_items i where i.transfer_id = t.id), null
      from stock_transfers t
    union all
    select 'ISSUE', x.id, x.doc_no, x.created_at, x.status,
           x.location_id, null, null, x.notes, x.created_by,
           (select count(*) from stock_issue_items i where i.issue_id = x.id), x.issued_to
      from stock_issues x
    union all
    select 'WASTE', w.id, w.doc_no, w.created_at, w.status,
           w.location_id, null, null, w.notes, w.created_by,
           (select count(*) from waste_items i where i.waste_id = w.id), w.reason_code
      from waste_records w
  ) d
  left join v_user_names u on u.id = d.created_by;

-- ---------- Price change with a reason (goes to price history + audit) ----------
create or replace function update_variant_price(p_variant_id bigint, p_price numeric, p_reason text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform require_perm('prices.change');
  if p_price is null or p_price < 0 then raise exception 'PRICE_INVALID'; end if;
  perform set_config('app.reason', coalesce(p_reason, ''), true);
  update product_variants set price = p_price where id = p_variant_id;
  if not found then raise exception 'VARIANT_NOT_FOUND'; end if;
end $$;

-- ---------- Add-on consumption (replace all lines atomically) ----------
-- items: [{material_id, quantity, unit_id}]  quantity may be negative
create or replace function save_addon_recipe(p_addon_id bigint, p_items jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare v_old jsonb; r record;
begin
  perform require_perm('catalog.manage');
  if not exists (select 1 from addons where id = p_addon_id) then raise exception 'ADDON_NOT_FOUND'; end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' then raise exception 'ITEMS_REQUIRED'; end if;

  select coalesce(jsonb_agg(jsonb_build_object('material_id', material_id, 'quantity', quantity,
                                               'unit_id', unit_id)), '[]')
    into v_old from addon_recipe_items where addon_id = p_addon_id;

  delete from addon_recipe_items where addon_id = p_addon_id;
  for r in select * from jsonb_to_recordset(p_items)
             as x(material_id bigint, quantity numeric, unit_id bigint) loop
    if coalesce(r.quantity, 0) = 0 then raise exception 'QTY_INVALID'; end if;
    perform to_base_qty(r.material_id, r.unit_id, abs(r.quantity));
    insert into addon_recipe_items (addon_id, material_id, quantity, unit_id)
    values (p_addon_id, r.material_id, r.quantity, r.unit_id);
  end loop;

  perform log_audit('ADDON_RECIPE_CHANGE', 'addons', p_addon_id::text, v_old, p_items);
end $$;

-- ---------- Own language preference ----------
create or replace function set_my_locale(p_locale text)
returns void language sql security definer set search_path = public as $$
  update app_users set locale = p_locale where id = auth.uid() and p_locale in ('ar','en');
$$;

-- ---------- Materials: avg_cost is never set from the client ----------
revoke insert on materials from authenticated;
grant insert (code, name_ar, name_en, category_id, base_unit_id, consumption_mode,
              track_stock, min_stock, active) on materials to authenticated;

-- ---------- Grants ----------
revoke execute on function update_variant_price(bigint,numeric,text), save_addon_recipe(bigint,jsonb),
                           set_my_locale(text) from public, anon;
grant execute on function update_variant_price(bigint,numeric,text), save_addon_recipe(bigint,jsonb),
                          set_my_locale(text) to authenticated;
