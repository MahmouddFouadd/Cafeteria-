import { h, put, btn, input, field, dataTable, badge, toast, toastError, busy, confirmDialog,
         fmtMoney, fmtDate, fmtDateTime, todayISO, printSheet } from '../ui.js';
import { t } from '../i18n.js';
import { sb } from '../supabase.js';
import { q, rpc } from '../api.js';
import { can } from '../session.js';

export async function closingPage(root) {
  const dateIn = input({ type: 'date', value: todayISO(), max: todayISO() });
  const box = h('div');
  const hist = h('section', { class: 'panel' });
  root.append(h('div', { class: 'toolbar' }, field(t('business_date'), dateIn), btn(t('show'), () => load(), 'primary')), box, hist);
  dateIn.onchange = () => load();

  async function load() {
    let p;
    try { p = await rpc('closing_preview', { p_date: dateIn.value }); } catch (e) { toastError(e); return; }
    const isToday = p.business_date === todayISO();
    const rowsKv = [
      [t('opening_cash'), fmtMoney(p.opening_cash)],
      [t('cash_sales'), fmtMoney(p.cash_sales)],
      [t('deposits_cash'), fmtMoney(p.deposits_cash)],
      [t('refunds_cash'), '− ' + fmtMoney(p.refunds_cash)],
      [t('expected_cash'), h('b', null, fmtMoney(p.expected_cash))],
    ];
    const infoKv = [
      [t('orders'), `${p.orders_count} — ${fmtMoney(p.orders_total)}`],
      [t('account_sales'), fmtMoney(p.account_sales)],
      [t('cancelled_orders'), String(p.cancelled_count)],
    ];
    const kv = (list) => h('dl', { class: 'kv' }, list.map(([k, v]) => [h('dt', null, k), h('dd', null, v)]));

    const parts = [];
    if (p.unclosed_before) parts.push(h('div', { class: 'alert warn' }, t('unclosed_before', { d: fmtDate(p.unclosed_before) })));

    if (p.status === 'NOT_OPENED' && isToday) {
      const cash = input({ type: 'number', step: '0.01', min: '0', value: '0', inputmode: 'decimal' });
      const b = btn(t('open_day'), () => busy(b, async () => {
        try { await rpc('open_day', { p_opening_cash: Number(cash.value) || 0 }); toast(t('day_opened'), 'ok'); load(); } catch (e) { toastError(e); }
      }), 'primary');
      parts.push(h('section', { class: 'panel' }, h('h2', null, t('open_day')), h('p', { class: 'muted' }, t('open_day_hint')),
        h('div', { class: 'toolbar' }, field(t('opening_cash'), cash), b)));
    }

    const closed = p.status === 'CLOSED';
    const cashBox = h('section', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h2', null, `${t('nav.closing')} ${fmtDate(p.business_date)}`),
        badge(t('cls.' + p.status), closed ? 'ok' : p.status === 'NOT_OPENED' ? '' : 'warn')),
      h('div', { class: 'two-col' }, kv(rowsKv), kv(infoKv)));

    if (!closed) {
      const actual = input({ type: 'number', step: '0.01', min: '0', inputmode: 'decimal' });
      const notes = h('textarea', { class: 'input', rows: 2 });
      const diff = h('div', { class: 'diff' });
      actual.oninput = () => {
        if (actual.value === '') { diff.textContent = ''; return; }
        const d = Number(actual.value) - Number(p.expected_cash);
        diff.textContent = `${t('difference')}: ${fmtMoney(d)}`;
        diff.className = 'diff ' + (d === 0 ? 'ok' : d < 0 ? 'bad' : 'warn');
      };
      const b = btn(t('close_day'), () => busy(b, async () => {
        if (actual.value === '') { toast(t('enter_actual_cash'), 'warn'); actual.focus(); return; }
        const ok = await confirmDialog(t('close_day_confirm'), { okLabel: t('close_day') });
        if (!ok.ok) return;
        try { await rpc('close_day', { p_date: p.business_date, p_actual_cash: Number(actual.value), p_notes: notes.value.trim() || null }); toast(t('day_closed'), 'ok'); load(); }
        catch (e) { toastError(e); }
      }), 'primary');
      cashBox.append(h('div', { class: 'form-grid', style: { marginTop: '12px' } },
        field(t('actual_cash'), actual), h('div', { class: 'field' }, h('span', { class: 'field-label' }, '\u00a0'), diff),
        field(t('notes'), notes, 'span-all')), h('div', { class: 'form-actions' }, b));
    } else {
      cashBox.append(kv([[t('actual_cash'), fmtMoney(p.actual_cash)], [t('difference'), fmtMoney(p.difference)]]),
        h('div', { class: 'form-actions' },
          btn(t('print'), () => printSheet({ title: `${t('nav.closing')} ${fmtDate(p.business_date)}`,
            meta: [...rowsKv, ...infoKv, [t('actual_cash'), fmtMoney(p.actual_cash)], [t('difference'), fmtMoney(p.difference)]]
              .map(([k, v]) => [k, v instanceof Node ? v.textContent : v]),
            body: h('div'), signatures: [t('sig.cashier'), t('sig.approved')] })),
          can('closing.override') ? btn(t('reopen_day'), async () => {
            const c = await confirmDialog(t('reopen_confirm'), { reason: true, danger: true, okLabel: t('reopen_day') });
            if (!c.ok) return;
            try { await rpc('reopen_day', { p_date: p.business_date, p_reason: c.reason }); toast(t('saved'), 'ok'); load(); } catch (e) { toastError(e); }
          }, 'danger') : null));
    }
    parts.push(cashBox);
    put(box, parts);
    loadHistory();
  }

  async function loadHistory() {
    try {
      const rows = await q(sb.from('daily_closings').select('*').order('business_date', { ascending: false }).limit(31));
      put(hist, h('h2', null, t('closing_history')), dataTable([
        { label: t('business_date'), render: (r) => fmtDate(r.business_date) },
        { label: t('status'), render: (r) => badge(t('cls.' + r.status), r.status === 'CLOSED' ? 'ok' : 'warn') },
        { label: t('opening_cash'), num: true, render: (r) => fmtMoney(r.opening_cash) },
        { label: t('expected_cash'), num: true, render: (r) => (r.expected_cash != null ? fmtMoney(r.expected_cash) : '') },
        { label: t('actual_cash'), num: true, render: (r) => (r.actual_cash != null ? fmtMoney(r.actual_cash) : '') },
        { label: t('difference'), num: true, render: (r) => (r.difference != null ? fmtMoney(r.difference) : '') },
        { label: t('closed_at'), render: (r) => fmtDateTime(r.closed_at) },
      ], rows, { onRowClick: (r) => { dateIn.value = r.business_date; load(); } }));
    } catch (e) { toastError(e); }
  }

  await load();
}
