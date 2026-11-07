import { h, icon, iconButton, confirmDialog, toast, fill } from '../dom.js';
import { t, tn, getLanguage, setLanguage, LANGUAGES } from '../i18n.js';
import { totals, load } from '../library.js';
import { clearEverything, getMeta, setMeta } from '../db.js';
import { getPref, setPref, PHOTO_QUALITIES } from '../prefs.js';
import { followTyping } from './editors.js';
import { forgetAll } from '../media.js';
import { chrome, $main, formatBytes, nav, goBack } from '../ui.js';
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

  const profileSlot = h('div');
  loadProfile().then((p) => fill(profileSlot, profileCard(p)));

  const photo = h('select', { class: 'field', 'aria-label': t('more.photoQuality'), onchange: (e) => { setPref('photoQuality', e.target.value); toast(t('editor.saved')); } },
    PHOTO_QUALITIES.map((q) => h('option', { value: q, selected: getPref('photoQuality') === q }, t(`quality.${q}`))));

  fill($main(),
    profileSlot,
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
    h('div', { class: 'card' },
      h('h2', {}, t('more.mediaQuality')),
      h('label', { class: 'form-field' }, h('span', { class: 'form-label' }, t('more.photoQuality')), photo),
      h('p', { class: 'small' }, t('more.qualityHint'))),
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

// --- profile (the app's Profile: who you are and what you train) -----------------------------------

const EMPTY_PROFILE = { displayName: '', username: '', bio: '', martialArts: [] };

async function loadProfile() {
  try {
    const p = await getMeta('profile', null);
    return p && typeof p === 'object' ? { ...EMPTY_PROFILE, ...p, martialArts: Array.isArray(p.martialArts) ? p.martialArts : [] } : { ...EMPTY_PROFILE };
  } catch {
    return { ...EMPTY_PROFILE };
  }
}

function profileCard(p) {
  const empty = !p.displayName && !p.username && !p.bio && p.martialArts.length === 0;
  if (empty) {
    return h('a', { class: 'card profile-card', href: '#/profile' },
      h('span', { class: 'avatar' }, icon('person', 30)),
      h('span', { class: 'item-body' }, h('b', {}, t('profile.setUp')), h('small', { class: 'muted' }, t('profile.setUpHint'))));
  }
  const initials = (p.displayName || p.username || '?').trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  return h('div', { class: 'card profile-card' },
    h('span', { class: 'avatar', dir: 'auto' }, initials),
    h('span', { class: 'item-body' },
      h('b', { dir: 'auto' }, p.displayName || p.username),
      p.username && p.displayName ? h('small', { class: 'muted', dir: 'ltr' }, `@${p.username}`) : null,
      p.bio ? h('span', { class: 'small prose', dir: 'auto' }, p.bio) : null,
      p.martialArts.length ? h('div', { class: 'chips' }, p.martialArts.map((m) => h('span', { class: 'chip', dir: 'auto' },
        [m.name, m.rank, m.yearsTraining ? t('profile.years', { n: m.yearsTraining }) : null].filter(Boolean).join(' · ')))) : null),
    iconButton('edit', t('profile.edit'), () => nav('/profile')));
}

export async function renderProfile() {
  chrome({ title: t('profile.edit'), back: '/more', tab: 'more' });
  const p = await loadProfile();
  const input = (value, attrs = {}) => followTyping(h('input', { class: 'field', type: 'text', value: value || '', autocomplete: 'off', ...attrs }));
  const name = input(p.displayName, { maxlength: 80 });
  const username = h('input', { class: 'field', type: 'text', value: p.username || '', autocomplete: 'off', dir: 'ltr', maxlength: 40, autocapitalize: 'off' });
  const bio = followTyping(h('textarea', { class: 'field', rows: 3, maxlength: 500 }));
  bio.value = p.bio || '';
  const rows = h('div', { class: 'link-rows' });
  const addArt = (m = { name: '', rank: '', yearsTraining: 0 }) => {
    const n = input(m.name, { placeholder: t('profile.artName'), 'aria-label': t('profile.artName') });
    const r = input(m.rank, { placeholder: t('profile.rank'), 'aria-label': t('profile.rank') });
    const y = h('input', { class: 'field years', type: 'number', min: 0, max: 80, inputmode: 'numeric', value: m.yearsTraining || '', placeholder: t('profile.yearsShort'), 'aria-label': t('profile.yearsLabel') });
    const row = h('div', { class: 'art-row' }, n, r, y, iconButton('close', t('common.remove'), () => row.remove()));
    row._value = () => ({ name: n.value.trim(), rank: r.value.trim(), yearsTraining: Math.max(0, Math.min(80, parseInt(y.value, 10) || 0)) });
    rows.append(row);
  };
  p.martialArts.forEach(addArt);
  if (!p.martialArts.length) addArt();
  const save = async () => {
    const next = {
      displayName: name.value.trim(), username: username.value.trim().replace(/^@/, ''), bio: bio.value.trim(),
      martialArts: [...rows.children].map((r) => r._value()).filter((m) => m.name),
    };
    await setMeta('profile', next);
    toast(t('editor.saved'));
    goBack('/more');
  };
  const field = (label, control) => h('label', { class: 'form-field' }, h('span', { class: 'form-label' }, label), control);
  fill($main(), h('form', { class: 'form', onsubmit: (e) => { e.preventDefault(); save(); } },
    field(t('profile.displayName'), name),
    field(t('profile.username'), username),
    field(t('profile.bio'), bio),
    h('div', { class: 'form-field' }, h('span', { class: 'form-label' }, t('profile.martialArts')), rows,
      h('button', { class: 'text-btn', type: 'button', onclick: () => addArt() }, icon('add', 18), t('profile.addArt'))),
    h('p', { class: 'small muted' }, t('profile.private')),
    h('button', { class: 'btn block', type: 'submit' }, t('common.save'))));
}
