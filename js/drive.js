/**
 * Google Drive: reading shared packages (any "Anyone with the link" file, with the API key) and
 * publishing a package to the user's own Drive (Google sign-in, scope drive.file) — the same
 * links and the same file layout as the Android app's "Send by Drive link" (drivePublish.ts).
 *
 * Reading: Drive's download page refuses web pages, but the Drive API (googleapis.com) allows
 * them, with Range, for public files (measured 2026-11-07 on the BJJ library: 200 + 206 with
 * Access-Control-Allow-Origin for ehudsuryano.github.io, 403 without the website).
 */
import { GOOGLE_API_KEY, GOOGLE_CLIENT_ID } from './config.js';
import { VIEWER_URL } from './links.js';

const API = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3/files';
const SCOPE = 'https://www.googleapis.com/auth/drive.file';

export class DriveError extends Error {
  constructor(code, detail) {
    super(code);
    this.code = code; // 'notPublic' | 'gone' | 'offline' | 'full' | 'noAccess' | 'cancelled' | 'failed' | 'popup'
    this.detail = detail || '';
  }
}

/** The Drive file id in anything pasted: a #d1. link, a Drive share link, a download link. */
export function driveFileIdFrom(text) {
  const s = String(text || '').trim();
  let m = /#d1\.([A-Za-z0-9_-]{10,})/.exec(s);
  if (m) return m[1];
  let url;
  try { url = new URL(/^[a-z]+:\/\//i.test(s) ? s : `https://${s}`); } catch { return null; }
  if (!/(^|\.)(drive|docs|drive\.usercontent)\.google\.com$/.test(url.hostname)) return null;
  m = /\/(?:file\/d|uc|open)\/([A-Za-z0-9_-]{10,})/.exec(url.pathname) || /\/d\/([A-Za-z0-9_-]{10,})/.exec(url.pathname);
  if (m) return m[1];
  const id = url.searchParams.get('id');
  return id && /^[A-Za-z0-9_-]{10,}$/.test(id) ? id : null;
}

/** The link that gets sent: through the viewer, exactly as the Android app makes it. */
export function driveShareLink(fileId) {
  return `${VIEWER_URL}#d1.${fileId}`;
}

async function readError(r) {
  try {
    const body = await r.json();
    return { reason: body?.error?.errors?.[0]?.reason || '', message: body?.error?.message || '' };
  } catch {
    return { reason: '', message: '' };
  }
}

// --- reading (no sign-in) ---------------------------------------------------------------------

async function publicFetch(url, init) {
  let r;
  try {
    r = await fetch(url, init);
  } catch {
    throw new DriveError('offline');
  }
  if (r.ok) return r;
  const { reason, message } = await readError(r);
  if (r.status === 404) throw new DriveError('gone');
  if (r.status === 403 || r.status === 401) {
    if (/rateLimit|quota|userRateLimit|dailyLimit/i.test(reason)) throw new DriveError('busy', message);
    throw new DriveError('notPublic', message);
  }
  throw new DriveError('failed', `${r.status}${message ? `: ${message}` : ''}`);
}

/** { id, name, size, modifiedTime, md5Checksum } of a public file. */
export async function driveMeta(fileId) {
  const r = await publicFetch(`${API}/${encodeURIComponent(fileId)}?fields=id,name,size,mimeType,modifiedTime,md5Checksum&supportsAllDrives=true&key=${GOOGLE_API_KEY}`);
  const meta = await r.json();
  return { ...meta, size: Number(meta.size || 0) };
}

/** A package source (see zip.js) over a public Drive file, read in byte ranges. */
export async function driveSource(fileId) {
  const meta = await driveMeta(fileId);
  const url = `${API}/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true&key=${GOOGLE_API_KEY}`;
  const read = async (start, end) => {
    try {
      const r = await publicFetch(url, { headers: { Range: `bytes=${start}-${end - 1}` } });
      return new Uint8Array(await r.arrayBuffer());
    } catch (e) {
      // Google answered for the file a moment ago, so this is Drive refusing the download (its
      // download limits, or its "automated queries" block), not a missing connection or file.
      if (e instanceof DriveError && (e.code === 'offline' || e.code === 'notPublic')) throw new DriveError('busy');
      throw e;
    }
  };
  const tailLen = Math.min(meta.size, 22 + 65535);
  const tail = await read(meta.size - tailLen, meta.size);
  return {
    name: meta.name || 'package.zip',
    size: meta.size,
    link: driveShareLink(fileId),
    driveId: fileId,
    read,
    readTail: async () => tail,
    blob: async (start, end, type) => new Blob([await read(start, end)], { type: type || '' }),
  };
}

// --- signing in (Google Identity Services, token model) ---------------------------------------------

let gisPromise = null;
let token = null; // { value, expires }

/** Loads Google's sign-in script. Done ahead of the tap: the sign-in window must open from it. */
export function loadGoogleSignIn() {
  if (!gisPromise) {
    gisPromise = new Promise((resolve, reject) => {
      if (globalThis.google?.accounts?.oauth2) { resolve(); return; }
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => { gisPromise = null; reject(new DriveError('offline')); };
      document.head.append(s);
    });
  }
  return gisPromise;
}

/** True once Google's script has loaded; checked without waiting so the tap can still open a window. */
export function signInReady() {
  return !!globalThis.google?.accounts?.oauth2;
}

export function isSignedIn() {
  return !!token && token.expires > Date.now() + 60000;
}

/**
 * Gets a Drive token. Call straight from a tap: Google's window is a popup. Resolves once the
 * user has signed in and allowed Drive (or rejects with 'cancelled' / 'noAccess').
 */
export function signIn() {
  if (isSignedIn()) return Promise.resolve(token.value);
  return new Promise((resolve, reject) => {
    const oauth2 = globalThis.google?.accounts?.oauth2;
    if (!oauth2) { reject(new DriveError('offline')); return; }
    const client = oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: SCOPE,
      callback: (resp) => {
        if (resp.error) { reject(new DriveError(resp.error === 'access_denied' ? 'cancelled' : 'failed', resp.error_description || resp.error)); return; }
        // Google's own screen lets the user untick Drive and still "sign in".
        if (!oauth2.hasGrantedAllScopes(resp, SCOPE)) { reject(new DriveError('noAccess')); return; }
        token = { value: resp.access_token, expires: Date.now() + Number(resp.expires_in || 3600) * 1000 };
        resolve(token.value);
      },
      error_callback: (err) => {
        reject(new DriveError(err && err.type === 'popup_closed' ? 'cancelled' : 'popup', err && err.type));
      },
    });
    client.requestAccessToken({ prompt: '' });
  });
}

