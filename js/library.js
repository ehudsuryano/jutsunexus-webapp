/**
 * The library: groups (folders), techniques and media rows, held in memory and written through
 * to IndexedDB. Field names follow the app's package DTOs so import/export is a straight copy.
 *
 * group     { id, parentId, name, description, tags[], notes, links[], coverKey, createdAt, modifiedAt }
 * technique { id, groupId, name, description, steps[], difficulty, position, classification,
 *             tags[], notes, links[], relatedIds[], leadsToIds[], coverKey, isFavorite,
 *             createdAt, modifiedAt, lastViewedAt }
 * media     { id, techniqueId, type, fileName, mimeType, sizeBytes, durationMs, width, height,
 *             sortOrder, createdAt, blobKey, thumbKey }
 *
 * `coverKey`, `blobKey` and `thumbKey` are keys in the `blobs` store.
 */
import * as db from './db.js';

export const DIFFICULTIES = ['UNSPECIFIED', 'BEGINNER', 'INTERMEDIATE', 'ADVANCED', 'EXPERT'];
export const CLASSIFICATIONS = ['UNSPECIFIED', 'OFFENSE', 'DEFENSE', 'COUNTER', 'TRANSITION'];

export const lib = {
  groups: new Map(),
  techniques: new Map(),
  media: new Map(),
};

const listeners = new Set();
export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function changed() { for (const fn of listeners) fn(); }

export function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const x = [...b].map((n) => n.toString(16).padStart(2, '0')).join('');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

export async function load() {
  const [groups, techniques, media] = await Promise.all([
    db.getAll('groups'), db.getAll('techniques'), db.getAll('media'),
  ]);
  lib.groups = new Map(groups.map((g) => [g.id, g]));
  lib.techniques = new Map(techniques.map((t) => [t.id, t]));
  lib.media = new Map(media.map((m) => [m.id, m]));
}

/** Writes rows (and optional deletes) in one transaction, then updates memory. */
export async function commit({ groups = [], techniques = [], media = [], delGroups = [], delTechniques = [], delMedia = [], blobs = [], delBlobs = [] }) {
  const ops = [
    ...groups.map((g) => ({ store: 'groups', put: g })),
    ...techniques.map((t) => ({ store: 'techniques', put: t })),
    ...media.map((m) => ({ store: 'media', put: m })),
    ...blobs.map(([key, blob]) => ({ store: 'blobs', put: blob, key })),
    ...delGroups.map((id) => ({ store: 'groups', del: id })),
    ...delTechniques.map((id) => ({ store: 'techniques', del: id })),
    ...delMedia.map((id) => ({ store: 'media', del: id })),
    ...delBlobs.filter(Boolean).map((key) => ({ store: 'blobs', del: key })),
  ];
  await db.write(ops);
  for (const g of groups) lib.groups.set(g.id, g);
  for (const t of techniques) lib.techniques.set(t.id, t);
  for (const m of media) lib.media.set(m.id, m);
  for (const id of delGroups) lib.groups.delete(id);
  for (const id of delTechniques) lib.techniques.delete(id);
  for (const id of delMedia) lib.media.delete(id);
  changed();
}

// --- queries -------------------------------------------------------------------------------------

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
export const byName = (a, b) => collator.compare(a.name, b.name);

/** A group id that exists, else null (the library root). */
export function validGroupId(id) {
  return id != null && lib.groups.has(id) ? id : null;
}

export function childGroups(parentId) {
  return [...lib.groups.values()].filter((g) => validGroupId(g.parentId) === parentId).sort(byName);
}

export function childTechniques(groupId) {
  return [...lib.techniques.values()].filter((t) => validGroupId(t.groupId) === groupId).sort(byName);
}

export function mediaOf(techniqueId) {
  return [...lib.media.values()]
    .filter((m) => m.techniqueId === techniqueId)
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || (a.createdAt ?? 0) - (b.createdAt ?? 0));
}

/** The group and every group under it. */
export function subtreeGroupIds(groupId) {
  const out = new Set([groupId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const g of lib.groups.values()) {
      if (g.parentId != null && out.has(g.parentId) && !out.has(g.id)) { out.add(g.id); grew = true; }
    }
  }
  return out;
}

/** Techniques in a group's subtree (or the whole library for null), in browsing order. */
export function techniquesUnder(groupId) {
  const out = [];
  const walk = (gid) => {
    out.push(...childTechniques(gid));
    for (const g of childGroups(gid)) walk(g.id);
  };
  walk(groupId);
  return out;
}

