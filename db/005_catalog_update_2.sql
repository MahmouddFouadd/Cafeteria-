-- =====================================================================
--  005_catalog_update_2.sql — milk carton, bottled water, hibiscus price
--  Run once after 004.
-- =====================================================================
set search_path = public, extensions;

-- Items sold as-is (one piece per sale). Units per packet are entered
-- later by the storekeeper from the UI (material_units → packet).
insert into materials (code, name_ar, name_en, category_id, base_unit_id, consumption_mode, track_stock)
select v.code, v.name_ar, v.name_en, c.id, u.id, 'RECIPE', true
  from (values
    ('MILK_CARTON',  'لبن جهينة صغير (علبة)', 'Juhayna milk carton (small)', 'ألبان'),
    ('WATER_BOTTLE', 'مياه (زجاجة)',          'Water bottle',                'مستلزمات')
  ) as v(code, name_ar, name_en, cat)
  join material_categories c on c.name_ar = v.cat
  join units u on u.code = 'pc';

-- Milk product = 1 carton, Water product = 1 bottle.
-- (Tap water inside hot drinks stays untracked — material WATER.)
insert into recipe_items (recipe_id, material_id, quantity, unit_id)
select r.id, m.id, 1, (select id from units where code = 'pc')
  from (values ('MILK','MILK_CARTON'), ('WATER','WATER_BOTTLE')) as v(variant, mat)
  join product_variants pv on pv.code = v.variant
  join recipes r on r.variant_id = pv.id and r.is_current
  join materials m on m.code = v.mat;

-- Rename the products so they read as packaged items
update products set name_ar = 'لبن جهينة', name_en = 'Juhayna Milk' where code = 'MILK';
update products set name_ar = 'مياه زجاجة', name_en = 'Bottled Water' where code = 'WATER';

-- A carton of milk / bottle of water takes no add-ons
delete from variant_addons
 where variant_id in (select id from product_variants where code in ('MILK','WATER'));

-- Hibiscus: 15 EGP, active
update product_variants set price = 15, active = true where code = 'HIBISCUS';
