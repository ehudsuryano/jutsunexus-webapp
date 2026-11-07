import { h, icon, iconButton, menu, confirmDialog, toast, pickFiles, fill } from '../dom.js';
import { t, tn } from '../i18n.js';
import {
  lib, mediaOf, deleteTechnique, deleteMedia, reorderMedia, setFavorite, setCover, addMediaFiles,
  leadsTo, comesFrom, validGroupId,
} from '../library.js';
import { chrome, $main, nav, routes, techniqueHead, techniqueSections, section, techniqueRow, formatDuration } from '../ui.js';
import { urlFor, mediaThumbUrl, probe, coverFromImage, firstVideoOf } from '../media.js';
import { getBlob, isQuotaError } from '../db.js';
import { openPlayer } from '../player.js';
import { shareExport, shareTechniqueLink } from '../share.js';

/** Arrange mode is per technique and survives the re-render after each change. */
let arranging = null;

export function renderTechnique(id) {
  const x = lib.techniques.get(id);
  if (!x) { nav('/', { replace: true }); return; }
  if (arranging !== id) arranging = null;
  const media = mediaOf(id);
  const rerender = () => renderTechnique(id);

  const favBtn = iconButton(x.isFavorite ? 'star' : 'starOutline', x.isFavorite ? t('technique.unfavorite') : t('technique.favorite'), async () => {
    await setFavorite(id, !x.isFavorite);
    rerender();
  }, x.isFavorite ? 'fav-on' : '');

  chrome({
    title: x.name,
    back: routes.group(validGroupId(x.groupId)),
    tab: 'library',
    crumbs: validGroupId(x.groupId),
    crumbLeaf: x.name,
    actions: [
      favBtn,
      iconButton('edit', t('common.edit'), () => nav(`/t/${id}/edit`)),
      iconButton('more', t('common.more'), () => techniqueMenu(x)),
    ],
  });

  const items = media.map((m) => ({ media: m, title: x.name }));
  const openAt = (m) => openPlayer(items, media.indexOf(m));

  const parts = [hero(x, openAt), techniqueHead(x)];

  // Media
  const addBtn = h('button', { class: 'text-btn', type: 'button', onclick: () => addMedia(x, rerender) }, icon('add', 18), t('media.add'));
  const arrangeBtn = media.length > 1 || (arranging && media.length)
    ? h('button', { class: `text-btn${arranging ? ' on' : ''}`, type: 'button', onclick: () => { arranging = arranging ? null : id; rerender(); } },
        arranging ? t('media.done') : t('media.arrange'))
    : null;
  const head = h('div', { class: 'section-head' }, h('h2', {}, media.length ? t('media.titleCount', { n: media.length }) : t('media.title')), h('span', { class: 'spacer' }), arrangeBtn, addBtn);
  const grid = media.length
    ? h('div', { class: `media-grid${arranging ? ' arranging' : ''}` }, media.map((m, i) => mediaTile(x, m, i, media, openAt, rerender)))
    : h('button', { class: 'media-empty', type: 'button', onclick: () => addMedia(x, rerender) }, icon('image', 28), h('span', {}, t('media.empty')));
  parts.push(h('section', { class: 'section' }, head, grid));

  parts.push(...techniqueSections(x));

  const next = leadsTo(x);
  const prev = comesFrom(x.id);
  if (next.length) parts.push(section(t('technique.leadsTo'), h('div', { class: 'list' }, next.map(techniqueRow))));
  if (prev.length) parts.push(section(t('technique.comesFrom'), h('div', { class: 'list' }, prev.map(techniqueRow))));

  if (!x.description && !(x.steps || []).length && !x.notes && !(x.links || []).length) {
    parts.push(h('p', { class: 'muted small section' }, t('technique.noText'), ' ',
      h('a', { href: `#/t/${id}/edit` }, t('technique.addText'))));
  }
  fill($main(), ...parts);
}

function hero(x, openAt) {
  if (x.coverKey) {
    const img = h('img', { class: 'cover', alt: '' });
    urlFor(x.coverKey).then((u) => { if (u) img.src = u; else img.remove(); });
    return img;
  }
  const v = firstVideoOf(x);
  if (!v) return null;
  const btn = h('button', { class: 'cover hero-video', type: 'button', 'aria-label': t('player.play'), onclick: () => openAt(v) },
    h('span', { class: 'hero-play' }, icon('play', 36)));
  mediaThumbUrl(v).then((u) => { if (u) btn.prepend(h('img', { src: u, alt: '' })); });
  return btn;
}

