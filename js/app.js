import { sb } from './supabase.js';
import { CONFIG } from './config.js';
import { t, lang, setLang } from './i18n.js';
import { h, put, clear, btn, input, field, toast, toastError, busy } from './ui.js';
import { rpc, errText } from './api.js';
import { loadRefs, loadSettings, usePrep } from './store.js';
import { session, canAny } from './session.js';
import { deviceUsers, rememberDeviceUser, forgetDeviceUser, pinPassword } from './pin.js';

import { settingsPage } from './pages/settings.js';
import { mePage } from './pages/me.js';
import { inventoryPage, INV_KEYS } from './pages/inventory.js';
import { homePage } from './pages/home.js';
import { stockPage } from './pages/stock.js';
import { movementsPage } from './pages/movements.js';
import { docFormPage, docsListPage } from './pages/docs.js';
import { countsPage } from './pages/counts.js';
import { materialsPage } from './pages/materials.js';
import { catalogPage } from './pages/catalog.js';
import { addonsPage } from './pages/addons.js';
import { masterPage } from './pages/master.js';
import { posPage } from './pages/pos.js';
import { queuePage } from './pages/queue.js';
import { ordersPage } from './pages/orders.js';
import { receptionPage } from './pages/reception.js';
import { customersPage } from './pages/customers.js';
import { closingPage } from './pages/closing.js';

const app = document.getElementById('app');

// ---------- Routes ----------
const ROUTES = {
  'home':          { title: 'nav.home',      perms: null,                     render: homePage },
  'me':            { title: 'nav.me',        perms: null,                     render: mePage },
  'inventory':     { title: 'nav.inventory', perms: ['inventory.view', 'inventory.purchase', 'inventory.transfer', 'inventory.issue', 'inventory.waste', 'inventory.adjust', 'inventory.materials'], render: inventoryPage },
  'pos':           { title: 'nav.pos',       perms: ['pos.create_order'],     render: posPage },
  'queue':         { title: 'nav.queue',     perms: ['orders.queue'],         render: queuePage },
  'orders':        { title: 'nav.orders',    perms: ['orders.view'],          render: ordersPage },
  'reception':     { title: 'nav.reception', perms: ['accounts.deposit', 'payments.receive'], render: receptionPage },
  'customers':     { title: 'nav.customers', perms: ['customers.manage', 'accounts.view'], render: customersPage },
  'closing':       { title: 'nav.closing',   perms: ['closing.perform'],      render: closingPage },
  'stock':         { title: 'nav.stock',     perms: ['inventory.view'],       render: stockPage },
  'docs/purchase': { title: 'nav.purchase',  perms: ['inventory.purchase'],   render: (r) => docFormPage(r, 'PURCHASE') },
  'docs/transfer': { title: 'nav.transfer',  perms: ['inventory.transfer'],   render: (r) => docFormPage(r, 'TRANSFER') },
  'docs/issue':    { title: 'nav.issue',     perms: ['inventory.issue'],      render: (r) => docFormPage(r, 'ISSUE') },
  'docs/waste':    { title: 'nav.waste',     perms: ['inventory.waste'],      render: (r) => docFormPage(r, 'WASTE') },
  'docs/opening':  { title: 'nav.opening',   perms: ['inventory.adjust'],     render: (r) => docFormPage(r, 'OPENING') },
  'counts':        { title: 'nav.counts',    perms: ['inventory.adjust'],     render: countsPage },
  'docs':          { title: 'nav.docs',      perms: ['inventory.view'],       render: docsListPage },
  'movements':     { title: 'nav.movements', perms: ['inventory.view'],       render: movementsPage },
  'materials':     { title: 'nav.materials', perms: ['inventory.view', 'inventory.materials'], render: materialsPage },
  'catalog':       { title: 'nav.catalog',   perms: ['catalog.manage', 'recipes.manage', 'prices.change'], render: catalogPage },
  'addons':        { title: 'nav.addons',    perms: ['catalog.manage'],       render: addonsPage },
  'settings':      { title: 'nav.settings',  perms: ['settings.manage'],      render: settingsPage },
  'master':        { title: 'nav.master',    perms: ['inventory.materials', 'catalog.manage'], render: masterPage },
};

