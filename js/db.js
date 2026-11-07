/**
 * IndexedDB storage. Everything lives on the device; nothing is uploaded.
 *
 *  groups, techniques, media  — the library rows (small; loaded whole into memory by library.js)
 *  blobs                       — the bytes: media files, covers, video thumbnails, keyed by string
 *  meta                        — settings
 *
 * Blobs sit in their own store so reading the library never touches the (possibly huge) files.
 */

const DB_NAME = 'jutsunexus';
const DB_VERSION = 1;
export const STORES = ['groups', 'techniques', 'media', 'blobs', 'meta'];

let dbPromise = null;

export function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('groups')) db.createObjectStore('groups', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('techniques')) db.createObjectStore('techniques', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('media')) db.createObjectStore('media', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs');
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
      };
      req.onsuccess = () => {
        const db = req.result;
        // Another tab upgrading the schema: let it, this one reloads.
        db.onversionchange = () => { db.close(); location.reload(); };
        resolve(db);
      };
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('Close the other JutsuNexus tabs and try again.'));
    });
  }
  return dbPromise;
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    // WebKit can leave tx.error null here; the failing request's own error is on the event.
    tx.onerror = (ev) => reject((ev && ev.target && ev.target.error) || tx.error || new Error('The save failed.'));
    tx.onabort = () => reject(tx.error || new Error('The save was cancelled.'));
  });
}

function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('Reading the library failed.'));
  });
}

export async function getAll(store) {
  const db = await openDb();
  return request(db.transaction(store).objectStore(store).getAll());
}

export async function get(store, key) {
  const db = await openDb();
  return request(db.transaction(store).objectStore(store).get(key));
}

// --- how files are stored --------------------------------------------------------------------
// Safari, Chrome and Firefox store a Blob in IndexedDB as a file on disk: reading it back gives a
// disk-backed Blob that plays a video without loading it into memory. Some WebKit builds refuse
// any Blob ("Error preparing Blob/File data to be stored in object store" — Playwright's Windows
// WebKit, and old iOS private mode). There the bytes are stored instead, which works but holds a
// file in memory while it is read. The mode is probed once, before anything is stored.

let blobModePromise = null;

export function blobMode() {
  if (!blobModePromise) {
    blobModePromise = (async () => {
      const db = await openDb();
      try {
        const tx = db.transaction('meta', 'readwrite');
        tx.objectStore('meta').put(new Blob(['probe'], { type: 'text/plain' }), '__blobProbe');
        await done(tx);
        await write([{ store: 'meta', del: '__blobProbe' }], 'raw');
        return 'blob';
      } catch {
        return 'bytes';
      }
    })();
  }
  return blobModePromise;
}

async function storable(value) {
  if (!(value instanceof Blob)) return value;
  if ((await blobMode()) === 'blob') return value;
  return { __bytes: await value.arrayBuffer(), type: value.type, name: value.name || null };
}

function fromStored(value) {
  if (value && value.__bytes instanceof ArrayBuffer) {
    return value.name ? new File([value.__bytes], value.name, { type: value.type }) : new Blob([value.__bytes], { type: value.type });
  }
  return value;
}

/**
 * One atomic write across stores. `ops` is a list of
 * { store, put: value, key? } or { store, del: key }.
 */
export async function write(ops, raw) {
  if (ops.length === 0) return;
  // Converted before the transaction opens: an IndexedDB transaction can't wait on other work.
  if (raw !== 'raw') {
    ops = await Promise.all(ops.map(async (op) => ('put' in op && op.store === 'blobs' ? { ...op, put: await storable(op.put) } : op)));
  }
  const db = await openDb();
  const names = [...new Set(ops.map((o) => o.store))];
  const tx = db.transaction(names, 'readwrite');
  for (const op of ops) {
    const os = tx.objectStore(op.store);
    if ('del' in op) os.delete(op.del);
    else if (op.key !== undefined) os.put(op.put, op.key);
    else os.put(op.put);
  }
  await done(tx);
}

export async function putBlob(key, blob) {
  await write([{ store: 'blobs', put: blob, key }]);
}

export async function getBlob(key) {
  if (!key) return null;
  return fromStored(await get('blobs', key)) || null;
}

export async function deleteBlobs(keys) {
  await write(keys.filter(Boolean).map((k) => ({ store: 'blobs', del: k })));
}

export async function getMeta(key, fallback = null) {
  const v = await get('meta', key);
  return v === undefined ? fallback : v;
}

export async function setMeta(key, value) {
  await write([{ store: 'meta', put: value, key }]);
}

/** Drops every row and every file. */
export async function clearEverything() {
  const db = await openDb();
  const tx = db.transaction(STORES, 'readwrite');
  for (const s of STORES) tx.objectStore(s).clear();
  await done(tx);
}

/** True when an error is the browser refusing more storage. */
export function isQuotaError(err) {
  return !!err && (err.name === 'QuotaExceededError' || err.code === 22 ||
    /quota|exceeded|space/i.test(String(err.message || err)));
}
