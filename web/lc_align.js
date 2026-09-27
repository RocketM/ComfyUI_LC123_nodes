/**
 * LC Align: snap and guide lines for the canvas.
 *
 * - Settings > LC123 > Align > "Align tool" switches the whole tool (and its logo button in the toolbar) on or off.
 * - The logo button turns Align on and off for the open workflow. That on/off is saved in the workflow
 *   (graph.extra.lc_align_on), so each workflow tab keeps its own state and a saved workflow opens the way it was saved.
 * - While on, dragged nodes snap to Node lines and dragged groups snap to Group lines (optionally also to other nodes' edges).
 * - Snap distance follows ComfyUI's own Settings > Lite Graph > Canvas > Snap to grid size, so there is one place to tune it.
 *   Shift (or Always snap to grid) is ComfyUI's grid snap and takes over; after you let go the line snap is put back on top.
 * - Optional rulers on the top and left edge of the canvas:
 *     left click the ruler  = add a Node line   (nodes snap to it)
 *     right click the ruler = add a Group line  (groups snap to it)
 *     click a line's marker again to remove it, drag a marker to move it.
 *   Lines stay invisible on the canvas until the cursor or something you drag comes within the reveal distance.
 *   Lines are saved in the workflow (graph.extra.lc_guides).
 *
 * Works in the classic canvas and in Nodes 2.0. Nodes 2.0 moves nodes with its own drag, so there the snapped
 * position is put back every frame just after ComfyUI's update (see the Nodes 2.0 section), and the lines are drawn
 * on the overlay canvas that sits above the nodes. Groups are still moved by the canvas and use the classic path.
 */
import { app } from "../../scripts/app.js";

const ID = {
  tool: "LC123.Align.Enabled",
  rulers: "LC123.Align.Rulers",
  snapItems: "LC123.Align.SnapItems",
  revealPx: "LC123.Align.RevealDistance",
};
// tool = the whole feature is installed (Settings), on = switched on for the open workflow (logo button, saved in the workflow)
const cfg = { tool: true, on: false, rulers: true, snapItems: false, revealPx: 120 };

// ComfyUI's snap grid (Settings > Lite Graph > Canvas > Snap to grid size) is our snap distance, in graph units
function gridSize() {
  const g = Number(graph()?.getSnapToGridSize?.() ?? get("Comfy.SnapToGrid.GridSize", 10));
  return Number.isFinite(g) && g > 0 ? g : 10;
}
const onGrid = (v) => Math.round(v / gridSize()) * gridSize();

const COLOR = { node: "#38BDF8", group: "#F59E0B", match: "#A3E635" };
const RULER = 18; // ruler thickness, screen px
const EPS = 0.5;

function get(id, fallback) {
  try {
    const v = app.extensionManager?.setting?.get?.(id) ?? app.ui?.settings?.getSettingValue?.(id);
    return v ?? fallback;
  } catch (_) {
    return fallback;
  }
}
const vue = () => !!window.LiteGraph?.vueNodesMode;
const canvas = () => app.canvas;
const graph = () => app.canvas?.graph || app.graph;
const titleH = () => window.LiteGraph?.NODE_TITLE_HEIGHT ?? 30;

// ---------------------------------------------------------------- guide lines (saved in the workflow)
// {axis: "x" | "y", v: graph coordinate, kind: "node" | "group"}; axis x = a vertical line at x = v
function guides() {
  const g = graph();
  const list = g?.extra?.lc_guides;
  return Array.isArray(list) ? list : [];
}
function saveGuides(list) {
  const g = graph();
  if (!g) return;
  g.extra = g.extra || {};
  if (list.length) g.extra.lc_guides = list;
  else delete g.extra.lc_guides;
  canvas()?.setDirty?.(true, true);
  markChanged();
  drawRulers();
}

// tell ComfyUI the workflow changed (undo + unsaved dot); captureCanvasState replaced checkState in newer frontends
function markChanged() {
  const ct = app.extensionManager?.workflow?.activeWorkflow?.changeTracker;
  if (!ct) return;
  if (typeof ct.captureCanvasState === "function") ct.captureCanvasState();
  else ct.checkState?.();
}

// ---------------------------------------------------------------- geometry
const arr = (v) => v && typeof v.length === "number";
function nodeRect(n) {
  const th = n.flags?.no_title ? 0 : titleH();
  if (n.flags?.collapsed) {
    const w = n._collapsed_width || window.LiteGraph?.NODE_COLLAPSED_WIDTH || 80;
    return [n.pos[0], n.pos[1] - th, w, th];
  }
  return [n.pos[0], n.pos[1] - th, n.size[0], n.size[1] + th];
}
function groupRect(g) {
  const p = arr(g._pos) ? g._pos : g.pos;
  const s = arr(g._size) ? g._size : g.size;
  if (arr(p) && arr(s)) return [p[0], p[1], s[0], s[1]];
  const b = g._bounding;
  return arr(b) ? [b[0], b[1], b[2], b[3]] : null;
}
function groupPos(g) {
  return arr(g._pos) ? g._pos : g.pos;
}
function groupsOf(g) {
  return g?._groups || g?.groups || [];
}
const union = (rects) => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of rects) {
    x0 = Math.min(x0, r[0]);
    y0 = Math.min(y0, r[1]);
    x1 = Math.max(x1, r[0] + r[2]);
    y1 = Math.max(y1, r[1] + r[3]);
  }
  return [x0, y0, x1 - x0, y1 - y0];
};

