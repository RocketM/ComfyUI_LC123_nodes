/**
 * LC Lighting Control V2 - the drag light stage.
 * Drag a handle = X / Y.  Shift+drag vertically, or the mouse wheel over a handle = Z (how frontal).
 * White = light 1, red = light 2 (when enabled). A live readout under the stage shows the exact numbers, and an
 * arrow shows which way the shadow falls. Widgets that do not apply (light 2 off, soft-only options, ...) are hidden.
 */
import { app } from "../../scripts/app.js";
import { lcApplyLaunchColor } from "./lc_color.js";

const COLOR = "#324B4B";
const TYPE = "LCLightingControlV2";
const STAGE = 268; // square stage, CSS px
const MARGIN = 16;

const L2_WIDGETS = [
  "light2_type", "light2_x", "light2_y", "light2_z", "light2_brightness", "light2_spread", "light2_warmth",
];
// fine controls, shown only when "advanced" is on
const ADVANCED_WIDGETS = [
  "relief", "depth_falloff", "shadow_height", "shadow_length", "shadow_softness", "subject_distance", "self_shadow", "mask_dome", "background_shadow",
];
// relief and self_shadow decide how much occlusion you get, so they are not hidden behind "advanced"
const ALWAYS_SHOWN = new Set(["relief", "self_shadow", "background_shadow"]);
const ADVANCED_SHADOW = new Set(["relief", "shadow_height", "shadow_length", "shadow_softness", "self_shadow", "background_shadow"]);

// preset = a starting look. Applying one sets these widgets; editing any of them afterwards flips the preset to custom.
const L1 = (x, y, z, brightness, spread, warmth, type = "spot") => ({
  light1_type: type, light1_x: x, light1_y: y, light1_z: z, light1_brightness: brightness, light1_spread: spread, light1_warmth: warmth,
});
const PRESETS = {
  "Soft window (left)": { ...L1(-0.7, 0.3, 0.55, 1.3, 1.3, 0.05), fill: 0.25, shadows: "soft", shadow_amount: 0.35, enable_light_2: false },
  "Soft window (right)": { ...L1(0.7, 0.3, 0.55, 1.3, 1.3, 0.05), fill: 0.25, shadows: "soft", shadow_amount: 0.35, enable_light_2: false },
  "Rembrandt": { ...L1(0.65, 0.6, 0.5, 1.4, 0.9, 0.1), fill: 0.18, shadows: "soft", shadow_amount: 0.55, enable_light_2: false },
  "Split (hard side)": { ...L1(0.95, 0, 0.3, 1.3, 1.5, 0, "sun"), fill: 0.12, shadows: "hard", shadow_amount: 0.6, enable_light_2: false },
  "Top light": { ...L1(0, 0.9, 0.4, 1.4, 0.9, 0), fill: 0.2, shadows: "soft", shadow_amount: 0.5, enable_light_2: false },
  "Under light": { ...L1(0, -0.85, 0.45, 1.2, 1.0, -0.1), fill: 0.15, shadows: "soft", shadow_amount: 0.45, enable_light_2: false },
  "Rim / back light": { ...L1(0.9, 0.5, 0.05, 1.6, 0.6, 0.2), fill: 0.3, shadows: "soft", shadow_amount: 0.3, enable_light_2: false },
  "Golden hour": { ...L1(0.85, 0.25, 0.3, 1.5, 1.5, 0.7), fill: 0.22, shadows: "soft", shadow_amount: 0.5, enable_light_2: false },
  "Key + fill": {
    ...L1(0.6, 0.5, 0.55, 1.3, 1.0, 0.1), fill: 0.15, shadows: "soft", shadow_amount: 0.5, enable_light_2: true,
    light2_type: "spot", light2_x: -0.8, light2_y: -0.1, light2_z: 0.5, light2_brightness: 0.5, light2_spread: 1.4, light2_warmth: -0.15,
  },
  "Flat front": { ...L1(0, 0.15, 1.0, 1.0, 1.4, 0), fill: 0.3, shadows: "off", shadow_amount: 0.4, enable_light_2: false },
};
// every preset also sets the fine controls (the "advanced" ones) so a preset is a complete look
// order: relief, depth_falloff, shadow_height, shadow_length, shadow_softness, subject_distance, self_shadow, mask_dome, shadow_blur, light_wrap
const FINE_KEYS = ["relief", "depth_falloff", "shadow_height", "shadow_length", "shadow_softness", "subject_distance", "self_shadow", "mask_dome", "shadow_blur", "light_wrap", "background_shadow"];
const FINE = {
  "Soft window (left)": [0.4, 0.3, 0.4, 0.3, 0.7, 0.12, 0.7, 0.4, 0.4, 0.4, 0.5],
  "Soft window (right)": [0.4, 0.3, 0.4, 0.3, 0.7, 0.12, 0.7, 0.4, 0.4, 0.4, 0.5],
  "Rembrandt": [0.45, 0.4, 0.3, 0.35, 0.5, 0.15, 0.8, 0.4, 0.3, 0.3, 0.5],
  "Split (hard side)": [0.45, 0.2, 0.3, 0.4, 0.2, 0.15, 0.9, 0.3, 0.5, 0.3, 0.5],
  "Top light": [0.45, 0.4, 0.5, 0.3, 0.5, 0.12, 0.8, 0.4, 0.3, 0.3, 0.5],
  "Under light": [0.4, 0.4, 0.4, 0.3, 0.6, 0.12, 0.7, 0.4, 0.4, 0.3, 0.5],
  "Rim / back light": [0.4, 0.3, 0.25, 0.35, 0.5, 0.15, 0.5, 0.5, 0.35, 0.2, 0.5],
  "Golden hour": [0.45, 0.5, 0.2, 0.45, 0.55, 0.2, 0.8, 0.4, 0.35, 0.3, 0.5],
  "Key + fill": [0.45, 0.4, 0.3, 0.35, 0.5, 0.15, 0.8, 0.4, 0.3, 0.3, 0.5],
  "Flat front": [0.3, 0.2, 0.4, 0.3, 0.5, 0.1, 0.5, 0.4, 0.3, 0.4, 0.5],
};
for (const [k, v] of Object.entries(PRESETS)) FINE_KEYS.forEach((n, i) => (v[n] = FINE[k][i]));
const PRESET_KEYS = new Set(["preset", ...new Set(Object.values(PRESETS).flatMap((p) => Object.keys(p)))]);
PRESET_KEYS.delete("preset");
PRESET_KEYS.add("light2_type").add("light2_x").add("light2_y").add("light2_z").add("light2_brightness").add("light2_spread").add("light2_warmth");

