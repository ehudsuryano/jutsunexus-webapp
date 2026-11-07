/**
 * "Send by Drive link", as in the Android app (DrivePublishScreen): upload a copy with its videos
 * to the user's own Google Drive and get a link that works with this phone off. Uploading again
 * keeps the link; Stop sharing deletes the file. Which items are shared is kept in this browser.
 */
import { h, icon, fill, toast, confirmDialog } from '../dom.js';
import { t } from '../i18n.js';
import { lib } from '../library.js';
import { getMeta, setMeta } from '../db.js';
import { chrome, $main, routes, formatBytes } from '../ui.js';
import { exportPackage } from '../packages.js';
import {
  loadGoogleSignIn, signIn, signInReady, signOut, isSignedIn, driveAccount, publishPackage, deleteDriveFile,
  driveShareLink, DriveError,
} from '../drive.js';
import { qrDataUrl } from './sharescreens.js';

const PUBS_KEY = 'drivePublications';

async function publications() {
  try { return (await getMeta(PUBS_KEY, null)) || {}; } catch { return {}; }
}
async function savePublication(key, pub) {
  const all = await publications();
  if (pub) all[key] = pub; else delete all[key];
  await setMeta(PUBS_KEY, all);
}

export function driveErrorText(e) {
  if (e instanceof DriveError) {
    const known = ['notPublic', 'gone', 'offline', 'full', 'noAccess', 'cancelled', 'popup', 'busy', 'signedOut'];
    return known.includes(e.code) ? t(`drive.err.${e.code}`) : t('drive.err.failed', { detail: e.detail || e.code });
  }
  return (e && e.message) || String(e);
}

function targetOf(kind, id) {
  if (kind === 'technique') { const x = lib.techniques.get(id); return x ? { target: { kind, id }, name: x.name, back: routes.technique(id) } : null; }
  if (kind === 'group') { const g = lib.groups.get(id); return g ? { target: { kind, id }, name: g.name, back: routes.group(id) } : null; }
  return { target: { kind: 'library' }, name: t('library.title'), back: '/more' };
}

let account = null;