const NAV = [
  { title: null,               items: ['home'] },
  { title: 'nav.g.sales',      items: ['pos', 'queue', 'reception', 'orders', 'customers', 'closing'] },
  { title: 'nav.g.inventory',  items: ['inventory'] },
  { title: 'nav.g.catalog',    items: ['catalog', 'addons'] },
  { title: 'nav.g.settings',   items: ['me', 'settings', 'master'] },
];

// Where each role starts: the buffet records, reception collects, the store keeps stock
const LANDING = { BARISTA: 'pos', RECEPTION: 'reception', STOREKEEPER: 'inventory' };
const landing = () => { const k = LANDING[session.profile?.role]; return k && allowed(k) ? k : 'home'; };
const routeTitle = (key) => (key === 'queue' && !usePrep() ? t('nav.queue_simple') : t(ROUTES[key].title));
const allowed = (key) => { const r = ROUTES[key]; return r && (!r.perms || canAny(r.perms)); };

// ---------- Boot ----------
async function boot() {
  applyDir();
  window.addEventListener('online', netBanner);
  window.addEventListener('offline', netBanner);
  sb.auth.onAuthStateChange((event) => { if (event === 'SIGNED_OUT') { session.profile = null; renderLogin(); } });

  if (CONFIG.SUPABASE_URL.includes('YOUR-PROJECT')) {
    put(app, h('div', { class: 'content' }, h('div', { class: 'alert bad' }, t('config_missing'))));
    return;
  }
  const { data } = await sb.auth.getSession();
  if (data.session && idleExpired()) { await signOutNow('idle'); return; }
  if (data.session && await loadProfile()) { rememberDeviceUser(session.profile); await loadSettings().catch(() => {}); renderShell(); }
  else renderLogin();
}

function applyDir() {
  document.documentElement.lang = lang();
  document.documentElement.dir = lang() === 'ar' ? 'rtl' : 'ltr';
  document.title = t('app_title');
}

function netBanner() {
  document.querySelector('.net-banner')?.remove();
  if (!navigator.onLine) document.body.prepend(h('div', { class: 'net-banner', role: 'alert' }, t('offline')));
}

async function loadProfile() {
  try {
    const p = await rpc('my_profile');
    if (!p) { await sb.auth.signOut(); toast(t('err.USER_INACTIVE'), 'bad'); return false; }
    session.profile = p;
    if (p.locale && p.locale !== lang() && !localStorage.getItem('lang')) { setLang(p.locale); applyDir(); }
    await loadRefs(true);
    return true;
  } catch (e) { toastError(e); return false; }
}

// ---------- Login ----------
function brandPlate() {
  return h('div', { class: 'brand-plate' },
    h('img', { src: 'assets/img/minapharm.png', alt: 'Minapharm' }),
    h('img', { src: 'assets/img/migentra.png', alt: 'Migentra', class: 'mig' }));
}

function langButton(onChange) {
  return btn(lang() === 'ar' ? 'English' : 'عربي', async () => {
    setLang(lang() === 'ar' ? 'en' : 'ar');
    applyDir();
    if (session.profile) rpc('set_my_locale', { p_locale: lang() }).catch(() => {});
    onChange();
  }, 'sm');
}

// Arabic-Indic / Persian digits → Latin, so "١٢٣" and "123" are the same
const latinDigits = (v) => v.replace(/[\u0660-\u0669\u06F0-\u06F9]/g, (d) => String((d.charCodeAt(0) & 0xF) % 10));