function mediaTile(x, m, index, all, openAt, rerender) {
  const tile = h('button', {
    class: `tile ${m.type === 'VIDEO' ? 'video' : 'other'}`, type: 'button', 'aria-label': m.fileName,
    onclick: () => { if (!document.querySelector('.media-grid.arranging')) openAt(m); },
  });
  if (m.type === 'IMAGE') {
    urlFor(m.blobKey).then((u) => u && tile.prepend(h('img', { src: u, alt: '', loading: 'lazy', decoding: 'async' })));
  } else if (m.type === 'VIDEO') {
    tile.append(h('span', { class: 'tile-icon' }, icon('play', 32)));
    mediaThumbUrl(m).then((u) => {
      if (!u) return;
      tile.querySelector('.tile-icon')?.remove();
      tile.prepend(h('img', { src: u, alt: '', loading: 'lazy', decoding: 'async' }));
    });
    tile.append(h('span', { class: 'badge' }, icon('play', 12), formatDuration(m.durationMs) || t('media.video')));
  } else {
    tile.append(h('span', { class: 'doc' }, icon('doc', 28), h('br'), m.fileName));
  }
  if (document.querySelector('.media-grid.arranging') || arranging) {
    const move = async (step) => {
      const ids = all.map((a) => a.id);
      const j = index + step;
      if (j < 0 || j >= ids.length) return;
      [ids[index], ids[j]] = [ids[j], ids[index]];
      await reorderMedia(ids);
      rerender();
    };
    const tools = h('span', { class: 'tile-tools' },
      index > 0 ? toolBtn('prev', t('media.earlier'), () => move(-1)) : null,
      index < all.length - 1 ? toolBtn('next', t('media.later'), () => move(1)) : null,
      m.type === 'IMAGE' || m.type === 'VIDEO' ? toolBtn('image', t('media.setCover'), () => useAsCover(x, m, rerender)) : null,
      toolBtn('trash', t('common.delete'), async () => {
        const ok = await confirmDialog({ title: t('media.deleteTitle'), body: m.fileName, ok: t('common.delete'), cancel: t('common.cancel'), danger: true });
        if (!ok) return;
        await deleteMedia(m.id);
        rerender();
      }));
    tile.append(tools);
  }
  return tile;
}

function toolBtn(name, label, fn) {
  return h('span', {
    class: 'tool', role: 'button', tabindex: '0', 'aria-label': label, title: label,
    onclick: (e) => { e.stopPropagation(); fn(); },
    onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); fn(); } },
  }, icon(name, 18));
}

async function useAsCover(x, m, rerender) {
  try {
    let blob;
    if (m.type === 'IMAGE') blob = await coverFromImage(await getBlob(m.blobKey));
    else {
      if (!m.thumbKey) await mediaThumbUrl(m);
      const fresh = lib.media.get(m.id);
      blob = fresh && fresh.thumbKey ? await getBlob(fresh.thumbKey) : null;
    }
    if (!blob) { toast(t('media.coverFailed')); return; }
    await setCover('technique', x.id, blob);
    toast(t('media.coverSet'));
    rerender();
  } catch {
    toast(t('media.coverFailed'));
  }
}

export async function addMedia(x, rerender) {
  const files = await pickFiles({ accept: 'image/*,video/*,application/pdf', multiple: true });
  if (!files.length) return;
  try {
    toast(t('media.adding', { done: 0, total: files.length }), 60000);
    await addMediaFiles(x.id, files, probe, (n) => toast(t('media.adding', { done: n, total: files.length }), 60000));
    toast(tn('media.added', files.length));
  } catch (e) {
    toast(isQuotaError(e) ? t('import.noSpace') : ((e && e.message) || String(e)), 6000);
  }
  rerender();
}

function techniqueMenu(x) {
  const hasVideo = mediaOf(x.id).some((m) => m.type === 'VIDEO');
  menu(x.name, [
    hasVideo ? {
      label: t('library.playAll'), icon: 'play',
      onSelect: () => openPlayer(mediaOf(x.id).filter((m) => m.type === 'VIDEO').map((m) => ({ media: m, title: x.name })), 0, { playlist: true }),
    } : null,
    { label: t('share.link'), icon: 'link', onSelect: () => shareTechniqueLink(x) },
    { label: t('share.packageMedia'), icon: 'share', onSelect: () => shareExport({ kind: 'technique', id: x.id }, true) },
    { label: t('share.packageText'), icon: 'share', onSelect: () => shareExport({ kind: 'technique', id: x.id }, false) },
    x.coverKey ? { label: t('media.removeCover'), icon: 'image', onSelect: async () => { await setCover('technique', x.id, null); renderTechnique(x.id); } } : null,
    {
      label: t('common.delete'), icon: 'trash', danger: true,
      onSelect: async () => {
        const n = mediaOf(x.id).length;
        const ok = await confirmDialog({
          title: t('technique.deleteTitle', { name: x.name }),
          body: n ? tn('technique.deleteBodyMedia', n) : t('technique.deleteBody'),
          ok: t('common.delete'), cancel: t('common.cancel'), danger: true,
        });
        if (!ok) return;
        await deleteTechnique(x.id);
        toast(t('library.deleted'));
        nav(routes.group(validGroupId(x.groupId)), { replace: true });
      },
    },
  ]);
}
