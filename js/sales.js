import { h, put, clear, btn, input, field, checkbox, dataTable, badge, modal, toast, toastError, busy,
         confirmDialog, fmtMoney, fmtNum, fmtDateTime, fmtDate, daysAgoISO, todayISO, printSheet, exportExcel } from './ui.js';
import { t, lang } from './i18n.js';
import { sb } from './supabase.js';
import { q, rpc } from './api.js';
import { can } from './session.js';

// ---------- Small helpers ----------
export const nmSnap = (o, base) => (lang() === 'en' && o[base + '_en_snap'] ? o[base + '_en_snap'] : o[base + '_ar_snap']);
export const lineName = (l) => (l.variant_name_en_snap === 'Regular' ? nmSnap(l, 'product_name') : `${nmSnap(l, 'product_name')} — ${nmSnap(l, 'variant_name')}`);
export const addonsText = (l) => (l.addons || []).map((a) => (lang() === 'en' && a.name_en ? a.name_en : a.name_ar)).join('، ');
export const customerLabel = (o) => (o.customer_id ? `${o.customer_name} (${o.customer_code})` : (o.guest_name || t('guest')));

export const payBadge = (s) => badge(t('ps.' + s), { PAID: 'ok', PARTIALLY_PAID: 'warn', UNPAID: 'bad', REFUNDED: '' }[s] || '');
export const fulfilBadge = (s) => badge(t('fs.' + s), { NEW: 'info', PREPARING: 'warn', READY: 'ok', SERVED: '', CANCELLED: 'bad' }[s] || '');

/** Balance text: prepaid / due */
export function balanceBlock(bal) {
  const b = Number(bal || 0);
  if (b > 0) return h('span', { class: 'bal bal-pos' }, `${t('balance_available')}: ${fmtMoney(b)}`);
  if (b < 0) return h('span', { class: 'bal bal-neg' }, `${t('balance_due')}: ${fmtMoney(-b)}`);
  return h('span', { class: 'bal' }, `${t('balance')}: ${fmtMoney(0)}`);
}

const cleanTerm = (s) => s.replace(/[,()%*\\]/g, ' ').trim();

export async function searchCustomers(term, { activeOnly = true, limit = 8 } = {}) {
  const s = cleanTerm(term);
  if (!s) return [];
  let qb = sb.from('v_customer_summary').select('*').or(`code.ilike.${s}%,full_name.ilike.%${s}%`).order('full_name').limit(limit);
  if (activeOnly) qb = qb.eq('status', 'ACTIVE');
  return q(qb);
}

export async function loadCustomer(id) {
  const rows = await q(sb.from('v_customer_summary').select('*').eq('id', id));
  return rows[0] || null;
}

/** Search box with a result list. onPick(customerSummaryRow)
 *  When nothing matches, users with customers.quick_add get an inline form
 *  to add the employee (and a new department if needed) and pick them at once. */
let deptCache = null;
async function departmentsList() {
  if (!deptCache) deptCache = await q(sb.from('departments').select('id,name_ar,name_en').eq('active', true).order('name_ar'));
  return deptCache;
}
let pickerSeq = 0;

