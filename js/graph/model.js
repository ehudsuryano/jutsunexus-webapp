/**
 * The library drawn as a graph: groups as pills, techniques as thumbnail cards, joined by the
 * folder structure, "leads to" arrows and related-technique lines.
 *
 * Port of the Android app's src/domain/libraryGraph.ts and src/components/graph/graphGeometry.ts:
 * same node sizes, same radial / tree layouts, same freeform rules, so a library looks the same
 * in both. Positions are node CENTRES in a world frame centred on the scope's root (0, 0).
 */

export const ROOT_NODE_ID = '__library__';
export const TECH_W = 128;
export const TECH_H = 104;
export const TECH_THUMB_H = 76;
export const DOT_SIZE = 22;
export const GROUP_H = 46;
export const ROOT_H = 60;

/** Rough text width, good enough to size a pill; Latin and Hebrew both average about this. */
function textWidth(text, fontSize) {
  return text.length * fontSize * 0.56;
}

/**
 * data: { groups: [group rows], techniques: [technique rows] }. scopeId null = whole library
 * under a "Library" root node. Returns null when the scope group no longer exists.
 */
export function buildLibraryGraph(data, scopeId, rootName) {
  const groupById = new Map(data.groups.map((g) => [g.id, g]));
  if (scopeId != null && !groupById.has(scopeId)) return null;

  const subgroups = new Map();
  for (const g of data.groups) {
    const parent = g.parentId != null && groupById.has(g.parentId) ? g.parentId : null;
    if (!subgroups.has(parent)) subgroups.set(parent, []);
    subgroups.get(parent).push(g);
  }
  const techniquesIn = new Map();
  for (const t of data.techniques) {
    const parent = t.groupId != null && groupById.has(t.groupId) ? t.groupId : null;
    if (!techniquesIn.has(parent)) techniquesIn.set(parent, []);
    techniquesIn.get(parent).push(t);
  }
  const byName = (a, b) => a.name.localeCompare(b.name);

  const nodes = [];
  const byId = new Map();
  const children = new Map();
  const add = (node) => {
    nodes.push(node);
    byId.set(node.id, node);
    children.set(node.id, []);
    if (node.parentId != null) children.get(node.parentId).push(node.id);
  };

  const fill = (groupKey, nodeId, depth) => {
    let count = 0;
    for (const g of [...(subgroups.get(groupKey) || [])].sort(byName)) {
      const node = {
        id: g.id, kind: 'group', name: g.name, parentId: nodeId, depth,
        w: Math.min(240, Math.max(120, textWidth(g.name, 15) + 60)), h: GROUP_H, group: g, techniqueCount: 0,
      };
      add(node);
      node.techniqueCount = fill(g.id, g.id, depth + 1);
      count += node.techniqueCount;
    }
    for (const t of [...(techniquesIn.get(groupKey) || [])].sort(byName)) {
      add({ id: t.id, kind: 'technique', name: t.name, parentId: nodeId, depth, w: TECH_W, h: TECH_H, technique: t, techniqueCount: 1 });
      count++;
    }
    return count;
  };

  let rootId;
  if (scopeId == null) {
    rootId = ROOT_NODE_ID;
    const root = { id: ROOT_NODE_ID, kind: 'root', name: rootName, parentId: null, depth: 0, w: 170, h: ROOT_H, techniqueCount: 0 };
    add(root);
    root.techniqueCount = fill(null, ROOT_NODE_ID, 1);
  } else {
    const g = groupById.get(scopeId);
    rootId = g.id;
    const root = {
      id: g.id, kind: 'group', name: g.name, parentId: null, depth: 0,
      w: Math.min(300, Math.max(160, textWidth(g.name, 20) + 76)), h: ROOT_H, group: g, techniqueCount: 0,
    };
    add(root);
    root.techniqueCount = fill(g.id, g.id, 1);
  }

  const edges = [];
  for (const node of nodes) {
    if (node.parentId != null) edges.push({ id: `t:${node.parentId}>${node.id}`, from: node.parentId, to: node.id, kind: 'tree' });
  }
  const leads = new Set();
  for (const node of nodes) {
    if (node.kind !== 'technique') continue;
    for (const to of node.technique.leadsToIds || []) {
      const target = byId.get(to);
      if (!target || target.kind !== 'technique' || to === node.id) continue;
      edges.push({ id: `l:${node.id}>${to}`, from: node.id, to, kind: 'leadsTo' });
      leads.add(pairKey(node.id, to));
    }
  }
  const related = new Set();
  for (const node of nodes) {
    if (node.kind !== 'technique') continue;
    for (const other of node.technique.relatedIds || []) {
      const target = byId.get(other);
      if (!target || target.kind !== 'technique' || other === node.id) continue;
      const key = pairKey(node.id, other);
      // An arrow already joins them: a second, plain line would only add clutter.
      if (leads.has(key) || related.has(key)) continue;
      related.add(key);
      edges.push({ id: `r:${key}`, from: node.id, to: other, kind: 'related' });
    }
  }
  return { rootId, nodes, byId, children, edges };
}

