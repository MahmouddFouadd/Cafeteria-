import { h, fmtNum } from '../ui.js';
import { t } from '../i18n.js';
import { sb } from '../supabase.js';
import { q } from '../api.js';
import { can, canAny } from '../session.js';

/** Routes that live under the "Inventory" hub (used for the menu highlight and the back link). */
export const INV_KEYS = ['stock', 'docs/purchase', 'docs/transfer', 'docs/issue', 'docs/waste',
                         'docs/opening', 'counts', 'docs', 'movements', 'materials'];

const GROUPS = [
  { title: 'inv_g_new', items: [
    ['docs/transfer', 'inventory.transfer', 'inv_t_transfer', 'inv_d_transfer'],
    ['docs/purchase', 'inventory.purchase', 'inv_t_purchase', 'inv_d_purchase'],
    ['docs/issue',    'inventory.issue',    'inv_t_issue',    'inv_d_issue'],
    ['docs/waste',    'inventory.waste',    'inv_t_waste',    'inv_d_waste'],
  ] },
  { title: 'inv_g_follow', items: [
    ['stock',     'inventory.view',   'nav.stock',     'inv_d_stock'],
    ['counts',    'inventory.adjust', 'nav.counts',    'inv_d_counts'],
    ['docs',      'inventory.view',   'nav.docs',      'inv_d_docs'],
    ['movements', 'inventory.view',   'nav.movements', 'inv_d_movements'],
  ] },
  { title: 'inv_g_setup', items: [
    ['materials',    'inventory.materials', 'nav.materials', 'inv_d_materials'],
    ['docs/opening', 'inventory.adjust',    'nav.opening',   'inv_d_opening'],
  ] },
];

export async function inventoryPage(root) {
  const alerts = h('div');
  root.append(alerts);
  if (can('inventory.view')) {
    q(sb.from('v_material_stock').select('stock_status,location_code').in('stock_status', ['LOW', 'OUT']))
      .then((rows) => {
        const buffet = rows.filter((r) => r.location_code === 'BUFFET').length;
        if (rows.length) alerts.append(h('a', { href: '#/stock', class: 'alert warn inv-alert' },
          t('inv_alerts', { n: fmtNum(rows.length), b: fmtNum(buffet) })));
      }).catch(() => {});
  }
  for (const g of GROUPS) {
    const items = g.items.filter(([, perm]) => can(perm) || (perm === 'inventory.view' && canAny(['inventory.view'])));
    if (!items.length) continue;
    root.append(h('section', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h2', null, t(g.title))),
      h('div', { class: 'hub-grid' + (g.title === 'inv_g_new' ? ' big' : '') }, items.map(([key, , title, desc]) =>
        h('a', { href: '#/' + key, class: 'hub-tile' },
          h('b', null, t(title)),
          h('span', { class: 'muted small' }, t(desc)))))));
  }
}
