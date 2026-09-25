import { h, put, btn, toastError, busy, fmtDateTime } from '../ui.js';
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
  const stamp = h('span', { class: 'muted small' });
  root.append(h('div', { class: 'toolbar' }, h('div', { class: 'grow' }, stamp), btn(t('refresh'), () => load())), board);

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
    const next = usePrep() ? NEXT[o.fulfillment_status] : 'SERVED';
    const b = btn(usePrep() ? t('to.' + next) : '✓ ' + t('mark_served'), () => busy(b, async () => {
      try { await rpc('set_order_status', { p_order_id: o.id, p_status: next }); await load(); } catch (e) { toastError(e); }
    }), next === 'SERVED' && usePrep() ? '' : 'primary lg');
    return h('article', { class: 'q-card' },
      h('header', null, h('b', { class: 'q-no', onclick: () => openOrder(o.id, { onChange: load }) }, o.order_no),
        h('span', { class: 'muted small' }, new Date(o.created_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Cairo' }))),
      h('div', { class: 'q-who' }, customerLabel(o)),
      h('ul', null, ls.map((l) => h('li', null, h('b', null, `${l.qty} × `), lineName(l),
        l.addons?.length ? h('div', { class: 'q-add' }, '+ ' + addonsText(l)) : null,
        l.notes ? h('div', { class: 'q-add' }, l.notes) : null))),
      o.notes ? h('div', { class: 'q-add' }, o.notes) : null,
      b);
  }

  await load();
  const timer = setInterval(() => { if (!root.isConnected) { clearInterval(timer); return; } if (!document.hidden) load(); }, 8000);
}
