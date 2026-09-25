import { h, put, clear, btn, input, field, checkbox, modal, toast, toastError, busy, fmtMoney } from '../ui.js';
import { t } from '../i18n.js';
import { sb } from '../supabase.js';
import { q, rpc } from '../api.js';
import { can, session } from '../session.js';
import { refs, nm, usePrep, setting, cachedSWR } from '../store.js';
import { customerPicker, balanceBlock, printOrderReceipt, loadCustomer, personMeta } from '../sales.js';

const uuid = () => (crypto.randomUUID ? crypto.randomUUID()
  : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); }));

/**
 * Buffet screen: person → drink → quantity → record.
 * The person who drinks (consumer) and the account that pays (payer) are separate:
 * SELF = their own account, DEPT = their department's account, HOST = an employee they're a guest of, CASH = pays now.
 */
export async function posPage(root) {
  // Cash at the buffet can be switched off in Settings; reception/closing users always can.
  const canCash = can('payments.receive') && (setting('buffet_cash', true) === true || can('closing.perform'));
  // The menu is cached for the session (refreshed quietly after a minute), so the screen opens instantly
  const [[products, addons, links], hints] = await Promise.all([
    cachedSWR('pos:catalog', () => Promise.all([
      q(sb.from('products').select('*, product_variants(*)').eq('active', true).order('sort').order('id')),
      q(sb.from('addons').select('*').eq('active', true).order('sort')),
      q(sb.from('variant_addons').select('*')),
    ])),
    cachedSWR('pos:hints', () => rpc('pos_hints', { p_customer_id: null }).catch(() => ({ popular: [], recent_customers: [] })), { freshMs: 20000 }),
  ]);
  const addonsFor = (vid) => addons.filter((a) => links.some((l) => l.variant_id === vid && l.addon_id === a.id));
  // Most ordered first (last 30 days); the menu order breaks ties
  const pop = new Map((hints.popular || []).map((x) => [x.variant_id, Number(x.qty)]));
  const productPop = (p) => (p.product_variants || []).reduce((sum, v) => sum + (pop.get(v.id) || 0), 0);
  const catalog = products.map((p) => ({ ...p, pop: productPop(p), variants: (p.product_variants || []).filter((v) => v.active).sort((a, b) => a.sort - b.sort || a.id - b.id) }))
    .filter((p) => p.variants.length)
    .sort((a, b) => b.pop - a.pop);
  // Coffee-machine drinks: one open-price variant, entered with its own button (not in the grid)
  let machine = null;
  for (const p of catalog) { const v = p.variants.find((x) => x.open_price); if (v) { machine = { p, v }; break; } }
  if (machine) { const i = catalog.indexOf(machine.p); if (machine.p.variants.every((x) => x.open_price)) catalog.splice(i, 1); else machine.p.variants = machine.p.variants.filter((x) => !x.open_price); }
  const topIds = new Set(catalog.filter((p) => p.pop > 0).slice(0, 3).map((p) => p.id));
  const findVariant = (vid) => { for (const p of catalog) { const v = p.variants.find((x) => x.id === vid); if (v) return { p, v }; } return null; };

  // ---------- state ----------
  const st = {
    cart: [], person: null, walkin: false, guestName: '',
    payer: 'SELF', customer: null, host: null,
    payMode: 'ACCOUNT', cashRecv: '', extraMode: null, key: uuid(), cat: '',
  };
  const unitOf = (l) => (l.price != null ? Number(l.price) : Number(l.variant.price)) + l.addons.reduce((a, x) => a + Number(x.price), 0);
  const total = () => st.cart.reduce((s, l) => s + l.qty * unitOf(l), 0);
  const count = () => st.cart.reduce((s, l) => s + l.qty, 0);
  const cashOnly = () => st.walkin || st.payer === 'CASH';

  // ---------- catalog ----------
  const cats = refs.prodCats.filter((c) => c.active !== false && catalog.some((p) => p.category_id === c.id));
  const catBar = h('div', { class: 'chips', role: 'tablist' });
  const search = input({ type: 'search', placeholder: t('search_product') });
  const grid = h('div', { class: 'pos-grid' });

  function renderCats() {
    put(catBar, [['', t('all')], ...cats.map((c) => [String(c.id), nm(c)])].map(([id, label]) =>
      h('button', { type: 'button', class: 'chip' + (st.cat === id ? ' on' : ''), onclick: () => { st.cat = id; renderCats(); renderGrid(); } }, label)));
  }
  function renderGrid() {
    const s = search.value.trim().toLowerCase();
    const list = catalog.filter((p) => (!st.cat || String(p.category_id) === st.cat)
      && (!s || `${p.name_ar} ${p.name_en || ''} ${p.code}`.toLowerCase().includes(s)));
    put(grid, list.length ? list.map((p) => h('div', { class: 'pos-card' + (topIds.has(p.id) ? ' top' : '') },
      h('div', { class: 'pos-name' }, nm(p), topIds.has(p.id) ? h('span', { class: 'top-badge', title: t('most_ordered') }, '★') : null),
      h('div', { class: 'pos-variants' }, p.variants.map((v) => h('button', {
        type: 'button', class: 'pos-var', onclick: () => addToCart(p, v),
      }, p.variants.length > 1 || v.name_en !== 'Regular' ? h('span', null, nm(v)) : null, h('b', null, fmtMoney(v.price))))))) :
      h('div', { class: 'empty' }, t('no_products')));
  }
  search.oninput = renderGrid;

  function addToCart(p, v) {
    const same = st.cart.find((l) => l.variant.id === v.id && !l.addons.length && !l.notes);
    if (same) same.qty += 1; else st.cart.push({ id: uuid(), product: p, variant: v, qty: 1, addons: [], notes: '' });
    renderCart(); pulse(); navigator.vibrate?.(10);
  }

  // ---------- person (top of the screen) ----------
  const personBox = h('div', { class: 'pos-customer' });
  const payerBox = h('div', { class: 'payer-box' });
  const repeatBox = h('div', { class: 'repeat-box' });

  async function setPerson(r) {
    st.person = r; st.walkin = false; st.host = null; st.extraMode = null; st.cashRecv = ''; st.payMode = 'ACCOUNT';
    st.payer = r.customer_type === 'TRAINEE' && canCash ? 'CASH' : 'SELF';
    await applyPayer();
    renderAll();
    loadRepeat(r);
  }

  async function applyPayer() {
    const p = st.person;
    if (!p) { st.customer = null; return; }
    if (st.payer === 'SELF') st.customer = p;
    else if (st.payer === 'DEPT') {
      try { st.customer = await rpc('department_account', { p_department_id: p.department_id }); }
      catch (e) { toastError(e); st.payer = 'SELF'; st.customer = p; }
    } else if (st.payer === 'HOST') st.customer = st.host;
    else st.customer = null;                         // CASH
    st.cashRecv = ''; st.extraMode = null;
  }

  function renderPerson() {
    clear(personBox); clear(payerBox);
    if (st.person) {
      const c = st.person;
      personBox.append(h('div', { class: 'cust-card' },
        h('div', { class: 'grow' },
          h('a', { href: '#/reception?c=' + c.id, class: 'cust-link' }, h('b', null, c.full_name)),
          h('div', { class: 'muted small' }, personMeta(c)),
          balanceBlock(c.balance)),
        btn(t('change'), () => { st.person = null; st.customer = null; st.host = null; clear(repeatBox); renderAll(); }, 'sm')));
      renderPayer();
      return;
    }
    if (st.walkin) {
      const guestName = input({ placeholder: t('guest_name_ph'), value: st.guestName });
      guestName.oninput = () => { st.guestName = guestName.value; };
      personBox.append(h('div', { class: 'cust-card' },
        h('div', { class: 'grow' }, h('b', null, t('walkin_title')), h('div', { class: 'muted small' }, t('walkin_hint'))),
        btn(t('change'), () => { st.walkin = false; renderAll(); }, 'sm')),
        field(t('guest_name'), guestName));
      return;
    }
    const picker = customerPicker({ onPick: (r) => setPerson(r), placeholder: t('person_search_ph') });
    const recent = (hints.recent_customers || []).length
      ? h('div', { class: 'recent-cust' },
          h('span', { class: 'muted small' }, t('recent_customers')),
          h('div', { class: 'chips scroll' }, hints.recent_customers.map((r) => h('button', { type: 'button', class: 'chip', onclick: async () => {
            setPerson((await loadCustomer(r.id).catch(() => null)) || r);
          } }, r.full_name))))
      : null;
    const walkin = canCash ? btn(t('walkin_btn'), () => { st.walkin = true; st.person = null; st.customer = null; renderAll(); }, 'sm ghost') : null;
    personBox.append(picker.el, recent, walkin ? h('div', { class: 'walkin-row' }, walkin) : null);
  }

  function renderPayer() {
    const p = st.person;
    const opts = [
      ['SELF', t('payer.SELF')],
      p.department_id ? ['DEPT', t('payer.DEPT', { d: p.department_ar || '' })] : null,
      ['HOST', t('payer.HOST')],
      canCash ? ['CASH', t('payer.CASH')] : null,
    ].filter(Boolean);
    payerBox.append(
      h('div', { class: 'muted small payer-label' }, t('charge_to')),
      h('div', { class: 'seg payer-seg' }, opts.map(([k, label]) => h('button', {
        type: 'button', class: st.payer === k ? 'on' : '',
        onclick: async () => { st.payer = k; await applyPayer(); renderAll(); },
      }, label))));
    if (st.payer === 'HOST') {
      if (st.host) {
        payerBox.append(h('div', { class: 'host-chip' },
          h('span', null, t('host_is'), ' ', h('b', null, st.host.full_name), ' ', balanceBlock(st.host.balance)),
          btn(t('change'), () => { st.host = null; st.customer = null; renderAll(); }, 'sm')));
      } else {
        const hp = customerPicker({ onPick: (r) => { st.host = r; st.customer = r; renderAll(); }, placeholder: t('host_search_ph'), autofocus: true });
        payerBox.append(hp.el);
      }
    } else if (st.payer === 'DEPT' && st.customer) {
      payerBox.append(h('div', { class: 'host-chip' }, h('span', null, h('b', null, st.customer.full_name), ' ', balanceBlock(st.customer.balance))));
    }
  }

  async function loadRepeat(c) {
    clear(repeatBox);
    try {
      const r = await rpc('pos_hints', { p_customer_id: c.id });
      if (st.person?.id !== c.id || !r.last_order?.items?.length) return;
      const items = r.last_order.items.map((it) => ({ it, f: findVariant(it.variant_id) })).filter((x) => x.f);
      if (!items.length) return;
      const label = items.map(({ it, f }) => `${it.qty}× ${nm(f.p)}${f.p.variants.length > 1 ? ' ' + nm(f.v) : ''}`).join('، ');
      put(repeatBox, h('button', { type: 'button', class: 'repeat-btn', onclick: () => {
        for (const { it, f } of items) {
          const ads = (it.addons || []).map((id) => addons.find((a) => a.id === id)).filter(Boolean);
          st.cart.push({ id: uuid(), product: f.p, variant: f.v, qty: it.qty, addons: ads, notes: it.notes || '' });
        }
        renderCart(); pulse(); navigator.vibrate?.(15);
      } }, h('span', { class: 'rb-ico', 'aria-hidden': 'true' }, '↻'),
        h('span', null, h('b', null, t('repeat_last')), h('span', { class: 'muted small' }, label))));
    } catch (_) { /* hint only */ }
  }

  // ---------- cart ----------
  const lines = h('div', { class: 'cart-lines' });
  const payBox = h('div', { class: 'pos-pay' });
  const totalEl = h('div', { class: 'cart-total' });
  const submitBtn = btn(t('confirm_order'), () => busy(submitBtn, submit), 'primary big');
  const resultBox = h('div');
  const mobileBar = h('button', { type: 'button', class: 'pos-mobile-bar', onclick: () => cartPanel.scrollIntoView({ behavior: 'smooth' }) });

  function renderCart() {
    clear(lines);
    if (!st.cart.length) lines.append(h('div', { class: 'muted cart-empty' }, t('cart_empty')));
    for (const l of st.cart) {
      const unit = unitOf(l);
      const avail = l.machine ? [] : addonsFor(l.variant.id);
      lines.append(h('div', { class: 'cart-line' },
        h('div', { class: 'cl-main' },
          l.machine ? h('div', { class: 'cl-name' }, '☕ ', l.name, h('div', { class: 'muted small' }, t('machine_line_note')))
            : h('div', { class: 'cl-name' }, nm(l.product), l.product.variants.length > 1 ? ` — ${nm(l.variant)}` : ''),
          l.addons.length ? h('div', { class: 'muted small' }, '+ ' + l.addons.map(nm).join('، ')) : null,
          l.notes ? h('div', { class: 'muted small' }, l.notes) : null,
          h('div', { class: 'cl-tools' },
            l.machine ? btn(t('edit'), () => machineDialog(l), 'sm ghost') : btn(t('addons_notes'), () => editLine(l, avail), 'sm ghost'),
            h('span', { class: 'muted small' }, fmtMoney(unit)))),
        h('div', { class: 'stepper' },
          h('button', { type: 'button', 'aria-label': t('less'), onclick: () => { l.qty -= 1; if (l.qty <= 0) st.cart.splice(st.cart.indexOf(l), 1); renderCart(); } }, '−'),
          h('span', null, l.qty),
          h('button', { type: 'button', 'aria-label': t('more'), onclick: () => { l.qty += 1; renderCart(); } }, '+')),
        h('div', { class: 'cl-total num' }, fmtMoney(unit * l.qty))));
    }
    totalEl.replaceChildren(h('span', null, t('total')), h('b', null, fmtMoney(total())));
    mobileBar.textContent = `${st.person ? st.person.full_name + ' · ' : ''}${t('cart')} (${count()}) — ${fmtMoney(total())}`;
    mobileBar.hidden = !st.cart.length;
    renderPay();
  }

  // Remember recent machine drinks on this device for one-tap re-use
  const MKEY = 'cafeteria-machine-items';
  const recentMachine = () => { try { return JSON.parse(localStorage.getItem(MKEY) || '[]'); } catch (_) { return []; } };
  function rememberMachine(name, price) {
    const list = recentMachine().filter((x) => x.name !== name);
    list.unshift({ name, price });
    try { localStorage.setItem(MKEY, JSON.stringify(list.slice(0, 8))); } catch (_) {}
  }
  function machineDialog(line = null) {
    const name = input({ value: line?.name || '', placeholder: t('machine_name_ph') });
    const price = input({ type: 'number', value: line?.price ?? '', placeholder: '0' });
    const qty = input({ type: 'number', value: String(line?.qty || 1) });
    const recent = recentMachine();
    const chips = recent.length ? h('div', { class: 'chips' }, recent.map((x) => h('button', { type: 'button', class: 'chip',
      onclick: () => { name.value = x.name; price.value = String(x.price); price.focus(); } }, `${x.name} · ${fmtMoney(x.price)}`))) : null;
    const m = modal({
      title: '☕ ' + t('machine_title'),
      body: h('div', { style: { display: 'grid', gap: '10px' } },
        h('div', { class: 'alert info small' }, t('machine_hint')),
        chips, field(t('machine_name'), name),
        h('div', { class: 'grid-2' }, field(t('machine_price'), price), field(t('qty'), qty))),
      actions: [btn(t('cancel'), () => m.close()), btn(line ? t('save') : t('add'), () => {
        const n = name.value.trim(), pr = Number(price.value), q2 = Math.max(1, Math.round(Number(qty.value) || 1));
        if (!n) { name.focus(); return toast(t('machine_name_req'), 'warn'); }
        if (!(pr > 0)) { price.focus(); return toast(t('machine_price_req'), 'warn'); }
        rememberMachine(n, pr);
        if (line) Object.assign(line, { name: n, price: pr, qty: q2 });
        else st.cart.push({ id: uuid(), product: machine.p, variant: machine.v, qty: q2, addons: [], notes: '', machine: true, name: n, price: pr });
        m.close(); renderCart(); pulse();
      }, 'primary')],
    });
    setTimeout(() => (recent.length && !line ? price : name).focus(), 60);
  }

  function editLine(l, avail) {
    const boxes = avail.map((a) => { const c = checkbox(`${nm(a)}${Number(a.price) ? ' (+' + fmtMoney(a.price) + ')' : ''}`, l.addons.some((x) => x.id === a.id)); c.addon = a; return c; });
    const notes = input({ value: l.notes, placeholder: t('line_notes_ph') });
    const m = modal({
      title: `${nm(l.product)} — ${nm(l.variant)}`,
      body: h('div', { style: { display: 'grid', gap: '10px' } },
        boxes.length ? h('div', { class: 'addon-list' }, boxes) : h('div', { class: 'muted' }, t('no_addons_for_item')),
        field(t('notes'), notes)),
      actions: [btn(t('cancel'), () => m.close()), btn(t('save'), () => {
        l.addons = boxes.filter((b) => b.input.checked).map((b) => b.addon);
        l.notes = notes.value.trim();
        m.close(); renderCart();
      }, 'primary')],
    });
  }

  // ---------- payment ----------
  function received(tot) {
    if (st.cashRecv === '' || st.cashRecv == null) return (cashOnly() || st.payMode === 'CASH') ? tot : 0;
    return Math.max(Number(st.cashRecv) || 0, 0);
  }

  function renderPay() {
    clear(payBox);
    const tot = total();
    if (!st.person && !st.walkin) { payBox.append(h('div', { class: 'muted small' }, t('pick_person_first'))); return; }
    if (cashOnly()) {
      const recv = input({ type: 'number', value: st.cashRecv, placeholder: fmtMoney(tot) });
      const change = h('div', { class: 'muted' });
      const upd = () => { const c = received(tot) - tot; change.textContent = c > 0 ? `${t('change_due')}: ${fmtMoney(c)}` : ''; };
      recv.addEventListener('input', () => { st.cashRecv = recv.value; upd(); });
      upd();
      payBox.append(field(t('cash_received'), recv), change);
      return;
    }
    if (!st.customer) { payBox.append(h('div', { class: 'muted small' }, t('pick_host_first'))); return; }
    if (!canCash) {
      st.payMode = 'ACCOUNT';
      payBox.append(h('div', { class: 'small' }, `${t('from_account')}: ${fmtMoney(tot)} — ${t('balance_after')}: `, balanceBlock(Number(st.customer.balance) - tot)));
      return;
    }
    payBox.append(h('div', { class: 'seg' }, ['ACCOUNT', 'CASH', 'MIXED'].map((md) => h('button', {
      type: 'button', class: st.payMode === md ? 'on' : '', onclick: () => { st.payMode = md; st.cashRecv = ''; st.extraMode = null; renderPay(); },
    }, t('pay.' + md)))));
    if (st.payMode === 'ACCOUNT') {
      payBox.append(h('div', { class: 'small' }, `${t('from_account')}: ${fmtMoney(tot)} — ${t('balance_after')}: `, balanceBlock(Number(st.customer.balance) - tot)));
      return;
    }
    // CASH: default = the total; MIXED: default = 0 (the rest goes on the account).
    // Cash above the total can go to the payer's account (pays what they owe) or back as change.
    const recv = input({ type: 'number', value: st.cashRecv, placeholder: st.payMode === 'CASH' ? fmtMoney(tot) : '0' });
    const extraBox = h('div', { class: 'extra-box' });
    const drawExtra = () => {
      const r = received(tot);
      const extra = r - tot;
      const bal = Number(st.customer.balance);
      clear(extraBox);
      if (r < tot) {
        extraBox.append(h('div', { class: 'small' }, `${t('from_account')}: ${fmtMoney(tot - r)} — ${t('balance_after')}: `, balanceBlock(bal - (tot - r))));
        return;
      }
      if (extra <= 0) return;
      if (!st.extraMode) st.extraMode = bal < 0 ? 'ACCOUNT' : 'CHANGE';
      extraBox.append(
        h('div', { class: 'muted small' }, t('extra_cash', { v: fmtMoney(extra) })),
        h('div', { class: 'seg sm' }, ['ACCOUNT', 'CHANGE'].map((md) => h('button', {
          type: 'button', class: st.extraMode === md ? 'on' : '', onclick: () => { st.extraMode = md; drawExtra(); },
        }, t('extra.' + md)))));
      if (st.extraMode === 'ACCOUNT') {
        const pays = bal < 0 ? Math.min(extra, -bal) : 0;
        extraBox.append(h('div', { class: 'small' },
          pays > 0 ? t('extra_pays_debt', { v: fmtMoney(pays) }) + ' — ' : '',
          `${t('balance_after')}: `, balanceBlock(bal + extra)));
      } else extraBox.append(h('div', { class: 'small' }, `${t('change_due')}: ${fmtMoney(extra)}`));
    };
    recv.addEventListener('input', () => { st.cashRecv = recv.value; drawExtra(); });
    payBox.append(field(st.payMode === 'CASH' ? t('cash_received') : t('cash_part'), recv), extraBox);
    drawExtra();
  }

  function pulse() { mobileBar.classList.remove('pulse'); void mobileBar.offsetWidth; mobileBar.classList.add('pulse'); }

  async function submit() {
    if (!st.cart.length) { toast(t('cart_empty'), 'warn'); return; }
    if (!st.person && !st.walkin) { toast(t('pick_person_first'), 'warn'); return; }
    if (!cashOnly() && !st.customer) { toast(t('pick_host_first'), 'warn'); return; }
    const tot = total();
    let cash = 0;
    if (cashOnly()) {
      cash = received(tot);
      if (cash < tot) { toast(t('cash_not_enough'), 'warn'); return; }
    } else if (canCash && st.payMode !== 'ACCOUNT') cash = received(tot);
    const extraToAccount = !cashOnly() && st.payMode !== 'ACCOUNT' && cash > tot && st.extraMode === 'ACCOUNT';

    const items = st.cart.map((l) => ({ variant_id: l.variant.id, qty: l.qty, addons: l.addons.map((a) => a.id), notes: l.notes || null,
      ...(l.machine ? { price: Number(l.price), name: l.name } : {}) }));
    try {
      const res = await rpc('create_order', {
        p_items: items,
        p_customer_id: cashOnly() ? null : st.customer.id,
        p_guest_name: st.walkin ? (st.guestName.trim() || null) : null,
        p_cash: cash, p_notes: null, p_idempotency_key: st.key, p_extra_to_account: extraToAccount,
        p_consumer_id: st.person?.id ?? null,
      });
      const change = (cashOnly() || (st.payMode !== 'ACCOUNT' && !extraToAccount)) ? Math.max(cash - tot, 0) : 0;
      const who = st.person ? st.person.full_name : (st.guestName.trim() || t('guest'));
      const payerNote = st.person && st.customer && st.customer.id !== st.person.id ? ` — ${t('charged_to', { n: st.customer.full_name })}` : '';
      toast(t('order_created', { no: res.order_no }), 'ok', 5000);
      put(resultBox, h('div', { class: 'alert ok-soft' },
        h('b', null, `${t('order_created', { no: res.order_no })} · ${who}`),
        h('div', null, `${t('total')}: ${fmtMoney(res.total)}${payerNote}`
          + (Number(res.cash) ? ` — ${t('cash')}: ${fmtMoney(res.cash)}` : '')
          + (Number(res.account) ? ` — ${t('from_account')}: ${fmtMoney(res.account)}` : '')
          + (Number(res.deposit) ? ` — ${t('extra_deposited', { v: fmtMoney(res.deposit) })}` : '')
          + (Number(res.machine) ? ` — ${t('machine_paid', { v: fmtMoney(res.machine) })}` : '')
          + (change > 0 ? ` — ${t('change_due')}: ${fmtMoney(change)}` : '')),
        res.balance != null ? h('div', null, balanceBlock(res.balance)) : null,
        res.warnings?.length ? h('div', { class: 'small', style: { marginTop: '6px' } }, t('negative_warning'), ' ', res.warnings.map((w) => nm(w)).join('، ')) : null,
        h('div', { class: 'row', style: { marginTop: '10px', gap: '8px' } },
          !usePrep() && can('orders.update_status') ? servedBtn(res.order_id) : null,
          btn(t('print_receipt'), () => printOrderReceipt(res.order_id), 'sm'))));
      navigator.vibrate?.(25);
      if (!usePrep() && setting('serve_on_create', false) === true && can('orders.update_status')) resultBox.querySelector('.served-btn')?.click();
      Object.assign(st, { cart: [], cashRecv: '', extraMode: null, key: uuid(), guestName: '', person: null, walkin: false,
                          customer: null, host: null, payer: 'SELF', payMode: 'ACCOUNT' });
      clear(repeatBox);
      renderAll();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (e) { toastError(e); }
  }

  function servedBtn(orderId) {
    const b = btn('✓ ' + t('mark_served'), async () => {
      b.disabled = true;
      try { await rpc('set_order_status', { p_order_id: orderId, p_status: 'SERVED' }); b.textContent = '✓ ' + t('served_done'); b.classList.remove('primary'); navigator.vibrate?.(15); }
      catch (e) { b.disabled = false; toastError(e); }
    }, 'primary served-btn');
    return b;
  }

  function renderAll() { renderPerson(); renderCart(); }

  const personPanel = h('section', { class: 'panel pos-person' },
    h('h2', null, t('who_drinks')), personBox, payerBox, repeatBox, resultBox);
  const cartPanel = h('aside', { class: 'pos-cart panel' },
    h('h2', null, t('cart')), lines, totalEl,
    h('h2', { style: { marginTop: '16px' } }, t('payment')), payBox,
    h('div', { class: 'form-actions' }, btn(t('clear'), () => { st.cart = []; renderCart(); }), submitBtn));

  root.append(personPanel,
    h('div', { class: 'pos' },
      h('section', { class: 'pos-catalog' },
        h('div', { class: 'toolbar' }, h('div', { class: 'grow' }, search),
          machine ? btn('☕ ' + t('machine_btn'), () => machineDialog(), 'machine-btn') : null),
        catBar, grid),
      cartPanel),
    mobileBar);

  renderCats(); renderGrid();
  if (session.posCustomer) { const c = session.posCustomer; session.posCustomer = null; await setPerson(c); }
  else renderAll();
}