// ---------------------------------------------------------------- snapping while dragging
const drag = {
  active: false,
  sx: 0,
  sy: 0,
  nodes: null, // Map node -> {x, y, w, h}
  groups: null, // Map group -> {x, y, w, h}
  locked: null, // {nodes: [], groups: [], mode, rect0}
  standDown: false,
  matches: [], // lines drawn while snapped: {axis, v, kind}
  moving: null, // current rect of what is being dragged (for revealing lines)
  final: null, // [[item, x, y]] where the last snap put things, re-applied after ComfyUI's grid snap on release
  rect: null, // canvas element rect at pointerdown
  g0: null, // graph position of the pointer at pointerdown
  snapped: false, // did the last move write a snapped position
  wasNear: false, // was the cursor near a line on the last idle move (redraw only while that changes)
  vueNode: false, // Nodes 2.0: this drag started on a node (its own drag moves it, see the Nodes 2.0 section)
  vueApply: null, // Nodes 2.0: [[item, x, y]] to put back every frame while a snap holds
  mouseG: null, // Nodes 2.0: pointer in graph space (graph_mouse does not follow the pointer over DOM nodes)
};

// pointer position in graph space with the view as it is right now (ComfyUI auto-pans while you drag near an edge)
function toGraphPoint(c, x, y) {
  const r = drag.rect;
  const s = c.ds.scale || 1;
  return [(x - r.left) / s - c.ds.offset[0], (y - r.top) / s - c.ds.offset[1]];
}

function onPointerDown(e) {
  drag.active = false;
  drag.vueNode = false;
  drag.vueApply = null;
  if (!cfg.on || e.button !== 0) return;
  const c = canvas();
  if (!c) return;
  const onNode = vue() && e.target !== c.canvas && !!vueNodeEl(e.target);
  if (e.target !== c.canvas && !onNode) return;
  const g = graph();
  drag.active = true;
  drag.vueNode = onNode;
  drag.rect = c.canvas.getBoundingClientRect();
  drag.g0 = toGraphPoint(c, e.clientX, e.clientY);
  drag.snapped = false;
  drag.locked = null;
  drag.standDown = false;
  drag.matches = [];
  drag.final = null;
  drag.nodes = new Map();
  for (const n of g._nodes || []) drag.nodes.set(n, { x: n.pos[0], y: n.pos[1], w: n.size[0], h: n.size[1], r: vue() ? domRect(n) : null });
  drag.groups = new Map();
  for (const gr of groupsOf(g)) {
    const r = groupRect(gr);
    if (r) drag.groups.set(gr, { x: r[0], y: r[1], w: r[2], h: r[3] });
  }
}

function lockMoving() {
  const nodes = [];
  const groups = [];
  for (const [n, s] of drag.nodes) {
    if (n.size[0] !== s.w || n.size[1] !== s.h) return "resize";
    if (n.pos[0] !== s.x || n.pos[1] !== s.y) {
      if (n.flags?.pinned) return "resize";
      nodes.push(n);
    }
  }
  for (const [gr, s] of drag.groups) {
    const r = groupRect(gr);
    if (!r) continue;
    if (Math.abs(r[2] - s.w) > EPS || Math.abs(r[3] - s.h) > EPS) return "resize";
    if (Math.abs(r[0] - s.x) > EPS || Math.abs(r[1] - s.y) > EPS) groups.push(gr);
  }
  if (!nodes.length && !groups.length) return null;
  const mode = groups.length ? "group" : "node";
  const start = (n) => {
    const s = drag.nodes.get(n);
    if (s.r) return s.r.slice(); // Nodes 2.0: the node box as drawn on screen at pointerdown
    const th = n.flags?.no_title ? 0 : titleH();
    return n.flags?.collapsed ? [s.x, s.y - th, n._collapsed_width || 80, th] : [s.x, s.y - th, s.w, s.h + th];
  };
  const rect0 =
    mode === "group"
      ? union(groups.map((gr) => { const s = drag.groups.get(gr); return [s.x, s.y, s.w, s.h]; }))
      : union(nodes.map(start));
  return { nodes, groups, mode, rect0 };
}

// candidate lines per axis for the current drag
function candidates(lock) {
  const xs = [];
  const ys = [];
  for (const gd of guides()) {
    if (gd.kind !== lock.mode) continue;
    (gd.axis === "x" ? xs : ys).push({ v: gd.v, kind: gd.kind, guide: true });
  }
  if (cfg.snapItems) {
    const movingN = new Set(lock.nodes);
    const movingG = new Set(lock.groups);
    const add = (r) => {
      xs.push({ v: r[0], kind: "match" }, { v: r[0] + r[2], kind: "match" }, { v: r[0] + r[2] / 2, kind: "match" });
      ys.push({ v: r[1], kind: "match" }, { v: r[1] + r[3], kind: "match" }, { v: r[1] + r[3] / 2, kind: "match" });
    };
    for (const n of graph()._nodes || []) if (!movingN.has(n)) add(itemRect(n));
    for (const gr of groupsOf(graph())) {
      if (movingG.has(gr)) continue;
      const r = groupRect(gr);
      if (r) add(r);
    }
  }
  return { xs, ys };
}

// best snap for one axis: edges = [start, end, center] of the moving rect. Your ruler lines win over node edges.
function bestSnap(edges, lines, limit) {
  const own = lines.filter((l) => l.guide);
  return (own.length && nearestLine(edges, own, limit)) || nearestLine(edges, lines, limit);
}
function nearestLine(edges, lines, limit) {
  let best = null;
  for (const l of lines) {
    for (const e of edges) {
      const d = l.v - e;
      if (Math.abs(d) <= limit && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, line: l };
    }
  }
  return best;
}