export function countTechniquesUnder(groupId) {
  let n = childTechniques(groupId).length;
  for (const g of childGroups(groupId)) n += countTechniquesUnder(g.id);
  return n;
}

/** Root → … → group chain, for breadcrumbs. */
export function ancestry(groupId) {
  const chain = [];
  let id = validGroupId(groupId);
  let guard = 0;
  while (id != null && guard++ < 64) {
    const g = lib.groups.get(id);
    chain.unshift(g);
    id = validGroupId(g.parentId);
  }
  return chain;
}

export function comesFrom(techniqueId) {
  return [...lib.techniques.values()].filter((t) => (t.leadsToIds || []).includes(techniqueId)).sort(byName);
}

/** Related techniques, whichever side the link was added from (a related link has no direction). */
export function relatedOf(techniqueId) {
  const self = lib.techniques.get(techniqueId);
  const ids = new Set((self && self.relatedIds) || []);
  for (const o of lib.techniques.values()) if ((o.relatedIds || []).includes(techniqueId)) ids.add(o.id);
  ids.delete(techniqueId);
  return [...ids].map((id) => lib.techniques.get(id)).filter(Boolean).sort(byName);
}

export function leadsTo(technique) {
  return (technique.leadsToIds || []).map((id) => lib.techniques.get(id)).filter(Boolean);
}

export function search(query) {
  const q = query.trim().toLocaleLowerCase();
  if (!q) return { groups: [], techniques: [] };
  const hit = (...fields) => fields.flat().some((f) => String(f || '').toLocaleLowerCase().includes(q));
  return {
    groups: [...lib.groups.values()].filter((g) => hit(g.name, g.description, g.tags, g.notes)).sort(byName),
    techniques: [...lib.techniques.values()]
      .filter((t) => hit(t.name, t.description, t.position, t.tags, t.notes, t.steps))
      .sort(byName),
  };
}

export function totals() {
  let bytes = 0;
  for (const m of lib.media.values()) bytes += m.sizeBytes || 0;
  return { groups: lib.groups.size, techniques: lib.techniques.size, media: lib.media.size, bytes };
}

// --- mutations -------------------------------------------------------------------------------------

export function newGroup(parentId) {
  const now = Date.now();
  return { id: uuid(), parentId: validGroupId(parentId), name: '', description: '', tags: [], notes: '', links: [], coverKey: null, createdAt: now, modifiedAt: now };
}

export function newTechnique(groupId) {
  const now = Date.now();
  return {
    id: uuid(), groupId: validGroupId(groupId), name: '', description: '', steps: [], difficulty: 'UNSPECIFIED',
    position: '', classification: 'UNSPECIFIED', tags: [], notes: '', links: [], relatedIds: [], leadsToIds: [],
    coverKey: null, isFavorite: false, createdAt: now, modifiedAt: now, lastViewedAt: null,
  };
}

export async function saveGroup(g) {
  await commit({ groups: [{ ...g, modifiedAt: Date.now() }] });
}

export async function saveTechnique(t) {
  await commit({ techniques: [{ ...t, modifiedAt: Date.now() }] });
}

export async function setFavorite(id, isFavorite) {
  const t = lib.techniques.get(id);
  if (t) await commit({ techniques: [{ ...t, isFavorite }] });
}

/** Can `groupId` move under `newParentId` without becoming its own ancestor? */
export function canMoveGroup(groupId, newParentId) {
  return newParentId == null || !subtreeGroupIds(groupId).has(newParentId);
}

/** Replaces a cover image; the old file is removed in the same transaction. */
export async function setCover(kind, id, blob) {
  const map = kind === 'group' ? lib.groups : lib.techniques;
  const row = map.get(id);
  if (!row) return;
  const key = blob ? `c:${id}:${Date.now()}` : null;
  const next = { ...row, coverKey: key, modifiedAt: Date.now() };
  await commit({
    [kind === 'group' ? 'groups' : 'techniques']: [next],
    blobs: key ? [[key, blob]] : [],
    delBlobs: row.coverKey ? [row.coverKey] : [],
  });
}

function mediaBlobKeys(m) { return [m.blobKey, m.thumbKey]; }

export async function deleteTechnique(id) {
  const t = lib.techniques.get(id);
  if (!t) return;
  const media = mediaOf(id);
  // Drop links pointing at it so no technique keeps a dangling arrow.
  const touched = [...lib.techniques.values()]
    .filter((o) => o.id !== id && ((o.leadsToIds || []).includes(id) || (o.relatedIds || []).includes(id)))
    .map((o) => ({ ...o, leadsToIds: (o.leadsToIds || []).filter((x) => x !== id), relatedIds: (o.relatedIds || []).filter((x) => x !== id) }));
  await commit({
    techniques: touched,
    delTechniques: [id],
    delMedia: media.map((m) => m.id),
    delBlobs: [t.coverKey, ...media.flatMap(mediaBlobKeys)],
  });
}

