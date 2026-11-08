import { h, icon, toast, pickFiles, fill, confirmDialog } from '../dom.js';
import { t, tn, lang } from '../i18n.js';
import { lib, uuid, newTechnique, childGroups, childTechniques, commit, validGroupId } from '../library.js';
import { chrome, $main, nav, routes, groupOptions, techniqueHead, techniqueSections, formatBytes, isIos } from '../ui.js';
import { fileSource, urlSource, resolveDownloadUrl } from '../zip.js';
import { readPackage, importPackage } from '../packages.js';
import { extractTechniqueToken, decodeTechniqueToken, isDirectSendLink, ANDROID_APP_URL } from '../links.js';
import { isQuotaError } from '../db.js';
import { driveFileIdFrom, driveSource, DriveError } from '../drive.js';
import { listSubscriptions, subscribe, checkForUpdate, unsubscribe, sourceLabel, lockedGroupIds } from '../subscriptions.js';
import { driveErrorText } from './drivescreen.js';
import { installHint } from './library.js';
import { scanButton } from '../scan.js';

const urlErrors = () => ({
  notLink: t('import.notLink'), drive: t('import.driveBlocked'), blocked: t('import.blocked'),
  notPublic: t('import.notPublic'), gone: t('import.gone'), http: t('import.http'), html: t('import.html'),
});

/** A link handed to the page as ?open=… waits here until the import screen picks it up. */
let pendingLink = null;
export function setPendingLink(link) { pendingLink = link; }

export function renderImport(dest) {
  let destination = dest && dest !== 'root' ? validGroupId(dest) : null;
  if (destination && lockedGroupIds().has(destination)) destination = null;
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
  const drop = h('div', { class: 'dropzone' }, pickBtn, h('p', {}, t('import.pickHint')),
    h('div', { class: 'scan-row' }, scanButton((text) => { linkInput.value = text; openLink(text); })));
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
    subscriptionsCard(),
    isIos() ? h('div', { class: 'card' },
      h('h2', {}, t('import.iosTitle')),
      h('ol', {}, h('li', {}, t('import.ios1')), h('li', {}, t('import.ios3')), h('li', {}, t('import.ios4'))),
      h('p', {}, t('import.ios2'))) : null,
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

  const link = pkg.source.link || null; // only a package behind a link can be followed for updates
  const go = h('button', { class: 'btn block', type: 'button' }, link ? t('subs.importOnce') : t('import.importNow'));
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
    go, bar, progressText,
    link ? subscribeBox(pkg, link, title, [go, dest]) : null));
  estimateWarning(pkg.mediaBytes).then((w) => { if (w) status.firstChild.append(h('p', { class: 'small warn' }, w)); });
}

/** "Subscribe to this syllabus": a read-only group that follows the link's updates. */
function subscribeBox(pkg, link, title, others) {
  const name = h('input', { class: 'field', type: 'text', value: pkg.rootName || title, dir: 'auto', maxlength: 120, placeholder: t('subs.namePlaceholder') });
  const bar = h('progress', { max: 1, value: 0, hidden: true });
  const msg = h('p', { class: 'small muted', hidden: true });
  const btn = h('button', { class: 'btn tonal block', type: 'button' }, icon('school', 20), t('subs.subscribe'));
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    for (const o of others) o.disabled = true;
    bar.hidden = false;
    msg.hidden = false;
    msg.textContent = t('subs.subscribing');
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {}); } catch { /* optional */ }
    try {
      const { rootGroupId, result } = await subscribe(pkg, link, name.value, (done, total) => {
        bar.max = Math.max(1, total);
        bar.value = done;
        msg.textContent = t('import.savingFiles', { done, total });
      });
      toast(t('subs.subscribedTo', { name: name.value.trim() || t('subs.defaultName') }) + ' — ' + t('import.done', { techniques: result.techniques, media: result.media }), 5000);
      nav(routes.group(rootGroupId), { replace: true });
    } catch (e) {
      btn.disabled = false;
      for (const o of others) o.disabled = false;
      bar.hidden = true;
      msg.textContent = isQuotaError(e) ? t('import.noSpace') : (e instanceof DriveError ? driveErrorText(e) : ((e && e.message) || String(e)));
      msg.className = 'small warn';
    }
  });
  return h('div', { class: 'subscribe-box' },
    h('h3', {}, t('subs.subscribeTitle')),
    h('p', { class: 'small muted' }, t('subs.from', { source: sourceLabel(link) })),
    h('label', { class: 'form-field' }, h('span', { class: 'form-label' }, t('subs.nameInLibrary')), name),
    h('p', { class: 'small muted' }, t('subs.subscribeHint')),
    btn, bar, msg);
}

