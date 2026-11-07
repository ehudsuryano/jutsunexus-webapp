/**
 * The technique map: one technique's neighbourhood in rows, in the order you'd perform them —
 * what leads to it above, the technique (with its related techniques beside it) in the middle,
 * what it leads to below. Port of the Android app's src/domain/techniqueMap.ts and its screen.
 */
import { h, icon, fill } from '../dom.js';
import { t } from '../i18n.js';
import { lib, validGroupId } from '../library.js';
import { chrome, $main, nav, routes } from '../ui.js';
import { techniqueThumbUrl } from '../media.js';

const NODE_WIDTH = 150;
const NODE_HEIGHT = 64;
const COLUMN_GAP = 18;
const ROW_GAP = 70;
const MARGIN = 20;
const STEPS_UP = 2;
const STEPS_DOWN = 3;
const SVG_NS = 'http://www.w3.org/2000/svg';

export function layoutTechniqueMap(all, focusId, minWidth) {
  const byId = new Map(all.map((x) => [x.id, x]));
  const focus = byId.get(focusId);
  if (!focus) return null;
  const nameOrder = (a, b) => byId.get(a).name.localeCompare(byId.get(b).name);

  const leadsTo = (x) => (x.leadsToIds || []).filter((id) => id !== x.id && byId.has(id));
  const comesFrom = new Map();
  const relatedOf = new Map();
  const relate = (a, b) => {
    if (a === b || !byId.has(a) || !byId.has(b)) return;
    if (!relatedOf.has(a)) relatedOf.set(a, new Set());
    if (!relatedOf.has(b)) relatedOf.set(b, new Set());
    relatedOf.get(a).add(b);
    relatedOf.get(b).add(a);
  };
  for (const x of all) {
    for (const id of leadsTo(x)) {
      if (!comesFrom.has(id)) comesFrom.set(id, []);
      comesFrom.get(id).push(x.id);
    }
    for (const id of x.relatedIds || []) relate(x.id, id);
  }

  const layerOf = new Map([[focus.id, 0]]);
  const rows = new Map([[0, [focus.id]]]);
  const grow = (direction, steps) => {
    let frontier = [focus.id];
    for (let step = 1; step <= steps && frontier.length > 0; step++) {
      const next = [];
      for (const id of frontier) {
        const neighbours = direction === 1 ? leadsTo(byId.get(id)) : comesFrom.get(id) || [];
        for (const n of neighbours) {
          if (layerOf.has(n)) continue;
          layerOf.set(n, direction * step);
          next.push(n);
        }
      }
      if (next.length > 0) rows.set(direction * step, next);
      frontier = next;
    }
  };
  grow(1, STEPS_DOWN);
  grow(-1, STEPS_UP);

  // Related techniques of the centre sit beside it, half on each side; arrows win.
  const related = [...(relatedOf.get(focus.id) || [])].filter((id) => !layerOf.has(id)).sort(nameOrder);
  const left = related.slice(0, Math.floor(related.length / 2));
  const right = related.slice(Math.floor(related.length / 2));
  rows.set(0, [...left, focus.id, ...right]);
  for (const id of related) layerOf.set(id, 0);

  const edges = [];
  for (const id of layerOf.keys()) {
    for (const to of leadsTo(byId.get(id))) if (layerOf.has(to)) edges.push({ from: id, to, kind: 'leadsTo' });
  }
  const seen = new Set();
  for (const id of layerOf.keys()) {
    for (const other of relatedOf.get(id) || []) {
      const key = id < other ? `${id}|${other}` : `${other}|${id}`;
      if (!layerOf.has(other) || seen.has(key)) continue;
      if (Math.abs(layerOf.get(id) - layerOf.get(other)) > 1 && id !== focus.id && other !== focus.id) continue;
      if (edges.some((e) => (e.from === id && e.to === other) || (e.from === other && e.to === id))) continue;
      seen.add(key);
      edges.push({ from: id, to: other, kind: 'related' });
    }
  }

  const layers = [...rows.keys()].sort((a, b) => a - b);
  const maxCount = Math.max(...layers.map((l) => rows.get(l).length));
  const width = Math.max(minWidth, maxCount * (NODE_WIDTH + COLUMN_GAP) - COLUMN_GAP + 2 * MARGIN);
  const xOf = new Map();
  const placeRow = (layer) => {
    const ids = rows.get(layer);
    const total = ids.length * (NODE_WIDTH + COLUMN_GAP) - COLUMN_GAP;
    let x = (width - total) / 2;
    for (const id of ids) { xOf.set(id, x); x += NODE_WIDTH + COLUMN_GAP; }
  };
  const sortByNeighbours = (layer, toward) => {
    const ids = rows.get(layer);
    const centre = (id) => {
      const xs = edges.filter((e) => e.kind === 'leadsTo')
        .flatMap((e) => (e.to === id ? [e.from] : e.from === id ? [e.to] : []))
        .filter((n) => layerOf.get(n) === toward && xOf.has(n)).map((n) => xOf.get(n));
      return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : Number.MAX_SAFE_INTEGER;
    };
    rows.set(layer, [...ids].sort((a, b) => centre(a) - centre(b) || nameOrder(a, b)));
  };
  placeRow(0);
  for (const layer of layers.filter((l) => l > 0)) { sortByNeighbours(layer, layer - 1); placeRow(layer); }
  for (const layer of layers.filter((l) => l < 0).reverse()) { sortByNeighbours(layer, layer + 1); placeRow(layer); }

  const top = layers[0];
  const nodes = [...layerOf.entries()].map(([id, layer]) => ({
    technique: byId.get(id), layer, x: xOf.get(id), y: MARGIN + (layer - top) * (NODE_HEIGHT + ROW_GAP), isFocus: id === focus.id,
  }));
  const height = MARGIN * 2 + layers.length * (NODE_HEIGHT + ROW_GAP) - ROW_GAP;
  return { nodes, edges, width, height, isolated: nodes.length === 1 };
}

