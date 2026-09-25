import { t, lang } from './i18n.js';

// ---------- DOM ----------
const PROPS = new Set(['value', 'checked', 'disabled', 'selected', 'multiple', 'readOnly', 'indeterminate']);

export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'html') el.innerHTML = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (PROPS.has(k)) el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  append(el, kids);
  return el;
}
function append(el, kids) {
  for (const k of kids) {
    if (k == null || k === false) continue;
    if (Array.isArray(k)) append(el, k);
    else if (k instanceof Node) el.append(k);
    else if (k !== '') el.append(document.createTextNode(String(k)));
  }
}
export const clear = (el) => { el.replaceChildren(); return el; };
/** Replace children; null/false/arrays handled like h() */
export const put = (el, ...kids) => { el.replaceChildren(); append(el, kids); return el; };

// ---------- Formatting (Latin digits in both languages) ----------
const locale = () => (lang() === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB');
const TZ = 'Africa/Cairo';
export const fmtNum = (n, d = 3) =>
  n == null || n === '' ? '' : Number(n).toLocaleString(locale(), { maximumFractionDigits: d });
export const fmtMoney = (n) =>
  n == null || n === '' ? '' :
  Number(n).toLocaleString(locale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ' + t('egp');
export const fmtDate = (d) =>
  !d ? '' : new Date(d.length === 10 ? d + 'T12:00:00' : d)
    .toLocaleDateString(locale(), { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
export const fmtDateTime = (d) =>
  !d ? '' : new Date(d).toLocaleString(locale(), {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
export const todayISO = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ });
export const daysAgoISO = (n) => new Date(Date.now() - n * 864e5).toLocaleDateString('en-CA', { timeZone: TZ });

// ---------- Controls ----------
export const btn = (label, onclick, variant = '', extra = {}) =>
  h('button', { class: 'btn ' + variant, type: 'button', onclick, ...extra }, label);

// Arabic-Indic / Persian digits and Arabic decimal marks → Latin
export const latinNum = (v) => String(v ?? '')
  .replace(/[\u0660-\u0669\u06F0-\u06F9]/g, (d) => String((d.charCodeAt(0) & 0xF) % 10))
  .replace(/[\u066B,\u060C]/g, '.');

/** Number fields are text fields with a numeric keyboard: <input type=number> silently
 *  drops Arabic digits (value becomes ''), so we accept them and convert on the fly. */
export const input = (props = {}) => {
  if (props.type !== 'number') return h('input', { class: 'input', ...props });
  const { type, step, min, max, ...rest } = props;
  const el = h('input', { class: 'input num', type: 'text', inputmode: 'decimal', autocomplete: 'off', dir: 'ltr', ...rest });
  if (el.value) el.value = latinNum(el.value);
  el.addEventListener('input', () => {
    const v = latinNum(el.value).replace(/[^0-9.\-]/g, '');
    if (v !== el.value) el.value = v;
  });
  return el;
};

export function select(options, value, props = {}) {
  const el = h('select', { class: 'input', ...props },
    options.map(([v, l]) => h('option', { value: v ?? '' }, l)));
  if (value != null) el.value = String(value);
  return el;
}

export const field = (label, control, cls = '') =>
  h('label', { class: 'field ' + cls }, h('span', { class: 'field-label' }, label), control);

export const checkbox = (label, checked) => {
  const box = h('input', { type: 'checkbox', checked: !!checked });
  const el = h('label', { class: 'check' }, box, label);
  el.input = box;
  return el;
};

export const badge = (text, kind = '') => h('span', { class: 'badge ' + kind }, text);

export async function busy(button, fn) {
  if (button) button.disabled = true;
  try { return await fn(); }
  finally { if (button) button.disabled = false; }
}

// ---------- Toast ----------
export function toast(msg, kind = '', ms = 4000) {
  let box = document.getElementById('toasts');
  if (!box) { box = h('div', { id: 'toasts', role: 'status', 'aria-live': 'polite' }); document.body.append(box); }
  const el = h('div', { class: 'toast ' + kind }, msg);
  box.append(el);
  setTimeout(() => el.remove(), ms);
}
export const toastError = (e) => toast(e?.message || String(e), 'bad', 6000);

// ---------- Modal ----------
export function modal({ title, body, actions = [], wide = false, onClose }) {
  const backdrop = h('div', { class: 'modal-backdrop' });
  const dlg = h('div', { class: 'modal' + (wide ? ' modal-wide' : ''), role: 'dialog', 'aria-modal': 'true' },
    h('header', { class: 'modal-head' },
      h('h2', null, title),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': t('close'), onclick: () => close() }, '✕')),
    h('div', { class: 'modal-body' }, body),
    actions.length ? h('footer', { class: 'modal-foot' }, actions) : null);
  backdrop.append(dlg);
  document.body.append(backdrop);
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) close(); });
  setTimeout(() => dlg.querySelector('.modal-body input, .modal-body select, .modal-body textarea')?.focus(), 40);
  function close() {
    document.removeEventListener('keydown', onKey);
    backdrop.remove();
    onClose && onClose();
  }
  return { close, el: dlg };
}

/** Resolves to { ok:true, reason } or { ok:false } */
export function confirmDialog(message, { title = t('confirm'), okLabel = t('confirm'), danger = false, reason = false } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const reasonIn = reason ? h('textarea', { class: 'input', placeholder: t('reason_required') }) : null;
    const okBtn = btn(okLabel, () => {
      const r = reasonIn ? reasonIn.value.trim() : '';
      if (reasonIn && !r) { reasonIn.focus(); toast(t('reason_required'), 'warn'); return; }
      done = true; m.close(); resolve({ ok: true, reason: r });
    }, danger ? 'danger' : 'primary');
    const m = modal({
      title,
      body: h('div', null, h('p', { style: { marginTop: 0 } }, message), reasonIn ? field(t('reason'), reasonIn) : null),
      actions: [btn(t('cancel'), () => m.close()), okBtn],
      onClose: () => { if (!done) resolve({ ok: false }); },
    });
  });
}