export function pairKey(a, b) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

// --- layouts -------------------------------------------------------------------------------------

const RING_SPACING = Math.hypot(TECH_W, TECH_H) + 14;
const RING_STEP = Math.hypot(TECH_W, TECH_H) + 14;
const CLUSTER_GAP = 90;
const PILL_ROOM = 1.5;
const BACK_CONE = Math.PI / 2;

/**
 * Clusters around their group: a group's techniques on rings around it, its subgroups (each a
 * cluster of its own) further out, opening away from the parent.
 */
export function radialLayout(graph) {
  const cluster = (id, isRoot) => {
    const node = graph.byId.get(id);
    const kids = graph.children.get(id) || [];
    const techniques = kids.filter((k) => graph.byId.get(k).kind === 'technique');
    const groups = kids.filter((k) => graph.byId.get(k).kind !== 'technique');
    const pos = new Map([[id, { x: 0, y: 0 }]]);
    const own = (Math.max(node.w, node.h) / 2) * PILL_ROOM;
    let outer = own;

    let r = own + TECH_H / 2 + 50;
    let placed = 0;
    let ring = 0;
    while (placed < techniques.length) {
      const capacity = Math.max(1, Math.floor((2 * Math.PI * r) / RING_SPACING));
      const count = Math.min(capacity, techniques.length - placed);
      const step = (2 * Math.PI) / count;
      const offset = isRoot ? -Math.PI / 2 + (ring % 2) * (step / 2) : Math.PI + step / 2 + (ring % 2) * (step / 4);
      for (let i = 0; i < count; i++) {
        const angle = offset + step * i;
        pos.set(techniques[placed + i], { x: Math.cos(angle) * r, y: Math.sin(angle) * r });
      }
      placed += count;
      outer = r + Math.hypot(TECH_W, TECH_H) / 2;
      r += RING_STEP;
      ring++;
    }

    if (groups.length > 0) {
      const subs = groups.map((g) => ({ id: g, ...cluster(g, false) }));
      const room = isRoot ? 2 * Math.PI : 2 * Math.PI - BACK_CONE;
      let scale = 1;
      let distances = [];
      let cones = [];
      for (let attempt = 0; attempt < 80; attempt++) {
        distances = subs.map((sub) => (outer + sub.radius + CLUSTER_GAP) * scale);
        cones = subs.map((sub, i) => 2 * Math.asin(Math.min(1, (sub.radius + CLUSTER_GAP / 2) / distances[i])));
        if (cones.reduce((a, c) => a + c, 0) <= room) break;
        scale *= 1.08;
      }
      const used = cones.reduce((a, c) => a + c, 0);
      const spare = isRoot ? (room - used) / subs.length : Math.min((room - used) / subs.length, 0.35);
      const span = used + spare * subs.length;
      let angle = isRoot ? (subs.length === 1 ? Math.PI / 2 : -Math.PI / 2) - (cones[0] + spare) / 2 : -span / 2;
      subs.forEach((sub, i) => {
        const a = angle + (cones[i] + spare) / 2;
        const cos = Math.cos(a);
        const sin = Math.sin(a);
        const cx = cos * distances[i];
        const cy = sin * distances[i];
        for (const [k, p] of sub.pos) pos.set(k, { x: cx + p.x * cos - p.y * sin, y: cy + p.x * sin + p.y * cos });
        angle += cones[i] + spare;
        outer = Math.max(outer, distances[i] + sub.radius);
      });
    }
    return { pos, radius: outer };
  };
  return cluster(graph.rootId, true).pos;
}

const TREE_ROW_GAP = 22;
const TREE_COLUMN_GAP = 150;

/** A sideways tree, like a mind map: each level in a column. */
export function treeLayout(graph) {
  const depthWidth = new Map();
  for (const n of graph.nodes) depthWidth.set(n.depth, Math.max(depthWidth.get(n.depth) || 0, n.w));
  const columnX = new Map([[0, 0]]);
  const maxDepth = Math.max(...graph.nodes.map((n) => n.depth));
  for (let d = 1; d <= maxDepth; d++) {
    columnX.set(d, columnX.get(d - 1) + depthWidth.get(d - 1) / 2 + TREE_COLUMN_GAP + depthWidth.get(d) / 2);
  }
  const pos = new Map();
  let cursor = 0;
  const place = (id) => {
    const node = graph.byId.get(id);
    const kids = graph.children.get(id) || [];
    let y;
    if (kids.length === 0) {
      y = cursor + node.h / 2;
      cursor += node.h + TREE_ROW_GAP;
    } else {
      const ys = kids.map(place);
      y = (ys[0] + ys[ys.length - 1]) / 2;
      cursor = Math.max(cursor, y + node.h / 2 + TREE_ROW_GAP);
    }
    pos.set(id, { x: columnX.get(node.depth), y });
    return y;
  };
  place(graph.rootId);
  const rootY = pos.get(graph.rootId).y;
  for (const [k, p] of pos) pos.set(k, { x: p.x, y: p.y - rootY });
  return pos;
}