export function customerPicker({ onPick, placeholder, autofocus = false, activeOnly = true }) {
  const inp = input({ type: 'search', placeholder: placeholder || t('customer_search_ph'), autocomplete: 'off', enterkeyhint: 'search' });
  const list = h('div', { class: 'pick-list', role: 'listbox' });
  const canAdd = can('customers.quick_add') || can('customers.manage');
  let timer = null, rows = [], seq = 0;
  const run = async () => {
    const my = ++seq;
    try {
      rows = await searchCustomers(inp.value, { activeOnly });
      if (my !== seq) return;
      const term = inp.value.trim();
      if (rows.length) {
        put(list, rows.map((r) => h('button', { type: 'button', class: 'pick-item', role: 'option', onclick: () => choose(r) },
          h('div', null, h('b', null, r.full_name), h('span', { class: 'muted small' }, ` ${r.code}${r.department_ar ? ' · ' + (lang() === 'en' && r.department_en ? r.department_en : r.department_ar) : ''}`)),
          balanceBlock(r.balance))));
      } else if (term && canAdd) {
        put(list, await quickAddForm(term));
      } else {
        put(list, term ? h('div', { class: 'muted small pick-empty' }, t('no_customer_found')) : null);
      }
    } catch (e) { toastError(e); }
  };

  async function quickAddForm(term) {
    const looksLikeCode = /\d/.test(term) && !/\s/.test(term);
    const codeIn = input({ value: looksLikeCode ? term : '', placeholder: t('code'), autocomplete: 'off' });
    const nameIn = input({ value: looksLikeCode ? '' : term, placeholder: t('qa_name_ph'), autocomplete: 'off' });
    const dlId = 'qa-depts-' + (++pickerSeq);
    const depts = await departmentsList().catch(() => []);
    const deptIn = input({ placeholder: t('qa_dept_ph'), autocomplete: 'off', list: dlId });
    const dl = h('datalist', { id: dlId }, depts.map((d) => h('option', { value: lang() === 'en' && d.name_en ? d.name_en : d.name_ar })));
    const chips = h('div', { class: 'chips qa-depts' }, depts.slice(0, 16).map((d) => {
      const label = lang() === 'en' && d.name_en ? d.name_en : d.name_ar;
      return h('button', { type: 'button', class: 'chip', onclick: (e) => {
        deptIn.value = label; chips.querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', c === e.currentTarget));
      } }, label);
    }));
    deptIn.oninput = () => chips.querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', c.textContent === deptIn.value.trim()));
    const addBtn = btn(t('qa_add_pick'), () => busy(addBtn, async () => { try {
      if (!codeIn.value.trim()) { codeIn.focus(); return toast(t('err.CODE_REQUIRED'), 'bad'); }
      if (!nameIn.value.trim()) { nameIn.focus(); return toast(t('err.NAME_REQUIRED'), 'bad'); }
      const res = await rpc('quick_add_customer', { p_code: codeIn.value.trim(), p_full_name: nameIn.value.trim(), p_department: deptIn.value.trim() || null });
      if (res.new_department) deptCache = null;
      const row = await loadCustomer(res.id);
      toast(t('qa_added'), 'ok');
      if (row) choose(row);
    } catch (err) { toastError(err); } }), 'primary');
    [codeIn, nameIn, deptIn].forEach((el) => el.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addBtn.click(); } }));
    setTimeout(() => (looksLikeCode ? nameIn : codeIn).focus(), 50);
    return h('div', { class: 'quick-add' },
      h('div', { class: 'qa-title' }, t('qa_title')),
      h('div', { class: 'qa-grid' },
        field(t('code'), codeIn), field(t('name'), nameIn)),
      field(t('department'), deptIn), dl, chips,
      h('div', { class: 'muted small' }, t('qa_dept_hint')),
      h('div', { class: 'form-actions' }, addBtn));
  }

  function choose(r) { inp.value = ''; clear(list); rows = []; onPick(r); }
  inp.oninput = () => { clearTimeout(timer); timer = setTimeout(run, 220); };
  inp.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); clearTimeout(timer); run().then(() => { if (rows.length === 1) choose(rows[0]); }); } };
  if (autofocus) setTimeout(() => inp.focus(), 60);
  return { el: h('div', { class: 'picker' }, inp, list), input: inp };
}

// ---------- Receipt ----------
export async function printOrderReceipt(orderId) {
  try {
    const [[o], lines] = await Promise.all([
      q(sb.from('v_orders').select('*').eq('id', orderId)),
      q(sb.from('v_order_lines').select('*').eq('order_id', orderId).order('id')),
    ]);
    if (!o) return;
    const table = dataTable([
      { label: t('item'), render: (l) => lineName(l) + (l.addons?.length ? ` (+ ${addonsText(l)})` : '') },
      { label: t('qty'), num: true, key: 'qty' },
      { label: t('unit_price'), num: true, render: (l) => fmtMoney(Number(l.unit_price) + Number(l.addons_total)) },
      { label: t('total'), num: true, render: (l) => fmtMoney(l.line_total) },
    ], lines);
    printSheet({
      title: `${t('receipt')} ${o.order_no}`,
      meta: [
        [t('date'), fmtDateTime(o.created_at)], [t('customer'), customerLabel(o)],
        [t('total'), fmtMoney(o.total)], [t('paid'), fmtMoney(o.paid_amount)],
        ...(Number(o.due) > 0 ? [[t('due'), fmtMoney(o.due)]] : []),
        [t('created_by'), o.created_by_name || ''],
        ...(o.fulfillment_status === 'CANCELLED' ? [[t('status'), t('fs.CANCELLED')]] : []),
      ],
      body: table,
    });
  } catch (e) { toastError(e); }
}

