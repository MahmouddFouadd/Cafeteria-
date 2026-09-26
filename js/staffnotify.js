// Buffet alerts for new orders from the employee app.
//  * Push (arrives even when the staff app is closed) once notifications are allowed.
//  * While the app is open: a short sound, vibration and a toast for every new app order.
import { sb } from './supabase.js';
import { rpc } from './api.js';
import { toast } from './ui.js';
import { can } from './session.js';

let pushOn = false, timer = null, seen = null;

function b64ToBytes(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

export const staffPushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
export const staffPushState = () => (!staffPushSupported() ? 'unsupported' : Notification.permission);

export async function ensureStaffPush() {
  try {
    if (!can('orders.queue') || !staffPushSupported() || Notification.permission !== 'granted') return false;
    const key = await rpc('self_vapid_key');
    if (!key) return false;
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(key) });
    const j = sub.toJSON();
    await rpc('staff_push_subscribe', { p_endpoint: j.endpoint, p_p256dh: j.keys.p256dh, p_auth: j.keys.auth });
    pushOn = true;
    return true;
  } catch (e) { console.warn('staff push', e); return false; }
}

export async function askStaffNotifications() {
  if (!staffPushSupported()) return false;
  const r = await Notification.requestPermission();
  return r === 'granted' ? ensureStaffPush() : false;
}

function beep() {
  try {
    const c = new (window.AudioContext || window.webkitAudioContext)();
    [0, 0.2, 0.4].forEach((t0) => {
      const o = c.createOscillator(); const g = c.createGain();
      o.frequency.value = 988; g.gain.value = 0.12; o.connect(g); g.connect(c.destination);
      o.start(c.currentTime + t0); o.stop(c.currentTime + t0 + 0.12);
    });
  } catch (_) { /* optional */ }
}

/** Watch for new app orders while the staff app is open (every 10 s). */
export function startNewOrderWatch() {
  stopNewOrderWatch();
  if (!can('orders.queue')) return;
  const check = async () => {
    try {
      const { data } = await sb.from('v_orders').select('id, order_no, consumer_name, pay_request')
        .eq('source', 'SELF').eq('fulfillment_status', 'NEW').order('id', { ascending: false }).limit(20);
      const rows = data || [];
      if (seen === null) { seen = new Set(rows.map((r) => r.id)); return; }      // first look: don't alert for old ones
      const fresh = rows.filter((r) => !seen.has(r.id));
      fresh.forEach((r) => seen.add(r.id));
      if (!fresh.length) return;
      beep(); navigator.vibrate?.([200, 100, 200]);
      for (const r of fresh) {
        const text = `📱 طلب جديد ${r.order_no} · ${r.consumer_name || ''} — ${r.pay_request === 'CASH' ? 'كاش' : 'على الحساب'}`;
        toast(text, 'ok', 8000);
        if (!pushOn && document.hidden && Notification?.permission === 'granted') {
          const reg = await navigator.serviceWorker?.ready;
          reg?.showNotification('طلب جديد من التطبيق 📱', { body: text, tag: 'new-' + r.id, data: { url: 'index.html#/queue' }, icon: 'assets/img/icon-192.png' });
        }
      }
      if (location.hash.startsWith('#/queue')) window.dispatchEvent(new Event('hashchange'));   // refresh the list
    } catch (_) { /* network hiccup: try next time */ }
  };
  check();
  timer = setInterval(check, 10000);
}

export function stopNewOrderWatch() { clearInterval(timer); timer = null; seen = null; }
