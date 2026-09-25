import { h, put, btn, input, dataTable, toastError, fmtMoney, fmtNum, fmtDate, fmtDateTime, todayISO, exportExcel, printSheet } from '../ui.js';
import { t, lang } from '../i18n.js';
import { rpc } from '../api.js';
import { can } from '../session.js';
import { personMeta } from '../sales.js';

// ---------- small helpers ----------
const L = (ar, en) => (lang() === 'en' && en ? en : ar);
const itemName = (r) => { const p = L(r.product_ar, r.product_en); return r.variant_en === 'Regular' ? p : `${p} — ${L(r.variant_ar, r.variant_en)}`; };
const dept = (r) => L(r.dept_ar, r.dept_en) || t('no_department');
const money = (key, label) => ({ key, label: t(label), num: true, sum: true, render: (r) => fmtMoney(r[key]), x: (r) => Number(r[key]) });
const count = (key, label) => ({ key, label: t(label), num: true, sum: true, render: (r) => fmtNum(r[key]), x: (r) => Number(r[key]) });
const qtyU = (key, label) => ({ key, label: t(label), num: true, render: (r) => `${fmtNum(r[key])} ${lang() === 'en' ? r.unit : r.unit_ar}`, x: (r) => Number(r[key]) });
const openPerson = (r) => { if (r.id && (can('accounts.deposit') || can('payments.receive'))) location.hash = '#/reception?c=' + r.id; };