function loginArt() {
  // Abstract arcs in the two brand colours (decorative only)
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 600 600'); svg.setAttribute('class', 'login-arcs'); svg.setAttribute('aria-hidden', 'true');
  for (const [d, cls] of [
    ['M40 420 C 160 120, 460 80, 560 260', 'arc-o'],
    ['M80 520 C 260 380, 520 420, 560 120', 'arc-v'],
    ['M20 300 C 200 260, 380 300, 580 480', 'arc-v thin'],
  ]) { const path = document.createElementNS(ns, 'path'); path.setAttribute('d', d); path.setAttribute('class', cls); svg.append(path); }
  return svg;
}

/** Shared sign-in. Returns an error message, or null on success (shell rendered). */
async function signIn(username, password, { remember = true } = {}) {
  const u = latinDigits(username).trim().toLowerCase().replace(/\s+/g, '');
  if (!navigator.onLine) return t('offline');
  const email = u.includes('@') ? u : `${u}@${CONFIG.EMAIL_DOMAIN}`;
  const { error } = await sb.auth.signInWithPassword({ email, password });
  if (error) return errText(error);
  try { await rpc('log_login', { p_client: navigator.userAgent.slice(0, 180) }); }
  catch (e) { await sb.auth.signOut(); return e.message; }
  if (!(await loadProfile())) return t('err.USER_INACTIVE');
  if (remember) rememberDeviceUser(session.profile); else forgetDeviceUser(session.profile.username);
  await loadSettings().catch(() => {});
  location.hash = '#/' + landing();
  renderShell();
  return null;
}

function loginFrame(...body) {
  let reason = null;
  try { reason = sessionStorage.getItem(REASON_KEY); sessionStorage.removeItem(REASON_KEY); } catch (_) {}
  const info = reason === 'idle' ? h('div', { class: 'alert warn', role: 'status' }, t('idle_logged_out', { m: idleMin() })) : null;
  const net = h('span', { class: 'dot ' + (navigator.onLine ? 'on' : 'off') }, navigator.onLine ? t('online') : t('network_off'));
  put(app, h('div', { class: 'login' },
    loginArt(),
    h('main', { class: 'login-card' },
      h('div', { class: 'login-brand' },
        h('img', { src: 'assets/img/minapharm.png', alt: 'Minapharm' }),
        h('span', { class: 'brand-sep', 'aria-hidden': 'true' }),
        h('img', { src: 'assets/img/migentra.png', alt: 'Migentra', class: 'mig' })),
      h('div', { class: 'login-body' },
        info, ...body,
        h('div', { class: 'login-foot' }, net,
          h('span', { class: 'muted small' }, t('session_note', { m: idleMin() }))),
        h('p', { class: 'muted small login-help' }, t('login_help'))))));
}

