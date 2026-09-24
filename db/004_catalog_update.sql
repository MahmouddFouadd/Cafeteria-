-- =====================================================================
--  004_catalog_update.sql — catalog data from the manager's answers
--  Safe to run once, right after 003 (before any orders exist).
-- =====================================================================
set search_path = public, extensions;

-- ---------- Sugar: 1 bag = 1 kg ----------
insert into material_units (material_id, unit_id, factor_to_base, is_purchase_unit)
select m.id, u.id, 1000, true
  from materials m, units u
 where m.code = 'SUGAR' and u.code = 'bag'
on conflict (material_id, unit_id) do update
  set factor_to_base = excluded.factor_to_base, is_purchase_unit = true;

-- ---------- Cappuccino is a ready sachet (count per box set later from the UI) ----------
update materials
   set code = 'CAPP_SACHET',
       name_ar = 'كابتشينو (ظرف)', name_en = 'Cappuccino sachet',
       base_unit_id = (select id from units where code = 'pc')
 where code = 'CAPP_POWDER';

-- ---------- Ready sachet drinks: anise, hibiscus ----------
insert into materials (code, name_ar, name_en, category_id, base_unit_id, consumption_mode, track_stock)
select v.code, v.name_ar, v.name_en, c.id, u.id, 'RECIPE', true
  from (values
    ('ANISE_SACHET',    'ينسون (ظرف)',  'Anise sachet'),
    ('HIBISCUS_SACHET', 'كركديه (ظرف)', 'Hibiscus sachet')
  ) as v(code, name_ar, name_en)
  join material_categories c on c.name_ar = 'مشروبات ساخنة'
  join units u on u.code = 'pc';

-- ---------- Hibiscus product (price not set yet → inactive) ----------
insert into products (code, category_id, name_ar, name_en, sort)
select 'HIBISCUS', id, 'كركديه', 'Hibiscus', 8 from product_categories where name_ar = 'مشروبات ساخنة';

insert into product_variants (code, product_id, name_ar, name_en, price, sort, active)
select 'HIBISCUS', id, 'عادي', 'Regular', 0, 1, false from products where code = 'HIBISCUS';

insert into recipes (variant_id, version, is_current, notes)
select id, 1, true, 'Starter recipe' from product_variants where code = 'HIBISCUS';

-- ---------- Recipes: one sachet per cup ----------
insert into recipe_items (recipe_id, material_id, quantity, unit_id)
select r.id, m.id, 1, (select id from units where code = 'pc')
  from (values ('CAPPUCCINO','CAPP_SACHET'),
               ('ANISE',     'ANISE_SACHET'),
               ('HIBISCUS',  'HIBISCUS_SACHET')) as v(variant, mat)
  join product_variants pv on pv.code = v.variant
  join recipes r on r.variant_id = pv.id and r.is_current
  join materials m on m.code = v.mat;

-- ---------- Prices (editable later from the UI) ----------
update product_variants pv
   set price = v.price, active = true
  from (values ('COFFEE_MILK_S', 35), ('COFFEE_MILK_D', 50),
               ('TEA', 15), ('TEA_MILK', 30), ('ANISE', 20),
               ('MILK', 15), ('WATER', 10)) as v(code, price)
 where pv.code = v.code;

-- ---------- No chocolate add-on in the company ----------
delete from variant_addons where addon_id = (select id from addons where code = 'EXTRA_CHOC');
delete from addons where code = 'EXTRA_CHOC';

-- Sugar options on hibiscus
insert into variant_addons (variant_id, addon_id)
select pv.id, a.id
  from product_variants pv, addons a
 where pv.code = 'HIBISCUS' and a.code in ('EXTRA_SUGAR','NO_SUGAR');

-- Cups per packet and sachets per box are entered by the storekeeper
-- per material from the UI (material_units), since they vary by supplier.