const REPORTS = [
  { k: 'by_person', perm: 'reports.sales', click: openPerson, cols: [
      { label: t('name'), render: (r) => h('div', null, h('b', null, r.name), h('div', { class: 'muted small' }, personMeta({ customer_type: r.type === 'GUEST' ? 'OTHER' : r.type, code: r.code, department_ar: r.dept_ar, department_en: r.dept_en, company: r.company }))), x: (r) => r.name },
      { label: t('code'), key: 'code', hideCard: true }, { label: t('department'), render: dept, hideCard: true },
      count('orders', 'rep_orders'), count('qty', 'rep_qty'), money('amount', 'rep_amount')] },
  { k: 'by_department', perm: 'reports.sales', cols: [
      { label: t('department'), render: (r) => h('b', null, dept(r)), x: dept },
      count('people', 'rep_people'), count('orders', 'rep_orders'), count('qty', 'rep_qty'), money('amount', 'rep_amount')] },
  { k: 'by_company', perm: 'reports.sales', cols: [
      { label: t('company'), render: (r) => h('b', null, r.company), x: (r) => r.company },
      { label: t('type'), render: (r) => t('ct.' + r.type), x: (r) => t('ct.' + r.type) },
      count('people', 'rep_people'), count('orders', 'rep_orders'), count('qty', 'rep_qty'), money('amount', 'rep_amount')] },
  { k: 'staff', perm: 'reports.sales', cols: [
      { label: t('user'), render: (r) => h('b', null, r.name), x: (r) => r.name },
      count('orders', 'rep_orders_created'), count('qty', 'rep_qty'), money('amount', 'rep_amount'),
      count('served', 'rep_served'), money('cash_orders', 'rep_cash_orders'), money('deposits', 'rep_deposits'), money('machine', 'machine_cash'), money('refunds', 'rep_refunds')] },
  { k: 'top_items', perm: 'reports.sales', cols: [
      { label: t('rep_item'), render: (r) => h('b', null, itemName(r)), x: itemName },
      count('orders', 'rep_orders'), count('qty', 'rep_qty'), money('amount', 'rep_amount'),
      { label: t('rep_share'), num: true, render: (r) => `${fmtNum(r.share, 1)}%`, x: (r) => r.share }] },
  { k: 'daily', perm: 'reports.sales', cols: [
      { label: t('date'), render: (r) => h('b', null, fmtDate(r.day)), x: (r) => r.day },
      count('orders', 'rep_orders'), count('qty', 'rep_qty'), money('amount', 'rep_amount'),
      money('cash_orders', 'rep_cash_orders'), money('deposits', 'rep_deposits'), money('machine', 'machine_cash'), money('refunds', 'rep_refunds'), count('cancelled', 'rep_cancelled')] },
  { k: 'collections', perm: 'reports.financial', cols: [
      { label: t('time'), render: (r) => fmtDateTime(r.at), x: (r) => fmtDateTime(r.at) },
      { label: t('receipt_no'), key: 'receipt_no' },
      { label: t('type'), render: (r) => t('pp.' + r.purpose), x: (r) => t('pp.' + r.purpose) },
      { label: t('customer'), render: (r) => r.customer || t('guest'), x: (r) => r.customer || '' },
      { label: t('user'), key: 'user' },
      { label: t('drawer'), render: (r) => (r.drawer ? t('drawer.' + r.drawer) : ''), x: (r) => (r.drawer ? t('drawer.' + r.drawer) : '') },
      { key: 'signed', label: t('amount'), num: true, sum: true, render: (r) => h('b', { class: r.direction === 'OUT' ? 'bad-text' : '' }, fmtMoney(r.signed)), x: (r) => Number(r.signed) }] },
  { k: 'receivables', perm: 'reports.financial', noPeriod: true, click: openPerson, cols: [
      { label: t('name'), render: (r) => h('div', null, h('b', null, r.name), h('div', { class: 'muted small' }, personMeta({ customer_type: r.type, code: r.code, department_ar: r.dept_ar, department_en: r.dept_en, company: r.company }))), x: (r) => r.name },
      { label: t('code'), key: 'code', hideCard: true }, { label: t('department'), render: dept, hideCard: true },
      money('due', 'due'), count('unpaid_count', 'unpaid_orders'),
      { label: t('open_since'), render: (r) => (r.oldest_unpaid ? fmtDate(r.oldest_unpaid) : '—'), x: (r) => r.oldest_unpaid || '' }] },
  { k: 'materials', perm: 'reports.inventory', cols: [
      { label: t('material'), render: (r) => h('b', null, L(r.name_ar, r.name_en)), x: (r) => L(r.name_ar, r.name_en) },
      qtyU('purchased', 'rep_purchased'), qtyU('consumed', 'rep_consumed'), qtyU('waste', 'rep_waste'), qtyU('adjusted', 'rep_adjusted'),
      money('consumed_value', 'rep_consumed_value'), money('waste_value', 'rep_waste_value'), qtyU('stock_now', 'rep_stock_now')] },
  { k: 'margin', perm: 'reports.cost', cols: [
      { label: t('rep_item'), render: (r) => h('b', null, itemName(r)), x: itemName },
      count('qty', 'rep_qty'), money('sales', 'rep_sales'), money('cost', 'rep_cost'), money('margin', 'rep_margin'),
      { label: t('rep_margin_pct'), num: true, render: (r) => (r.margin_pct == null ? '—' : `${fmtNum(r.margin_pct, 1)}%`), x: (r) => r.margin_pct }] },
];

// ---------- periods (Cairo dates as YYYY-MM-DD) ----------
const iso = (d) => d.toISOString().slice(0, 10);
const cairoToday = () => new Date(todayISO() + 'T12:00:00Z');
function period(kind) {
  const d = cairoToday();
  if (kind === 'today') return [iso(d), iso(d)];
  if (kind === 'yesterday') { d.setUTCDate(d.getUTCDate() - 1); return [iso(d), iso(d)]; }
  if (kind === 'week') { const s = new Date(d); s.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 1) % 7)); return [iso(s), iso(d)]; } // week starts Saturday
  if (kind === 'month') return [iso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1))), iso(d)];
  if (kind === 'last_month') {
    const s = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1));
    const e = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 0));
    return [iso(s), iso(e)];
  }
  return null;
}

