/**
 * "Share as link or QR" and "Share to YouTube", after the Android app's TechniqueQrScreen and
 * YouTubeShareScreen.
 *
 * YouTube: a web page can't open the YouTube app's upload screen directly; it hands the clip to
 * the phone's share sheet, where YouTube is one of the choices. As in the app, the title and
 * description are copied for pasting, because YouTube ignores a title passed along with the file.
 * Joining all clips into one video needs a video encoder, which browsers don't have.
 */
import { h, icon, fill, toast } from '../dom.js';
import { t } from '../i18n.js';
import { lib, mediaOf } from '../library.js';
import { chrome, $main, routes, formatDuration, formatBytes } from '../ui.js';
import { techniqueViewerLink } from '../links.js';
import { getBlob } from '../db.js';
import { mediaThumb, thumbNode } from '../media.js';

/** Past this a QR code stops being scannable from a phone at arm's length; the link still works. */
const QR_COMFORTABLE_LENGTH = 1200;
/** Version 40 at error-correction L holds 2953 bytes. */
const QR_MAX_LENGTH = 2900;
const QR_TARGET_PX = 300;

async function copyText(text, done) {
  try {
    await navigator.clipboard.writeText(text);
    toast(done);
    return true;
  } catch {
    toast(t('share.copyFailed'));
    return false;
  }
}

// --- QR ------------------------------------------------------------------------------------------

export function renderQr(id) {
  const x = lib.techniques.get(id);
  chrome({ title: t('qr.title'), back: routes.technique(id), tab: 'library' });
  if (!x) { fill($main(), h('p', { class: 'empty' }, t('map.gone'))); return; }
  const link = techniqueViewerLink(x);

  let qrImg = null;
  let qrBlob = null;
  if (link.length <= QR_MAX_LENGTH && globalThis.qrcode) {
    // Stronger error correction while it is cheap; L when the text is long (same as the app).
    const code = globalThis.qrcode(0, link.length <= QR_COMFORTABLE_LENGTH ? 'M' : 'L');
    code.addData(link, 'Byte');
    code.make();
    const n = code.getModuleCount();
    const cell = Math.max(2, Math.floor(QR_TARGET_PX / (n + 8)));
    const canvas = document.createElement('canvas');
    const margin = cell * 4;
    canvas.width = canvas.height = n * cell + margin * 2;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#000';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (code.isDark(r, c)) ctx.fillRect(margin + c * cell, margin + r * cell, cell, cell);
    qrImg = h('img', { class: 'qr-img', src: canvas.toDataURL('image/png'), alt: t('qr.a11y', { name: x.name }), width: canvas.width, height: canvas.height });
    canvas.toBlob((b) => { qrBlob = b; }, 'image/png');
  }

  const safeName = x.name.replace(/[^A-Za-z0-9 _-]/g, '').trim().replace(/ /g, '_') || 'technique';
  const shareLink = async () => {
    const text = t('qr.shareText', { name: x.name, link });
    if (navigator.share) {
      try { await navigator.share({ title: x.name, text: `${x.name}\n`, url: link }); return; } catch (e) { if (e && e.name === 'AbortError') return; }
    }
    copyText(text, t('share.linkCopied'));
  };
  const shareImage = async () => {
    if (!qrBlob) return;
    const file = new File([qrBlob], `JutsuNexus_QR_${safeName}.png`, { type: 'image/png' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: x.name }); return; } catch (e) { if (e && e.name === 'AbortError') return; }
    }
    const a = h('a', { href: URL.createObjectURL(file), download: file.name });
    document.body.append(a);
    a.click();
    a.remove();
  };

  fill($main(),
    h('div', { class: 'qr-box' },
      h('h2', { class: 'tech-title', dir: 'auto' }, x.name),
      qrImg || h('div', { class: 'card error-box' }, h('p', {}, t('qr.tooLong', { count: link.length }))),
      qrImg && link.length > QR_COMFORTABLE_LENGTH ? h('p', { class: 'small warn' }, t('qr.dense')) : null),
    h('div', { class: 'stack section' },
      h('button', { class: 'btn block', type: 'button', onclick: shareLink }, icon('share', 20), t('qr.shareLink')),
      h('button', { class: 'btn tonal block', type: 'button', onclick: () => copyText(link, t('share.linkCopied')) }, icon('link', 20), t('qr.copyLink')),
      qrImg ? h('button', { class: 'btn tonal block', type: 'button', onclick: shareImage }, icon('qr', 20), t('qr.shareImage')) : null),
    h('div', { class: 'card' }, h('h2', {}, t('qr.whatsIn')), h('p', {}, t('qr.whatsInText')), h('p', {}, t('qr.whatsInBrowser'))));
}

// --- YouTube -------------------------------------------------------------------------------------

const TITLE_MAX = 100;
const DESCRIPTION_MAX = 5000;
const clean = (s) => s.replace(/[<>]/g, '');

