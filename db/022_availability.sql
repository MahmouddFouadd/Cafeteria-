-- =====================================================================
--  022_availability.sql — the employee app says "not available now" when a
--  drink's ingredients are out in BOTH the buffet store and the main store.
--  Only materials that are actually tracked (have stock records) count, so
--  items you never entered stock for are not blocked.   Run once after 021.
-- =====================================================================
set search_path = public, extensions;

-- stock left for a material across all active stores (null = never had stock records)
create or replace function material_total_stock(p_material bigint) returns numeric
language sql stable security definer set search_path = public as $$
  select case when exists (select 1 from material_stock where material_id = p_material)
              then (select coalesce(sum(s.qty), 0) from material_stock s join stock_locations l on l.id = s.location_id and l.active
                     where s.material_id = p_material) end;
$$;

-- what a variant needs per cup, in base units (current recipe)
create or replace function _variant_needs(p_variant_id bigint)
returns table (material_id bigint, qty numeric) language sql stable security definer set search_path = public as $$
  select ri.material_id, sum(ri.quantity * coalesce(mu.factor_to_base, 1))
    from recipes r
    join recipe_items ri on ri.recipe_id = r.id
    join materials m on m.id = ri.material_id and m.track_stock
    left join material_units mu on mu.material_id = ri.material_id and mu.unit_id = ri.unit_id and ri.unit_id <> m.base_unit_id
   where r.variant_id = p_variant_id and r.is_current
   group by ri.material_id;
$$;

-- first missing ingredient for p_qty cups of a variant, or null when it can be made
create or replace function variant_shortage(p_variant_id bigint, p_qty int default 1) returns text
language sql stable security definer set search_path = public as $$
  select m.name_ar
    from _variant_needs(p_variant_id) n
    join materials m on m.id = n.material_id
   where material_total_stock(n.material_id) is not null
     and material_total_stock(n.material_id) < n.qty * greatest(p_qty, 1)
   limit 1;
$$;

-- whole order (items share ingredients: two teas need two tea bags); returns the drink's name
create or replace function order_shortage(p_items jsonb) returns text
language plpgsql stable security definer set search_path = public as $$
declare r record;
begin
  for r in
    with items as (select (e->>'variant_id')::bigint as variant_id, greatest(coalesce((e->>'qty')::int, 1), 1) as qty
                     from jsonb_array_elements(coalesce(p_items, '[]')) e),
         needs as (select n.material_id, sum(n.qty * i.qty) as qty, min(i.variant_id) as variant_id
                     from items i cross join lateral _variant_needs(i.variant_id) n group by n.material_id)
    select p.name_ar as product, pv.name_ar as variant, pv.name_en as variant_en
      from needs x
      join product_variants pv on pv.id = x.variant_id
      join products p on p.id = pv.product_id
     where material_total_stock(x.material_id) is not null and material_total_stock(x.material_id) < x.qty
     limit 1
  loop
    return r.product || case when coalesce(r.variant_en, '') <> 'Regular' then ' ' || r.variant else '' end;
  end loop;
  return null;
end $$;

revoke execute on function material_total_stock(bigint), _variant_needs(bigint), order_shortage(jsonb) from public, anon;
grant execute on function variant_shortage(bigint, int) to authenticated;

-- the app menu carries "available" per size, and ordering checks the stock first
create or replace function self_menu() returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform _self_customer();
  return jsonb_build_object(
    'categories', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name_ar', name_ar) order by sort, id), '[]') from product_categories where active),
    'products', (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'category_id', p.category_id, 'name_ar', p.name_ar,
                    'variants', (select jsonb_agg(jsonb_build_object('id', v.id, 'name_ar', v.name_ar, 'name_en', v.name_en, 'price', v.price,
                                                                     'available', variant_shortage(v.id, 1) is null) order by v.sort, v.id)
                                   from product_variants v where v.product_id = p.id and v.active and not v.open_price)) order by p.sort, p.id), '[]')
                   from products p where p.active and exists (select 1 from product_variants v where v.product_id = p.id and v.active and not v.open_price)),
    'addons', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name_ar', name_ar, 'price', price) order by sort), '[]') from addons where active),
    'variant_addons', (select coalesce(jsonb_agg(jsonb_build_object('variant_id', variant_id, 'addon_id', addon_id)), '[]') from variant_addons));
end $$;


create or replace function self_create_order(p_items jsonb, p_pay text default 'ACCOUNT', p_notes text default null,
                                             p_idempotency_key uuid default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_cid bigint := _self_customer(); v_pay text := upper(coalesce(p_pay, 'ACCOUNT')); res jsonb; v_short text;
begin
  if coalesce((select value::text from app_settings where key = 'self_order_enabled'), 'true') = 'false' then
    raise exception 'SELF_ORDERING_OFF';
  end if;
  if v_pay not in ('ACCOUNT','CASH') then raise exception 'SELF_PAY_INVALID'; end if;
  if exists (select 1 from jsonb_array_elements(coalesce(p_items, '[]')) e
              join product_variants v on v.id = (e->>'variant_id')::bigint where v.open_price) then
    raise exception 'SELF_ITEM_NOT_ALLOWED';
  end if;
  -- nothing left in the buffet store or the main store → "not available now"
  v_short := order_shortage(p_items);
  if v_short is not null then raise exception 'SELF_OUT_OF_STOCK:%', v_short; end if;
  if (select count(*) from orders where consumer_id = v_cid and source = 'SELF'
        and fulfillment_status in ('NEW','PREPARING','READY')) >= 3 then
    raise exception 'SELF_TOO_MANY_OPEN';
  end if;
  perform set_config('app.self_order', '1', true);        -- lets create_order run for this one call
  res := create_order(p_items, v_cid, null, 0, p_notes, p_idempotency_key, false, v_cid);
  perform set_config('app.self_order', '', true);
  update orders set source = 'SELF', pay_request = v_pay, device_uid = auth.uid()
   where id = (res->>'order_id')::bigint and source = 'STAFF';
  update self_devices set orders_count = orders_count + 1, last_seen = now() where device_uid = auth.uid();
  return res || jsonb_build_object('pay_request', v_pay);
end $$;

