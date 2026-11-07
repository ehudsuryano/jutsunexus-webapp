import { h, icon, toast, pickFiles, fill } from '../dom.js';
import { t, tn, lang } from '../i18n.js';
import { uuid, newTechnique, childGroups, childTechniques, commit, validGroupId } from '../library.js';
import { chrome, $main, nav, routes, groupOptions, techniqueHead, techniqueSections, formatBytes, isIos } from '../ui.js';
import { fileSource, urlSource, resolveDownloadUrl } from '../zip.js';
import { readPackage, importPackage } from '../packages.js';
import { extractTechniqueToken, decodeTechniqueToken, isDirectSendLink, ANDROID_APP_URL } from '../links.js';
import { isQuotaError } from '../db.js';
import { driveFileIdFrom, driveSource, DriveError } from '../drive.js';
import { driveErrorText } from './drivescreen.js';
import { installHint } from './library.js';

const urlErrors = () => ({
  notLink: t('import.notLink'), drive: t('import.driveBlocked'), blocked: t('import.blocked'),
  notPublic: t('import.notPublic'), gone: t('import.gone'), http: t('import.http'), html: t('import.html'),
});

/** A link handed to the page as ?open=… waits here until the import screen picks it up. */
let pendingLink = null;
export function setPendingLink(link) { pendingLink = link; }

export function renderImport(dest) {
  const destination = dest && dest !== 'root' ? validGroupId(dest) : null;
  chrome({ title: t('import.title'), tab: 'import', back: dest ? routes.group(destination) : null });

  const status = h('div');
  const showError = (msg) => fill(status, h('div', { class: 'card error-box' }, h('p', {}, msg)));

  const open = async (sourcePromise, label) => {
    fill(status, h('p', { class: 'loading' }, t('import.opening', { name: label })));
    try {
      const pkg = await readPackage(await sourcePromise);
      preview(pkg, destination, status);
    } catch (e) {
      showError((e && e.message) || String(e));
    }
  };
  const openDrive = async (fileId) => {
    fill(status, h('p', { class: 'loading' }, t('import.openingDrive')));
    try {
      const pkg = await readPackage(await driveSource(fileId));
      preview(pkg, destination, status);
    } catch (e) {
      // If Drive itself won't hand it over, the download-then-pick route still works.
      if (e instanceof DriveError && e.code !== 'notPublic' && e.code !== 'gone') {
        driveHelp(status, `https://drive.google.com/file/d/${fileId}/view`, driveErrorText(e));
      } else showError(e instanceof DriveError ? driveErrorText(e) : ((e && e.message) || String(e)));
    }
  };

  const pickBtn = h('button', {
    class: 'btn block', type: 'button',
    onclick: async () => {
      const [file] = await pickFiles({ accept: '.zip,application/zip,application/x-zip-compressed' });
      if (file) open(fileSource(file), file.name);
    },
  }, icon('zip', 20), t('import.pick'));

  const linkInput = h('input', {
    class: 'field', type: 'url', inputmode: 'url', dir: 'ltr', autocomplete: 'off', placeholder: t('import.linkPlaceholder'), 'aria-label': t('import.linkLabel'),
  });
  const openLink = (value) => {
    const v = String(value || '').trim();
    if (!v) return;
    const token = extractTechniqueToken(v);
    if (token) { nav(`/link/${token}`); return; }
    if (isDirectSendLink(v)) { showError(t('import.directSend')); return; }
    // Drive links (#d1. from the app, or a plain Drive share link) are read through the Drive API.
    const driveId = driveFileIdFrom(v);
    if (driveId) { openDrive(driveId); return; }
    const resolved = resolveDownloadUrl(v);
    open(urlSource(v, urlErrors()), resolved || v);
  };
  const linkForm = h('form', { class: 'link-row', onsubmit: (e) => { e.preventDefault(); openLink(linkInput.value); } },
    linkInput, h('button', { class: 'btn', type: 'submit' }, t('import.open')));

  // Drag and drop for computers.
  const drop = h('div', { class: 'dropzone' }, pickBtn, h('p', {}, t('import.pickHint')));
  const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { stop(e); drop.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { stop(e); drop.classList.remove('drag'); }));
  drop.addEventListener('drop', (e) => {
    const file = e.dataTransfer && e.dataTransfer.files[0];
    if (file) open(fileSource(file), file.name);
  });

  fill($main(),
    status,
    drop,
    h('div', { class: 'card' }, h('h2', {}, t('import.linkTitle')), h('p', {}, t('import.linkBody')), linkForm),
    isIos() ? h('div', { class: 'card' },
      h('h2', {}, t('import.iosTitle')),
      h('ol', {}, h('li', {}, t('import.ios1')), h('li', {}, t('import.ios2')), h('li', {}, t('import.ios3')), h('li', {}, t('import.ios4')))) : null,
    h('div', { class: 'card' }, h('h2', {}, t('import.privacyTitle')), h('p', {}, t('import.privacyBody'))));

  if (pendingLink) {
    const link = pendingLink;
    pendingLink = null;
    linkInput.value = link;
    openLink(link);
  }
}

