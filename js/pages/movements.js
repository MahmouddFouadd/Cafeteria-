import { h, put, clear, btn, input, select, field, dataTable, badge, fmtNum, fmtMoney, fmtDateTime, exportExcel,
         daysAgoISO, todayISO, toastError, busy } from '../ui.js';
import { t } from '../i18n.js';
import { sb } from '../supabase.js';
import { q } from '../api.js';
import { refs, nm, location, unitLabel, material } from '../store.js';

const TYPES = ['PURCHASE', 'CONSUMPTION', 'WASTE', 'ADJUSTMENT', 'RETURN', 'TRANSFER', 'OPENING_BALANCE'];

export async function movementsPage(root) {
  const from = input({ type: 'date', value: daysAgoISO(7) });
  const to = input({ type: 'date', value: todayISO() });
  const locSel = select([['', t('all_locations')], ...refs.locations.map((l) => [l.id, nm(l)])], '');
  const typeSel = select([['', t('all_types')], ...TYPES.map((x) => [x, t('mv.' + x)])], '');
  const matSel = select([['', t('all_materials')], ...refs.materials.map((m) => [m.id, nm(m)])], '');
  const box = h('div');
  let rows = [];

  const cols = [
    { label: t('date'), render: (r) => fmtDateTime(r.created_at) },
    { label: t('material'), render: (r) => nm({ name_ar: r.material_name_ar, name_en: r.material_name_en }) },
    { label: t('location'), render: (r) => nm(location(r.location_id)) },
    { label: t('movement'), x: (r) => t('mv.' + r.movement_type), render: (r) => badge(t('mv.' + r.movement_type), r.qty_base < 0 ? 'bad' : 'ok') },
    { label: t('qty'), num: true, x: (r) => Number(r.qty_base), render: (r) => h('div', null, `${fmtNum(r.qty_base)} ${unitLabel(material(r.material_id)?.base_unit_id) || r.base_unit}`,
        r.entered_unit_id && r.qty_entered != null ? h('div', { class: 'muted small' }, `${fmtNum(r.qty_entered)} ${unitLabel(r.entered_unit_id)}`) : null) },
    { label: t('value'), num: true, x: (r) => Number(r.value), render: (r) => fmtMoney(r.value) },
    { label: t('reference'), render: (r) => `${t('ref.' + r.reference_type)} #${r.reference_id ?? ''}` },
    { label: t('user'), key: 'created_by_name' },
    { label: t('notes'), render: (r) => r.notes || '' },
  ];

  const loadBtn = btn(t('show'), () => busy(loadBtn, load), 'primary');
  root.append(
    h('div', { class: 'toolbar' },
      field(t('date_from'), from), field(t('date_to'), to),
      field(t('location'), locSel), field(t('movement'), typeSel), field(t('material'), matSel),
      loadBtn, btn(t('export_excel'), () => exportExcel('movements', cols, rows))),
    box);

  async function load() {
    try {
      let qb = sb.from('v_inventory_movements').select('*')
        .gte('business_date', from.value).lte('business_date', to.value)
        .order('id', { ascending: false }).limit(1000);
      if (locSel.value) qb = qb.eq('location_id', Number(locSel.value));
      if (typeSel.value) qb = qb.eq('movement_type', typeSel.value);
      if (matSel.value) qb = qb.eq('material_id', Number(matSel.value));
      rows = await q(qb);
      put(box, 
        rows.length === 1000 ? h('div', { class: 'alert info' }, t('limit_note')) : null,
        dataTable(cols, rows));
    } catch (e) { toastError(e); }
  }
  await load();
}