export function signOut() {
  const t = token;
  token = null;
  try { if (t) globalThis.google?.accounts?.oauth2?.revoke(t.value, () => {}); } catch { /* best effort */ }
}

async function authed(url, init = {}) {
  if (!isSignedIn()) throw new DriveError('signedOut');
  let r;
  try {
    r = await fetch(url, { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${token.value}` } });
  } catch {
    throw new DriveError('offline');
  }
  return r;
}

async function apiFailure(r) {
  const { reason, message } = await readError(r);
  if (reason === 'storageQuotaExceeded') return new DriveError('full');
  if (reason === 'insufficientPermissions' || r.status === 401) return new DriveError('noAccess');
  return new DriveError('failed', `${r.status}${message ? `: ${message}` : ''}`);
}

/** The signed-in account's address (Drive's about.user works with drive.file). */
export async function driveAccount() {
  const r = await authed('https://www.googleapis.com/drive/v3/about?fields=user(emailAddress,displayName)');
  if (!r.ok) return null;
  const j = await r.json();
  return j.user?.emailAddress || j.user?.displayName || null;
}

// --- publishing ---------------------------------------------------------------------------------------

async function startSession(fileName, size, existingId) {
  const url = existingId ? `${UPLOAD_API}/${encodeURIComponent(existingId)}?uploadType=resumable&fields=id` : `${UPLOAD_API}?uploadType=resumable&fields=id`;
  return authed(url, {
    method: existingId ? 'PATCH' : 'POST',
    headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': 'application/zip', 'X-Upload-Content-Length': String(size) },
    body: JSON.stringify(existingId ? { name: fileName } : { name: fileName, mimeType: 'application/zip' }),
  });
}

/** The session address: Location when the browser may read it, else built from the upload id. */
function sessionUrl(r, existingId) {
  const loc = r.headers.get('Location');
  if (loc) return loc;
  const uploadId = r.headers.get('X-GUploader-UploadID');
  if (!uploadId) return null;
  const base = existingId ? `${UPLOAD_API}/${encodeURIComponent(existingId)}` : UPLOAD_API;
  return `${base}?uploadType=resumable&fields=id&upload_id=${encodeURIComponent(uploadId)}`;
}

/** PUT with progress (fetch can't report upload progress). Resolves { status, body }. */
function putWithProgress(url, blob, onProgress, signal) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', 'application/zip');
    xhr.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded, e.total); };
    xhr.onload = () => resolve({ status: xhr.status, body: xhr.responseText });
    xhr.onerror = () => reject(new DriveError('offline'));
    xhr.onabort = () => reject(new DriveError('cancelled'));
    if (signal) signal.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(blob);
  });
}

/**
 * Uploads `blob` as `fileName`, replacing `existingId` when given (the link stays the same), and
 * makes it readable by anyone with the link. Resolves { fileId, linkChanged }.
 */
export async function publishPackage(blob, fileName, existingId, onProgress, signal) {
  let linkChanged = false;
  let session = await startSession(fileName, blob.size, existingId);
  if (session.status === 404 && existingId) {
    // Deleted from Drive by hand: it can only be a new file now.
    session = await startSession(fileName, blob.size, null);
    existingId = null;
    linkChanged = true;
  }
  if (!session.ok) throw await apiFailure(session);
  const url = sessionUrl(session, existingId);
  if (!url) throw new DriveError('failed', 'no upload address');
  const up = await putWithProgress(url, blob, onProgress, signal);
  if (up.status === 403 && up.body.includes('storageQuotaExceeded')) throw new DriveError('full');
  if (up.status < 200 || up.status >= 300) throw new DriveError('failed', String(up.status));
  const fileId = JSON.parse(up.body).id;
  const shared = await authed(`${API}/${encodeURIComponent(fileId)}/permissions?fields=id`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'reader', type: 'anyone' }),
  });
  if (!shared.ok) throw await apiFailure(shared);
  return { fileId, linkChanged };
}

/** Deletes the file from Drive, which ends the link for everyone. Already gone counts as done. */
export async function deleteDriveFile(fileId) {
  const r = await authed(`${API}/${encodeURIComponent(fileId)}`, { method: 'DELETE' });
  if (!r.ok && r.status !== 404) throw await apiFailure(r);
}
