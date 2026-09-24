-- =====================================================================
--  002_seed.sql — roles, permissions, units, locations, settings
-- =====================================================================
set search_path = public;

-- ---------- Settings ----------
insert into app_settings (key, value) values
  ('company',              '{"name_ar":"مينافارم / ميجنترا","name_en":"Minapharm / Migentra"}'),
  ('logos',                '{"primary":"assets/img/minapharm.png","secondary":"assets/img/migentra.png"}'),
  ('app_name',             '{"ar":"بوفيه الشركة","en":"Company Cafeteria"}'),
  ('currency',             '"EGP"'),
  ('timezone',             '"Africa/Cairo"'),
  ('allow_negative_stock', 'true'),     -- sell with a warning when stock is short
  ('default_credit_limit', 'null'),     -- null = no limit; per-customer credit_limit overrides
  ('auto_settle_on_deposit','true'),    -- deposits settle oldest unpaid orders first
  ('print_paper',          '"A4"'),
  ('receipt_footer',       '{"ar":"شكرًا لكم","en":"Thank you"}');

insert into doc_sequences (doc_type, prefix) values
  ('ORDER','C-'), ('PAYMENT','R-'), ('PURCHASE','PU-'), ('TRANSFER','TR-'),
  ('ISSUE','IS-'), ('WASTE','WS-'), ('COUNT','SC-');

-- ---------- Permissions ----------
insert into permissions (code, module, name_ar, name_en) values
  ('dashboard.view',          'dashboard', 'عرض لوحة المدير',            'View manager dashboard'),
  ('pos.create_order',        'orders',    'إنشاء طلب',                  'Create order'),
  ('orders.view',             'orders',    'عرض الطلبات',                'View orders'),
  ('orders.update_status',    'orders',    'تحديث حالة التحضير',          'Update preparation status'),
  ('orders.edit',             'orders',    'تعديل طلب جديد',              'Edit new order'),
  ('orders.cancel',           'orders',    'إلغاء طلب غير مدفوع',         'Cancel unpaid order'),
  ('orders.cancel_paid',      'orders',    'إلغاء طلب مدفوع',             'Cancel paid order'),
  ('payments.view',           'payments',  'عرض المدفوعات',              'View payments'),
  ('payments.receive',        'payments',  'استلام نقدية',               'Receive cash'),
  ('payments.refund',         'payments',  'رد مبالغ',                   'Refund'),
  ('accounts.view',           'accounts',  'عرض كشوف الحساب',            'View account ledgers'),
  ('accounts.deposit',        'accounts',  'إيداع في الحساب',            'Deposit to account'),
  ('accounts.adjust',         'accounts',  'تسوية يدوية للحساب',          'Manual account adjustment'),
  ('accounts.credit_override','accounts',  'تجاوز حد الائتمان',          'Override credit limit'),
  ('customers.manage',        'customers', 'إدارة العملاء',              'Manage customers'),
  ('catalog.manage',          'catalog',   'إدارة المنتجات والإضافات',     'Manage products & add-ons'),
  ('prices.change',           'catalog',   'تغيير الأسعار',              'Change prices'),
  ('recipes.manage',          'catalog',   'إدارة الوصفات',              'Manage recipes'),
  ('inventory.view',          'inventory', 'عرض المخزون',                'View inventory'),
  ('inventory.materials',     'inventory', 'إدارة الخامات والوحدات',       'Manage materials & units'),
  ('inventory.purchase',      'inventory', 'إذن شراء',                   'Purchases'),
  ('inventory.transfer',      'inventory', 'تحويل بين المخازن',           'Stock transfer'),
  ('inventory.issue',         'inventory', 'صرف للاستخدام',              'Issue for use'),
  ('inventory.waste',         'inventory', 'تسجيل هالك',                 'Record waste'),
  ('inventory.adjust',        'inventory', 'جرد وتسوية',                 'Stock count & adjustment'),
  ('reports.sales',           'reports',   'تقارير المبيعات',             'Sales reports'),
  ('reports.financial',       'reports',   'التقارير المالية',            'Financial reports'),
  ('reports.inventory',       'reports',   'تقارير المخزون',              'Inventory reports'),
  ('reports.cost',            'reports',   'تقارير التكلفة والربح',        'Cost & margin reports'),
  ('closing.perform',         'closing',   'الإقفال اليومي',              'Daily closing'),
  ('closing.override',        'closing',   'التعديل بعد الإقفال',          'Edit after closing'),
  ('users.manage',            'admin',     'إدارة المستخدمين',            'Manage users'),
  ('roles.manage',            'admin',     'إدارة الأدوار والصلاحيات',     'Manage roles & permissions'),
  ('audit.view',              'admin',     'عرض سجل التدقيق',             'View audit trail'),
  ('settings.manage',         'admin',     'الإعدادات',                  'Settings');

