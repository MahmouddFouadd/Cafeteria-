import { h, put, toast, toastError } from '../ui.js';
import { t } from '../i18n.js';
import { setting, saveSetting, usePrep } from '../store.js';

/** Settings that change how the buffet works day to day (admin only). */
export async function settingsPage(root) {
  const flowBox = h('div', { class: 'choice-list' });
  const idleBox = h('div', { class: 'chips' });

  function drawFlow() {
    const cur = usePrep();
    put(flowBox, [false, true].map((prep) => h('button', {
      type: 'button', class: 'choice' + (cur === prep ? ' on' : ''), 'aria-pressed': String(cur === prep),
      onclick: async () => {
        if (cur === prep) return;
        try { await saveSetting('use_preparation', prep); toast(t('saved'), 'ok'); drawFlow(); location.reload(); }
        catch (e) { toastError(e); }
      },
    },
      h('span', { class: 'choice-dot', 'aria-hidden': 'true' }),
      h('span', { class: 'choice-body' },
        h('b', null, t(prep ? 'set_flow_prep' : 'set_flow_simple')),
        h('span', { class: 'muted small' }, t(prep ? 'set_flow_prep_hint' : 'set_flow_simple_hint'))))));
  }

  function drawIdle() {
    const cur = Number(setting('idle_minutes', 30));
    put(idleBox, [15, 30, 45, 60, 120].map((m) => h('button', {
      type: 'button', class: 'chip' + (cur === m ? ' on' : ''),
      onclick: async () => {
        try { await saveSetting('idle_minutes', m); toast(t('saved'), 'ok'); drawIdle(); }
        catch (e) { toastError(e); }
      },
    }, t('minutes_n', { n: m }))));
  }

  const serveBox = h('div');
  function drawServe() {
    const on = setting('serve_on_create', false) === true;
    put(serveBox, [false, true].map((v) => h('button', {
      type: 'button', class: 'choice' + (on === v ? ' on' : ''), onclick: async () => {
        if (on === v) return;
        try { await saveSetting('serve_on_create', v); toast(t('saved'), 'ok'); drawServe(); } catch (e) { toastError(e); }
      },
    }, h('span', { class: 'choice-dot', 'aria-hidden': 'true' }),
      h('span', { class: 'choice-body' }, h('b', null, t(v ? 'set_serve_auto' : 'set_serve_manual')),
        h('span', { class: 'muted small' }, t(v ? 'set_serve_auto_hint' : 'set_serve_manual_hint'))))));
  }

  drawFlow(); drawIdle(); drawServe();
  root.append(
    h('section', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h2', null, t('set_flow_title'))),
      h('p', { class: 'muted small' }, t('set_flow_desc')),
      flowBox),
    usePrep() ? null : h('section', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h2', null, t('set_serve_title'))),
      h('div', { class: 'choice-list' }, serveBox)),
    h('section', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h2', null, t('set_idle_title'))),
      h('p', { class: 'muted small' }, t('set_idle_desc')),
      idleBox));
}
