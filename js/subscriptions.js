/**
 * Syllabus subscriptions, as in the Android app (src/data/subscriptions.ts): an instructor keeps a
 * package at one fixed link (usually their own Drive file) and students subscribe to it. The
 * syllabus lands in a group of its own; "Check for updates" reads the link again and swaps the
 * group's contents for the new version. Nothing is automatic: a check only runs when asked.
 *
 * Everything under a subscribed group is READ-ONLY in the UI, because an update replaces it
 * wholesale and would throw away any edit made there.
 *
 * Unlike the app, a check reads only the package's index and manifest (a few KB): the videos
 * download only when the export really is newer.
 */
import { t } from './i18n.js';
import { getMeta, setMeta } from './db.js';
import {
  lib, uuid, newGroup, commit, deleteGroup, deleteTechnique, childGroups, childTechniques, subtreeGroupIds,
} from './library.js';
import { readPackage, importPackage } from './packages.js';
import { urlSource } from './zip.js';
import { driveFileIdFrom, driveSource } from './drive.js';

const KEY = 'subscriptions';
let subs = [];

/** Loads the list; drops any whose group is gone (e.g. after "Delete everything"). */
export async function loadSubscriptions() {
  try {
    const v = await getMeta(KEY, []);
    subs = Array.isArray(v) ? v : [];
  } catch {
    subs = [];
  }
  const alive = subs.filter((s) => lib.groups.has(s.rootGroupId));
  if (alive.length !== subs.length) { subs = alive; await save(); }
  return subs;
}

async function save() {
  await setMeta(KEY, subs);
}

export const listSubscriptions = () => [...subs].sort((a, b) => (lib.groups.get(a.rootGroupId)?.name || '').localeCompare(lib.groups.get(b.rootGroupId)?.name || ''));

export function subscriptionOfGroup(groupId) {
  return subs.find((s) => s.rootGroupId === groupId) || null;
}

/** The subscription a group belongs to (itself or an ancestor is a syllabus root), or null. */
export function lockOfGroup(groupId) {
  let id = groupId;
  let guard = 0;
  while (id != null && guard++ < 64) {
    const s = subscriptionOfGroup(id);
    if (s) return s;
    id = lib.groups.get(id)?.parentId ?? null;
  }
  return null;
}

export function lockOfTechnique(techniqueId) {
  const x = lib.techniques.get(techniqueId);
  return x ? lockOfGroup(x.groupId) : null;
}

/** Every group inside a syllabus: excluded from "move into" and "import into" pickers. */
export function lockedGroupIds() {
  const out = new Set();
  for (const s of subs) if (lib.groups.has(s.rootGroupId)) for (const id of subtreeGroupIds(s.rootGroupId)) out.add(id);
  return out;
}

/** Where a link's package comes from, for the list and the banner: "Google Drive" or a host. */
export function sourceLabel(link) {
  if (driveFileIdFrom(link)) return 'Google Drive';
  try { return new URL(link).hostname.replace(/^www\./, ''); } catch { return link; }
}

const urlErrors = () => ({
  notLink: t('import.notLink'), drive: t('import.driveBlocked'), blocked: t('import.blocked'),
  notPublic: t('import.notPublic'), gone: t('import.gone'), http: t('import.http'), html: t('import.html'),
});

/** A package source for a subscription link (Drive through the Drive API, else Range reads). */
export function sourceForLink(link) {
  const driveId = driveFileIdFrom(link);
  return driveId ? driveSource(driveId) : urlSource(link, urlErrors());
}

/** Copies the package's own root-group fields onto the syllabus group (after a merge). */
async function adoptRoot(rootGroupId, mergedRoot, name = null) {
  if (!mergedRoot) return;
  const g = lib.groups.get(rootGroupId);
  if (!g) return;
  const d = mergedRoot.dto;
  await commit({
    groups: [{ ...g, ...(name ? { name } : {}), description: d.description || '', tags: d.tags || [], notes: d.notes || '', links: d.links || [], coverKey: mergedRoot.coverKey, modifiedAt: Date.now() }],
    delBlobs: g.coverKey && g.coverKey !== mergedRoot.coverKey ? [g.coverKey] : [],
  });
}

