// LC Directional Blur — a small arrow pad: drag from center to set angle + length, or double-click either
// readout to type an exact value. The pad is capped at a comfortable drag range; typing still reaches the
// node's full range. Sits alongside the shared wipe-preview widget (web/lc_image_preview.js handles that
// half; this file only owns the pad + the hidden angle/distance widgets it mirrors).
import { app } from "../../scripts/app.js";

const NODE_NAMES = new Set(["LCDirectionalBlur"]);
const HIDE = new Set(["angle", "distance"]);
// Same width as the shared wipe-preview image area (lc_image_preview.js: 300 wide node, 16px padding each
// side -> 268 inner) so the pad and the preview line up instead of the pad looking like an afterthought in
// a much wider node. The pad is square, so this also makes the node noticeably taller -- expected.
const PAD_SIZE = 268;
const PAD_MAX_DRAG = 130; // px of drag == this many px of blur; type a bigger distance for more
const FACE_H = PAD_SIZE + 30; // pad + the angle/distance readout row above it

function findWidget(node, name) {
  return (node.widgets || []).find((w) => w && w.name === name);
}

function num(v, fb) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fb;
}

function ensureStyle() {
  if (document.getElementById("lc123-dirblur-style")) return;
  const st = document.createElement("style");
  st.id = "lc123-dirblur-style";
  st.textContent = `
.lc-db{display:flex;flex-direction:column;align-items:center;gap:4px;width:100%;box-sizing:border-box;padding:4px 6px;font:12px system-ui,sans-serif;color:#ddd;user-select:none}
.lc-db-readout{display:flex;gap:10px;font-variant-numeric:tabular-nums}
.lc-db-readout span{cursor:text;padding:1px 3px;border-radius:3px}
.lc-db-readout span:hover{background:#ffffff14}
.lc-db input.lc-db-edit{width:56px;font:inherit;text-align:center;color:#fff;background:#111;border:1px solid #666;border-radius:3px;padding:1px 3px}
.lc-db-pad{border-radius:8px;background:#1a1a1a;border:1px solid #444;cursor:crosshair;touch-action:none}
`;
  document.head.appendChild(st);
}

function readConfig(node) {
  const angle = num(findWidget(node, "angle")?.value, 0);
  const distance = num(findWidget(node, "distance")?.value, 0);
  return { angle, distance };
}

function writeConfig(node, angle, distance) {
  angle = ((angle % 360) + 360) % 360;
  distance = Math.max(0, Math.min(500, distance));
  const aw = findWidget(node, "angle");
  const dw = findWidget(node, "distance");
  if (aw) aw.value = angle;
  if (dw) dw.value = distance;
  return { angle, distance };
}

function hideBackendWidgets(node) {
  for (const w of node.widgets || []) {
    if (!w || !HIDE.has(w.name)) continue;
    w.type = "hidden";
    w.computeSize = () => [0, -4];
    if (w.options) w.options.hidden = true;
    try {
      Object.defineProperty(w, "hidden", { configurable: true, get: () => true, set: () => {} });
    } catch (_) {
      w.hidden = true;
    }
  }
}

