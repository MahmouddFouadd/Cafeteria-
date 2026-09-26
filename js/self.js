// Employee ordering app (order.html): register this phone, order, follow the order, see the balance.
// Each phone signs in anonymously once and stays signed in; the server ties it to one person.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
import { CONFIG } from './config.js';

const sb = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, storageKey: 'cafeteria-self', storage: window.localStorage },
});

// ---------- helpers ----------
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (['value', 'checked', 'disabled', 'hidden'].includes(k)) el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
}
const put = (el, ...kids) => { el.replaceChildren(); for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c))); };
const money = (n) => `${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ج.م`;
const latin = (v) => String(v ?? '').replace(/[\u0660-\u0669\u06F0-\u06F9]/g, (d) => String((d.charCodeAt(0) & 0xF) % 10));
const uuid = () => (crypto.randomUUID ? crypto.randomUUID()
  : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); }));
const app = document.getElementById('app');

function toast(msg, kind = '') {
  const t = h('div', { class: 'toast ' + kind }, msg);
  document.getElementById('toasts').append(t);
  setTimeout(() => t.remove(), 4500);
}

const ERR = {
  SELF_NOT_MATCHED: 'الاسم والكود مش متطابقين. اكتب كودك واسمك الأول زي ما هو متسجل في الشركة.',
  SELF_DEVICE_BLOCKED: 'الموبايل ده موقوف. كلّم الريسبشن.',
  SELF_CODE_NAME_REQUIRED: 'اكتب اسمك وكودك.',
  SELF_ORDERING_OFF: 'الطلب من التطبيق مقفول دلوقتي. اطلب من البوفيه.',
  SELF_TOO_MANY_OPEN: 'عندك 3 طلبات لسه ماتسلمتش. استنى لما يتسلموا.',
  SELF_ITEM_NOT_ALLOWED: 'المشروب ده مش متاح من التطبيق.',
  CREDIT_LIMIT_EXCEEDED: 'حسابك وصل للحد الأقصى. ادفع في الريسبشن أو اختار كاش عند الاستلام.',
  CUSTOMER_INACTIVE: 'حسابك موقوف. كلّم الريسبشن.',
  CUSTOMER_NOT_ACTIVE: 'حسابك موقوف. كلّم الريسبشن.',
  DAY_CLOSED: 'البوفيه قفل اليوم.',
  VARIANT_NOT_AVAILABLE: 'مشروب مش متاح دلوقتي. حدّث الصفحة.',
  ADDON_NOT_ALLOWED: 'إضافة مش متاحة للمشروب ده.',
};
const errText = (e) => {
  const m = String(e?.message || e || '');
  const code = m.split(':')[0].trim();
  if (ERR[code]) return ERR[code];
  if (/Failed to fetch|NetworkError/i.test(m)) return 'مفيش إنترنت. جرّب تاني.';
  if (/anonymous/i.test(m)) return 'التطبيق مش متفعّل لسه. كلّم مدير النظام.';
  return m || 'حصلت مشكلة. جرّب تاني.';
};
async function rpc(name, args) {
  const { data, error } = await sb.rpc(name, args);
  if (error) throw error;
  return data;
}

// ---------- notifications ----------
const STATUS = {
  NEW: { label: 'اتبعت للبوفيه', step: 1 },
  PREPARING: { label: 'بيتجهز دلوقتي ☕', step: 2 },
  READY: { label: 'جاهز — استلمه', step: 3 },
  SERVED: { label: 'اتسلّم ✓', step: 3 },
  CANCELLED: { label: 'اتلغى', step: 0 },
};
function beep() {
  try {
    const c = new (window.AudioContext || window.webkitAudioContext)();
    [0, 0.25].forEach((t0) => { const o = c.createOscillator(); const g = c.createGain(); o.frequency.value = 880; g.gain.value = 0.1; o.connect(g); g.connect(c.destination); o.start(c.currentTime + t0); o.stop(c.currentTime + t0 + 0.15); });
  } catch (_) { /* optional */ }
}
async function notify(title, body, tag) {
  navigator.vibrate?.([200, 100, 200]);
  beep();
  toast(`${title} — ${body}`, 'ok');
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const reg = await navigator.serviceWorker?.ready;
    if (reg) await reg.showNotification(title, { body, tag, renotify: true, icon: 'assets/img/icon-192.png', badge: 'assets/img/icon-192.png', vibrate: [200, 100, 200], data: { url: 'order.html' } });
    else new Notification(title, { body, tag });
  } catch (_) { /* optional */ }
}

