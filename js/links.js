/**
 * Technique links (text only), byte-compatible with the app's src/utils/techniqueLink.ts and the
 * viewer: JSON with short keys → raw DEFLATE → base64url, in the URL fragment of the viewer.
 * Change all three or none.
 */
import { t as tr } from './i18n.js';
import { DIFFICULTIES, CLASSIFICATIONS } from './library.js';

/** Every technique link ever shared embeds this address; links made here use it too. */
export const VIEWER_URL = 'https://ehudsuryano.github.io/jutsunexus-viewer/';
export const ANDROID_APP_URL = 'https://ehudsuryano.github.io/jutsunexus-app/';
const PREFIX = 't1.';

function toBase64Url(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text) {
  const b64 = text.replace(/[^A-Za-z0-9_-]/g, '').replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '==='.slice((b64.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function encodeTechniqueToken(x) {
  const p = { n: x.name };
  if ((x.description || '').trim()) p.d = x.description;
  if ((x.steps || []).length > 0) p.s = x.steps;
  if (x.difficulty && x.difficulty !== 'UNSPECIFIED') p.df = x.difficulty;
  if ((x.position || '').trim()) p.p = x.position;
  if (x.classification && x.classification !== 'UNSPECIFIED') p.c = x.classification;
  if ((x.tags || []).length > 0) p.tg = x.tags;
  if ((x.notes || '').trim()) p.no = x.notes;
  if ((x.links || []).length > 0) p.l = x.links.map((l) => [l.title || '', l.url]);
  return PREFIX + toBase64Url(globalThis.pako.deflateRaw(JSON.stringify(p), { level: 9 }));
}

export function techniqueViewerLink(x) {
  return `${VIEWER_URL}#${encodeTechniqueToken(x)}`;
}

export function extractTechniqueToken(text) {
  const m = /(?:^|[#=\s])(t1\.[A-Za-z0-9_-]+)/.exec(String(text || '').trim());
  return m ? m[1] : null;
}

/** A link from the app's "Send by link" (phone-to-phone), which a browser can't receive. */
export function isDirectSendLink(text) {
  return /#s1\.[0-9a-f]{64}/.test(String(text || ''));
}

/** A link from the app's "Send by Drive link": #d1.<Drive file id>. */
export function driveLinkFileId(text) {
  const m = /#d1\.([A-Za-z0-9_-]{10,})/.exec(String(text || ''));
  return m ? m[1] : null;
}

export function decodeTechniqueToken(token) {
  if (!token.startsWith(PREFIX)) throw new Error(tr('link.tooNew'));
  let p;
  try {
    p = JSON.parse(globalThis.pako.inflateRaw(fromBase64Url(token.slice(PREFIX.length)), { to: 'string' }));
  } catch {
    throw new Error(tr('link.damaged'));
  }
  if (!p || typeof p.n !== 'string' || !p.n.trim()) throw new Error(tr('link.empty'));
  const strings = (v) => (Array.isArray(v) ? v.filter((s) => typeof s === 'string') : []);
  return {
    name: p.n.trim(),
    description: typeof p.d === 'string' ? p.d : '',
    steps: strings(p.s),
    difficulty: DIFFICULTIES.includes(p.df) ? p.df : 'UNSPECIFIED',
    position: typeof p.p === 'string' ? p.p : '',
    classification: CLASSIFICATIONS.includes(p.c) ? p.c : 'UNSPECIFIED',
    tags: strings(p.tg),
    notes: typeof p.no === 'string' ? p.no : '',
    links: Array.isArray(p.l)
      ? p.l.filter((l) => Array.isArray(l) && typeof l[1] === 'string').map(([title, url]) => ({ title: typeof title === 'string' ? title : '', url }))
      : [],
  };
}