const initials = (name) => (name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();

/** Entry point: tiles of this device's users, or the full form when there are none. */
function renderLogin() {
  const list = deviceUsers();
  if (!list.length) return renderPasswordLogin();
  let editing = false;
  const grid = h('div', { class: 'user-tiles' });
  const draw = () => put(grid, deviceUsers().map((x) => h('div', { class: 'user-tile-wrap' },
    h('button', { type: 'button', class: 'user-tile', onclick: () => (x.pin ? renderPinLogin(x) : renderPasswordLogin(x.u)) },
      h('span', { class: 'avatar', 'aria-hidden': 'true' }, initials(x.name)),
      h('b', null, x.name),
      h('span', { class: 'muted small' }, lang() === 'en' ? x.role_en : x.role_ar)),
    editing ? h('button', { type: 'button', class: 'tile-x', 'aria-label': t('forget_user'),
      onclick: () => { forgetDeviceUser(x.u); if (!deviceUsers().length) renderPasswordLogin(); else draw(); } }, '×') : null)));
  draw();
  const editBtn = btn(t('edit_list'), () => { editing = !editing; editBtn.textContent = editing ? t('done') : t('edit_list'); draw(); }, 'sm ghost');
  loginFrame(
    h('div', { class: 'login-head' },
      h('div', null, h('h1', null, t('who_is_using')), h('p', { class: 'muted' }, t('tap_your_name'))),
      langButton(renderLogin)),
    grid,
    h('div', { class: 'row', style: { justifyContent: 'space-between' } },
      btn(t('other_user'), () => renderPasswordLogin(), 'ghost'), editBtn));
}

function renderPinLogin(x) {
  let pin = '';
  const len = x.len || 4;
  const dots = h('div', { class: 'pin-dots', 'aria-live': 'polite' });
  const msg = h('div', { class: 'alert bad', hidden: true, role: 'alert' });
  const drawDots = () => put(dots, Array.from({ length: len }, (_, i) => h('span', { class: i < pin.length ? 'on' : '' })));
  let busyNow = false;
  const press = async (d) => {
    if (busyNow) return;
    msg.hidden = true;
    if (d === 'back') pin = pin.slice(0, -1);
    else if (pin.length < len) pin += d;
    drawDots();
    if (pin.length === len) {
      busyNow = true; pad.classList.add('busy');
      const err = await signIn(x.u, pinPassword(pin));
      busyNow = false; pad.classList.remove('busy');
      if (err) {
        pin = ''; drawDots(); msg.textContent = t('wrong_pin'); msg.hidden = false;
        dots.classList.remove('shake'); void dots.offsetWidth; dots.classList.add('shake');
        navigator.vibrate?.([30, 40, 30]);
      }
    }
  };
  const key = (label, val, cls = '') => h('button', { type: 'button', class: 'pin-key ' + cls, onclick: () => press(val) }, label);
  const pad = h('div', { class: 'pin-pad' },
    ['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => key(d, d)),
    h('span'), key('0', '0'), key('⌫', 'back', 'muted'));
  const onKey = (e) => {
    if (!document.body.contains(pad)) { window.removeEventListener('keydown', onKey); return; }
    const d = latinDigits(e.key);
    if (/^\d$/.test(d)) press(d); else if (e.key === 'Backspace') press('back');
  };
  window.addEventListener('keydown', onKey);
  drawDots();
  loginFrame(
    h('div', { class: 'pin-head' },
      h('span', { class: 'avatar lg', 'aria-hidden': 'true' }, initials(x.name)),
      h('h1', null, x.name),
      h('p', { class: 'muted' }, t('enter_pin'))),
    dots, msg, pad,
    h('div', { class: 'row', style: { justifyContent: 'space-between' } },
      btn(t('back'), () => renderLogin(), 'ghost'),
      btn(t('use_password'), () => renderPasswordLogin(x.u), 'ghost')));
}

function renderPasswordLogin(prefill = '') {
  const user = input({ id: 'lg-user', value: prefill, autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false', dir: 'ltr', enterkeyhint: 'next', placeholder: t('username_ph') });
  const pass = input({ id: 'lg-pass', type: 'password', autocomplete: 'current-password', dir: 'ltr', enterkeyhint: 'go' });
  const eye = h('button', { type: 'button', class: 'pw-toggle', 'aria-label': t('show_password'), onclick: () => {
    const show = pass.type === 'password';
    pass.type = show ? 'text' : 'password';
    eye.textContent = show ? t('hide') : t('show');
    eye.setAttribute('aria-label', show ? t('hide_password') : t('show_password'));
    pass.focus();
  } }, t('show'));
  const caps = h('div', { class: 'caps-hint', hidden: true }, t('caps_on'));
  const onKey = (e) => { if (e.getModifierState) caps.hidden = !e.getModifierState('CapsLock'); };
  pass.addEventListener('keyup', onKey); pass.addEventListener('keydown', onKey);
  user.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); pass.focus(); } });
  const remember = h('input', { type: 'checkbox', checked: true });
  const msg = h('div', { class: 'alert bad', hidden: true, role: 'alert' });
  const submit = h('button', { class: 'btn primary lg', type: 'submit' }, t('login'));

  const form = h('form', { class: 'login-form', novalidate: true, onsubmit: (e) => { e.preventDefault(); busy(submit, doLogin); } },
    h('label', { class: 'field', for: 'lg-user' }, h('span', { class: 'label' }, t('username')), user),
    h('label', { class: 'field', for: 'lg-pass' }, h('span', { class: 'label' }, t('password')),
      h('div', { class: 'pw-wrap' }, pass, eye)),
    caps,
    h('label', { class: 'check' }, remember, h('span', null, t('remember_device'))),
    msg, submit);

  async function doLogin() {
    msg.hidden = true;
    if (!user.value.trim()) { user.focus(); msg.textContent = t('enter_username'); msg.hidden = false; return; }
    if (!pass.value) { pass.focus(); msg.textContent = t('enter_password'); msg.hidden = false; return; }
    const err = await signIn(user.value, latinDigits(pass.value), { remember: remember.checked });
    if (err) { msg.textContent = err; msg.hidden = false; pass.select(); }
  }

  loginFrame(
    h('div', { class: 'login-head' },
      h('div', null, h('h1', null, t('app_title')), h('p', { class: 'muted' }, t('login_sub'))),
      langButton(() => renderPasswordLogin(user.value))),
    form,
    deviceUsers().length ? btn(t('back_to_users'), () => renderLogin(), 'ghost') : null);
  setTimeout(() => (prefill ? pass : user).focus(), 60);
}

