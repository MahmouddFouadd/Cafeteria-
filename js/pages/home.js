import { h, put, btn, badge, fmtNum, fmtMoney, toastError } from '../ui.js';
import { t, lang } from '../i18n.js';
import { rpc } from '../api.js';
import { can, session } from '../session.js';
import { material, unitLabel } from '../store.js';

const LINKS = [
  ['pos', 'pos.create_order'], ['queue', 'orders.queue'], ['reception', 'accounts.deposit'],
  ['orders', 'orders.view'], ['customers', 'customers.manage'], ['closing', 'closing.perform'],
  ['docs/purchase', 'inventory.purchase'], ['docs/transfer', 'inventory.transfer'],
  ['docs/issue', 'inventory.issue'], ['docs/waste', 'inventory.waste'],
  ['stock', 'inventory.view'], ['counts', 'inventory.adjust'],
  ['catalog', 'catalog.manage'], ['materials', 'inventory.materials'],
];

const L = (ar, en) => (lang() === 'en' && en ? en : ar);
const itemName = (r) => {
  const p = L(r.product_ar, r.product_en), v = L(r.variant_ar, r.variant_en);
  return r.variant_en === 'Regular' ? p : `${p} — ${v}`;
};
const dayLabel = (iso) => { const [, m, d] = iso.split('-').map(Number); return `${d}/${m}`; };
const dayTitle = (iso) => new Date(iso + 'T12:00:00').toLocaleDateString(lang() === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB',
  { weekday: 'long', day: 'numeric', month: 'long' });
const hourLabel = (hh) => (lang() === 'ar'
  ? `${((hh + 11) % 12) + 1}${hh < 12 ? 'ص' : 'م'}`
  : `${((hh + 11) % 12) + 1}${hh < 12 ? 'am' : 'pm'}`);

function tile({ label, value, sub, tone = '', href }) {
  const body = [h('div', { class: 'kpi-label' }, label), h('div', { class: 'kpi-value num' }, value), sub ? h('div', { class: 'kpi-sub' }, sub) : null];
  return href ? h('a', { class: 'kpi ' + tone, href }, body) : h('div', { class: 'kpi ' + tone }, body);
}

/** Vertical bar chart from [{label, value, title}] */
function bars(data, { money = false, highlightLast = false } = {}) {
  const max = Math.max(1, ...data.map((d) => Number(d.value) || 0));
  return h('div', { class: 'bars', role: 'img' },
    data.map((d, i) => {
      const v = Number(d.value) || 0;
      return h('div', { class: 'bar-col' + (highlightLast && i === data.length - 1 ? ' now' : ''), title: d.title || '' },
        h('div', { class: 'bar-val num' }, v ? (money ? fmtNum(v, 0) : fmtNum(v)) : ''),
        h('div', { class: 'bar-track' }, h('div', { class: 'bar' + (v ? '' : ' zero'), style: { height: `${Math.max(v ? 4 : 0, (v / max) * 100)}%` } })),
        h('div', { class: 'bar-label' }, d.label));
    }));
}

/** Horizontal ranked list */
function ranked(rows, { name, value, sub }) {
  const max = Math.max(1, ...rows.map((r) => Number(value(r)) || 0));
  return h('ol', { class: 'ranked' }, rows.map((r) => h('li', null,
    h('div', { class: 'rk-top' }, h('span', { class: 'rk-name' }, name(r)), h('span', { class: 'rk-val num' }, sub(r))),
    h('div', { class: 'rk-track' }, h('div', { class: 'rk-bar', style: { width: `${(Number(value(r)) / max) * 100}%` } })))));
}