/** The "Subscribed syllabi" card: each with Check for updates and Unsubscribe; Check all. */
function subscriptionsCard() {
  const box = h('div', { class: 'card subs-card' });
  const draw = () => {
    const subs = listSubscriptions();
    if (!subs.length) {
      fill(box, h('h2', {}, t('subs.title')), h('p', {}, t('subs.none')), h('p', { class: 'small' }, t('subs.noneCaption')));
      return;
    }
    const checkOne = async (sub, row) => {
      const status = row.querySelector('.sub-status');
      const btns = row.querySelectorAll('button');
      btns.forEach((b) => { b.disabled = true; });
      status.className = 'sub-status small muted';
      status.textContent = t('subs.checking');
      const name = lib.groups.get(sub.rootGroupId)?.name || '';
      try {
        const r = await checkForUpdate(sub, (done, total) => { status.textContent = t('import.savingFiles', { done, total }); });
        toast(r.status === 'UP_TO_DATE' ? t('subs.upToDate', { name }) : t('subs.updated', { name }) + ' — ' + t('import.done', { techniques: r.result.techniques, media: r.result.media }), 4000);
        draw();
      } catch (e) {
        btns.forEach((b) => { b.disabled = false; });
        status.className = 'sub-status small warn';
        status.textContent = `${t('subs.updateFailed')}: ${e instanceof DriveError ? driveErrorText(e) : ((e && e.message) || String(e))}`;
      }
    };
    const rows = subs.map((sub) => {
      const g = lib.groups.get(sub.rootGroupId);
      const row = h('div', { class: 'sub-row' },
        h('a', { class: 'sub-name', href: `#${routes.group(sub.rootGroupId)}`, dir: 'auto' }, icon('school', 20), g ? g.name : '?'),
        h('p', { class: 'small muted' }, t('subs.meta', {
          source: sourceLabel(sub.url),
          date: sub.packageExportedAt ? new Date(sub.packageExportedAt).toLocaleDateString(lang) : '—',
          when: new Date(sub.lastCheckedAt).toLocaleString(lang),
        })),
        h('p', { class: 'sub-status small muted' }),
        h('div', { class: 'row' },
          h('button', { class: 'btn small-btn', type: 'button', onclick: () => checkOne(sub, row) }, icon('reset', 18), t('subs.check')),
          h('button', {
            class: 'text-btn', type: 'button',
            onclick: async () => {
              const ok = await confirmDialog({ title: t('subs.unsubscribeTitle', { name: g ? g.name : '' }), body: t('subs.unsubscribeBody'), ok: t('subs.unsubscribe'), cancel: t('common.cancel'), danger: true });
              if (!ok) return;
              await unsubscribe(sub);
              toast(t('library.deleted'));
              draw();
            },
          }, t('subs.unsubscribe'))));
      return { sub, row };
    });
    const checkAll = h('button', {
      class: 'text-btn', type: 'button',
      onclick: async () => { for (const { sub, row } of rows) { if (row.isConnected) await checkOne(sub, row); } },
    }, t('subs.checkAll'));
    fill(box, h('div', { class: 'section-head' }, h('h2', {}, t('subs.title')), h('span', { class: 'spacer' }), subs.length > 1 ? checkAll : null),
      rows.map((r) => r.row));
  };
  draw();
  return box;
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