// ---------- Auto sign-out after inactivity ----------
const idleMin = () => {
  let v = 0;
  try { v = Number(localStorage.getItem('cafeteria-idle-min')); } catch (_) {}
  return v || Number(CONFIG.IDLE_MINUTES) || 30;
};
const ACT_KEY = 'cafeteria-last-activity';
const REASON_KEY = 'cafeteria-logout-reason';
let idleTimer = null, lastMark = 0;
const markActive = () => { try { sessionStorage.setItem(ACT_KEY, String(Date.now())); } catch (_) {} };
const lastActive = () => Number(sessionStorage.getItem(ACT_KEY)) || 0;
const idleExpired = () => { const la = lastActive(); return la > 0 && Date.now() - la > idleMin() * 60000; };
function onActivity() { const n = Date.now(); if (n - lastMark > 15000) { lastMark = n; markActive(); } }
async function signOutNow(reason) {
  clearInterval(idleTimer);
  try { if (reason) sessionStorage.setItem(REASON_KEY, reason); sessionStorage.removeItem(ACT_KEY); } catch (_) {}
  await sb.auth.signOut();
}
function checkIdle() { if (session.profile && document.visibilityState === 'visible' && idleExpired()) signOutNow('idle'); }
function startIdleWatch() {
  markActive();
  ['pointerdown', 'keydown', 'touchstart', 'wheel'].forEach((ev) => window.addEventListener(ev, onActivity, { passive: true }));
  document.removeEventListener('visibilitychange', checkIdle);
  document.addEventListener('visibilitychange', checkIdle);
  clearInterval(idleTimer);
  idleTimer = setInterval(checkIdle, 30000);
}

// ---------- Shell ----------
let shellEls = null;

