-- =====================================================================
--  Minapharm / Migentra Cafeteria System
--  001_schema.sql  —  Phase 1: core schema, integrity triggers, RLS
--  Target: Supabase (PostgreSQL 15+)
--
--  Design principles
--   * No hard deletes for money / stock / orders. Corrections = reversal rows.
--   * Balances & stock are CACHES maintained only by triggers from ledgers.
--   * Sensitive writes (orders, payments, stock movements, closing) go
--     through SECURITY DEFINER RPC functions (added in later phases).
--     Clients only get direct write access to master data, gated by RLS.
--   * Single wallet per customer: balance > 0 prepaid, < 0 amount due.
--   * Two stock locations: MAIN (main store) and BUFFET (buffet store).
-- =====================================================================

-- Supabase keeps extensions in the "extensions" schema
create schema if not exists extensions;
create extension if not exists pg_trgm with schema extensions;
set search_path = public, extensions;

-- ---------------------------------------------------------------------
-- 1. Settings & document numbering
-- ---------------------------------------------------------------------
create table app_settings (
  key         text primary key,
  value       jsonb not null,
  updated_at  timestamptz not null default now(),
  updated_by  uuid default auth.uid()
);

create table doc_sequences (
  doc_type  text primary key,
  prefix    text not null,
  last_no   bigint not null default 0,
  pad       int not null default 6
);

-- ---------------------------------------------------------------------
-- 2. Security: roles, permissions, users
-- ---------------------------------------------------------------------
create table roles (
  id          bigint generated always as identity primary key,
  code        text not null unique,
  name_ar     text not null,
  name_en     text not null,
  is_system   boolean not null default false,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

create table permissions (
  code     text primary key,
  module   text not null,
  name_ar  text not null,
  name_en  text not null
);

create table role_permissions (
  role_id          bigint not null references roles(id) on delete cascade,
  permission_code  text   not null references permissions(code) on delete cascade,
  primary key (role_id, permission_code)
);

create table app_users (
  id          uuid primary key references auth.users(id),
  username    text not null unique,
  full_name   text not null,
  role_id     bigint not null references roles(id),
  locale      text not null default 'ar' check (locale in ('ar','en')),
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  created_by  uuid
);

-- ---------------------------------------------------------------------
-- 3. Security helpers
-- ---------------------------------------------------------------------
create or replace function is_active_user() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from app_users where id = auth.uid() and active);
$$;

create or replace function has_perm(p text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1
      from app_users u
      join roles r on r.id = u.role_id
     where u.id = auth.uid() and u.active and r.active
       and ( r.code = 'ADMIN'
             or exists (select 1 from role_permissions rp
                         where rp.role_id = r.id and rp.permission_code = p) )
  );
$$;

create or replace function require_perm(p text) returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if not has_perm(p) then
    raise exception 'PERMISSION_DENIED:%', p using errcode = '42501';
  end if;
end $$;

-- Business date is always computed on the server in Cairo time.
create or replace function business_today() returns date
language sql stable as $$
  select (now() at time zone 'Africa/Cairo')::date;
$$;

create or replace function next_doc_no(p_type text) returns text
language plpgsql security definer set search_path = public as $$
declare v_prefix text; v_no bigint; v_pad int;
begin
  update doc_sequences set last_no = last_no + 1
   where doc_type = p_type
   returning prefix, last_no, pad into v_prefix, v_no, v_pad;
  if not found then
    raise exception 'UNKNOWN_DOC_TYPE:%', p_type;
  end if;
  return v_prefix || lpad(v_no::text, v_pad, '0');
end $$;

-- ---------------------------------------------------------------------
-- 4. Audit log
-- ---------------------------------------------------------------------
create table audit_logs (
  id           bigint generated always as identity primary key,
  occurred_at  timestamptz not null default now(),
  user_id      uuid,
  action       text not null,          -- INSERT/UPDATE/DELETE or semantic: LOGIN, CREATE_ORDER, ...
  entity       text not null,
  entity_id    text,
  old_value    jsonb,
  new_value    jsonb,
  reason       text,
  client_info  text
);
create index audit_logs_entity_idx on audit_logs (entity, entity_id);
create index audit_logs_time_idx   on audit_logs (occurred_at desc);
create index audit_logs_user_idx   on audit_logs (user_id, occurred_at desc);

-- Used by RPC functions to write semantic audit entries.
create or replace function log_audit(p_action text, p_entity text, p_entity_id text,
                                     p_old jsonb default null, p_new jsonb default null,
                                     p_reason text default null)
returns void language sql security definer set search_path = public as $$
  insert into audit_logs (user_id, action, entity, entity_id, old_value, new_value, reason)
  values (auth.uid(), p_action, p_entity, p_entity_id, p_old, p_new, p_reason);
$$;