/** The name of the package's own folder, when it is a single folder; else null. */
const incomingName = (mergedRoot) => (mergedRoot && String(mergedRoot.dto.name || '').trim()) || null;

/**
 * The sender's new folder name, when the subscriber kept the name the syllabus came with;
 * null to leave the name alone. A name typed into "Name in your library" is never overwritten.
 * Subscriptions made before 1.4.2 didn't record the name they came with, and that box starts
 * out holding it, so they follow.
 */
function followedName(sub, group, mergedRoot) {
  const incoming = incomingName(mergedRoot);
  if (!incoming || !group || group.name === incoming) return null;
  const cameWith = sub.sourceName == null ? group.name : sub.sourceName;
  return group.name === cameWith ? incoming : null;
}

/**
 * Subscribes to a package already read with readPackage: a new group at the Library root, the
 * package imported into it, and where it came from recorded. Resolves { rootGroupId, result }.
 */
export async function subscribe(pkg, link, name, onProgress) {
  const group = { ...newGroup(null), name: String(name || '').trim() || t('subs.defaultName') };
  await commit({ groups: [group] });
  try {
    const result = await importPackage(pkg, group.id, onProgress, { mergeSingleRootGroup: true });
    await adoptRoot(group.id, result.mergedRoot);
    const now = Date.now();
    subs.push({
      id: uuid(), url: link.trim(), rootGroupId: group.id, packageExportedAt: pkg.manifest.exportedAt || 0,
      sourceName: incomingName(result.mergedRoot),
      addedAt: now, lastCheckedAt: now, lastUpdatedAt: now,
    });
    await save();
    return { rootGroupId: group.id, result };
  } catch (e) {
    await deleteGroup(group.id).catch(() => {});
    throw e;
  }
}

/**
 * Reads the link again; when it is a different export, replaces the syllabus group's contents.
 * The new version goes in BEFORE the old one is deleted, so a failed update leaves the old
 * syllabus whole. Resolves { status: 'UP_TO_DATE' } or { status: 'UPDATED', result }.
 */
export async function checkForUpdate(sub, onProgress) {
  const pkg = await readPackage(await sourceForLink(sub.url));
  const now = Date.now();
  const record = subs.find((s) => s.id === sub.id);
  if ((pkg.manifest.exportedAt || 0) === sub.packageExportedAt) {
    if (record) { record.lastCheckedAt = now; await save(); }
    return { status: 'UP_TO_DATE' };
  }
  const root = sub.rootGroupId;
  const oldGroups = childGroups(root).map((g) => g.id);
  const oldTechniques = childTechniques(root).map((x) => x.id);
  // No renaming: the old copies are about to go, and "(2)" suffixes would outlive them.
  const result = await importPackage(pkg, root, onProgress, { mergeSingleRootGroup: true, dedupeNames: false });
  for (const id of oldGroups) await deleteGroup(id);
  for (const id of oldTechniques) await deleteTechnique(id);
  await adoptRoot(root, result.mergedRoot, followedName(record || sub, lib.groups.get(root), result.mergedRoot));
  if (record) {
    record.packageExportedAt = pkg.manifest.exportedAt || 0;
    if (incomingName(result.mergedRoot)) record.sourceName = incomingName(result.mergedRoot);
    record.lastCheckedAt = now;
    record.lastUpdatedAt = now;
    await save();
  }
  return { status: 'UPDATED', result };
}

/** Removes the syllabus and its media from this device; the link keeps working for others. */
export async function unsubscribe(sub) {
  await deleteGroup(sub.rootGroupId);
  subs = subs.filter((s) => s.id !== sub.id);
  await save();
}