function renderShell() {
  const p = session.profile;
  const nav = h('nav', { class: 'nav', 'aria-label': t('menu') });
  for (const g of NAV) {
    const items = g.items.filter(allowed);
    if (!items.length) continue;
    nav.append(h('div', { class: 'nav-group' },
      g.title ? h('div', { class: 'nav-group-title' }, t(g.title)) : null,
      items.map((k) => h('a', { href: '#/' + k, 'data-route': k }, routeTitle(k)))));
  }
  const title = h('h1');
  const content = h('div', { class: 'content', id: 'content' });
  const shell = h('div', { class: 'shell' },
    h('aside', { class: 'side' },
      brandPlate(),
      h('div', { class: 'app-name' }, t('app_title')),
      nav,
      h('div', { class: 'side-foot' },
        h('div', { class: 'who' }, p.full_name),
        h('div', { style: { color: '#A99DC2' } }, lang() === 'en' ? p.role_name_en : p.role_name_ar),
        h('div', { class: 'row' },
          langButton(() => { renderShell(); }),
          btn(t('logout'), () => signOutNow(), 'sm')))),
    h('main', { class: 'main' },
      h('div', { class: 'topbar' },
        h('button', { class: 'icon-btn menu-btn', type: 'button', 'aria-label': t('menu'),
          onclick: () => shell.classList.toggle('nav-open') }, '☰'),
        title,
        h('div', { class: 'top-user' },
          h('div', { class: 'tu-text' },
            h('b', null, p.full_name),
            h('span', null, lang() === 'en' ? p.role_name_en : p.role_name_ar)),
          h('button', { type: 'button', class: 'btn sm logout-btn', title: t('switch_user'), onclick: () => signOutNow() },
            h('span', { class: 'logout-ico', 'aria-hidden': 'true' }, '⇄'), h('span', { class: 'logout-txt' }, t('switch_user'))))),
      content));
  // Phone-style bottom tabs (mobile only); "More" opens the full menu
  const ICONS = {
    home: 'M3 11.5 12 4l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
    pos: 'M5 8h14l-1.2 11.1a1 1 0 0 1-1 .9H7.2a1 1 0 0 1-1-.9zM9 8V6a3 3 0 0 1 6 0v2',
    queue: 'M4 6h16M4 12h16M4 18h9M16 17l2 2 4-4',
    reception: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
    inventory: 'M3 7l9-4 9 4v10l-9 4-9-4zM3 7l9 4 9-4M12 11v10',
    orders: 'M7 4h10l2 3v13H5V7zM9 11h6M9 15h6',
    more: 'M5 12h.01M12 12h.01M19 12h.01',
  };
  const icon = (k) => {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(ns, 'path'); path.setAttribute('d', ICONS[k]); svg.append(path); return svg;
  };
  const tabKeys = ['home', 'pos', 'queue', 'reception', 'inventory', 'orders'].filter(allowed).slice(0, 4);
  const tabs = h('nav', { class: 'tabbar', 'aria-label': t('menu') },
    tabKeys.map((k) => h('a', { href: '#/' + k, 'data-route': k, class: 'tab' }, icon(k), h('span', null, routeTitle(k)))),
    h('button', { type: 'button', class: 'tab', onclick: (e) => { e.stopPropagation(); shell.classList.toggle('nav-open'); } }, icon('more'), h('span', null, t('nav_more'))));
  shell.append(tabs);
  shell.classList.add('has-tabs');

  shell.addEventListener('click', (e) => {
    if (e.target === shell || e.target.closest('.nav a')) shell.classList.remove('nav-open');
  });
  put(app, shell);
  shellEls = { title, content, nav, tabs };
  startIdleWatch();
  route();
}

async function route() {
  if (!session.profile || !shellEls) return;
  let key = location.hash.replace(/^#\/?/, '').split('?')[0] || landing();
  if (!allowed(key)) key = 'home';
  document.querySelector('.shell')?.classList.remove('nav-open');
  const r = ROUTES[key];
  const navKey = INV_KEYS.includes(key) ? 'inventory' : key;
  shellEls.nav.querySelectorAll('a').forEach((a) => a.classList.toggle('active', a.dataset.route === navKey));
  shellEls.title.textContent = routeTitle(key);
  document.title = `${routeTitle(key)} | ${t('app_title')}`;
  shellEls.tabs?.querySelectorAll('[data-route]').forEach((a) => a.classList.toggle('active', a.dataset.route === navKey));
  const root = clear(shellEls.content);
  if (INV_KEYS.includes(key) && allowed('inventory')) root.append(h('a', { href: '#/inventory', class: 'crumb' }, '→ ' + t('nav.inventory')));
  try { await r.render(root); }
  catch (e) { root.append(h('div', { class: 'alert bad' }, errText(e))); }
}

window.addEventListener('hashchange', route);
boot();
