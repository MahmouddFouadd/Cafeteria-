import { h, put, btn, toastError, busy, fmtDateTime, fmtMoney } from '../ui.js';
import { t } from '../i18n.js';
import { sb } from '../supabase.js';
import { q, rpc } from '../api.js';
import { todayISO } from '../ui.js';
import { lineName, addonsText, customerLabel, openOrder } from '../sales.js';
import { usePrep } from '../store.js';

const COLS = ['NEW', 'PREPARING', 'READY'];   // all still-open orders
const NEXT = { NEW: 'PREPARING', PREPARING: 'READY', READY: 'SERVED' };

let beepCtx = null;
function beep() {
  try {
    beepCtx = beepCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = beepCtx.createOscillator(); const g = beepCtx.createGain();
    o.frequency.value = 880; g.gain.value = 0.08; o.connect(g); g.connect(beepCtx.destination);
    o.start(); o.stop(beepCtx.currentTime + 0.18);
  } catch { /* sound is optional */ }
}

export async function queuePage(root) {
  const board = h('div', { class: 'queue' });
  // served app orders whose cash was never recorded (safety net for older versions)
  const missing = h('div');
  async function loadMissing() {
    try {
      const rows = await q(sb.from('v_orders').select('*').eq('source', 'SELF').eq('pay_request', 'CASH')
        .eq('fulfillment_status', 'SERVED').is('cash_collected_at', null).order('id').limit(50));
      put(missing, rows.length ? h('section', { class: 'panel' },
        h('div', { class: 'panel-head' }, h('h2', null, t('self_cash_missing_title'))),
        h('p', { class: 'muted small' }, t('self_cash_missing_hint')),
        rows.map((o) => {
          const b = btn(t('self_cash_collect', { v: fmtMoney(o.total) }), () => busy(b, async () => {
            try { await rpc('self_cash_served', { p_order_id: o.id }); await loadMissing(); } catch (e) { toastError(e); }
          }), 'primary');
          return h('div', { class: 'row', style: { justifyContent: 'space-between', gap: '8px', padding: '8px 0', borderBottom: '1px solid var(--line)' } },
            h('div', null, h('b', null, o.order_no), ' ', customerLabel(o)), b);
        })) : null);
    } catch (_) { /* optional */ }
  }

  const stamp = h('span', { class: 'muted small' });
  root.append(h('div', { class: 'toolbar' }, h('div', { class: 'grow' }, stamp), btn(t('refresh'), () => load())), board, missing);

  let known = null;
  async function load() {
    try {
      const orders = await q(sb.from('v_orders').select('*').eq('business_date', todayISO())
        .in('fulfillment_status', COLS).order('id').limit(200));
      const ids = orders.map((o) => o.id);
      const lines = ids.length ? await q(sb.from('v_order_lines').select('*').in('order_id', ids).order('id')) : [];
      const fresh = orders.filter((o) => o.fulfillment_status === 'NEW').map((o) => o.id);
      if (known && fresh.some((id) => !known.has(id))) beep();
      known = new Set(fresh);
      render(orders, lines);
      loadMissing();
      stamp.textContent = `${t('updated_at')}: ${fmtDateTime(new Date())}`;
    } catch (e) { toastError(e); }
  }

  function render(orders, lines) {
    if (!usePrep()) {
      // Simple flow: one list, one big "served" button per order
      board.classList.add('simple');
      put(board, h('section', { class: 'q-col q-open' },
        h('h2', null, t('to_serve'), h('span', { class: 'q-count' }, orders.length)),
        orders.length ? orders.map((o) => card(o, lines.filter((l) => l.order_id === o.id))) : h('div', { class: 'muted small q-empty' }, t('no_orders'))));
      return;
    }
    put(board, COLS.map((col) => {
      const list = orders.filter((o) => o.fulfillment_status === col);
      return h('section', { class: 'q-col q-' + col.toLowerCase() },
        h('h2', null, t('fs.' + col), h('span', { class: 'q-count' }, list.length)),
        list.length ? list.map((o) => card(o, lines.filter((l) => l.order_id === o.id))) : h('div', { class: 'muted small q-empty' }, t('no_orders')));
    }));
  }

  function card(o, ls) {
    const self = o.source === 'SELF';
    let next = usePrep() ? NEXT[o.fulfillment_status] : 'SERVED';
    // app orders always pass through "preparing" so the employee is told when theirs starts
    if (self && !usePrep() && o.fulfillment_status === 'NEW') next = 'PREPARING';
    const cashOnDelivery = self && o.pay_request === 'CASH' && !o.cash_collected_at && next === 'SERVED';
    const label = cashOnDelivery ? t('self_cash_serve', { v: fmtMoney(o.total) })
      : (usePrep() || next === 'PREPARING') ? t('to.' + next) : '✓ ' + t('mark_served');
    const b = btn(label, () => busy(b, async () => {
      try {
        if (cashOnDelivery) await rpc('self_cash_served', { p_order_id: o.id });
        else await rpc('set_order_status', { p_order_id: o.id, p_status: next });
        await load();
      } catch (e) { toastError(e); }
    }), next === 'SERVED' && usePrep() && !cashOnDelivery ? '' : 'primary lg');
    return h('article', { class: 'q-card' },
      h('header', null, h('b', { class: 'q-no', onclick: () => openOrder(o.id, { onChange: load }) }, o.order_no),
        h('span', { class: 'muted small' }, new Date(o.created_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Cairo' }))),
      h('div', { class: 'q-who' }, customerLabel(o)),
      self ? h('div', { class: 'q-self' }, h('span', { class: 'badge self' }, t('self_badge')),
        h('span', { class: 'badge ' + (o.pay_request === 'CASH' ? 'warn' : '') }, o.pay_request === 'CASH' ? t('self_pays_cash') : t('self_on_account'))) : null,
      h('ul', null, ls.map((l) => h('li', null, h('b', null, `${l.qty} × `), lineName(l),
        l.addons?.length ? h('div', { class: 'q-add' }, '+ ' + addonsText(l)) : null,
        l.notes ? h('div', { class: 'q-add' }, l.notes) : null))),
      o.notes ? h('div', { class: 'q-add' }, o.notes) : null,
      b);
  }

  await load();
  const timer = setInterval(() => { if (!root.isConnected) { clearInterval(timer); return; } if (!document.hidden) load(); }, 8000);
}
