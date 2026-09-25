import { h, put, clear, btn, input, select, field, checkbox, badge, modal, toast, toastError, busy,
         dataTable, exportExcel, fmtNum, fmtMoney } from './ui.js';
import { t } from './i18n.js';
import { sb } from './supabase.js';
import { q } from './api.js';
import { refs, nm, material, unitLabel, unitsForMaterial, factorOf } from './store.js';

/**
 * Line editor for stock documents and recipes.
 * opts:
 *  withCost      — manual cost per entered unit (purchase / opening)
 *  computedCost  — show cost from material avg_cost (recipes)
 *  allowNegative — signed quantities (add-on consumption)
 *  allowEmpty    — zero lines allowed
 *  materialFilter(m), stockLookup(materialId) → qty in base unit | null
 *  preferPurchaseUnit, initial: [{material_id, qty, unit_id, unit_cost}]
 *  onChange()
 */
export function itemsEditor(opts = {}) {
  const { withCost = false, computedCost = false, allowNegative = false, allowEmpty = false,
          materialFilter = () => true, stockLookup = null, preferPurchaseUnit = false,
          initial = [], onChange = () => {} } = opts;
  const rows = [];
  const body = h('tbody');
  const totalEl = h('span', { class: 'total' });
  const showTotal = withCost || computedCost;

  const materials = () => refs.materials.filter((m) => (m.active || initial.some((i) => i.material_id === m.id)) && materialFilter(m));

  function addRow(init = {}) {
    const r = { material_id: init.material_id ?? null, qty: init.qty ?? '', unit_id: init.unit_id ?? null, unit_cost: init.unit_cost ?? '' };
    const matSel = h('select', { class: 'input', 'aria-label': t('material') },
      h('option', { value: '' }, t('choose_material')),
      materials().map((m) => h('option', { value: m.id }, `${nm(m)} — ${m.code}`)));
    const unitSel = h('select', { class: 'input', 'aria-label': t('unit') });
    const qtyIn = input({ type: 'number', step: 'any', inputmode: 'decimal', min: allowNegative ? null : '0', 'aria-label': t('qty'), placeholder: t('qty') });
    const costIn = withCost ? input({ type: 'number', step: 'any', min: '0', inputmode: 'decimal', 'aria-label': t('unit_cost'), placeholder: t('unit_cost') }) : null;
    const info = h('div', { class: 'muted small' });
    const lineEl = showTotal ? h('td', { class: 'num' }) : null;
    const tr = h('tr', null,
      h('td', null, matSel, info),
      h('td', { style: { width: '130px' } }, qtyIn),
      h('td', { style: { width: '190px' } }, unitSel),
      withCost ? h('td', { style: { width: '140px' } }, costIn) : null,
      lineEl,
      h('td', { style: { width: '44px' } }, h('button', {
        class: 'icon-btn danger', type: 'button', 'aria-label': t('remove'),
        onclick: () => { rows.splice(rows.indexOf(r), 1); tr.remove(); recalc(); },
      }, '✕')));

    function fillUnits(keep) {
      clear(unitSel);
      const list = unitsForMaterial(r.material_id);
      const base = list[0];
      list.forEach((u) => unitSel.append(h('option', { value: u.unit_id },
        unitLabel(u.unit_id) + (u.factor !== 1 ? ` (${fmtNum(u.factor)} ${unitLabel(base.unit_id)})` : ''))));
      const pick = (keep && list.find((u) => u.unit_id === keep)) || (preferPurchaseUnit && list.find((u) => u.purchase)) || base;
      if (pick) { unitSel.value = pick.unit_id; r.unit_id = pick.unit_id; } else r.unit_id = null;
    }
    r.showInfo = () => {
      if (!stockLookup || !r.material_id) { info.textContent = ''; return; }
      const s = stockLookup(r.material_id);
      const m = material(r.material_id);
      info.textContent = s == null ? '' : `${t('available')}: ${fmtNum(s)} ${unitLabel(m.base_unit_id)}`;
      info.style.color = s != null && s <= 0 ? 'var(--bad)' : '';
    };
    r.lineCost = () => {
      const qn = Number(r.qty) || 0;
      if (withCost) return qn * (Number(r.unit_cost) || 0);
      if (computedCost && r.material_id) {
        const m = material(r.material_id);
        if (!m || !m.track_stock) return 0;
        return qn * (factorOf(r.material_id, r.unit_id) || 1) * Number(m.avg_cost || 0);
      }
      return 0;
    };
    r.lineEl = lineEl;

    matSel.onchange = () => { r.material_id = Number(matSel.value) || null; fillUnits(); r.showInfo(); recalc(); };
    unitSel.onchange = () => { r.unit_id = Number(unitSel.value); recalc(); };
    qtyIn.oninput = () => { r.qty = qtyIn.value; recalc(); };
    if (costIn) costIn.oninput = () => { r.unit_cost = costIn.value; recalc(); };

    if (r.material_id) { matSel.value = r.material_id; fillUnits(r.unit_id); r.showInfo(); }
    if (r.qty !== '') qtyIn.value = r.qty;
    if (costIn && r.unit_cost !== '') costIn.value = r.unit_cost;

    rows.push(r);
    body.append(tr);
    return r;
  }

  function recalc() {
    if (showTotal) {
      let tot = 0;
      rows.forEach((r) => { const v = r.lineCost(); tot += v; if (r.lineEl) r.lineEl.textContent = v ? fmtMoney(v) : ''; });
      totalEl.textContent = fmtMoney(tot);
      api.total = tot;
    }
    onChange();
  }

  const el = h('div', { class: 'items-editor' },
    h('div', { class: 'table-wrap' },
      h('table', { class: 'tbl tbl-edit' },
        h('thead', null, h('tr', null,
          h('th', null, t('material')), h('th', null, t('qty')), h('th', null, t('unit')),
          withCost ? h('th', null, t('unit_cost')) : null,
          showTotal ? h('th', { class: 'num' }, t('line_cost')) : null,
          h('th', null, ''))),
        body)),
    h('div', { class: 'items-foot' },
      btn('+ ' + t('add_line'), () => addRow(), 'ghost'),
      showTotal ? h('div', null, t('total') + ': ', totalEl) : null));

  const api = {
    el, total: 0, addRow,
    getItems() {
      const out = [];
      for (const r of rows) {
        if (!r.material_id && (r.qty === '' || r.qty == null)) continue;
        if (!r.material_id) throw new Error(t('err.MATERIAL_REQUIRED'));
        const qn = Number(r.qty);
        if (!qn || (!allowNegative && qn < 0)) throw new Error(t('err.QTY_INVALID'));
        if (out.some((o) => o.material_id === r.material_id) && (computedCost || allowNegative))
          throw new Error(t('err.DUPLICATE_MATERIAL'));
        const it = { material_id: r.material_id, qty: qn, unit_id: r.unit_id };
        if (withCost) it.unit_cost = Number(r.unit_cost) || 0;
        out.push(it);
      }
      if (!out.length && !allowEmpty) throw new Error(t('err.ITEMS_REQUIRED'));
      return out;
    },
    reset() { rows.splice(0); clear(body); addRow(); recalc(); },
    refreshStock() { rows.forEach((r) => r.showInfo()); },
  };

  if (initial.length) initial.forEach((i) => addRow(i)); else addRow();
  recalc();
  return api;
}

