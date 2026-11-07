import { h, icon, confirmDialog, toast, fill } from '../dom.js';
import { t, tn, getLanguage, setLanguage, LANGUAGES } from '../i18n.js';
import { totals, load } from '../library.js';
import { clearEverything } from '../db.js';
import { forgetAll } from '../media.js';
import { chrome, $main, formatBytes, nav } from '../ui.js';
import { shareExport } from '../share.js';
import { installHint } from './library.js';
import { ANDROID_APP_URL } from '../links.js';
import { APP_VERSION } from '../packages.js';

export function renderMore() {
  chrome({ title: t('more.title'), tab: 'more' });
  const s = totals();

  const storageText = h('p', { class: 'small muted' }, t('common.loading'));
  const persistLine = h('p', { class: 'small muted' });
  const persistBtn = h('button', {
    class: 'btn tonal', type: 'button', hidden: true,
    onclick: async () => {
      let ok = false;
      try { ok = await navigator.storage.persist(); } catch { /* unsupported */ }
      toast(ok ? t('more.persistYes') : t('more.persistNo'), 4000);
      refreshStorage();
    },
  }, t('more.persistAsk'));

  async function refreshStorage() {
    try {
      const est = navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null;
      storageText.textContent = est && est.quota
        ? t('more.storageUse', { used: formatBytes(est.usage || 0), quota: formatBytes(est.quota) })
        : t('more.storageUnknown');
      const persisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : false;
      persistLine.textContent = persisted ? t('more.persisted') : t('more.notPersisted');
      persistBtn.hidden = persisted || !(navigator.storage && navigator.storage.persist);
    } catch {
      storageText.textContent = t('more.storageUnknown');
    }
  }
  refreshStorage();

  const lang = h('select', { class: 'field', onchange: (e) => { setLanguage(e.target.value); } },
    h('option', { value: 'auto', selected: getLanguage() === 'auto' }, t('more.languageAuto')),
    LANGUAGES.map(([code, name]) => h('option', { value: code, selected: getLanguage() === code }, name)));

  fill($main(),
    h('div', { class: 'card' },
      h('h2', {}, t('more.libraryTitle')),
      h('p', {}, [tn('count.techniques', s.techniques), tn('count.groups', s.groups), tn('count.mediaFiles', s.media)].join(' • ')),
      h('p', { class: 'small muted' }, t('more.mediaSize', { size: formatBytes(s.bytes) })),
      storageText, persistLine, persistBtn),
    h('div', { class: 'card' },
      h('h2', {}, t('more.backupTitle')),
      h('p', {}, t('more.backupBody')),
      h('div', { class: 'stack' },
        h('button', { class: 'btn block', type: 'button', disabled: s.techniques + s.groups === 0, onclick: () => shareExport({ kind: 'library' }, true) }, icon('download', 20), t('more.backup')),
        h('button', { class: 'btn tonal block', type: 'button', disabled: s.techniques + s.groups === 0, onclick: () => shareExport({ kind: 'library' }, false) }, t('more.backupText')))),
    installHint(),
    LANGUAGES.length > 1 ? h('div', { class: 'card' },
      h('h2', {}, t('more.languageTitle')),
      lang) : null,
    h('div', { class: 'card' },
      h('h2', {}, t('more.androidTitle')),
      h('p', {}, t('more.androidBody')),
      h('p', {}, h('a', { href: ANDROID_APP_URL, target: '_blank', rel: 'noopener' }, t('more.androidApp')))),
    h('div', { class: 'card' },
      h('h2', {}, t('more.privacyTitle')),
      h('p', {}, t('more.privacyBody'))),
    h('div', { class: 'card danger-card' },
      h('h2', {}, t('more.deleteAllTitle')),
      h('p', {}, t('more.deleteAllBody')),
      h('button', {
        class: 'btn danger', type: 'button', disabled: s.techniques + s.groups + s.media === 0,
        onclick: async () => {
          const ok = await confirmDialog({ title: t('more.deleteAllConfirm'), body: t('more.deleteAllConfirmBody'), ok: t('more.deleteAllOk'), cancel: t('common.cancel'), danger: true });
          if (!ok) return;
          await clearEverything();
          forgetAll();
          await load();
          toast(t('more.deletedAll'));
          nav('/', { replace: true });
        },
      }, icon('trash', 20), t('more.deleteAllOk'))),
    h('p', { class: 'about small muted' }, t('more.version', { version: APP_VERSION })));
}
