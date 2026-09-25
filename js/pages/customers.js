import { h, put, btn, input, select, field, dataTable, badge, modal, toast, toastError, busy, fmtMoney, exportExcel, loadXLSX } from '../ui.js';
import { t, lang } from '../i18n.js';
import { sb } from '../supabase.js';
import { q, rpc, errText } from '../api.js';
import { can } from '../session.js';
import { balanceBlock, openLedger, openConsumption } from '../sales.js';

const TYPES = ['EMPLOYEE', 'VISITOR', 'TRAINEE', 'CONTRACTOR', 'OTHER'];
const STATUSES = ['ACTIVE', 'SUSPENDED', 'CLOSED'];

export async function customersPage(root) {
  const canManage = can('customers.manage');
  let depts = [], rows = [];
  const search = input({ type: 'search', placeholder: t('customer_search_ph') });
  const deptSel = select([['', t('all_departments')]], '');
  const statusSel = select([['', t('all')], ...STATUSES.map((s) => [s, t('cs.' + s)])], 'ACTIVE');
  const box = h('div');
  const sum = h('div', { class: 'muted', style: { marginBottom: '10px' } });

  const deptName = (id) => { const d = depts.find((x) => x.id === id); return d ? (lang() === 'en' && d.name_en ? d.name_en : d.name_ar) : ''; };
  const cols = [
    { label: t('code'), key: 'code' },
    { label: t('name'), render: (r) => (can('accounts.deposit') || can('payments.receive') ? h('a', { href: '#/reception?c=' + r.id, class: 'cust-link' }, r.full_name) : r.full_name) },
    { label: t('department'), render: (r) => deptName(r.department_id) },
    { label: t('type'), render: (r) => t('ct.' + r.customer_type), x: (r) => t('ct.' + r.customer_type) },
    { label: t('balance'), num: true, render: (r) => balanceBlock(r.balance), x: (r) => Number(r.balance) },
    { label: t('unpaid_orders'), num: true, render: (r) => (Number(r.unpaid_amount) ? fmtMoney(r.unpaid_amount) : ''), x: (r) => Number(r.unpaid_amount) },
    { label: t('status'), render: (r) => badge(t('cs.' + r.status), r.status === 'ACTIVE' ? 'ok' : 'bad'), x: (r) => t('cs.' + r.status) },
    { label: '', render: (r) => h('div', { class: 'row-actions' },
        canManage ? btn(t('edit'), () => form(r), 'sm') : null,
        can('accounts.view') ? btn(t('ledger'), () => openLedger(r), 'sm') : null,
        can('orders.view') ? btn(t('consumption_short'), () => openConsumption(r), 'sm') : null) },
  ];

  root.append(h('div', { class: 'toolbar' },
    h('div', { class: 'grow' }, field(t('search'), search)), field(t('department'), deptSel), field(t('status'), statusSel),
    btn(t('export_excel'), () => exportExcel('customers', cols.slice(0, -1), filtered())),
    canManage ? btn(t('import_excel'), importFlow) : null,
    canManage ? btn('+ ' + t('new_customer'), () => form(null), 'primary') : null), sum, box);
  search.oninput = render; deptSel.onchange = render; statusSel.onchange = render;

  function filtered() {
    const s = search.value.trim().toLowerCase();
    return rows.filter((r) => (!statusSel.value || r.status === statusSel.value)
      && (!deptSel.value || r.department_id === Number(deptSel.value))
      && (!s || `${r.code} ${r.full_name} ${r.phone || ''}`.toLowerCase().includes(s)));
  }
  function render() {
    const list = filtered();
    const due = list.reduce((s, r) => s + Math.max(-Number(r.balance), 0), 0);
    const pre = list.reduce((s, r) => s + Math.max(Number(r.balance), 0), 0);
    sum.textContent = `${t('customers')}: ${list.length} — ${t('total_prepaid')}: ${fmtMoney(pre)} — ${t('total_due')}: ${fmtMoney(due)}`;
    put(box, dataTable(cols, list, { empty: t('no_customers'), rowClass: (r) => (r.status !== 'ACTIVE' ? 'row-muted' : '') }));
  }
  async function load() {
    try {
      [depts, rows] = await Promise.all([
        q(sb.from('departments').select('*').order('name_ar')),
        q(sb.from('v_customer_summary').select('*').order('full_name').limit(5000)),
      ]);
      const keep = deptSel.value;
      put(deptSel, h('option', { value: '' }, t('all_departments')), depts.map((d) => h('option', { value: d.id }, deptName(d.id))));
      deptSel.value = keep;
      render();
    } catch (e) { toastError(e); }
  }

  function form(r) {
    const isNew = !r;
    const code = input({ value: r?.code ?? '', disabled: !isNew, dir: 'ltr' });
    const name = input({ value: r?.full_name ?? '' });
    const type = select(TYPES.map((x) => [x, t('ct.' + x)]), r?.customer_type ?? 'EMPLOYEE');
    const dept = select([['', '—'], ...depts.filter((d) => d.active || d.id === r?.department_id).map((d) => [d.id, deptName(d.id)])], r?.department_id ?? '');
    const phone = input({ value: r?.phone ?? '', dir: 'ltr', inputmode: 'tel' });
    const company = input({ value: r?.company ?? '', placeholder: t('company_ph') });
    const limit = input({ type: 'number', step: '0.01', min: '0', value: r?.credit_limit ?? '', placeholder: t('credit_limit_ph') });
    const status = select(STATUSES.map((x) => [x, t('cs.' + x)]), r?.status ?? 'ACTIVE');
    const notes = h('textarea', { class: 'input', rows: 2 }, r?.notes ?? '');
    const opening = isNew && can('accounts.adjust') ? input({ type: 'number', step: '0.01', placeholder: '0' }) : null;
    const saveBtn = btn(t('save'), () => busy(saveBtn, async () => {
      if (!code.value.trim() || !name.value.trim()) { toast(t('required_fields'), 'warn'); return; }
      const v = { full_name: name.value.trim(), customer_type: type.value, department_id: dept.value ? Number(dept.value) : null,
        phone: phone.value.trim() || null, credit_limit: limit.value === '' ? null : Number(limit.value), status: status.value,
        notes: notes.value.trim() || null, company: company.value.trim() || null };
      try {
        if (isNew) {
          const [c] = await q(sb.from('customers').insert({ ...v, code: code.value.trim() }).select());
          if (opening && Number(opening.value)) {
            await rpc('account_adjust', { p_customer_id: c.id, p_amount: Number(opening.value), p_reason: t('opening_balance'), p_type: 'OPENING' });
          }
        } else await q(sb.from('customers').update(v).eq('id', r.id));
        toast(t('saved'), 'ok'); m.close(); load();
      } catch (e) { toastError(e); }
    }), 'primary');
    const m = modal({
      title: isNew ? t('new_customer') : `${t('edit')}: ${r.full_name}`,
      body: h('div', { class: 'form-grid' },
        field(t('employee_code') + ' *', code), field(t('name') + ' *', name), field(t('type'), type), field(t('department'), dept),
        field(t('phone'), phone), field(t('company'), company), field(t('credit_limit'), limit), field(t('status'), status),
        opening ? field(t('opening_balance'), opening) : null,
        field(t('notes'), notes, 'span-all'),
        h('p', { class: 'muted small span-all', style: { margin: 0 } }, t('credit_limit_hint'))),
      actions: [btn(t('cancel'), () => m.close()), saveBtn],
    });
  }

  function importFlow() {
    const file = input({ type: 'file', accept: '.xlsx,.xls,.csv' });
    const preview = h('div');
    let parsed = [];
    file.onchange = async () => {
      try { await loadXLSX(); } catch (_) { toast(t('err.EXCEL_LIB'), 'bad'); return; }
      const f = file.files[0]; if (!f) return;
      const wb = XLSX.read(await f.arrayBuffer());
      const sheet = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
      const pick = (row, keys) => { for (const k of Object.keys(row)) if (keys.includes(String(k).trim().toLowerCase())) return String(row[k]).trim(); return ''; };
      parsed = sheet.map((row) => ({
        code: pick(row, ['code', 'الكود', 'كود', 'employee id', 'id', 'رقم الموظف']),
        name: pick(row, ['name', 'الاسم', 'اسم', 'full name', 'اسم الموظف']),
        dept: pick(row, ['department', 'القسم', 'الإدارة', 'dept']),
        phone: pick(row, ['phone', 'الموبايل', 'التليفون', 'mobile']),
        opening: Number(pick(row, ['opening', 'balance', 'الرصيد', 'رصيد افتتاحي']) || 0),
      })).filter((x) => x.code && x.name);
      const existing = new Set(rows.map((r) => r.code));
      const fresh = parsed.filter((x) => !existing.has(x.code));
      put(preview, h('div', { class: 'alert info' }, t('import_preview', { total: parsed.length, fresh: fresh.length, skip: parsed.length - fresh.length })),
        dataTable([{ label: t('code'), key: 'code' }, { label: t('name'), key: 'name' }, { label: t('department'), key: 'dept' },
          { label: t('opening_balance'), num: true, render: (x) => (x.opening ? fmtMoney(x.opening) : '') }], fresh.slice(0, 50)));
      parsed = fresh;
    };
    const goBtn = btn(t('import'), () => busy(goBtn, async () => {
      if (!parsed.length) { toast(t('nothing_to_import'), 'warn'); return; }
      try {
        const names = [...new Set(parsed.map((x) => x.dept).filter(Boolean))].filter((n) => !depts.some((d) => d.name_ar === n || d.name_en === n));
        if (names.length) await q(sb.from('departments').insert(names.map((n) => ({ name_ar: n }))));
        const all = await q(sb.from('departments').select('*'));
        const did = (n) => all.find((d) => d.name_ar === n || d.name_en === n)?.id ?? null;
        let done = 0, fail = 0;
        for (let i = 0; i < parsed.length; i += 200) {
          const chunk = parsed.slice(i, i + 200);
          const inserted = await q(sb.from('customers').insert(chunk.map((x) => ({ code: x.code, full_name: x.name, department_id: did(x.dept), phone: x.phone || null }))).select('id, code'));
          done += inserted.length;
          if (can('accounts.adjust')) {
            for (const x of chunk.filter((y) => y.opening)) {
              const c = inserted.find((y) => y.code === x.code);
              try { await rpc('account_adjust', { p_customer_id: c.id, p_amount: x.opening, p_reason: t('opening_balance'), p_type: 'OPENING' }); }
              catch { fail += 1; }
            }
          }
        }
        toast(t('import_done', { n: done }) + (fail ? ` — ${t('import_fail_balances', { n: fail })}` : ''), fail ? 'warn' : 'ok', 7000);
        m.close(); load();
      } catch (e) { toast(errText(e), 'bad', 7000); }
    }), 'primary');
    const m = modal({
      title: t('import_excel'), wide: true,
      body: h('div', { style: { display: 'grid', gap: '12px' } }, h('div', { class: 'alert info' }, t('import_hint')), file, preview),
      actions: [btn(t('cancel'), () => m.close()), goBtn],
    });
  }

  await load();
}