// ---------- state ----------
let me = null;            // { person, orders, self_enabled }
let menu = null;
let lastStatus = new Map();
let view = 'home';
const cart = [];
let pay = 'ACCOUNT', notes = '', key = uuid(), cat = '';

// ---------- boot ----------
async function boot() {
  try {
    let { data } = await sb.auth.getSession();
    if (!data.session) {
      const res = await sb.auth.signInAnonymously();
      if (res.error) throw res.error;
    }
    await refresh(true);
  } catch (e) {
    const m = String(e?.message || '');
    if (m.startsWith('SELF_NOT_REGISTERED')) return renderRegister();
    put(app, h('div', { class: 'self-reg' }, logos(), h('div', { class: 'alert bad' }, errText(e)), h('button', { class: 'btn primary lg', onclick: () => location.reload() }, 'حاول تاني')));
  }
}

async function refresh(first = false) {
  const data = await rpc('self_me');
  // tell the employee when their order moves on
  for (const o of data.orders || []) {
    const prev = lastStatus.get(o.id);
    if (!first && prev && prev !== o.status) {
      if (o.status === 'PREPARING') notify('طلبك بيتجهز دلوقتي ☕', `${o.order_no}: ${o.items}`, 'order-' + o.id);
      else if (o.status === 'READY') notify('طلبك جاهز', `${o.order_no}: استلمه من البوفيه`, 'order-' + o.id);
      else if (o.status === 'CANCELLED') notify('طلبك اتلغى', o.order_no, 'order-' + o.id);
    }
    lastStatus.set(o.id, o.status);
  }
  me = data;
  if (view === 'home') renderHome();
}

let timer = null, lastPoll = 0;
function startPolling() {
  clearInterval(timer);
  timer = setInterval(() => {
    const hasOpen = (me?.orders || []).some((o) => ['NEW', 'PREPARING', 'READY'].includes(o.status));
    const every = document.hidden ? 30000 : (hasOpen ? 6000 : 20000);
    if (Date.now() - lastPoll >= every) { lastPoll = Date.now(); refresh().catch(() => {}); }
  }, 3000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh().catch(() => {}); });
}

// ---------- screens ----------
const logos = () => h('div', { class: 'logos' },
  h('img', { src: 'assets/img/minapharm.png', alt: 'Minapharm' }), h('img', { src: 'assets/img/migentra.png', alt: 'Migentra', class: 'mig' }));

function renderRegister(prefill = {}) {
  view = 'register';
  const name = h('input', { class: 'input', autocomplete: 'name', value: prefill.name || '', placeholder: 'مثلًا: أحمد فؤاد' });
  const code = h('input', { class: 'input num', inputmode: 'numeric', dir: 'ltr', value: prefill.code || '', placeholder: 'كود الموظف' });
  code.addEventListener('input', () => { code.value = latin(code.value).trim(); });
  const msg = h('div', { class: 'alert bad', hidden: true });
  const go = h('button', { class: 'btn primary lg', type: 'submit' }, 'دخول');
  const form = h('form', { class: 'login-form', onsubmit: async (e) => {
    e.preventDefault(); msg.hidden = true;
    if (!name.value.trim() || !code.value.trim()) { msg.textContent = ERR.SELF_CODE_NAME_REQUIRED; msg.hidden = false; return; }
    go.disabled = true;
    try {
      const res = await rpc('self_register', { p_code: code.value.trim(), p_name: name.value.trim(), p_user_agent: navigator.userAgent.slice(0, 300) });
      if (res?.error) { msg.textContent = ERR[res.error] || res.error; msg.hidden = false; return; }
      me = res; lastStatus = new Map((res.orders || []).map((o) => [o.id, o.status]));
      view = 'home'; renderHome(); startPolling();
    } catch (err) { msg.textContent = errText(err); msg.hidden = false; }
    finally { go.disabled = false; }
  } },
    h('label', { class: 'field' }, h('span', { class: 'label' }, 'اسمك'), name),
    h('label', { class: 'field' }, h('span', { class: 'label' }, 'كود الموظف'), code),
    msg, go);
  put(app, h('div', { class: 'self-reg' }, logos(),
    h('div', null, h('h1', { style: 'margin:0' }, 'طلبات البوفيه'), h('p', { class: 'muted' }, 'اكتب اسمك وكودك مرة واحدة، والموبايل ده هيتسجل باسمك.')),
    form,
    h('p', { class: 'muted small' }, 'الموبايل بيتسجل باسمك ومعاه بيانات الجهاز والـIP. لو اتسجل عليه اسم تاني، الإدارة بتعرف.')));
  setTimeout(() => name.focus(), 60);
}

