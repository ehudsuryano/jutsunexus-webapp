/**
 * Import and export of JutsuNexus packages (format v1), matching the Android app's
 * importManager.ts / exportManager.ts so packages travel both ways between the app and this one.
 *
 * Import: every row gets a fresh id; the package's root items land in the destination group;
 * root names that clash get " (2)"; media order follows the manifest's `mediaOrder`.
 */
import * as db from './db.js';
import { t } from './i18n.js';
import { lib, uuid, commit, validGroupId, childGroups, childTechniques, subtreeGroupIds, mediaOf, guessMime } from './library.js';
import { openZip, entryBlob, buildZip, textBlob, ZipError, ZipTooBigError } from './zip.js';

export const PACKAGE_FORMAT_VERSION = 1;
export const APP_NAME = 'JutsuNexus';
export const APP_VERSION = '1.2.0-web';

async function readJson(source, entries, name) {
  const entry = entries.get(name);
  if (!entry) return null;
  return JSON.parse(await (await entryBlob(source, entry)).text());
}

/** Opens a package and reads its manifest + content. Cheap: no media is read. */
export async function readPackage(source) {
  let entries;
  try {
    entries = await openZip(source);
  } catch (e) {
    if (e instanceof ZipError) throw new Error(t('import.notZip'));
    throw e;
  }
  let manifest;
  let content;
  try {
    manifest = await readJson(source, entries, 'manifest.json');
    if (!manifest) throw new Error(t('import.notPackage'));
    content = (await readJson(source, entries, 'content.json')) || {};
  } catch (e) {
    if (e instanceof SyntaxError || e instanceof ZipError) throw new Error(t('import.damaged'));
    throw e;
  }
  if ((manifest.formatVersion || 1) > PACKAGE_FORMAT_VERSION) throw new Error(t('import.tooNew'));
  const groups = content.groups || [];
  const techniques = content.techniques || [];
  const media = content.media || [];
  const ids = new Set(groups.map((g) => g.id));
  const rootGroups = groups.filter((g) => g.parentId == null || !ids.has(g.parentId));
  const rootTechniques = techniques.filter((x) => x.groupId == null || !ids.has(x.groupId));
  const rootName = rootGroups.length === 1 && rootTechniques.length === 0 ? rootGroups[0].name
    : rootGroups.length === 0 && rootTechniques.length === 1 ? rootTechniques[0].name : null;
  const mediaBytes = media.reduce((n, m) => n + (entries.get(m.zipEntry)?.size || m.sizeBytes || 0), 0);
  return { source, entries, manifest, groups, techniques, media, rootName, mediaBytes };
}

function videosFirst(list) {
  const rank = { VIDEO: 0, IMAGE: 1 };
  return list.map((m, i) => ({ m, i }))
    .sort((a, b) => (rank[a.m.type] ?? 2) - (rank[b.m.type] ?? 2) || a.i - b.i)
    .map((x) => x.m);
}

/**
 * Imports a package read by `readPackage`. Files are stored one per transaction (a phone can't
 * hold a whole library in one), then all rows in a single transaction; any failure removes the
 * files stored so far, so a failed import leaves nothing behind.
 */