// ---------- Order details ----------
export async function openOrder(orderId, { onChange } = {}) {
  let o, lines, pays = [];
  try {
    [[o], lines] = await Promise.all([
      q(sb.from('v_orders').select('*').eq('id', orderId)),
      q(sb.from('v_order_lines').select('*').eq('order_id', orderId).order('id')),
    ]);
    if (can('payments.view')) pays = await q(sb.from('order_payments').select('*').eq('order_id', orderId).order('id'));
  } catch (e) { toastError(e); return; }
  if (!o) return;

  const meta = [
    [t('order_no'), o.order_no], [t('date'), fmtDateTime(o.created_at)], [t('customer'), customerLabel(o)],
    [t('fulfillment'), fulfilBadge(o.fulfillment_status)], [t('payment'), payBadge(o.payment_status)],
    [t('total'), fmtMoney(o.total)], [t('paid'), fmtMoney(o.paid_amount)],
    ...(Number(o.due) > 0 && o.fulfillment_status !== 'CANCELLED' ? [[t('due'), fmtMoney(o.due)]] : []),
    [t('created_by'), o.created_by_name || ''],
    ...(o.served_by_name ? [[t('served_by'), `${o.served_by_name} ${fmtDateTime(o.served_at)}`]] : []),
    ...(o.paid_by_name ? [[t('paid_by'), `${o.paid_by_name} ${fmtDateTime(o.paid_at)}`]] : []),
    ...(o.cancelled_at ? [[t('cancelled'), `${o.cancelled_by_name || ''} ${fmtDateTime(o.cancelled_at)} — ${o.cancel_reason}`]] : []),
    ...(o.notes ? [[t('notes'), o.notes]] : []),
  ];
  const body = h('div', null,
    h('dl', { class: 'kv' }, meta.map(([k, v]) => [h('dt', null, k), h('dd', null, v)])),
    dataTable([
      { label: t('item'), render: (l) => h('div', null, lineName(l), l.addons?.length ? h('div', { class: 'muted small' }, '+ ' + addonsText(l)) : null, l.notes ? h('div', { class: 'muted small' }, l.notes) : null) },
      { label: t('qty'), num: true, key: 'qty' },
      { label: t('unit_price'), num: true, render: (l) => fmtMoney(Number(l.unit_price) + Number(l.addons_total)) },
      { label: t('total'), num: true, render: (l) => fmtMoney(l.line_total) },
    ], lines),
    pays.length ? h('div', { style: { marginTop: '14px' } }, h('h3', { class: 'sub' }, t('payments')),
      dataTable([
        { label: t('date'), render: (p) => fmtDateTime(p.created_at) },
        { label: t('method'), render: (p) => t('pm.' + p.method) },
        { label: t('amount'), num: true, render: (p) => fmtMoney(p.amount) },
      ], pays)) : null);

  const canCancel = o.fulfillment_status !== 'CANCELLED' && can('orders.cancel');
  const m = modal({
    title: `${t('order')} ${o.order_no}`, wide: true, body,
    actions: [
      btn(t('print_receipt'), () => printOrderReceipt(o.id)),
      canCancel ? btn(t('cancel_order'), () => cancelFlow(o, () => { m.close(); onChange && onChange(); }), 'danger') : null,
      btn(t('close'), () => m.close()),
    ].filter(Boolean),
  });
}

export async function cancelFlow(o, after) {
  const prepared = checkbox(t('was_prepared'), ['PREPARING', 'READY', 'SERVED'].includes(o.fulfillment_status));
  const reason = h('textarea', { class: 'input', rows: 2 });
  const okBtn = btn(t('cancel_order'), () => busy(okBtn, async () => {
    const r = reason.value.trim();
    if (!r) { toast(t('reason_required'), 'warn'); reason.focus(); return; }
    try {
      const res = await rpc('cancel_order', { p_order_id: o.id, p_reason: r, p_was_prepared: prepared.input.checked });
      toast(t('order_cancelled', { no: res.order_no }) + (Number(res.cash_refund) ? ` — ${t('cash_back')}: ${fmtMoney(res.cash_refund)}` : ''), 'ok', 7000);
      m.close(); after && after();
    } catch (e) { toastError(e); }
  }), 'danger');
  const m = modal({
    title: `${t('cancel_order')} ${o.order_no}`,
    body: h('div', { style: { display: 'grid', gap: '12px' } },
      h('div', { class: 'alert warn' }, t('cancel_hint')),
      field(t('reason') + ' *', reason), prepared,
      h('p', { class: 'muted small', style: { margin: 0 } }, t('was_prepared_hint'))),
    actions: [btn(t('back'), () => m.close()), okBtn],
  });
}