function onPointerMove(e) {
  const c = canvas();
  if (!c) return;
  if (drag.vueNode) return; // Nodes 2.0 node drags are handled in onPointerMoveVue
  if (!drag.active) {
    // lines fade in and out around the cursor: redraw only while the cursor is near one (or just left one)
    if (!cfg.on || e.target !== c.canvas) return;
    const list = guides();
    if (!list.length) return;
    const m = c.graph_mouse || [0, 0];
    const reveal = cfg.revealPx / (c.ds.scale || 1);
    const near = list.some((gd) => Math.abs((gd.axis === "x" ? m[0] : m[1]) - gd.v) < reveal);
    if (near || drag.wasNear) c.setDirty(true, false);
    drag.wasNear = near;
    return;
  }
  if (!cfg.on || !(e.buttons & 1) || c.dragging_canvas || c.dragging_rectangle) return;
  if (drag.standDown) return;
  if (!drag.locked) {
    const l = lockMoving();
    if (l === "resize") {
      drag.standDown = true;
      return;
    }
    if (!l) return;
    drag.locked = l;
  }
  const lock = drag.locked;
  const s = c.ds.scale || 1;
  const g = toGraphPoint(c, e.clientX, e.clientY);
  const dx = g[0] - drag.g0[0];
  const dy = g[1] - drag.g0[1];
  const r = [lock.rect0[0] + dx, lock.rect0[1] + dy, lock.rect0[2], lock.rect0[3]];
  let sx = 0, sy = 0;
  drag.matches = [];
  drag.final = null;
  // Shift = ComfyUI's own grid snap, no line snap: hand the drag back to ComfyUI
  if (!e.shiftKey) {
    const { xs, ys } = candidates(lock);
    const limit = Math.max(gridSize(), 4 / s);
    const bx = bestSnap([r[0], r[0] + r[2], r[0] + r[2] / 2], xs, limit);
    const by = bestSnap([r[1], r[1] + r[3], r[1] + r[3] / 2], ys, limit);
    if (bx) {
      sx = bx.d;
      drag.matches.push({ axis: "x", v: bx.line.v, kind: bx.line.kind });
    }
    if (by) {
      sy = by.d;
      drag.matches.push({ axis: "y", v: by.line.v, kind: by.line.kind });
    }
  }
  drag.moving = [r[0] + sx, r[1] + sy, r[2], r[3]];
  const snapping = !!(sx || sy);
  // ComfyUI moves the items itself; positions are only written while a snap holds them (or once, to let go of one)
  if (!snapping && !drag.snapped) return;
  drag.snapped = snapping;
  const final = [];
  for (const n of lock.nodes) {
    const st = drag.nodes.get(n);
    n.pos[0] = st.x + dx + sx;
    n.pos[1] = st.y + dy + sy;
    final.push([() => n.pos, sx ? n.pos[0] : null, sy ? n.pos[1] : null]);
  }
  for (const gr of lock.groups) {
    const st = drag.groups.get(gr);
    const p = groupPos(gr);
    if (arr(p)) {
      p[0] = st.x + dx + sx;
      p[1] = st.y + dy + sy;
      final.push([() => groupPos(gr), sx ? p[0] : null, sy ? p[1] : null]);
    }
  }
  if (snapping) drag.final = final;
  c.setDirty(true, true);
}

function onPointerUp() {
  if (!drag.active) return;
  // ComfyUI grid-snaps the dropped items on release (Shift / Always snap to grid); a line snap wins over that
  const final = drag.final;
  const putBack = () => {
    for (const [pos, x, y] of final) {
      const p = pos(); // only the axis that snapped to a line; the other one keeps ComfyUI's grid snap
      if (x !== null) p[0] = x;
      if (y !== null) p[1] = y;
    }
    canvas()?.setDirty?.(true, true);
  };
  if (final) {
    setTimeout(putBack, 0);
    if (drag.vueNode) requestAnimationFrame(() => requestAnimationFrame(putBack)); // after Nodes 2.0 settles its drop
  }
  drag.final = null;
  drag.vueNode = false;
  drag.vueApply = null;
  drag.active = false;
  drag.locked = null;
  drag.matches = [];
  drag.moving = null;
  canvas()?.setDirty?.(true, true);
}

// ---------------------------------------------------------------- Nodes 2.0
// Nodes 2.0 draws every node as a page element and moves it with its own drag, which works out the position from where
// the drag started plus how far the pointer went, on every pointer move. A position written in a pointer event is
// simply overwritten, so the snapped position is worked out here and put back every animation frame, just after
// ComfyUI's own update. Groups are still dragged by the canvas, so they keep the classic path.
function vueNodeEl(target) {
  return target?.closest?.("[data-node-id]") || null;
}
// a node's box as it is drawn on screen, in graph units (the Nodes 2.0 header and size differ from litegraph's numbers)
function domRect(n) {
  const c = canvas();
  const el = document.querySelector(`[data-node-id="${n.id}"]`);
  if (!c || !el) return null;
  const r = el.getBoundingClientRect();
  if (!r.width && !r.height) return null;
  const cr = c.canvas.getBoundingClientRect();
  const s = c.ds.scale || 1;
  return [(r.left - cr.left) / s - c.ds.offset[0], (r.top - cr.top) / s - c.ds.offset[1], r.width / s, r.height / s];
}
const itemRect = (n) => (vue() && domRect(n)) || nodeRect(n);

