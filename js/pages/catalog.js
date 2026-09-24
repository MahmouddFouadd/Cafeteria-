import { h, put, clear, btn, input, select, field, checkbox, dataTable, badge, modal, toast, toastError, busy,
         confirmDialog, fmtMoney } from '../ui.js';
import { t } from '../i18n.js';
import { sb } from '../supabase.js';
import { q, rpc } from '../api.js';
import { can } from '../session.js';
import { itemsEditor, activeBadge } from '../components.js';
import { refs, nm, loadRefs } from '../store.js';

export async function catalogPage(root) {
  const canCatalog = can('catalog.manage');
  const canPrice = can('prices.change');
  const canRecipe = can('recipes.manage');
  const showCost = can('reports.cost') || canRecipe;

  const catSel = select([['', t('all_categories')], ...refs.prodCats.map((c) => [c.id, nm(c)])], '');
  const search = input({ type: 'search', placeholder: t('search_product') });
  const showInactive = checkbox(t('show_inactive'), true);
  const box = h('div');
  let products = [], costs = new Map(), addons = [], variantAddons = [];

  root.append(
    h('div', { class: 'toolbar' },
      field(t('category'), catSel),
      h('div', { class: 'grow' }, field(t('search'), search)),
      showInactive,
      canCatalog ? btn('+ ' + t('new_product'), () => productForm(null), 'primary') : null),
    box);
  catSel.onchange = render; search.oninput = render; showInactive.input.onchange = render;

  async function load() {
    try {
      const [p, c, a, va] = await Promise.all([
        q(sb.from('products').select('*, product_variants(*)').order('sort').order('id')),
        q(sb.from('v_variant_cost').select('variant_id, material_cost, gross_margin, version')),
        q(sb.from('addons').select('*').order('sort')),
        q(sb.from('variant_addons').select('*')),
      ]);
      products = p; costs = new Map(c.map((x) => [x.variant_id, x])); addons = a; variantAddons = va;
      render();
    } catch (e) { toastError(e); }
  }

  function render() {
    const s = search.value.trim().toLowerCase();
    const list = products.filter((p) => (!catSel.value || p.category_id === Number(catSel.value))
      && (showInactive.input.checked || p.active)
      && (!s || `${p.code} ${p.name_ar} ${p.name_en || ''}`.toLowerCase().includes(s)));
    clear(box);
    if (!list.length) { box.append(h('div', { class: 'empty' }, t('no_products'))); return; }
    for (const p of list) {
      const variants = [...(p.product_variants || [])].sort((a, b) => a.sort - b.sort || a.id - b.id)
        .filter((v) => showInactive.input.checked || v.active);
      box.append(h('section', { class: 'product' },
        h('div', { class: 'product-head' },
          h('h3', null, nm(p)),
          h('span', { class: 'muted small' }, nm(refs.prodCats.find((c) => c.id === p.category_id))),
          activeBadge(p),
          canCatalog ? btn(t('edit'), () => productForm(p), 'sm') : null,
          canCatalog ? btn('+ ' + t('new_variant'), () => variantForm(p, null), 'sm') : null),
        variants.length ? dataTable([
          { label: t('variant'), render: (v) => h('div', null, nm(v), h('div', { class: 'muted small' }, v.code)) },
          { label: t('price'), num: true, render: (v) => fmtMoney(v.price) },
          ...(showCost ? [
            { label: t('material_cost'), num: true, render: (v) => fmtMoney(costs.get(v.id)?.material_cost ?? 0) },
            { label: t('margin'), num: true, render: (v) => fmtMoney(costs.get(v.id)?.gross_margin ?? v.price) },
          ] : []),
          { label: t('recipe_version'), num: true, render: (v) => costs.get(v.id)?.version ?? '—' },
          { label: t('status'), render: activeBadge },
          { label: '', render: (v) => h('div', { class: 'row-actions' },
              canPrice ? btn(t('change_price'), () => priceForm(p, v), 'sm') : null,
              canRecipe ? btn(t('recipe'), () => recipeForm(p, v), 'sm') : null,
              canCatalog ? btn(t('addons_btn'), () => variantAddonsForm(p, v), 'sm') : null,
              canCatalog ? btn(t('edit'), () => variantForm(p, v), 'sm') : null) },
        ], variants) : h('div', { class: 'empty', style: { margin: '0 16px 16px' } }, t('no_variants'))));
    }
  }

  // ---------- Product ----------
  function productForm(p) {
    const code = input({ value: p?.code ?? '', disabled: !!p, dir: 'ltr' });
    const nameAr = input({ value: p?.name_ar ?? '' });
    const nameEn = input({ value: p?.name_en ?? '', dir: 'ltr' });
    const cat = select(refs.prodCats.map((c) => [c.id, nm(c)]), p?.category_id ?? refs.prodCats[0]?.id);
    const sort = input({ type: 'number', value: p?.sort ?? 0 });
    const active = checkbox(t('active'), p ? p.active : true);
    const saveBtn = btn(t('save'), () => busy(saveBtn, async () => {
      if (!nameAr.value.trim() || (!p && !code.value.trim())) { toast(t('required_fields'), 'warn'); return; }
      const values = { name_ar: nameAr.value.trim(), name_en: nameEn.value.trim() || null,
        category_id: Number(cat.value) || null, sort: Number(sort.value) || 0, active: active.input.checked };
      try {
        if (p) await q(sb.from('products').update(values).eq('id', p.id));
        else {
          const [np] = await q(sb.from('products').insert({ ...values, code: code.value.trim().toUpperCase() }).select());
          m.close(); toast(t('saved'), 'ok'); await load();
          variantForm(np, null);
          return;
        }
        toast(t('saved'), 'ok'); m.close(); load();
      } catch (e) { toastError(e); }
    }), 'primary');
    const m = modal({ title: p ? t('edit_product') : t('new_product'),
      body: h('div', { class: 'form-grid' }, field(t('code') + ' *', code), field(t('category'), cat),
        field(t('name_ar') + ' *', nameAr), field(t('name_en'), nameEn), field(t('sort'), sort),
        h('div', { class: 'field' }, h('span', { class: 'field-label' }, '\u00a0'), active)),
      actions: [btn(t('cancel'), () => m.close()), saveBtn] });
  }

  // ---------- Variant ----------
  function variantForm(p, v) {
    const code = input({ value: v?.code ?? `${p.code}_`, disabled: !!v, dir: 'ltr' });
    const nameAr = input({ value: v?.name_ar ?? t('regular_ar') });
    const nameEn = input({ value: v?.name_en ?? 'Regular', dir: 'ltr' });
    const price = input({ type: 'number', step: '0.01', min: '0', value: v?.price ?? '', disabled: !!v });
    const sort = input({ type: 'number', value: v?.sort ?? ((p.product_variants?.length || 0) + 1) });
    const active = checkbox(t('active'), v ? v.active : true);
    const saveBtn = btn(t('save'), () => busy(saveBtn, async () => {
      if (!nameAr.value.trim() || (!v && (!code.value.trim() || price.value === ''))) { toast(t('required_fields'), 'warn'); return; }
      const values = { name_ar: nameAr.value.trim(), name_en: nameEn.value.trim() || null,
        sort: Number(sort.value) || 0, active: active.input.checked };
      try {
        if (v) await q(sb.from('product_variants').update(values).eq('id', v.id));
        else {
          const [nv] = await q(sb.from('product_variants').insert({ ...values, product_id: p.id,
            code: code.value.trim().toUpperCase(), price: Number(price.value) }).select());
          if (canRecipe) await rpc('save_recipe', { p_variant_id: nv.id, p_items: [], p_notes: 'Created' });
          m.close(); toast(t('saved'), 'ok'); await load();
          if (canRecipe) recipeForm(p, nv);
          return;
        }
        toast(t('saved'), 'ok'); m.close(); load();
      } catch (e) { toastError(e); }
    }), 'primary');
    const m = modal({ title: v ? t('edit_variant') : `${t('new_variant')}: ${nm(p)}`,
      body: h('div', { class: 'form-grid' },
        field(t('code') + ' *', code), field(t('price') + (v ? ` (${t('use_change_price')})` : ' *'), price),
        field(t('name_ar') + ' *', nameAr), field(t('name_en'), nameEn), field(t('sort'), sort),
        h('div', { class: 'field' }, h('span', { class: 'field-label' }, '\u00a0'), active)),
      actions: [btn(t('cancel'), () => m.close()), saveBtn] });
  }

  // ---------- Price ----------
  function priceForm(p, v) {
    const price = input({ type: 'number', step: '0.01', min: '0', value: v.price });
    const reason = h('textarea', { class: 'input', rows: 2 });
    const hist = h('div');
    q(sb.from('variant_price_history').select('*').eq('variant_id', v.id).order('id', { ascending: false }).limit(10))
      .then((rows) => hist.append(rows.length ? dataTable([
        { label: t('date'), render: (r) => new Date(r.changed_at).toLocaleDateString('en-GB') },
        { label: t('old_price'), num: true, render: (r) => fmtMoney(r.old_price) },
        { label: t('new_price'), num: true, render: (r) => fmtMoney(r.new_price) },
        { label: t('reason'), render: (r) => r.reason || '' },
      ], rows) : null)).catch(() => {});
    const saveBtn = btn(t('save'), () => busy(saveBtn, async () => {
      const n = Number(price.value);
      if (price.value === '' || n < 0) { toast(t('err.PRICE_INVALID'), 'warn'); return; }
      try {
        await rpc('update_variant_price', { p_variant_id: v.id, p_price: n, p_reason: reason.value.trim() || null });
        toast(t('saved'), 'ok'); m.close(); load();
      } catch (e) { toastError(e); }
    }), 'primary');
    const m = modal({ title: `${t('change_price')}: ${nm(p)} — ${nm(v)}`,
      body: h('div', null, h('div', { class: 'form-grid' },
        field(t('current_price'), input({ value: fmtMoney(v.price), disabled: true })),
        field(t('new_price'), price), field(t('reason'), reason, 'span-all')),
        h('h3', { style: { fontSize: '15px', margin: '20px 0 8px' } }, t('price_history')), hist),
      actions: [btn(t('cancel'), () => m.close()), saveBtn] });
  }

  // ---------- Recipe ----------
  async function recipeForm(p, v) {
    let current;
    try {
      const rows = await q(sb.from('recipes').select('*, recipe_items(*)').eq('variant_id', v.id).eq('is_current', true));
      current = rows[0];
    } catch (e) { toastError(e); return; }
    const initial = (current?.recipe_items || []).map((i) => ({ material_id: i.material_id, qty: i.quantity, unit_id: i.unit_id }));
    const summary = h('div', { class: 'kv' });
    let editor = null;
    editor = itemsEditor({
      computedCost: true, allowEmpty: true, initial,
      materialFilter: (m) => m.consumption_mode === 'RECIPE',
      onChange: () => updateSummary(),
    });
    function updateSummary() {
      const cost = editor?.total ?? 0;
      put(summary, 
        h('dt', null, t('price')), h('dd', null, fmtMoney(v.price)),
        h('dt', null, t('material_cost')), h('dd', null, fmtMoney(cost)),
        h('dt', null, t('margin')), h('dd', null, fmtMoney(Number(v.price) - cost)));
    }
    const notes = input({ placeholder: t('recipe_change_note') });
    const saveBtn = btn(t('save_recipe'), () => busy(saveBtn, async () => {
      let items;
      try { items = editor.getItems(); } catch (e) { toast(e.message, 'warn'); return; }
      if (!items.length) {
        const c = await confirmDialog(t('empty_recipe_confirm'));
        if (!c.ok) return;
      }
      try {
        const res = await rpc('save_recipe', { p_variant_id: v.id,
          p_items: items.map((i) => ({ material_id: i.material_id, quantity: i.qty, unit_id: i.unit_id })),
          p_notes: notes.value.trim() || null });
        toast(t('recipe_saved', { v: res.version }), 'ok'); m.close(); load();
      } catch (e) { toastError(e); }
    }), 'primary');
    const m = modal({ title: `${t('recipe')}: ${nm(p)} — ${nm(v)}`, wide: true,
      body: h('div', null,
        h('div', { class: 'alert info' }, t('recipe_hint', { v: current?.version ?? 0 })),
        editor.el,
        h('div', { style: { marginTop: '16px' } }, summary),
        field(t('notes'), notes)),
      actions: [btn(t('cancel'), () => m.close()), saveBtn] });
    updateSummary();
  }

  // ---------- Allowed add-ons ----------
  function variantAddonsForm(p, v) {
    const current = new Set(variantAddons.filter((x) => x.variant_id === v.id).map((x) => x.addon_id));
    const boxes = addons.map((a) => {
      const c = checkbox(`${nm(a)}${Number(a.price) ? ` (+${fmtMoney(a.price)})` : ''}${a.active ? '' : ` — ${t('inactive')}`}`, current.has(a.id));
      c.addon = a;
      return c;
    });
    const saveBtn = btn(t('save'), () => busy(saveBtn, async () => {
      const want = new Set(boxes.filter((b) => b.input.checked).map((b) => b.addon.id));
      const toAdd = [...want].filter((id) => !current.has(id));
      const toDel = [...current].filter((id) => !want.has(id));
      try {
        if (toAdd.length) await q(sb.from('variant_addons').insert(toAdd.map((addon_id) => ({ variant_id: v.id, addon_id }))));
        if (toDel.length) await q(sb.from('variant_addons').delete().eq('variant_id', v.id).in('addon_id', toDel));
        toast(t('saved'), 'ok'); m.close(); load();
      } catch (e) { toastError(e); }
    }), 'primary');
    const m = modal({ title: `${t('addons_btn')}: ${nm(p)} — ${nm(v)}`,
      body: boxes.length ? h('div', { style: { display: 'grid', gap: '4px' } }, boxes) : h('div', { class: 'empty' }, t('no_addons')),
      actions: [btn(t('cancel'), () => m.close()), saveBtn] });
  }

  await load();
}
