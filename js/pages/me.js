import { h, put, btn, input, field, toast, toastError, busy } from '../ui.js';
import { t, lang, setLang } from '../i18n.js';
import { sb } from '../supabase.js';
import { rpc, errText } from '../api.js';
import { session } from '../session.js';
import { pinPassword, refreshDeviceUser } from '../pin.js';

const latin = (v) => String(v || '').replace(/[\u0660-\u0669\u06F0-\u06F9]/g, (d) => String((d.charCodeAt(0) & 0xF) % 10));

/** "My account": quick PIN, normal password, language. Every user can open it. */
export async function mePage(root) {
  const p = session.profile;
  const pinBox = h('div');
  let len = p.pin_length || 4;

  function drawPin() {
    const a = input({ type: 'password', inputmode: 'numeric', autocomplete: 'new-password', maxlength: String(len), dir: 'ltr', class: 'input pin-input' });
    const b = input({ type: 'password', inputmode: 'numeric', autocomplete: 'new-password', maxlength: String(len), dir: 'ltr', class: 'input pin-input' });
    [a, b].forEach((el) => el.addEventListener('input', () => { el.value = latin(el.value).replace(/\D/g, '').slice(0, len); }));
    const save = btn(p.pin_enabled ? t('pin_change') : t('pin_set'), () => busy(save, async () => {
      if (a.value.length !== len) { a.focus(); return toast(t('pin_len_hint', { n: len }), 'warn'); }
      if (a.value !== b.value) { b.focus(); return toast(t('pin_mismatch'), 'bad'); }
      if (/^(\d)\1+$/.test(a.value) || '0123456789'.includes(a.value) || '9876543210'.includes(a.value)) {
        return toast(t('pin_too_easy'), 'warn');
      }
      const { error } = await sb.auth.updateUser({ password: pinPassword(a.value) });
      if (error) return toast(errText(error), 'bad');
      try {
        await rpc('set_my_pin_flag', { p_enabled: true, p_length: len });
        Object.assign(session.profile, { pin_enabled: true, pin_length: len });
        refreshDeviceUser();
        toast(t('pin_saved'), 'ok');
        drawPin();
      } catch (e) { toastError(e); }
    }), 'primary');
    put(pinBox,
      h('div', { class: 'chips' }, [4, 6].map((n) => h('button', { type: 'button', class: 'chip' + (len === n ? ' on' : ''),
        onclick: () => { len = n; drawPin(); } }, t('pin_digits', { n })))),
      h('div', { class: 'grid-2' }, field(t('pin_new'), a), field(t('pin_repeat'), b)),
      h('div', { class: 'form-actions' }, save),
      p.pin_enabled ? h('div', { class: 'alert ok-soft small' }, t('pin_active', { n: p.pin_length })) : null);
  }

  // Back to a normal password (also turns the PIN off)
  const pw1 = input({ type: 'password', autocomplete: 'new-password', dir: 'ltr' });
  const pw2 = input({ type: 'password', autocomplete: 'new-password', dir: 'ltr' });
  const pwBtn = btn(t('pw_save'), () => busy(pwBtn, async () => {
    const v = latin(pw1.value);
    if (v.length < 6) return toast(t('pw_min'), 'warn');
    if (v !== latin(pw2.value)) return toast(t('pin_mismatch'), 'bad');
    const { error } = await sb.auth.updateUser({ password: v });
    if (error) return toast(errText(error), 'bad');
    try {
      await rpc('set_my_pin_flag', { p_enabled: false, p_length: null });
      Object.assign(session.profile, { pin_enabled: false, pin_length: null });
      refreshDeviceUser();
      pw1.value = pw2.value = '';
      toast(t('pw_saved'), 'ok'); drawPin();
    } catch (e) { toastError(e); }
  }));

  drawPin();
  root.append(
    h('section', { class: 'panel' },
      h('div', { class: 'me-head' },
        h('span', { class: 'avatar lg', 'aria-hidden': 'true' }, (p.full_name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase()),
        h('div', null, h('h2', null, p.full_name),
          h('div', { class: 'muted' }, `${p.username} · ${lang() === 'en' ? p.role_name_en : p.role_name_ar}`)))),
    h('section', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h2', null, t('pin_title'))),
      h('p', { class: 'muted small' }, t('pin_desc')),
      pinBox),
    h('section', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h2', null, t('pw_title'))),
      h('p', { class: 'muted small' }, t('pw_desc')),
      h('div', { class: 'grid-2' }, field(t('pw_new'), pw1), field(t('pin_repeat'), pw2)),
      h('div', { class: 'form-actions' }, pwBtn)),
    h('section', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h2', null, t('language'))),
      h('div', { class: 'chips' }, [['ar', 'العربية'], ['en', 'English']].map(([code, label]) =>
        h('button', { type: 'button', class: 'chip' + (lang() === code ? ' on' : ''), onclick: () => { if (lang() !== code) { setLang(code); location.reload(); } } }, label)))));
}