export async function importPackage(pkg, destinationGroupId, onProgress) {
  const { source, entries, manifest, groups, techniques, media } = pkg;
  const destination = validGroupId(destinationGroupId);
  const now = Date.now();

  const groupIdMap = new Map(groups.map((g) => [g.id, uuid()]));
  const techniqueIdMap = new Map(techniques.map((x) => [x.id, uuid()]));

  const taken = new Set([...childGroups(destination), ...childTechniques(destination)].map((x) => x.name.toLowerCase()));
  let renamed = 0;
  const uniqueName = (name) => {
    const n = String(name || '').trim() || t('common.untitled');
    if (!taken.has(n.toLowerCase())) { taken.add(n.toLowerCase()); return n; }
    let c = 2;
    while (taken.has(`${n.toLowerCase()} (${c})`)) c++;
    taken.add(`${n.toLowerCase()} (${c})`);
    renamed++;
    return `${n} (${c})`;
  };

  const storedKeys = [];
  const total = media.length + groups.filter((g) => g.coverEntry).length + techniques.filter((x) => x.coverEntry).length;
  let doneCount = 0;
  const tick = () => { doneCount++; if (onProgress) onProgress(doneCount, total); };

  const storeEntry = async (entryName, key, type) => {
    const entry = entryName ? entries.get(entryName) : null;
    if (!entry) return false;
    const blob = await entryBlob(source, entry, type || guessMime(entryName));
    await db.putBlob(key, blob);
    storedKeys.push(key);
    return true;
  };

  try {
    const groupRows = [];
    for (const g of groups) {
      const id = groupIdMap.get(g.id);
      const parent = g.parentId != null ? groupIdMap.get(g.parentId) ?? null : null;
      const coverKey = g.coverEntry ? `c:${id}:${now}` : null;
      const hasCover = coverKey ? await storeEntry(g.coverEntry, coverKey) : false;
      if (coverKey) tick();
      groupRows.push({
        id, parentId: parent ?? destination, name: parent == null ? uniqueName(g.name) : g.name,
        description: g.description || '', tags: g.tags || [], notes: g.notes || '', links: g.links || [],
        coverKey: hasCover ? coverKey : null,
        createdAt: g.createdAt > 0 ? g.createdAt : now, modifiedAt: now,
      });
    }

    const techniqueRows = [];
    for (const x of techniques) {
      const id = techniqueIdMap.get(x.id);
      const gid = x.groupId != null ? groupIdMap.get(x.groupId) ?? null : null;
      const coverKey = x.coverEntry ? `c:${id}:${now}` : null;
      const hasCover = coverKey ? await storeEntry(x.coverEntry, coverKey) : false;
      if (coverKey) tick();
      const remap = (list) => (list || []).map((o) => techniqueIdMap.get(o)).filter(Boolean);
      techniqueRows.push({
        id, groupId: gid ?? destination, name: gid == null ? uniqueName(x.name) : x.name,
        description: x.description || '', steps: x.steps || [], difficulty: x.difficulty || 'UNSPECIFIED',
        position: x.position || '', classification: x.classification || 'UNSPECIFIED', tags: x.tags || [],
        notes: x.notes || '', links: x.links || [], relatedIds: remap(x.relatedIds), leadsToIds: remap(x.leadsToIds),
        coverKey: hasCover ? coverKey : null, isFavorite: !!x.isFavorite,
        createdAt: x.createdAt > 0 ? x.createdAt : now, modifiedAt: now, lastViewedAt: null,
      });
    }

    let skipped = 0;
    const mediaRows = [];
    for (const m of media) {
      const techniqueId = techniqueIdMap.get(m.techniqueId);
      if (!techniqueId) { tick(); continue; }
      const id = uuid();
      const blobKey = `m:${id}`;
      const mimeType = m.mimeType || guessMime(m.fileName);
      if (!(await storeEntry(m.zipEntry, blobKey, mimeType))) { skipped++; tick(); continue; }
      mediaRows.push({
        id, techniqueId, type: m.type || 'DOCUMENT', fileName: m.fileName || 'file', mimeType,
        sizeBytes: entries.get(m.zipEntry)?.size ?? m.sizeBytes ?? 0,
        durationMs: m.durationMs ?? null, width: m.width ?? null, height: m.height ?? null,
        sortOrder: m.sortOrder ?? 0, createdAt: now, blobKey, thumbKey: null,
      });
      tick();
    }

    // Position of each item in its technique's media, 1..n.
    const byTech = new Map();
    for (const m of mediaRows) {
      if (!byTech.has(m.techniqueId)) byTech.set(m.techniqueId, []);
      byTech.get(m.techniqueId).push(m);
    }
    for (const list of byTech.values()) {
      const stored = [...list].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
      const ordered = manifest.mediaOrder === 'manual' ? stored : videosFirst(stored);
      ordered.forEach((m, i) => { m.sortOrder = i + 1; });
    }

    await commit({ groups: groupRows, techniques: techniqueRows, media: mediaRows });
    return { groups: groupRows.length, techniques: techniqueRows.length, media: mediaRows.length, skipped, renamed };
  } catch (e) {
    await db.deleteBlobs(storedKeys).catch(() => {});
    if (db.isQuotaError(e)) throw new Error(t('import.noSpace'));
    throw e;
  }
}

// --- export -------------------------------------------------------------------------------------

function sanitize(name) {
  return String(name || 'file').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim() || 'file';
}

