-- =====================================================================
--  019_self_serve_guard.sql — app orders can't skip preparation, and a
--  cash-on-delivery order can't be served without recording its cash.
--  Run once after 018.
-- =====================================================================
set search_path = public, extensions;

create or replace function set_order_status(p_order_id bigint, p_status text)
returns void language plpgsql security definer set search_path = public as $$
declare o orders; v_rank_old int; v_rank_new int;
begin
  perform require_perm('orders.update_status');
  select * into o from orders where id = p_order_id for update;
  if not found then raise exception 'ORDER_NOT_FOUND'; end if;
  if o.fulfillment_status = 'CANCELLED' then raise exception 'ORDER_CANCELLED'; end if;
  -- app orders: always through "preparing" (that's what notifies the employee),
  -- and a cash-on-delivery order is only served together with its cash (self_cash_served)
  if o.source = 'SELF' and o.fulfillment_status = 'NEW' and p_status in ('READY','SERVED') then
    raise exception 'SELF_PREP_FIRST';
  end if;
  if p_status = 'SERVED' and o.source = 'SELF' and o.pay_request = 'CASH' and o.cash_collected_at is null and o.total > 0 then
    raise exception 'SELF_CASH_PENDING';
  end if;
  v_rank_old := array_position(array['NEW','PREPARING','READY','SERVED'], o.fulfillment_status);
  v_rank_new := array_position(array['NEW','PREPARING','READY','SERVED'], p_status);
  if v_rank_new is null or v_rank_new <= v_rank_old then raise exception 'STATUS_INVALID:%', p_status; end if;
  update orders set
    fulfillment_status = p_status,
    prepared_by = case when p_status = 'PREPARING' or (prepared_by is null and v_rank_new >= 2) then coalesce(prepared_by, auth.uid()) else prepared_by end,
    prepared_at = case when prepared_at is null and v_rank_new >= 2 then now() else prepared_at end,
    ready_at    = case when ready_at is null and v_rank_new >= 3 then now() else ready_at end,
    served_by   = case when p_status = 'SERVED' then auth.uid() else served_by end,
    served_at   = case when p_status = 'SERVED' then now() else served_at end
  where id = p_order_id;
end $$;