/**
 * Generic list + add/edit modal for simple master tables.
 * cfg: { table, select?, order?, title, fields:[{key,label,type:'text'|'number'|'bool'|'select'|'textarea',
 *        options?:()=>[[v,l]], required?, createOnly?, default?}], columns, canEdit, canCreate,
 *        search?(row)=>string, rowActions?(row, reload)=>nodes, afterSave?(), exportName? }
 */
export async function crudPage(root, cfg) {
  const { canEdit = false, canCreate = canEdit } = cfg;
  let rows = [];
  const searchIn = input({ type: 'search', placeholder: t('search') });
  const listBox = h('div');
  root.append(
    h('div', { class: 'toolbar' },
      h('div', { class: 'grow' }, searchIn),
      cfg.exportName ? btn(t('export_excel'), () => exportExcel(cfg.exportName, cfg.columns, filtered())) : null,
      canCreate ? btn('+ ' + (cfg.newLabel || t('add')), () => openForm(null), 'primary') : null),
    listBox);
  searchIn.oninput = render;

  function filtered() {
    const s = searchIn.value.trim().toLowerCase();
    if (!s || !cfg.search) return rows;
    return rows.filter((r) => cfg.search(r).toLowerCase().includes(s));
  }

  function render() {
    const cols = [...cfg.columns];
    if (canEdit || cfg.rowActions) {
      cols.push({ label: '', render: (r) => h('div', { class: 'row-actions' },
        cfg.rowActions ? cfg.rowActions(r, reload) : null,
        canEdit ? btn(t('edit'), () => openForm(r), 'sm') : null) });
    }
    put(listBox, dataTable(cols, filtered(), { rowClass: (r) => (r.active === false ? 'row-muted' : '') }));
  }

  async function reload() {
    try {
      let qb = sb.from(cfg.table).select(cfg.select || '*');
      if (cfg.order) qb = qb.order(cfg.order);
      rows = await q(qb);
      render();
    } catch (e) { toastError(e); }
  }

  function openForm(row) {
    const isNew = !row;
    const controls = {};
    const grid = h('div', { class: 'form-grid' });
    for (const f of cfg.fields) {
      const val = isNew ? (typeof f.default === 'function' ? f.default() : f.default) : row[f.key];
      let c;
      if (f.type === 'bool') { c = checkbox(f.label, isNew ? (f.default ?? true) : val); controls[f.key] = c.input; grid.append(h('div', { class: 'field' }, h('span', { class: 'field-label' }, '\u00a0'), c)); continue; }
      if (f.type === 'select') c = select([['', '—'], ...f.options()], val);
      else if (f.type === 'textarea') c = h('textarea', { class: 'input' }, val ?? '');
      else c = input({ type: f.type === 'number' ? 'number' : 'text', step: 'any', value: val ?? '' });
      if (!isNew && f.createOnly) c.disabled = true;
      controls[f.key] = c;
      grid.append(field(f.label + (f.required ? ' *' : ''), c, f.wide ? 'span-2' : ''));
    }
    const saveBtn = btn(t('save'), () => busy(saveBtn, save), 'primary');
    const m = modal({ title: isNew ? (cfg.newLabel || t('add')) : t('edit'), body: grid, actions: [btn(t('cancel'), () => m.close()), saveBtn] });

    async function save() {
      const values = {};
      for (const f of cfg.fields) {
        if (!isNew && f.createOnly) continue;
        const c = controls[f.key];
        let v;
        if (f.type === 'bool') v = c.checked;
        else if (f.type === 'number') v = c.value === '' ? null : Number(c.value);
        else if (f.type === 'select') v = c.value === '' ? null : (f.numeric === false ? c.value : Number(c.value));
        else v = c.value.trim() === '' ? null : c.value.trim();
        if (f.required && (v == null || v === '')) { toast(`${t('required')}: ${f.label}`, 'warn'); c.focus(); return; }
        values[f.key] = v;
      }
      try {
        if (isNew) await q(sb.from(cfg.table).insert(values));
        else await q(sb.from(cfg.table).update(values).eq('id', row.id));
        toast(t('saved'), 'ok');
        m.close();
        if (cfg.afterSave) await cfg.afterSave();
        reload();
      } catch (e) { toastError(e); }
    }
  }

  await reload();
  return { reload };
}

export const activeBadge = (r) => (r.active ? badge(t('active'), 'ok') : badge(t('inactive')));