-- Generic row-level audit for master data.
-- A reason can be passed from an RPC with: set_config('app.reason', '...', true)
create or replace function audit_row() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_old jsonb; v_new jsonb; v_row jsonb; v_id text;
begin
  if tg_op in ('UPDATE','DELETE') then v_old := to_jsonb(old); end if;
  if tg_op in ('INSERT','UPDATE') then v_new := to_jsonb(new); end if;
  if tg_op = 'UPDATE' and v_old = v_new then return new; end if;
  v_row := coalesce(v_new, v_old);
  v_id  := coalesce(v_row->>'id', v_row->>'key', v_row->>'code', left(v_row::text, 200));
  insert into audit_logs (user_id, action, entity, entity_id, old_value, new_value, reason)
  values (auth.uid(), tg_op, tg_table_name, v_id, v_old, v_new,
          nullif(current_setting('app.reason', true), ''));
  return coalesce(new, old);
end $$;

-- Ledger tables are append-only.
create or replace function forbid_change() returns trigger
language plpgsql as $$
begin
  raise exception 'IMMUTABLE_TABLE:% (use a reversal entry instead)', tg_table_name
    using errcode = 'P0001';
end $$;

create or replace function log_login(p_client text default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_active_user() then
    raise exception 'USER_INACTIVE' using errcode = '42501';
  end if;
  insert into audit_logs (user_id, action, entity, entity_id, client_info)
  values (auth.uid(), 'LOGIN', 'app_users', auth.uid()::text, p_client);
end $$;

create or replace function my_profile() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
           'id', u.id, 'username', u.username, 'full_name', u.full_name, 'locale', u.locale,
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

-- ---------------------------------------------------------------------
-- 5. Daily closing (single cashier → one closing per business date)
-- ---------------------------------------------------------------------
create table daily_closings (
  id                bigint generated always as identity primary key,
  business_date     date not null unique,
  status            text not null default 'OPEN' check (status in ('OPEN','CLOSED','REOPENED')),
  opening_cash      numeric(12,2) not null default 0,
  opened_by         uuid default auth.uid(),
  opened_at         timestamptz not null default now(),
  cash_sales        numeric(12,2),
  deposits_cash     numeric(12,2),
  refunds_cash      numeric(12,2),
  expected_cash     numeric(12,2),
  actual_cash       numeric(12,2),
  difference        numeric(12,2),
  closed_by         uuid,
  closed_at         timestamptz,
  reopened_by       uuid,
  reopened_at       timestamptz,
  reopen_reason     text,
  notes             text
);

create or replace function is_day_closed(d date) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from daily_closings where business_date = d and status = 'CLOSED');
$$;