/**
 * Where every node is drawn. Freeform uses saved positions; a node added since lands where the
 * radial layout would put it relative to its parent. Radial and tree are computed, except pins.
 */
export function resolvePositions(graph, mode, saved, pinned) {
  if (mode !== 'freeform') {
    const pos = mode === 'tree' ? treeLayout(graph) : radialLayout(graph);
    for (const id of pinned) {
      const p = saved[id];
      if (p && pos.has(id)) pos.set(id, { x: p.x, y: p.y });
    }
    return pos;
  }
  const radial = radialLayout(graph);
  const pos = new Map();
  const visit = (id) => {
    const node = graph.byId.get(id);
    const p = saved[id];
    if (p) pos.set(id, { x: p.x, y: p.y });
    else if (node.parentId == null) pos.set(id, radial.get(id));
    else {
      const parent = pos.get(node.parentId);
      const r = radial.get(id);
      const rp = radial.get(node.parentId);
      pos.set(id, { x: parent.x + r.x - rp.x, y: parent.y + r.y - rp.y });
    }
    for (const k of graph.children.get(id) || []) visit(k);
  };
  visit(graph.rootId);
  return pos;
}

export function nodeSize(node, dots) {
  return dots && node.kind === 'technique' ? { w: DOT_SIZE, h: DOT_SIZE } : { w: node.w, h: node.h };
}

export function graphBounds(graph, pos) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of graph.nodes) {
    const p = pos.get(n.id);
    if (!p) continue;
    minX = Math.min(minX, p.x - n.w / 2);
    maxX = Math.max(maxX, p.x + n.w / 2);
    minY = Math.min(minY, p.y - n.h / 2);
    maxY = Math.max(maxY, p.y + n.h / 2);
  }
  if (minX === Infinity) return { minX: -100, minY: -100, maxX: 100, maxY: 100 };
  return { minX, minY, maxX, maxY };
}

// --- geometry (graphGeometry.ts) -------------------------------------------------------------------
// axis 0 = S-curve along the longer axis; 1 = sideways S-curve (tree); 2 = an arc bowing to the
// left of the direction of travel, for links between techniques (clears their own group).

function controls(a, b, axis) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (axis === 2) {
    const len = Math.sqrt(dx * dx + dy * dy);
    const bow = len < 0.001 ? 0 : Math.min(180, len * 0.22) / len;
    const nx = dy * bow;
    const ny = -dx * bow;
    return [a.x + dx / 3 + nx, a.y + dy / 3 + ny, a.x + (2 * dx) / 3 + nx, a.y + (2 * dy) / 3 + ny];
  }
  if (axis === 1 || Math.abs(dx) > Math.abs(dy)) return [a.x + dx * 0.5, a.y, b.x - dx * 0.5, b.y];
  return [a.x, a.y + dy * 0.5, b.x, b.y - dy * 0.5];
}

function bezier(p0, p1, p2, p3, t) {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}

function bezierSlope(p0, p1, p2, p3, t) {
  const u = 1 - t;
  return 3 * u * u * (p1 - p0) + 6 * u * t * (p2 - p1) + 3 * t * t * (p3 - p2);
}

const f = (n) => Math.round(n * 10) / 10;

/** SVG path data of the curve between two boxes {x, y, hw, hh}. */
export function curvePath(a, b, axis) {
  const c = controls(a, b, axis);
  return `M${f(a.x)} ${f(a.y)}C${f(c[0])} ${f(c[1])} ${f(c[2])} ${f(c[3])} ${f(b.x)} ${f(b.y)}`;
}

/** SVG path data of a filled arrowhead where the curve enters b's box ('' when they overlap). */
export function arrowPath(a, b, axis, size) {
  const c = controls(a, b, axis);
  const inside = (t) => {
    const x = bezier(a.x, c[0], c[2], b.x, t);
    const y = bezier(a.y, c[1], c[3], b.y, t);
    return Math.abs(x - b.x) <= b.hw + 2 && Math.abs(y - b.y) <= b.hh + 2;
  };
  let lo = 0;
  let hi = 1;
  for (let t = 1; t >= 0; t -= 0.05) {
    if (!inside(t)) { lo = t; hi = Math.min(1, t + 0.05); break; }
  }
  if (inside(lo)) return '';
  for (let i = 0; i < 8; i++) {
    const mid = (lo + hi) / 2;
    if (inside(mid)) hi = mid; else lo = mid;
  }
  const tipX = bezier(a.x, c[0], c[2], b.x, lo);
  const tipY = bezier(a.y, c[1], c[3], b.y, lo);
  let dx = bezierSlope(a.x, c[0], c[2], b.x, lo);
  let dy = bezierSlope(a.y, c[1], c[3], b.y, lo);
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 0.001) return '';
  dx /= len;
  dy /= len;
  const baseX = tipX - dx * size;
  const baseY = tipY - dy * size;
  const half = size * 0.6;
  return `M${f(tipX)} ${f(tipY)}L${f(baseX - dy * half)} ${f(baseY + dx * half)}L${f(baseX + dy * half)} ${f(baseY - dx * half)}Z`;
}