// ---------- Tables ----------
/** columns: [{ key, label, render?(row), num?, x?(row) for export }] */
export function dataTable(columns, rows, { empty, onRowClick, rowClass, noCards = false } = {}) {
  if (!rows.length) return h('div', { class: 'empty' }, empty || t('no_data'));
  return h('div', { class: 'table-wrap' },
    h('table', { class: 'tbl' + (noCards ? '' : ' tbl-cards') },
      h('thead', null, h('tr', null, columns.map((c) => h('th', { class: c.num ? 'num' : '' }, c.label)))),
      h('tbody', null, rows.map((r) =>
        h('tr', {
          class: [onRowClick ? 'clickable' : '', rowClass ? rowClass(r) : ''].join(' ').trim() || null,
          onclick: onRowClick ? () => onRowClick(r) : null,
        }, columns.map((c) => h('td', { class: c.num ? 'num' : '', 'data-label': typeof c.label === 'string' ? c.label : '' }, c.render ? c.render(r) : r[c.key])))))));
}

const textOf = (v) => (v instanceof Node ? v.textContent : v);

export function exportExcel(filename, columns, rows) {
  if (!window.XLSX) { toast(t('err.EXCEL_LIB'), 'bad'); return; }
  const data = rows.map((r) => Object.fromEntries(columns.map((c) =>
    [c.label, c.x ? c.x(r) : textOf(c.render ? c.render(r) : r[c.key])])));
  const ws = XLSX.utils.json_to_sheet(data);
  if (lang() === 'ar') ws['!views'] = [{ RTL: true }];
  const wb = XLSX.utils.book_new();
  wb.Workbook = { Views: [{ RTL: lang() === 'ar' }] };
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  XLSX.writeFile(wb, `${filename}-${todayISO()}.xlsx`);
}

// ---------- Print (A4 with both logos) ----------
export function printSheet({ title, meta = [], body, signatures = [] }) {
  let area = document.getElementById('print-area');
  if (!area) { area = h('div', { id: 'print-area' }); document.body.append(area); }
  put(area,
    h('div', { class: 'print-head' },
      h('img', { src: 'assets/img/minapharm.png', alt: 'Minapharm' }),
      h('div', { class: 'print-title' }, h('h1', null, title), h('div', null, fmtDateTime(new Date()))),
      h('img', { src: 'assets/img/migentra.png', alt: 'Migentra' })),
    meta.length ? h('div', { class: 'print-meta' }, meta.map(([k, v]) => h('div', null, h('b', null, k + ': '), v))) : null,
    body instanceof Node ? body.cloneNode(true) : body,
    signatures.length ? h('div', { class: 'print-foot' }, signatures.map((s) => h('div', null, s))) : null);
  const imgs = [...area.querySelectorAll('img')];
  Promise.all(imgs.map((i) => (i.complete ? 1 : new Promise((r) => { i.onload = i.onerror = r; }))))
    .then(() => window.print());
}
