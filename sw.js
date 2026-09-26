// Service worker: makes the app installable and fast.
//  * App files (same origin): served from cache instantly, refreshed in the background.
//    When a newer version is found, open pages get a message and show "update available".
//  * Libraries & fonts (CDN, versioned URLs): cached permanently.
//  * Supabase (data, login): never cached — always live.
const APP_CACHE = 'cafe-app-v2';
const CDN_CACHE = 'cafe-cdn-v1';
const CDN_HOSTS = ['cdn.jsdelivr.net', 'cdnjs.cloudflare.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k !== APP_CACHE && k !== CDN_CACHE) await caches.delete(k);
  await self.clients.claim();
})()));

let notified = false;
const stamp = (r) => r && (r.headers.get('etag') || r.headers.get('last-modified') || r.headers.get('content-length'));
async function tellClients() {
  if (notified) return;
  notified = true;
  for (const c of await self.clients.matchAll({ type: 'window' })) c.postMessage({ type: 'app-updated' });
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (CDN_HOSTS.includes(url.hostname)) {
    e.respondWith((async () => {
      const cache = await caches.open(CDN_CACHE);
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
      return res;
    })());
    return;
  }

  if (url.origin !== self.location.origin || url.pathname.endsWith('/sw.js')) return;

  e.respondWith((async () => {
    const cache = await caches.open(APP_CACHE);
    const key = req.mode === 'navigate' ? new Request(url.origin + url.pathname) : req;
    const hit = await cache.match(key);
    const refresh = fetch(new Request(key.url, { cache: 'no-cache', credentials: 'same-origin' }))
      .then(async (res) => {
        if (res.ok) {
          if (hit && stamp(hit) !== stamp(res)) tellClients();
          await cache.put(key, res.clone());
        }
        return res;
      });
    if (hit) { e.waitUntil(refresh.catch(() => {})); return hit; }
    return refresh;
  })());
});

// Tapping an order notification opens (or focuses) the ordering app
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = new URL((e.notification.data && e.notification.data.url) || 'order.html', self.registration.scope).href;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const w = wins.find((c) => c.url.startsWith(target.split('#')[0]));
    if (w) return w.focus();
    return self.clients.openWindow(target);
  })());
});
