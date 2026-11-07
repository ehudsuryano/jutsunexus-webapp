/**
 * Viewer preferences kept in this browser (localStorage): how the library looks and how big new
 * photos are kept. Defaults match the Android app where it has the same setting.
 */

const KEYS = { viewMode: 'jn.viewMode', sortOption: 'jn.sortOption', photoQuality: 'jn.photoQuality' };
export const VIEW_MODES = ['CARDS', 'LIST', 'COMPACT'];
export const SORT_OPTIONS = ['NAME', 'MODIFIED', 'CREATED'];
export const PHOTO_QUALITIES = ['ORIGINAL', 'HIGH', 'BALANCED'];
const DEFAULTS = { viewMode: 'LIST', sortOption: 'NAME', photoQuality: 'BALANCED' };
const ALLOWED = { viewMode: VIEW_MODES, sortOption: SORT_OPTIONS, photoQuality: PHOTO_QUALITIES };

export function getPref(name) {
  try {
    const v = localStorage.getItem(KEYS[name]);
    return ALLOWED[name].includes(v) ? v : DEFAULTS[name];
  } catch {
    return DEFAULTS[name];
  }
}

export function setPref(name, value) {
  try { localStorage.setItem(KEYS[name], value); } catch { /* private mode: the default stays */ }
}