function pointerGraph(c, e) {
  const r = c.canvas.getBoundingClientRect();
  const s = c.ds.scale || 1;
  return [(e.clientX - r.left) / s - c.ds.offset[0], (e.clientY - r.top) / s - c.ds.offset[1]];
}

// Nodes 2.0 gives every node its own stacking level, so ComfyUI's canvases (and its overlay canvas) all sit under
// the nodes. The lines get their own see-through canvas above them that never takes the pointer.
let vueLines = null;
function vueLinesCtx(c) {
  const host = c.canvas?.parentElement;
  if (!host) return null;
  if (!vueLines) {
    vueLines = document.createElement("canvas");
    vueLines.className = "lc-align-lines";
    vueLines.style.cssText = "position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;z-index:998;"; // above the nodes (3 and up), under ComfyUI's panels (999)
  }
  if (vueLines.parentElement !== host) host.appendChild(vueLines);
  const dpr = window.devicePixelRatio || 1;
  const W = Math.max(1, Math.round(host.clientWidth * dpr));
  const H = Math.max(1, Math.round(host.clientHeight * dpr));
  if (vueLines.width !== W) vueLines.width = W;
  if (vueLines.height !== H) vueLines.height = H;
  const ctx = vueLines.getContext("2d");
  ctx.clearRect(0, 0, W, H);
  return ctx;
}
function clearVueLines() {
  if (vueLines?.width) vueLines.getContext("2d").clearRect(0, 0, vueLines.width, vueLines.height);
}

let vueLoop = 0;
function vueFrame() {
  vueLoop = 0;
  if (!drag.active || !drag.vueNode) return;
  const list = drag.vueApply;
  if (list)
    for (const [pos, x, y] of list) {
      const p = pos();
      if (x !== null && p[0] !== x) p[0] = x;
      if (y !== null && p[1] !== y) p[1] = y;
    }
  vueLoop = requestAnimationFrame(vueFrame);
}

function onPointerMoveVue(e) {
  if (!vue()) return;
  const c = canvas();
  if (!c || !cfg.on) return;
  drag.mouseG = pointerGraph(c, e);
  if (!drag.active) {
    // lines fade in around the cursor over nodes too (over empty canvas the classic handler does it)
    if (e.target === c.canvas || !vueNodeEl(e.target)) return;
    const list = guides();
    if (!list.length) return;
    const reveal = cfg.revealPx / (c.ds.scale || 1);
    const m = drag.mouseG;
    const near = list.some((gd) => Math.abs((gd.axis === "x" ? m[0] : m[1]) - gd.v) < reveal);
    if (near || drag.wasNear) c.setDirty(true, false);
    drag.wasNear = near;
    return;
  }
  if (!drag.vueNode || !(e.buttons & 1) || drag.standDown) return;
  // this runs before ComfyUI moves the node for this event: look at the move on the next frame
  const x = e.clientX, y = e.clientY, shift = e.shiftKey;
  requestAnimationFrame(() => vueStep(c, x, y, shift));
}

function vueStep(c, clientX, clientY, shift) {
  if (!drag.active || !drag.vueNode || drag.standDown) return;
  if (!drag.locked) {
    const l = lockMoving();
    if (l === "resize") {
      drag.standDown = true;
      return;
    }
    if (!l) return;
    drag.locked = l;
  }
  const lock = drag.locked;
  const s = c.ds.scale || 1;
  const g = toGraphPoint(c, clientX, clientY);
  const dx = g[0] - drag.g0[0];
  const dy = g[1] - drag.g0[1];
  const r = [lock.rect0[0] + dx, lock.rect0[1] + dy, lock.rect0[2], lock.rect0[3]];
  let sx = 0, sy = 0;
  drag.matches = [];
  // Shift = ComfyUI's own grid snap, no line snap
  if (!shift) {
    const { xs, ys } = candidates(lock);
    const limit = Math.max(gridSize(), 4 / s);
    const bx = bestSnap([r[0], r[0] + r[2], r[0] + r[2] / 2], xs, limit);
    const by = bestSnap([r[1], r[1] + r[3], r[1] + r[3] / 2], ys, limit);
    if (bx) {
      sx = bx.d;
      drag.matches.push({ axis: "x", v: bx.line.v, kind: bx.line.kind });
    }
    if (by) {
      sy = by.d;
      drag.matches.push({ axis: "y", v: by.line.v, kind: by.line.kind });
    }
  }
  drag.moving = [r[0] + sx, r[1] + sy, r[2], r[3]];
  if (!sx && !sy) {
    // no line in reach: ComfyUI's own drag places the node
    drag.vueApply = null;
    drag.final = null;
    c.setDirty(true, false);
    return;
  }
  const list = [];
  for (const n of lock.nodes) {
    const st = drag.nodes.get(n);
    list.push([() => n.pos, sx ? st.x + dx + sx : null, sy ? st.y + dy + sy : null]);
  }
  drag.vueApply = list;
  drag.final = list;
  if (!vueLoop) vueLoop = requestAnimationFrame(vueFrame);
  c.setDirty(true, false);
}

