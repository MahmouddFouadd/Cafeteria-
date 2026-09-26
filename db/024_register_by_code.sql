-- =====================================================================
--  024_register_by_code.sql — employees register the app with their code only
--  (a name alone is never accepted; if a name is typed it must still match).
--  Every registration stays logged with the phone and IP, and a phone that
--  switches to another code is flagged in "Employee phones". Run after 023.
-- =====================================================================
set search_path = public, extensions;

create or replace function self_register(p_code text, p_name text, p_user_agent text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_ip text := _req_ip(); c customers; d self_devices;
        v_code text := trim(translate(coalesce(p_code, ''), '٠١٢٣٤٥٦٧٨٩', '0123456789'));
        v_first text;
begin
  if v_uid is null then raise exception 'SELF_NO_SESSION'; end if;
  if coalesce(v_code, '') = '' then raise exception 'SELF_CODE_NAME_REQUIRED'; end if;   -- the code is enough; a typed name is optional
  select * into c from customers where lower(code) = lower(v_code) and customer_type <> 'DEPARTMENT';
  v_first := split_part(_norm_name(trim(p_name)), ' ', 1);
  if not found or c.status <> 'ACTIVE'
     or (coalesce(trim(p_name), '') <> '' and (length(v_first) < 2 or position(v_first in _norm_name(c.full_name)) = 0)) then
    insert into self_device_events (device_uid, customer_id, event, typed_name, typed_code, ip, user_agent, details)
    values (v_uid, c.id, 'REJECTED', p_name, v_code, v_ip, left(p_user_agent, 300),
            case when c.id is null then 'code not found' when c.status <> 'ACTIVE' then 'person not active' else 'name does not match' end);
    return jsonb_build_object('error', 'SELF_NOT_MATCHED');        -- returned (not raised) so the attempt stays logged
  end if;

  select * into d from self_devices where device_uid = v_uid for update;
  if found then
    if d.blocked then
      insert into self_device_events (device_uid, customer_id, event, typed_name, typed_code, ip, user_agent)
      values (v_uid, c.id, 'BLOCKED_ATTEMPT', p_name, v_code, v_ip, left(p_user_agent, 300));
      return jsonb_build_object('error', 'SELF_DEVICE_BLOCKED');
    end if;
    if d.customer_id <> c.id then
      -- same phone, different person → keep the history and flag it
      insert into self_device_events (device_uid, customer_id, event, typed_name, typed_code, ip, user_agent, details)
      values (v_uid, c.id, 'SWITCH', p_name, v_code, v_ip, left(p_user_agent, 300), 'previous customer_id=' || d.customer_id);
    end if;
    update self_devices set customer_id = c.id, last_ip = v_ip, user_agent = left(p_user_agent, 300), last_seen = now() where device_uid = v_uid;
  else
    insert into self_devices (device_uid, customer_id, first_ip, last_ip, user_agent) values (v_uid, c.id, v_ip, v_ip, left(p_user_agent, 300));
    insert into self_device_events (device_uid, customer_id, event, typed_name, typed_code, ip, user_agent, details)
    values (v_uid, c.id,
            case when exists (select 1 from self_devices x where x.customer_id = c.id and x.device_uid <> v_uid) then 'NEW_DEVICE' else 'REGISTER' end,
            p_name, v_code, v_ip, left(p_user_agent, 300), null);
  end if;
  return self_me();
end $$;