function widget(node, name) {
  return (node.widgets || []).find((x) => x && x.name === name);
}
function wval(node, name, fallback) {
  const w = widget(node, name);
  if (!w || w.value === undefined || w.value === null || w.value === "") return fallback;
  return w.value;
}
function setWval(node, name, value) {
  const w = widget(node, name);
  if (!w) return;
  w.value = value;
  try {
    w.callback?.(value, undefined, node, undefined, undefined);
  } catch (_) {}
}
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const radiusForZ = (z, base) => base * (0.55 + 0.7 * clamp(Number(z), 0, 1));

// ---- show / hide widgets that do not apply ----

function setVisible(w, vis) {
  if (!w) return;
  if (!w._lcOrig) w._lcOrig = { type: w.type, computeSize: w.computeSize };
  if (vis) {
    w.type = w._lcOrig.type;
    if (w._lcOrig.computeSize) w.computeSize = w._lcOrig.computeSize;
    else delete w.computeSize;
    try {
      w.hidden = false;
    } catch (_) {}
    if (w.options) w.options.hidden = false;
  } else {
    w.type = "hidden";
    w.computeSize = () => [0, -4];
    try {
      w.hidden = true;
    } catch (_) {}
    if (w.options) w.options.hidden = true;
  }
}

function applyPreset(node, name) {
  const p = PRESETS[name];
  if (!p) return;
  node.__lcApplying = true;
  try {
    for (const [k, v] of Object.entries(p)) setWval(node, k, v);
  } finally {
    node.__lcApplying = false;
  }
  syncVisibility(node);
  node.__lcStageRedraw?.();
}

function syncVisibility(node) {
  const two = !!wval(node, "enable_light_2", false);
  for (const n of L2_WIDGETS) setVisible(widget(node, n), two);
  const mode = String(wval(node, "shadows", "soft"));
  const adv = !!wval(node, "advanced", false);
  setVisible(widget(node, "shadow_amount"), mode !== "off");
  setVisible(widget(node, "shadow_blur"), mode !== "off");
  for (const n of ADVANCED_WIDGETS) {
    let vis = adv || ALWAYS_SHOWN.has(n);
    if (ADVANCED_SHADOW.has(n) && mode === "off") vis = false;
    if (n === "shadow_softness" && mode !== "soft") vis = false;
    setVisible(widget(node, n), vis);
  }
  setVisible(widget(node, "light1_spread"), String(wval(node, "light1_type", "spot")) === "spot");
  if (two) setVisible(widget(node, "light2_spread"), String(wval(node, "light2_type", "spot")) === "spot");
  // keep the width, follow the new content height
  try {
    const sz = node.computeSize();
    node.setSize([node.size[0], Math.max(sz[1], 120)]);
  } catch (_) {}
  node.setDirtyCanvas?.(true, true);
}

