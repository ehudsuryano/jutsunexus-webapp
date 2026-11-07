/**
 * Picking photos, videos and files for a technique — shared by the technique page and the
 * new-technique form — and storing them (new photos shrunk to the chosen size first).
 */
import { pickFiles, toast } from './dom.js';
import { t, tn } from './i18n.js';
import { addMediaFiles } from './library.js';
import { probe, compressPhoto } from './media.js';
import { isQuotaError } from './db.js';
import { getPref } from './prefs.js';

export const PICKERS = {
  // `capture` opens the camera straight away on a phone; a computer shows its file picker.
  photo: { accept: 'image/*', capture: 'environment' },
  video: { accept: 'video/*', capture: 'environment' },
  gallery: { accept: 'image/*,video/*', multiple: true },
  file: { accept: '', multiple: true },
};

/** The Photo / Video / Gallery / File buttons' kinds, in the order they are shown. */
export const ADD_KINDS = [
  { kind: 'photo', icon: 'camera', label: 'media.photo' },
  { kind: 'video', icon: 'videocam', label: 'media.video' },
  { kind: 'gallery', icon: 'image', label: 'media.gallery' },
  { kind: 'file', icon: 'doc', label: 'media.file', iconOnly: true },
];

export function pickMedia(kind) {
  return pickFiles(PICKERS[kind] || PICKERS.gallery);
}

/** Stores picked files under a technique, with progress toasts. Resolves true when all went in. */
export async function storePicked(techniqueId, picked) {
  if (!picked.length) return true;
  try {
    toast(t('media.adding', { done: 0, total: picked.length }), 60000);
    const quality = getPref('photoQuality');
    const files = [];
    for (const f of picked) files.push(f.type.startsWith('image/') ? await compressPhoto(f, quality) : f);
    await addMediaFiles(techniqueId, files, probe, (n) => toast(t('media.adding', { done: n, total: files.length }), 60000));
    toast(tn('media.added', picked.length));
    return true;
  } catch (e) {
    toast(isQuotaError(e) ? t('import.noSpace') : ((e && e.message) || String(e)), 6000);
    return false;
  }
}
