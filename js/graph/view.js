/**
 * The library graph screen: port of the Android app's LibraryGraphView (1.7).
 *
 * One world layer holds an SVG with every connection and the node cards; a single
 * translate+scale transform pans and zooms it, so moving around never re-lays anything out.
 * Gestures (pointer events) work in small steps from wherever the view is now — never from where
 * it was when the fingers came down — which is what fixed the app's pinch jump.
 */
import { h, icon, iconButton, fill, sheet, toast } from '../dom.js';
import { t, tn } from '../i18n.js';
import { lib, mediaOf, validGroupId, childGroups, commit } from '../library.js';
import { getMeta, setMeta } from '../db.js';
import { techniqueThumb, thumbNode } from '../media.js';
import { chrome, $main, nav, routes } from '../ui.js';
import { openPlayer } from '../player.js';
import { addMenu } from '../views/library.js';
import {
  buildLibraryGraph, resolvePositions, nodeSize, graphBounds, curvePath, arrowPath,
  TECH_THUMB_H,
} from './model.js';

const MIN_SCALE = 0.12;
const MAX_SCALE = 2;
const DOT_ZOOM = 0.42;
const ARROW_SIZE = 13;
const MINIMAP_W = 132;
const MINIMAP_H = 88;
const SVG_NS = 'http://www.w3.org/2000/svg';
const DEFAULT_LAYOUT = { mode: 'radial', positions: {}, pinned: [] };

// --- preferences (per browser; conveniences only) --------------------------------------------------

