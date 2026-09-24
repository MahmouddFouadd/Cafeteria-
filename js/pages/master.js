import { h, clear } from '../ui.js';
import { t } from '../i18n.js';
import { can } from '../session.js';
import { crudPage, activeBadge } from '../components.js';
import { nm, loadRefs } from '../store.js';

const DIMENSIONS = ['MASS', 'VOLUME', 'COUNT', 'PACK'];

const TABS = [
  { key: 'units', perm: 'inventory.materials', cfg: () => ({
      table: 'units', order: 'id', newLabel: t('new_unit'),
      search: (r) => `${r.code} ${r.name_ar} ${r.name_en}`,
      fields: [
        { key: 'code', label: t('code'), required: true, createOnly: true },
        { key: 'name_ar', label: t('name_ar'), required: true },
        { key: 'name_en', label: t('name_en'), required: true },
        { key: 'dimension', label: t('dimension'), type: 'select', numeric: false, required: true, createOnly: true,
          options: () => DIMENSIONS.map((d) => [d, t('dim.' + d)]) },
      ],
      columns: [
        { label: t('code'), key: 'code' }, { label: t('name'), render: (r) => nm(r) },
        { label: t('dimension'), render: (r) => t('dim.' + r.dimension) },
      ] }) },
  { key: 'matcats', perm: 'inventory.materials', cfg: () => ({
      table: 'material_categories', order: 'id', newLabel: t('new_category'),
      search: (r) => `${r.name_ar} ${r.name_en || ''}`,
      fields: [
        { key: 'name_ar', label: t('name_ar'), required: true }, { key: 'name_en', label: t('name_en') },
        { key: 'active', label: t('active'), type: 'bool', default: true },
      ],
      columns: [{ label: t('name'), render: (r) => nm(r) }, { label: t('status'), render: activeBadge }] }) },
  { key: 'prodcats', perm: 'catalog.manage', cfg: () => ({
      table: 'product_categories', order: 'sort', newLabel: t('new_category'),
      search: (r) => `${r.name_ar} ${r.name_en || ''}`,
      fields: [
        { key: 'name_ar', label: t('name_ar'), required: true }, { key: 'name_en', label: t('name_en') },
        { key: 'sort', label: t('sort'), type: 'number', default: 0 },
        { key: 'active', label: t('active'), type: 'bool', default: true },
      ],
      columns: [{ label: t('name'), render: (r) => nm(r) }, { label: t('sort'), key: 'sort', num: true },
        { label: t('status'), render: activeBadge }] }) },
  { key: 'suppliers', perm: 'inventory.materials', cfg: () => ({
      table: 'suppliers', order: 'name', newLabel: t('new_supplier'),
      search: (r) => `${r.name} ${r.phone || ''}`,
      fields: [
        { key: 'name', label: t('name'), required: true }, { key: 'phone', label: t('phone') },
        { key: 'notes', label: t('notes'), type: 'textarea', wide: true },
        { key: 'active', label: t('active'), type: 'bool', default: true },
      ],
      columns: [{ label: t('name'), key: 'name' }, { label: t('phone'), key: 'phone' },
        { label: t('status'), render: activeBadge }] }) },
  { key: 'locations', perm: 'inventory.materials', cfg: () => ({
      table: 'stock_locations', order: 'id', canCreate: false,
      fields: [
        { key: 'name_ar', label: t('name_ar'), required: true }, { key: 'name_en', label: t('name_en'), required: true },
      ],
      columns: [{ label: t('code'), key: 'code' }, { label: t('name'), render: (r) => nm(r) },
        { label: t('consumption_location'), render: (r) => (r.is_consumption ? t('yes') : '') }] }) },
];

export async function masterPage(root) {
  const tabs = TABS.filter((x) => can(x.perm));
  const bar = h('div', { class: 'tabs', role: 'tablist' });
  const body = h('div');
  root.append(bar, body);
  async function show(key) {
    bar.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.k === key));
    clear(body);
    const tab = tabs.find((x) => x.key === key);
    await crudPage(body, { canEdit: true, ...tab.cfg(), afterSave: () => loadRefs(true) });
  }
  tabs.forEach((x) => bar.append(h('button', { type: 'button', role: 'tab', 'data-k': x.key, onclick: () => show(x.key) }, t('tab.' + x.key))));
  if (tabs.length) await show(tabs[0].key);
}