/** Deletes a group with everything inside it. */
export async function deleteGroup(id) {
  const ids = subtreeGroupIds(id);
  const groups = [...ids].map((gid) => lib.groups.get(gid)).filter(Boolean);
  const techniques = [...lib.techniques.values()].filter((t) => ids.has(t.groupId));
  const techIds = new Set(techniques.map((t) => t.id));
  const media = [...lib.media.values()].filter((m) => techIds.has(m.techniqueId));
  const touched = [...lib.techniques.values()]
    .filter((o) => !techIds.has(o.id) && [...(o.leadsToIds || []), ...(o.relatedIds || [])].some((x) => techIds.has(x)))
    .map((o) => ({ ...o, leadsToIds: (o.leadsToIds || []).filter((x) => !techIds.has(x)), relatedIds: (o.relatedIds || []).filter((x) => !techIds.has(x)) }));
  await commit({
    techniques: touched,
    delGroups: groups.map((g) => g.id),
    delTechniques: [...techIds],
    delMedia: media.map((m) => m.id),
    delBlobs: [...groups.map((g) => g.coverKey), ...techniques.map((t) => t.coverKey), ...media.flatMap(mediaBlobKeys)],
  });
}

export async function deleteMedia(id) {
  const m = lib.media.get(id);
  if (!m) return;
  await commit({ delMedia: [id], delBlobs: mediaBlobKeys(m) });
}

/** Saves a new order for a technique's media (ids in display order). */
export async function reorderMedia(ids) {
  const rows = ids.map((id, i) => ({ ...lib.media.get(id), sortOrder: i + 1 })).filter((m) => m.id);
  await commit({ media: rows });
}

export function mediaTypeFor(mime, name = '') {
  const m = mime || '';
  if (m.startsWith('image/')) return 'IMAGE';
  if (m.startsWith('video/')) return 'VIDEO';
  if (!m && /\.(mp4|m4v|mov|webm|3gp)$/i.test(name)) return 'VIDEO';
  if (!m && /\.(jpe?g|png|gif|webp|heic)$/i.test(name)) return 'IMAGE';
  return 'DOCUMENT';
}

export function guessMime(name) {
  const ext = (String(name).split('.').pop() || '').toLowerCase();
  return {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
    heic: 'image/heic', mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime',
    webm: 'video/webm', '3gp': 'video/3gpp', pdf: 'application/pdf',
  }[ext] || '';
}

/**
 * Adds picked files to a technique. `probe(blob)` returns { durationMs, width, height, thumb } for
 * videos (best effort). Each file is stored in its own transaction so one failure keeps the rest.
 */
export async function addMediaFiles(techniqueId, files, probe, onEach) {
  let order = mediaOf(techniqueId).reduce((n, m) => Math.max(n, m.sortOrder ?? 0), 0);
  const added = [];
  for (const file of files) {
    const mimeType = file.type || guessMime(file.name);
    const type = mediaTypeFor(mimeType, file.name);
    const id = uuid();
    const info = type === 'VIDEO' || type === 'IMAGE' ? await probe(file, type).catch(() => ({})) : {};
    const row = {
      id, techniqueId, type, fileName: file.name || `${type.toLowerCase()}_${Date.now()}`, mimeType,
      sizeBytes: file.size, durationMs: info.durationMs ?? null, width: info.width ?? null, height: info.height ?? null,
      sortOrder: ++order, createdAt: Date.now(), blobKey: `m:${id}`, thumbKey: info.thumb ? `th:${id}` : null,
    };
    const blobs = [[row.blobKey, file]];
    if (info.thumb) blobs.push([row.thumbKey, info.thumb]);
    await commit({ media: [row], blobs });
    added.push(row);
    if (onEach) onEach(added.length);
  }
  const t = lib.techniques.get(techniqueId);
  if (t) await commit({ techniques: [{ ...t, modifiedAt: Date.now() }] });
  return added;
}

export async function setThumb(mediaId, blob) {
  const m = lib.media.get(mediaId);
  if (!m) return;
  const key = `th:${mediaId}`;
  await commit({ media: [{ ...m, thumbKey: key }], blobs: [[key, blob]] });
}