export async function renderDrive(kind, id) {
  const info = targetOf(kind, id);
  chrome({ title: t('drive.title'), back: info ? info.back : '/', tab: kind === 'library' ? 'more' : 'library' });
  if (!info) { fill($main(), h('p', { class: 'empty' }, t('map.gone'))); return; }
  const key = kind === 'library' ? 'LIBRARY' : `${kind.toUpperCase()}:${id}`;
  const pub = (await publications())[key] || null;

  const status = h('div');
  const progress = h('progress', { max: 1, value: 0, hidden: true });
  let busy = null; // AbortController while uploading

  // Google's sign-in window has to open straight from the tap, so its script loads now.
  const ready = loadGoogleSignIn().then(() => true, () => false);

  const setStatus = (text, cls = 'muted') => fill(status, text ? h('p', { class: `small ${cls}` }, text) : null);

  async function upload() {
    if (busy) return;
    // Nothing may be awaited before signIn(): browsers only open Google's window straight from a tap.
    if (!signInReady()) { setStatus(t('drive.loadingGoogle'), 'warn'); ready.then((ok) => setStatus(ok ? '' : t('drive.err.offline'), ok ? 'muted' : 'warn')); return; }
    let signing;
    try { signing = signIn(); } catch (e) { setStatus(driveErrorText(e), 'warn'); return; } // opens Google's window now
    busy = new AbortController();
    draw();
    try {
      setStatus(t('drive.signingIn'));
      await signing;
      driveAccount().then((a) => { account = a; drawAccount(); }).catch(() => {});
      setStatus(t('drive.preparing'));
      progress.hidden = false;
      const exported = await exportPackage(info.target, true, (done, total) => { progress.max = Math.max(1, total); progress.value = done; });
      if (busy.signal.aborted) throw new DriveError('cancelled');
      const total = exported.blob.size;
      setStatus(t('drive.uploading', { sent: formatBytes(0), total: formatBytes(total) }));
      const result = await publishPackage(exported.blob, exported.fileName, pub ? pub.fileId : null, (sent, all) => {
        progress.max = Math.max(1, all);
        progress.value = sent;
        setStatus(sent >= all ? t('drive.almostDone') : t('drive.uploading', { sent: formatBytes(sent), total: formatBytes(all) }));
      }, busy.signal);
      await savePublication(key, { fileId: result.fileId, name: info.name, sizeBytes: total, publishedAt: Date.now() });
      toast(result.linkChanged ? t('drive.newLink') : pub ? t('drive.updated') : t('drive.shared'), 5000);
      busy = null;
      renderDrive(kind, id);
    } catch (e) {
      busy = null;
      progress.hidden = true;
      if (e instanceof DriveError && e.code === 'cancelled') setStatus('');
      else setStatus(driveErrorText(e), 'warn');
      draw();
    }
  }

  async function stop() {
    // Sign in first, from the tap, if needed; then ask.
    let signing = null;
    if (!isSignedIn()) {
      if (!signInReady()) { setStatus(t('drive.loadingGoogle'), 'warn'); return; }
      try { signing = signIn(); } catch (e) { setStatus(driveErrorText(e), 'warn'); return; } }
    const ok = await confirmDialog({ title: t('drive.stopTitle'), body: t('drive.stopBody'), ok: t('drive.deleteFromDrive'), cancel: t('drive.keepSharing'), danger: true });
    if (!ok) return;
    try {
      if (signing) await signing;
      await deleteDriveFile(pub.fileId);
      await savePublication(key, null);
      toast(t('drive.deleted'), 4000);
      renderDrive(kind, id);
    } catch (e) {
      setStatus(driveErrorText(e), 'warn');
    }
  }

  const accountLine = h('p', { class: 'small muted drive-account' });
  function drawAccount() {
    fill(accountLine, account && isSignedIn()
      ? [h('span', {}, t('drive.account', { account })), ' ', h('button', { class: 'text-btn', type: 'button', onclick: () => { signOut(); account = null; drawAccount(); } }, t('drive.signOut'))]
      : null);
  }

  const body = h('div');
  function draw() {
    const uploading = !!busy;
    const cancelBtn = uploading ? h('button', { class: 'btn tonal block', type: 'button', onclick: () => busy && busy.abort() }, t('common.cancel')) : null;
    if (!pub) {
      fill(body,
        h('div', { class: 'card' }, h('h2', { dir: 'auto' }, info.name), h('p', {}, t('drive.intro'))),
        h('div', { class: 'stack section' },
          h('button', { class: 'btn block', type: 'button', disabled: uploading, onclick: upload }, icon('upload', 20), t('drive.upload')),
          cancelBtn),
        status, progress,
        uploading ? h('p', { class: 'small muted' }, t('drive.keepOpen')) : null);
      return;
    }
    const link = driveShareLink(pub.fileId);
    const qr = qrDataUrl(link);
    fill(body,
      h('div', { class: 'card' },
        h('h2', { dir: 'auto' }, info.name),
        h('p', { class: 'small muted' }, t('drive.meta', { size: formatBytes(pub.sizeBytes), when: new Date(pub.publishedAt).toLocaleString() })),
        h('input', { class: 'field drive-link', readonly: true, value: link, dir: 'ltr', onfocus: (e) => e.target.select() }),
        h('div', { class: 'stack', style: { marginTop: '10px' } },
          h('button', {
            class: 'btn block', type: 'button',
            onclick: async () => {
              if (navigator.share) { try { await navigator.share({ title: info.name, url: link }); return; } catch (e) { if (e && e.name === 'AbortError') return; } }
              try { await navigator.clipboard.writeText(link); toast(t('share.linkCopied')); } catch { toast(t('share.copyFailed')); }
            },
          }, icon('share', 20), t('qr.shareLink')),
          h('button', { class: 'btn tonal block', type: 'button', onclick: async () => { try { await navigator.clipboard.writeText(link); toast(t('share.linkCopied')); } catch { toast(t('share.copyFailed')); } } }, icon('link', 20), t('qr.copyLink'))),
        qr ? h('img', { class: 'qr-img drive-qr', src: qr, alt: t('qr.a11y', { name: info.name }) }) : null,
        h('p', { class: 'small' }, t('drive.anyone'))),
      h('div', { class: 'card' },
        h('h2', {}, t('drive.changed')), h('p', {}, t('drive.changedBody')),
        h('div', { class: 'stack' },
          h('button', { class: 'btn tonal block', type: 'button', disabled: uploading, onclick: upload }, icon('upload', 20), t('drive.uploadLatest')),
          cancelBtn)),
      status, progress,
      uploading ? h('p', { class: 'small muted' }, t('drive.keepOpen')) : null,
      h('div', { class: 'card danger-card' },
        h('button', { class: 'btn danger', type: 'button', disabled: uploading, onclick: stop }, icon('trash', 20), t('drive.stop'))));
  }

  fill($main(), body, accountLine);
  draw();
  drawAccount();
}