function pref(key, fallback) {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}
function setPref(key, value) {
  try { if (value == null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch { /* private mode */ }
}
export const libraryLayout = () => pref('jn.libraryLayout', 'LIST');
export const setLibraryLayout = (v) => setPref('jn.libraryLayout', v);
export const lastGraphScope = () => {
  const v = pref('jn.graphScope', '');
  return v && lib.groups.has(v) ? v : null;
};

/** The List | Graph switch shown at the top of both views. */
export function layoutSwitch(current, groupId) {
  const seg = (value, label, name) => h('button', {
    class: `seg${current === value ? ' on' : ''}`, type: 'button', 'aria-pressed': String(current === value), 'aria-label': label, title: label,
    onclick: () => {
      if (current === value) return;
      setLibraryLayout(value);
      if (value === 'GRAPH') nav(`/graph/${groupId || 'all'}`);
      else nav(routes.group(groupId));
    },
  }, icon(name, 18), h('span', { class: 'seg-label' }, label));
  return h('div', { class: 'segmented', role: 'group' }, seg('LIST', t('graph.list'), 'list'), seg('GRAPH', t('graph.graph'), 'graph'));
}

// --- layout storage ---------------------------------------------------------------------------------

const scopeKey = (scopeId) => `graph:${scopeId ?? 'ALL'}`;

async function loadLayout(scopeId) {
  try {
    const v = await getMeta(scopeKey(scopeId), null);
    if (!v || typeof v !== 'object') return { ...DEFAULT_LAYOUT };
    return {
      mode: ['radial', 'tree', 'freeform'].includes(v.mode) ? v.mode : 'radial',
      positions: v.positions && typeof v.positions === 'object' ? v.positions : {},
      pinned: Array.isArray(v.pinned) ? v.pinned.filter((p) => typeof p === 'string') : [],
    };
  } catch {
    return { ...DEFAULT_LAYOUT };
  }
}

function saveLayout(scopeId, layout) {
  const positions = {};
  for (const [id, p] of Object.entries(layout.positions)) positions[id] = { x: Math.round(p.x), y: Math.round(p.y) };
  setMeta(scopeKey(scopeId), { mode: layout.mode, positions, pinned: layout.pinned }).catch(() => {});
}

// --- the screen -------------------------------------------------------------------------------------

let session = null; // the live graph screen, torn down when another screen renders

export async function renderGraph(scopeArg, focusId) {
  if (session) session.destroy();
  let scopeId = scopeArg === 'all' || scopeArg == null ? null : validGroupId(scopeArg);
  if (scopeArg && scopeArg !== 'all' && scopeId == null) { nav('/graph/all', { replace: true }); return; }
  setPref('jn.graphScope', scopeId);
  setLibraryLayout('GRAPH');

  // + adds into the group being looked at: the selected group, the selected technique's group, or the scope.
  const addTarget = () => {
    const sel = state.selectedId && state.graph ? state.graph.byId.get(state.selectedId) : null;
    if (sel && sel.kind === 'group') return sel.id;
    if (sel && sel.kind === 'technique') return validGroupId(sel.technique.groupId);
    return state.scopeId;
  };
  chrome({ title: t('library.title'), tab: 'library', actions: [iconButton('add', t('library.add'), () => addMenu(addTarget()))] });
  document.body.classList.add('graph-mode');
  const placeStage = () => document.documentElement.style.setProperty('--graph-top', `${document.getElementById('topbar').getBoundingClientRect().bottom}px`);
  placeStage();
  // Torn down by the router even if we are left before the saved layout has loaded.
  session = { destroy() { document.body.classList.remove('graph-mode'); session = null; } };

  const state = {
    scopeId, graph: null, positions: null, layout: null, selectedId: null, arranging: false,
    linkFrom: null, cam: { s: 1, tx: 0, ty: 0 }, dots: false, undo: [],
    drag: null, // { id, dx, dy }
  };

  // ---- skeleton
  const scopeSelect = h('select', { class: 'scope-select', 'aria-label': t('graph.chooseScope') },
    h('option', { value: '' }, t('graph.allTechniques')), scopeOptions());
  scopeSelect.value = scopeId || '';
  scopeSelect.addEventListener('change', () => nav(`/graph/${scopeSelect.value || 'all'}`));
  const arrangeBtn = h('button', { class: 'btn tonal small-btn', type: 'button', onclick: () => setArranging(!state.arranging) });
  const header = h('div', { class: 'graph-header' }, layoutSwitch('GRAPH', scopeId), scopeSelect, arrangeBtn);

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'g-edges');
  svg.setAttribute('width', '1');
  svg.setAttribute('height', '1');
  svg.innerHTML = `<defs><filter id="g-glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="6"/></filter></defs>`;
  const pathEl = (cls) => { const p = document.createElementNS(SVG_NS, 'path'); p.setAttribute('class', cls); svg.append(p); return p; };
  const paths = {
    tree: pathEl('e-tree'), related: pathEl('e-related'), leads: pathEl('e-leads'), arrows: pathEl('e-arrows'),
    glow: pathEl('e-glow'), hi: pathEl('e-hi'), hiArrows: pathEl('e-hi-arrows'),
  };
  paths.glow.setAttribute('filter', 'url(#g-glow)');
  const nodeLayer = h('div', { class: 'g-nodes' });
  const world = h('div', { class: 'g-world' }, svg, nodeLayer);
  const viewport = h('div', { class: 'g-viewport' }, world);

  const emptyNote = h('div', { class: 'g-empty', hidden: true });
  const linkBanner = h('div', { class: 'g-banner', hidden: true });
  const popover = h('div', { class: 'g-popover', hidden: true });

  const miniCanvas = h('canvas', { width: MINIMAP_W * 2, height: MINIMAP_H * 2 });
  const miniView = h('div', { class: 'g-mini-view' });
  const minimap = h('div', { class: 'g-minimap', role: 'img', 'aria-label': t('graph.minimap') }, miniCanvas, miniView);
  const zoomLabel = h('span', { class: 'g-zoom-label' }, '100%');
  const zoomPill = h('div', { class: 'g-zoom' },
    iconButton('remove', t('graph.zoomOut'), () => zoomBy(1 / 1.3)), zoomLabel, iconButton('add', t('graph.zoomIn'), () => zoomBy(1.3)));
  const fitBtn = iconButton('fit', t('graph.showEverything'), () => fitAll(true), 'g-fit');
  const bottomControls = h('div', { class: 'g-bottom' }, minimap, h('span', { class: 'spacer' }), zoomPill, fitBtn);
  const preview = h('div', { class: 'g-preview', hidden: true });
  const arrangeBar = h('div', { class: 'g-arrange', hidden: true });

  const stage = h('div', { class: 'g-stage' }, viewport, emptyNote, linkBanner, popover, bottomControls, preview, arrangeBar);
  fill($main(), h('div', { class: 'graph-screen' }, header, stage));

  // ---- data
  const data = () => ({ groups: [...lib.groups.values()], techniques: [...lib.techniques.values()] });
  state.layout = await loadLayout(scopeId);
  if (!stage.isConnected || !session) return;

  function rebuild({ keepCamera = true } = {}) {
    state.graph = buildLibraryGraph(data(), state.scopeId, t('library.title'));
    if (!state.graph) { nav('/graph/all', { replace: true }); return; }
    state.positions = resolvePositions(state.graph, state.layout.mode, state.layout.positions, new Set(state.layout.pinned));
    if (state.selectedId && !state.graph.byId.has(state.selectedId)) state.selectedId = null;
    drawNodes();
    drawEdges();
    drawMinimap();
    updateOverlays();
    if (!keepCamera) fitAll(false);
  }

  // ---- camera
  const size = () => ({ w: viewport.clientWidth, h: viewport.clientHeight });
  function applyCamera() {
    const { s, tx, ty } = state.cam;
    world.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`;
    const grid = 40 * s;
    viewport.style.backgroundSize = `${grid}px ${grid}px`;
    viewport.style.backgroundPosition = `${tx}px ${ty}px`;
    world.style.setProperty('--gk', String(Math.min(2.2, Math.max(1, 0.5 / s))));
    world.style.setProperty('--dk', String(Math.min(3, Math.max(1, 0.3 / s))));
    const thick = Math.min(3, Math.max(1, 0.6 / s));
    paths.tree.setAttribute('stroke-width', 2 * thick);
    paths.related.setAttribute('stroke-width', 1.6 * thick);
    paths.leads.setAttribute('stroke-width', 2.6 * thick);
    paths.hi.setAttribute('stroke-width', 3.2 * thick);
    paths.glow.setAttribute('stroke-width', 9 * thick);
    zoomLabel.textContent = `${Math.round(s * 20) * 5}%`;
    const dots = s < DOT_ZOOM;
    if (dots !== state.dots) {
      state.dots = dots;
      drawNodes();
      drawEdges();
    }
    drawMiniView();
    placePopover();
  }

  let anim = 0;
  function animateCamera(to, ms = 260) {
    cancelAnimationFrame(anim);
    const from = { ...state.cam };
    const t0 = performance.now();
    const step = (now) => {
      const k = Math.min(1, (now - t0) / ms);
      const e = 1 - Math.pow(1 - k, 3);
      state.cam = { s: from.s + (to.s - from.s) * e, tx: from.tx + (to.tx - from.tx) * e, ty: from.ty + (to.ty - from.ty) * e };
      applyCamera();
      if (k < 1) anim = requestAnimationFrame(step);
    };
    anim = requestAnimationFrame(step);
  }

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  /** Room the bottom cards take, so "fit" keeps the graph clear of them. */
  function bottomRoom() {
    return (preview.hidden ? 0 : preview.offsetHeight + 12) + (arrangeBar.hidden ? 0 : arrangeBar.offsetHeight + 12) + 110;
  }

  function fitAll(animated) {
    if (!state.graph) return;
    const { w, h: hh } = size();
    if (!w || !hh) return;
    const b = graphBounds(state.graph, state.positions);
    const room = bottomRoom();
    const s = clamp(Math.min((w - 48) / Math.max(1, b.maxX - b.minX), (hh - 48 - room) / Math.max(1, b.maxY - b.minY)), MIN_SCALE, 1);
    const cx = (b.minX + b.maxX) / 2;
    const cy = (b.minY + b.maxY) / 2;
    const to = { s, tx: w / 2 - cx * s, ty: (hh - room) / 2 + 24 - cy * s };
    if (animated) animateCamera(to); else { state.cam = to; applyCamera(); }
  }

  function centreOn(id, animated) {
    const p = state.positions.get(id);
    if (!p) return;
    const { w, h: hh } = size();
    const s = Math.max(state.cam.s, 0.7);
    const to = { s, tx: w / 2 - p.x * s, ty: hh * 0.4 - p.y * s };
    if (animated) animateCamera(to); else { state.cam = to; applyCamera(); }
  }

  function zoomBy(factor, cx, cy) {
    const { w, h: hh } = size();
    const px = cx ?? w / 2;
    const py = cy ?? hh / 2;
    const { s, tx, ty } = state.cam;
    const next = clamp(s * factor, MIN_SCALE, MAX_SCALE);
    const wx = (px - tx) / s;
    const wy = (py - ty) / s;
    const to = { s: next, tx: px - wx * next, ty: py - wy * next };
    if (cx == null) animateCamera(to, 180); else { state.cam = to; applyCamera(); }
  }

  // ---- nodes
  const nodeEls = new Map();
  function drawNodes() {
    nodeEls.clear();
    const frag = document.createDocumentFragment();
    for (const node of state.graph.nodes) {
      const p = state.positions.get(node.id);
      const el = node.kind === 'technique' ? (state.dots ? techniqueDot(node) : techniqueCard(node)) : groupPill(node);
      const sz = nodeSize(node, state.dots && node.kind === 'technique');
      Object.assign(el.style, { left: `${p.x - sz.w / 2}px`, top: `${p.y - sz.h / 2}px`, width: `${sz.w}px`, height: `${sz.h}px` });
      el.dataset.id = node.id;
      if (state.arranging && state.layout.pinned.includes(node.id)) el.append(h('span', { class: 'g-pin' }, icon('pin', 13)));
      if (state.drag && state.drag.id === node.id) el.style.translate = `${state.drag.dx}px ${state.drag.dy}px`;
      nodeEls.set(node.id, el);
      frag.append(el);
    }
    nodeLayer.replaceChildren(frag);
    markSelection();
  }

  function techniqueCard(node) {
    const x = node.technique;
    const videos = mediaOf(x.id).filter((m) => m.type === 'VIDEO').length;
    const thumb = h('span', { class: 'g-thumb', style: { height: `${TECH_THUMB_H}px` } }, icon('technique', 28),
      videos ? h('span', { class: 'g-play' }, icon('play', 14)) : null);
    techniqueThumb(x).then((r) => { const n = thumbNode(r); if (n) thumb.prepend(n); }).catch(() => {});
    return h('div', { class: 'g-node g-tech' }, thumb, h('span', { class: 'g-label', dir: 'auto' }, node.name));
  }

  function techniqueDot(node) {
    return h('div', { class: 'g-node g-dot', title: node.name });
  }

  function groupPill(node) {
    const isRoot = node.parentId == null;
    return h('div', { class: `g-node g-group${isRoot ? ' g-root' : ''}` },
      h('span', { class: 'g-pill' }, icon(node.kind === 'root' ? 'home' : 'folder', isRoot ? 22 : 18), h('span', { class: 'g-pill-name', dir: 'auto' }, node.name)));
  }

  function markSelection() {
    for (const [id, el] of nodeEls) el.classList.toggle('selected', id === state.selectedId || id === state.linkFrom);
  }

  // ---- edges
  function boxOf(id) {
    const node = state.graph.byId.get(id);
    const p = state.positions.get(id);
    const sz = nodeSize(node, state.dots);
    const d = state.drag && state.drag.id === id ? state.drag : null;
    return { x: p.x + (d ? d.dx : 0), y: p.y + (d ? d.dy : 0), hw: sz.w / 2, hh: sz.h / 2 };
  }
  const treeAxis = () => (state.layout.mode === 'tree' ? 1 : 0);

  function drawEdges() {
    const d = { tree: '', related: '', leads: '', arrows: '' };
    for (const e of state.graph.edges) {
      if (isHighlighted(e)) continue;
      const a = boxOf(e.from);
      const b = boxOf(e.to);
      if (e.kind === 'tree') d.tree += curvePath(a, b, treeAxis());
      else if (e.kind === 'related') d.related += curvePath(a, b, 2);
      else { d.leads += curvePath(a, b, 2); d.arrows += arrowPath(a, b, 2, ARROW_SIZE); }
    }
    for (const k of Object.keys(d)) paths[k].setAttribute('d', d[k]);
    drawHighlight();
  }

  function isHighlighted(e) {
    return state.selectedId != null && (e.from === state.selectedId || e.to === state.selectedId);
  }

  function drawHighlight() {
    let lines = '';
    let arrows = '';
    if (state.selectedId != null) {
      for (const e of state.graph.edges) {
        if (!isHighlighted(e)) continue;
        const a = boxOf(e.from);
        const b = boxOf(e.to);
        lines += curvePath(a, b, e.kind === 'tree' ? treeAxis() : 2);
        if (e.kind === 'leadsTo') arrows += arrowPath(a, b, 2, ARROW_SIZE);
      }
    }
    paths.hi.setAttribute('d', lines);
    paths.glow.setAttribute('d', lines);
    paths.hiArrows.setAttribute('d', arrows);
  }

  // ---- minimap
  let mini = null;
  function drawMinimap() {
    const b = graphBounds(state.graph, state.positions);
    const pad = 6;
    const bw = Math.max(1, b.maxX - b.minX);
    const bh = Math.max(1, b.maxY - b.minY);
    const k = Math.min((MINIMAP_W - 2 * pad) / bw, (MINIMAP_H - 2 * pad) / bh);
    const ox = (MINIMAP_W - bw * k) / 2 - b.minX * k;
    const oy = (MINIMAP_H - bh * k) / 2 - b.minY * k;
    mini = { k, ox, oy };
    const ctx = miniCanvas.getContext('2d');
    ctx.setTransform(2, 0, 0, 2, 0, 0);
    ctx.clearRect(0, 0, MINIMAP_W, MINIMAP_H);
    for (const n of state.graph.nodes) {
      const p = state.positions.get(n.id);
      ctx.beginPath();
      if (n.kind === 'technique') { ctx.fillStyle = 'rgba(74,143,231,.85)'; ctx.arc(ox + p.x * k, oy + p.y * k, 1.8, 0, Math.PI * 2); }
      else { ctx.fillStyle = '#BFD6F5'; ctx.arc(ox + p.x * k, oy + p.y * k, n.parentId == null ? 4 : 3, 0, Math.PI * 2); }
      ctx.fill();
    }
    const sel = state.selectedId ? state.positions.get(state.selectedId) : null;
    if (sel) { ctx.beginPath(); ctx.fillStyle = '#E0454A'; ctx.arc(ox + sel.x * k, oy + sel.y * k, 4, 0, Math.PI * 2); ctx.fill(); }
    drawMiniView();
  }

  function drawMiniView() {
    if (!mini) return;
    const { s, tx, ty } = state.cam;
    const { w, h: hh } = size();
    Object.assign(miniView.style, {
      left: `${mini.ox + (-tx / s) * mini.k}px`, top: `${mini.oy + (-ty / s) * mini.k}px`,
      width: `${(w / s) * mini.k}px`, height: `${(hh / s) * mini.k}px`,
    });
  }

  function minimapMove(ev) {
    const r = minimap.getBoundingClientRect();
    const wx = (ev.clientX - r.left - mini.ox) / mini.k;
    const wy = (ev.clientY - r.top - mini.oy) / mini.k;
    const { w, h: hh } = size();
    cancelAnimationFrame(anim);
    state.cam = { s: state.cam.s, tx: w / 2 - wx * state.cam.s, ty: hh / 2 - wy * state.cam.s };
    applyCamera();
  }
  minimap.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    minimap.setPointerCapture(ev.pointerId);
    minimapMove(ev);
    const move = (e) => minimapMove(e);
    const up = () => { minimap.removeEventListener('pointermove', move); minimap.removeEventListener('pointerup', up); minimap.removeEventListener('pointercancel', up); };
    minimap.addEventListener('pointermove', move);
    minimap.addEventListener('pointerup', up);
    minimap.addEventListener('pointercancel', up);
  });

  // ---- gestures
  const pointers = new Map(); // id -> {x, y}
  let gesture = null; // { kind: 'pan'|'pinch'|'drag'|'maybe', startX, startY, moved, nodeId, t0 }
  let last = null; // previous centroid + spread, for incremental steps

  function localPoint(ev) {
    const r = viewport.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  }

  function hitTest(sx, sy) {
    const { s, tx, ty } = state.cam;
    const wx = (sx - tx) / s;
    const wy = (sy - ty) / s;
    const nodes = state.graph.nodes;
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      const p = state.positions.get(n.id);
      const sz = nodeSize(n, state.dots && n.kind === 'technique');
      let hw = sz.w / 2;
      let hh = sz.h / 2;
      // Pills drawn bigger when zoomed out; dots get a finger-sized target.
      if (n.kind !== 'technique') { const gk = Math.min(2.2, Math.max(1, 0.5 / s)); hw *= gk; hh *= gk; }
      else if (state.dots) { hw = hh = Math.max(hw * Math.min(3, Math.max(1, 0.3 / s)), 22 / s); }
      if (Math.abs(wx - p.x) <= hw && Math.abs(wy - p.y) <= hh) return n.id;
    }
    return '';
  }

  function snapshot() {
    const pts = [...pointers.values()];
    const cx = pts.reduce((a, p) => a + p.x, 0) / pts.length;
    const cy = pts.reduce((a, p) => a + p.y, 0) / pts.length;
    const spread = pts.length > 1 ? Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) : 0;
    return { cx, cy, spread, n: pts.length };
  }

  viewport.addEventListener('pointerdown', (ev) => {
    if (ev.button > 0) return;
    viewport.setPointerCapture(ev.pointerId);
    cancelAnimationFrame(anim);
    const p = localPoint(ev);
    pointers.set(ev.pointerId, p);
    if (pointers.size === 1) {
      const hit = hitTest(p.x, p.y);
      gesture = { kind: 'maybe', startX: p.x, startY: p.y, moved: 0, nodeId: hit, t0: performance.now() };
    } else if (gesture && gesture.kind === 'drag') {
      // While a card is being dragged, a second finger doesn't zoom.
    } else {
      gesture = { kind: 'pinch' };
    }
    last = snapshot(); // a finger landing moves nothing
  });

  viewport.addEventListener('pointermove', (ev) => {
    if (!pointers.has(ev.pointerId)) return;
    const p = localPoint(ev);
    pointers.set(ev.pointerId, p);
    const now = snapshot();
    if (!gesture || !last) { last = now; return; }
    if (gesture.kind === 'maybe') {
      gesture.moved = Math.hypot(p.x - gesture.startX, p.y - gesture.startY);
      if (gesture.moved > 8) {
        if (state.arranging && gesture.nodeId && gesture.nodeId !== state.graph.rootId && state.linkFrom == null) {
          gesture.kind = 'drag';
          state.selectedId = gesture.nodeId;
          state.drag = { id: gesture.nodeId, dx: 0, dy: 0, sx: gesture.startX, sy: gesture.startY };
          popover.hidden = true;
          markSelection();
          drawEdges();
        } else gesture.kind = 'pan';
      }
    }
    if (gesture.kind === 'drag') {
      const d = state.drag;
      d.dx = (p.x - d.sx) / state.cam.s;
      d.dy = (p.y - d.sy) / state.cam.s;
      const el = nodeEls.get(d.id);
      if (el) el.style.translate = `${d.dx}px ${d.dy}px`;
      drawHighlight();
    } else if (gesture.kind === 'pan' || gesture.kind === 'pinch') {
      if (now.n === last.n) {
        let { s, tx, ty } = state.cam;
        if (now.n >= 2 && last.spread > 0) {
          // Zoom about the point between the fingers as it is now.
          const next = clamp(s * (now.spread / last.spread), MIN_SCALE, MAX_SCALE);
          tx = now.cx - ((now.cx - tx) * next) / s;
          ty = now.cy - ((now.cy - ty) * next) / s;
          s = next;
        }
        tx += now.cx - last.cx;
        ty += now.cy - last.cy;
        state.cam = { s, tx, ty };
        applyCamera();
      }
    }
    last = now;
  });

  function endPointer(ev) {
    if (!pointers.has(ev.pointerId)) return;
    pointers.delete(ev.pointerId);
    if (gesture && gesture.kind === 'maybe' && pointers.size === 0 && ev.type === 'pointerup') onTap(gesture.nodeId);
    if (gesture && gesture.kind === 'drag' && pointers.size === 0) endDrag();
    if (pointers.size === 0) gesture = null;
    last = pointers.size ? snapshot() : null; // a finger lifting moves nothing
  }
  viewport.addEventListener('pointerup', endPointer);
  viewport.addEventListener('pointercancel', endPointer);

  viewport.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const p = localPoint(ev);
    // Trackpad pinch arrives as a ctrl-wheel with small deltas; a mouse wheel as larger steps.
    const factor = Math.exp(-ev.deltaY * (ev.ctrlKey ? 0.01 : 0.0015));
    zoomBy(factor, p.x, p.y);
  }, { passive: false });

  // ---- taps, selection, preview
  function onTap(id) {
    if (state.linkFrom != null) {
      const node = state.graph.byId.get(id);
      if (node && node.kind === 'technique' && id !== state.linkFrom) linkDialog(state.linkFrom, id);
      return;
    }
    state.selectedId = id || null;
    markSelection();
    drawEdges();
    drawMinimap();
    updateOverlays();
    const p = id ? state.positions.get(id) : null;
    if (p && !state.arranging) {
      const { w, h: hh } = size();
      const { s, tx, ty } = state.cam;
      const x = tx + p.x * s;
      const y = ty + p.y * s;
      if (x < 40 || x > w - 40 || y < 40 || y > hh - bottomRoom() - 20) centreOn(id, true);
    }
  }

  function updateOverlays() {
    const g = state.graph;
    const empty = g.nodes.length === 1;
    emptyNote.hidden = !empty;
    emptyNote.textContent = state.scopeId == null ? t('graph.emptyLibrary') : t('graph.emptyGroup');
    arrangeBtn.replaceChildren(state.arranging ? t('media.done') : h('span', { class: 'row-inline' }, icon('move', 18), t('graph.arrange')));
    arrangeBtn.classList.toggle('on', state.arranging);
    arrangeBtn.hidden = empty;

    // Link banner
    const from = state.linkFrom ? g.byId.get(state.linkFrom) : null;
    linkBanner.hidden = !from;
    if (from) {
      fill(linkBanner, icon('link', 20),
        h('div', { class: 'g-banner-text' }, h('small', {}, t('graph.tapToLink')), h('b', { dir: 'auto' }, from.name)),
        h('button', { class: 'text-btn', type: 'button', onclick: () => { state.linkFrom = null; markSelection(); updateOverlays(); } }, t('common.cancel')));
    }

    // Preview card (not while arranging or linking)
    const node = !state.arranging && !from && state.selectedId ? g.byId.get(state.selectedId) : null;
    preview.hidden = !node;
    if (node) fill(preview, previewContent(node));

    // Arrange bar
    arrangeBar.hidden = !state.arranging;
    if (state.arranging) fill(arrangeBar, arrangeContent());

    // Popover (arranging, a node selected, not linking)
    placePopover();
    bottomControls.style.bottom = `${12 + (preview.hidden ? 0 : preview.offsetHeight + 10) + (arrangeBar.hidden ? 0 : arrangeBar.offsetHeight + 10)}px`;
  }

  function previewContent(node) {
    if (node.kind === 'technique') {
      const x = node.technique;
      const videos = mediaOf(x.id).filter((m) => m.type === 'VIDEO');
      const groupName = validGroupId(x.groupId) ? lib.groups.get(x.groupId).name : t('library.title');
      const thumb = h('span', { class: 'g-preview-thumb' }, icon('technique', 28));
      techniqueThumb(x).then((r) => { const n = thumbNode(r); if (n) thumb.replaceChildren(n); }).catch(() => {});
      return [thumb, h('div', { class: 'g-preview-body' },
        h('b', { dir: 'auto' }, node.name),
        h('small', {}, h('span', { dir: 'auto' }, groupName), ' · ', tn('count.videos', videos.length)),
        h('div', { class: 'row' },
          videos.length ? h('button', { class: 'btn small-btn', type: 'button', onclick: () => openPlayer(videos.map((m) => ({ media: m, title: x.name })), 0, { playlist: true }) }, icon('play', 18), t('graph.watch')) : null,
          h('a', { class: 'btn tonal small-btn', href: `#${routes.technique(x.id)}` }, t('graph.details'))))];
    }
    const parentId = node.kind === 'group' ? validGroupId(node.group.parentId) : null;
    const parentName = parentId ? lib.groups.get(parentId).name : null;
    const isScopeRoot = node.id === state.graph.rootId;
    const count = tn('count.techniques', node.techniqueCount);
    return [h('span', { class: 'g-preview-thumb g-preview-group' }, icon(node.kind === 'root' ? 'home' : 'folder', 28)),
      h('div', { class: 'g-preview-body' },
        h('b', { dir: 'auto' }, node.name),
        h('small', {}, node.kind === 'root' ? count : [t('graph.techniqueGroup'), ' · ', parentName ? [h('span', { dir: 'auto' }, parentName), ' · '] : null, count]),
        h('div', { class: 'row' },
          node.kind === 'group' && !isScopeRoot ? h('button', { class: 'btn small-btn', type: 'button', onclick: () => nav(`/graph/${node.id}`) }, t('graph.exploreGroup'), icon('arrow', 18)) : null,
          node.kind === 'group' && isScopeRoot ? h('button', { class: 'btn tonal small-btn', type: 'button', onclick: () => nav(`/graph/${parentId || 'all'}`) }, icon('up', 18), t('graph.upALevel')) : null,
          node.kind === 'group' ? h('a', { class: 'btn tonal small-btn', href: `#${routes.group(node.id)}` }, t('graph.openList')) : null))];
  }

  function arrangeContent() {
    const chip = (mode, label, name) => h('button', {
      class: `pl-chip g-chip${state.layout.mode === mode ? ' on' : ''}`, type: 'button', onclick: () => applyMode(mode),
    }, icon(name, 18), label);
    return [
      h('div', { class: 'row' }, h('b', {}, t('graph.layout')), chip('freeform', t('graph.freeform'), 'move'), chip('radial', t('graph.radial'), 'radial'), chip('tree', t('graph.tree'), 'tree')),
      h('div', { class: 'row g-arrange-row' },
        h('small', { class: 'muted' }, t('graph.arrangeHint')),
        h('span', { class: 'spacer' }),
        h('button', { class: 'text-btn', type: 'button', disabled: state.undo.length === 0, onclick: undo }, icon('undo', 18), t('graph.undo')),
        h('button', { class: 'text-btn', type: 'button', onclick: reset }, icon('reset', 18), t('graph.reset'))),
    ];
  }

  function placePopover() {
    const node = state.arranging && state.selectedId && !state.linkFrom && !state.drag ? state.graph?.byId.get(state.selectedId) : null;
    popover.hidden = !node;
    if (!node) return;
    if (popover.dataset.for !== node.id || popover.dataset.pinned !== String(state.layout.pinned.includes(node.id))) {
      popover.dataset.for = node.id;
      const isPinned = state.layout.pinned.includes(node.id);
      popover.dataset.pinned = String(isPinned);
      fill(popover,
        node.id !== state.graph.rootId ? h('button', { class: 'text-btn', type: 'button', onclick: () => togglePin(node.id) }, icon('pin', 18), isPinned ? t('graph.unpin') : t('graph.pin')) : null,
        node.kind === 'technique' ? h('button', { class: 'text-btn', type: 'button', onclick: () => { state.linkFrom = node.id; markSelection(); updateOverlays(); } }, icon('link', 18), t('graph.link')) : null);
    }
    const p = state.positions.get(node.id);
    const sz = nodeSize(node, state.dots && node.kind === 'technique');
    const { s, tx, ty } = state.cam;
    const { w } = size();
    const pw = popover.offsetWidth || 180;
    const x = clamp(tx + p.x * s - pw / 2, 8, w - pw - 8);
    const y = Math.max(8, ty + (p.y - sz.h / 2) * s - 54);
    popover.style.left = `${x}px`;
    popover.style.top = `${y}px`;
  }

  // ---- arranging
  function commitLayout(next) {
    state.undo.push(state.layout);
    if (state.undo.length > 50) state.undo.shift();
    state.layout = next;
    saveLayout(state.scopeId, next);
    rebuild();
  }

  const currentPositions = () => {
    const out = {};
    for (const [id, p] of state.positions) out[id] = { x: p.x, y: p.y };
    return out;
  };

  function applyMode(mode) {
    if (mode === 'freeform') {
      if (state.layout.mode === 'freeform') return;
      commitLayout({ mode, positions: currentPositions(), pinned: state.layout.pinned });
      return;
    }
    const keep = {};
    for (const id of state.layout.pinned) { const p = state.positions.get(id); if (p) keep[id] = { x: p.x, y: p.y }; }
    commitLayout({ mode, positions: keep, pinned: state.layout.pinned });
    fitAll(true);
  }

  function togglePin(id) {
    const isPinned = state.layout.pinned.includes(id);
    const positions = { ...state.layout.positions };
    if (!isPinned) positions[id] = { ...state.positions.get(id) };
    else if (state.layout.mode !== 'freeform') delete positions[id];
    commitLayout({ mode: state.layout.mode, positions, pinned: isPinned ? state.layout.pinned.filter((p) => p !== id) : [...state.layout.pinned, id] });
  }

  function undo() {
    const previous = state.undo.pop();
    if (!previous) return;
    state.layout = previous;
    saveLayout(state.scopeId, previous);
    rebuild();
  }

  function reset() {
    commitLayout({ ...DEFAULT_LAYOUT, positions: {}, pinned: [] });
    fitAll(true);
  }

  function endDrag() {
    const d = state.drag;
    state.drag = null;
    if (!d || (Math.abs(d.dx) < 1 && Math.abs(d.dy) < 1)) { rebuild(); return; }
    const all = currentPositions();
    all[d.id] = { x: all[d.id].x + d.dx, y: all[d.id].y + d.dy };
    // Moving a card makes the arrangement yours: the whole graph becomes freeform as it looks.
    commitLayout({ mode: 'freeform', positions: all, pinned: state.layout.pinned });
  }

  function setArranging(on) {
    state.arranging = on;
    state.linkFrom = null;
    drawNodes(); // pins show only while arranging
    updateOverlays();
  }

  // ---- linking
  function linkDialog(fromId, toId) {
    const a = lib.techniques.get(fromId);
    const b = lib.techniques.get(toId);
    if (!a || !b) return;
    const aLeadsB = (a.leadsToIds || []).includes(b.id);
    const bLeadsA = (b.leadsToIds || []).includes(a.id);
    const related = (a.relatedIds || []).includes(b.id) || (b.relatedIds || []).includes(a.id);
    const linked = aLeadsB || bLeadsA || related;
    let close;
    const done = () => { close(); state.linkFrom = null; rebuild(); markSelection(); };
    const save = async (rows) => {
      await commit({ techniques: rows.map((r) => ({ ...r, modifiedAt: Date.now() })) });
      toast(t('editor.saved'));
      done();
    };
    // Names on their own lines: a Hebrew name inside an English sentence comes out scrambled.
    const pair = (first, second) => h('span', { class: 'g-pair' }, h('b', { dir: 'auto' }, first), h('small', {}, t('graph.leadsTo')), h('b', { dir: 'auto' }, second));
    const option = (label, name, onclick, disabled) => h('button', { class: 'menu-item', type: 'button', disabled, onclick }, icon(name, 22), label);
    const current = aLeadsB && bLeadsA ? t('graph.eachLeads') : aLeadsB || bLeadsA ? t('graph.oneLeads') : related ? t('graph.relatedState') : t('graph.notLinked');
    close = sheet(h('div', { class: 'dialog' },
      h('h2', {}, t('graph.linkTechniques')),
      h('p', {}, current),
      h('div', { class: 'menu' },
        option(pair(a.name, b.name), 'down', () => save([{ ...a, leadsToIds: [...(a.leadsToIds || []), b.id] }]), aLeadsB),
        option(pair(b.name, a.name), 'up', () => save([{ ...b, leadsToIds: [...(b.leadsToIds || []), a.id] }]), bLeadsA),
        option(t('graph.related'), 'related', () => save([{ ...a, relatedIds: [...(a.relatedIds || []), b.id] }]), related || aLeadsB || bLeadsA),
        linked ? option(t('graph.removeLink'), 'linkOff', () => save([
          { ...a, leadsToIds: (a.leadsToIds || []).filter((x) => x !== b.id), relatedIds: (a.relatedIds || []).filter((x) => x !== b.id) },
          { ...b, leadsToIds: (b.leadsToIds || []).filter((x) => x !== a.id), relatedIds: (b.relatedIds || []).filter((x) => x !== a.id) },
        ]), false) : null),
      h('div', { class: 'dialog-actions' }, h('button', { class: 'btn tonal', type: 'button', onclick: () => close() }, t('common.cancel')))));
  }

  // ---- start
  rebuild({ keepCamera: false });
  if (focusId && state.positions.has(focusId)) {
    state.selectedId = focusId;
    drawEdges();
    drawMinimap();
    updateOverlays();
    centreOn(focusId, false);
  } else fitAll(false);

  const onResize = () => { placeStage(); applyCamera(); updateOverlays(); };
  window.addEventListener('resize', onResize);

  session = {
    destroy() {
      cancelAnimationFrame(anim);
      window.removeEventListener('resize', onResize);
      document.body.classList.remove('graph-mode');
      session = null;
    },
  };
}

/** Called by the router before any other screen renders. */
export function leaveGraph() {
  if (session) session.destroy();
}

function scopeOptions() {
  const out = [];
  const walk = (parentId, depth) => {
    for (const g of childGroups(parentId)) {
      out.push(h('option', { value: g.id }, `${' '.repeat(depth)}${g.name}`));
      walk(g.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