// ---------- Ledger ----------
export async function openLedger(c) {
  const from = input({ type: 'date', value: daysAgoISO(90) });
  const to = input({ type: 'date', value: todayISO() });
  const box = h('div');
  let rows = [];
  const cols = [
    { label: t('date'), render: (r) => fmtDateTime(r.created_at), x: (r) => fmtDateTime(r.created_at) },
    { label: t('type'), render: (r) => t('tt.' + r.txn_type), x: (r) => t('tt.' + r.txn_type) },
    { label: t('reference'), render: (r) => r.reference_no || '' },
    { label: t('debit'), num: true, render: (r) => (Number(r.debit) ? fmtMoney(r.debit) : ''), x: (r) => Number(r.debit) || '' },
    { label: t('credit'), num: true, render: (r) => (Number(r.credit) ? fmtMoney(r.credit) : ''), x: (r) => Number(r.credit) || '' },
    { label: t('balance'), num: true, render: (r) => fmtMoney(r.balance_after), x: (r) => Number(r.balance_after) },
    { label: t('user'), render: (r) => r.created_by_name || '' },
    { label: t('notes'), render: (r) => r.notes || '' },
  ];
  const load = async () => {
    try {
      rows = await q(sb.from('v_account_ledger').select('*').eq('customer_id', c.id)
        .gte('business_date', from.value).lte('business_date', to.value).order('id').limit(2000));
      put(box, dataTable(cols, rows, { empty: t('no_movements') }));
    } catch (e) { toastError(e); }
  };
  const showBtn = btn(t('show'), () => busy(showBtn, load), 'primary');
  const meta = () => [[t('customer'), `${c.full_name} (${c.code})`], [t('date_from'), fmtDate(from.value)], [t('date_to'), fmtDate(to.value)],
    [t('balance_now'), fmtMoney(c.balance)]];
  const m = modal({
    title: `${t('ledger')}: ${c.full_name}`, wide: true,
    body: h('div', null,
      h('div', { class: 'toolbar' }, field(t('date_from'), from), field(t('date_to'), to), showBtn),
      h('div', { style: { marginBottom: '10px' } }, balanceBlock(c.balance)), box),
    actions: [
      btn(t('print'), () => printSheet({ title: `${t('ledger')}: ${c.full_name}`, meta: meta(), body: dataTable(cols, rows) })),
      btn(t('export_excel'), () => exportExcel(`ledger-${c.code}`, cols, rows)),
      btn(t('close'), () => m.close()),
    ],
  });
  await load();
}

// ---------- Consumption (what the person drank) ----------
export async function openConsumption(c) {
  const from = input({ type: 'date', value: daysAgoISO(30) });
  const to = input({ type: 'date', value: todayISO() });
  const box = h('div');
  const sum = h('div', { class: 'muted', style: { margin: '8px 0' } });
  let rows = [];
  const cols = [
    { label: t('date'), render: (r) => fmtDateTime(r.created_at), x: (r) => fmtDateTime(r.created_at) },
    { label: t('order_no'), key: 'order_no' },
    { label: t('drink'), render: (r) => nmSnap(r, 'product_name') },
    { label: t('variant'), render: (r) => nmSnap(r, 'variant_name') + (r.addons?.length ? ` + ${addonsText(r)}` : '') },
    { label: t('qty'), num: true, key: 'qty' },
    { label: t('amount'), num: true, render: (r) => fmtMoney(r.line_total), x: (r) => Number(r.line_total) },
    { label: t('payment'), render: (r) => t('ps.' + r.payment_status), x: (r) => t('ps.' + r.payment_status) },
  ];
  const load = async () => {
    try {
      rows = await q(sb.from('v_order_lines').select('*').eq('customer_id', c.id).neq('fulfillment_status', 'CANCELLED')
        .gte('business_date', from.value).lte('business_date', to.value).order('id', { ascending: false }).limit(2000));
      const total = rows.reduce((s, r) => s + Number(r.line_total), 0);
      const qty = rows.reduce((s, r) => s + Number(r.qty), 0);
      sum.textContent = `${t('items_count')}: ${fmtNum(qty)} — ${t('total')}: ${fmtMoney(total)}`;
      put(box, dataTable(cols, rows, { empty: t('no_orders') }));
    } catch (e) { toastError(e); }
  };
  const showBtn = btn(t('show'), () => busy(showBtn, load), 'primary');
  const m = modal({
    title: `${t('consumption_report')}: ${c.full_name}`, wide: true,
    body: h('div', null, h('div', { class: 'toolbar' }, field(t('date_from'), from), field(t('date_to'), to), showBtn), sum, box),
    actions: [
      btn(t('print'), () => printSheet({ title: `${t('consumption_report')}: ${c.full_name}`,
        meta: [[t('customer'), `${c.full_name} (${c.code})`], [t('date_from'), fmtDate(from.value)], [t('date_to'), fmtDate(to.value)], [t('total'), sum.textContent]],
        body: dataTable(cols, rows) })),
      btn(t('export_excel'), () => exportExcel(`consumption-${c.code}`, cols, rows)),
      btn(t('close'), () => m.close()),
    ],
  });
  await load();
}

