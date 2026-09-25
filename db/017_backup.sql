-- =====================================================================
--  017_backup.sql — full data export for the in-app backup button (admin).
--  Run once after 016.
-- =====================================================================
set search_path = public, extensions;

-- Tables included in a backup, in restore order (parents before children)
create or replace function backup_tables() returns text[]
language sql immutable as $$
  select array[
    'app_settings','roles','permissions','role_permissions','app_users','doc_sequences',
    'departments','customers','customer_accounts',
    'units','material_categories','materials','material_units','stock_locations','suppliers',
    'product_categories','products','product_variants','variant_price_history','recipes','recipe_items',
    'addons','addon_recipe_items','variant_addons',
    'daily_closings','orders','order_items','order_item_addons','order_status_history',
    'account_transactions','payments','order_payments',
    'purchases','purchase_items','stock_transfers','stock_transfer_items','stock_issues','stock_issue_items',
    'waste_records','waste_items','stock_counts','stock_count_items',
    'inventory_transactions','material_stock','audit_logs'];
$$;

-- One page of one table (the app pulls tables page by page)
create or replace function backup_table(p_table text, p_offset int default 0, p_limit int default 5000)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare res jsonb;
begin
  perform require_perm('settings.manage');
  if not (p_table = any(backup_tables())) then raise exception 'TABLE_NOT_ALLOWED:%', p_table; end if;
  execute format('select coalesce(jsonb_agg(to_jsonb(x)), ''[]''::jsonb) from (select * from %I order by 1 offset %s limit %s) x',
                 p_table, greatest(coalesce(p_offset, 0), 0), least(greatest(coalesce(p_limit, 5000), 1), 10000))
     into res;
  return res;
end $$;

create or replace function backup_counts() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare t text; n bigint; res jsonb := '{}';
begin
  perform require_perm('settings.manage');
  foreach t in array backup_tables() loop
    execute format('select count(*) from %I', t) into n;
    res := res || jsonb_build_object(t, n);
  end loop;
  return res;
end $$;

create or replace function backup_done(p_rows bigint, p_format text default 'xlsx')
returns void language plpgsql security definer set search_path = public as $$
begin
  perform require_perm('settings.manage');
  insert into app_settings (key, value) values ('last_backup_at', to_jsonb(now()))
  on conflict (key) do update set value = excluded.value, updated_at = now(), updated_by = auth.uid();
  perform log_audit('BACKUP', 'app_settings', 'last_backup_at', null,
                    jsonb_build_object('rows', p_rows, 'format', p_format));
end $$;

revoke execute on function backup_table(text, int, int), backup_counts(), backup_done(bigint, text) from public, anon;
grant execute on function backup_table(text, int, int), backup_counts(), backup_done(bigint, text) to authenticated;
