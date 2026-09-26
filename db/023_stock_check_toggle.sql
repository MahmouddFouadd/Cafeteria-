-- =====================================================================
--  023_stock_check_toggle.sql — switch the app's "not available" check on/off.
--  Keep it OFF until real stock is entered (opening balance / count),
--  otherwise every drink shows "not available". Run once after 022.
-- =====================================================================
set search_path = public, extensions;

insert into app_settings (key, value) values ('self_stock_check', 'false')
on conflict (key) do update set value = 'false';

create or replace function _stock_check_on() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select value::text from app_settings where key = 'self_stock_check'), 'false') = 'true';
$$;

-- same as 022, but only when the check is switched on
create or replace function variant_shortage(p_variant_id bigint, p_qty int default 1) returns text
language sql stable security definer set search_path = public as $$
  select m.name_ar
    from _variant_needs(p_variant_id) n
    join materials m on m.id = n.material_id
   where _stock_check_on()
     and material_total_stock(n.material_id) is not null
     and material_total_stock(n.material_id) < n.qty * greatest(p_qty, 1)
   limit 1;
$$;

create or replace function order_shortage(p_items jsonb) returns text
language plpgsql stable security definer set search_path = public as $$
declare r record;
begin
  if not _stock_check_on() then return null; end if;
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
