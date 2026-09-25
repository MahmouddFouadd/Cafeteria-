-- =====================================================================
--  009_quick_add_customer.sql — departments list + add an employee
--  straight from the POS / reception search box. Run once after 008.
-- =====================================================================
set search_path = public, extensions;

-- ---------- Departments ----------
insert into departments (name_ar, name_en)
select v.name_ar, v.name_en
  from (values
    ('QC', 'QC'), ('IT', 'IT'), ('Planning', 'Planning'), ('Export', 'Export'),
    ('Production', 'Production'), ('R&D', 'R&D'), ('IPC', 'IPC'), ('HR', 'HR'),
    ('المالية', 'Finance'), ('الخزنة', 'Treasury'),
    ('شؤون العاملين', 'Personnel Affairs'), ('الخدمات', 'Services')
  ) as v(name_ar, name_en)
 where not exists (select 1 from departments d
                    where lower(d.name_ar) = lower(v.name_ar) or lower(coalesce(d.name_en, '')) = lower(v.name_en));

-- ---------- Permission ----------
insert into permissions (code, module, name_ar, name_en) values
  ('customers.quick_add', 'customers', 'إضافة موظف سريعة من البحث', 'Quick-add employee from search')
on conflict (code) do nothing;

insert into role_permissions (role_id, permission_code)
select r.id, 'customers.quick_add' from roles r where r.code in ('BARISTA','RECEPTION','MANAGER')
on conflict do nothing;

-- ---------- RPC ----------
-- p_department: an existing department name (Arabic or English, any case) or a new one to create.
create or replace function quick_add_customer(p_code text, p_full_name text, p_department text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_code text := nullif(trim(p_code), ''); v_name text := nullif(trim(p_full_name), '');
        v_dept_name text := nullif(trim(p_department), ''); v_dept bigint; v_id bigint; v_new_dept boolean := false;
begin
  if not (has_perm('customers.quick_add') or has_perm('customers.manage')) then
    raise exception 'PERMISSION_DENIED:customers.quick_add' using errcode = '42501';
  end if;
  if v_code is null then raise exception 'CODE_REQUIRED'; end if;
  if v_name is null then raise exception 'NAME_REQUIRED'; end if;
  if exists (select 1 from customers where lower(code) = lower(v_code)) then
    raise exception 'CUSTOMER_CODE_EXISTS:%', v_code;
  end if;

  if v_dept_name is not null then
    select id into v_dept from departments
     where lower(name_ar) = lower(v_dept_name) or lower(coalesce(name_en, '')) = lower(v_dept_name)
     order by active desc, id limit 1;
    if v_dept is null then
      insert into departments (name_ar) values (v_dept_name) returning id into v_dept;
      v_new_dept := true;
    end if;
  end if;

  insert into customers (code, full_name, department_id, customer_type)
  values (v_code, v_name, v_dept, 'EMPLOYEE')
  returning id into v_id;

  perform log_audit('QUICK_ADD_CUSTOMER', 'customers', v_id::text, null,
                    jsonb_build_object('code', v_code, 'name', v_name, 'department', v_dept_name,
                                       'new_department', v_new_dept));
  return jsonb_build_object('id', v_id, 'department_id', v_dept, 'new_department', v_new_dept);
end $$;

revoke execute on function quick_add_customer(text, text, text) from public, anon;
grant execute on function quick_add_customer(text, text, text) to authenticated;
