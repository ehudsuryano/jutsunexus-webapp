/**
 * Object URLs for stored files, video probing and thumbnails.
 *
 * A Blob read back from IndexedDB is backed by the browser's own file, so an object URL to it
 * plays a video without loading it into memory. URLs are cached per key and the oldest are
 * revoked once there are many, so browsing a long list doesn't pin every file.
 */
import * as db from './db.js';
import { lib, mediaOf, setThumb } from './library.js';

const urls = new Map(); // key -> url (insertion order = age)
const MAX_URLS = 80;
const pinned = new Set();

export async function urlFor(key) {
  if (!key) return null;
  if (urls.has(key)) {
    const u = urls.get(key);
    urls.delete(key);
    urls.set(key, u);
    return u;
  }
  const blob = await db.getBlob(key);
  if (!blob) return null;
  if (urls.has(key)) return urls.get(key); // a concurrent call got there first
  const url = URL.createObjectURL(blob);
  urls.set(key, url);
  trim();
  return url;
}

function trim() {
  for (const [k, u] of urls) {
    if (urls.size <= MAX_URLS) break;
    if (pinned.has(k)) continue;
    URL.revokeObjectURL(u);
    urls.delete(k);
  }
}

/** Keeps a URL alive while something (the player) is using it. */
export function pin(key) { pinned.add(key); }
export function unpin(key) { pinned.delete(key); trim(); }

export function forget(keys) {
  for (const k of keys) {
    const u = urls.get(k);
    if (u) URL.revokeObjectURL(u);
    urls.delete(k);
  }
}

export function forgetAll() {
  for (const u of urls.values()) URL.revokeObjectURL(u);
  urls.clear();
}

// --- probing ------------------------------------------------------------------------------------

function once(target, events, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('timeout')); }, ms);
    const ok = () => { cleanup(); resolve(); };
    const bad = () => { cleanup(); reject(new Error('media error')); };
    const cleanup = () => {
      clearTimeout(timer);
      for (const e of events) target.removeEventListener(e, ok);
      target.removeEventListener('error', bad);
    };
    for (const e of events) target.addEventListener(e, ok);
    target.addEventListener('error', bad);
  });
}

function canvasBlob(source, w, h, maxW = 360) {
  const scale = Math.min(1, maxW / Math.max(1, w));
  const cw = Math.max(1, Math.round(w * scale));
  const ch = Math.max(1, Math.round(h * scale));
  const canvas = document.createElement('canvas');
  canvas.width = cw;
  canvas.height = ch;
  canvas.getContext('2d').drawImage(source, 0, 0, cw, ch);
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.8));
}

let probeChain = Promise.resolve();

/**
 * { durationMs, width, height, thumb } of a video or photo. Runs one at a time: phones handle a
 * single hidden video decoder fine and a dozen of them badly.
 */
export function probe(blob, type) {
  const run = () => (type === 'VIDEO' ? probeVideo(blob) : probeImage(blob));
  const p = probeChain.then(run, run);
  probeChain = p.catch(() => {});
  return p;
}

async function probeImage(blob) {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return { width: img.naturalWidth, height: img.naturalHeight };
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function probeVideo(blob) {
  const url = URL.createObjectURL(blob);
  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.setAttribute('playsinline', '');
  v.preload = 'auto';
  // iOS only decodes a video that is in the document.
  Object.assign(v.style, { position: 'fixed', left: '-10px', top: '-10px', width: '2px', height: '2px', opacity: '0', pointerEvents: 'none' });
  document.body.append(v);
  try {
    v.src = url;
    await once(v, ['loadedmetadata'], 15000);
    const info = {
      durationMs: Number.isFinite(v.duration) ? Math.round(v.duration * 1000) : null,
      width: v.videoWidth || null,
      height: v.videoHeight || null,
    };
    try {
      if (v.readyState < 2) await once(v, ['loadeddata'], 8000);
      v.currentTime = Math.min(0.5, (v.duration || 1) / 3);
      await once(v, ['seeked'], 8000);
      if (v.videoWidth > 0) info.thumb = await canvasBlob(v, v.videoWidth, v.videoHeight);
    } catch {
      // No frame (iOS sometimes won't decode off-screen): the tile falls back to an icon.
    }
    return info;
  } finally {
    v.removeAttribute('src');
    v.load();
    v.remove();
    URL.revokeObjectURL(url);
  }
}

// --- photo size (the app's "Photo quality") ----------------------------------------------------

const PHOTO_MAX_EDGE = { HIGH: 3072, BALANCED: 2048 };
const PHOTO_JPEG_QUALITY = 0.85;
const MIN_PHOTO_BYTES = 300 * 1024;

/**
 * A new photo shrunk to the chosen size before it is stored, as the Android app does: the longer
 * edge to 3072 or 2048 px, JPEG at 85% (PNG stays PNG). Small photos, and any photo the browser
 * can't decode, are kept as they are. Videos are never re-encoded here — a browser can't.
 */
export async function compressPhoto(file, quality) {
  if (quality === 'ORIGINAL' || !PHOTO_MAX_EDGE[quality] || file.size < MIN_PHOTO_BYTES) return file;
  if (!/^image\/(jpeg|png|webp|heic|heif)$/i.test(file.type || '')) return file;
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const w = img.naturalWidth;
    const hgt = img.naturalHeight;
    const scale = Math.min(1, PHOTO_MAX_EDGE[quality] / Math.max(w, hgt));
    const png = /png/i.test(file.type);
    if (scale === 1 && !/heic|heif/i.test(file.type)) return file;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(hgt * scale));
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    const type = png ? 'image/png' : 'image/jpeg';
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, type, PHOTO_JPEG_QUALITY));
    if (!blob || blob.size >= file.size) return file;
    const base = (file.name || 'photo').replace(/\.[^.]+$/, '');
    return new File([blob], `${base}.${png ? 'png' : 'jpg'}`, { type, lastModified: Date.now() });
  } catch {
    return file;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Downscaled copy of a picked photo for use as a cover. */
export async function coverFromImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return (await canvasBlob(img, img.naturalWidth, img.naturalHeight, 1280)) || file;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// --- thumbnails ---------------------------------------------------------------------------------

const pendingThumbs = new Map();

/** The thumbnail URL of a media row; makes and stores one for a video that has none yet. */
export async function mediaThumbUrl(m) {
  if (m.type === 'IMAGE') return urlFor(m.blobKey);
  if (m.type !== 'VIDEO') return null;
  if (m.thumbKey) {
    const u = await urlFor(m.thumbKey);
    if (u) return u;
  }
  if (!pendingThumbs.has(m.id)) {
    pendingThumbs.set(m.id, (async () => {
      const blob = await db.getBlob(m.blobKey);
      if (!blob) return null;
      const info = await probe(blob, 'VIDEO').catch(() => ({}));
      if (!info.thumb) return null;
      await setThumb(m.id, info.thumb);
      return urlFor(`th:${m.id}`);
    })().catch(() => null));
  }
  return pendingThumbs.get(m.id);
}

/** Library thumbnail of a technique: its cover, else its first video (as in the app). */
export async function techniqueThumbUrl(t) {
  if (t.coverKey) {
    const u = await urlFor(t.coverKey);
    if (u) return u;
  }
  const firstVideo = mediaOf(t.id).find((m) => m.type === 'VIDEO');
  return firstVideo ? mediaThumbUrl(firstVideo) : null;
}

export function firstVideoOf(t) {
  return mediaOf(t.id).find((m) => m.type === 'VIDEO') || null;
}

export function isMediaRow(id) { return lib.media.has(id); }