-- ---------- Roles ----------
insert into roles (code, name_ar, name_en, is_system) values
  ('ADMIN',       'مدير النظام', 'Admin',       true),
  ('MANAGER',     'مدير البوفيه','Manager',     true),
  ('RECEPTION',   'الريسبشن',    'Reception',   true),
  ('BARISTA',     'باريستا',     'Barista',     true),
  ('STOREKEEPER', 'أمين المخزن', 'Storekeeper', true);
-- ADMIN has every permission implicitly (see has_perm).

insert into role_permissions (role_id, permission_code)
select r.id, p.code
  from roles r
  join (values
    ('BARISTA','pos.create_order'), ('BARISTA','orders.view'), ('BARISTA','orders.update_status'),

    ('RECEPTION','pos.create_order'), ('RECEPTION','orders.view'), ('RECEPTION','orders.update_status'),
    ('RECEPTION','orders.edit'), ('RECEPTION','orders.cancel'),
    ('RECEPTION','payments.view'), ('RECEPTION','payments.receive'),
    ('RECEPTION','accounts.view'), ('RECEPTION','accounts.deposit'),
    ('RECEPTION','customers.manage'),
    ('RECEPTION','reports.sales'), ('RECEPTION','reports.financial'),
    ('RECEPTION','closing.perform'),

    ('STOREKEEPER','inventory.view'), ('STOREKEEPER','inventory.materials'),
    ('STOREKEEPER','inventory.purchase'), ('STOREKEEPER','inventory.transfer'),
    ('STOREKEEPER','inventory.issue'), ('STOREKEEPER','inventory.waste'),
    ('STOREKEEPER','inventory.adjust'), ('STOREKEEPER','reports.inventory')
  ) as m(role_code, perm) on m.role_code = r.code
  join permissions p on p.code = m.perm;

-- MANAGER: everything except admin-only permissions
insert into role_permissions (role_id, permission_code)
select r.id, p.code
  from roles r cross join permissions p
 where r.code = 'MANAGER'
   and p.code not in ('roles.manage','settings.manage','audit.view');

-- ---------- Units ----------
insert into units (code, name_ar, name_en, dimension) values
  ('g',      'جرام',    'gram',       'MASS'),
  ('kg',     'كيلو',    'kilogram',   'MASS'),
  ('ml',     'مللي',    'millilitre', 'VOLUME'),
  ('l',      'لتر',     'litre',      'VOLUME'),
  ('pc',     'قطعة',    'piece',      'COUNT'),
  ('bag',    'كيس',     'bag',        'PACK'),
  ('can',    'علبة',    'can',        'PACK'),
  ('box',    'علبة كرتون','box',       'PACK'),
  ('packet', 'باكيت',   'packet',     'PACK');

-- ---------- Locations ----------
insert into stock_locations (code, name_ar, name_en, is_consumption) values
  ('MAIN',   'المخزن الرئيسي', 'Main store',   false),
  ('BUFFET', 'مخزن البوفيه',  'Buffet store', true);

-- ---------- Categories ----------
insert into material_categories (name_ar, name_en) values
  ('مشروبات ساخنة', 'Hot beverage ingredients'),
  ('ألبان',         'Dairy'),
  ('مستلزمات',      'Supplies');

insert into product_categories (name_ar, name_en, sort) values
  ('قهوة',          'Coffee',       1),
  ('مشروبات ساخنة', 'Hot drinks',   2),
  ('أخرى',          'Other',        3);

-- =====================================================================
--  First admin (run once, after creating the user in Supabase Auth):
--    Authentication → Users → Add user → email: admin@cafeteria.local
--    then:
--  insert into app_users (id, username, full_name, role_id)
--  select u.id, 'admin', 'System Admin', r.id
--    from auth.users u, roles r
--   where u.email = 'admin@cafeteria.local' and r.code = 'ADMIN';
-- =====================================================================