function topBar() {
  return h('header', { class: 'self-top' },
    h('img', { src: 'assets/img/minapharm.png', alt: 'Minapharm' }),
    h('div', { class: 'grow' }),
    h('img', { src: 'assets/img/migentra.png', alt: 'Migentra' }));
}

function balanceCard(p) {
  const b = Number(p.balance || 0);
  return h('section', { class: 'self-card' },
    h('div', { class: 'self-balance ' + (b < 0 ? 'due' : b > 0 ? 'pos' : '') },
      h('span', null, b < 0 ? 'عليك' : b > 0 ? 'رصيدك' : 'رصيدك'), h('b', { class: 'num' }, money(Math.abs(b)))),
    b < 0 ? h('div', { class: 'muted small' }, 'تقدر تدفع في الريسبشن، أو كاش عند استلام الطلب.') : null);
}

function orderCard(o) {
  const s = STATUS[o.status] || { label: o.status, step: 0 };
  const open = ['NEW', 'PREPARING', 'READY'].includes(o.status);
  return h('article', { class: 'self-card self-order ' + o.status },
    h('div', { class: 'row', style: 'justify-content:space-between' }, h('b', null, o.order_no), h('span', { class: 'muted small' },
      new Date(o.created_at).toLocaleTimeString('ar-EG-u-nu-latn', { hour: 'numeric', minute: '2-digit', timeZone: 'Africa/Cairo' }))),
    h('div', null, o.items),
    open ? h('div', { class: 'self-steps' }, [1, 2, 3].map((i) => h('span', { class: i <= s.step ? 'on' : '' }))) : null,
    h('div', { class: 'self-status' }, s.label),
    o.status === 'NEW' && o.ahead != null ? h('div', { class: 'self-ahead muted' }, Number(o.ahead) === 0 ? 'إنت الجاي 👌' : `قبلك ${o.ahead} ${Number(o.ahead) === 1 ? 'طلب' : 'طلبات'}`) : null,
    h('div', { class: 'muted small' }, `${money(o.total)} · ${o.pay_request === 'CASH' ? 'كاش عند الاستلام' : 'على الحساب'}`));
}

function renderHome() {
  view = 'home';
  const p = me.person;
  const open = (me.orders || []).filter((o) => ['NEW', 'PREPARING', 'READY'].includes(o.status));
  const done = (me.orders || []).filter((o) => !['NEW', 'PREPARING', 'READY'].includes(o.status));
  const needPerm = 'Notification' in window && Notification.permission === 'default';
  put(app, topBar(), h('main', { class: 'self-wrap' },
    h('div', { class: 'self-hello' }, h('h1', null, `أهلًا ${p.full_name.split(' ')[0]}`),
      h('div', { class: 'muted small' }, [p.code, p.department_ar, p.company].filter(Boolean).join(' · '), ' · ',
        h('button', { class: 'self-link', onclick: () => renderRegister() }, 'مش أنا؟'))),
    balanceCard(p),
    needPerm ? h('button', { class: 'btn', onclick: async () => { await Notification.requestPermission(); renderHome(); } }, '🔔 فعّل الإشعارات علشان يوصلك لما طلبك يتجهز') : null,
    open.length ? [h('h2', { style: 'margin:4px 0 0' }, 'طلباتك دلوقتي'), open.map(orderCard)] : null,
    done.length ? [h('h2', { style: 'margin:4px 0 0;font-size:16px' }, 'النهارده'), done.map(orderCard)] : null,
    !open.length && !done.length ? h('div', { class: 'self-card self-empty' }, 'مفيش طلبات النهارده.') : null),
    h('div', { class: 'self-bar' }, me.self_enabled
      ? h('button', { class: 'btn primary', onclick: openMenu }, '☕ اطلب مشروب')
      : h('div', { class: 'alert warn' }, ERR.SELF_ORDERING_OFF)));
}

