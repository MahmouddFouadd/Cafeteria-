import { h, put, clear, btn, input, select, field, dataTable, badge, modal, toast, toastError, busy, confirmDialog,
         fmtNum, fmtMoney, fmtDateTime, daysAgoISO, todayISO, printSheet, exportExcel } from '../ui.js';
import { t } from '../i18n.js';
import { sb } from '../supabase.js';
import { q, rpc } from '../api.js';
import { can } from '../session.js';
import { itemsEditor } from '../components.js';
import { refs, nm, loadRefs, locationByCode, location, material, unitLabel } from '../store.js';

const WASTE_REASONS = ['EXPIRED', 'SPILLED', 'DAMAGED', 'PREPARED_CANCELLED', 'OTHER'];

const locOptions = () => refs.locations.filter((l) => l.active).map((l) => [l.id, nm(l)]);
const defaultLoc = (code) => locationByCode(code)?.id ?? refs.locations[0]?.id;

async function stockMap(locationId) {
  const rows = await q(sb.from('material_stock').select('material_id, qty').eq('location_id', locationId));
  return new Map(rows.map((r) => [r.material_id, Number(r.qty)]));
}

// ---------------------------------------------------------------------
// New document forms
// ---------------------------------------------------------------------
export async function docFormPage(root, type) {
  const cfg = {
    PURCHASE: { loc: 'MAIN', withCost: true, purchaseUnit: true, stock: false },
    OPENING:  { loc: 'MAIN', withCost: true, purchaseUnit: true, stock: false },
    TRANSFER: { loc: 'MAIN', purchaseUnit: true, stock: true },
    ISSUE:    { loc: 'MAIN', purchaseUnit: true, stock: true, filter: (m) => m.consumption_mode === 'ISSUE' },
    WASTE:    { loc: 'BUFFET', stock: true },
  }[type];

  root.append(h('div', { class: 'alert info' }, t('doc_hint.' + type)));

  const locSel = select(locOptions(), defaultLoc(cfg.loc));
  const toSel = type === 'TRANSFER' ? select(locOptions(), defaultLoc('BUFFET')) : null;
  const supplierSel = type === 'PURCHASE'
    ? select([['', t('no_supplier')], ...refs.suppliers.filter((s) => s.active).map((s) => [s.id, s.name])], '') : null;
  const invoiceIn = type === 'PURCHASE' ? input({ placeholder: t('invoice_ref') }) : null;
  const issuedTo = type === 'ISSUE' ? input({ placeholder: t('issued_to_ph') }) : null;
  const reasonSel = type === 'WASTE' ? select(WASTE_REASONS.map((r) => [r, t('waste.' + r)]), 'EXPIRED') : null;
  const notes = h('textarea', { class: 'input', rows: 2 });

  let stock = new Map();
  const editor = itemsEditor({
    withCost: cfg.withCost,
    preferPurchaseUnit: cfg.purchaseUnit,
    materialFilter: (m) => m.track_stock && (!cfg.filter || cfg.filter(m)),
    stockLookup: cfg.stock ? (id) => (stock.has(id) ? stock.get(id) : 0) : null,
  });
  const refreshStock = async () => {
    if (!cfg.stock) return;
    try { stock = await stockMap(Number(locSel.value)); editor.refreshStock(); } catch (e) { toastError(e); }
  };
  locSel.onchange = refreshStock;

  const header = h('div', { class: 'form-grid' },
    field(type === 'TRANSFER' ? t('from_location') : t('location'), locSel),
    toSel ? field(t('to_location'), toSel) : null,
    supplierSel ? field(t('supplier'), supplierSel) : null,
    invoiceIn ? field(t('invoice_ref'), invoiceIn) : null,
    issuedTo ? field(t('issued_to'), issuedTo) : null,
    reasonSel ? field(t('waste_reason'), reasonSel) : null,
    field(t('notes') + (type === 'WASTE' ? ` (${t('required_if_other')})` : ''), notes, 'span-all'));

  const saveBtn = btn(t('post_' + type.toLowerCase()), () => busy(saveBtn, save), 'primary');
  const result = h('div');
  root.append(
    h('section', { class: 'panel' }, header),
    h('section', { class: 'panel' }, h('h2', null, t('items')), editor.el,
      h('div', { class: 'form-actions' }, btn(t('clear'), () => editor.reset()), saveBtn)),
    result);
  await refreshStock();

  async function save() {
    let items;
    try { items = editor.getItems(); } catch (e) { toast(e.message, 'warn'); return; }
    const loc = Number(locSel.value);
    const n = notes.value.trim() || null;
    const ok = await confirmDialog(t('confirm_post', { count: items.length }));
    if (!ok.ok) return;
    try {
      let res;
      if (type === 'PURCHASE') res = await rpc('post_purchase', { p_location_id: loc, p_items: items,
        p_supplier_id: supplierSel.value ? Number(supplierSel.value) : null, p_invoice_ref: invoiceIn.value.trim() || null, p_notes: n });
      if (type === 'OPENING') res = await rpc('post_opening_balance', { p_location_id: loc, p_items: items, p_notes: n });
      if (type === 'TRANSFER') res = await rpc('post_transfer', { p_from_location_id: loc, p_to_location_id: Number(toSel.value), p_items: items, p_notes: n });
      if (type === 'ISSUE') res = await rpc('post_issue', { p_location_id: loc, p_items: items, p_issued_to: issuedTo.value.trim() || null, p_notes: n });
      if (type === 'WASTE') res = await rpc('post_waste', { p_location_id: loc, p_reason_code: reasonSel.value, p_items: items, p_notes: n });

      toast(res?.doc_no ? t('posted_doc', { no: res.doc_no }) : t('saved'), 'ok');
      clear(result);
      if (res?.warnings?.length) {
        result.append(h('div', { class: 'alert warn' }, t('negative_warning'), ' ',
          res.warnings.map((w) => `${nm(w)} (${fmtNum(w.qty)})`).join('، ')));
      }
      editor.reset();
      notes.value = '';
      if (invoiceIn) invoiceIn.value = '';
      await loadRefs(true);
      await refreshStock();
    } catch (e) { toastError(e); }
  }
}

