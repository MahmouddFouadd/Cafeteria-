import { h, put, clear, btn, input, select, field, dataTable, badge, fmtNum, fmtMoney, exportExcel, printSheet, toastError } from '../ui.js';
import { t } from '../i18n.js';
import { sb } from '../supabase.js';
import { q } from '../api.js';
import { can } from '../session.js';
import { refs, nm, purchaseUnit, unitLabel, material } from '../store.js';
const baseLabel = (r) => unitLabel(material(r.material_id)?.base_unit_id) || r.base_unit;

export const stockBadge = (s) => badge(t('st.' + s), s === 'OUT' ? 'bad' : s === 'LOW' ? 'warn' : 'ok');

export async function stockPage(root) {
  const locSel = select([['', t('all_locations')], ...refs.locations.map((l) => [l.id, nm(l)])], '');
  const stSel = select([['', t('all_statuses')], ['OK', t('st.OK')], ['LOW', t('st.LOW')], ['OUT', t('st.OUT')]], '');
  const search = input({ type: 'search', placeholder: t('search_material') });
  const box = h('div');
  let rows = [];
  const showValue = can('reports.cost') || can('inventory.materials');

  const cols = [
    { label: t('code'), key: 'code' },
    { label: t('material'), render: (r) => nm(r) },
    { label: t('location'), render: (r) => nm({ name_ar: r.location_name_ar, name_en: r.location_name_en }) },
    { label: t('balance'), num: true, x: (r) => Number(r.qty), render: (r) => {
        const pu = purchaseUnit(r.material_id);
        return h('div', null, `${fmtNum(r.qty)} ${baseLabel(r)}`,
          pu ? h('div', { class: 'muted small' }, `${fmtNum(r.qty / pu.factor, 2)} ${unitLabel(pu.unit_id)}`) : null);
      } },
    { label: t('min_stock'), num: true, x: (r) => Number(r.min_qty), render: (r) => fmtNum(r.min_qty) },
    { label: t('status'), x: (r) => t('st.' + r.stock_status), render: (r) => stockBadge(r.stock_status) },
    ...(showValue ? [{ label: t('stock_value'), num: true, x: (r) => Number(r.stock_value), render: (r) => fmtMoney(r.stock_value) }] : []),
  ];

  const view = () => {
    const s = search.value.trim().toLowerCase();
    return rows.filter((r) => (!locSel.value || r.location_id === Number(locSel.value))
      && (!stSel.value || r.stock_status === stSel.value)
      && (!s || `${r.code} ${r.name_ar} ${r.name_en || ''}`.toLowerCase().includes(s)));
  };
  const render = () => put(box, dataTable(cols, view(), { empty: t('no_data') }));

  root.append(
    h('div', { class: 'toolbar' },
      field(t('location'), locSel), field(t('status'), stSel),
      h('div', { class: 'grow' }, field(t('search'), search)),
      btn(t('export_excel'), () => exportExcel('stock', cols, view())),
      btn(t('print'), () => printSheet({ title: t('nav.stock'),
        meta: [[t('location'), locSel.selectedOptions[0].textContent]],
        body: dataTable(cols, view()) }))),
    box);
  [locSel, stSel].forEach((c) => (c.onchange = render));
  search.oninput = render;

  try {
    rows = await q(sb.from('v_material_stock').select('*').order('name_ar').order('location_id'));
    render();
  } catch (e) { toastError(e); }
}
