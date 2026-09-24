-- =====================================================================
--  003_starter_catalog.sql — starter materials, drinks, recipes, add-ons
--  Taken from the requirement examples. Everything here is editable
--  from the UI. Variants with unknown prices are seeded INACTIVE with
--  price 0 so they cannot be sold until the manager sets a price.
-- =====================================================================
set search_path = public;

-- ---------- Materials ----------
insert into materials (code, name_ar, name_en, category_id, base_unit_id, consumption_mode, track_stock)
select v.code, v.name_ar, v.name_en, c.id, u.id, v.mode, v.track
  from (values
    ('COFFEE_BEANS',  'بن',                'Coffee beans',       'مشروبات ساخنة', 'g',  'RECIPE', true),
    ('MILK',          'لبن',               'Milk',               'ألبان',         'ml', 'RECIPE', true),
    ('TEA_BAG',       'شاي فتلة',          'Tea bags',           'مشروبات ساخنة', 'pc', 'RECIPE', true),
    ('HOT_CHOC',      'شوكولاتة ساخنة (ظرف)','Hot chocolate sachet','مشروبات ساخنة', 'pc', 'RECIPE', true),
    ('CAPP_POWDER',   'بودرة كابتشينو',     'Cappuccino powder',  'مشروبات ساخنة', 'g',  'RECIPE', true),
    ('WATER',         'مياه',              'Water',              'مستلزمات',      'ml', 'RECIPE', false),
    ('SUGAR',         'سكر',               'Sugar',              'مستلزمات',      'g',  'ISSUE',  true),
    ('CUPS',          'أكواب',             'Cups',               'مستلزمات',      'pc', 'ISSUE',  true)
  ) as v(code, name_ar, name_en, cat, unit, mode, track)
  join material_categories c on c.name_ar = v.cat
  join units u on u.code = v.unit;

-- ---------- Unit conversions (only the ones given in the requirements) ----------
insert into material_units (material_id, unit_id, factor_to_base, is_purchase_unit)
select m.id, u.id, v.factor, v.purchase
  from (values
    ('COFFEE_BEANS', 'bag', 500,  true),
    ('COFFEE_BEANS', 'kg',  1000, false),
    ('MILK',         'can', 1000, true),
    ('MILK',         'l',   1000, false),
    ('TEA_BAG',      'box', 100,  true),
    ('SUGAR',        'kg',  1000, false)
  ) as v(mat, unit, factor, purchase)
  join materials m on m.code = v.mat
  join units u on u.code = v.unit;
-- TODO (manager): sugar bag weight, cups per packet, hot-chocolate box size, cappuccino pack size.

-- ---------- Products ----------
insert into products (code, category_id, name_ar, name_en, sort)
select v.code, c.id, v.name_ar, v.name_en, v.sort
  from (values
    ('COFFEE',       'قهوة',          'قهوة',          'Coffee',           1),
    ('COFFEE_MILK',  'قهوة',          'قهوة باللبن',    'Coffee with Milk', 2),
    ('CAPPUCCINO',   'قهوة',          'كابتشينو',      'Cappuccino',       3),
    ('HOT_CHOC',     'مشروبات ساخنة', 'هوت شوكليت',    'Hot Chocolate',    4),
    ('TEA',          'مشروبات ساخنة', 'شاي',           'Tea',              5),
    ('TEA_MILK',     'مشروبات ساخنة', 'شاي باللبن',     'Tea with Milk',    6),
    ('ANISE',        'مشروبات ساخنة', 'ينسون',         'Anise',            7),
    ('MILK',         'أخرى',          'لبن',           'Milk',             8),
    ('WATER',        'أخرى',          'مياه',          'Water',            9)
  ) as v(code, cat, name_ar, name_en, sort)
  join product_categories c on c.name_ar = v.cat;

