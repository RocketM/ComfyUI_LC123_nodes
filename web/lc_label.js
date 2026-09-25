// LC Label
// A chromeless text label for annotating a workflow. Drawn as HTML on a layer above the canvas, so it is never buried
// under nodes or links (clicks pass straight through the text to the canvas, so the label is selected, moved and
// pinned like any node). Select it to get the Word / Paint style handles: the round handle above rotates it (hold
// snaps to 5 degrees with a magnet at 0 / 90 / 180), a corner handle scales it. Double-click opens the settings dialog, like LC Image Label.
import { app } from "../../scripts/app.js";
import { getLayer, isSelected, screenCentre, setCentreFromScreen, commit, dragHandle, hitRotated, clientToGraph, snapAngle, vueClickThrough } from "./lc_overlay_common.js";

const NODE = "LCLabel";

// ---- fonts -------------------------------------------------------------------------------------------------
const BUNDLED = [
  { name: "Bebas Neue", file: "BebasNeue-Regular.ttf", weight: "400" },
  { name: "Oswald", file: "Oswald-Variable.ttf", weight: "200 700" },
  { name: "Permanent Marker", file: "PermanentMarker-Regular.ttf", weight: "400" },
  { name: "Pacifico", file: "Pacifico-Regular.ttf", weight: "400" },
  { name: "Lobster", file: "Lobster-Regular.ttf", weight: "400" },
  { name: "Great Vibes", file: "GreatVibes-Regular.ttf", weight: "400" },
  { name: "Abril Fatface", file: "AbrilFatface-Regular.ttf", weight: "400" },
  { name: "Cinzel Decorative", file: "CinzelDecorative-Regular.ttf", weight: "400" },
  { name: "UnifrakturMaguntia", file: "UnifrakturMaguntia-Book.ttf", weight: "400" },
  { name: "Monoton", file: "Monoton-Regular.ttf", weight: "400" },
  { name: "Bangers", file: "Bangers-Regular.ttf", weight: "400" },
  { name: "Creepster", file: "Creepster-Regular.ttf", weight: "400" },
  { name: "Rubik Glitch", file: "RubikGlitch-Regular.ttf", weight: "400" },
  { name: "Press Start 2P", file: "PressStart2P-Regular.ttf", weight: "400" },
];
const SYSTEM = [
  "Arial", "Arial Black", "Segoe UI", "Bahnschrift", "Trebuchet MS", "Verdana", "Impact", "Georgia", "Times New Roman",
  "Segoe Script", "Ink Free", "Comic Sans MS", "Courier New", "Consolas",
];

let fontsStarted = false;
function loadBundledFonts() {
  if (fontsStarted) return;
  fontsStarted = true;
  document.fonts?.ready?.then(relayoutAll);
  for (const f of BUNDLED) {
    try {
      const face = new FontFace(f.name, `url(${new URL("./fonts/" + f.file, import.meta.url).href})`, { weight: f.weight });
      document.fonts.add(face);
      face.load().then(relayoutAll).catch(() => {});
    } catch (_) {}
  }
}
const fontCss = (name) => `"${name}", Arial, sans-serif`;

// ---- defaults ----------------------------------------------------------------------------------------------
const DEFAULTS = {
  text: "Label",
  font: "Arial",
  size: 48,
  bold: true,
  italic: false,
  color: "#ffffff",
  align: "center",
  outline: false,
  outlineColor: "#000000",
  outlineWidth: 4,
  shadow: false,
  shadowBlur: 10,
  bg: false,
  bgColor: "#324B4B",
  radius: 12,
  padding: 8,
  angle: 0,
  width: 0, // 0 = auto: the box fits the text. Above 0 = a fixed wrap width
};

const WORKFLOW_COLORS = ["#ffdd77", "#ffffff", "#ff3232", "#324b4b", "#c3782d", "#649632", "#5a78ff", "#a05aff"];
const BASIC_COLORS = [
  "#ff4d4d", "#ff9a3c", "#ffe63c", "#50e070", "#3cd8ff", "#4a6dff", "#a05aff", "#ff4ccc",
  "#000000", "#333333", "#666666", "#999999", "#bbbbbb", "#dddddd", "#eeeeee", "#ffffff",
];

function recentColors() {
  try { return JSON.parse(localStorage.getItem("lc_label_recent") || "[]"); } catch (_) { return []; }
}
function pushRecent(c) {
  try {
    const list = [c, ...recentColors().filter((x) => x !== c)].slice(0, 8);
    localStorage.setItem("lc_label_recent", JSON.stringify(list));
  } catch (_) {}
}