// ---------------------------------------------------------------- drawing lines on the canvas
function drawLines(c, overlay = null) {
  const list = guides();
  const hover = ruler.hover;
  if (!list.length && !drag.matches.length && !hover) return;
  const ctx = overlay || c.ctx;
  const ds = c.ds;
  const s = ds.scale || 1;
  const px = 1 / s;
  const vis = c.visible_area || [-1e6, -1e6, 2e6, 2e6];
  const mouse = (overlay && drag.mouseG) || c.graph_mouse || [0, 0];
  const reveal = cfg.revealPx / s;
  const mv = drag.moving;

  ctx.save();
  try {
  if (overlay) {
    // the overlay canvas is in screen pixels (device pixel ratio included), like ComfyUI's own overlay links
    const k = overlay.canvas.width / (overlay.canvas.clientWidth || 1);
    ctx.setTransform(k, 0, 0, k, 0, 0);
  }
  ds.toCanvasContext(ctx);
  const line = (axis, v, color, alpha, dash) => {
    if (alpha <= 0.01) return;
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5 * px;
    ctx.setLineDash(dash ? [6 * px, 5 * px] : []);
    ctx.beginPath();
    if (axis === "x") {
      ctx.moveTo(v, vis[1]);
      ctx.lineTo(v, vis[1] + vis[3]);
    } else {
      ctx.moveTo(vis[0], v);
      ctx.lineTo(vis[0] + vis[2], v);
    }
    ctx.stroke();
  };
  for (const gd of list) {
    // distance from the cursor, and from the edges of whatever is being dragged
    let d = Math.abs((gd.axis === "x" ? mouse[0] : mouse[1]) - gd.v);
    if (mv) {
      const a = gd.axis === "x" ? [mv[0], mv[0] + mv[2], mv[0] + mv[2] / 2] : [mv[1], mv[1] + mv[3], mv[1] + mv[3] / 2];
      for (const e of a) d = Math.min(d, Math.abs(e - gd.v));
    }
    let alpha = Math.max(0, 1 - d / reveal);
    if (ruler.hot === gd) alpha = 1;
    line(gd.axis, gd.v, COLOR[gd.kind] || COLOR.node, alpha * 0.9, false);
  }
  for (const m of drag.matches) if (m.kind !== "match") line(m.axis, m.v, COLOR[m.kind], 1, false); // edge-to-edge snaps stay silent
  if (hover && !ruler.hot) line(hover.axis, hover.v, "#ffffff", 0.45, true);
  } finally {
    ctx.restore();
  }
}

// ---------------------------------------------------------------- rulers
const ruler = { top: null, left: null, corner: null, hover: null, hot: null, press: null, box: null };

function visibleBox() {
  // the part of the canvas not covered by the tab bar, the floating action bar or the side tool bar
  const c = canvas();
  const cr = c.canvas.getBoundingClientRect();
  let top = cr.top;
  let left = cr.left;
  const tabs = document.querySelector(".workflow-tabs-container");
  if (tabs) {
    const r = tabs.getBoundingClientRect();
    if (r.height && r.bottom > top && r.top < top + 80) top = r.bottom;
  }
  const bar = app.menu?.settingsGroup?.element?.closest?.(".actionbar-container");
  if (bar) {
    const r = bar.getBoundingClientRect();
    if (r.height && r.top < top + 60) top = Math.max(top, r.bottom + 6);
  }
  const side = document.querySelector(".side-tool-bar-container");
  if (side) {
    const r = side.getBoundingClientRect();
    if (r.width && r.left <= left + 2) left = Math.max(left, r.right);
  }
  return { top, left, right: cr.right, bottom: cr.bottom, cr };
}

function makeBar(cls) {
  const el = document.createElement("canvas");
  el.className = "lc-align-ruler " + cls;
  el.style.cssText = "position:fixed;z-index:5;cursor:crosshair;display:none;";
  document.body.appendChild(el);
  return el;
}

function ensureRulers() {
  if (ruler.top) return;
  ruler.top = makeBar("lc-align-ruler-top");
  ruler.left = makeBar("lc-align-ruler-left");
  ruler.corner = document.createElement("div");
  ruler.corner.style.cssText = `position:fixed;z-index:5;display:none;width:${RULER}px;height:${RULER}px;background:#1b1f24;border-right:1px solid #3a4048;border-bottom:1px solid #3a4048;box-sizing:border-box;`;
  ruler.corner.title = "Rulers: left click = Node line, right click = Group line, click a marker again to remove it";
  document.body.appendChild(ruler.corner);
  for (const [el, axis] of [[ruler.top, "x"], [ruler.left, "y"]]) {
    el.addEventListener("pointermove", (e) => rulerMove(e, axis));
    el.addEventListener("pointerleave", () => {
      if (ruler.press) return;
      ruler.hover = null;
      ruler.hot = null;
      canvas()?.setDirty?.(true, false);
      drawRulers();
    });
    el.addEventListener("pointerdown", (e) => rulerDown(e, axis));
    el.addEventListener("pointerup", (e) => rulerUp(e, axis));
    el.addEventListener("pointercancel", () => {
      ruler.press = null;
      ruler.hot = null;
      drawRulers(true);
    });
    el.addEventListener("contextmenu", (e) => e.preventDefault());
  }
}

