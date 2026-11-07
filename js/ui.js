/** Shared screen pieces: top bar, navigation, list rows, thumbnails, technique text sections. */
import { h, icon, iconButton } from './dom.js';
import { t, tn, ltr, isRtl } from './i18n.js';
import { lib, ancestry, childGroups, countTechniquesUnder, mediaOf } from './library.js';
import { urlFor, techniqueThumb, thumbNode } from './media.js';

export const $main = () => document.getElementById('main');

// --- navigation ------------------------------------------------------------------------------------

const stack = [];

/** Called by the router on every hash change; keeps a small stack to know if Back can go back. */
export function trackRoute() {
  const cur = location.hash || '#/';
  if (stack.length >= 2 && stack[stack.length - 2] === cur) stack.pop();
  else if (stack[stack.length - 1] !== cur) stack.push(cur);
}

export function nav(path, { replace = false } = {}) {
  const hash = path.startsWith('#') ? path : `#${path}`;
  if (replace) {
    stack.pop();
    location.replace(hash);
  } else if ((location.hash || '#/') === hash) {
    // Same address (the Library tab shows the list or the graph): render it again anyway.
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  } else {
    location.hash = hash;
  }
}

/** Back: the previous screen when there is one in this session, else `fallback`. */
export function goBack(fallback) {
  if (stack.length > 1) history.back();
  else nav(fallback || '/', { replace: true });
}

export const routes = {
  group: (id) => (id ? `/g/${id}` : '/'),
  technique: (id) => `/t/${id}`,
};

// --- chrome ---------------------------------------------------------------------------------------

/**
 * title: string; back: fallback route (or null for none); actions: nodes; tab: which tab is lit;
 * crumbs: group id whose path is shown under the bar (undefined = none).
 */
export function chrome({ title, back = null, actions = [], tab = null, crumbs, crumbLeaf }) {
  const bar = document.getElementById('topbar');
  const backBtn = back != null ? iconButton('back', t('common.back'), () => goBack(back)) : null;
  bar.replaceChildren(
    ...(backBtn ? [backBtn] : []),
    h('h1', { class: `bar-title${backBtn ? '' : ' no-back'}`, dir: 'auto' }, title),
    h('div', { class: 'bar-actions' }, actions));
  document.title = title && title !== 'JutsuNexus' ? `${title} · JutsuNexus` : 'JutsuNexus';
  for (const el of document.querySelectorAll('.tabbar a')) {
    el.classList.toggle('active', el.dataset.tab === tab);
    if (el.dataset.tab === tab) el.setAttribute('aria-current', 'page');
    else el.removeAttribute('aria-current');
  }
  const $crumbs = document.getElementById('crumbs');
  if (crumbs === undefined) { $crumbs.hidden = true; return; }
  const chain = ancestry(crumbs);
  const parts = [h('a', { href: '#/' }, t('library.title'))];
  chain.forEach((g, i) => {
    parts.push(h('span', { 'aria-hidden': 'true' }, isRtl ? '‹' : '›'));
    const last = i === chain.length - 1 && !crumbLeaf;
    parts.push(last ? h('span', { class: 'current', dir: 'auto' }, g.name) : h('a', { href: `#${routes.group(g.id)}`, dir: 'auto' }, g.name));
  });
  if (crumbLeaf) {
    parts.push(h('span', { 'aria-hidden': 'true' }, isRtl ? '‹' : '›'));
    parts.push(h('span', { class: 'current', dir: 'auto' }, crumbLeaf));
  }
  $crumbs.replaceChildren(...parts);
  $crumbs.hidden = chain.length === 0 && !crumbLeaf;
}

// --- rows -----------------------------------------------------------------------------------------

export function thumbBox(kind, loadUrl, extra) {
  const box = h('span', { class: `thumb ${kind}` }, icon(kind === 'group' ? 'folder' : 'technique', 28), extra);
  if (loadUrl) {
    loadUrl().then((res) => {
      const node = typeof res === 'string' ? h('img', { src: res, alt: '', loading: 'lazy', decoding: 'async' }) : thumbNode(res);
      if (node) box.replaceChildren(node, extra || '');
    }).catch(() => {});
  }
  return box;
}

export function groupRow(g) {
  const sub = childGroups(g.id).length;
  const tech = countTechniquesUnder(g.id);
  return h('a', { class: 'item', href: `#${routes.group(g.id)}` },
    thumbBox('group', g.coverKey ? () => urlFor(g.coverKey) : null),
    h('span', { class: 'item-body' },
      h('span', { class: 'item-title', dir: 'auto' }, g.name),
      h('span', { class: 'item-meta' }, [sub > 0 ? tn('count.groups', sub) : null, tn('count.techniques', tech)].filter(Boolean).join(' • '))));
}

