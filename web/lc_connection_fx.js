/**
 * LC Connection FX: while you drag a wire, every socket it can plug into glows in its own socket color.
 * Close to the cursor, rings pulse out of the socket and grow brighter the closer you get.
 * Zoomed out, every valid socket glows brighter so the options stay easy to spot.
 *
 * Draws only while a wire is being dragged (classic canvas renderer). Otherwise the cost is one flag check per frame.
 */
import { app } from "../../scripts/app.js";

const ID = {
  on: "LC123.Connections.FX",
  radius: "LC123.Connections.FXReach",
  zoomGlow: "LC123.Connections.FXZoomGlow",
};
const cfg = { on: false, radius: 160, zoomGlow: 60 };

function get(id, fallback) {
  try {
    const v = app.extensionManager?.setting?.get?.(id) ?? app.ui?.settings?.getSettingValue?.(id);
    return v ?? fallback;
  } catch (_) {
    return fallback;
  }
}

function slotColor(canvas, slot, fallbackType) {
  const pick = (t) => {
    if (!t || t === "*") return null;
    const first = String(t).split(",")[0].trim();
    return canvas.default_connection_color_byType?.[first] || window.LGraphCanvas?.link_type_colors?.[first] || null;
  };
  return pick(slot?.type) || pick(fallbackType) || slot?.color_on || "#9fd3ff";
}

function hexToRgb(c) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(c).trim());
  if (!m) return [159, 211, 255];
  let h = m[1];
  if (h.length === 3) h = h.split("").map((x) => x + x).join("");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

const rgbCache = new Map();
function rgb(c) {
  let v = rgbCache.get(c);
  if (!v) rgbCache.set(c, (v = hexToRgb(c)));
  return v;
}

// every socket the wire being dragged could connect to: [{x, y, color}] in graph space
function targets(canvas) {
  const lc = canvas.linkConnector;
  if (!lc?.isConnecting) return null;
  const toInputs = lc.state?.connectingTo === "input";
  const links = lc.renderLinks || [];
  if (!links.length) return null;
  const fromType = links[0]?.fromSlot?.type;
  const out = [];
  for (const node of canvas.visible_nodes || []) {
    if (node.flags?.collapsed) continue;
    const slots = toInputs ? node.inputs : node.outputs;
    if (!slots?.length) continue;
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i];
      let ok = false;
      try {
        ok = toInputs ? lc.isInputValidDrop(node, slot) : links.some((l) => l.canConnectToOutput?.(node, slot));
      } catch (_) {}
      if (!ok) continue;
      const p = node.getConnectionPos(toInputs, i);
      out.push({ x: p[0], y: p[1], color: slotColor(canvas, slot, fromType) });
    }
  }
  return out;
}