const toGraph = (axis, clientPos) => {
  const c = canvas();
  const cr = ruler.box.cr;
  const s = c.ds.scale;
  return axis === "x" ? (clientPos - cr.left) / s - c.ds.offset[0] : (clientPos - cr.top) / s - c.ds.offset[1];
};
const toScreen = (axis, v) => {
  const c = canvas();
  const cr = ruler.box.cr;
  const s = c.ds.scale;
  return axis === "x" ? (v + c.ds.offset[0]) * s + cr.left : (v + c.ds.offset[1]) * s + cr.top;
};
function nearest(axis, client) {
  let best = null;
  for (const gd of guides()) {
    if (gd.axis !== axis) continue;
    const d = Math.abs(toScreen(axis, gd.v) - client);
    if (d <= 6 && (!best || d < best.d)) best = { gd, d };
  }
  return best?.gd || null;
}
const clientOf = (e, axis) => (axis === "x" ? e.clientX : e.clientY);

function rulerMove(e, axis) {
  const cl = clientOf(e, axis);
  if (ruler.press) {
    const p = ruler.press;
    if (p.gd && Math.abs(cl - p.start) > 3) p.moved = true;
    if (p.moved) {
      p.gd.v = onGrid(toGraph(axis, cl));
      canvas()?.setDirty?.(true, false);
      drawRulers();
    }
    return;
  }
  ruler.hot = nearest(axis, cl);
  ruler.hover = ruler.hot ? null : { axis, v: onGrid(toGraph(axis, cl)) };
  e.currentTarget.style.cursor = ruler.hot ? "pointer" : "crosshair";
  canvas()?.setDirty?.(true, false);
  drawRulers();
}
function rulerDown(e, axis) {
  if (e.button !== 0 && e.button !== 2) return; // left = Node line, right = Group line, nothing else
  e.preventDefault();
  e.stopPropagation();
  const cl = clientOf(e, axis);
  ruler.press = { axis, button: e.button, start: cl, gd: nearest(axis, cl), moved: false };
  try {
    e.currentTarget.setPointerCapture(e.pointerId);
  } catch (_) {}
}
function rulerUp(e, axis) {
  const p = ruler.press;
  ruler.press = null;
  if (!p) return;
  const list = guides().slice();
  if (p.gd) {
    // a click on an existing line removes it, a drag has already moved it
    if (!p.moved) list.splice(list.indexOf(p.gd), 1);
    ruler.hot = null;
  } else if (p.button === 0 || p.button === 2) {
    list.push({ axis, v: onGrid(toGraph(axis, clientOf(e, axis))), kind: p.button === 2 ? "group" : "node" });
  }
  saveGuides(list);
}

function niceStep(scale) {
  const steps = [10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000];
  for (const st of steps) if (st * scale >= 70) return st;
  return steps[steps.length - 1];
}

let lastView = "";
function drawRulers(force) {
  const show = cfg.on && cfg.rulers && !!canvas();
  if (!show) {
    if (ruler.top) for (const el of [ruler.top, ruler.left, ruler.corner]) el.style.display = "none";
    return;
  }
  ensureRulers();
  const c = canvas();
  const box = (ruler.box = ruler.box || visibleBox());
  const s = c.ds.scale;
  const key = [box.top, box.left, box.right, box.bottom, s, c.ds.offset[0], c.ds.offset[1], guides().length, ruler.hot?.v, JSON.stringify(ruler.hover)].join("|");
  if (!force && key === lastView) return;
  lastView = key;
  const dpr = window.devicePixelRatio || 1;
  const place = (el, x, y, w, h) => {
    el.style.display = "block";
    el.style.left = x + "px";
    el.style.top = y + "px";
    el.style.width = w + "px";
    el.style.height = h + "px";
    if (el.tagName === "CANVAS") {
      const W = Math.max(1, Math.round(w * dpr));
      const H = Math.max(1, Math.round(h * dpr));
      if (el.width !== W) el.width = W;
      if (el.height !== H) el.height = H;
    }
  };
  place(ruler.corner, box.left, box.top, RULER, RULER);
  place(ruler.top, box.left + RULER, box.top, Math.max(0, box.right - box.left - RULER), RULER);
  place(ruler.left, box.left, box.top + RULER, RULER, Math.max(0, box.bottom - box.top - RULER));

  const step = niceStep(s);
  for (const [el, axis] of [[ruler.top, "x"], [ruler.left, "y"]]) {
    const ctx = el.getContext("2d");
    const len = axis === "x" ? el.width / dpr : el.height / dpr;
    const origin = axis === "x" ? box.left + RULER : box.top + RULER;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#1b1f24";
    ctx.fillRect(0, 0, axis === "x" ? len : RULER, axis === "x" ? RULER : len);
    ctx.fillStyle = "#3a4048";
    if (axis === "x") ctx.fillRect(0, RULER - 1, len, 1);
    else ctx.fillRect(RULER - 1, 0, 1, len);
    const g0 = toGraph(axis, origin);
    const g1 = toGraph(axis, origin + len);
    ctx.strokeStyle = "#6b7480";
    ctx.fillStyle = "#9aa3ad";
    ctx.font = "9px sans-serif";
    ctx.lineWidth = 1;
    ctx.beginPath();
    const minor = step / 5;
    for (let v = Math.ceil(g0 / minor) * minor; v <= g1; v += minor) {
      const p = Math.round(toScreen(axis, v) - origin) + 0.5;
      const major = Math.abs(v / step - Math.round(v / step)) < 1e-6;
      const tick = major ? RULER * 0.55 : RULER * 0.25;
      if (axis === "x") {
        ctx.moveTo(p, RULER);
        ctx.lineTo(p, RULER - tick);
      } else {
        ctx.moveTo(RULER, p);
        ctx.lineTo(RULER - tick, p);
      }
      if (major) {
        const t = String(Math.round(v));
        if (axis === "x") ctx.fillText(t, p + 2, 8);
        else {
          ctx.save();
          ctx.translate(8, p - 2);
          ctx.rotate(-Math.PI / 2);
          ctx.fillText(t, 0, 0);
          ctx.restore();
        }
      }
    }
    ctx.stroke();
    // line markers
    for (const gd of guides()) {
      if (gd.axis !== axis) continue;
      const p = toScreen(axis, gd.v) - origin;
      if (p < -6 || p > len + 6) continue;
      ctx.fillStyle = COLOR[gd.kind] || COLOR.node;
      ctx.globalAlpha = ruler.hot === gd ? 1 : 0.85;
      ctx.beginPath();
      if (axis === "x") {
        ctx.moveTo(p - 5, 0);
        ctx.lineTo(p + 5, 0);
        ctx.lineTo(p, RULER - 2);
      } else {
        ctx.moveTo(0, p - 5);
        ctx.lineTo(0, p + 5);
        ctx.lineTo(RULER - 2, p);
      }
      ctx.fill();
      ctx.globalAlpha = 1;
      if (ruler.hot === gd) {
        ctx.fillStyle = "#fff";
        const label = gd.kind === "group" ? "Group" : "Node";
        if (axis === "x") ctx.fillText(label, p + 7, 14);
        else {
          ctx.save();
          ctx.translate(14, p - 7);
          ctx.rotate(-Math.PI / 2);
          ctx.fillText(label, 0, 0);
          ctx.restore();
        }
      }
    }
    if (ruler.hover && ruler.hover.axis === axis) {
      const p = toScreen(axis, ruler.hover.v) - origin;
      ctx.fillStyle = "rgba(255,255,255,0.6)";
      if (axis === "x") ctx.fillRect(p - 0.5, 0, 1, RULER);
      else ctx.fillRect(0, p - 0.5, RULER, 1);
    }
  }
}