function driveHelp(status, link, reason) {
  fill(status, h('div', { class: 'card hint' },
    h('h2', {}, t('import.driveTitle')),
    reason ? h('p', { class: 'small warn' }, reason) : null,
    h('ol', {}, h('li', {}, t('import.drive1')), h('li', {}, t('import.drive2')), h('li', {}, t('import.drive3'))),
    h('a', { class: 'btn block', href: link, target: '_blank', rel: 'noopener' }, t('import.openDrive'))));
}

function preview(pkg, destination, status) {
  const m = pkg.manifest;
  const title = pkg.rootName || pkg.source.name.replace(/\.zip$/i, '').replace(/_/g, ' ');
  const dest = h('select', { class: 'field' }, groupOptions(destination));
  const bar = h('progress', { max: 1, value: 0, hidden: true });
  const progressText = h('p', { class: 'small muted', hidden: true });
  const counts = [
    tn('count.techniques', pkg.techniques.length),
    pkg.groups.length ? tn('count.groups', pkg.groups.length) : null,
    pkg.media.length ? `${tn('count.mediaFiles', pkg.media.length)} (${formatBytes(pkg.mediaBytes)})` : null,
  ].filter(Boolean).join(' • ');

  const go = h('button', { class: 'btn block', type: 'button' }, t('import.importNow'));
  go.addEventListener('click', async () => {
    go.disabled = true;
    dest.disabled = true;
    bar.hidden = false;
    progressText.hidden = false;
    progressText.textContent = t('import.saving');
    // Ask the browser not to clear the library when space runs low. Never wait for the answer:
    // Firefox shows a permission prompt and its promise waits until it is answered (or forever).
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {}); } catch { /* optional */ }
    try {
      const where = dest.value || null;
      const result = await importPackage(pkg, where, (done, total) => {
        bar.max = Math.max(1, total);
        bar.value = done;
        progressText.textContent = t('import.savingFiles', { done, total });
      });
      let msg = t('import.done', { techniques: result.techniques, media: result.media });
      if (result.skipped) msg += ` ${tn('import.skipped', result.skipped)}`;
      toast(msg, 4000);
      nav(routes.group(validGroupId(where)), { replace: true });
    } catch (e) {
      go.disabled = false;
      dest.disabled = false;
      bar.hidden = true;
      progressText.hidden = true;
      fill(status, h('div', { class: 'card error-box' }, h('p', {}, isQuotaError(e) ? t('import.noSpace') : ((e && e.message) || String(e)))));
    }
  });

  fill(status, h('div', { class: 'card preview' },
    h('h2', {}, t('import.previewTitle')),
    h('p', { class: 'preview-name', dir: 'auto' }, title),
    h('p', { class: 'small muted' }, counts),
    m.exportedAt ? h('p', { class: 'small muted' }, t('import.exportedOn', { date: new Date(m.exportedAt).toLocaleDateString(lang) })) : null,
    m.includesMedia === false ? h('p', { class: 'small muted' }, t('import.noMedia')) : null,
    h('label', { class: 'form-field' }, h('span', { class: 'form-label' }, t('import.into')), dest),
    go, bar, progressText));
  estimateWarning(pkg.mediaBytes).then((w) => { if (w) status.firstChild.append(h('p', { class: 'small warn' }, w)); });
}

async function estimateWarning(bytes) {
  try {
    if (!navigator.storage || !navigator.storage.estimate || !bytes) return null;
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    if (quota && quota - usage < bytes * 1.1) return t('import.mayNotFit', { size: formatBytes(bytes), free: formatBytes(quota - usage) });
  } catch { /* unknown */ }
  return null;
}

// --- technique links (#t1.…) ------------------------------------------------------------------

export function renderLink(token) {
  chrome({ title: t('link.title'), tab: 'import', back: '/import' });
  let x;
  try {
    x = decodeTechniqueToken(token);
  } catch (e) {
    fill($main(), h('div', { class: 'card error-box' }, h('p', {}, e.message)));
    return;
  }
  const saveBtn = h('button', {
    class: 'btn block', type: 'button',
    onclick: async () => {
      const row = { ...newTechnique(null), ...x, id: uuid() };
      const taken = new Set([...childGroups(null), ...childTechniques(null)].map((r) => r.name.toLowerCase()));
      if (taken.has(row.name.toLowerCase())) {
        let c = 2;
        while (taken.has(`${row.name.toLowerCase()} (${c})`)) c++;
        row.name = `${row.name} (${c})`;
      }
      await commit({ techniques: [row] });
      toast(t('link.saved'));
      nav(routes.technique(row.id), { replace: true });
    },
  }, icon('add', 20), t('link.save'));
  fill($main(),
    techniqueHead(x),
    ...techniqueSections(x),
    h('div', { class: 'card add-box' },
      h('h2', {}, t('link.keepTitle')),
      h('p', {}, t('link.keepBody')),
      saveBtn),
    h('p', { class: 'muted small section' }, t('link.textOnly')));
}

/** Pages for the app-only link kinds, if someone opens one here. */
export function renderAppOnly(kind) {
  chrome({ title: t('import.title'), tab: 'import' });
  fill($main(), h('div', { class: 'card error-box' },
    h('p', {}, kind === 'send' ? t('import.directSend') : t('import.driveBlocked')),
    h('p', {}, h('a', { href: ANDROID_APP_URL }, t('more.androidApp')))));
}