// ---------- ordering ----------
async function openMenu() {
  view = 'menu';
  put(app, topBar(), h('main', { class: 'self-wrap' }, h('div', { class: 'page-loading' }, h('span'), h('span'), h('span'))));
  try { menu = menu || await rpc('self_menu'); } catch (e) { toast(errText(e), 'bad'); return renderHome(); }
  renderMenu();
}

const total = () => cart.reduce((s, l) => s + l.qty * (Number(l.variant.price) + l.addons.reduce((a, x) => a + Number(x.price), 0)), 0);
const count = () => cart.reduce((s, l) => s + l.qty, 0);
const addonsFor = (vid) => menu.addons.filter((a) => menu.variant_addons.some((x) => x.variant_id === vid && x.addon_id === a.id));

function renderMenu() {
  view = 'menu';
  const cats = menu.categories.filter((c) => menu.products.some((p) => p.category_id === c.id));
  const grid = h('div', { class: 'pos-grid' });
  const drawGrid = () => put(grid, menu.products.filter((p) => !cat || p.category_id === cat).map((p) =>
    h('div', { class: 'pos-card' }, h('div', { class: 'pos-name' }, p.name_ar),
      h('div', { class: 'pos-variants' }, p.variants.map((v) => h('button', { type: 'button', class: 'pos-var', onclick: () => {
        const same = cart.find((l) => l.variant.id === v.id && !l.addons.length && !l.notes);
        if (same) same.qty += 1; else cart.push({ product: p, variant: v, qty: 1, addons: [], notes: '' });
        navigator.vibrate?.(10); renderMenu();
      } }, p.variants.length > 1 || v.name_en !== 'Regular' ? h('span', null, v.name_ar) : null, h('b', null, money(v.price))))))));
  const chips = h('div', { class: 'chips scroll' }, [{ id: '', name_ar: 'الكل' }, ...cats].map((c) =>
    h('button', { type: 'button', class: 'chip' + (cat === c.id ? ' on' : ''), onclick: () => { cat = c.id; renderMenu(); } }, c.name_ar)));
  drawGrid();
  put(app, topBar(), h('main', { class: 'self-wrap' },
    h('div', { class: 'row', style: 'justify-content:space-between' }, h('h1', { style: 'margin:0;font-size:20px' }, 'اختار مشروبك'),
      h('button', { class: 'btn sm', onclick: () => renderHome() }, 'رجوع')),
    chips, grid),
    h('div', { class: 'self-bar' }, cart.length
      ? h('button', { class: 'btn primary', onclick: renderCart }, `طلبك (${count()}) — ${money(total())}`)
      : h('div', { class: 'alert info small' }, 'دوس على المشروب علشان تضيفه.')));
}

function editLine(l) {
  const avail = addonsFor(l.variant.id);
  const boxes = avail.map((a) => { const i = h('input', { type: 'checkbox', checked: l.addons.some((x) => x.id === a.id) }); i.addon = a; return h('label', { class: 'check' }, i, h('span', null, a.name_ar + (Number(a.price) ? ` (+${money(a.price)})` : ''))); });
  const note = h('input', { class: 'input', value: l.notes, placeholder: 'مثلًا: سكر خفيف' });
  const back = h('div', { class: 'modal-backdrop' });
  const close = () => back.remove();
  back.append(h('div', { class: 'modal', role: 'dialog' },
    h('header', { class: 'modal-head' }, h('h2', null, `${l.product.name_ar} — ${l.variant.name_ar}`), h('button', { class: 'icon-btn', type: 'button', onclick: close }, '✕')),
    h('div', { class: 'modal-body', style: 'display:grid;gap:10px' }, boxes.length ? boxes : h('div', { class: 'muted' }, 'مفيش إضافات للمشروب ده.'),
      h('label', { class: 'field' }, h('span', { class: 'label' }, 'ملاحظات'), note)),
    h('footer', { class: 'modal-foot' }, h('button', { class: 'btn', onclick: close }, 'إلغاء'),
      h('button', { class: 'btn primary', onclick: () => {
        l.addons = boxes.map((b) => b.querySelector('input')).filter((i) => i.checked).map((i) => i.addon);
        l.notes = note.value.trim(); close(); renderCart();
      } }, 'حفظ'))));
  document.body.append(back);
}

