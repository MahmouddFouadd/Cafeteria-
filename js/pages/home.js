import { h, dataTable, badge, fmtNum } from '../ui.js';
import { t } from '../i18n.js';
import { sb } from '../supabase.js';
import { q } from '../api.js';
import { can } from '../session.js';
import { session } from '../session.js';
import { nm, material, unitLabel } from '../store.js';

const LINKS = [
  ['docs/purchase', 'inventory.purchase'], ['docs/transfer', 'inventory.transfer'],
  ['docs/issue', 'inventory.issue'], ['docs/waste', 'inventory.waste'],
  ['stock', 'inventory.view'], ['counts', 'inventory.adjust'],
  ['catalog', 'catalog.manage'], ['materials', 'inventory.materials'],
];

export async function homePage(root) {
  root.append(h('p', { class: 'muted', style: { marginTop: 0 } }, t('home_hello', { name: session.profile.full_name })));

  const links = LINKS.filter(([, p]) => can(p));
  if (links.length) {
    root.append(h('section', { class: 'panel' },
      h('h2', null, t('quick_actions')),
      h('div', { class: 'quick' }, links.map(([k]) =>
        h('a', { href: '#/' + k }, t('nav.' + k.replace('docs/', '')), h('span', null, t('hint.' + k.replace('docs/', ''))))))));
  }

  if (can('inventory.view')) {
    const rows = await q(sb.from('v_material_stock').select('*').in('stock_status', ['LOW', 'OUT']).order('location_id').limit(12));
    root.append(h('section', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h2', null, t('low_stock')), h('a', { href: '#/stock', class: 'btn sm' }, t('view_stock'))),
      dataTable([
        { label: t('material'), render: (r) => nm({ name_ar: r.name_ar, name_en: r.name_en }) },
        { label: t('location'), render: (r) => nm({ name_ar: r.location_name_ar, name_en: r.location_name_en }) },
        { label: t('balance'), num: true, render: (r) => `${fmtNum(r.qty)} ${unitLabel(material(r.material_id)?.base_unit_id)}` },
        { label: t('min_stock'), num: true, render: (r) => fmtNum(r.min_qty) },
        { label: t('status'), render: (r) => badge(t('st.' + r.stock_status), r.stock_status === 'OUT' ? 'bad' : 'warn') },
      ], rows, { empty: t('no_low_stock') })));
  }
}