/** The title and description to paste into YouTube's upload screen (same text as the app). */
export function youtubeText(x) {
  const title = clean(x.name).trim().slice(0, TITLE_MAX);
  const parts = [];
  if ((x.description || '').trim()) parts.push(x.description.trim());
  const steps = (x.steps || []).map((s) => s.trim()).filter(Boolean);
  if (steps.length) parts.push([t('yt.steps'), ...steps.map((s, i) => `${i + 1}. ${s}`)].join('\n'));
  return { title, description: clean(parts.join('\n\n')).slice(0, DESCRIPTION_MAX) };
}

export function renderYouTube(id) {
  const x = lib.techniques.get(id);
  chrome({ title: t('yt.title'), back: routes.technique(id), tab: 'library' });
  if (!x) { fill($main(), h('p', { class: 'empty' }, t('map.gone'))); return; }
  const videos = mediaOf(id).filter((m) => m.type === 'VIDEO');
  if (!videos.length) {
    fill($main(), h('div', { class: 'empty' }, h('p', {}, h('b', {}, t('yt.noVideos'))), h('p', {}, t('yt.noVideosCaption'))));
    return;
  }
  const text = youtubeText(x);
  let picked = videos[0];
  // The clip is read before the tap: iOS opens the share sheet only straight after one.
  let ready = null;
  const prepare = async (m) => {
    ready = null;
    const blob = await getBlob(m.blobKey);
    if (blob && picked === m) ready = new File([blob], m.fileName || 'clip.mp4', { type: m.mimeType || 'video/mp4' });
  };

  const list = h('div', { class: 'list yt-clips' });
  const drawList = () => fill(list, videos.map((m) => {
    const thumb = h('span', { class: 'thumb' }, icon('play', 24));
    mediaThumb(m).then((r) => { const n = thumbNode(r); if (n) thumb.replaceChildren(n); }).catch(() => {});
    return h('button', {
      class: `item yt-clip${m === picked ? ' on' : ''}`, type: 'button', 'aria-pressed': String(m === picked),
      onclick: () => { picked = m; drawList(); prepare(m); },
    }, thumb, h('span', { class: 'item-body' },
      h('span', { class: 'item-title', dir: 'auto' }, m.fileName),
      h('span', { class: 'item-meta' }, [formatDuration(m.durationMs), formatBytes(m.sizeBytes)].filter(Boolean).join(' • '))),
    m === picked ? icon('check', 22) : null);
  }));
  drawList();
  prepare(picked);

  const open = async () => {
    const file = ready;
    if (!file) { toast(t('common.loading')); return; }
    // Copy first, without waiting, so the share sheet still opens from this tap.
    if (navigator.clipboard) navigator.clipboard.writeText(text.title).catch(() => {});
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: text.title });
        toast(text.description ? t('yt.bothHintShort') : t('yt.titleCopiedTap'), 6000);
      } catch (e) {
        if (!e || e.name !== 'AbortError') toast(t('yt.couldNotOpen'));
      }
      return;
    }
    // A computer: save the clip and open YouTube's upload page.
    const a = h('a', { href: URL.createObjectURL(file), download: file.name });
    document.body.append(a);
    a.click();
    a.remove();
    window.open('https://www.youtube.com/upload', '_blank', 'noopener');
  };

  fill($main(),
    h('h2', { class: 'tech-title', dir: 'auto' }, x.name),
    h('p', { class: 'muted' }, videos.length > 1 ? t('yt.oneClipCaption') : t('yt.oneClipOnly')),
    list,
    videos.length > 1 ? h('p', { class: 'small muted' }, t('yt.noJoin')) : null,
    h('button', { class: 'btn block section', type: 'button', onclick: open }, icon('youtube', 20), t('yt.open')),
    h('p', { class: 'small muted' }, t('yt.howItWorks')),
    h('div', { class: 'card' },
      h('h2', {}, t('yt.forUpload')),
      h('p', { class: 'small' }, t('yt.titleLabel')), h('p', { dir: 'auto', class: 'yt-text' }, text.title),
      text.description ? [h('p', { class: 'small' }, t('technique.description')), h('p', { dir: 'auto', class: 'yt-text prose' }, text.description)] : null,
      h('div', { class: 'row', style: { marginTop: '12px' } },
        h('button', { class: 'btn tonal small-btn', type: 'button', onclick: () => copyText(text.title, t('yt.titleCopied')) }, t('yt.copyTitle')),
        text.description ? h('button', { class: 'btn tonal small-btn', type: 'button', onclick: () => copyText(text.description, t('yt.descriptionCopied')) }, t('yt.copyDescription')) : null)),
    h('div', { class: 'card' }, h('p', {}, t('yt.tipPrivacy')), h('p', {}, t('yt.tipLink'))));
}

