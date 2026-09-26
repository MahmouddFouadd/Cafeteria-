import { h, put, btn, dataTable, badge, toast, toastError, busy, fmtDateTime, confirmDialog } from '../ui.js';
import { t } from '../i18n.js';
import { sb } from '../supabase.js';
import { q, rpc } from '../api.js';

/** Employees' phones (self-ordering app): who registered from which phone, and anything suspicious. */
export async function devicesPage(root) {
  let tab = 'EVENTS';
  const seg = h('div', { class: 'seg rec-tabs' });
  const box = h('div');
  const EV_BAD = ['SWITCH', 'REJECTED', 'BLOCKED_ATTEMPT'];

  const drawTabs = () => put(seg, [['EVENTS', t('dev_tab_events')], ['DEVICES', t('dev_tab_devices')]].map(([k, l]) =>
    h('button', { type: 'button', class: tab === k ? 'on' : '', onclick: () => { tab = k; drawTabs(); load(); } }, l)));

  async function load() {
    try {
      if (tab === 'DEVICES') {
        const rows = await q(sb.from('v_self_devices').select('*').order('last_seen', { ascending: false }).limit(500));
        put(box, h('p', { class: 'muted small' }, t('dev_devices_hint')), dataTable([
          { label: t('name'), render: (r) => h('div', null, h('b', null, r.full_name), h('div', { class: 'muted small' }, `${r.code}${r.department_ar ? ' · ' + r.department_ar : ''}`)) },
          { label: t('dev_ip'), render: (r) => h('span', { dir: 'ltr' }, r.last_ip || '—') },
          { label: t('dev_phone'), render: (r) => h('span', { class: 'small', dir: 'ltr' }, (r.user_agent || '').slice(0, 60)) },
          { label: t('dev_first'), render: (r) => fmtDateTime(r.first_seen) },
          { label: t('dev_last'), render: (r) => fmtDateTime(r.last_seen) },
          { label: t('dev_orders'), key: 'orders_count', num: true },
          { label: t('dev_flags'), render: (r) => (Number(r.flags) ? badge(String(r.flags), 'bad') : '—') },
          { label: '', render: (r) => {
            const b = btn(r.blocked ? t('dev_unblock') : t('dev_block'), () => busy(b, async () => {
              if (!r.blocked) { const ok = await confirmDialog(t('dev_block_confirm', { n: r.full_name }), { danger: true }); if (!ok.ok) return; }
              try { await rpc('set_device_blocked', { p_device: r.device_uid, p_blocked: !r.blocked }); toast(t('saved'), 'ok'); load(); } catch (e) { toastError(e); }
            }), r.blocked ? 'sm' : 'sm danger');
            return h('div', { class: 'row-actions' }, r.blocked ? badge(t('dev_blocked'), 'bad') : null, b);
          } },
        ], rows, { empty: t('dev_none') }));
      } else {
        const rows = await q(sb.from('v_self_device_events').select('*').order('id', { ascending: false }).limit(300));
        const unreviewed = rows.filter((r) => !r.reviewed && EV_BAD.includes(r.event)).length;
        put(box,
          h('div', { class: 'toolbar' },
            h('div', { class: 'grow' }, unreviewed ? h('div', { class: 'alert warn small' }, t('dev_unreviewed', { n: unreviewed })) : h('span', { class: 'muted small' }, t('dev_all_reviewed'))),
            unreviewed ? btn(t('dev_mark_reviewed'), async () => { try { await rpc('mark_device_events_reviewed'); load(); } catch (e) { toastError(e); } }, 'sm') : null),
          dataTable([
            { label: t('time'), render: (r) => fmtDateTime(r.created_at) },
            { label: t('dev_event'), render: (r) => badge(t('dev_ev.' + r.event), EV_BAD.includes(r.event) ? 'bad' : (r.event === 'NEW_DEVICE' ? 'warn' : 'ok')) },
            { label: t('dev_typed'), render: (r) => h('div', null, h('b', null, r.typed_name || ''), h('span', { class: 'muted small' }, ` (${r.typed_code || ''})`)) },
            { label: t('dev_account'), render: (r) => r.customer_name ? `${r.customer_name} (${r.customer_code})` : '—' },
            { label: t('dev_ip'), render: (r) => h('span', { dir: 'ltr' }, r.ip || '—') },
            { label: t('dev_phone'), render: (r) => h('span', { class: 'small', dir: 'ltr' }, (r.user_agent || '').slice(0, 50)) },
          ], rows, { empty: t('dev_none'), rowClass: (r) => (!r.reviewed && EV_BAD.includes(r.event) ? 'row-flag' : '') }));
      }
    } catch (e) { put(box, h('div', { class: 'alert bad' }, e.message)); }
  }
  drawTabs();
  root.append(h('div', { class: 'alert info small' }, t('dev_intro')), seg, box);
  load();
}