function renderCart() {
  view = 'cart';
  const p = me.person;
  const bal = Number(p.balance || 0);
  const lines = cart.map((l) => {
    const unit = Number(l.variant.price) + l.addons.reduce((a, x) => a + Number(x.price), 0);
    return h('div', { class: 'cart-line' },
      h('div', { class: 'cl-main' },
        h('div', { class: 'cl-name' }, l.product.name_ar + (l.product.variants.length > 1 ? ` — ${l.variant.name_ar}` : '')),
        l.addons.length ? h('div', { class: 'muted small' }, '+ ' + l.addons.map((a) => a.name_ar).join('، ')) : null,
        l.notes ? h('div', { class: 'muted small' }, l.notes) : null,
        h('button', { class: 'btn sm ghost', onclick: () => editLine(l) }, 'إضافات وملاحظات')),
      h('div', { class: 'stepper' },
        h('button', { type: 'button', onclick: () => { l.qty -= 1; if (l.qty <= 0) cart.splice(cart.indexOf(l), 1); cart.length ? renderCart() : renderMenu(); } }, '−'),
        h('span', null, l.qty),
        h('button', { type: 'button', onclick: () => { l.qty += 1; renderCart(); } }, '+')),
      h('div', { class: 'cl-total num' }, money(unit * l.qty)));
  });
  const payBar = h('div', { class: 'seg' }, [['ACCOUNT', 'على حسابي'], ['CASH', 'كاش عند الاستلام']].map(([k, label]) =>
    h('button', { type: 'button', class: pay === k ? 'on' : '', onclick: () => { pay = k; renderCart(); } }, label)));
  const noteIn = h('input', { class: 'input', value: notes, placeholder: 'ملاحظة للبوفيه (اختياري)' });
  noteIn.addEventListener('input', () => { notes = noteIn.value; });
  const go = h('button', { class: 'btn primary', onclick: async () => {
    go.disabled = true;
    try {
      const items = cart.map((l) => ({ variant_id: l.variant.id, qty: l.qty, addons: l.addons.map((a) => a.id), notes: l.notes || null }));
      const res = await rpc('self_create_order', { p_items: items, p_pay: pay, p_notes: notes.trim() || null, p_idempotency_key: key });
      cart.length = 0; notes = ''; key = uuid();
      toast(`اتبعت طلبك ${res.order_no}. هيوصلك إشعار لما يبدأ يتجهز.`, 'ok');
      navigator.vibrate?.(30);
      if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
      view = 'home'; await refresh(); lastStatus.set(res.order_id, 'NEW');
    } catch (e) { toast(errText(e), 'bad'); }
    finally { go.disabled = false; }
  } }, `تأكيد الطلب — ${money(total())}`);
  put(app, topBar(), h('main', { class: 'self-wrap self-sheet' },
    h('div', { class: 'row', style: 'justify-content:space-between' }, h('h1', { style: 'margin:0;font-size:20px' }, 'طلبك'),
      h('button', { class: 'btn sm', onclick: renderMenu }, '+ زوّد')),
    h('section', { class: 'self-card' }, lines, h('div', { class: 'cart-total' }, h('span', null, 'الإجمالي'), h('b', null, money(total())))),
    h('section', { class: 'self-card' }, h('b', null, 'الدفع'), payBar,
      h('div', { class: 'muted small' }, pay === 'ACCOUNT'
        ? `بيتخصم من حسابك. بعد الطلب: ${bal - total() < 0 ? 'عليك ' + money(-(bal - total())) : 'رصيدك ' + money(bal - total())}`
        : 'هتدفع للبوفيه وقت ما تستلم المشروب.'),
      noteIn)),
    h('div', { class: 'self-bar' }, go));
}

boot().then(() => { if (me) startPolling(); });