const labelNodes = new Set();
let loopOn = false;
function startLoop() {
  if (loopOn) return;
  loopOn = true;
  const tick = () => {
    if (!labelNodes.size) {
      loopOn = false;
      return;
    }
    for (const n of labelNodes) renderNode(n);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
function relayoutAll() {
  for (const n of labelNodes) layoutNode(n);
}

// ---- the label view (one per node) -------------------------------------------------------------------------
function buildView(node) {
  const box = document.createElement("div");
  box.style.cssText = "position:absolute;left:0;top:0;transform-origin:0 0;pointer-events:none;will-change:transform;display:none;";
  const txt = document.createElement("div");
  box.appendChild(txt);
  const frame = document.createElement("div");
  frame.style.cssText = "position:absolute;left:0;top:0;right:0;bottom:0;pointer-events:none;display:none;";
  box.appendChild(frame);

  const mkHandle = (cursor, round) => {
    const h = document.createElement("div");
    h.style.cssText = `position:absolute;width:${round ? 24 : 12}px;height:${round ? 24 : 12}px;background:#fff;border:2px solid #6cf;border-radius:${round ? "50%" : "2px"};cursor:${cursor};pointer-events:auto;display:none;box-sizing:border-box;touch-action:none;`;
    if (round) {
      h.style.display = "none";
      h.style.alignItems = "center";
      h.style.justifyContent = "center";
      h.style.fontSize = "15px";
      h.style.fontWeight = "bold";
      h.style.color = "#246";
      h.style.lineHeight = "1";
      h.textContent = "⟳";
    }
    box.appendChild(h);
    return h;
  };
  const corners = [
    { el: mkHandle("nwse-resize"), fx: 0, fy: 0 },
    { el: mkHandle("nesw-resize"), fx: 1, fy: 0 },
    { el: mkHandle("nesw-resize"), fx: 0, fy: 1 },
    { el: mkHandle("nwse-resize"), fx: 1, fy: 1 },
  ];
  const sides = [
    { el: mkHandle("ew-resize"), fx: 0, fy: 0.5 },
    { el: mkHandle("ew-resize"), fx: 1, fy: 0.5 },
  ];
  for (const k of sides) {
    k.el.style.width = "10px";
    k.el.style.height = "18px";
    k.el.style.borderRadius = "4px";
  }
  const rot = mkHandle("grab", true);
  const stem = document.createElement("div");
  stem.style.cssText = "position:absolute;background:#6cf;pointer-events:none;display:none;";
  box.appendChild(stem);
  const badge = document.createElement("div");
  badge.style.cssText = "position:absolute;padding:2px 8px;background:#111;border:1px solid #6cf;color:#6cf;border-radius:10px;font:12px Arial,sans-serif;white-space:nowrap;pointer-events:none;display:none;";
  box.appendChild(badge);

  const v = { box, txt, frame, corners, sides, rot, stem, badge, w: 60, h: 40, key: "", sel: false };
  getLayer().appendChild(box);
  wireHandles(node, v);
  wireSideHandles(node, v);
  return v;
}

function applyTextStyle(node) {
  const p = node.properties;
  const t = node.__lc.txt;
  t.textContent = p.text === "" ? " " : p.text;
  const s = t.style;
  s.cssText = "display:inline-block;white-space:pre;position:relative;";
  s.fontFamily = fontCss(p.font);
  s.fontSize = p.size + "px";
  s.fontWeight = p.bold ? "700" : "400";
  s.fontSynthesisWeight = "none"; // no fake bold: on fonts without a bold face (Impact, Bebas Neue...) it leaves seams inside the letters
  s.fontStyle = p.italic ? "italic" : "normal";
  s.lineHeight = "1.15";
  s.color = p.color;
  s.textAlign = p.align;
  s.padding = (p.bg ? p.padding : 4) + "px " + (p.bg ? p.padding * 1.6 : 4) + "px";
  if (p.width > 0) {
    s.boxSizing = "border-box";
    s.width = p.width + "px";
    s.whiteSpace = "pre-wrap";
    s.overflowWrap = "break-word";
  }
  if (p.bg) {
    s.background = p.bgColor;
    s.borderRadius = p.radius + "px";
  }
  if (p.outline) {
    s.webkitTextStroke = p.outlineWidth + "px " + p.outlineColor;
    s.paintOrder = "stroke fill";
  }
  if (p.shadow) s.textShadow = `0 ${Math.round(p.shadowBlur / 2)}px ${p.shadowBlur}px rgba(0,0,0,.65)`;
}

// re-measure, then size the node to the rotated bounding box while keeping its centre where it was
function layoutNode(node, topLeft = false) {
  const v = node.__lc;
  if (!v) return;
  applyTextStyle(node);
  v.box.style.display = "block"; // a box that is display:none measures 0, which left a brand new label 8 x 8
  const w = Math.max(8, v.txt.offsetWidth);
  const h = Math.max(8, v.txt.offsetHeight);
  v.w = w;
  v.h = h;
  const a = (node.properties.angle * Math.PI) / 180;
  const W = Math.abs(w * Math.cos(a)) + Math.abs(h * Math.sin(a));
  const H = Math.abs(w * Math.sin(a)) + Math.abs(h * Math.cos(a));
  // the exact box size is kept in the properties: ComfyUI rounds a reloaded node's size up to its grid, and the saved
  // position is the top-left of the exact box, so that is what to measure from
  const pr = node.properties;
  const ow = Number.isFinite(pr._w) ? pr._w : node.size[0];
  const oh = Number.isFinite(pr._h) ? pr._h : node.size[1];
  if (topLeft) {
    node.size = [W, H]; // a brand new label: the top-left corner is where it was dropped
  } else if (Math.abs(W - ow) < 1.5 && Math.abs(H - oh) < 1.5) {
    node.size = [ow, oh]; // unchanged: leave the position alone so nothing drifts
  } else {
    const cx = node.pos[0] + ow / 2;
    const cy = node.pos[1] + oh / 2;
    node.size = [W, H];
    node.pos = [cx - W / 2, cy - H / 2];
  }
  pr._w = node.size[0];
  pr._h = node.size[1];
  v.key = "";
  v.box.style.display = "block";
  app.canvas?.setDirty?.(true, true);
}

function renderNode(node) {
  const v = node.__lc;
  if (!v) return;
  const c = app.canvas;
  if (!c || !node.graph || node.graph !== c.graph) {
    v.box.style.display = "none";
    return;
  }
  const ds = c.ds;
  const s = ds.scale;
  const cr = c.canvas.getBoundingClientRect();
  const lr = getLayer().getBoundingClientRect();
  const cx = (node.pos[0] + node.size[0] / 2 + ds.offset[0]) * s + (cr.left - lr.left);
  const cy = (node.pos[1] + node.size[1] / 2 + ds.offset[1]) * s + (cr.top - lr.top);
  const sel = isSelected(node) && !node.__lcDialog;
  const pinned = !!(node.flags && node.flags.pinned);
  vueClickThrough(node, pinned);
  const edit = sel && !pinned; // a pinned label is locked: frame only, no handles
  const key = [cx.toFixed(2), cy.toFixed(2), s.toFixed(4), node.properties.angle, v.w, v.h, sel, edit, v.badgeText || ""].join("|");
  if (key === v.key) return;
  v.key = key;
  v.box.style.display = "block";
  v.box.style.transform = `translate(${cx}px,${cy}px) rotate(${node.properties.angle}deg) scale(${s}) translate(${-v.w / 2}px,${-v.h / 2}px)`;
  const inv = 1 / s;
  v.frame.style.display = sel ? "block" : "none";
  v.frame.style.border = `${2 * inv}px dashed #6cf`;
  for (const k of v.corners) {
    k.el.style.display = edit ? "block" : "none";
    k.el.style.left = k.fx * v.w + "px";
    k.el.style.top = k.fy * v.h + "px";
    k.el.style.transform = `translate(-50%,-50%) scale(${inv})`;
  }
  for (const k of v.sides) {
    k.el.style.display = edit ? "block" : "none";
    k.el.style.left = k.fx * v.w + "px";
    k.el.style.top = k.fy * v.h + "px";
    k.el.style.transform = `translate(-50%,-50%) scale(${inv})`;
  }
  const off = 38 * inv;
  v.rot.style.display = edit ? "flex" : "none";
  v.rot.style.left = v.w / 2 + "px";
  v.rot.style.top = -off + "px";
  v.rot.style.transform = `translate(-50%,-50%) scale(${inv})`;
  v.stem.style.display = edit ? "block" : "none";
  v.stem.style.left = v.w / 2 - inv + "px";
  v.stem.style.top = -off + "px";
  v.stem.style.width = 2 * inv + "px";
  v.stem.style.height = off + "px";
  const showBadge = edit && v.badgeText;
  v.badge.style.display = showBadge ? "block" : "none";
  if (showBadge) {
    v.badge.textContent = v.badgeText;
    v.badge.style.left = v.w / 2 + 26 * inv + "px";
    v.badge.style.top = -off - 10 * inv + "px";
    v.badge.style.transformOrigin = "0 0";
    v.badge.style.transform = `scale(${inv}) rotate(${-node.properties.angle}deg)`;
  }
}

// ---- handles: rotate and scale ------------------------------------------------------------------------------
function wireHandles(node, v) {
  // rotate
  dragHandle(
    v.rot,
    () => {
      v.badgeText = Math.round(node.properties.angle) + "°";
    },
    (e) => {
      const [cx, cy] = screenCentre(node);
      const a = snapAngle((Math.atan2(e.clientY - cy, e.clientX - cx) * 180) / Math.PI + 90, e);
      node.properties.angle = a;
      v.badgeText = node.properties.angle + "°";
      layoutNode(node);
    },
    () => {
      v.badgeText = "";
      v.key = "";
      commit();
    }
  );

  // scale from a corner: the opposite corner stays where it is
  for (const k of v.corners) {
    dragHandle(
      k.el,
      () => {
        const ds = app.canvas.ds;
        const [cx, cy] = screenCentre(node);
        const a = (node.properties.angle * Math.PI) / 180;
        const rotv = (lx, ly) => [lx * Math.cos(a) - ly * Math.sin(a), lx * Math.sin(a) + ly * Math.cos(a)];
        const half = (fx, fy) => rotv((fx - 0.5) * v.w * ds.scale, (fy - 0.5) * v.h * ds.scale);
        const [dx, dy] = half(k.fx, k.fy);
        const [ax, ay] = half(1 - k.fx, 1 - k.fy);
        k.state = { size0: node.properties.size, width0: node.properties.width, anchor: [cx + ax, cy + ay], c0: [cx, cy], d0: Math.max(1, Math.hypot(dx - ax, dy - ay)) };
      },
      (e) => {
        const st = k.state;
        if (!st) return;
        const dm = Math.hypot(e.clientX - st.anchor[0], e.clientY - st.anchor[1]);
        const size = Math.min(800, Math.max(6, Math.round(st.size0 * (dm / st.d0))));
        const r = size / st.size0;
        node.properties.size = size;
        if (st.width0 > 0) node.properties.width = Math.max(20, Math.round(st.width0 * r));
        setCentreFromScreen(node, st.anchor[0] + r * (st.c0[0] - st.anchor[0]), st.anchor[1] + r * (st.c0[1] - st.anchor[1]));
        layoutNode(node);
      },
      () => {
        k.state = null;
        commit();
      }
    );
  }
}

// a side handle sets the wrap width: the opposite edge stays put and the text reflows, the top edge stays put too
function wireSideHandles(node, v) {
  for (const k of v.sides) {
    let st = null;
    dragHandle(
      k.el,
      () => {
        const ds = app.canvas.ds;
        const a = (node.properties.angle * Math.PI) / 180;
        const [cx, cy] = screenCentre(node);
        const u = [Math.cos(a), Math.sin(a)];
        const sign = k.fx === 1 ? 1 : -1; // which way from the anchor edge the handle points
        const halfW = (v.w * ds.scale) / 2;
        st = { h0: v.h, u, sign, anchor: [cx - sign * u[0] * halfW, cy - sign * u[1] * halfW], scale: ds.scale, a };
      },
      (e) => {
        if (!st) return;
        const proj = ((e.clientX - st.anchor[0]) * st.u[0] + (e.clientY - st.anchor[1]) * st.u[1]) * st.sign;
        const w = Math.max(24, Math.round(proj / st.scale));
        node.properties.width = w;
        const half = (w * st.scale) / 2;
        setCentreFromScreen(node, st.anchor[0] + st.sign * st.u[0] * half, st.anchor[1] + st.sign * st.u[1] * half);
        layoutNode(node);
        // reflowing changes the height: keep the top edge where it was
        const dh = v.h - st.h0;
        node.pos = [node.pos[0] - Math.sin(st.a) * (dh / 2), node.pos[1] + Math.cos(st.a) * (dh / 2)];
      },
      () => {
        st = null;
        commit();
      }
    );
  }
}

// ---- settings dialog (same look and behavior as LC Image Label) ------------------------------------------------
function showSettings(node) {
  if (node.__lcDialog) return;
  node.__lcDialog = true;
  const p = node.properties;
  const apply = () => layoutNode(node);

  const dialog = document.createElement("div");
  dialog.style.cssText =
    "position:fixed;background:#1a1a1a;border:2px solid #333;border-radius:8px;padding:20px;z-index:10000;width:400px;max-height:88vh;overflow-y:auto;color:#fff;font-family:Arial,sans-serif;font-size:13px;";
  const title = document.createElement("h3");
  title.textContent = "LC Label Settings ⚙️";
  title.style.cssText = "margin:0 0 15px 0;color:#fff;cursor:grab;user-select:none;padding-bottom:5px;border-bottom:1px solid #333;font-size:16px;";
  dialog.appendChild(title);

  let dragging = false, dx = 0, dy = 0;
  title.addEventListener("mousedown", (e) => {
    dragging = true;
    const r = dialog.getBoundingClientRect();
    dx = e.clientX - r.left;
    dy = e.clientY - r.top;
    e.preventDefault();
  });
  const onMove = (e) => {
    if (!dragging) return;
    dialog.style.left = Math.max(10, Math.min(window.innerWidth - dialog.offsetWidth - 10, e.clientX - dx)) + "px";
    dialog.style.top = Math.max(10, Math.min(window.innerHeight - 40, e.clientY - dy)) + "px";
  };
  const onUp = () => { dragging = false; };
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);

  const close = () => {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    document.removeEventListener("keydown", onKey);
    if (dialog.parentNode) dialog.parentNode.removeChild(dialog);
    node.__lcDialog = false;
    node.__lc && (node.__lc.key = "");
    commit();
  };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);

  const ipt = "background:#2a2a2a;color:#fff;border:1px solid #444;border-radius:4px;padding:6px;";
  const row = (label, ...controls) => {
    const r = document.createElement("div");
    r.style.cssText = "display:flex;align-items:center;gap:10px;margin-bottom:10px;position:relative;";
    const l = document.createElement("label");
    l.textContent = label;
    l.style.cssText = "min-width:82px;color:#ccc;";
    r.appendChild(l);
    for (const c of controls) r.appendChild(c);
    dialog.appendChild(r);
    return r;
  };
  const number = (key, min, max, step = 1, w = 70) => {
    const i = document.createElement("input");
    i.type = "number";
    i.min = min; i.max = max; i.step = step;
    i.value = p[key];
    i.style.cssText = ipt + `width:${w}px;`;
    i.addEventListener("input", () => {
      const n = parseFloat(i.value);
      if (Number.isFinite(n)) { p[key] = Math.min(max, Math.max(min, n)); apply(); }
    });
    return i;
  };
  const check = (key, cb) => {
    const c = document.createElement("input");
    c.type = "checkbox";
    c.checked = !!p[key];
    c.style.cssText = "width:18px;height:18px;";
    c.addEventListener("change", () => { p[key] = c.checked; apply(); cb?.(); });
    return c;
  };
  const toggleBtn = (label, key, extra = "") => {
    const b = document.createElement("button");
    b.textContent = label;
    const paint = () => (b.style.cssText = ipt + `width:34px;cursor:pointer;${extra}` + (p[key] ? "background:#324B4B;border-color:#5fa;" : ""));
    paint();
    b.addEventListener("click", () => { p[key] = !p[key]; paint(); apply(); });
    return b;
  };

  // text
  const ta = document.createElement("textarea");
  ta.value = p.text;
  ta.rows = 3;
  ta.style.cssText = ipt + "flex:1;resize:vertical;font-family:Arial,sans-serif;";
  ta.addEventListener("input", () => { p.text = ta.value; apply(); });
  row("Text", ta);

  // font dropdown: each entry drawn in its own typeface
  const fontBtn = document.createElement("button");
  const paintFont = () => {
    fontBtn.textContent = p.font + "  ▾";
    fontBtn.style.cssText = ipt + `flex:1;text-align:left;cursor:pointer;font-family:${fontCss(p.font)};font-size:15px;`;
  };
  paintFont();
  const fontList = document.createElement("div");
  fontList.style.cssText = "display:none;position:absolute;left:92px;right:0;top:36px;max-height:250px;overflow-y:auto;background:#232323;border:1px solid #666;border-radius:8px;z-index:5;box-shadow:0 8px 24px rgba(0,0,0,.6);";
  const addSection = (label, names) => {
    const h = document.createElement("div");
    h.textContent = label;
    h.style.cssText = "padding:4px 12px;font-size:11px;color:#8a9;letter-spacing:1px;background:#1a1a1a;";
    fontList.appendChild(h);
    for (const n of names) {
      const it = document.createElement("div");
      it.textContent = n;
      it.style.cssText = `padding:6px 12px;font-size:19px;cursor:pointer;font-family:${fontCss(n)};` + (n === p.font ? "background:#324b4b;" : "");
      it.addEventListener("mouseenter", () => (it.style.background = "#3a4a4a"));
      it.addEventListener("mouseleave", () => (it.style.background = n === p.font ? "#324b4b" : ""));
      it.addEventListener("click", () => {
        p.font = n;
        paintFont();
        fontList.style.display = "none";
        for (const c of fontList.children) if (c.dataset.f) c.style.background = c.dataset.f === n ? "#324b4b" : "";
        apply();
      });
      it.dataset.f = n;
      fontList.appendChild(it);
    }
  };
  addSection("BUNDLED", BUNDLED.map((f) => f.name));
  addSection("SYSTEM", SYSTEM);
  fontBtn.addEventListener("click", () => (fontList.style.display = fontList.style.display === "none" ? "block" : "none"));
  const fr = row("Font", fontBtn);
  fr.appendChild(fontList);

  // size, bold, italic
  const b = toggleBtn("B", "bold", "font-weight:bold;");
  const it = toggleBtn("I", "italic", "font-style:italic;");
  row("Size", number("size", 6, 800), b, it);
  const wIn = number("width", 0, 4000, 1, 70);
  const wAuto = document.createElement("button");
  wAuto.textContent = "Auto";
  wAuto.title = "Fit the box to the text";
  wAuto.style.cssText = ipt + "cursor:pointer;";
  wAuto.addEventListener("click", () => { p.width = 0; wIn.value = 0; apply(); });
  const wHint = document.createElement("span");
  wHint.textContent = "0 = auto";
  wHint.style.cssText = "color:#8a9;font-size:12px;";
  row("Wrap width", wIn, wAuto, wHint);

  // alignment
  const alignRow = document.createElement("div");
  alignRow.style.cssText = "display:flex;gap:6px;";
  const alignBtns = {};
  for (const [k, g] of [["left", "≡L"], ["center", "≡C"], ["right", "≡R"]]) {
    const ab = document.createElement("button");
    ab.textContent = g;
    ab.style.cssText = ipt + "cursor:pointer;width:44px;";
    ab.addEventListener("click", () => {
      p.align = k;
      for (const [kk, bb] of Object.entries(alignBtns)) bb.style.background = kk === k ? "#324B4B" : "#2a2a2a";
      apply();
    });
    alignBtns[k] = ab;
    alignRow.appendChild(ab);
  }
  alignBtns[p.align].style.background = "#324B4B";
  row("Align", alignRow);

  // colors
  const colorControl = (key) => {
    const wrap = document.createElement("div");
    wrap.style.cssText = "position:relative;display:flex;gap:8px;align-items:center;";
    const sw = document.createElement("button");
    const paint = () => (sw.style.cssText = `width:34px;height:30px;border-radius:6px;border:2px solid #777;cursor:pointer;background:${p[key]};`);
    paint();
    const hex = document.createElement("input");
    hex.type = "text";
    hex.value = p[key];
    hex.style.cssText = ipt + "width:88px;";
    const set = (c, remember) => {
      p[key] = c;
      hex.value = c;
      paint();
      apply();
      if (remember) pushRecent(c);
    };
    hex.addEventListener("input", () => { if (/^#[0-9a-fA-F]{6}$/.test(hex.value.trim())) set(hex.value.trim(), false); });
    hex.addEventListener("change", () => { if (/^#[0-9a-fA-F]{6}$/.test(hex.value.trim())) pushRecent(hex.value.trim()); });
    const pop = document.createElement("div");
    pop.style.cssText = "display:none;position:absolute;left:0;top:38px;width:290px;background:#232323;border:1px solid #666;border-radius:10px;padding:10px;z-index:6;box-shadow:0 8px 24px rgba(0,0,0,.6);";
    const grid = (label, colors) => {
      if (!colors.length) return;
      const h = document.createElement("div");
      h.textContent = label;
      h.style.cssText = "font-size:11px;color:#8a9;letter-spacing:1px;margin:6px 0 4px;";
      pop.appendChild(h);
      const g = document.createElement("div");
      g.style.cssText = "display:grid;grid-template-columns:repeat(8,1fr);gap:5px;";
      for (const c of colors) {
        const d = document.createElement("div");
        d.style.cssText = `height:26px;border-radius:5px;border:1px solid #0006;cursor:pointer;background:${c};`;
        d.addEventListener("click", () => { set(c, true); pop.style.display = "none"; });
        g.appendChild(d);
      }
      pop.appendChild(g);
    };
    const nat = document.createElement("input");
    nat.type = "color";
    nat.value = /^#[0-9a-f]{6}$/i.test(p[key]) ? p[key] : "#ffffff";
    nat.style.cssText = "width:34px;height:30px;padding:0;border:none;background:none;cursor:pointer;";
    nat.title = "System color picker (eyedropper)";
    nat.addEventListener("input", () => set(nat.value, false));
    nat.addEventListener("change", () => pushRecent(nat.value));
    sw.addEventListener("click", () => {
      if (pop.style.display === "none") {
        pop.textContent = "";
        grid("WORKFLOW COLORS", WORKFLOW_COLORS);
        grid("BASIC", BASIC_COLORS);
        grid("RECENT", recentColors());
        pop.style.display = "block";
      } else pop.style.display = "none";
    });
    wrap.append(sw, hex, nat, pop);
    return wrap;
  };
  row("Color", colorControl("color"));

  // outline, shadow, background
  const outRow = row("Outline", check("outline"), colorControl("outlineColor"), number("outlineWidth", 0, 40, 1, 56));
  row("Shadow", check("shadow"), (() => { const s = number("shadowBlur", 0, 60, 1, 56); s.title = "blur"; return s; })());
  const bgRow = row("Background", check("bg"), colorControl("bgColor"));
  row("Corners", number("radius", 0, 200), (() => { const l = document.createElement("span"); l.textContent = "padding"; l.style.color = "#ccc"; return l; })(), number("padding", 0, 100));

  // angle
  const ang = number("angle", -180, 180, 1, 70);
  const reset = document.createElement("button");
  reset.textContent = "Reset";
  reset.style.cssText = ipt + "cursor:pointer;";
  reset.addEventListener("click", () => { p.angle = 0; ang.value = 0; apply(); });
  row("Angle", ang, reset);
  const tip = document.createElement("div");
  tip.textContent = "Tip: drag the round handle above the label to rotate it. It snaps to 5° with a magnet at 0, 90 and 180 (Shift = 15°, Alt = free). Drag a corner to scale.";
  tip.style.cssText = "font-size:12px;color:#8a9;margin-bottom:6px;line-height:1.4;";
  dialog.appendChild(tip);

  const ok = document.createElement("button");
  ok.textContent = "OK";
  ok.style.cssText = "margin-top:8px;padding:8px 20px;background:#324B4B;color:#fff;border:none;border-radius:4px;cursor:pointer;width:100%;";
  ok.addEventListener("click", close);
  dialog.appendChild(ok);
  document.body.appendChild(dialog);
  void outRow; void bgRow;

  requestAnimationFrame(() => {
    const c = app.canvas;
    if (!c) return;
    const cr = c.canvas.getBoundingClientRect();
    const ds = c.ds;
    const right = cr.left + (node.pos[0] + node.size[0] + ds.offset[0]) * ds.scale;
    const left = cr.left + (node.pos[0] + ds.offset[0]) * ds.scale;
    const margin = 12;
    let x = right + margin;
    let y = Math.max(margin, cr.top + (node.pos[1] + ds.offset[1]) * ds.scale);
    if (x + dialog.offsetWidth > window.innerWidth - margin) x = left - dialog.offsetWidth - margin;
    if (x < margin) x = Math.max(margin, window.innerWidth / 2 - dialog.offsetWidth / 2);
    if (y + dialog.offsetHeight > window.innerHeight - margin) y = Math.max(margin, window.innerHeight - dialog.offsetHeight - margin);
    dialog.style.left = x + "px";
    dialog.style.top = y + "px";
  });
}

// ---- the node ----------------------------------------------------------------------------------------------
const lcLabelState = { down: null };

app.registerExtension({
  name: "LC123.Label",

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE) return;
    loadBundledFonts();

    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      onCreated?.apply(this, arguments);
      this.title = "";
      this.resizable = false;
      this.collapsable = false;
      this.flags = {};
      this.shape = LiteGraph.CUSTOM_SHAPE;
      this.color = "#fff0";
      this.bgcolor = "#fff0";
      this.shadow_color = "transparent";
      this.onDrawBackground = function () {};
      this.properties = Object.assign({}, DEFAULTS, this.properties || {});
      this.__lc = buildView(this);
      labelNodes.add(this);
      startLoop();
      layoutNode(this, true);
      requestAnimationFrame(() => layoutNode(this)); // once the label is really in the graph and the fonts are ready
    };

    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      const r = onConfigure?.apply(this, arguments);
      this.properties = Object.assign({}, DEFAULTS, this.properties || {});
      if (!this.__lc) {
        this.__lc = buildView(this);
        labelNodes.add(this);
        startLoop();
      }
      layoutNode(this);
      setTimeout(() => layoutNode(this), 400); // once late fonts have arrived
      return r;
    };

    const onRemoved = nodeType.prototype.onRemoved;
    nodeType.prototype.onRemoved = function () {
      onRemoved?.apply(this, arguments);
      labelNodes.delete(this);
      try { this.__lc?.box.remove(); } catch (_) {}
      this.__lc = null;
    };

    nodeType.prototype.onDblClick = function () {
      showSettings(this);
    };
    nodeType.prototype.getHelp = function () {
      return `<p>LC Label is a floating text label with no title and no sockets.</p>
      <p><strong>Double-click</strong> to open settings. Select it and drag the round handle to rotate (snaps to 5&deg;, magnet at 0, 90 and 180; Shift = 15&deg;, Alt = free), or a corner to scale.</p>`;
    };
    nodeType.title_mode = LiteGraph.NO_TITLE;
  },

  async setup() {
    // nothing is drawn on the canvas for a label: the HTML layer does it
    const oldDrawNode = LGraphCanvas.prototype.drawNode;
    LGraphCanvas.prototype.drawNode = function (node, ctx) {
      if (node.comfyClass === NODE || node.type === NODE) {
        node.color = "#fff0";
        node.bgcolor = "#fff0";
        node.shadow_color = "transparent";
        return;
      }
      return oldDrawNode.apply(this, arguments);
    };

    // a pinned label lets clicks through to the nodes under it (double-click still opens its settings)
    const oldGetNodeOnPos = LGraph.prototype.getNodeOnPos;
    LGraph.prototype.getNodeOnPos = function (x, y, nodes_list) {
      const e = lcLabelState.down;
      if (nodes_list && e && e.type.includes("down") && e.button === 0) {
        // a pinned label ignores left clicks entirely: they reach the node under it. Ctrl+drag a box to select it.
        nodes_list = [...nodes_list].filter((n) => !((n.comfyClass === NODE || n.type === NODE) && n.flags && n.flags.pinned));
      }
      return oldGetNodeOnPos.apply(this, [x, y, nodes_list]);
    };
    // double-click on a label's text opens its settings in classic and in Nodes 2.0 (where nodes are HTML and do not call onDblClick)
    document.addEventListener(
      "dblclick",
      (e) => {
        const c = app.canvas;
        if (!c || !labelNodes.size) return;
        if (e.target?.closest?.("input,textarea,button,select")) return;
        const [gx, gy, cr] = clientToGraph(e);
        if (e.clientX < cr.left || e.clientX > cr.right || e.clientY < cr.top || e.clientY > cr.bottom) return;
        let hit = null;
        for (const n of labelNodes) {
          if (!n.__lc || n.graph !== c.graph) continue;
          if (n.flags && n.flags.pinned) continue; // pinned = locked
          if (hitRotated(n, gx, gy, n.__lc.w, n.__lc.h, n.properties.angle)) hit = n;
        }
        if (hit) {
          e.preventDefault();
          e.stopPropagation();
          showSettings(hit);
        }
      },
      true
    );
    document.addEventListener("pointerdown", (e) => { lcLabelState.down = e; }, true);
    document.addEventListener("pointerup", () => { lcLabelState.down = null; }, true);
    document.addEventListener("pointercancel", () => { lcLabelState.down = null; }, true);
  },
});