// ---- the stage ----

function installStage(node) {
  if (node.__lcStageV2) return;
  node.__lcStageV2 = true;

  const wrap = document.createElement("div");
  wrap.style.cssText = "width:100%;display:flex;flex-direction:column;align-items:center;padding:4px 0 2px 0;box-sizing:border-box;";

  const canvas = document.createElement("canvas");
  canvas.width = STAGE * 2;
  canvas.height = STAGE * 2;
  canvas.style.cssText = `width:${STAGE}px;height:${STAGE}px;border-radius:6px;cursor:grab;touch-action:none;background:#1a1f1f;`;
  wrap.appendChild(canvas);

  const readout = document.createElement("div");
  readout.style.cssText =
    "font:11px ui-monospace,Consolas,monospace;color:rgba(255,255,255,0.75);margin-top:5px;user-select:none;text-align:center;line-height:1.4;";
  wrap.appendChild(readout);

  const hint = document.createElement("div");
  hint.textContent = "drag = X/Y   ·   shift-drag or wheel = Z (front)";
  hint.style.cssText = "font-size:10px;color:rgba(255,255,255,0.4);margin-top:2px;user-select:none;";
  wrap.appendChild(hint);

  const dom = node.addDOMWidget("lc_light_stage", "LC_LIGHT_STAGE", wrap, {
    getMinHeight: () => STAGE + 64,
    hideOnZoom: false,
  });
  dom.serializeValue = () => undefined;
  // the stage goes first, so the picture of the light is the first thing on the node
  try {
    const arr = node.widgets;
    const i = arr.indexOf(dom);
    if (i > 0) {
      arr.splice(i, 1);
      arr.splice(0, 0, dom);
    }
  } catch (_) {}

  let dragging = null;
  let lastY = 0;
  let shiftZ = false;

  const usable = () => STAGE - 2 * MARGIN;
  const toPx = (x, y) => ({
    px: MARGIN + ((Number(x) + 1) / 2) * usable(),
    py: MARGIN + ((1 - Number(y)) / 2) * usable(),
  });
  const toLight = (px, py) => {
    const u = clamp((px - MARGIN) / usable(), 0, 1);
    const v = clamp((py - MARGIN) / usable(), 0, 1);
    return { x: Math.round((u * 2 - 1) * 20) / 20, y: Math.round((1 - v * 2) * 20) / 20 };
  };
  const local = (ev) => {
    const r = canvas.getBoundingClientRect();
    return { x: ((ev.clientX - r.left) * STAGE) / Math.max(1, r.width), y: ((ev.clientY - r.top) * STAGE) / Math.max(1, r.height) };
  };
  const lights = () => {
    const out = [{ id: "1", x: wval(node, "light1_x", 0.65), y: wval(node, "light1_y", 0.6), z: wval(node, "light1_z", 0.5), type: wval(node, "light1_type", "spot"), color: "#F5F5F5" }];
    if (wval(node, "enable_light_2", false)) {
      out.push({ id: "2", x: wval(node, "light2_x", -0.8), y: wval(node, "light2_y", -0.1), z: wval(node, "light2_z", 0.5), type: wval(node, "light2_type", "spot"), color: "#E74C3C" });
    }
    return out;
  };
  const hit = (lx, ly) => {
    let best = null;
    let bestD = Infinity;
    for (const l of lights()) {
      const p = toPx(l.x, l.y);
      const d = Math.hypot(lx - p.px, ly - p.py);
      if (d <= radiusForZ(l.z, 12) + 8 && d < bestD) {
        bestD = d;
        best = l.id;
      }
    }
    return best;
  };
  const getZ = (id) => Number(wval(node, `light${id}_z`, 0.5));
  const setZ = (id, z) => setWval(node, `light${id}_z`, Math.round(clamp(z, 0, 1) * 20) / 20);

  function arrow(ctx, x0, y0, x1, y1, color, dash) {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 1.5;
    if (dash) ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
    ctx.setLineDash([]);
    const a = Math.atan2(y1 - y0, x1 - x0);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x1 - 7 * Math.cos(a - 0.4), y1 - 7 * Math.sin(a - 0.4));
    ctx.lineTo(x1 - 7 * Math.cos(a + 0.4), y1 - 7 * Math.sin(a + 0.4));
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  function redraw() {
    const ctx = canvas.getContext("2d");
    const s = canvas.width / STAGE;
    ctx.setTransform(s, 0, 0, s, 0, 0);
    ctx.clearRect(0, 0, STAGE, STAGE);
    ctx.fillStyle = "#1a1f1f";
    ctx.fillRect(0, 0, STAGE, STAGE);
    ctx.strokeStyle = "#3a4545";
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, STAGE - 1, STAGE - 1);

    // the picture area, crosshair, and the subject in the middle
    ctx.strokeStyle = "rgba(255,255,255,0.07)";
    ctx.strokeRect(MARGIN, MARGIN, usable(), usable());
    ctx.strokeStyle = "rgba(255,255,255,0.12)";
    ctx.beginPath();
    ctx.moveTo(MARGIN, STAGE / 2);
    ctx.lineTo(STAGE - MARGIN, STAGE / 2);
    ctx.moveTo(STAGE / 2, MARGIN);
    ctx.lineTo(STAGE / 2, STAGE - MARGIN);
    ctx.stroke();
    ctx.strokeStyle = "rgba(255,255,255,0.22)";
    ctx.beginPath();
    ctx.arc(STAGE / 2, STAGE / 2, usable() * 0.14, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = "rgba(255,255,255,0.3)";
    ctx.font = "9px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("subject", STAGE / 2, STAGE / 2);
    ctx.fillStyle = "rgba(255,255,255,0.28)";
    ctx.fillText("up  (+Y)", STAGE / 2, 8);
    ctx.fillText("down", STAGE / 2, STAGE - 7);
    ctx.save();
    ctx.translate(STAGE - 8, STAGE / 2);
    ctx.rotate(Math.PI / 2);
    ctx.fillText("right  (+X)", 0, 0);
    ctx.restore();
    ctx.save();
    ctx.translate(8, STAGE / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText("left", 0, 0);
    ctx.restore();

    const shadowsOn = String(wval(node, "shadows", "soft")) !== "off";
    const cx = STAGE / 2;
    const cy = STAGE / 2;
    for (const l of lights()) {
      const p = toPx(l.x, l.y);
      // the light's aim: from the handle toward the subject
      arrow(ctx, p.px, p.py, cx + (p.px - cx) * 0.3, cy + (p.py - cy) * 0.3, l.color + "88", true);
      // where the shadow falls: away from the light, same direction the engine uses
      if (shadowsOn) {
        const vx = Number(l.x);
        const vy = Number(l.y);
        const len = Math.hypot(vx, vy);
        // same fade as the engine: a light near the middle is head-on and throws no sideways shadow
        let f = clamp((len - 0.05) / 0.45, 0, 1);
        f = f * f * (3 - 2 * f);
        if (f > 0.02) {
          const ux = -vx / len;
          const uy = vy / len; // stage y grows downward, light +Y is up
          arrow(
            ctx, cx + ux * usable() * 0.16, cy + uy * usable() * 0.16,
            cx + ux * usable() * (0.16 + 0.2 * f), cy + uy * usable() * (0.16 + 0.2 * f),
            "rgba(150,170,255," + (0.35 + 0.4 * f).toFixed(2) + ")", false
          );
        }
      }
    }
    for (const l of lights()) {
      const p = toPx(l.x, l.y);
      const r = radiusForZ(l.z, 10);
      ctx.beginPath();
      ctx.arc(p.px, p.py, r + 3, 0, Math.PI * 2);
      ctx.fillStyle = l.color + "33";
      ctx.fill();
      if (l.type === "sun") {
        ctx.strokeStyle = l.color;
        ctx.lineWidth = 1.5;
        for (let k = 0; k < 8; k++) {
          const a = (k / 8) * Math.PI * 2;
          ctx.beginPath();
          ctx.moveTo(p.px + Math.cos(a) * (r + 2), p.py + Math.sin(a) * (r + 2));
          ctx.lineTo(p.px + Math.cos(a) * (r + 7), p.py + Math.sin(a) * (r + 7));
          ctx.stroke();
        }
      }
      ctx.beginPath();
      ctx.arc(p.px, p.py, r, 0, Math.PI * 2);
      ctx.fillStyle = l.color;
      ctx.fill();
      ctx.strokeStyle = "rgba(0,0,0,0.45)";
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.fillStyle = "rgba(0,0,0,0.75)";
      ctx.font = "bold 9px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(l.id, p.px, p.py);
    }

    readout.innerHTML = lights()
      .map((l) => `<span style="color:${l.color}">●</span> ${l.id}  x ${Number(l.x).toFixed(2)}  y ${Number(l.y).toFixed(2)}  z ${Number(l.z).toFixed(2)}  ${l.type}`)
      .join("<br>");
  }

  canvas.addEventListener("pointerdown", (ev) => {
    const loc = local(ev);
    const id = hit(loc.x, loc.y);
    if (!id) return;
    dragging = id;
    lastY = loc.y;
    shiftZ = !!ev.shiftKey;
    canvas.setPointerCapture?.(ev.pointerId);
    canvas.style.cursor = shiftZ ? "ns-resize" : "grabbing";
    ev.preventDefault();
    ev.stopPropagation();
  });
  canvas.addEventListener("pointermove", (ev) => {
    if (!dragging) return;
    const loc = local(ev);
    if (ev.shiftKey || shiftZ) {
      const dy = lastY - loc.y;
      lastY = loc.y;
      setZ(dragging, getZ(dragging) + dy * 0.02);
    } else {
      const { x, y } = toLight(loc.x, loc.y);
      setWval(node, `light${dragging}_x`, x);
      setWval(node, `light${dragging}_y`, y);
    }
    redraw();
    app.canvas?.setDirty?.(true, true);
    ev.preventDefault();
    ev.stopPropagation();
  });
  const end = (ev) => {
    if (!dragging) return;
    dragging = null;
    shiftZ = false;
    canvas.style.cursor = "grab";
    try {
      canvas.releasePointerCapture?.(ev.pointerId);
    } catch (_) {}
  };
  canvas.addEventListener("pointerup", end);
  canvas.addEventListener("pointercancel", end);
  canvas.addEventListener(
    "wheel",
    (ev) => {
      const id = hit(local(ev).x, local(ev).y);
      if (!id) return;
      setZ(id, getZ(id) - Math.sign(ev.deltaY) * 0.05);
      redraw();
      app.canvas?.setDirty?.(true, true);
      ev.preventDefault();
      ev.stopPropagation();
    },
    { passive: false }
  );

  // any related widget change redraws the stage and re-checks what to show
  const hookNames = new Set([...PRESET_KEYS, "preset", "advanced"]);
  const visNames = new Set(["enable_light_2", "shadows", "light1_type", "light2_type", "advanced", "preset"]);
  for (const w of node.widgets || []) {
    if (!w || w._lcStageHooked || !hookNames.has(w.name)) continue;
    w._lcStageHooked = true;
    const prev = w.callback;
    const name = w.name;
    w.callback = function (v, ...args) {
      const out = prev?.apply(this, [v, ...args]);
      if (name === "preset") {
        if (String(v) !== "custom") applyPreset(node, String(v));
      } else if (PRESET_KEYS.has(name) && !node.__lcApplying) {
        // the user changed a value by hand: it is no longer the preset
        const pw = widget(node, "preset");
        if (pw && pw.value !== "custom") pw.value = "custom";
      }
      redraw();
      if (visNames.has(name)) syncVisibility(node);
      return out;
    };
  }

  node.__lcStageRedraw = () => {
    redraw();
    syncVisibility(node);
  };
  requestAnimationFrame(node.__lcStageRedraw);
  setTimeout(node.__lcStageRedraw, 60);
  setTimeout(node.__lcStageRedraw, 250);
}

app.registerExtension({
  name: "LC123.LightingV2Chrome",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== TYPE) return;
    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onCreated?.apply(this, arguments);
      try {
        lcApplyLaunchColor(this, COLOR);
      } catch (_) {}
      installStage(this); // synchronous: the widget list must be final before saved values are restored
      return r;
    };
    // a saved workflow restores widget values after creation: redraw and re-check visibility once it has
    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      const r = onConfigure?.apply(this, arguments);
      setTimeout(() => this.__lcStageRedraw?.(), 30);
      setTimeout(() => this.__lcStageRedraw?.(), 300);
      return r;
    };
  },
  nodeCreated(node) {
    if ((node.comfyClass || node.type) !== TYPE) return;
    installStage(node);
  },
});