function extFromMime(mime) {
  return { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/heic': 'heic' }[mime] || 'jpg';
}

/**
 * target: { kind: 'library' } | { kind: 'group', id } | { kind: 'technique', id }
 * Resolves { blob, fileName, counts }.
 */
export async function exportPackage(target, includeMedia, onProgress) {
  let groups;
  let techniques;
  let exportType;
  let label;
  if (target.kind === 'library') {
    exportType = 'LIBRARY';
    label = 'Library';
    groups = [...lib.groups.values()];
    techniques = [...lib.techniques.values()];
  } else if (target.kind === 'group') {
    exportType = 'GROUP';
    const ids = subtreeGroupIds(target.id);
    groups = [...ids].map((id) => lib.groups.get(id)).filter(Boolean)
      .map((g) => (g.id === target.id ? { ...g, parentId: null } : g));
    techniques = [...lib.techniques.values()].filter((x) => ids.has(x.groupId));
    label = lib.groups.get(target.id)?.name || 'Group';
  } else {
    exportType = 'TECHNIQUE';
    const x = lib.techniques.get(target.id);
    if (!x) throw new Error(t('export.notFound'));
    groups = [];
    techniques = [{ ...x, groupId: null }];
    label = x.name;
  }

  const files = []; // { name, key }
  const coverEntry = (ownerId, key) => {
    if (!key) return null;
    const entry = `covers/${ownerId}_cover`;
    files.push({ name: entry, key, cover: true });
    return entry;
  };

  const groupDtos = groups.map((g) => ({
    id: g.id, parentId: g.parentId ?? null, name: g.name, description: g.description || '',
    tags: g.tags || [], notes: g.notes || '', links: g.links || [],
    coverEntry: coverEntry(g.id, g.coverKey), createdAt: g.createdAt, modifiedAt: g.modifiedAt,
  }));
  const techIds = new Set(techniques.map((x) => x.id));
  const techniqueDtos = techniques.map((x) => ({
    id: x.id, groupId: x.groupId ?? null, name: x.name, description: x.description || '', steps: x.steps || [],
    difficulty: x.difficulty || 'UNSPECIFIED', position: x.position || '', classification: x.classification || 'UNSPECIFIED',
    tags: x.tags || [], notes: x.notes || '', links: x.links || [],
    relatedIds: (x.relatedIds || []).filter((id) => techIds.has(id)),
    leadsToIds: (x.leadsToIds || []).filter((id) => techIds.has(id)),
    coverEntry: coverEntry(x.id, x.coverKey), isFavorite: !!x.isFavorite, createdAt: x.createdAt, modifiedAt: x.modifiedAt,
  }));

  const mediaDtos = [];
  if (includeMedia) {
    for (const x of techniques) {
      for (const m of mediaOf(x.id)) {
        const entry = `media/${m.id}_${sanitize(m.fileName)}`;
        files.push({ name: entry, key: m.blobKey });
        mediaDtos.push({
          id: m.id, techniqueId: m.techniqueId, type: m.type, fileName: m.fileName, mimeType: m.mimeType,
          sizeBytes: m.sizeBytes, durationMs: m.durationMs ?? null, width: m.width ?? null, height: m.height ?? null,
          sortOrder: m.sortOrder, zipEntry: entry,
        });
      }
    }
  }

  // Read the stored files; a missing one is left out of the package rather than failing it.
  const zipEntries = [];
  const present = new Set();
  for (const f of files) {
    const blob = await db.getBlob(f.key);
    if (!blob) continue;
    let name = f.name;
    if (f.cover) name = `${f.name}.${extFromMime(blob.type)}`;
    zipEntries.push({ name, blob, ref: f });
    present.add(f.name);
    f.finalName = name;
  }
  for (const g of groupDtos) {
    if (g.coverEntry) g.coverEntry = present.has(g.coverEntry) ? files.find((f) => f.name === g.coverEntry).finalName : null;
  }
  for (const x of techniqueDtos) {
    if (x.coverEntry) x.coverEntry = present.has(x.coverEntry) ? files.find((f) => f.name === x.coverEntry).finalName : null;
  }
  const mediaOut = mediaDtos.filter((m) => present.has(m.zipEntry));

  const manifest = {
    formatVersion: PACKAGE_FORMAT_VERSION, app: APP_NAME, appVersion: APP_VERSION, exportType,
    exportedAt: Date.now(), includesMedia: !!includeMedia,
    groupCount: groupDtos.length, techniqueCount: techniqueDtos.length, mediaCount: mediaOut.length,
    mediaOrder: 'manual',
  };
  const content = { groups: groupDtos, techniques: techniqueDtos, media: mediaOut };

  let blob;
  try {
    blob = await buildZip([
      { name: 'manifest.json', blob: textBlob(JSON.stringify(manifest)) },
      { name: 'content.json', blob: textBlob(JSON.stringify(content)) },
      ...zipEntries.map(({ name, blob: b }) => ({ name, blob: b })),
    ], onProgress);
  } catch (e) {
    if (e instanceof ZipTooBigError) throw new Error(t('export.tooBig'));
    throw e;
  }
  const date = new Date().toISOString().slice(0, 10);
  const fileName = `JutsuNexus_${sanitize(label).replace(/\s+/g, '_')}_${date}.zip`;
  return { blob, fileName, counts: { groups: groupDtos.length, techniques: techniqueDtos.length, media: mediaOut.length } };
}
