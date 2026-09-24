import { sb } from './supabase.js';
import { t } from './i18n.js';

export class AppError extends Error {}

export function errText(e) {
  const msg = (e && (e.message || e.error_description)) || String(e);
  const m = msg.match(/^([A-Z_]+)(?::(.*))?$/s);
  if (m) {
    const key = 'err.' + m[1];
    const tr = t(key);
    if (tr !== key) return m[2] ? `${tr} (${m[2]})` : tr;
  }
  if (/Invalid login credentials/i.test(msg)) return t('err.LOGIN');
  if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) return t('err.NETWORK');
  if (/row-level security|permission denied/i.test(msg)) return t('err.PERMISSION_DENIED');
  if (/duplicate key/i.test(msg)) return t('err.DUPLICATE');
  if (/violates foreign key/i.test(msg)) return t('err.IN_USE');
  return msg;
}

export async function rpc(fn, args = {}) {
  const { data, error } = await sb.rpc(fn, args);
  if (error) throw new AppError(errText(error));
  return data;
}

export async function q(builder) {
  const { data, error } = await builder;
  if (error) throw new AppError(errText(error));
  return data;
}