// ---------------------------------------------------------------------
// Documents list
// ---------------------------------------------------------------------
const ITEMS_TABLE = {
  PURCHASE: ['purchase_items', 'purchase_id'],
  TRANSFER: ['stock_transfer_items', 'transfer_id'],
  ISSUE: ['stock_issue_items', 'issue_id'],
  WASTE: ['waste_items', 'waste_id'],
};

const partyText = (d) => (d.doc_type === 'WASTE' && d.party ? t('waste.' + d.party) : d.party || '');
const locText = (d) => d.doc_type === 'TRANSFER'
  ? `${nm(location(d.location_id))} ${document.documentElement.dir === 'rtl' ? '←' : '→'} ${nm(location(d.to_location_id))}`
  : nm(location(d.location_id));

export async function docsListPage(root) {
  const typeSel = select([['', t('all_types')], ...Object.keys(ITEMS_TABLE).map((k) => [k, t('doc.' + k)])], '');
  const from = input({ type: 'date', value: daysAgoISO(30) });
  const to = input({ type: 'date', value: todayISO() });
  const box = h('div');
  let rows = [];

  const cols = [
    { label: t('doc_no'), key: 'doc_no' },
    { label: t('type'), x: (d) => t('doc.' + d.doc_type), render: (d) => badge(t('doc.' + d.doc_type), 'info') },
    { label: t('date'), render: (d) => fmtDateTime(d.created_at) },
    { label: t('location'), render: locText },
    { label: t('details'), render: partyText },
    { label: t('lines'), num: true, key: 'lines' },
    { label: t('total'), num: true, x: (d) => d.total, render: (d) => (d.total != null ? fmtMoney(d.total) : '') },
    { label: t('user'), key: 'created_by_name' },
    { label: t('status'), x: (d) => t('ds.' + d.status), render: (d) => badge(t('ds.' + d.status), d.status === 'POSTED' ? 'ok' : 'bad') },
  ];

  const loadBtn = btn(t('show'), () => busy(loadBtn, load), 'primary');
  root.append(h('div', { class: 'toolbar' },
    field(t('type'), typeSel), field(t('date_from'), from), field(t('date_to'), to),
    loadBtn, btn(t('export_excel'), () => exportExcel('stock-documents', cols, rows))), box);

  async function load() {
    try {
      let qb = sb.from('v_stock_documents').select('*').gte('doc_date', from.value).lte('doc_date', to.value)
        .order('created_at', { ascending: false }).limit(500);
      if (typeSel.value) qb = qb.eq('doc_type', typeSel.value);
      rows = await q(qb);
      put(box, dataTable(cols, rows, { onRowClick: openDoc }));
    } catch (e) { toastError(e); }
  }

  async function openDoc(d) {
    const [table, fk] = ITEMS_TABLE[d.doc_type];
    let items;
    try { items = await q(sb.from(table).select('*').eq(fk, d.id).order('id')); }
    catch (e) { toastError(e); return; }

    const itemCols = [
      { label: t('material'), render: (i) => nm(material(i.material_id)) },
      { label: t('qty'), num: true, render: (i) => `${fmtNum(i.qty)} ${unitLabel(i.unit_id)}` },
      { label: t('base_qty'), num: true, render: (i) => `${fmtNum(i.qty_base)} ${unitLabel(material(i.material_id)?.base_unit_id)}` },
      ...(d.doc_type === 'PURCHASE' ? [
        { label: t('unit_cost'), num: true, render: (i) => fmtMoney(i.unit_cost) },
        { label: t('line_cost'), num: true, render: (i) => fmtMoney(i.line_total) }] : []),
    ];
    const meta = [
      [t('doc_no'), d.doc_no], [t('type'), t('doc.' + d.doc_type)], [t('date'), fmtDateTime(d.created_at)],
      [t('location'), locText(d)], [t('user'), d.created_by_name || ''], [t('status'), t('ds.' + d.status)],
      ...(partyText(d) ? [[t('details'), partyText(d)]] : []),
      ...(d.total != null ? [[t('total'), fmtMoney(d.total)]] : []),
      ...(d.notes ? [[t('notes'), d.notes]] : []),
    ];
    const table_ = dataTable(itemCols, items);
    const canReverse = d.status === 'POSTED' && can('inventory.adjust');
    const m = modal({
      title: `${t('doc.' + d.doc_type)} ${d.doc_no}`, wide: true,
      body: h('div', null, h('dl', { class: 'kv' }, meta.map(([k, v]) => [h('dt', null, k), h('dd', null, v)])), table_),
      actions: [
        btn(t('print'), () => printSheet({ title: `${t('doc.' + d.doc_type)} ${d.doc_no}`, meta, body: table_,
          signatures: [t('sig.created'), t('sig.received'), t('sig.approved')] })),
        canReverse ? btn(t('reverse_doc'), async () => {
          const c = await confirmDialog(t('reverse_confirm'), { danger: true, reason: true, okLabel: t('reverse_doc') });
          if (!c.ok) return;
          try {
            await rpc('reverse_stock_document', { p_doc_type: d.doc_type, p_doc_id: d.id, p_reason: c.reason });
            toast(t('reversed'), 'ok'); m.close(); await loadRefs(true); load();
          } catch (e) { toastError(e); }
        }, 'danger') : null,
        btn(t('close'), () => m.close()),
      ].filter(Boolean),
    });
  }

  await load();
}
