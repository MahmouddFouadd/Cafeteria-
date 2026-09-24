import { h, put, clear, btn, input, select, field, dataTable, badge, modal, toast, toastError, busy, confirmDialog,
         fmtNum, fmtDateTime, printSheet } from '../ui.js';
import { t } from '../i18n.js';
import { sb } from '../supabase.js';
import { q, rpc } from '../api.js';
import { refs, nm, location, material, unitLabel, loadRefs } from '../store.js';

export async function countsPage(root) {
  const locSel = select(refs.locations.filter((l) => l.active).map((l) => [l.id, nm(l)]));
  const box = h('div');
  const newBtn = btn('+ ' + t('new_count'), () => busy(newBtn, async () => {
    try {
      const res = await rpc('create_stock_count', { p_location_id: Number(locSel.value) });
      toast(t('count_created', { no: res.doc_no }), 'ok');
      await load();
      openCount(res.id);
    } catch (e) { toastError(e); }
  }), 'primary');

  root.append(
    h('div', { class: 'alert info' }, t('count_hint')),
    h('div', { class: 'toolbar' }, field(t('location'), locSel), newBtn),
    box);

  async function load() {
    const rows = await q(sb.from('stock_counts').select('*').order('id', { ascending: false }).limit(100));
    put(box, dataTable([
      { label: t('doc_no'), key: 'doc_no' },
      { label: t('location'), render: (r) => nm(location(r.location_id)) },
      { label: t('date'), render: (r) => fmtDateTime(r.created_at) },
      { label: t('status'), render: (r) => badge(t('cs.' + r.status), r.status === 'DRAFT' ? 'warn' : r.status === 'POSTED' ? 'ok' : '') },
    ], rows, { onRowClick: (r) => openCount(r.id), empty: t('no_counts') }));
  }

  async function openCount(id) {
    let c, items;
    try {
      [c] = await q(sb.from('stock_counts').select('*').eq('id', id));
      items = await q(sb.from('stock_count_items').select('*').eq('count_id', id).order('id'));
    } catch (e) { toastError(e); return; }
    const draft = c.status === 'DRAFT';
    items.sort((a, b) => nm(material(a.material_id)).localeCompare(nm(material(b.material_id))));
    const inputs = new Map();

    const diffCell = (i, v) => {
      const d = (Number(v) || 0) - Number(i.system_qty);
      return h('span', { style: { color: d < 0 ? 'var(--bad)' : d > 0 ? 'var(--ok)' : '' } }, d ? fmtNum(d) : '0');
    };
    const tbody = h('tbody', null, items.map((i) => {
      const m = material(i.material_id);
      const diffTd = h('td', { class: 'num' }, diffCell(i, i.counted_qty));
      const inp = input({ type: 'number', step: 'any', min: '0', value: i.counted_qty, disabled: !draft,
        oninput: () => put(diffTd, diffCell(i, inp.value)) });
      inputs.set(i.material_id, inp);
      return h('tr', null,
        h('td', null, nm(m), h('div', { class: 'muted small' }, m?.code)),
        h('td', { class: 'num' }, `${fmtNum(i.system_qty)} ${unitLabel(m?.base_unit_id)}`),
        h('td', { style: { width: '160px' } }, inp),
        diffTd);
    }));
    const table = h('div', { class: 'table-wrap' }, h('table', { class: 'tbl tbl-edit' },
      h('thead', null, h('tr', null, h('th', null, t('material')), h('th', { class: 'num' }, t('system_qty')),
        h('th', null, t('counted_qty')), h('th', { class: 'num' }, t('difference')))), tbody));

    const collect = () => items.map((i) => ({ material_id: i.material_id, counted_qty: Number(inputs.get(i.material_id).value || 0) }));
    const saveBtn = btn(t('save_draft'), () => busy(saveBtn, async () => {
      try { await rpc('save_stock_count', { p_count_id: id, p_items: collect() }); toast(t('saved'), 'ok'); }
      catch (e) { toastError(e); }
    }));
    const postBtn = btn(t('post_count'), () => busy(postBtn, async () => {
      const ok = await confirmDialog(t('post_count_confirm'), { danger: true, okLabel: t('post_count') });
      if (!ok.ok) return;
      try {
        await rpc('save_stock_count', { p_count_id: id, p_items: collect() });
        const res = await rpc('post_stock_count', { p_count_id: id });
        toast(t('count_posted', { n: res.adjusted_lines }), 'ok');
        m.close(); await loadRefs(true); load();
      } catch (e) { toastError(e); }
    }), 'primary');

    const blankSheet = () => h('div', { class: 'table-wrap' }, h('table', { class: 'tbl' },
      h('thead', null, h('tr', null, h('th', null, t('code')), h('th', null, t('material')),
        h('th', null, t('unit')), h('th', null, t('counted_qty')))),
      h('tbody', null, items.map((i) => { const m = material(i.material_id);
        return h('tr', null, h('td', null, m?.code), h('td', null, nm(m)), h('td', null, unitLabel(m?.base_unit_id)), h('td', null, '')); }))));

    const m = modal({
      title: `${t('nav.counts')} ${c.doc_no} — ${nm(location(c.location_id))}`, wide: true,
      body: h('div', null, draft ? h('div', { class: 'alert info' }, t('count_base_unit_note')) : null, table),
      actions: [
        btn(t('print_count_sheet'), () => printSheet({ title: `${t('nav.counts')} ${c.doc_no}`,
          meta: [[t('location'), nm(location(c.location_id))]], body: blankSheet(),
          signatures: [t('sig.counted'), t('sig.reviewed'), t('sig.approved')] })),
        draft ? saveBtn : null, draft ? postBtn : null, btn(t('close'), () => m.close()),
      ].filter(Boolean),
    });
  }

  await load();
}
