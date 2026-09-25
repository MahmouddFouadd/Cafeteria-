import { h, put, clear, btn, input, select, dataTable, toastError, fmtMoney, fmtNum, fmtDateTime, fmtDate, todayISO, exportExcel, printSheet } from '../ui.js';
import { t, lang } from '../i18n.js';
import { sb } from '../supabase.js';
import { q } from '../api.js';
import { can, session } from '../session.js';
import { customerPicker, balanceBlock, loadCustomer, openLedger, openConsumption, openOrder,
         depositFlow, adjustFlow, refundFlow, payBadge, fulfilBadge, personMeta } from '../sales.js';

export async function receptionPage(root) {
  const cardBox = h('div');
  const today = h('section', { class: 'panel' });
  const dues = h('section', { class: 'panel dues' });
  let current = null;

  const picker = customerPicker({ onPick: (r) => show(r.id), autofocus: true, activeOnly: false, people: false });
  // Two views: who owes money (collection) and today's activity
  let view = 'DUES';
  const seg = h('div', { class: 'seg rec-tabs' });
  const drawTabs = () => {
    put(seg, [['DUES', t('rec_tab_dues')], ['TODAY', t('rec_tab_today')]].map(([k, label]) =>
      h('button', { type: 'button', class: view === k ? 'on' : '', onclick: () => { view = k; drawTabs(); } }, label)));
    dues.hidden = view !== 'DUES'; today.hidden = view !== 'TODAY';
  };
  root.append(
    h('section', { class: 'panel' }, h('h2', null, t('find_person_or_dept')), picker.el),
    cardBox, seg, dues, today);
  drawTabs();

  async function show(id) {
    try { current = await loadCustomer(id); } catch (e) { toastError(e); return; }
    if (!current) return;
    const c = current;
    const unpaid = await q(sb.from('v_orders').select('*').eq('customer_id', c.id)
      .in('payment_status', ['UNPAID', 'PARTIALLY_PAID']).neq('fulfillment_status', 'CANCELLED').order('id')).catch(() => []);
    const refresh = async (res) => { if (res) { await show(c.id); loadToday(); loadDues(); } };
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

  // ---------- Collection: everyone who owes money ----------
  let dueRows = [];
  const dSearch = input({ type: 'search', placeholder: t('dues_search_ph') });
  const KINDS = [['', t('all')], ['PEOPLE', t('kind_people')], ['DEPARTMENT', t('kind_departments')],
                 ['VISITOR', t('ct.VISITOR')], ['TRAINEE', t('ct.TRAINEE')]];
  let kind = '', sort = 'DUE';
  const kindBar = h('div', { class: 'chips scroll' });
  const deptSel = select([['', t('all_departments')]], '');
  const sortSel = select([['DUE', t('sort_biggest')], ['OLD', t('sort_oldest')], ['NAME', t('sort_name')]], 'DUE');
  const dSummary = h('div', { class: 'dues-summary' });
  const dList = h('div');
  const byDept = h('div');
  const drawKinds = () => put(kindBar, KINDS.map(([k, label]) => h('button', { type: 'button', class: 'chip' + (kind === k ? ' on' : ''),
    onclick: () => { kind = k; drawKinds(); drawDues(); } }, label)));
  const deptLabel = (r) => (lang() === 'en' && r.department_en ? r.department_en : r.department_ar) || '—';

  function filteredDues() {
    const s = dSearch.value.trim().toLowerCase();
    let list = dueRows.filter((r) =>
      (!kind || (kind === 'PEOPLE' ? r.customer_type !== 'DEPARTMENT' : r.customer_type === kind))
      && (!deptSel.value || String(r.department_id) === deptSel.value)
      && (!s || `${r.code} ${r.full_name} ${r.company || ''} ${r.department_ar || ''} ${r.department_en || ''}`.toLowerCase().includes(s)));
    if (sort === 'DUE') list = list.sort((a, b) => Number(b.due) - Number(a.due));
    else if (sort === 'OLD') list = list.sort((a, b) => String(a.oldest_unpaid || '9').localeCompare(String(b.oldest_unpaid || '9')));
    else list = list.sort((a, b) => a.full_name.localeCompare(b.full_name, 'ar'));
    return list;
  }

  const dueCols = [
    { label: t('name'), render: (r) => h('div', null,
        h('a', { href: '#', class: 'cust-link', onclick: (e) => { e.preventDefault(); show(r.id); window.scrollTo({ top: 0, behavior: 'smooth' }); } }, r.full_name),
        h('div', { class: 'muted small' }, personMeta(r))), x: (r) => r.full_name },
    { label: t('due'), num: true, render: (r) => h('b', { class: 'bad-text' }, fmtMoney(r.due)), x: (r) => Number(r.due) },
    { label: t('unpaid_orders'), num: true, render: (r) => fmtNum(r.unpaid_count), x: (r) => Number(r.unpaid_count) },
    { label: t('open_since'), render: (r) => (r.oldest_unpaid ? `${fmtDate(r.oldest_unpaid)} (${Number(r.days_open) ? t('days_n', { n: r.days_open }) : t('today')})` : '—'), x: (r) => r.oldest_unpaid || '' },
    { label: '', render: (r) => h('div', { class: 'row-actions' },
        can('accounts.deposit') ? btn(t('collect'), async () => {
          const c = await loadCustomer(r.id);
          if (c && await depositFlow(c)) { loadDues(); loadToday(); if (current?.id === r.id) show(r.id); }
        }, 'sm primary') : null,
        can('accounts.view') ? btn(t('ledger'), async () => { const c = await loadCustomer(r.id); if (c) openLedger(c); }, 'sm') : null), x: () => '' },
  ];

  function drawDues() {
    const list = filteredDues();
    const sum = list.reduce((a, r) => a + Number(r.due), 0);
    const people = list.filter((r) => r.customer_type !== 'DEPARTMENT').length;
    put(dSummary,
      h('div', { class: 'ds-big' }, h('span', { class: 'muted small' }, t('total_due')), h('b', { class: 'num' }, fmtMoney(sum))),
      h('div', { class: 'ds-small muted small' }, t('dues_counts', { p: fmtNum(people), d: fmtNum(list.length - people) })));
    put(dList, dataTable(dueCols, list, { empty: t('no_dues') }));
    // totals per department (people in it + its own account)
    const map = new Map();
    for (const r of list) {
      const k = r.department_id || 0;
      const e = map.get(k) || { name: deptLabel(r), due: 0, n: 0 };
      e.due += Number(r.due); e.n += 1; map.set(k, e);
    }
    const rows = [...map.values()].sort((a, b) => b.due - a.due);
    put(byDept, rows.length > 1 ? h('details', { class: 'by-dept' },
      h('summary', null, t('dues_by_dept')),
      dataTable([{ label: t('department'), key: 'name' }, { label: t('count'), num: true, render: (x) => fmtNum(x.n) },
                 { label: t('due'), num: true, render: (x) => fmtMoney(x.due) }], rows)) : null);
  }

  async function loadDues() {
    try {
      dueRows = await q(sb.from('v_receivables').select('*').order('balance').limit(1000));
      const depts = new Map(dueRows.filter((r) => r.department_id).map((r) => [String(r.department_id), deptLabel(r)]));
      const cur = deptSel.value;
      put(deptSel, [['', t('all_departments')], ...[...depts.entries()].sort((a, b) => a[1].localeCompare(b[1], 'ar'))]
        .map(([v, l]) => h('option', { value: v }, l)));
      deptSel.value = depts.has(cur) ? cur : '';
      drawDues();
    } catch (e) { toastError(e); }
  }

  dSearch.oninput = drawDues; deptSel.onchange = drawDues; sortSel.onchange = () => { sort = sortSel.value; drawDues(); };
  drawKinds();
  put(dues,
    h('div', { class: 'panel-head' }, h('h2', null, t('rec_tab_dues')),
      h('div', { class: 'row' },
        btn(t('export_excel'), () => exportExcel('dues', [
          { label: t('name'), key: 'full_name' }, { label: t('code'), key: 'code' }, { label: t('type'), x: (r) => t('ct.' + r.customer_type) },
          { label: t('department'), x: deptLabel }, { label: t('company'), x: (r) => r.company || '' },
          ...dueCols.slice(1, -1)], filteredDues()), 'sm'),
        btn(t('print'), () => printSheet({ title: t('rec_tab_dues'), meta: [[t('total_due'), fmtMoney(filteredDues().reduce((a, r) => a + Number(r.due), 0))]],
          body: dataTable(dueCols.slice(0, -1), filteredDues(), { noCards: true }) }), 'sm'))),
    dSummary,
    h('div', { class: 'toolbar dues-tools' }, h('div', { class: 'grow' }, dSearch), deptSel, sortSel),
    kindBar, dList, byDept);
  loadDues();

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
