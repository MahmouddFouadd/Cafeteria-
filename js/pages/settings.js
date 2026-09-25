import { h, put, toast, toastError } from '../ui.js';
import { t } from '../i18n.js';
import { setting, saveSetting, usePrep, loadSettings } from '../store.js';
import { backupExcel, backupJson } from '../backup.js';
import { fmtDateTime, fmtNum, btn } from '../ui.js';

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

  const cashBox = h('div', { class: 'choice-list' });
  function drawCash() {
    const on = setting('buffet_cash', true) === true;
    put(cashBox, [true, false].map((v) => h('button', {
      type: 'button', class: 'choice' + (on === v ? ' on' : ''), onclick: async () => {
        if (on === v) return;
        try { await saveSetting('buffet_cash', v); toast(t('saved'), 'ok'); drawCash(); } catch (e) { toastError(e); }
      },
    }, h('span', { class: 'choice-dot', 'aria-hidden': 'true' }),
      h('span', { class: 'choice-body' }, h('b', null, t(v ? 'set_bcash_on' : 'set_bcash_off')),
        h('span', { class: 'muted small' }, t(v ? 'set_bcash_on_hint' : 'set_bcash_off_hint'))))));
  }

  // ---------- Backup ----------
  const lastEl = h('div', { class: 'backup-last' });
  const progress = h('div', { class: 'backup-progress', hidden: true }, h('div', { class: 'bp-bar' }, h('span')), h('div', { class: 'muted small bp-text' }));
  function drawLast() {
    const at = setting('last_backup_at', null);
    const days = at ? Math.floor((Date.now() - new Date(at).getTime()) / 86400000) : null;
    put(lastEl, at
      ? h('div', { class: 'alert ' + (days >= 7 ? 'warn' : 'ok-soft') + ' small' }, t('backup_last', { at: fmtDateTime(at), d: days }))
      : h('div', { class: 'alert warn small' }, t('backup_never')));
  }
  const run = (fn) => async () => {
    btnX.disabled = btnJ.disabled = true; progress.hidden = false;
    const bar = progress.querySelector('.bp-bar span'), txt = progress.querySelector('.bp-text');
    try {
      const n = await fn((done, total, tbl) => {
        bar.style.width = `${total ? Math.round((done / total) * 100) : 100}%`;
        txt.textContent = t('backup_progress', { done: fmtNum(done), total: fmtNum(total), tbl });
      });
      await loadSettings(true).catch(() => {});
      drawLast();
      toast(t('backup_ok', { n: fmtNum(n) }), 'ok', 6000);
    } catch (e) { toastError(e); }
    finally { btnX.disabled = btnJ.disabled = false; setTimeout(() => { progress.hidden = true; }, 1500); }
  };
  const btnX = btn('⬇ ' + t('backup_excel'), run(backupExcel), 'primary');
  const btnJ = btn('⬇ ' + t('backup_json'), run(backupJson));
  drawLast();

  drawFlow(); drawIdle(); drawServe(); drawCash();
  root.append(
    h('section', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h2', null, t('backup_title'))),
      h('p', { class: 'muted small' }, t('backup_desc')),
      lastEl,
      h('div', { class: 'row', style: { gap: '8px', flexWrap: 'wrap' } }, btnX, btnJ),
      progress,
      h('p', { class: 'muted small' }, t('backup_keep'))),
    h('section', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h2', null, t('set_flow_title'))),
      h('p', { class: 'muted small' }, t('set_flow_desc')),
      flowBox),
    usePrep() ? null : h('section', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h2', null, t('set_serve_title'))),
      h('div', { class: 'choice-list' }, serveBox)),
    h('section', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h2', null, t('set_bcash_title'))), cashBox),
    h('section', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h2', null, t('set_idle_title'))),
      h('p', { class: 'muted small' }, t('set_idle_desc')),
      idleBox));
}
