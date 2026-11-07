/**
 * ZIP reading and writing for JutsuNexus packages (format v1, same as the Android app).
 *
 * Reading parses the central directory and hands out each entry as a lazy slice of the source:
 * the app writes packages with STORE, so a video entry is a zero-copy slice of the picked file and
 * never has to sit in memory. DEFLATE entries (manifest/content JSON, older packages) go through
 * pako. Ported from the web viewer (jutsunexus-viewer/app.js).
 *
 * Writing produces STORE entries with UTF-8 names (flag bit 11). Files are read in chunks only to
 * compute their CRC-32; the finished archive is a Blob made of references to the stored files.
 */

const utf8 = new TextDecoder('utf-8');
const enc = new TextEncoder();

// --- sources ------------------------------------------------------------------------------------

export function fileSource(file) {
  return {
    name: file.name,
    size: file.size,
    read: async (start, end) => new Uint8Array(await file.slice(start, end).arrayBuffer()),
    readTail: async (n) => new Uint8Array(await file.slice(Math.max(0, file.size - n), file.size).arrayBuffer()),
    blob: async (start, end, type) => file.slice(start, end, type || ''),
  };
}

/** Rewrites share links to their download address (same rules as the app and the viewer). */
export function resolveDownloadUrl(input) {
  let url;
  try {
    const s = String(input || '').trim();
    url = new URL(/^[a-z]+:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (/(^|\.)(drive|docs|drive\.usercontent)\.google\.com$/.test(url.hostname)) {
    const m = /\/file\/d\/([A-Za-z0-9_-]{10,})/.exec(url.pathname);
    const id = m ? m[1] : url.searchParams.get('id');
    if (id) return `https://drive.usercontent.google.com/download?id=${encodeURIComponent(id)}&export=download&confirm=t`;
  }
  if (/(^|\.)dropbox\.com$/.test(url.hostname)) {
    url.searchParams.set('dl', '1');
    return url.toString();
  }
  if (url.hostname === 'github.com') {
    const m = /^\/([^/]+)\/([^/]+)\/blob\/(.+)$/.exec(url.pathname);
    if (m) return `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}`;
  }
  return url.toString();
}

export function isDriveDownload(url) {
  return /^https:\/\/drive\.usercontent\.google\.com\//.test(url || '');
}

/**
 * A package behind a web link, read with Range requests. Google Drive refuses every cross-site
 * request from a web page (403 on `Sec-Fetch-Site: cross-site`, measured 2026-09-29), so callers
 * check `isDriveDownload` first and send the visitor to download the file instead.
 */
export async function urlSource(link, errors) {
  const url = resolveDownloadUrl(link);
  if (!url) throw new Error(errors.notLink);
  if (isDriveDownload(url)) throw new Error(errors.drive);
  const fetchRange = async (range) => {
    let r;
    try {
      r = await fetch(url, { headers: { Range: range } });
    } catch {
      throw new Error(errors.blocked);
    }
    if (r.status === 401 || r.status === 403) throw new Error(errors.notPublic);
    if (r.status === 404) throw new Error(errors.gone);
    if (!r.ok) throw new Error(errors.http.replace('{status}', r.status));
    if (/text\/html/i.test(r.headers.get('content-type') || '')) throw new Error(errors.html);
    return r;
  };
  let name = 'package.zip';
  try { name = decodeURIComponent(new URL(url).pathname.split('/').pop() || name); } catch { /* keep */ }

  const tailResponse = await fetchRange('bytes=-65557');
  // A server that ignores Range sends the whole file: hold it as a local file.
  if (tailResponse.status === 200) {
    const blob = await tailResponse.blob();
    // Keep where it came from: subscriptions follow this link for updates.
    return { ...fileSource(new File([blob], name)), link };
  }
  const tail = new Uint8Array(await tailResponse.arrayBuffer());
  const read = async (start, end) => new Uint8Array(await (await fetchRange(`bytes=${start}-${end - 1}`)).arrayBuffer());
  return {
    name,
    link,
    read,
    readTail: async () => tail,
    blob: async (start, end, type) => new Blob([await read(start, end)], { type: type || '' }),
  };
}

// --- reading -----------------------------------------------------------------------------------

function u64(view, at) {
  return view.getUint32(at, true) + view.getUint32(at + 4, true) * 2 ** 32;
}

export class ZipError extends Error {}

/** Map of entry name → { name, method, compSize, size, offset }. */
export async function openZip(src) {
  const tail = await src.readTail(22 + 65535);
  const tv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new ZipError('not-zip');

  let count = tv.getUint16(eocd + 10, true);
  let cdSize = tv.getUint32(eocd + 12, true);
  let cdOffset = tv.getUint32(eocd + 16, true);

  if (cdOffset === 0xffffffff || count === 0xffff || cdSize === 0xffffffff) {
    const loc = eocd - 20;
    if (loc < 0 || tv.getUint32(loc, true) !== 0x07064b50) throw new ZipError('layout');
    const z64At = u64(tv, loc + 8);
    const zb = await src.read(z64At, z64At + 56);
    const z = new DataView(zb.buffer, zb.byteOffset, zb.byteLength);
    if (z.getUint32(0, true) !== 0x06064b50) throw new ZipError('layout');
    count = u64(z, 32);
    cdSize = u64(z, 40);
    cdOffset = u64(z, 48);
  }

  const cd = await src.read(cdOffset, cdOffset + cdSize);
  const v = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);
  const entries = new Map();
  let p = 0;
  for (let n = 0; n < count && p + 46 <= cd.length; n++) {
    if (v.getUint32(p, true) !== 0x02014b50) break;
    const method = v.getUint16(p + 10, true);
    let compSize = v.getUint32(p + 20, true);
    let size = v.getUint32(p + 24, true);
    const nameLen = v.getUint16(p + 28, true);
    const extraLen = v.getUint16(p + 30, true);
    const commentLen = v.getUint16(p + 32, true);
    let offset = v.getUint32(p + 42, true);
    const name = utf8.decode(cd.subarray(p + 46, p + 46 + nameLen));
    let e = p + 46 + nameLen;
    const eEnd = e + extraLen;
    while (e + 4 <= eEnd) {
      const id = v.getUint16(e, true);
      const len = v.getUint16(e + 2, true);
      if (id === 0x0001) {
        let q = e + 4;
        if (size === 0xffffffff) { size = u64(v, q); q += 8; }
        if (compSize === 0xffffffff) { compSize = u64(v, q); q += 8; }
        if (offset === 0xffffffff) { offset = u64(v, q); }
      }
      e += 4 + len;
    }
    entries.set(name.replace(/\\/g, '/'), { name, method, compSize, size, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** A Blob of one entry's contents. For a picked file, STORE entries are zero-copy slices. */
export async function entryBlob(src, entry, type) {
  const hb = await src.read(entry.offset, entry.offset + 30);
  const head = new DataView(hb.buffer, hb.byteOffset, hb.byteLength);
  if (head.getUint32(0, true) !== 0x04034b50) throw new ZipError('entry');
  const start = entry.offset + 30 + head.getUint16(26, true) + head.getUint16(28, true);
  const raw = await src.blob(start, start + entry.compSize, type);
  if (entry.method === 0) return raw;
  if (entry.method === 8) {
    const out = globalThis.pako.inflateRaw(new Uint8Array(await raw.arrayBuffer()));
    return new Blob([out], { type: type || '' });
  }
  throw new ZipError('method');
}

// --- writing -----------------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crcUpdate(crc, bytes) {
  let c = crc;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return c;
}

const CHUNK = 4 * 1024 * 1024;

async function crcOfBlob(blob, onBytes) {
  let crc = 0xffffffff;
  for (let at = 0; at < blob.size; at += CHUNK) {
    const part = new Uint8Array(await blob.slice(at, Math.min(blob.size, at + CHUNK)).arrayBuffer());
    crc = crcUpdate(crc, part);
    if (onBytes) onBytes(part.length);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

export class ZipTooBigError extends Error {}

/**
 * Builds a STORE zip. entries: [{ name, blob }]. onProgress(doneBytes, totalBytes).
 * Plain ZIP (no ZIP64): refuses past 4 GB, which no phone package approaches.
 */
export async function buildZip(entries, onProgress) {
  const total = entries.reduce((n, e) => n + e.blob.size, 0);
  let doneBytes = 0;
  const { time, date } = dosDateTime(new Date());
  const parts = [];
  const central = [];
  let offset = 0;

  for (const e of entries) {
    const nameBytes = enc.encode(e.name);
    const crc = await crcOfBlob(e.blob, (n) => { doneBytes += n; if (onProgress) onProgress(doneBytes, total); });
    const size = e.blob.size;
    if (offset + 30 + nameBytes.length + size > 0xfffffffe) throw new ZipTooBigError();

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true); // version needed
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(8, 0, true); // STORE
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, size, true);
    local.setUint32(22, size, true);
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true);
    parts.push(local.buffer, nameBytes, e.blob);

    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, 20, true); // made by
    c.setUint16(6, 20, true);
    c.setUint16(8, 0x0800, true);
    c.setUint16(10, 0, true);
    c.setUint16(12, time, true);
    c.setUint16(14, date, true);
    c.setUint32(16, crc, true);
    c.setUint32(20, size, true);
    c.setUint32(24, size, true);
    c.setUint16(28, nameBytes.length, true);
    c.setUint16(30, 0, true);
    c.setUint16(32, 0, true);
    c.setUint16(34, 0, true);
    c.setUint16(36, 0, true);
    c.setUint32(38, 0, true);
    c.setUint32(42, offset, true);
    central.push(c.buffer, nameBytes);

    offset += 30 + nameBytes.length + size;
  }

  const cdSize = central.reduce((n, p) => n + p.byteLength, 0);
  if (offset + cdSize > 0xfffffffe || entries.length > 0xfffe) throw new ZipTooBigError();
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
}

export function textBlob(text) {
  return new Blob([enc.encode(text)], { type: 'application/json' });
}