-- Blocks new financial / stock rows on a closed day unless closing.override.
create or replace function guard_closed_day() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if is_day_closed(new.business_date) and not has_perm('closing.override') then
    raise exception 'DAY_CLOSED:%', new.business_date using errcode = 'P0001';
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------
-- 6. Customers & wallet ledger
-- ---------------------------------------------------------------------
create table departments (
  id          bigint generated always as identity primary key,
  name_ar     text not null,
  name_en     text,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

create table customers (
  id             bigint generated always as identity primary key,
  code           text not null unique,              -- Employee ID / visitor code
  full_name      text not null,
  customer_type  text not null default 'EMPLOYEE'
                 check (customer_type in ('EMPLOYEE','VISITOR','CONTRACTOR','OTHER')),
  department_id  bigint references departments(id),
  phone          text,
  status         text not null default 'ACTIVE' check (status in ('ACTIVE','SUSPENDED','CLOSED')),
  credit_limit   numeric(12,2) check (credit_limit is null or credit_limit >= 0),
                 -- NULL = use app_settings.default_credit_limit
  notes          text,
  created_at     timestamptz not null default now(),
  created_by     uuid default auth.uid()
);
create index customers_name_trgm on customers using gin (full_name extensions.gin_trgm_ops);

create table customer_accounts (
  id           bigint generated always as identity primary key,
  customer_id  bigint not null unique references customers(id),
  balance      numeric(12,2) not null default 0,     -- CACHE, trigger-maintained
  status       text not null default 'OPEN' check (status in ('OPEN','CLOSED')),
  opened_at    timestamptz not null default now()
);

create or replace function create_customer_account() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into customer_accounts (customer_id) values (new.id);
  return new;
end $$;

create table account_transactions (
  id              bigint generated always as identity primary key,
  account_id      bigint not null references customer_accounts(id),
  txn_type        text not null check (txn_type in
                  ('OPENING','DEPOSIT','ORDER_CHARGE','REFUND','ADJUSTMENT','REVERSAL')),
  debit           numeric(12,2) not null default 0 check (debit  >= 0),
  credit          numeric(12,2) not null default 0 check (credit >= 0),
  balance_after   numeric(12,2),
  reference_type  text,
  reference_id    bigint,
  reversal_of     bigint references account_transactions(id),
  business_date   date not null default business_today(),
  created_by      uuid default auth.uid(),
  created_at      timestamptz not null default now(),
  notes           text,
  check ((debit > 0) <> (credit > 0))
);
create index account_txn_account_idx on account_transactions (account_id, id);
create index account_txn_ref_idx     on account_transactions (reference_type, reference_id);

-- Locks the account row, computes running balance, updates cache.
create or replace function apply_account_txn() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_bal numeric(12,2); v_status text;
begin
  select balance, status into v_bal, v_status
    from customer_accounts where id = new.account_id for update;
  if not found then raise exception 'ACCOUNT_NOT_FOUND:%', new.account_id; end if;
  if v_status = 'CLOSED' then raise exception 'ACCOUNT_CLOSED:%', new.account_id; end if;
  new.balance_after := v_bal + new.credit - new.debit;
  update customer_accounts set balance = new.balance_after where id = new.account_id;
  return new;
end $$;

-- ---------------------------------------------------------------------
-- 7. Units & materials & locations
-- ---------------------------------------------------------------------
create table units (
  id         bigint generated always as identity primary key,
  code       text not null unique,                  -- g, kg, ml, l, pc, bag, can, box, packet
  name_ar    text not null,
  name_en    text not null,
  dimension  text not null check (dimension in ('MASS','VOLUME','COUNT','PACK'))
);

create table material_categories (
  id       bigint generated always as identity primary key,
  name_ar  text not null,
  name_en  text,
  active   boolean not null default true
);

create table materials (
  id                bigint generated always as identity primary key,
  code              text not null unique,
  name_ar           text not null,
  name_en           text,
  category_id       bigint references material_categories(id),
  base_unit_id      bigint not null references units(id),
  consumption_mode  text not null default 'RECIPE' check (consumption_mode in ('RECIPE','ISSUE')),
                    -- RECIPE: auto-consumed by orders | ISSUE: consumed when a bag/packet is issued
  track_stock       boolean not null default true,  -- false e.g. tap water
  min_stock         numeric(14,3) not null default 0,  -- default alert level (base unit)
  avg_cost          numeric(14,6) not null default 0,  -- weighted average cost per base unit
  active            boolean not null default true,
  created_at        timestamptz not null default now(),
  created_by        uuid default auth.uid()
);
create index materials_name_trgm on materials using gin (name_ar extensions.gin_trgm_ops);

-- Per-material unit conversions: 1 Can of milk = 1000 ml, 1 Bag of coffee = 500 g ...
create table material_units (
  material_id       bigint not null references materials(id) on delete cascade,
  unit_id           bigint not null references units(id),
  factor_to_base    numeric(14,6) not null check (factor_to_base > 0),
  is_purchase_unit  boolean not null default false,
  primary key (material_id, unit_id)
);

create or replace function to_base_qty(p_material bigint, p_unit bigint, p_qty numeric)
returns numeric language plpgsql stable security definer set search_path = public as $$
declare v_base bigint; v_factor numeric;
begin
  select base_unit_id into v_base from materials where id = p_material;
  if v_base is null then raise exception 'MATERIAL_NOT_FOUND:%', p_material; end if;
  if p_unit = v_base then return p_qty; end if;
  select factor_to_base into v_factor from material_units
   where material_id = p_material and unit_id = p_unit;
  if v_factor is null then
    raise exception 'NO_UNIT_CONVERSION:material=% unit=%', p_material, p_unit;
  end if;
  return p_qty * v_factor;
end $$;

create table stock_locations (
  id                bigint generated always as identity primary key,
  code              text not null unique,           -- MAIN, BUFFET
  name_ar           text not null,
  name_en           text not null,
  is_consumption    boolean not null default false, -- orders consume from this location
  active            boolean not null default true
);
create unique index one_consumption_location on stock_locations (is_consumption) where is_consumption;

create table material_stock (
  material_id  bigint not null references materials(id),
  location_id  bigint not null references stock_locations(id),
  qty          numeric(14,3) not null default 0,    -- CACHE, trigger-maintained (may go negative)
  min_qty      numeric(14,3),                        -- per-location alert level (overrides min_stock)
  updated_at   timestamptz not null default now(),
  primary key (material_id, location_id)
);

-- ---------------------------------------------------------------------
-- 8. Stock ledger & stock documents
-- ---------------------------------------------------------------------
create table inventory_transactions (
  id              bigint generated always as identity primary key,
  material_id     bigint not null references materials(id),
  location_id     bigint not null references stock_locations(id),
  movement_type   text not null check (movement_type in
                  ('PURCHASE','CONSUMPTION','WASTE','ADJUSTMENT','RETURN','TRANSFER','OPENING_BALANCE')),
  qty_base        numeric(14,3) not null check (qty_base <> 0),   -- signed, base unit
  qty_entered     numeric(14,3),
  unit_id         bigint references units(id),                    -- unit the user entered
  unit_cost       numeric(14,6) not null default 0,               -- per base unit
  reference_type  text not null,   -- ORDER, PURCHASE, TRANSFER, ISSUE, WASTE, COUNT, OPENING, MANUAL
  reference_id    bigint,
  reversal_of     bigint references inventory_transactions(id),
  business_date   date not null default business_today(),
  created_by      uuid default auth.uid(),
  created_at      timestamptz not null default now(),
  notes           text
);
create index inv_txn_material_idx on inventory_transactions (material_id, business_date);
create index inv_txn_ref_idx      on inventory_transactions (reference_type, reference_id);
create index inv_txn_date_idx     on inventory_transactions (business_date, movement_type);

create or replace function apply_inventory_txn() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_track boolean; v_avg numeric; v_total numeric;
begin
  select track_stock, avg_cost into v_track, v_avg
    from materials where id = new.material_id for update;
  if not found then raise exception 'MATERIAL_NOT_FOUND:%', new.material_id; end if;
  if not v_track then return new; end if;

  -- Weighted average cost on incoming priced stock
  if new.movement_type in ('PURCHASE','OPENING_BALANCE') and new.qty_base > 0 and new.unit_cost > 0 then
    select coalesce(sum(qty), 0) into v_total from material_stock where material_id = new.material_id;
    if v_total <= 0 then
      v_avg := new.unit_cost;
    else
      v_avg := (v_total * v_avg + new.qty_base * new.unit_cost) / (v_total + new.qty_base);
    end if;
    update materials set avg_cost = round(v_avg, 6) where id = new.material_id;
  end if;

  insert into material_stock (material_id, location_id, qty)
  values (new.material_id, new.location_id, new.qty_base)
  on conflict (material_id, location_id)
  do update set qty = material_stock.qty + excluded.qty, updated_at = now();
  return new;
end $$;

create table suppliers (
  id          bigint generated always as identity primary key,
  name        text not null,
  phone       text,
  notes       text,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

create table purchases (
  id              bigint generated always as identity primary key,
  doc_no          text not null unique,
  supplier_id     bigint references suppliers(id),
  location_id     bigint not null references stock_locations(id),
  purchase_date   date not null default business_today(),
  invoice_ref     text,
  status          text not null default 'POSTED' check (status in ('POSTED','REVERSED')),
  total           numeric(14,2) not null default 0,
  notes           text,
  created_by      uuid default auth.uid(),
  created_at      timestamptz not null default now(),
  reversed_by     uuid, reversed_at timestamptz, reverse_reason text
);
create table purchase_items (
  id           bigint generated always as identity primary key,
  purchase_id  bigint not null references purchases(id),
  material_id  bigint not null references materials(id),
  qty          numeric(14,3) not null check (qty > 0),
  unit_id      bigint not null references units(id),
  qty_base     numeric(14,3) not null check (qty_base > 0),
  unit_cost    numeric(14,4) not null check (unit_cost >= 0),   -- per entered unit
  line_total   numeric(14,2) not null
);

create table stock_transfers (
  id                bigint generated always as identity primary key,
  doc_no            text not null unique,
  from_location_id  bigint not null references stock_locations(id),
  to_location_id    bigint not null references stock_locations(id),
  status            text not null default 'POSTED' check (status in ('POSTED','REVERSED')),
  notes             text,
  created_by        uuid default auth.uid(),
  created_at        timestamptz not null default now(),
  check (from_location_id <> to_location_id)
);
create table stock_transfer_items (
  id           bigint generated always as identity primary key,
  transfer_id  bigint not null references stock_transfers(id),
  material_id  bigint not null references materials(id),
  qty          numeric(14,3) not null check (qty > 0),
  unit_id      bigint not null references units(id),
  qty_base     numeric(14,3) not null check (qty_base > 0)
);

-- Issue for use: sugar bags, cup packets … (consumption_mode = ISSUE)
create table stock_issues (
  id           bigint generated always as identity primary key,
  doc_no       text not null unique,
  location_id  bigint not null references stock_locations(id),
  issued_to    text,
  status       text not null default 'POSTED' check (status in ('POSTED','REVERSED')),
  notes        text,
  created_by   uuid default auth.uid(),
  created_at   timestamptz not null default now()
);
create table stock_issue_items (
  id           bigint generated always as identity primary key,
  issue_id     bigint not null references stock_issues(id),
  material_id  bigint not null references materials(id),
  qty          numeric(14,3) not null check (qty > 0),
  unit_id      bigint not null references units(id),
  qty_base     numeric(14,3) not null check (qty_base > 0)
);

create table waste_records (
  id           bigint generated always as identity primary key,
  doc_no       text not null unique,
  location_id  bigint not null references stock_locations(id),
  reason_code  text not null check (reason_code in
               ('EXPIRED','SPILLED','DAMAGED','PREPARED_CANCELLED','OTHER')),
  status       text not null default 'POSTED' check (status in ('POSTED','REVERSED')),
  notes        text,
  created_by   uuid default auth.uid(),
  created_at   timestamptz not null default now()
);
create table waste_items (
  id           bigint generated always as identity primary key,
  waste_id     bigint not null references waste_records(id),
  material_id  bigint not null references materials(id),
  qty          numeric(14,3) not null check (qty > 0),
  unit_id      bigint not null references units(id),
  qty_base     numeric(14,3) not null check (qty_base > 0),
  unit_cost    numeric(14,6) not null default 0
);

create table stock_counts (
  id           bigint generated always as identity primary key,
  doc_no       text not null unique,
  location_id  bigint not null references stock_locations(id),
  count_date   date not null default business_today(),
  status       text not null default 'DRAFT' check (status in ('DRAFT','POSTED','CANCELLED')),
  notes        text,
  created_by   uuid default auth.uid(),
  created_at   timestamptz not null default now(),
  posted_by    uuid, posted_at timestamptz
);
create table stock_count_items (
  id           bigint generated always as identity primary key,
  count_id     bigint not null references stock_counts(id),
  material_id  bigint not null references materials(id),
  system_qty   numeric(14,3) not null,
  counted_qty  numeric(14,3) not null check (counted_qty >= 0),
  diff_qty     numeric(14,3) generated always as (counted_qty - system_qty) stored,
  unique (count_id, material_id)
);

-- ---------------------------------------------------------------------
-- 9. Catalog: products, variants, recipes, add-ons
-- ---------------------------------------------------------------------
create table product_categories (
  id       bigint generated always as identity primary key,
  name_ar  text not null,
  name_en  text,
  sort     int not null default 0,
  active   boolean not null default true
);

create table products (
  id           bigint generated always as identity primary key,
  code         text not null unique,
  category_id  bigint references product_categories(id),
  name_ar      text not null,
  name_en      text,
  image_url    text,
  sort         int not null default 0,
  active       boolean not null default true,
  created_at   timestamptz not null default now()
);
create index products_name_trgm on products using gin (name_ar extensions.gin_trgm_ops);

create table product_variants (
  id          bigint generated always as identity primary key,
  code        text not null unique,
  product_id  bigint not null references products(id),
  name_ar     text not null,
  name_en     text,
  price       numeric(12,2) not null default 0 check (price >= 0),
  sort        int not null default 0,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  unique (product_id, name_ar)
);

create table variant_price_history (
  id          bigint generated always as identity primary key,
  variant_id  bigint not null references product_variants(id),
  old_price   numeric(12,2),
  new_price   numeric(12,2) not null,
  changed_by  uuid,
  changed_at  timestamptz not null default now(),
  reason      text
);

create or replace function on_variant_price_change() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.price is distinct from old.price then
    if auth.uid() is not null and not has_perm('prices.change') then
      raise exception 'PERMISSION_DENIED:prices.change' using errcode = '42501';
    end if;
    insert into variant_price_history (variant_id, old_price, new_price, changed_by, reason)
    values (new.id, old.price, new.price, auth.uid(), nullif(current_setting('app.reason', true), ''));
  end if;
  return new;
end $$;

-- Versioned recipes: editing creates a new version (RPC in Phase 2),
-- so historical orders keep the recipe they were made with.
create table recipes (
  id              bigint generated always as identity primary key,
  variant_id      bigint not null references product_variants(id),
  version         int not null,
  is_current      boolean not null default true,
  effective_from  timestamptz not null default now(),
  notes           text,
  created_by      uuid default auth.uid(),
  created_at      timestamptz not null default now(),
  unique (variant_id, version)
);
create unique index one_current_recipe on recipes (variant_id) where is_current;

create table recipe_items (
  id           bigint generated always as identity primary key,
  recipe_id    bigint not null references recipes(id),
  material_id  bigint not null references materials(id),
  quantity     numeric(14,3) not null check (quantity > 0),
  unit_id      bigint not null references units(id),
  unique (recipe_id, material_id)
);

create table addons (
  id          bigint generated always as identity primary key,
  code        text not null unique,
  name_ar     text not null,
  name_en     text,
  price       numeric(12,2) not null default 0 check (price >= 0),
  sort        int not null default 0,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

-- quantity may be negative (e.g. "less milk"); consumption never goes below 0 per item.
create table addon_recipe_items (
  id           bigint generated always as identity primary key,
  addon_id     bigint not null references addons(id),
  material_id  bigint not null references materials(id),
  quantity     numeric(14,3) not null check (quantity <> 0),
  unit_id      bigint not null references units(id),
  unique (addon_id, material_id)
);

create table variant_addons (
  variant_id  bigint not null references product_variants(id) on delete cascade,
  addon_id    bigint not null references addons(id) on delete cascade,
  primary key (variant_id, addon_id)
);

-- ---------------------------------------------------------------------
-- 10. Orders & payments
-- ---------------------------------------------------------------------
create table orders (
  id                  bigint generated always as identity primary key,
  order_no            text not null unique,
  customer_id         bigint references customers(id),    -- NULL = quick cash sale
  guest_name          text,                                -- optional name for quick cash sale
  location_id         bigint not null references stock_locations(id),
  business_date       date not null default business_today(),
  fulfillment_status  text not null default 'NEW'
                      check (fulfillment_status in ('NEW','PREPARING','READY','SERVED','CANCELLED')),
  payment_status      text not null default 'UNPAID'
                      check (payment_status in ('UNPAID','PARTIALLY_PAID','PAID','REFUNDED')),
  subtotal            numeric(12,2) not null default 0,
  discount            numeric(12,2) not null default 0 check (discount >= 0),
  total               numeric(12,2) not null default 0 check (total >= 0),
  paid_amount         numeric(12,2) not null default 0,
  material_cost       numeric(14,4) not null default 0,
  created_by          uuid not null default auth.uid(),
  created_at          timestamptz not null default now(),
  prepared_by         uuid, prepared_at timestamptz,
  ready_at            timestamptz,
  served_by           uuid, served_at timestamptz,
  paid_by             uuid, paid_at timestamptz,
  cancelled_by        uuid, cancelled_at timestamptz, cancel_reason text,
  notes               text,
  idempotency_key     uuid unique,                          -- blocks double submit
  check (paid_amount >= 0 and paid_amount <= total),
  check (fulfillment_status <> 'CANCELLED'
         or (cancelled_by is not null and cancelled_at is not null and cancel_reason is not null))
);
create index orders_date_idx     on orders (business_date, fulfillment_status);
create index orders_customer_idx on orders (customer_id, business_date);
create index orders_unpaid_idx   on orders (customer_id, id) where payment_status in ('UNPAID','PARTIALLY_PAID');

create table order_items (
  id                    bigint generated always as identity primary key,
  order_id              bigint not null references orders(id),
  variant_id            bigint not null references product_variants(id),
  product_name_ar_snap  text not null,
  product_name_en_snap  text,
  variant_name_ar_snap  text not null,
  variant_name_en_snap  text,
  qty                   int not null check (qty > 0),
  unit_price            numeric(12,2) not null check (unit_price >= 0),  -- price at order time
  addons_total          numeric(12,2) not null default 0,                -- per unit
  line_total            numeric(12,2) not null,
  recipe_id             bigint references recipes(id),                   -- recipe version used
  unit_cost_snap        numeric(14,4) not null default 0,                -- material cost per unit
  notes                 text
);
create index order_items_order_idx   on order_items (order_id);
create index order_items_variant_idx on order_items (variant_id);

create table order_item_addons (
  id             bigint generated always as identity primary key,
  order_item_id  bigint not null references order_items(id),
  addon_id       bigint not null references addons(id),
  name_ar_snap   text not null,
  name_en_snap   text,
  price_snap     numeric(12,2) not null default 0,
  qty            int not null default 1 check (qty > 0)
);

create table order_status_history (
  id           bigint generated always as identity primary key,
  order_id     bigint not null references orders(id),
  from_status  text,
  to_status    text not null,
  changed_by   uuid default auth.uid(),
  changed_at   timestamptz not null default now()
);
create index order_status_hist_idx on order_status_history (order_id);

-- Cash register movements (single cashier). Method list extendable later.
create table payments (
  id              bigint generated always as identity primary key,
  receipt_no      text not null unique,
  customer_id     bigint references customers(id),
  method          text not null default 'CASH' check (method in ('CASH')),
  direction       text not null check (direction in ('IN','OUT')),
  purpose         text not null check (purpose in ('ORDER','DEPOSIT','REFUND')),
  amount          numeric(12,2) not null check (amount > 0),
  account_txn_id  bigint references account_transactions(id),   -- set for DEPOSIT / wallet REFUND
  reversal_of     bigint references payments(id),
  business_date   date not null default business_today(),
  created_by      uuid default auth.uid(),
  created_at      timestamptz not null default now(),
  notes           text
);
create index payments_date_idx     on payments (business_date, purpose);
create index payments_customer_idx on payments (customer_id, business_date);

-- Allocation of money to orders. CASH → payment row; ACCOUNT → wallet ledger row.
-- Negative amounts are reversals (cancellation).
create table order_payments (
  id              bigint generated always as identity primary key,
  order_id        bigint not null references orders(id),
  method          text not null check (method in ('CASH','ACCOUNT')),
  amount          numeric(12,2) not null check (amount <> 0),
  payment_id      bigint references payments(id),
  account_txn_id  bigint references account_transactions(id),
  business_date   date not null default business_today(),
  created_by      uuid default auth.uid(),
  created_at      timestamptz not null default now(),
  check ( (method = 'CASH'    and payment_id     is not null)
       or (method = 'ACCOUNT' and account_txn_id is not null) )
);
create index order_payments_order_idx on order_payments (order_id);

create or replace function refresh_order_payment() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_total numeric(12,2); v_fs text; v_paid numeric(12,2); v_had boolean;
begin
  select total, fulfillment_status into v_total, v_fs from orders where id = new.order_id for update;
  select coalesce(sum(amount), 0), coalesce(bool_or(amount > 0), false)
    into v_paid, v_had from order_payments where order_id = new.order_id;
  update orders set
    paid_amount    = v_paid,
    payment_status = case
                       when v_fs = 'CANCELLED' and v_paid = 0 and v_had then 'REFUNDED'
                       when v_paid >= v_total then 'PAID'
                       when v_paid > 0        then 'PARTIALLY_PAID'
                       else 'UNPAID' end,
    paid_at        = case when v_paid >= v_total then coalesce(paid_at, now()) else null end,
    paid_by        = case when v_paid >= v_total then coalesce(paid_by, new.created_by) else null end
  where id = new.order_id;
  return new;
end $$;

create or replace function track_order_status() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    insert into order_status_history (order_id, from_status, to_status, changed_by)
    values (new.id, null, new.fulfillment_status, new.created_by);
  elsif new.fulfillment_status is distinct from old.fulfillment_status then
    insert into order_status_history (order_id, from_status, to_status, changed_by)
    values (new.id, old.fulfillment_status, new.fulfillment_status, auth.uid());
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------
-- 11. Triggers
-- ---------------------------------------------------------------------
create trigger customers_create_account after insert on customers
  for each row execute function create_customer_account();

create trigger account_txn_apply before insert on account_transactions
  for each row execute function apply_account_txn();

create trigger inventory_txn_apply after insert on inventory_transactions
  for each row execute function apply_inventory_txn();

create trigger variant_price_change before update on product_variants
  for each row execute function on_variant_price_change();

create trigger order_payments_refresh after insert on order_payments
  for each row execute function refresh_order_payment();

create trigger orders_status_track after insert or update of fulfillment_status on orders
  for each row execute function track_order_status();

-- Closed-day guard on every new financial / stock row
create trigger guard_day_account_txn before insert on account_transactions
  for each row execute function guard_closed_day();
create trigger guard_day_inventory   before insert on inventory_transactions
  for each row execute function guard_closed_day();
create trigger guard_day_payments    before insert on payments
  for each row execute function guard_closed_day();
create trigger guard_day_order_pay   before insert on order_payments
  for each row execute function guard_closed_day();
create trigger guard_day_orders      before insert on orders
  for each row execute function guard_closed_day();

-- Append-only ledgers
do $$
declare t text;
begin
  foreach t in array array['audit_logs','account_transactions','inventory_transactions',
                           'payments','order_payments','order_status_history',
                           'variant_price_history'] loop
    execute format('create trigger %I before update or delete on %I
                    for each row execute function forbid_change()', t || '_immutable', t);
  end loop;

  -- Orders are never deleted
  execute 'create trigger orders_no_delete before delete on orders
           for each row execute function forbid_change()';

  -- Row audit on master data
  foreach t in array array['app_settings','roles','role_permissions','app_users',
                           'departments','customers','customer_accounts',
                           'product_categories','products','product_variants',
                           'recipes','recipe_items','addons','addon_recipe_items','variant_addons',
                           'units','material_categories','materials','material_units',
                           'stock_locations','suppliers','daily_closings'] loop
    execute format('create trigger %I after insert or update or delete on %I
                    for each row execute function audit_row()', t || '_audit', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 12. Views (security_invoker → RLS of the caller applies)
-- ---------------------------------------------------------------------
create view v_material_stock with (security_invoker = true) as
select m.id  as material_id, m.code, m.name_ar, m.name_en, m.consumption_mode,
       l.id  as location_id, l.code as location_code, l.name_ar as location_name_ar,
       l.name_en as location_name_en,
       coalesce(s.qty, 0)                        as qty,
       u.code                                    as base_unit,
       coalesce(s.min_qty, m.min_stock)          as min_qty,
       case when coalesce(s.qty, 0) <= 0 then 'OUT'
            when coalesce(s.qty, 0) < coalesce(s.min_qty, m.min_stock) then 'LOW'
            else 'OK' end                        as stock_status,
       round(coalesce(s.qty, 0) * m.avg_cost, 2) as stock_value
  from materials m
 cross join stock_locations l
  left join material_stock s on s.material_id = m.id and s.location_id = l.id
  join units u on u.id = m.base_unit_id
 where m.active and l.active and m.track_stock;

create view v_customer_balances with (security_invoker = true) as
select c.id as customer_id, c.code, c.full_name, c.customer_type, c.department_id,
       c.status, c.credit_limit, a.id as account_id, a.balance,
       greatest(a.balance, 0)  as available_balance,
       greatest(-a.balance, 0) as amount_due
  from customers c
  join customer_accounts a on a.customer_id = c.id;

-- ---------------------------------------------------------------------
-- 13. Row Level Security
-- ---------------------------------------------------------------------
revoke all on all tables in schema public from anon;
revoke execute on all functions in schema public from anon, public;
grant execute on function is_active_user(), has_perm(text), my_profile(),
                          log_login(text), business_today() to authenticated;
revoke execute on function next_doc_no(text), log_audit(text,text,text,jsonb,jsonb,text),
                           require_perm(text), to_base_qty(bigint,bigint,numeric)
  from authenticated;

do $$
declare t text; r text[];
begin
  -- RLS on every table
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t);
  end loop;

  -- Readable by any active user (POS needs catalog, customers, balances, stock)
  foreach t in array array['app_settings','roles','permissions','role_permissions',
                           'departments','customers','customer_accounts',
                           'product_categories','products','product_variants',
                           'recipes','recipe_items','addons','addon_recipe_items','variant_addons',
                           'units','material_categories','materials','material_units',
                           'stock_locations','material_stock','suppliers'] loop
    execute format('create policy %I on public.%I for select to authenticated using (is_active_user())',
                   t || '_read', t);
  end loop;

  -- Readable by permission
  foreach r slice 1 in array array[
      ['account_transactions','accounts.view'],
      ['variant_price_history','catalog.manage'],
      ['orders','orders.view'], ['order_items','orders.view'],
      ['order_item_addons','orders.view'], ['order_status_history','orders.view'],
      ['payments','payments.view'], ['order_payments','payments.view'],
      ['inventory_transactions','inventory.view'],
      ['purchases','inventory.view'], ['purchase_items','inventory.view'],
      ['stock_transfers','inventory.view'], ['stock_transfer_items','inventory.view'],
      ['stock_issues','inventory.view'], ['stock_issue_items','inventory.view'],
      ['waste_records','inventory.view'], ['waste_items','inventory.view'],
      ['stock_counts','inventory.view'], ['stock_count_items','inventory.view'],
      ['audit_logs','audit.view']] loop
    execute format('create policy %I on public.%I for select to authenticated using (has_perm(%L))',
                   r[1] || '_read', r[1], r[2]);
  end loop;

  -- Direct insert/update on master data, gated by permission (audited by trigger)
  foreach r slice 1 in array array[
      ['departments','customers.manage'], ['customers','customers.manage'],
      ['product_categories','catalog.manage'], ['products','catalog.manage'],
      ['product_variants','catalog.manage'], ['addons','catalog.manage'],
      ['variant_addons','catalog.manage'],
      ['units','inventory.materials'], ['material_categories','inventory.materials'],
      ['materials','inventory.materials'], ['material_units','inventory.materials'],
      ['stock_locations','inventory.materials'], ['suppliers','inventory.materials'],
      ['app_settings','settings.manage'],
      ['roles','roles.manage'], ['role_permissions','roles.manage']] loop
    execute format('create policy %I on public.%I for insert to authenticated with check (has_perm(%L))',
                   r[1] || '_ins', r[1], r[2]);
    execute format('create policy %I on public.%I for update to authenticated using (has_perm(%L)) with check (has_perm(%L))',
                   r[1] || '_upd', r[1], r[2], r[2]);
  end loop;

  -- Link tables that may be deleted
  foreach r slice 1 in array array[
      ['variant_addons','catalog.manage'], ['material_units','inventory.materials'],
      ['role_permissions','roles.manage']] loop
    execute format('create policy %I on public.%I for delete to authenticated using (has_perm(%L))',
                   r[1] || '_del', r[1], r[2]);
  end loop;
end $$;

-- Custom policies
create policy app_users_read on app_users for select to authenticated
  using (id = auth.uid() or has_perm('users.manage'));
create policy app_users_upd on app_users for update to authenticated
  using (has_perm('users.manage')) with check (has_perm('users.manage'));

create policy daily_closings_read on daily_closings for select to authenticated
  using (has_perm('closing.perform') or has_perm('reports.financial'));

create policy material_stock_upd on material_stock for update to authenticated
  using (has_perm('inventory.materials')) with check (has_perm('inventory.materials'));

-- Column-level protection: caches and base units cannot be edited from the client
revoke update on materials, material_stock, customer_accounts, app_users from authenticated;
grant update (code, name_ar, name_en, category_id, consumption_mode, track_stock, min_stock, active)
  on materials to authenticated;
grant update (min_qty) on material_stock to authenticated;
grant update (full_name, role_id, locale, active) on app_users to authenticated;
revoke insert on material_stock, customer_accounts, app_users from authenticated;