// the visible area only changes when the window or the side panels change, so measure it on a slow timer (only while on)
let boxTimer = null;
function watchBox(on) {
  clearInterval(boxTimer);
  boxTimer = null;
  ruler.box = null;
  if (!on) return;
  boxTimer = setInterval(() => {
    if (!canvas()) return;
    const b = visibleBox();
    const o = ruler.box;
    if (!o || o.top !== b.top || o.left !== b.left || o.right !== b.right || o.bottom !== b.bottom) {
      ruler.box = b;
      drawRulers(true);
    } else ruler.box.cr = b.cr;
  }, 700);
}

// ---------------------------------------------------------------- on/off per workflow
// The on/off state lives in the root workflow (not a subgraph), so every tab keeps its own and it is saved with the workflow.
const root = () => app.graph;
const savedOn = () => !!root()?.extra?.lc_align_on;
function setOn(v) {
  const g = root();
  if (!g) return;
  g.extra = g.extra || {};
  if (v) g.extra.lc_align_on = true;
  else delete g.extra.lc_align_on;
  markChanged();
  syncOn();
}
// follow the open workflow: switching tabs or opening a saved workflow brings its own on/off with it
function syncOn() {
  const want = cfg.tool && savedOn();
  if (want === cfg.on) return;
  cfg.on = want;
  if (!want) onPointerUp();
  applyOn();
}

// ---------------------------------------------------------------- toolbar button
let btn = null;
let btnGroup = null;
const LOGO_ON = new URL("./icons/lc_align_logo.png", import.meta.url).href;
const LOGO_OFF = new URL("./icons/lc_align_logo_off.png", import.meta.url).href; // same logo, flame in the right side's gray
const ICON = `<img src="${LOGO_OFF}" alt="Align" draggable="false" style="width:24px;height:24px;display:block;pointer-events:none">`;
new Image().src = LOGO_ON; // preloaded, so the first click swaps without a blank frame
const BG_ON = "rgb(175,175,175)"; // light gray: Align is on
const BG_OFF = "rgb(75,75,75)"; // dark gray: Align is off
function mountButton(tries = 0) {
  const anchor = app.menu?.settingsGroup?.element;
  if (!anchor) {
    if (tries < 40) setTimeout(() => mountButton(tries + 1), 250);
    return;
  }
  if (btnGroup) {
    // the toolbar was rebuilt (for example Nodes 2.0 switched on or off): move the same button back in
    if (!btnGroup.isConnected) anchor.before(btnGroup);
    document.querySelectorAll(".lc-align-group").forEach((g) => g !== btnGroup && g.remove());
    paintButton();
    return;
  }
  document.querySelectorAll(".lc-align-group").forEach((g) => g.remove()); // never two buttons
  btnGroup = document.createElement("div");
  btnGroup.className = "comfyui-button-group lc-align-group";
  btnGroup.style.flexShrink = "0"; // keep the logo button whole when the toolbar is crowded
  btn = document.createElement("button");
  btn.className = "comfyui-button lc-align-btn";
  btn.innerHTML = ICON;
  btn.addEventListener("click", () => setOn(!cfg.on));
  btnGroup.appendChild(btn);
  anchor.before(btnGroup);
  // keep the button square whatever height the toolbar gives it
  new ResizeObserver(squareButton).observe(btn);
  paintButton();
}
function squareButton() {
  const h = btn?.offsetHeight;
  if (h && btn.style.width !== h + "px") btn.style.width = btn.style.minWidth = h + "px";
}
function paintButton() {
  if (!btn) return;
  btnGroup.style.display = cfg.tool ? "" : "none";
  btn.title = cfg.on
    ? "LC Align is on for this workflow: rulers show, nodes snap to Node lines, groups to Group lines. Saved with the workflow. Click to turn off."
    : "LC Align: rulers with Node / Group lines that nodes and groups snap to. Click to turn on for this workflow.";
  btn.style.background = cfg.on ? BG_ON : BG_OFF;
  const img = btn.querySelector("img");
  const src = cfg.on ? LOGO_ON : LOGO_OFF;
  if (img && img.src !== src) img.src = src;
  // square: as wide as the toolbar makes it tall (set in mountButton), logo centered
  btn.style.padding = "0";
  btn.style.display = "flex";
  btn.style.alignItems = "center";
  btn.style.justifyContent = "center";
  squareButton();
}

