import { sb } from './supabase.js';
import { CONFIG } from './config.js';
import { t, lang, setLang } from './i18n.js';
import { h, put, clear, btn, input, field, toast, toastError, busy } from './ui.js';
import { rpc, errText } from './api.js';
import { loadRefs } from './store.js';
import { session, canAny } from './session.js';

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
  'master':        { title: 'nav.master',    perms: ['inventory.materials', 'catalog.manage'], render: masterPage },
};

const NAV = [
  { title: null,               items: ['home'] },
  { title: 'nav.g.sales',      items: ['pos', 'queue', 'reception', 'orders', 'customers', 'closing'] },
  { title: 'nav.g.inventory',  items: ['stock', 'docs/purchase', 'docs/transfer', 'docs/issue', 'docs/waste', 'counts', 'docs', 'movements', 'materials'] },
  { title: 'nav.g.catalog',    items: ['catalog', 'addons'] },
  { title: 'nav.g.settings',   items: ['master', 'docs/opening'] },
];

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
  if (data.session && await loadProfile()) renderShell();
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

function renderLogin() {
  const user = input({ autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false', dir: 'ltr' });
  const pass = input({ type: 'password', autocomplete: 'current-password', dir: 'ltr' });
  const msg = h('div', { class: 'alert bad', hidden: true });
  const submit = h('button', { class: 'btn primary', type: 'submit', style: { width: '100%' } }, t('login'));

  const form = h('form', { onsubmit: (e) => { e.preventDefault(); busy(submit, doLogin); } },
    h('div', { style: { display: 'grid', gap: '14px' } },
      field(t('username'), user), field(t('password'), pass), msg, submit));

  async function doLogin() {
    msg.hidden = true;
    const u = user.value.trim().toLowerCase();
    if (!u || !pass.value) return;
    const email = u.includes('@') ? u : `${u}@${CONFIG.EMAIL_DOMAIN}`;
    const { error } = await sb.auth.signInWithPassword({ email, password: pass.value });
    if (error) { msg.textContent = errText(error); msg.hidden = false; return; }
    try { await rpc('log_login', { p_client: navigator.userAgent.slice(0, 180) }); }
    catch (e) { msg.textContent = e.message; msg.hidden = false; await sb.auth.signOut(); return; }
    if (await loadProfile()) { location.hash = '#/home'; renderShell(); }
  }

  put(app, h('div', { class: 'login' },
    h('section', { class: 'login-art' },
      h('div', null, h('h1', null, t('app_title')), h('p', null, t('login_blurb'))),
      h('div', { class: 'status-row' },
        h('span', { class: 'dot ' + (navigator.onLine ? 'on' : 'off') }, t('network')))),
    h('section', { class: 'login-panel' },
      brandPlate(),
      h('div', { style: { display: 'flex', alignItems: 'center' } },
        h('h2', { style: { flex: 1 } }, t('login_title')), langButton(renderLogin)),
      form,
      h('p', { class: 'muted small', style: { margin: 0 } }, t('login_audit_note')))));
  setTimeout(() => user.focus(), 50);
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
      items.map((k) => h('a', { href: '#/' + k, 'data-route': k }, t(ROUTES[k].title)))));
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
          btn(t('logout'), async () => { await sb.auth.signOut(); }, 'sm')))),
    h('main', { class: 'main' },
      h('div', { class: 'topbar' },
        h('button', { class: 'icon-btn menu-btn', type: 'button', 'aria-label': t('menu'),
          onclick: () => shell.classList.toggle('nav-open') }, '☰'),
        title),
      content));
  shell.addEventListener('click', (e) => {
    if (e.target === shell || e.target.closest('.nav a')) shell.classList.remove('nav-open');
  });
  put(app, shell);
  shellEls = { title, content, nav };
  route();
}

async function route() {
  if (!session.profile || !shellEls) return;
  let key = location.hash.replace(/^#\/?/, '') || 'home';
  if (!allowed(key)) key = 'home';
  document.querySelector('.shell')?.classList.remove('nav-open');
  const r = ROUTES[key];
  shellEls.nav.querySelectorAll('a').forEach((a) => a.classList.toggle('active', a.dataset.route === key));
  shellEls.title.textContent = t(r.title);
  document.title = `${t(r.title)} | ${t('app_title')}`;
  const root = clear(shellEls.content);
  try { await r.render(root); }
  catch (e) { root.append(h('div', { class: 'alert bad' }, errText(e))); }
}

window.addEventListener('hashchange', route);
boot();