// ---------- Money dialogs ----------
function amountDialog({ title, hint, okLabel, needReason = false, signed = false, extra = null, onOk }) {
  return new Promise((resolve) => {
    const amt = input({ type: 'number', step: '0.01', min: signed ? null : '0', inputmode: 'decimal' });
    const note = h('textarea', { class: 'input', rows: 2 });
    let done = false;
    const okBtn = btn(okLabel, () => busy(okBtn, async () => {
      const v = Number(amt.value);
      if (!amt.value || !v || (!signed && v < 0)) { toast(t('err.AMOUNT_INVALID'), 'warn'); amt.focus(); return; }
      if (needReason && !note.value.trim()) { toast(t('reason_required'), 'warn'); note.focus(); return; }
      try { const res = await onOk(v, note.value.trim() || null); done = true; m.close(); resolve(res); }
      catch (e) { toastError(e); }
    }), 'primary');
    const m = modal({
      title,
      body: h('div', { style: { display: 'grid', gap: '12px' } },
        hint ? h('div', { class: 'alert info' }, hint) : null, extra,
        field(t('amount') + ' *', amt), field(needReason ? t('reason') + ' *' : t('notes'), note)),
      actions: [btn(t('cancel'), () => m.close()), okBtn],
      onClose: () => { if (!done) resolve(null); },
    });
  });
}

export async function depositFlow(c) {
  const res = await amountDialog({
    title: `${t('deposit')}: ${c.full_name}`, hint: t('deposit_hint'), okLabel: t('confirm_deposit'),
    onOk: async (v, n) => ({ ...(await rpc('deposit', { p_customer_id: c.id, p_amount: v, p_notes: n })), amount: v }),
  });
  if (res) {
    toast(t('deposit_done', { no: res.receipt_no }) + (res.settled_orders ? ` — ${t('settled_n', { n: res.settled_orders })}` : ''), 'ok', 7000);
    printMoneyReceipt(c, t('deposit'), res);
  }
  return res;
}

export async function adjustFlow(c) {
  const type = h('select', { class: 'input' }, h('option', { value: 'ADJUSTMENT' }, t('tt.ADJUSTMENT')), h('option', { value: 'OPENING' }, t('tt.OPENING')));
  const res = await amountDialog({
    title: `${t('adjust')}: ${c.full_name}`, hint: t('adjust_hint'), okLabel: t('save'), needReason: true, signed: true,
    extra: field(t('type'), type),
    onOk: (v, n) => rpc('account_adjust', { p_customer_id: c.id, p_amount: v, p_reason: n, p_type: type.value }),
  });
  if (res) toast(t('saved'), 'ok');
  return res;
}

export async function refundFlow(c) {
  const res = await amountDialog({
    title: `${t('refund_balance')}: ${c.full_name}`, hint: t('refund_hint'), okLabel: t('refund_balance'), needReason: true,
    onOk: async (v, n) => ({ ...(await rpc('refund_balance', { p_customer_id: c.id, p_amount: v, p_reason: n })), amount: v }),
  });
  if (res) { toast(t('saved'), 'ok'); printMoneyReceipt(c, t('refund_balance'), res); }
  return res;
}

async function printMoneyReceipt(c, kind, res) {
  const ok = await confirmDialog(t('print_receipt_q'), { okLabel: t('print') });
  if (!ok.ok) return;
  printSheet({ title: `${kind} ${res.receipt_no}`,
    meta: [[t('customer'), `${c.full_name} (${c.code})`], [t('date'), fmtDateTime(new Date())],
           [t('amount'), fmtMoney(res.amount)], [t('balance_now'), fmtMoney(res.balance)]],
    body: h('div'), signatures: [t('sig.received'), t('sig.customer')] });
}
