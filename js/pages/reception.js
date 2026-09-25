import { h, put, clear, btn, dataTable, toastError, fmtMoney, fmtDateTime, todayISO } from '../ui.js';
import { t, lang } from '../i18n.js';
import { sb } from '../supabase.js';
import { q } from '../api.js';
import { can, session } from '../session.js';
import { customerPicker, balanceBlock, loadCustomer, openLedger, openConsumption, openOrder,
         depositFlow, adjustFlow, refundFlow, payBadge, fulfilBadge } from '../sales.js';

export async function receptionPage(root) {
  const cardBox = h('div');
  const today = h('section', { class: 'panel' });
  let current = null;

  const picker = customerPicker({ onPick: (r) => show(r.id), autofocus: true, activeOnly: false, people: false });
  root.append(
    h('section', { class: 'panel' }, h('h2', null, t('find_customer')), picker.el),
    cardBox, today);

  async function show(id) {
    try { current = await loadCustomer(id); } catch (e) { toastError(e); return; }
    if (!current) return;
    const c = current;
    const unpaid = await q(sb.from('v_orders').select('*').eq('customer_id', c.id)
      .in('payment_status', ['UNPAID', 'PARTIALLY_PAID']).neq('fulfillment_status', 'CANCELLED').order('id')).catch(() => []);
    const refresh = async (res) => { if (res) { await show(c.id); loadToday(); } };
    put(cardBox, h('section', { class: 'panel cust-panel' },
      h('div', { class: 'cust-head' },
        h('div', { class: 'grow' },
          h('h2', null, c.full_name, c.status !== 'ACTIVE' ? h('span', { class: 'badge bad', style: { marginInlineStart: '8px' } }, t('cs.' + c.status)) : null),
          h('div', { class: 'muted' }, `${t('code')}: ${c.code}`, c.department_ar ? ` · ${lang() === 'en' && c.department_en ? c.department_en : c.department_ar}` : '', c.phone ? ` · ${c.phone}` : '')),
        btn(t('close'), () => { current = null; clear(cardBox); picker.input.focus(); }, 'sm')),
      h('div', { class: 'stats' },
        stat(t('balance'), balanceBlock(c.balance)),
        stat(t('unpaid_orders'), `${fmtMoney(c.unpaid_amount)} (${c.unpaid_count})`),
        stat(t('today'), `${c.today_orders} ${t('orders_word')} — ${fmtMoney(c.today_amount)}`),
        c.credit_limit != null ? stat(t('credit_limit'), fmtMoney(c.credit_limit)) : null),
      h('div', { class: 'actions-row' },
        can('pos.create_order') && c.status === 'ACTIVE' ? btn(t('new_order'), () => { session.posCustomer = c; location.hash = '#/pos'; }, 'primary') : null,
        can('accounts.deposit') && c.status === 'ACTIVE' ? btn(t('deposit'), async () => refresh(await depositFlow(c)), 'primary') : null,
        can('accounts.view') ? btn(t('ledger'), () => openLedger(c)) : null,
        can('orders.view') ? btn(t('consumption_report'), () => openConsumption(c)) : null,
        can('accounts.adjust') ? btn(t('adjust'), async () => refresh(await adjustFlow(c))) : null,
        can('payments.refund') && Number(c.balance) > 0 ? btn(t('refund_balance'), async () => refresh(await refundFlow(c))) : null),
      unpaid.length ? h('div', { style: { marginTop: '16px' } },
        h('h3', { class: 'sub' }, t('unpaid_orders')),
        dataTable([
          { label: t('order_no'), key: 'order_no' },
          { label: t('date'), render: (o) => fmtDateTime(o.created_at) },
          { label: t('total'), num: true, render: (o) => fmtMoney(o.total) },
          { label: t('due'), num: true, render: (o) => fmtMoney(o.due) },
          { label: t('payment'), render: (o) => payBadge(o.payment_status) },
        ], unpaid, { onRowClick: (o) => openOrder(o.id, { onChange: () => show(c.id) }) }),
        h('p', { class: 'muted small' }, t('deposit_settles_note'))) : null));
  }

  const qc = Number(new URLSearchParams(location.hash.split('?')[1] || '').get('c'));
  if (qc) show(qc);

  function stat(label, value) { return h('div', { class: 'stat' }, h('span', { class: 'muted small' }, label), h('div', null, value)); }

  async function loadToday() {
    if (!can('payments.view')) { today.remove(); return; }
    try {
      const [pays, orders] = await Promise.all([
        q(sb.from('v_payments').select('*').eq('business_date', todayISO()).order('id', { ascending: false }).limit(50)),
        q(sb.from('v_orders').select('*').eq('business_date', todayISO()).order('id', { ascending: false }).limit(30)),
      ]);
      const cashIn = pays.filter((p) => p.direction === 'IN').reduce((s, p) => s + Number(p.amount), 0);
      const cashOut = pays.filter((p) => p.direction === 'OUT').reduce((s, p) => s + Number(p.amount), 0);
      put(today,
        h('div', { class: 'panel-head' }, h('h2', null, t('today_activity')),
          h('span', { class: 'muted small' }, `${t('cash_in')}: ${fmtMoney(cashIn)} — ${t('cash_out')}: ${fmtMoney(cashOut)}`),
          can('closing.perform') ? h('a', { href: '#/closing', class: 'btn sm' }, t('nav.closing')) : null),
        h('h3', { class: 'sub' }, t('latest_orders')),
        dataTable([
          { label: t('order_no'), key: 'order_no' },
          { label: t('time'), render: (o) => fmtDateTime(o.created_at) },
          { label: t('customer'), render: (o) => (o.customer_id ? o.customer_name : (o.guest_name || t('guest'))) },
          { label: t('total'), num: true, render: (o) => fmtMoney(o.total) },
          { label: t('payment'), render: (o) => payBadge(o.payment_status) },
          { label: t('fulfillment'), render: (o) => fulfilBadge(o.fulfillment_status) },
        ], orders, { onRowClick: (o) => openOrder(o.id, { onChange: loadToday }), empty: t('no_orders') }),
        h('h3', { class: 'sub', style: { marginTop: '16px' } }, t('latest_payments')),
        dataTable([
          { label: t('receipt_no'), key: 'receipt_no' },
          { label: t('time'), render: (p) => fmtDateTime(p.created_at) },
          { label: t('type'), render: (p) => t('pp.' + p.purpose) },
          { label: t('customer'), render: (p) => p.customer_name || t('guest') },
          { label: t('amount'), num: true, render: (p) => (p.direction === 'OUT' ? '−' : '') + fmtMoney(p.amount) },
          { label: t('user'), render: (p) => p.created_by_name || '' },
        ], pays, { empty: t('no_payments') }));
    } catch (e) { toastError(e); }
  }
  loadToday();
}