export function techniqueRow(x) {
  const media = mediaOf(x.id);
  const videos = media.filter((m) => m.type === 'VIDEO').length;
  const meta = [
    videos > 0 ? tn('count.videos', videos) : null,
    media.length - videos > 0 ? tn('count.files', media.length - videos) : null,
    x.position || null,
  ].filter(Boolean).join(' • ');
  return h('a', { class: 'item', href: `#${routes.technique(x.id)}` },
    thumbBox('technique', () => techniqueThumb(x), videos > 0 ? h('span', { class: 'thumb-play' }, icon('play', 14)) : null),
    h('span', { class: 'item-body' },
      h('span', { class: 'item-title', dir: 'auto' }, x.isFavorite ? h('span', { class: 'fav-dot', 'aria-label': t('technique.favorite') }, icon('star', 14)) : null, x.name),
      meta ? h('span', { class: 'item-meta' }, meta) : null,
      difficultyBar(x.difficulty)));
}

// --- technique text --------------------------------------------------------------------------------

const LEVEL = { BEGINNER: 1, INTERMEDIATE: 2, ADVANCED: 3, EXPERT: 4 };

export function difficultyBar(d, withLabel) {
  const level = LEVEL[d];
  if (!level) return null;
  const label = t(`difficulty.${d}`);
  return h('span', { class: 'difficulty', title: label },
    [1, 2, 3, 4].map((i) => h('i', { class: i <= level ? 'on' : '' })),
    withLabel ? h('span', { class: 'difficulty-label' }, label) : null);
}

export function tagChips(tags) {
  if (!tags || tags.length === 0) return null;
  return h('div', { class: 'chips' }, tags.map((x) => h('span', { class: 'chip', dir: 'auto' }, x)));
}

export function section(title, ...body) {
  return h('section', { class: 'section' }, h('h2', {}, title), ...body);
}

export function safeHref(url) {
  const u = String(url || '').trim();
  if (/^https?:\/\//i.test(u)) return u;
  if (/^[\w-]+(\.[\w-]+)+/.test(u)) return `https://${u}`;
  return null;
}

function isYouTube(url) {
  return /(^|\/\/)(www\.|m\.)?(youtube\.com|youtu\.be)\//i.test(url || '');
}

function linkTitle(l) {
  if (l.title && l.title.trim()) return l.title;
  try { return new URL(safeHref(l.url)).hostname.replace(/^www\./, ''); } catch { return l.url; }
}

export function techniqueHead(x) {
  const meta = [
    x.classification && x.classification !== 'UNSPECIFIED' ? t(`classification.${x.classification}`) : null,
    x.position || null,
  ].filter(Boolean);
  return h('div', { class: 'tech-head' },
    h('h2', { class: 'tech-title', dir: 'auto' }, x.name),
    meta.length || LEVEL[x.difficulty]
      ? h('div', { class: 'meta-row' }, meta.map((m) => h('span', { dir: 'auto' }, m)), difficultyBar(x.difficulty, true))
      : null,
    tagChips(x.tags));
}

/** Description, steps, notes, links — shared by library techniques and technique links. */
export function techniqueSections(x) {
  const out = [];
  if (x.description) out.push(section(t('technique.description'), h('p', { class: 'prose', dir: 'auto' }, x.description)));
  if (x.steps && x.steps.length) {
    out.push(section(t('technique.steps'),
      h('ol', { class: 'steps' }, x.steps.map((s, i) => h('li', {}, h('span', { class: 'n' }, i + 1), h('span', { class: 'prose', dir: 'auto' }, s))))));
  }
  if (x.notes) out.push(section(t('technique.notes'), h('p', { class: 'prose', dir: 'auto' }, x.notes)));
  if (x.links && x.links.length) {
    out.push(section(t('technique.links'), h('div', { class: 'links' }, x.links.map((l) => {
      const href = safeHref(l.url);
      const yt = isYouTube(l.url);
      return h(href ? 'a' : 'div', { class: `link${yt ? ' yt' : ''}`, href, target: '_blank', rel: 'noopener noreferrer' },
        icon(yt ? 'youtube' : 'link', 22),
        h('div', {}, h('b', { dir: 'auto' }, linkTitle(l)), h('small', {}, l.url)));
    }))));
  }
  return out;
}

export function formatBytes(n) {
  if (!n || n < 0) return ltr('0 MB');
  if (n < 1024 * 1024) return ltr(`${Math.max(1, Math.round(n / 1024))} KB`);
  if (n < 1024 ** 3) return ltr(`${(n / 1024 ** 2).toFixed(n < 10 * 1024 ** 2 ? 1 : 0)} MB`);
  return ltr(`${(n / 1024 ** 3).toFixed(2)} GB`);
}

export function formatDuration(ms) {
  if (!ms || ms <= 0) return null;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function isIos() {
  return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

export function isStandalone() {
  return navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
}

/** Group <option>s indented by depth, for "Folder" pickers. `exclude` = ids that can't be picked. */
export function groupOptions(selectedId, exclude = new Set()) {
  const opts = [h('option', { value: '', selected: selectedId == null }, t('library.title'))];
  const walk = (parentId, depth) => {
    for (const g of childGroups(parentId)) {
      if (exclude.has(g.id)) continue;
      opts.push(h('option', { value: g.id, selected: g.id === selectedId }, `${' '.repeat(depth)}${g.name}`));
      walk(g.id, depth + 1);
    }
  };
  walk(null, 1);
  return opts;
}

