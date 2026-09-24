-- =====================================================================
--  006_inventory_rpc.sql — Phase 2: stock documents & recipe versions
--  All functions are transactional: any error rolls back the whole call.
--  Items are passed as JSON arrays from the UI.
-- =====================================================================
set search_path = public, extensions;

-- ---------------------------------------------------------------------
-- Internal helpers
-- ---------------------------------------------------------------------
create or replace function _assert_location(p_location bigint) returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if not exists (select 1 from stock_locations where id = p_location and active) then
    raise exception 'LOCATION_INVALID:%', p_location;
  end if;
end $$;

create or replace function _assert_material(p_material bigint) returns materials
language plpgsql stable security definer set search_path = public as $$
declare m materials;
begin
  select * into m from materials where id = p_material;
  if not found or not m.active then
    raise exception 'MATERIAL_INVALID:%', p_material;
  end if;
  return m;
end $$;

create or replace function _assert_items(p_items jsonb) returns void
language plpgsql immutable as $$
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'ITEMS_REQUIRED';
  end if;
end $$;

create or replace function _inv_move(p_material bigint, p_location bigint, p_type text,
                                     p_qty_base numeric, p_qty_entered numeric, p_unit bigint,
                                     p_unit_cost numeric, p_ref_type text, p_ref_id bigint,
                                     p_notes text default null, p_reversal_of bigint default null)
returns bigint language plpgsql security definer set search_path = public as $$
declare v_id bigint;
begin
  insert into inventory_transactions (material_id, location_id, movement_type, qty_base, qty_entered,
                                      unit_id, unit_cost, reference_type, reference_id, notes, reversal_of)
  values (p_material, p_location, p_type, p_qty_base, p_qty_entered, p_unit,
          coalesce(p_unit_cost, 0), p_ref_type, p_ref_id, p_notes, p_reversal_of)
  returning id into v_id;
  return v_id;
end $$;

-- Materials of a document that are now negative at a location → UI warning
create or replace function _negative_warnings(p_location bigint, p_materials bigint[]) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('material_id', m.id, 'name_ar', m.name_ar,
                                               'name_en', m.name_en, 'qty', s.qty)), '[]')
    from material_stock s join materials m on m.id = s.material_id
   where s.location_id = p_location and s.material_id = any(p_materials) and s.qty < 0;
$$;