export async function reportsPage(root) {
  const list = REPORTS.filter((r) => can(r.perm));
  if (!list.length) { root.append(h('div', { class: 'empty' }, t('rep_none'))); return; }
  let cur = list[0], pk = 'month', rows = [];
  let [from, to] = period(pk);

  const repBar = h('div', { class: 'chips scroll rep-kinds' });
  const perBar = h('div', { class: 'chips scroll' });
  const fromIn = input({ type: 'date', value: from });
  const toIn = input({ type: 'date', value: to });
  const periodBox = h('div', { class: 'rep-period' });
  const summary = h('div', { class: 'kpis rep-sum' });
  const table = h('div');
  const title = h('h2');
  const note = h('div', { class: 'muted small' });

  const drawKinds = () => put(repBar, list.map((r) => h('button', { type: 'button', class: 'chip' + (r === cur ? ' on' : ''),
    onclick: () => { cur = r; drawKinds(); load(); } }, t('rep.' + r.k))));
  const drawPeriods = () => put(perBar, ['today', 'yesterday', 'week', 'month', 'last_month'].map((k) => h('button', {
    type: 'button', class: 'chip' + (pk === k ? ' on' : ''),
    onclick: () => { pk = k; [from, to] = period(k); fromIn.value = from; toIn.value = to; drawPeriods(); load(); } }, t('per.' + k))));
  const onDate = () => { if (fromIn.value && toIn.value) { pk = 'custom'; from = fromIn.value; to = toIn.value; drawPeriods(); load(); } };
  fromIn.onchange = onDate; toIn.onchange = onDate;

  async function load() {
    periodBox.hidden = !!cur.noPeriod;
    title.textContent = t('rep.' + cur.k);
    note.textContent = cur.noPeriod ? t('rep_as_of_now') : `${fmtDate(from)} – ${fmtDate(to)}`;
    put(table, h('div', { class: 'muted' }, t('loading')));
    try {
      rows = await rpc('report', { p_kind: cur.k, p_from: from, p_to: to });
      if (cur.k === 'top_items') { const tot = rows.reduce((a, r) => a + Number(r.qty), 0) || 1; rows.forEach((r) => { r.share = (Number(r.qty) / tot) * 100; }); }
      if (cur.k === 'daily') rows = rows.filter((r) => Number(r.orders) || Number(r.deposits) || Number(r.refunds) || Number(r.cancelled) || Number(r.cash_orders) || Number(r.machine));
      if (cur.k === 'collections') rows.forEach((r) => { r.signed = r.direction === 'OUT' ? -Number(r.amount) : Number(r.amount); });
      draw();
    } catch (e) { put(table, h('div', { class: 'alert bad' }, e.message)); toastError(e); }
  }

  function draw() {
    const sums = cur.cols.filter((c) => c.sum);
    put(summary, [
      h('div', { class: 'kpi' }, h('div', { class: 'kpi-label' }, t('rep_rows')), h('div', { class: 'kpi-value num' }, fmtNum(rows.length))),
      ...sums.map((c) => {
        const v = rows.reduce((a, r) => a + (Number(r[c.key]) || 0), 0);
        return h('div', { class: 'kpi' }, h('div', { class: 'kpi-label' }, c.label), h('div', { class: 'kpi-value num' }, c.render({ [c.key]: v, unit: '', unit_ar: '' })));
      })]);
    put(table, dataTable(cur.cols.filter((c) => !c.hideCard), rows, { empty: t('rep_empty'), onRowClick: cur.click || null }));
  }

  const exportCols = () => cur.cols.map((c) => ({ label: c.label, x: c.x || ((r) => r[c.key] ?? '') }));
  root.append(
    h('section', { class: 'panel' },
      repBar,
      periodBox),
    h('section', { class: 'panel' },
      h('div', { class: 'panel-head' },
        h('div', null, title, note),
        h('div', { class: 'row' },
          btn(t('export_excel'), () => exportExcel('report-' + cur.k, exportCols(), rows), 'sm'),
          btn(t('print'), () => printSheet({
            title: t('rep.' + cur.k),
            meta: [[t('rep_period'), note.textContent], [t('rep_rows'), fmtNum(rows.length)]],
            body: dataTable(cur.cols.filter((c) => !c.hideCard), rows, { noCards: true }),
          }), 'sm'))),
      summary, table));
  put(periodBox, perBar, h('div', { class: 'rep-dates' }, h('label', null, h('span', { class: 'muted small' }, t('from')), fromIn), h('label', null, h('span', { class: 'muted small' }, t('to')), toIn)));
  drawKinds(); drawPeriods(); load();
}
