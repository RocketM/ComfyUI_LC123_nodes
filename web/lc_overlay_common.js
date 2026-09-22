// Shared pieces for the LC nodes that draw themselves as HTML above the canvas (LC Label, LC Image Label):
// the overlay layer, canvas <-> screen maths, and a drag that survives the browser dropping pointer capture.
import { app } from "../../scripts/app.js";

let layer = null;
export function getLayer() {
  if (layer && layer.isConnected) return layer;
  const host = app.canvas?.canvas?.parentElement || document.body;
  layer = document.createElement("div");
  layer.style.cssText = "position:absolute;left:0;top:0;right:0;bottom:0;pointer-events:none;overflow:hidden;z-index:30;";
  host.appendChild(layer);
  return layer;
}

export function isSelected(node) {
  const sel = app.canvas?.selected_nodes;
  return !!(sel && (sel[node.id] || sel[String(node.id)]));
}

// the exact box size (ComfyUI rounds a reloaded node's size up to its grid; the exact size is kept in the properties)
function exactSize(node) {
  const p = node.properties || {};
  return [Number.isFinite(p._w) ? p._w : node.size[0], Number.isFinite(p._h) ? p._h : node.size[1]];
}

// screen position (client px) of a node's centre
export function screenCentre(node) {
  const c = app.canvas;
  const ds = c.ds;
  const cr = c.canvas.getBoundingClientRect();
  const [w, h] = exactSize(node);
  return [cr.left + (node.pos[0] + w / 2 + ds.offset[0]) * ds.scale, cr.top + (node.pos[1] + h / 2 + ds.offset[1]) * ds.scale];
}

// put a node's centre at a screen position (client px)
export function setCentreFromScreen(node, X, Y) {
  const c = app.canvas;
  const ds = c.ds;
  const cr = c.canvas.getBoundingClientRect();
  const gx = (X - cr.left) / ds.scale - ds.offset[0];
  const gy = (Y - cr.top) / ds.scale - ds.offset[1];
  const [w, h] = exactSize(node);
  node.pos = [gx - w / 2, gy - h / 2];
}

// tell ComfyUI something changed (undo history, the unsaved dot)
export function commit() {
  try {
    app.extensionManager?.workflow?.activeWorkflow?.changeTracker?.checkState?.();
  } catch (_) {}
}

// a drag that keeps working wherever the pointer goes: window-level listeners in the capture phase, so the canvas never
// sees the moves and the browser dropping the pointer capture cannot end the drag
export function dragHandle(el, onStart, onMove, onEnd) {
  el.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    onStart(e);
    const move = (ev) => {
      ev.stopPropagation();
      onMove(ev);
    };
    const up = (ev) => {
      ev.stopPropagation();
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", up, true);
      onEnd(ev);
    };
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", up, true);
  });
}

// is the graph point (gx, gy) inside the rotated w x h box centred on the node?
export function hitRotated(node, gx, gy, w, h, angleDeg) {
  const a = (-angleDeg * Math.PI) / 180;
  const [bw, bh] = exactSize(node);
  const dx = gx - (node.pos[0] + bw / 2);
  const dy = gy - (node.pos[1] + bh / 2);
  const lx = dx * Math.cos(a) - dy * Math.sin(a);
  const ly = dx * Math.sin(a) + dy * Math.cos(a);
  return Math.abs(lx) <= w / 2 && Math.abs(ly) <= h / 2;
}

// client px -> graph coordinates
export function clientToGraph(e) {
  const c = app.canvas;
  const cr = c.canvas.getBoundingClientRect();
  return [(e.clientX - cr.left) / c.ds.scale - c.ds.offset[0], (e.clientY - cr.top) / c.ds.scale - c.ds.offset[1], cr];
}

// rotation snapping: 5 degree steps with a magnet at 0 / 90 / 180 (so the right angles are easy to land on),
// Shift = 15 degree steps, Alt = free (0.1 degree)
export function snapAngle(a, e) {
  let out;
  if (e.altKey) {
    out = Math.round(a * 10) / 10;
  } else {
    const step = e.shiftKey ? 15 : 5;
    out = Math.round(a / step) * step;
    const right = Math.round(a / 90) * 90;
    if (Math.abs(a - right) < 8) out = right;
  }
  let r = ((out % 360) + 360) % 360;
  if (r > 180) r -= 360;
  return Math.round(r * 10) / 10;
}

// Nodes 2.0 draws every node as an HTML element that takes the click before the canvas does. A pinned label has to let
// the click through (to the node under it, or to the canvas for a box selection), so its element ignores the pointer.
// keydown/keyup miss a Ctrl already held when the canvas gets focus, and a synthetic drag never fires them at all -- the
// pointer/mouse events themselves always carry the live modifier state, so track it from those instead
let ctrlHeld = false;
for (const t of ["pointerdown", "pointermove", "mousedown", "mousemove"]) {
  window.addEventListener(t, (e) => { ctrlHeld = !!(e.ctrlKey || e.metaKey); }, true);
}

export function vueClickThrough(node, on) {
  let el = node.__vueEl;
  if (!el || !el.isConnected) {
    el = document.querySelector(`.lg-node[data-node-id="${node.id}"]`);
    node.__vueEl = el || null;
  }
  if (!el) return;
  // clip-path: a fully clipped element takes no clicks
  // while Ctrl is down (the box selection) the element is hit-testable again, which is how the box finds it
  const want = on && !ctrlHeld ? "inset(100%)" : "";
  if (el.style.clipPath !== want) el.style.clipPath = want;
}