-- ---------------------------------------------------------------------
-- Purchase (into any location, normally MAIN)
-- items: [{material_id, qty, unit_id, unit_cost}]  unit_cost = per entered unit
-- ---------------------------------------------------------------------
create or replace function post_purchase(p_location_id bigint, p_items jsonb,
                                         p_supplier_id bigint default null,
                                         p_invoice_ref text default null,
                                         p_notes text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_id bigint; v_no text; r record; v_base numeric; v_total numeric := 0;
begin
  perform require_perm('inventory.purchase');
  perform _assert_location(p_location_id);
  perform _assert_items(p_items);

  v_no := next_doc_no('PURCHASE');
  insert into purchases (doc_no, supplier_id, location_id, invoice_ref, notes)
  values (v_no, p_supplier_id, p_location_id, p_invoice_ref, p_notes)
  returning id into v_id;

  for r in select * from jsonb_to_recordset(p_items)
             as x(material_id bigint, qty numeric, unit_id bigint, unit_cost numeric) loop
    perform _assert_material(r.material_id);
    if coalesce(r.qty, 0) <= 0 then raise exception 'QTY_INVALID'; end if;
    if coalesce(r.unit_cost, 0) < 0 then raise exception 'COST_INVALID'; end if;
    v_base := to_base_qty(r.material_id, r.unit_id, r.qty);

    insert into purchase_items (purchase_id, material_id, qty, unit_id, qty_base, unit_cost, line_total)
    values (v_id, r.material_id, r.qty, r.unit_id, v_base, coalesce(r.unit_cost, 0),
            round(r.qty * coalesce(r.unit_cost, 0), 2));
    v_total := v_total + round(r.qty * coalesce(r.unit_cost, 0), 2);

    perform _inv_move(r.material_id, p_location_id, 'PURCHASE', v_base, r.qty, r.unit_id,
                      (r.qty * coalesce(r.unit_cost, 0)) / v_base, 'PURCHASE', v_id);
  end loop;

  update purchases set total = v_total where id = v_id;
  perform log_audit('PURCHASE', 'purchases', v_id::text, null,
                    jsonb_build_object('doc_no', v_no, 'total', v_total, 'items', p_items));
  return jsonb_build_object('id', v_id, 'doc_no', v_no, 'total', v_total);
end $$;

-- ---------------------------------------------------------------------
-- Opening balance (only for a material/location with no movements yet)
-- items: [{material_id, qty, unit_id, unit_cost}]
-- ---------------------------------------------------------------------
create or replace function post_opening_balance(p_location_id bigint, p_items jsonb,
                                                p_notes text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r record; v_base numeric; v_count int := 0;
begin
  perform require_perm('inventory.adjust');
  perform _assert_location(p_location_id);
  perform _assert_items(p_items);

  for r in select * from jsonb_to_recordset(p_items)
             as x(material_id bigint, qty numeric, unit_id bigint, unit_cost numeric) loop
    perform _assert_material(r.material_id);
    if coalesce(r.qty, 0) <= 0 then raise exception 'QTY_INVALID'; end if;
    if exists (select 1 from inventory_transactions
                where material_id = r.material_id and location_id = p_location_id) then
      raise exception 'OPENING_BALANCE_EXISTS:material=%', r.material_id;
    end if;
    v_base := to_base_qty(r.material_id, r.unit_id, r.qty);
    perform _inv_move(r.material_id, p_location_id, 'OPENING_BALANCE', v_base, r.qty, r.unit_id,
                      (r.qty * coalesce(r.unit_cost, 0)) / v_base, 'OPENING', null, p_notes);
    v_count := v_count + 1;
  end loop;

  perform log_audit('OPENING_BALANCE', 'stock_locations', p_location_id::text, null, p_items, p_notes);
  return jsonb_build_object('lines', v_count);
end $$;

-- ---------------------------------------------------------------------
-- Transfer between locations (MAIN → BUFFET)
-- items: [{material_id, qty, unit_id}]
-- ---------------------------------------------------------------------
create or replace function post_transfer(p_from_location_id bigint, p_to_location_id bigint,
                                         p_items jsonb, p_notes text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_id bigint; v_no text; r record; v_base numeric; m materials; v_mats bigint[] := '{}';
begin
  perform require_perm('inventory.transfer');
  perform _assert_location(p_from_location_id);
  perform _assert_location(p_to_location_id);
  if p_from_location_id = p_to_location_id then raise exception 'SAME_LOCATION'; end if;
  perform _assert_items(p_items);

  v_no := next_doc_no('TRANSFER');
  insert into stock_transfers (doc_no, from_location_id, to_location_id, notes)
  values (v_no, p_from_location_id, p_to_location_id, p_notes)
  returning id into v_id;

  for r in select * from jsonb_to_recordset(p_items)
             as x(material_id bigint, qty numeric, unit_id bigint) loop
    m := _assert_material(r.material_id);
    if coalesce(r.qty, 0) <= 0 then raise exception 'QTY_INVALID'; end if;
    v_base := to_base_qty(r.material_id, r.unit_id, r.qty);

    insert into stock_transfer_items (transfer_id, material_id, qty, unit_id, qty_base)
    values (v_id, r.material_id, r.qty, r.unit_id, v_base);

    perform _inv_move(r.material_id, p_from_location_id, 'TRANSFER', -v_base, r.qty, r.unit_id,
                      m.avg_cost, 'TRANSFER', v_id);
    perform _inv_move(r.material_id, p_to_location_id,   'TRANSFER',  v_base, r.qty, r.unit_id,
                      m.avg_cost, 'TRANSFER', v_id);
    v_mats := v_mats || r.material_id;
  end loop;

  perform log_audit('TRANSFER', 'stock_transfers', v_id::text, null,
                    jsonb_build_object('doc_no', v_no, 'items', p_items));
  return jsonb_build_object('id', v_id, 'doc_no', v_no,
                            'warnings', _negative_warnings(p_from_location_id, v_mats));
end $$;

-- ---------------------------------------------------------------------
-- Issue for use (sugar bag, cup packet …) — ISSUE-mode materials only
-- items: [{material_id, qty, unit_id}]
-- ---------------------------------------------------------------------
create or replace function post_issue(p_location_id bigint, p_items jsonb,
                                      p_issued_to text default null, p_notes text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_id bigint; v_no text; r record; v_base numeric; m materials; v_mats bigint[] := '{}';
begin
  perform require_perm('inventory.issue');
  perform _assert_location(p_location_id);
  perform _assert_items(p_items);

  v_no := next_doc_no('ISSUE');
  insert into stock_issues (doc_no, location_id, issued_to, notes)
  values (v_no, p_location_id, p_issued_to, p_notes)
  returning id into v_id;

  for r in select * from jsonb_to_recordset(p_items)
             as x(material_id bigint, qty numeric, unit_id bigint) loop
    m := _assert_material(r.material_id);
    if m.consumption_mode <> 'ISSUE' then
      raise exception 'MATERIAL_NOT_ISSUE_MODE:%', m.code;   -- recipe materials are consumed by orders
    end if;
    if coalesce(r.qty, 0) <= 0 then raise exception 'QTY_INVALID'; end if;
    v_base := to_base_qty(r.material_id, r.unit_id, r.qty);

    insert into stock_issue_items (issue_id, material_id, qty, unit_id, qty_base)
    values (v_id, r.material_id, r.qty, r.unit_id, v_base);

    perform _inv_move(r.material_id, p_location_id, 'CONSUMPTION', -v_base, r.qty, r.unit_id,
                      m.avg_cost, 'ISSUE', v_id);
    v_mats := v_mats || r.material_id;
  end loop;

  perform log_audit('ISSUE', 'stock_issues', v_id::text, null,
                    jsonb_build_object('doc_no', v_no, 'issued_to', p_issued_to, 'items', p_items));
  return jsonb_build_object('id', v_id, 'doc_no', v_no,
                            'warnings', _negative_warnings(p_location_id, v_mats));
end $$;

-- ---------------------------------------------------------------------
-- Waste
-- items: [{material_id, qty, unit_id}]
-- ---------------------------------------------------------------------
create or replace function post_waste(p_location_id bigint, p_reason_code text, p_items jsonb,
                                      p_notes text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_id bigint; v_no text; r record; v_base numeric; m materials; v_mats bigint[] := '{}';
begin
  perform require_perm('inventory.waste');
  perform _assert_location(p_location_id);
  perform _assert_items(p_items);
  if p_reason_code = 'OTHER' and coalesce(trim(p_notes), '') = '' then
    raise exception 'NOTES_REQUIRED';
  end if;

  v_no := next_doc_no('WASTE');
  insert into waste_records (doc_no, location_id, reason_code, notes)
  values (v_no, p_location_id, p_reason_code, p_notes)
  returning id into v_id;

  for r in select * from jsonb_to_recordset(p_items)
             as x(material_id bigint, qty numeric, unit_id bigint) loop
    m := _assert_material(r.material_id);
    if coalesce(r.qty, 0) <= 0 then raise exception 'QTY_INVALID'; end if;
    v_base := to_base_qty(r.material_id, r.unit_id, r.qty);

    insert into waste_items (waste_id, material_id, qty, unit_id, qty_base, unit_cost)
    values (v_id, r.material_id, r.qty, r.unit_id, v_base, m.avg_cost);

    perform _inv_move(r.material_id, p_location_id, 'WASTE', -v_base, r.qty, r.unit_id,
                      m.avg_cost, 'WASTE', v_id, p_reason_code);
    v_mats := v_mats || r.material_id;
  end loop;

  perform log_audit('WASTE', 'waste_records', v_id::text, null,
                    jsonb_build_object('doc_no', v_no, 'reason', p_reason_code, 'items', p_items), p_notes);
  return jsonb_build_object('id', v_id, 'doc_no', v_no,
                            'warnings', _negative_warnings(p_location_id, v_mats));
end $$;

-- ---------------------------------------------------------------------
-- Reverse a posted stock document (audit-safe, never deletes)
-- p_doc_type: PURCHASE | TRANSFER | ISSUE | WASTE
-- ---------------------------------------------------------------------
create or replace function reverse_stock_document(p_doc_type text, p_doc_id bigint, p_reason text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_status text; t record; v_count int := 0;
begin
  perform require_perm('inventory.adjust');
  if coalesce(trim(p_reason), '') = '' then raise exception 'REASON_REQUIRED'; end if;

  case p_doc_type
    when 'PURCHASE' then select status into v_status from purchases       where id = p_doc_id for update;
    when 'TRANSFER' then select status into v_status from stock_transfers where id = p_doc_id for update;
    when 'ISSUE'    then select status into v_status from stock_issues    where id = p_doc_id for update;
    when 'WASTE'    then select status into v_status from waste_records   where id = p_doc_id for update;
    else raise exception 'DOC_TYPE_INVALID:%', p_doc_type;
  end case;
  if v_status is null then raise exception 'DOC_NOT_FOUND'; end if;
  if v_status <> 'POSTED' then raise exception 'DOC_NOT_POSTED:%', v_status; end if;

  for t in select * from inventory_transactions
            where reference_type = p_doc_type and reference_id = p_doc_id and reversal_of is null
              and not exists (select 1 from inventory_transactions x where x.reversal_of = inventory_transactions.id)
  loop
    perform _inv_move(t.material_id, t.location_id, t.movement_type, -t.qty_base, t.qty_entered, t.unit_id,
                      t.unit_cost, t.reference_type, t.reference_id, 'REVERSAL: ' || p_reason, t.id);
    v_count := v_count + 1;
  end loop;

  case p_doc_type
    when 'PURCHASE' then update purchases set status = 'REVERSED', reversed_by = auth.uid(),
                                               reversed_at = now(), reverse_reason = p_reason where id = p_doc_id;
    when 'TRANSFER' then update stock_transfers set status = 'REVERSED' where id = p_doc_id;
    when 'ISSUE'    then update stock_issues    set status = 'REVERSED' where id = p_doc_id;
    when 'WASTE'    then update waste_records   set status = 'REVERSED' where id = p_doc_id;
  end case;

  perform log_audit('REVERSE_' || p_doc_type,
                    case p_doc_type when 'PURCHASE' then 'purchases' when 'TRANSFER' then 'stock_transfers'
                                    when 'ISSUE' then 'stock_issues' else 'waste_records' end,
                    p_doc_id::text, null,
                    jsonb_build_object('lines', v_count), p_reason);
  return jsonb_build_object('reversed_lines', v_count);
end $$;

-- ---------------------------------------------------------------------
-- Stock count: create (snapshot) → save counts → post (adjustments)
-- ---------------------------------------------------------------------
create or replace function create_stock_count(p_location_id bigint, p_notes text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_id bigint; v_no text;
begin
  perform require_perm('inventory.adjust');
  perform _assert_location(p_location_id);
  if exists (select 1 from stock_counts where location_id = p_location_id and status = 'DRAFT') then
    raise exception 'DRAFT_COUNT_EXISTS';
  end if;

  v_no := next_doc_no('COUNT');
  insert into stock_counts (doc_no, location_id, notes) values (v_no, p_location_id, p_notes)
  returning id into v_id;

  insert into stock_count_items (count_id, material_id, system_qty, counted_qty)
  select v_id, m.id, coalesce(s.qty, 0), greatest(coalesce(s.qty, 0), 0)
    from materials m
    left join material_stock s on s.material_id = m.id and s.location_id = p_location_id
   where m.active and m.track_stock;

  return jsonb_build_object('id', v_id, 'doc_no', v_no);
end $$;

-- items: [{material_id, counted_qty}]  (base unit)
create or replace function save_stock_count(p_count_id bigint, p_items jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare r record;
begin
  perform require_perm('inventory.adjust');
  if not exists (select 1 from stock_counts where id = p_count_id and status = 'DRAFT') then
    raise exception 'COUNT_NOT_DRAFT';
  end if;
  for r in select * from jsonb_to_recordset(p_items) as x(material_id bigint, counted_qty numeric) loop
    if coalesce(r.counted_qty, -1) < 0 then raise exception 'QTY_INVALID'; end if;
    update stock_count_items set counted_qty = r.counted_qty
     where count_id = p_count_id and material_id = r.material_id;
  end loop;
end $$;

create or replace function post_stock_count(p_count_id bigint)
returns jsonb language plpgsql security definer set search_path = public as $$
declare c stock_counts; r record; v_count int := 0;
begin
  perform require_perm('inventory.adjust');
  select * into c from stock_counts where id = p_count_id for update;
  if not found or c.status <> 'DRAFT' then raise exception 'COUNT_NOT_DRAFT'; end if;

  -- Re-read system qty at posting time (orders may have consumed stock since the snapshot)
  update stock_count_items i
     set system_qty = coalesce((select qty from material_stock s
                                 where s.material_id = i.material_id and s.location_id = c.location_id), 0)
   where i.count_id = p_count_id;

  for r in select i.material_id, i.diff_qty, m.avg_cost, m.base_unit_id
             from stock_count_items i join materials m on m.id = i.material_id
            where i.count_id = p_count_id and i.diff_qty <> 0 loop
    perform _inv_move(r.material_id, c.location_id, 'ADJUSTMENT', r.diff_qty, r.diff_qty, r.base_unit_id,
                      r.avg_cost, 'COUNT', p_count_id);
    v_count := v_count + 1;
  end loop;

  update stock_counts set status = 'POSTED', posted_by = auth.uid(), posted_at = now() where id = p_count_id;
  perform log_audit('STOCK_COUNT', 'stock_counts', p_count_id::text, null,
                    jsonb_build_object('doc_no', c.doc_no, 'adjusted_lines', v_count));
  return jsonb_build_object('adjusted_lines', v_count);
end $$;

-- ---------------------------------------------------------------------
-- Recipes: every save creates a new version
-- items: [{material_id, quantity, unit_id}]   (empty array = no consumption)
-- ---------------------------------------------------------------------
create or replace function save_recipe(p_variant_id bigint, p_items jsonb, p_notes text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_old jsonb; v_ver int; v_id bigint; r record;
begin
  perform require_perm('recipes.manage');
  if not exists (select 1 from product_variants where id = p_variant_id) then
    raise exception 'VARIANT_NOT_FOUND';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' then raise exception 'ITEMS_REQUIRED'; end if;

  select coalesce(jsonb_agg(jsonb_build_object('material_id', ri.material_id,
                                               'quantity', ri.quantity, 'unit_id', ri.unit_id)), '[]')
    into v_old
    from recipes rc join recipe_items ri on ri.recipe_id = rc.id
   where rc.variant_id = p_variant_id and rc.is_current;

  select coalesce(max(version), 0) + 1 into v_ver from recipes where variant_id = p_variant_id;
  update recipes set is_current = false where variant_id = p_variant_id and is_current;
  insert into recipes (variant_id, version, is_current, notes)
  values (p_variant_id, v_ver, true, p_notes) returning id into v_id;

  for r in select * from jsonb_to_recordset(p_items)
             as x(material_id bigint, quantity numeric, unit_id bigint) loop
    perform _assert_material(r.material_id);
    if coalesce(r.quantity, 0) <= 0 then raise exception 'QTY_INVALID'; end if;
    perform to_base_qty(r.material_id, r.unit_id, r.quantity);   -- fails if no conversion
    insert into recipe_items (recipe_id, material_id, quantity, unit_id)
    values (v_id, r.material_id, r.quantity, r.unit_id);
  end loop;

  perform log_audit('RECIPE_CHANGE', 'product_variants', p_variant_id::text, v_old, p_items, p_notes);
  return jsonb_build_object('recipe_id', v_id, 'version', v_ver);
end $$;

-- Material cost of the current recipe of each variant (for margin screens)
create or replace view v_variant_cost with (security_invoker = true) as
select pv.id as variant_id, pv.code, p.name_ar as product_name_ar, p.name_en as product_name_en,
       pv.name_ar as variant_name_ar, pv.name_en as variant_name_en, pv.price, pv.active,
       rc.id as recipe_id, rc.version,
       round(coalesce(sum(case when m.track_stock
                               then ri.quantity * coalesce(mu.factor_to_base, 1) * m.avg_cost end), 0), 4)
         as material_cost,
       round(pv.price - coalesce(sum(case when m.track_stock
                               then ri.quantity * coalesce(mu.factor_to_base, 1) * m.avg_cost end), 0), 2)
         as gross_margin
  from product_variants pv
  join products p on p.id = pv.product_id
  left join recipes rc on rc.variant_id = pv.id and rc.is_current
  left join recipe_items ri on ri.recipe_id = rc.id
  left join materials m on m.id = ri.material_id
  left join material_units mu on mu.material_id = ri.material_id and mu.unit_id = ri.unit_id
 group by pv.id, p.id, rc.id;

-- ---------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------
revoke execute on function _assert_location(bigint), _assert_material(bigint), _assert_items(jsonb),
  _inv_move(bigint,bigint,text,numeric,numeric,bigint,numeric,text,bigint,text,bigint),
  _negative_warnings(bigint,bigint[]) from public, anon, authenticated;

grant execute on function
  post_purchase(bigint,jsonb,bigint,text,text),
  post_opening_balance(bigint,jsonb,text),
  post_transfer(bigint,bigint,jsonb,text),
  post_issue(bigint,jsonb,text,text),
  post_waste(bigint,text,jsonb,text),
  reverse_stock_document(text,bigint,text),
  create_stock_count(bigint,text),
  save_stock_count(bigint,jsonb),
  post_stock_count(bigint),
  save_recipe(bigint,jsonb,text)
to authenticated;
revoke execute on function
  post_purchase(bigint,jsonb,bigint,text,text), post_opening_balance(bigint,jsonb,text),
  post_transfer(bigint,bigint,jsonb,text), post_issue(bigint,jsonb,text,text),
  post_waste(bigint,text,jsonb,text), reverse_stock_document(text,bigint,text),
  create_stock_count(bigint,text), save_stock_count(bigint,jsonb), post_stock_count(bigint),
  save_recipe(bigint,jsonb,text)
from anon, public;
