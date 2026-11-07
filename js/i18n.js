/**
 * Strings. t('area.key', { param }) and tn('area.key', count) (plural forms one/two/other).
 * Language: the viewer's choice in More (kept in this browser), else the browser's language.
 */
import { en } from './strings/en.js';
import { he } from './strings/he.js';

const DICTS = { en, he };
/** [code, native name] of the languages that have a dictionary. */
export const LANGUAGES = [['en', 'English'], ['he', 'עברית']];
const RTL = new Set(['he']);
const PREF_KEY = 'jn.language';

export function getLanguage() {
  try { return localStorage.getItem(PREF_KEY) || 'auto'; } catch { return 'auto'; }
}

export function setLanguage(code) {
  try {
    if (code === 'auto') localStorage.removeItem(PREF_KEY);
    else localStorage.setItem(PREF_KEY, code);
  } catch { /* private mode: falls back to the browser language */ }
  location.reload();
}

function resolveLanguage() {
  const pref = getLanguage();
  if (pref !== 'auto' && DICTS[pref]) return pref;
  for (const l of navigator.languages || [navigator.language || 'en']) {
    const code = String(l).toLowerCase().split('-')[0];
    const mapped = code === 'iw' ? 'he' : code;
    if (DICTS[mapped]) return mapped;
  }
  return 'en';
}

export const lang = resolveLanguage();
const dict = DICTS[lang];

export function applyDocumentLanguage() {
  document.documentElement.lang = lang;
  document.documentElement.dir = RTL.has(lang) ? 'rtl' : 'ltr';
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
}

function lookup(key) {
  return dict[key] ?? en[key] ?? key;
}

export const isRtl = RTL.has(lang);

/** In a right-to-left page each inserted value is isolated (FSI…PDI) so a Latin name or "159 MB" keeps its own order. */
function fillParams(s, params) {
  if (!params) return s;
  return s.replace(/\{(\w+)\}/g, (m, k) => (params[k] != null ? (isRtl ? `⁨${params[k]}⁩` : String(params[k])) : m));
}

/** A left-to-right run (a size, a file name) for use inside right-to-left text. */
export function ltr(text) {
  return isRtl ? `⁦${text}⁩` : String(text);
}

export function t(key, params) {
  const v = lookup(key);
  return fillParams(typeof v === 'string' ? v : v.other, params);
}

const plural = new Intl.PluralRules(lang);

export function tn(key, n, params) {
  const v = lookup(key);
  if (typeof v === 'string') return fillParams(v, { n, ...params });
  const form = n === 2 && v.two ? 'two' : plural.select(n);
  return fillParams(v[form] ?? v.other, { n, ...params });
}
