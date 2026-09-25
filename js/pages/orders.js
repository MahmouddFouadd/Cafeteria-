import { h, put, btn, input, select, field, dataTable, toastError, busy, fmtMoney, fmtDateTime, todayISO, exportExcel } from '../ui.js';
import { t } from '../i18n.js';
import { sb } from '../supabase.js';
import { q } from '../api.js';
import { customerLabel, payBadge, fulfilBadge, openOrder } from '../sales.js';

export async function ordersPage(root) {
  const from = input({ type: 'date', value: todayISO() });
  const to = input({ type: 'date', value: todayISO() });
  const status = select([
    ['', t('all')], ['OPEN', t('of.OPEN')], ['UNPAID', t('of.UNPAID')], ['SERVED', t('fs.SERVED')], ['CANCELLED', t('fs.CANCELLED')],
  ], '');
  const search = input({ type: 'search', placeholder: t('order_search_ph') });
  const sum = h('div', { class: 'muted', style: { marginBottom: '10px' } });
  const box = h('div');
  let rows = [];

  const cols = [
    { label: t('order_no'), key: 'order_no' },
    { label: t('time'), render: (o) => fmtDateTime(o.created_at) },
    { label: t('customer'), render: customerLabel },
    { label: t('items_count'), num: true, key: 'items_qty' },
    { label: t('total'), num: true, render: (o) => fmtMoney(o.total), x: (o) => Number(o.total) },
    { label: t('paid'), num: true, render: (o) => fmtMoney(o.paid_amount), x: (o) => Number(o.paid_amount) },
    { label: t('payment'), render: (o) => payBadge(o.payment_status), x: (o) => t('ps.' + o.payment_status) },
    { label: t('fulfillment'), render: (o) => fulfilBadge(o.fulfillment_status), x: (o) => t('fs.' + o.fulfillment_status) },
    { label: t('created_by'), render: (o) => o.created_by_name || '' },
  ];

  const showBtn = btn(t('show'), () => busy(showBtn, load), 'primary');
  root.append(h('div', { class: 'toolbar' },
    field(t('date_from'), from), field(t('date_to'), to), field(t('status'), status),
    h('div', { class: 'grow' }, field(t('search'), search)), showBtn,
    btn(t('export_excel'), () => exportExcel('orders', cols, filtered()))), sum, box);
  search.oninput = render;

  function filtered() {
    const s = search.value.trim().toLowerCase();
    return !s ? rows : rows.filter((o) => `${o.order_no} ${o.customer_name || ''} ${o.customer_code || ''} ${o.guest_name || ''}`.toLowerCase().includes(s));
  }
  function render() {
    const list = filtered();
    const live = list.filter((o) => o.fulfillment_status !== 'CANCELLED');
    sum.textContent = `${t('orders')}: ${live.length} — ${t('total')}: ${fmtMoney(live.reduce((s, o) => s + Number(o.total), 0))}`
      + ` — ${t('due')}: ${fmtMoney(live.reduce((s, o) => s + Number(o.due), 0))}`;
    put(box, dataTable(cols, list, { onRowClick: (o) => openOrder(o.id, { onChange: load }), empty: t('no_orders'),
      rowClass: (o) => (o.fulfillment_status === 'CANCELLED' ? 'row-muted' : '') }));
  }
  async function load() {
    try {
      let qb = sb.from('v_orders').select('*').gte('business_date', from.value).lte('business_date', to.value)
        .order('id', { ascending: false }).limit(1000);
      if (status.value === 'OPEN') qb = qb.in('fulfillment_status', ['NEW', 'PREPARING', 'READY']);
      if (status.value === 'UNPAID') qb = qb.in('payment_status', ['UNPAID', 'PARTIALLY_PAID']).neq('fulfillment_status', 'CANCELLED');
      if (status.value === 'SERVED' || status.value === 'CANCELLED') qb = qb.eq('fulfillment_status', status.value);
      rows = await q(qb);
      render();
    } catch (e) { toastError(e); }
  }
  await load();
}