function drawPad(ui, angle, distance) {
  const { canvas, ctx } = ui;
  const c = PAD_SIZE / 2;
  ctx.clearRect(0, 0, PAD_SIZE, PAD_SIZE);
  // boundary + crosshair
  ctx.strokeStyle = "#3a3a3a";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(c, c, c - 3, 0, Math.PI * 2);
  ctx.moveTo(c, 4);
  ctx.lineTo(c, PAD_SIZE - 4);
  ctx.moveTo(4, c);
  ctx.lineTo(PAD_SIZE - 4, c);
  ctx.stroke();

  const rad = (angle * Math.PI) / 180;
  const shown = Math.min(distance, PAD_MAX_DRAG);
  const tx = c + Math.cos(rad) * shown;
  const ty = c + Math.sin(rad) * shown;

  if (distance > 0.5) {
    ctx.strokeStyle = "#7fc8ff";
    ctx.fillStyle = "#7fc8ff";
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(c, c);
    ctx.lineTo(tx, ty);
    ctx.stroke();
    // arrowhead
    const headLen = 8;
    const headAngle = Math.PI / 7;
    ctx.beginPath();
    ctx.moveTo(tx, ty);
    ctx.lineTo(tx - headLen * Math.cos(rad - headAngle), ty - headLen * Math.sin(rad - headAngle));
    ctx.lineTo(tx - headLen * Math.cos(rad + headAngle), ty - headLen * Math.sin(rad + headAngle));
    ctx.closePath();
    ctx.fill();
    // a ring at the edge hints the value keeps going past the pad's visual cap
    if (distance > PAD_MAX_DRAG) {
      ctx.strokeStyle = "#7fc8ff88";
      ctx.beginPath();
      ctx.arc(c, c, PAD_MAX_DRAG, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  ctx.fillStyle = "#888";
  ctx.beginPath();
  ctx.arc(c, c, 2.5, 0, Math.PI * 2);
  ctx.fill();
}

function applyFace(node) {
  const ui = node._lcDbFace;
  if (!ui) return;
  const { angle, distance } = readConfig(node);
  ui.angleLabel.textContent = angle.toFixed(1) + "°";
  ui.distLabel.textContent = distance.toFixed(0) + "px";
  drawPad(ui, angle, distance);
}

function setFromDrag(node, clientX, clientY) {
  const ui = node._lcDbFace;
  const rect = ui.canvas.getBoundingClientRect();
  const c = PAD_SIZE / 2;
  const scaleX = PAD_SIZE / rect.width;
  const scaleY = PAD_SIZE / rect.height;
  const dx = (clientX - rect.left) * scaleX - c;
  const dy = (clientY - rect.top) * scaleY - c;
  let angle = (Math.atan2(dy, dx) * 180) / Math.PI;
  const dragPx = Math.hypot(dx, dy);
  const distance = Math.min(dragPx, PAD_MAX_DRAG);
  const cfg = writeConfig(node, angle, distance);
  applyFace(node);
  node.setDirtyCanvas?.(true, true);
  try {
    node.graph?.setisChangedFlag?.(node.id);
  } catch (_) {}
  return cfg;
}

function startEditValue(node, which) {
  const ui = node._lcDbFace;
  const labelEl = which === "angle" ? ui.angleLabel : ui.distLabel;
  if (ui.editing) return;
  ui.editing = which;
  const cfg = readConfig(node);
  const input = document.createElement("input");
  input.type = "number";
  input.className = "lc-db-edit";
  input.step = "any";
  input.value = which === "angle" ? cfg.angle.toFixed(1) : cfg.distance.toFixed(0);
  labelEl.replaceWith(input);
  input.focus();
  input.select();
  const done = (commit) => {
    if (ui.editing !== which) return;
    ui.editing = null;
    input.replaceWith(labelEl);
    if (commit && input.value !== "") {
      const v = parseFloat(input.value);
      if (Number.isFinite(v)) {
        const cur = readConfig(node);
        const next = which === "angle" ? { angle: v, distance: cur.distance } : { angle: cur.angle, distance: v };
        writeConfig(node, next.angle, next.distance);
        applyFace(node);
        node.setDirtyCanvas?.(true, true);
      }
    }
  };
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") done(true);
    else if (e.key === "Escape") done(false);
  });
  input.addEventListener("blur", () => done(true));
}

function attachFace(node) {
  if (node._lcDbFaceAttached) {
    applyFace(node);
    return;
  }
  node._lcDbFaceAttached = true;
  ensureStyle();

  const wrap = document.createElement("div");
  wrap.className = "lc-db";

  const readout = document.createElement("div");
  readout.className = "lc-db-readout";
  const angleLabel = document.createElement("span");
  angleLabel.title = "Double-click to type an exact angle";
  const distLabel = document.createElement("span");
  distLabel.title = "Double-click to type an exact length";
  angleLabel.addEventListener("dblclick", (e) => {
    e.stopPropagation();
    startEditValue(node, "angle");
  });
  distLabel.addEventListener("dblclick", (e) => {
    e.stopPropagation();
    startEditValue(node, "distance");
  });
  readout.append(angleLabel, distLabel);

  const canvas = document.createElement("canvas");
  canvas.className = "lc-db-pad";
  canvas.width = PAD_SIZE;
  canvas.height = PAD_SIZE;
  canvas.style.width = PAD_SIZE + "px";
  canvas.style.height = PAD_SIZE + "px";
  const ctx = canvas.getContext("2d");

  wrap.append(readout, canvas);
  node._lcDbFace = { wrap, canvas, ctx, angleLabel, distLabel, editing: null };

  let dragging = false;
  const onMove = (e) => {
    if (!dragging) return;
    setFromDrag(node, e.clientX, e.clientY);
  };
  const onUp = () => {
    dragging = false;
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
  };
  canvas.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragging = true;
    setFromDrag(node, e.clientX, e.clientY);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  });

  try {
    node._lcDbDomWidget = node.addDOMWidget("lc_db_face", "LC_DB_FACE", wrap, {
      getMinHeight: () => FACE_H,
      getHeight: () => FACE_H,
      serialize: false,
    });
    // addDOMWidget doesn't set computeSize itself. The shared wipe-preview module
    // (lc_image_preview.js) figures out where to start drawing the preview image by summing
    // every widget's computeSize -- a widget with no computeSize is assumed to be a normal
    // ~22px row. Without this, the pad's real ~298px is invisible to that math, so the preview
    // gets positioned as if the pad were 22px tall: the image ends up drawn starting underneath
    // where the pad actually sits on screen, and only the sliver below the pad's true bottom
    // edge is visible.
    node._lcDbDomWidget.computeSize = (w) => [w, FACE_H];
  } catch (e) {
    console.warn("LC Directional Blur face widget failed", e);
  }

  applyFace(node);
}

function boot(node) {
  hideBackendWidgets(node);
  attachFace(node);
  applyFace(node);
}

app.registerExtension({
  name: "LC123.DirectionalBlur",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (!NODE_NAMES.has(nodeData.name)) return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      onNodeCreated?.apply(this, arguments);
      requestAnimationFrame(() => boot(this));
      setTimeout(() => boot(this), 0);
      setTimeout(() => boot(this), 150);
      setTimeout(() => boot(this), 450);

      const onConfigure = this.onConfigure;
      this.onConfigure = function (info) {
        onConfigure?.apply(this, arguments);
        requestAnimationFrame(() => boot(this));
      };
    };
  },

  async nodeCreated(node) {
    if (!NODE_NAMES.has(node.comfyClass) && !NODE_NAMES.has(node.type)) return;
    requestAnimationFrame(() => boot(node));
  },
});