function draw(canvas) {
  const list = targets(canvas);
  if (!list?.length) return;
  const ctx = canvas.ctx;
  const ds = canvas.ds;
  const s = ds.scale || 1;
  const mouse = canvas.graph_mouse || [0, 0];
  const t = performance.now() / 1000;
  // 0 at 100% zoom and above, 1 once zoomed out to 30%, scaled by the Zoomed-out glow setting
  const zoomOut = Math.min(1, Math.max(0, (1 - s) / 0.7)) * (cfg.zoomGlow / 100);
  const R = Math.max(20, cfg.radius);
  const px = 1 / s; // one screen pixel in graph units, so the effect keeps its screen size at any zoom

  ctx.save();
  try {
  ds.toCanvasContext(ctx);
  ctx.globalCompositeOperation = "lighter";
  let best = null;
  for (const it of list) {
    const d = Math.hypot(it.x - mouse[0], it.y - mouse[1]) * s; // screen px
    const near = Math.max(0, 1 - d / R);
    const [r, g, b] = rgb(it.color);

    // glow on every valid socket: stronger when zoomed out, and as the cursor gets close
    const glowR = (9 + 10 * zoomOut + 12 * near) * px;
    const a = Math.min(1, 0.22 + 0.5 * zoomOut + 0.55 * near);
    const grad = ctx.createRadialGradient(it.x, it.y, 0, it.x, it.y, glowR);
    grad.addColorStop(0, `rgba(${r},${g},${b},${a})`);
    grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(it.x, it.y, glowR, 0, Math.PI * 2);
    ctx.fill();

    if (near > 0) {
      // three rings pulse outward; closer = bigger, brighter and faster
      const speed = 0.7 + 1.3 * near;
      ctx.lineWidth = (1.2 + 1.6 * near) * px;
      for (let k = 0; k < 3; k++) {
        const phase = (t * speed + k / 3) % 1;
        const rr = (7 + phase * (10 + 26 * near)) * px;
        ctx.strokeStyle = `rgba(${r},${g},${b},${(1 - phase) * (0.25 + 0.75 * near)})`;
        ctx.beginPath();
        ctx.arc(it.x, it.y, rr, 0, Math.PI * 2);
        ctx.stroke();
      }
      if (!best || near > best.near) best = { it, near, r, g, b };
    }
  }
  // the closest socket gets a solid bright core
  if (best) {
    const { it, near, r, g, b } = best;
    ctx.fillStyle = `rgba(${Math.min(255, r + 80)},${Math.min(255, g + 80)},${Math.min(255, b + 80)},${0.5 + 0.5 * near})`;
    ctx.beginPath();
    ctx.arc(it.x, it.y, (3 + 2.5 * near) * px, 0, Math.PI * 2);
    ctx.fill();
  }
  } finally {
    ctx.restore(); // never leave the canvas transformed or in 'lighter' mode
  }
  canvas.setDirty(true, false); // keep the rings moving while the wire is held
}

let installed = false;
function install() {
  if (installed) return;
  const LGC = window.LGraphCanvas;
  if (!LGC?.prototype?.drawFrontCanvas) return;
  installed = true;
  const orig = LGC.prototype.drawFrontCanvas;
  LGC.prototype.drawFrontCanvas = function () {
    const r = orig.apply(this, arguments);
    if (cfg.on && !window.LiteGraph?.vueNodesMode && this.linkConnector?.isConnecting) {
      try {
        draw(this);
      } catch (e) {
        console.warn("[LC123] Connection FX", e);
      }
    }
    return r;
  };
}

app.registerExtension({
  name: "LC123.ConnectionFX",
  settings: [
    {
      id: ID.on,
      name: "Connection FX",
      type: "boolean",
      defaultValue: false,
      tooltip:
        "While you drag a wire, every socket it can connect to glows in its socket color. Rings pulse out and brighten as you get close.",
      category: ["LC123 Settings ⚙️", "Connections", "Connection FX"],
      sortOrder: 100,
      onChange: (v) => {
        cfg.on = v === true;
        if (cfg.on) install();
      },
    },
    {
      id: ID.radius,
      name: "Connection FX reach (px)",
      type: "slider",
      defaultValue: 160,
      attrs: { min: 40, max: 400, step: 10 },
      tooltip: "How close (in screen pixels) the cursor has to be before a socket starts to ring.",
      category: ["LC123 Settings ⚙️", "Connections", "Connection FX reach (px)"],
      sortOrder: 90,
      onChange: (v) => (cfg.radius = Number(v) || 160),
    },
    {
      id: ID.zoomGlow,
      name: "Connection FX zoomed-out glow (%)",
      type: "slider",
      defaultValue: 60,
      attrs: { min: 0, max: 100, step: 5 },
      tooltip: "How much brighter every valid socket glows when you are zoomed out. 0 = same as at 100% zoom.",
      category: ["LC123 Settings ⚙️", "Connections", "Connection FX zoomed-out glow (%)"],
      sortOrder: 80,
      onChange: (v) => (cfg.zoomGlow = Number.isFinite(Number(v)) ? Number(v) : 60),
    },
  ],
  setup() {
    cfg.on = get(ID.on, false) === true;
    cfg.radius = Number(get(ID.radius, 160)) || 160;
    cfg.zoomGlow = Number.isFinite(Number(get(ID.zoomGlow, 60))) ? Number(get(ID.zoomGlow, 60)) : 60;
    if (cfg.on) install();
  },
});
