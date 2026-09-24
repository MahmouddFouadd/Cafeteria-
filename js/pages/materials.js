import { h, put, clear, btn, input, select, checkbox, dataTable, badge, modal, toast, toastError, busy, fmtNum, fmtMoney } from '../ui.js';
import { t } from '../i18n.js';
import { sb } from '../supabase.js';
import { q } from '../api.js';
import { can } from '../session.js';
import { crudPage, activeBadge } from '../components.js';
import { refs, nm, unit, unitLabel, loadRefs } from '../store.js';

export async function materialsPage(root) {
  const edit = can('inventory.materials');
  const showCost = can('reports.cost') || edit;
  const cat = (id) => refs.matCats.find((c) => c.id === id);

  await crudPage(root, {
    table: 'materials', order: 'name_ar', canEdit: edit, newLabel: t('new_material'), exportName: 'materials',
    search: (r) => `${r.code} ${r.name_ar} ${r.name_en || ''}`,
    afterSave: () => loadRefs(true),
    fields: [
      { key: 'code', label: t('code'), required: true, createOnly: true },
      { key: 'name_ar', label: t('name_ar'), required: true },
      { key: 'name_en', label: t('name_en') },
      { key: 'category_id', label: t('category'), type: 'select', options: () => refs.matCats.filter((c) => c.active).map((c) => [c.id, nm(c)]) },
      { key: 'base_unit_id', label: t('base_unit'), type: 'select', required: true, createOnly: true,
        options: () => refs.units.filter((u) => u.dimension !== 'PACK').map((u) => [u.id, `${unitLabel(u.id)} (${u.code})`]) },
      { key: 'consumption_mode', label: t('consumption_mode'), type: 'select', numeric: false, required: true, default: 'RECIPE',
        options: () => [['RECIPE', t('mode.RECIPE')], ['ISSUE', t('mode.ISSUE')]] },
      { key: 'min_stock', label: t('min_stock_base'), type: 'number', default: 0 },
      { key: 'track_stock', label: t('track_stock'), type: 'bool', default: true },
      { key: 'active', label: t('active'), type: 'bool', default: true },
    ],
    columns: [
      { label: t('code'), key: 'code' },
      { label: t('material'), render: (r) => nm(r) },
      { label: t('category'), render: (r) => nm(cat(r.category_id)) },
      { label: t('base_unit'), render: (r) => unitLabel(r.base_unit_id) },
      { label: t('conversions'), x: (r) => refs.materialUnits.filter((x) => x.material_id === r.id)
          .map((x) => `${unitLabel(x.unit_id)} = ${x.factor_to_base}`).join(', '),
        render: (r) => { const list = refs.materialUnits.filter((x) => x.material_id === r.id);
          return list.length ? h('div', { class: 'small' }, list.map((x) => h('div', { style: { whiteSpace: 'nowrap' } },
            `${unitLabel(x.unit_id)} = ${fmtNum(x.factor_to_base)} ${unitLabel(r.base_unit_id)}${x.is_purchase_unit ? ' ★' : ''}`)))
            : h('span', { class: 'muted' }, '—'); } },
      { label: t('consumption_mode'), render: (r) => badge(t('mode.' + r.consumption_mode), r.consumption_mode === 'ISSUE' ? 'warn' : 'info') },
      { label: t('min_stock'), num: true, render: (r) => fmtNum(r.min_stock) },
      ...(showCost ? [{ label: t('avg_cost'), num: true, render: (r) => (r.track_stock ? fmtMoney(r.avg_cost) : '—') }] : []),
      { label: t('status'), render: (r) => (r.track_stock ? activeBadge(r) : badge(t('not_tracked'))) },
    ],
    rowActions: (r, reload) => (edit ? btn(t('units_btn'), () => unitsModal(r, reload), 'sm') : null),
  });
}

function unitsModal(mat, reloadList) {
  const box = h('div');
  const base = unit(mat.base_unit_id);

  async function refresh() {
    await loadRefs(true);
    const rows = refs.materialUnits.filter((x) => x.material_id === mat.id);
    const used = new Set([mat.base_unit_id, ...rows.map((r) => r.unit_id)]);
    const free = refs.units.filter((u) => !used.has(u.id) && (u.dimension === base.dimension || u.dimension === 'PACK'));

    const tbl = dataTable([
      { label: t('unit'), render: (r) => unitLabel(r.unit_id) },
      { label: t('contains'), render: (r) => {
          const inp = input({ type: 'number', step: 'any', min: '0', value: r.factor_to_base, style: { maxWidth: '140px' } });
          const save = btn(t('save'), () => busy(save, () => upd(r.unit_id, { factor_to_base: Number(inp.value) })), 'sm');
          return h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center' } }, inp, unitLabel(base.id), save);
        } },
      { label: t('purchase_unit'), render: (r) => r.is_purchase_unit ? badge('★ ' + t('purchase_unit'), 'ok')
          : btn(t('set_purchase_unit'), () => setPurchase(r.unit_id), 'sm ghost') },
      { label: '', render: (r) => btn(t('delete'), () => del(r.unit_id), 'sm danger') },
    ], rows, { empty: t('no_conversions') });

    const unitSel = select(free.map((u) => [u.id, `${unitLabel(u.id)} (${u.code})`]));
    const factor = input({ type: 'number', step: 'any', min: '0', placeholder: t('how_many', { unit: unitLabel(base.id) }) });
    const purchase = checkbox(t('purchase_unit'), rows.length === 0);
    const addBtn = btn('+ ' + t('add'), () => busy(addBtn, add), 'primary');

    async function add() {
      const f = Number(factor.value);
      if (!unitSel.value || !(f > 0)) { toast(t('err.QTY_INVALID'), 'warn'); return; }
      try {
        if (purchase.input.checked) await q(sb.from('material_units').update({ is_purchase_unit: false }).eq('material_id', mat.id));
        await q(sb.from('material_units').insert({ material_id: mat.id, unit_id: Number(unitSel.value), factor_to_base: f, is_purchase_unit: purchase.input.checked }));
        toast(t('saved'), 'ok'); refresh();
      } catch (e) { toastError(e); }
    }
    put(box, 
      h('p', { class: 'muted', style: { marginTop: 0 } }, t('conversion_hint', { base: unitLabel(base.id) })),
      tbl,
      free.length ? h('div', { class: 'toolbar', style: { marginTop: '16px' } },
        h('div', { class: 'field' }, h('span', { class: 'field-label' }, t('unit')), unitSel),
        h('div', { class: 'field grow' }, h('span', { class: 'field-label' }, t('contains')), factor),
        purchase, addBtn) : null);
  }
  async function upd(unitId, values) {
    try { await q(sb.from('material_units').update(values).eq('material_id', mat.id).eq('unit_id', unitId)); toast(t('saved'), 'ok'); refresh(); }
    catch (e) { toastError(e); }
  }
  async function setPurchase(unitId) {
    try {
      await q(sb.from('material_units').update({ is_purchase_unit: false }).eq('material_id', mat.id));
      await upd(unitId, { is_purchase_unit: true });
    } catch (e) { toastError(e); }
  }
  async function del(unitId) {
    try { await q(sb.from('material_units').delete().eq('material_id', mat.id).eq('unit_id', unitId)); toast(t('deleted'), 'ok'); refresh(); }
    catch (e) { toastError(e); }
  }

  modal({ title: `${t('units_btn')}: ${nm(mat)}`, wide: true, body: box, onClose: reloadList });
  refresh();
}
