import { h, btn, modal, toast, toastError, busy, fmtNum, fmtMoney } from '../ui.js';
import { t } from '../i18n.js';
import { sb } from '../supabase.js';
import { q, rpc } from '../api.js';
import { crudPage, activeBadge, itemsEditor } from '../components.js';
import { nm, material, unitLabel } from '../store.js';

export async function addonsPage(root) {
  let recipes = [];
  const loadRecipes = async () => { recipes = await q(sb.from('addon_recipe_items').select('*')); };
  await loadRecipes();

  root.append(h('div', { class: 'alert info' }, t('addons_hint')));
  const page = await crudPage(root, {
    table: 'addons', order: 'sort', canEdit: true, newLabel: t('new_addon'),
    search: (r) => `${r.code} ${r.name_ar} ${r.name_en || ''}`,
    fields: [
      { key: 'code', label: t('code'), required: true, createOnly: true },
      { key: 'name_ar', label: t('name_ar'), required: true },
      { key: 'name_en', label: t('name_en') },
      { key: 'price', label: t('extra_price'), type: 'number', default: 0, required: true },
      { key: 'sort', label: t('sort'), type: 'number', default: 0 },
      { key: 'active', label: t('active'), type: 'bool', default: true },
    ],
    columns: [
      { label: t('code'), key: 'code' },
      { label: t('addon'), render: (r) => nm(r) },
      { label: t('extra_price'), num: true, render: (r) => fmtMoney(r.price) },
      { label: t('extra_consumption'), render: (r) => recipes.filter((x) => x.addon_id === r.id)
          .map((x) => `${Number(x.quantity) > 0 ? '+' : ''}${fmtNum(x.quantity)} ${unitLabel(x.unit_id)} ${nm(material(x.material_id))}`)
          .join(' | ') || h('span', { class: 'muted' }, t('none')) },
      { label: t('status'), render: activeBadge },
    ],
    rowActions: (r, reload) => btn(t('consumption'), () => consumptionForm(r, async () => { await loadRecipes(); reload(); }), 'sm'),
  });

  function consumptionForm(addon, done) {
    const editor = itemsEditor({
      allowNegative: true, allowEmpty: true,
      materialFilter: (m) => m.consumption_mode === 'RECIPE',
      initial: recipes.filter((x) => x.addon_id === addon.id)
        .map((x) => ({ material_id: x.material_id, qty: x.quantity, unit_id: x.unit_id })),
    });
    const saveBtn = btn(t('save'), () => busy(saveBtn, async () => {
      let items;
      try { items = editor.getItems(); } catch (e) { toast(e.message, 'warn'); return; }
      try {
        await rpc('save_addon_recipe', { p_addon_id: addon.id,
          p_items: items.map((i) => ({ material_id: i.material_id, quantity: i.qty, unit_id: i.unit_id })) });
        toast(t('saved'), 'ok'); m.close(); done();
      } catch (e) { toastError(e); }
    }), 'primary');
    const m = modal({ title: `${t('consumption')}: ${nm(addon)}`, wide: true,
      body: h('div', null, h('div', { class: 'alert info' }, t('addon_consumption_hint')), editor.el),
      actions: [btn(t('cancel'), () => m.close()), saveBtn] });
  }
  return page;
}
