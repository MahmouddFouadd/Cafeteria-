import { h, put, clear, btn, input, field, checkbox, modal, toast, toastError, busy, fmtMoney } from '../ui.js';
import { t } from '../i18n.js';
import { sb } from '../supabase.js';
import { q, rpc } from '../api.js';
import { can, session } from '../session.js';
import { refs, nm } from '../store.js';
import { customerPicker, balanceBlock, printOrderReceipt } from '../sales.js';

const uuid = () => (crypto.randomUUID ? crypto.randomUUID()
  : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); }));

export async function posPage(root) {
  const canCash = can('payments.receive');
  const [products, addons, links] = await Promise.all([
    q(sb.from('products').select('*, product_variants(*)').eq('active', true).order('sort').order('id')),
    q(sb.from('addons').select('*').eq('active', true).order('sort')),
    q(sb.from('variant_addons').select('*')),
  ]);
  const addonsFor = (vid) => addons.filter((a) => links.some((l) => l.variant_id === vid && l.addon_id === a.id));
  const catalog = products.map((p) => ({ ...p, variants: (p.product_variants || []).filter((v) => v.active).sort((a, b) => a.sort - b.sort || a.id - b.id) }))
    .filter((p) => p.variants.length);

  // ---------- state ----------
  const st = { cart: [], customer: null, guest: false, guestName: '', payMode: 'ACCOUNT', cashIn: '', cashRecv: '', extraMode: null, key: uuid(), cat: '' };
  if (session.posCustomer) { st.customer = session.posCustomer; session.posCustomer = null; }
  if (!canCash) st.payMode = 'ACCOUNT';

  const total = () => st.cart.reduce((s, l) => s + l.qty * (Number(l.variant.price) + l.addons.reduce((a, x) => a + Number(x.price), 0)), 0);
  const count = () => st.cart.reduce((s, l) => s + l.qty, 0);

  // ---------- catalog side ----------
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
    put(grid, list.length ? list.map((p) => h('div', { class: 'pos-card' },
      h('div', { class: 'pos-name' }, nm(p)),
      h('div', { class: 'pos-variants' }, p.variants.map((v) => h('button', {
        type: 'button', class: 'pos-var', onclick: () => addToCart(p, v),
      }, p.variants.length > 1 || v.name_en !== 'Regular' ? h('span', null, nm(v)) : null, h('b', null, fmtMoney(v.price))))))) :
      h('div', { class: 'empty' }, t('no_products')));
  }
  search.oninput = renderGrid;

  function addToCart(p, v) {
    const same = st.cart.find((l) => l.variant.id === v.id && !l.addons.length && !l.notes);
    if (same) same.qty += 1; else st.cart.push({ id: uuid(), product: p, variant: v, qty: 1, addons: [], notes: '' });
    renderCart(); pulse();
  }

  // ---------- cart side ----------
  const custBox = h('div', { class: 'pos-customer' });
  const lines = h('div', { class: 'cart-lines' });
  const payBox = h('div', { class: 'pos-pay' });
  const totalEl = h('div', { class: 'cart-total' });
  const submitBtn = btn(t('confirm_order'), () => busy(submitBtn, submit), 'primary big');
  const resultBox = h('div');
  const mobileBar = h('button', { type: 'button', class: 'pos-mobile-bar', onclick: () => cartPanel.scrollIntoView({ behavior: 'smooth' }) });

  function renderCustomer() {
    clear(custBox);
    if (st.customer) {
      const c = st.customer;
      custBox.append(h('div', { class: 'cust-card' },
        h('div', { class: 'grow' }, h('b', null, c.full_name), h('div', { class: 'muted small' }, `${c.code}${c.department_ar ? ' · ' + c.department_ar : ''}`), balanceBlock(c.balance)),
        btn(t('change'), () => { st.customer = null; renderAll(); }, 'sm')));
      return;
    }
    const picker = customerPicker({ onPick: (r) => { st.customer = r; st.guest = false; st.extraMode = null; renderAll(); } });
    const guestToggle = canCash ? checkbox(t('quick_cash'), st.guest) : null;
    const guestName = input({ placeholder: t('guest_name_ph'), value: st.guestName });
    guestName.oninput = () => { st.guestName = guestName.value; };
    if (guestToggle) guestToggle.input.onchange = () => { st.guest = guestToggle.input.checked; if (st.guest) { st.payMode = 'CASH'; } renderAll(); };
    custBox.append(...[st.guest ? null : picker.el, guestToggle, st.guest ? field(t('guest_name'), guestName) : null].filter(Boolean));
  }

  function renderCart() {
    clear(lines);
    if (!st.cart.length) lines.append(h('div', { class: 'muted cart-empty' }, t('cart_empty')));
    for (const l of st.cart) {
      const unit = Number(l.variant.price) + l.addons.reduce((a, x) => a + Number(x.price), 0);
      const avail = addonsFor(l.variant.id);
      lines.append(h('div', { class: 'cart-line' },
        h('div', { class: 'cl-main' },
          h('div', { class: 'cl-name' }, nm(l.product), l.product.variants.length > 1 ? ` — ${nm(l.variant)}` : ''),
          l.addons.length ? h('div', { class: 'muted small' }, '+ ' + l.addons.map(nm).join('، ')) : null,
          l.notes ? h('div', { class: 'muted small' }, l.notes) : null,
          h('div', { class: 'cl-tools' },
            btn(t('addons_notes'), () => editLine(l, avail), 'sm ghost'),
            h('span', { class: 'muted small' }, fmtMoney(unit)))),
        h('div', { class: 'stepper' },
          h('button', { type: 'button', 'aria-label': t('less'), onclick: () => { l.qty -= 1; if (l.qty <= 0) st.cart.splice(st.cart.indexOf(l), 1); renderCart(); } }, '−'),
          h('span', null, l.qty),
          h('button', { type: 'button', 'aria-label': t('more'), onclick: () => { l.qty += 1; renderCart(); } }, '+')),
        h('div', { class: 'cl-total num' }, fmtMoney(unit * l.qty))));
    }
    totalEl.replaceChildren(h('span', null, t('total')), h('b', null, fmtMoney(total())));
    mobileBar.textContent = `${t('cart')} (${count()}) — ${fmtMoney(total())}`;
    mobileBar.hidden = !st.cart.length;
    renderPay();
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

  function renderPay() {
    clear(payBox);
    const tot = total();
    if (!st.customer && !st.guest) {
      payBox.append(h('div', { class: 'muted small' }, canCash ? t('pick_customer_or_cash') : t('pick_customer')));
      return;
    }
    if (st.guest) {
      const cashIn = input({ type: 'number', step: '0.01', min: '0', inputmode: 'decimal', value: st.cashIn, placeholder: fmtMoney(tot) });
      const change = h('div', { class: 'muted' });
      const upd = () => { st.cashIn = cashIn.value; const c = Number(cashIn.value || tot) - tot; change.textContent = c > 0 ? `${t('change_due')}: ${fmtMoney(c)}` : ''; };
      cashIn.oninput = upd; upd();
      payBox.append(field(t('cash_received'), cashIn), change);
      return;
    }
    const modes = canCash ? ['ACCOUNT', 'CASH', 'MIXED'] : ['ACCOUNT'];
    payBox.append(h('div', { class: 'seg' }, modes.map((md) => h('button', {
      type: 'button', class: st.payMode === md ? 'on' : '', onclick: () => { st.payMode = md; renderPay(); },
    }, t('pay.' + md)))));
    let cashPart = st.payMode === 'CASH' ? tot : 0;
    if (st.payMode === 'CASH') {
      // Amount actually handed over; anything above the total can go to the employee's account
      const recv = input({ type: 'number', step: '0.01', min: '0', inputmode: 'decimal', value: st.cashRecv, placeholder: fmtMoney(tot) });
      const extraBox = h('div', { class: 'extra-box' });
      const drawExtra = () => {
        const r = st.cashRecv === '' ? tot : Number(st.cashRecv) || 0;
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
          const nb = bal + extra;
          const pays = bal < 0 ? Math.min(extra, -bal) : 0;
          extraBox.append(h('div', { class: 'small' },
            pays > 0 ? t('extra_pays_debt', { v: fmtMoney(pays) }) + ' — ' : '',
            `${t('balance_after')}: `, balanceBlock(nb)));
        } else {
          extraBox.append(h('div', { class: 'small' }, `${t('change_due')}: ${fmtMoney(extra)}`));
        }
      };
      recv.oninput = () => { st.cashRecv = recv.value; drawExtra(); };
      payBox.append(field(t('cash_received'), recv), extraBox);
      drawExtra();
      return;
    }
    if (st.payMode === 'MIXED') {
      const cashIn = input({ type: 'number', step: '0.01', min: '0', inputmode: 'decimal', value: st.cashIn });
      cashIn.oninput = () => { st.cashIn = cashIn.value; after(); };
      payBox.append(field(t('cash_part'), cashIn));
    }
    const afterEl = h('div', { class: 'small' });
    payBox.append(afterEl);
    function after() {
      if (st.payMode === 'MIXED') cashPart = Math.min(Number(st.cashIn) || 0, tot);
      const acc = tot - cashPart;
      const nb = Number(st.customer.balance) - acc;
      afterEl.replaceChildren(acc > 0 ? h('div', null, `${t('from_account')}: ${fmtMoney(acc)} — ${t('balance_after')}: `, balanceBlock(nb)) : '');
    }
    after();
  }

  function pulse() { mobileBar.classList.remove('pulse'); void mobileBar.offsetWidth; mobileBar.classList.add('pulse'); }

  async function submit() {
    if (!st.cart.length) { toast(t('cart_empty'), 'warn'); return; }
    if (!st.customer && !st.guest) { toast(t('pick_customer_or_cash'), 'warn'); return; }
    const tot = total();
    let cash = 0;
    if (st.guest) {
      cash = st.cashIn === '' ? tot : Number(st.cashIn);
      if (cash < tot) { toast(t('cash_not_enough'), 'warn'); return; }
    } else if (st.payMode === 'CASH') cash = st.cashRecv === '' ? tot : Math.max(Number(st.cashRecv) || 0, 0);
    else if (st.payMode === 'MIXED') cash = Math.min(Number(st.cashIn) || 0, tot);
    const extraToAccount = !st.guest && st.payMode === 'CASH' && cash > tot && st.extraMode === 'ACCOUNT';

    const items = st.cart.map((l) => ({ variant_id: l.variant.id, qty: l.qty, addons: l.addons.map((a) => a.id), notes: l.notes || null }));
    try {
      const res = await rpc('create_order', {
        p_items: items, p_customer_id: st.customer?.id ?? null, p_guest_name: st.guest ? (st.guestName.trim() || null) : null,
        p_cash: cash, p_notes: null, p_idempotency_key: st.key, p_extra_to_account: extraToAccount,
      });
      const change = (st.guest || (st.payMode === 'CASH' && !extraToAccount)) ? Math.max(cash - tot, 0) : 0;
      toast(t('order_created', { no: res.order_no }), 'ok', 6000);
      put(resultBox, h('div', { class: 'alert ok-soft' },
        h('b', null, t('order_created', { no: res.order_no })),
        h('div', null, `${t('total')}: ${fmtMoney(res.total)}`
          + (Number(res.cash) ? ` — ${t('cash')}: ${fmtMoney(res.cash)}` : '')
          + (Number(res.account) ? ` — ${t('from_account')}: ${fmtMoney(res.account)}` : '')
          + (Number(res.deposit) ? ` — ${t('extra_deposited', { v: fmtMoney(res.deposit) })}` : '')
          + (change > 0 ? ` — ${t('change_due')}: ${fmtMoney(change)}` : '')),
        res.balance != null ? h('div', null, balanceBlock(res.balance)) : null,
        res.warnings?.length ? h('div', { class: 'small', style: { marginTop: '6px' } }, t('negative_warning'), ' ', res.warnings.map((w) => nm(w)).join('، ')) : null,
        h('div', { style: { marginTop: '8px' } }, btn(t('print_receipt'), () => printOrderReceipt(res.order_id), 'sm'))));
      st.cart = []; st.cashIn = ''; st.cashRecv = ''; st.extraMode = null; st.key = uuid(); st.guestName = '';
      st.customer = null; st.guest = false; st.payMode = 'ACCOUNT';
      renderAll();
    } catch (e) { toastError(e); }
  }

  function renderAll() { renderCustomer(); renderCart(); }

  const cartPanel = h('aside', { class: 'pos-cart panel' },
    h('h2', null, t('customer')), custBox,
    h('h2', { style: { marginTop: '16px' } }, t('cart')), lines, totalEl,
    h('h2', { style: { marginTop: '16px' } }, t('payment')), payBox,
    h('div', { class: 'form-actions' }, btn(t('clear'), () => { st.cart = []; renderCart(); }), submitBtn),
    resultBox);

  root.append(h('div', { class: 'pos' },
    h('section', { class: 'pos-catalog' }, h('div', { class: 'toolbar' }, h('div', { class: 'grow' }, search)), catBar, grid),
    cartPanel), mobileBar);

  renderCats(); renderGrid(); renderAll();
}