export async function homePage(root) {
  const body = h('div', { class: 'dash' });
  const updated = h('span', { class: 'muted small' });
  const refreshBtn = btn(t('refresh'), () => load(true), 'sm');
  const statusSlot = h('span');

  const links = LINKS.filter(([, p]) => can(p));
  root.append(
    h('div', { class: 'dash-head' },
      h('div', { class: 'grow' },
        h('h2', null, t('home_hello', { name: session.profile.full_name })),
        h('div', { class: 'muted small' },
          new Date().toLocaleDateString(lang() === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }),
          ' ', statusSlot)),
      h('div', { class: 'dash-tools' }, updated, refreshBtn)),
    links.length ? h('nav', { class: 'dash-links', 'aria-label': t('quick_actions') },
      links.map(([k]) => h('a', { href: '#/' + k, class: 'chip' }, t('nav.' + k.replace('docs/', ''))))) : null,
    body);

  let topMode = 'today', data = null;

  async function load(manual = false) {
    try {
      refreshBtn.disabled = true;
      data = await rpc('dashboard_summary', {});
      render();
      updated.textContent = t('dash_updated', { time: new Date().toLocaleTimeString(lang() === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB', { hour: 'numeric', minute: '2-digit' }) });
    } catch (e) { if (manual || !data) toastError(e); }
    finally { refreshBtn.disabled = false; }
  }

  function render() {
    const { sales, queue, last7, hourly, cash, accounts, inventory, margin } = data;
    put(statusSlot, cash ? badge(t('cls.' + cash.day_status), { OPEN: 'ok', CLOSED: '', REOPENED: 'warn', NOT_OPENED: 'warn' }[cash.day_status] || '') : null);

    // ---- KPI tiles ----
    const tiles = [];
    if (sales) {
      const avg = sales.orders_count ? sales.orders_total / sales.orders_count : 0;
      tiles.push(tile({ label: t('dash_sales_today'), value: fmtMoney(sales.orders_total), tone: 'primary', href: can('orders.view') ? '#/orders' : null,
        sub: t('dash_orders_avg', { n: fmtNum(sales.orders_count), avg: fmtMoney(avg) }) }));
      tiles.push(tile({ label: t('dash_paid'), value: fmtMoney(sales.paid_total),
        sub: Number(sales.unpaid_total) > 0 ? t('dash_unpaid', { v: fmtMoney(sales.unpaid_total) }) : t('dash_all_paid'),
        tone: Number(sales.unpaid_total) > 0 ? 'warn' : '' }));
    }
    if (cash) tiles.push(tile({ label: t('dash_expected_cash'), value: fmtMoney(cash.expected), href: can('closing.perform') ? '#/closing' : null,
      sub: t('dash_cash_breakdown', { s: fmtMoney(cash.cash_sales), d: fmtMoney(cash.deposits) }) }));
    if (accounts) tiles.push(tile({ label: t('dash_receivables'), value: fmtMoney(accounts.receivables), tone: Number(accounts.receivables) > 0 ? 'bad' : '',
      href: can('customers.manage') || can('accounts.view') ? '#/customers' : null,
      sub: t('dash_debtors', { n: fmtNum(accounts.debtors_count), p: fmtMoney(accounts.prepaid) }) }));
    if (margin) tiles.push(tile({ label: t('dash_margin'), value: fmtMoney(margin.gross_margin), tone: 'ok',
      sub: t('dash_material_cost', { v: fmtMoney(margin.material_cost) }) }));
    if (inventory) {
      const n = Number(inventory.low_count) + Number(inventory.out_count);
      tiles.push(tile({ label: t('dash_stock_alerts'), value: fmtNum(n), tone: n ? 'bad' : 'ok', href: '#/stock',
        sub: t('dash_waste_today', { v: fmtMoney(inventory.waste_value_today) }) }));
    }

    const blocks = [];
    if (tiles.length) blocks.push(h('div', { class: 'kpis' }, tiles));

    // ---- Queue strip ----
    if (queue) {
      const href = can('orders.queue') ? '#/queue' : (can('orders.view') ? '#/orders' : null);
      blocks.push(h('div', { class: 'queue-strip' },
        ['NEW', 'PREPARING', 'READY'].map((s) => {
          const inner = [h('span', { class: 'qs-n num' }, fmtNum(queue[s])), h('span', null, t('fs.' + s))];
          return href ? h('a', { class: 'qs qs-' + s.toLowerCase(), href }, inner) : h('div', { class: 'qs qs-' + s.toLowerCase() }, inner);
        })));
    }

    // ---- Charts row ----
    const row1 = [];
    if (last7) row1.push(h('section', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h2', null, t('dash_last7'))),
      bars(last7.map((d) => ({ label: dayLabel(d.d), value: d.amount, title: `${dayTitle(d.d)}: ${fmtMoney(d.amount)} · ${t('dash_n_orders', { n: d.n })}` })), { money: true, highlightLast: true })));
    if (data.top_today) {
      const list = h('div');
      const seg = h('div', { class: 'seg sm' });
      const drawTop = () => {
        const rows = topMode === 'today' ? data.top_today : data.top_7d;
        put(seg, ['today', '7d'].map((m) => h('button', { type: 'button', class: topMode === m ? 'on' : '', onclick: () => { topMode = m; drawTop(); } }, t('dash_top_' + m))));
        put(list, rows.length
          ? ranked(rows, { name: itemName, value: (r) => r.qty, sub: (r) => `${fmtNum(r.qty)} · ${fmtMoney(r.amount)}` })
          : h('div', { class: 'empty' }, t('dash_no_sales')));
      };
      drawTop();
      row1.push(h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', null, t('dash_top_items')), seg), list));
    }
    if (row1.length) blocks.push(h('div', { class: 'dash-row' }, row1));

    // ---- Hourly + cash ----
    const row2 = [];
    if (hourly) {
      const hs = hourly.map((x) => x.h);
      const from = Math.min(8, ...hs), to = Math.max(17, ...hs);
      const byH = Object.fromEntries(hourly.map((x) => [x.h, x]));
      const series = [];
      for (let hh = from; hh <= to; hh++) series.push({ label: hourLabel(hh), value: byH[hh]?.n || 0, title: byH[hh] ? `${t('dash_n_orders', { n: byH[hh].n })} · ${fmtMoney(byH[hh].amount)}` : '' });
      row2.push(h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', null, t('dash_hourly'))), bars(series)));
    }
    if (cash) {
      const line = (k, v, cls = '') => h('div', { class: 'cash-line ' + cls }, h('span', null, k), h('b', { class: 'num' }, v));
      row2.push(h('section', { class: 'panel' },
        h('div', { class: 'panel-head' }, h('h2', null, t('dash_cash_today')),
          can('closing.perform') ? h('a', { class: 'btn sm', href: '#/closing' }, t('nav.closing')) : null),
        cash.unclosed_before ? h('div', { class: 'alert warn small' }, t('dash_unclosed', { d: cash.unclosed_before })) : null,
        h('div', { class: 'cash-lines' },
          line(t('dash_opening_cash'), fmtMoney(cash.opening_cash)),
          line('+ ' + t('dash_cash_sales'), fmtMoney(cash.cash_sales)),
          line('+ ' + t('dash_deposits'), fmtMoney(cash.deposits)),
          line('− ' + t('dash_refunds'), fmtMoney(cash.refunds)),
          line(t('dash_expected_cash'), fmtMoney(cash.expected), 'total'))));
    }
    if (row2.length) blocks.push(h('div', { class: 'dash-row' }, row2));

    // ---- Stock alerts + debtors ----
    const row3 = [];
    if (inventory) {
      row3.push(h('section', { class: 'panel' },
        h('div', { class: 'panel-head' }, h('h2', null, t('low_stock')), h('a', { href: '#/stock', class: 'btn sm' }, t('view_stock'))),
        inventory.alerts.length
          ? h('ul', { class: 'alert-list' }, inventory.alerts.map((a) => h('li', null,
              h('div', { class: 'grow' }, h('b', null, L(a.name_ar, a.name_en)), h('div', { class: 'muted small' }, L(a.location_ar, a.location_en))),
              h('span', { class: 'num' }, `${fmtNum(a.qty)} ${unitLabel(material(a.material_id)?.base_unit_id) || a.unit}`),
              badge(t('st.' + a.status), a.status === 'OUT' ? 'bad' : 'warn'))))
          : h('div', { class: 'empty' }, t('no_low_stock')),
        h('div', { class: 'muted small dash-note' },
          t('dash_stock_value', { v: fmtMoney(inventory.stock_value) }), ' · ',
          t('dash_consumption_today', { v: fmtMoney(inventory.consumption_value_today) }))));
    }
    if (accounts) {
      row3.push(h('section', { class: 'panel' },
        h('div', { class: 'panel-head' }, h('h2', null, t('dash_top_debtors')),
          can('accounts.deposit') ? h('a', { href: '#/reception', class: 'btn sm' }, t('nav.reception')) : null),
        accounts.top_debtors.length
          ? ranked(accounts.top_debtors, { name: (r) => `${r.name} (${r.code})`, value: (r) => r.due, sub: (r) => fmtMoney(r.due) })
          : h('div', { class: 'empty' }, t('dash_no_debtors')),
        h('div', { class: 'muted small dash-note' }, t('dash_active_customers', { n: fmtNum(accounts.active_customers) }))));
    }
    if (row3.length) blocks.push(h('div', { class: 'dash-row' }, row3));

    if (!blocks.length) blocks.push(h('div', { class: 'empty' }, t('dash_nothing')));
    put(body, blocks);
  }

  await load();
  const timer = setInterval(() => {
    if (!root.isConnected) { clearInterval(timer); return; }
    if (!document.hidden) load();
  }, 60000);
}