function applyOn() {
  paintButton();
  watchBox(cfg.on && cfg.rulers);
  drawRulers(true);
  canvas()?.setDirty?.(true, true);
}

// ---------------------------------------------------------------- install
let installed = false;
let lastVue = null;
function install() {
  if (installed) return;
  const LGC = window.LGraphCanvas;
  if (!LGC?.prototype?.drawFrontCanvas) return;
  installed = true;
  const orig = LGC.prototype.drawFrontCanvas;
  LGC.prototype.drawFrontCanvas = function () {
    const r = orig.apply(this, arguments);
    if (!cfg.tool) return r;
    try {
      syncOn(); // one flag read per frame: picks up tab switches and freshly opened workflows
      if (btnGroup && !btnGroup.isConnected) mountButton(); // the toolbar was rebuilt: put the same button back
      const v = vue();
      if (v !== lastVue) {
        lastVue = v;
        paintButton();
        if (!v) clearVueLines(); // back to classic: nothing left on the Nodes 2.0 layer
      }
      if (v) {
        // Nodes 2.0: the lines go on Align's own layer above the nodes
        if (cfg.on) {
          const ctx = vueLinesCtx(this);
          if (ctx) drawLines(this, ctx);
          if (cfg.rulers) drawRulers();
        } else clearVueLines();
      } else if (cfg.on) {
        drawLines(this);
        if (cfg.rulers) drawRulers();
      }
    } catch (e) {
      console.warn("[LC123] Align", e);
    }
    return r;
  };
  window.addEventListener("pointerdown", onPointerDown, true);
  window.addEventListener("pointermove", onPointerMove, false);
  window.addEventListener("pointermove", onPointerMoveVue, true);
  window.addEventListener("pointerup", onPointerUp, true);
  window.addEventListener("pointercancel", onPointerUp, true);
}

app.registerExtension({
  name: "LC123.Align",
  settings: [
    {
      id: ID.tool,
      name: "Align tool",
      type: "boolean",
      defaultValue: true,
      sortOrder: 100,
      tooltip:
        "Turns the whole Align tool on or off, including its logo button in the top toolbar. While on, the logo button (light gray = on, dark gray = off) switches Align on for the open workflow, and that is saved with the workflow.",
      category: ["LC123 Settings ⚙️", "Align", "Align tool"],
      onChange: (v) => {
        cfg.tool = v !== false;
        if (cfg.tool) install();
        cfg.on = cfg.tool && savedOn();
        if (!cfg.on) onPointerUp();
        applyOn(); // also shows or hides the logo button
      },
    },
    {
      id: ID.rulers,
      name: "Rulers",
      type: "boolean",
      defaultValue: true,
      sortOrder: 90,
      tooltip:
        "Rulers on the top and left edge while Align is on. Left click = Node line, right click = Group line, click a marker again to remove it, drag a marker to move it.",
      category: ["LC123 Settings ⚙️", "Align", "Rulers"],
      onChange: (v) => {
        cfg.rulers = v !== false;
        applyOn();
      },
    },
    {
      id: ID.revealPx,
      name: "Line reveal distance (px)",
      type: "slider",
      defaultValue: 120,
      sortOrder: 80,
      attrs: { min: 10, max: 600, step: 10 },
      tooltip: "Ruler lines stay invisible until the cursor or something you drag is this close (screen pixels). They fade in as you get closer.",
      category: ["LC123 Settings ⚙️", "Align", "Line reveal distance (px)"],
      onChange: (v) => {
        cfg.revealPx = Number(v) || 120;
        canvas()?.setDirty?.(true, false);
      },
    },
    {
      id: ID.snapItems,
      name: "Also snap to other nodes and groups",
      type: "boolean",
      defaultValue: false,
      sortOrder: 70,
      tooltip:
        "Also snap to the edges and centers of other nodes and groups (no line is shown for these). Off = snap to your ruler lines only. Snap distance is ComfyUI's Snap to grid size (Lite Graph > Canvas).",
      category: ["LC123 Settings ⚙️", "Align", "Also snap to other nodes and groups"],
      onChange: (v) => (cfg.snapItems = v === true),
    },
  ],
  setup() {
    cfg.tool = get(ID.tool, true) !== false;
    cfg.rulers = get(ID.rulers, true) !== false;
    cfg.snapItems = get(ID.snapItems, false) === true;
    cfg.revealPx = Number(get(ID.revealPx, 120)) || 120;
    install();
    mountButton();
    cfg.on = cfg.tool && savedOn();
    applyOn();
  },
});

window.LC123Align = { cfg, drag, guides, isOn: () => cfg.on }; // the Optimization report reads isOn; also handy from the console