/** Where the segment from a's centre toward b's centre leaves box b (for arrow tips). */
function edgePoint(ax, ay, bx, by, hw, hh) {
  const dx = ax - bx;
  const dy = ay - by;
  if (dx === 0 && dy === 0) return { x: bx, y: by };
  const k = Math.min(Math.abs(dx) > 0 ? hw / Math.abs(dx) : Infinity, Math.abs(dy) > 0 ? hh / Math.abs(dy) : Infinity);
  return { x: bx + dx * k, y: by + dy * k };
}

export function renderMap(id) {
  const focus = lib.techniques.get(id);
  chrome({ title: t('map.title'), back: focus ? routes.technique(id) : '/', tab: 'library' });
  if (!focus) { fill($main(), h('p', { class: 'empty' }, t('map.gone'))); return; }

  const minWidth = Math.min(760, document.documentElement.clientWidth) - 32;
  const layout = layoutTechniqueMap([...lib.techniques.values()], id, minWidth);
  const box = h('div', { class: 'map-canvas', style: { width: `${layout.width}px`, height: `${layout.height}px` } });

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'map-edges');
  svg.setAttribute('width', layout.width);
  svg.setAttribute('height', layout.height);
  svg.innerHTML = '<defs><marker id="map-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#E0454A"/></marker></defs>';
  const at = new Map(layout.nodes.map((n) => [n.technique.id, n]));
  const hw = NODE_WIDTH / 2;
  const hh = NODE_HEIGHT / 2;
  for (const e of layout.edges) {
    const a = at.get(e.from);
    const b = at.get(e.to);
    const ax = a.x + hw; const ay = a.y + hh;
    const bx = b.x + hw; const by = b.y + hh;
    const start = edgePoint(bx, by, ax, ay, hw + 2, hh + 2);
    const end = edgePoint(ax, ay, bx, by, hw + 4, hh + 4);
    const line = document.createElementNS(SVG_NS, 'line');
    line.setAttribute('x1', start.x); line.setAttribute('y1', start.y);
    line.setAttribute('x2', end.x); line.setAttribute('y2', end.y);
    line.setAttribute('class', e.kind === 'leadsTo' ? 'map-lead' : 'map-related');
    if (e.kind === 'leadsTo') line.setAttribute('marker-end', 'url(#map-arrow)');
    svg.append(line);
  }
  box.append(svg);

  for (const n of layout.nodes) {
    const x = n.technique;
    const where = validGroupId(x.groupId) ? lib.groups.get(x.groupId).name : null;
    const thumb = h('span', { class: 'map-thumb' }, icon('technique', 22));
    techniqueThumbUrl(x).then((u) => { if (u) thumb.replaceChildren(h('img', { src: u, alt: '' })); }).catch(() => {});
    box.append(h('button', {
      class: `map-node${n.isFocus ? ' focus' : ''}`, type: 'button',
      style: { left: `${n.x}px`, top: `${n.y}px`, width: `${NODE_WIDTH}px`, height: `${NODE_HEIGHT}px` },
      'aria-label': n.isFocus ? t('map.openA11y', { name: x.name }) : t('map.moveA11y', { name: x.name }),
      onclick: () => (n.isFocus ? nav(routes.technique(x.id)) : nav(`/map/${x.id}`, { replace: true })),
    }, thumb, h('span', { class: 'map-text' }, h('b', { dir: 'auto' }, x.name), h('small', { dir: 'auto' }, n.isFocus ? t('map.tapToOpen') : where || ''))));
  }

  fill($main(),
    h('div', { class: 'map-legend' },
      h('span', {}, h('i', { class: 'lg-lead' }), t('map.legendLeadsTo')),
      h('span', {}, h('i', { class: 'lg-related' }), t('map.legendRelated')),
      h('span', { class: 'spacer' }),
      h('a', { class: 'text-btn', href: `#/graph/${validGroupId(focus.groupId) || 'all'}/${focus.id}` }, icon('graph', 18), t('technique.openInGraph'))),
    layout.isolated
      ? h('div', { class: 'card hint' }, h('p', {}, t('map.isolatedBefore'), ' ', h('b', {}, t('technique.leadsTo')), t('map.isolatedAfter')),
          h('a', { class: 'btn tonal', href: `#/t/${id}/edit` }, icon('edit', 18), t('common.edit')))
      : h('p', { class: 'small muted' }, t('map.tapToMove')),
    h('div', { class: 'map-scroll' }, box));
  // Bring the centre row into view on a wide map.
  const scroller = $main().querySelector('.map-scroll');
  const f = layout.nodes.find((n) => n.isFocus);
  scroller.scrollLeft = Math.max(0, f.x + hw - scroller.clientWidth / 2);
}
