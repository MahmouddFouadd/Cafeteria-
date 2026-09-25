import { session } from './session.js';

// Users remembered on this device (one-tap + PIN sign-in).
// A PIN is the user's Supabase password in a fixed shape, so no server secret is needed.
const DEVICE_KEY = 'cafeteria-device-users';
export const pinPassword = (pin) => `cafe-pin-${pin}`;

export function deviceUsers() {
  try { return JSON.parse(localStorage.getItem(DEVICE_KEY) || '[]'); } catch (_) { return []; }
}
function saveDeviceUsers(list) { try { localStorage.setItem(DEVICE_KEY, JSON.stringify(list.slice(0, 12))); } catch (_) {} }
export function rememberDeviceUser(p) {
  if (!p) return;
  const list = deviceUsers().filter((x) => x.u !== p.username);
  list.unshift({ u: p.username, name: p.full_name, role_ar: p.role_name_ar, role_en: p.role_name_en,
                 pin: !!p.pin_enabled, len: p.pin_length || 4 });
  saveDeviceUsers(list);
}
export function forgetDeviceUser(u) { saveDeviceUsers(deviceUsers().filter((x) => x.u !== u)); }
export const refreshDeviceUser = () => rememberDeviceUser(session.profile);