-- ---------- Variants (known prices active, unknown prices inactive) ----------
insert into product_variants (code, product_id, name_ar, name_en, price, sort, active)
select v.code, p.id, v.name_ar, v.name_en, v.price, v.sort, v.active
  from (values
    ('COFFEE_S',      'COFFEE',      'سينجل', 'Single',  25, 1, true),
    ('COFFEE_D',      'COFFEE',      'دبل',   'Double',  35, 2, true),
    ('COFFEE_MILK_S', 'COFFEE_MILK', 'سينجل', 'Single',   0, 1, false),
    ('COFFEE_MILK_D', 'COFFEE_MILK', 'دبل',   'Double',   0, 2, false),
    ('CAPPUCCINO',    'CAPPUCCINO',  'عادي',  'Regular', 40, 1, true),
    ('HOT_CHOC',      'HOT_CHOC',    'عادي',  'Regular', 45, 1, true),
    ('TEA',           'TEA',         'عادي',  'Regular',  0, 1, false),
    ('TEA_MILK',      'TEA_MILK',    'عادي',  'Regular',  0, 1, false),
    ('ANISE',         'ANISE',       'عادي',  'Regular',  0, 1, false),
    ('MILK',          'MILK',        'عادي',  'Regular',  0, 1, false),
    ('WATER',         'WATER',       'عادي',  'Regular',  0, 1, false)
  ) as v(code, prod, name_ar, name_en, price, sort, active)
  join products p on p.code = v.prod;

-- ---------- Recipes v1 ----------
insert into recipes (variant_id, version, is_current, notes)
select id, 1, true, 'Starter recipe' from product_variants;

insert into recipe_items (recipe_id, material_id, quantity, unit_id)
select r.id, m.id, v.qty, u.id
  from (values
    ('COFFEE_S',      'COFFEE_BEANS', 7,   'g'),
    ('COFFEE_S',      'WATER',        100, 'ml'),
    ('COFFEE_D',      'COFFEE_BEANS', 14,  'g'),
    ('COFFEE_D',      'WATER',        100, 'ml'),
    ('COFFEE_MILK_S', 'COFFEE_BEANS', 7,   'g'),
    ('COFFEE_MILK_S', 'MILK',         100, 'ml'),
    ('COFFEE_MILK_S', 'WATER',        50,  'ml'),
    ('COFFEE_MILK_D', 'COFFEE_BEANS', 14,  'g'),
    ('COFFEE_MILK_D', 'MILK',         150, 'ml'),
    ('COFFEE_MILK_D', 'WATER',        50,  'ml'),
    ('HOT_CHOC',      'HOT_CHOC',     1,   'pc'),
    ('HOT_CHOC',      'MILK',         100, 'ml'),
    ('TEA',           'TEA_BAG',      1,   'pc'),
    ('TEA',           'WATER',        200, 'ml'),
    ('TEA_MILK',      'TEA_BAG',      1,   'pc'),
    ('TEA_MILK',      'MILK',         100, 'ml'),
    ('TEA_MILK',      'WATER',        100, 'ml')
  ) as v(variant, mat, qty, unit)
  join product_variants pv on pv.code = v.variant
  join recipes r on r.variant_id = pv.id and r.is_current
  join materials m on m.code = v.mat
  join units u on u.code = v.unit;
-- TODO (manager): recipes for Cappuccino, Anise, Milk, Water.

-- ---------- Add-ons ----------
insert into addons (code, name_ar, name_en, price, sort, active) values
  ('EXTRA_MILK',   'لبن زيادة',       'Extra Milk',      5, 1, true),
  ('EXTRA_SUGAR',  'سكر زيادة',       'Extra Sugar',     0, 2, true),
  ('NO_SUGAR',     'بدون سكر',        'No Sugar',        0, 3, true),
  ('EXTRA_COFFEE', 'قهوة زيادة',      'Extra Coffee',    0, 4, false),
  ('EXTRA_CHOC',   'شوكولاتة زيادة',   'Extra Chocolate', 0, 5, false);

insert into addon_recipe_items (addon_id, material_id, quantity, unit_id)
select a.id, m.id, v.qty, u.id
  from (values
    ('EXTRA_MILK',   'MILK',         50, 'ml'),
    ('EXTRA_COFFEE', 'COFFEE_BEANS', 7,  'g')
  ) as v(addon, mat, qty, unit)
  join addons a on a.code = v.addon
  join materials m on m.code = v.mat
  join units u on u.code = v.unit;
-- Sugar is an ISSUE material, so sugar add-ons carry no stock consumption.

-- Offer all add-ons on all drinks except water (manager can narrow this)
insert into variant_addons (variant_id, addon_id)
select pv.id, a.id
  from product_variants pv cross join addons a
 where pv.code <> 'WATER';
