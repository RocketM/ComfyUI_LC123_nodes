// LC Slider - one small DOM face that looks and behaves the same in Nodes classic and Nodes 2.0.
// A thin track, a round knob and the value; nothing else on the node. Double-click the value to type one.
// min / max / step / decimals live in node.properties (the Properties Panel) and behind the faint gear,
// the right-click menu entry "Slider settings...", so the face stays a plain slider.
import { app } from "../../scripts/app.js";
import { lcApplyLaunchColor } from "./lc_color.js";

const NODE_NAMES = new Set(["LCSlider"]);
const HIDE = new Set(["value", "min", "max", "step", "decimals", "snap"]);
const DEFAULTS = { min: 0, max: 100, step: 1, decimals: 0 };
const FACE_H = 30;
const NODE_SIZE = [230, 86];

function findWidget(node, name) {
  return (node.widgets || []).find((w) => w && w.name === name);
}

function num(v, fb) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fb;
}

function snapValue(value, lo, hi, step) {
  if (lo > hi) [lo, hi] = [hi, lo];
  const st = step > 0 ? step : 1;
  let v = lo + Math.round((value - lo) / st) * st;
  v = Math.round(v * 1e10) / 1e10;
  if (v < lo) v = lo;
  if (v > hi) v = hi;
  return v;
}

function roundTo(v, decimals) {
  if (decimals <= 0) return Math.round(v);
  const rn = Math.pow(10, decimals);
  return Math.round(v * rn) / rn;
}

function formatByDecimals(v, decimals) {
  const d = Math.max(0, Math.min(4, Math.floor(Number(decimals) || 0)));
  return d <= 0 ? String(Math.round(Number(v))) : Number(v).toFixed(d);
}

function ensureProps(node) {
  node.properties = node.properties || {};
  for (const [k, v] of Object.entries(DEFAULTS)) {
    if (node.properties[k] === undefined || node.properties[k] === null) {
      const w = findWidget(node, k);
      node.properties[k] = w !== undefined && w.value !== undefined && w.value !== null ? w.value : v;
    }
  }
  if ("snap" in node.properties) delete node.properties.snap;
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

function readConfig(node) {
  ensureProps(node);
  let lo = num(node.properties.min, 0);
  let hi = num(node.properties.max, 100);
  if (lo > hi) [lo, hi] = [hi, lo];
  let st = num(node.properties.step, 1);
  if (!(st > 0)) st = 1;
  const decimals = Math.max(0, Math.min(4, Math.floor(num(node.properties.decimals, 0))));
  return { lo, hi, st, decimals };
}

// The hidden backend widgets are what execution reads, so they always mirror value + config.
function writeValueWidget(node, v) {
  const w = findWidget(node, "value");
  if (w) w.value = v;
  const { lo, hi, st, decimals } = readConfig(node);
  for (const [k, val] of Object.entries({ min: lo, max: hi, step: st, decimals })) {
    const cw = findWidget(node, k);
    if (cw) cw.value = val;
  }
}

function updateOutputType(node) {
  // Static any-type socket. Switching INT/FLOAT at runtime is unreliable in Nodes 2.0.
  const out = node.outputs?.[0];
  if (!out) return;
  out.type = "*";
  out.name = "*";
  out.localized_name = "*";
  out.label = "*";
}

function paintTrack(ui, v, lo, hi) {
  const span = hi - lo;
  const pct = span > 0 ? Math.max(0, Math.min(100, ((v - lo) / span) * 100)) : 0;
  ui.range.style.setProperty("--lc-p", pct + "%");
}

function applyFace(node) {
  const ui = node._lc123Face;
  if (!ui) return;
  const { lo, hi, st, decimals } = readConfig(node);
  let v = snapValue(num(findWidget(node, "value")?.value, lo), lo, hi, st);
  v = roundTo(v, decimals);
  writeValueWidget(node, v);
  ui.range.min = String(lo);
  ui.range.max = String(hi);
  ui.range.step = String(st);
  ui.range.value = String(v);
  ui.label.textContent = formatByDecimals(v, decimals);
  paintTrack(ui, v, lo, hi);
  updateOutputType(node);
}

function setFromFace(node, raw) {
  const { lo, hi, st, decimals } = readConfig(node);
  const v = roundTo(snapValue(num(raw, lo), lo, hi, st), decimals);
  writeValueWidget(node, v);
  const ui = node._lc123Face;
  if (ui) {
    ui.range.value = String(v);
    ui.label.textContent = formatByDecimals(v, decimals);
    paintTrack(ui, v, lo, hi);
  }
  updateOutputType(node);
  node.setDirtyCanvas?.(true, true);
  try {
    node.graph?.setisChangedFlag?.(node.id);
  } catch (_) {}
}

// ---- settings popup (min / max / step / decimals) ----

function openSettingsModal(node) {
  ensureProps(node);
  const p = node.properties;
  document.getElementById("lc123-slider-modal")?.remove();

  const overlay = document.createElement("div");
  overlay.id = "lc123-slider-modal";
  overlay.style.cssText =
    "position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,0.55);display:flex;align-items:center;justify-content:center;font-family:system-ui,sans-serif;";

  const panel = document.createElement("div");
  panel.style.cssText =
    "background:#1e1e1e;color:#eee;border:1px solid #444;border-radius:10px;padding:16px 18px;min-width:260px;max-width:90vw;box-shadow:0 12px 40px rgba(0,0,0,0.5);";

  const title = document.createElement("div");
  title.textContent = "Slider settings";
  title.style.cssText = "font-size:15px;font-weight:600;margin-bottom:10px;";
  panel.appendChild(title);

  const fields = [
    { key: "min", label: "Min" },
    { key: "max", label: "Max" },
    { key: "step", label: "Step" },
    { key: "decimals", label: "Decimals (0 = INT)" },
  ];
  const inputs = {};
  for (const f of fields) {
    const row = document.createElement("label");
    row.style.cssText =
      "display:flex;align-items:center;justify-content:space-between;gap:12px;margin:8px 0;font-size:13px;";
    const span = document.createElement("span");
    span.textContent = f.label;
    span.style.minWidth = "120px";
    const input = document.createElement("input");
    input.type = "number";
    input.step = f.key === "decimals" ? "1" : "any";
    input.value = String(p[f.key] ?? DEFAULTS[f.key]);
    input.style.cssText =
      "width:110px;padding:4px 8px;border-radius:6px;border:1px solid #555;background:#111;color:#eee;";
    row.appendChild(span);
    row.appendChild(input);
    panel.appendChild(row);
    inputs[f.key] = input;
  }

  const actions = document.createElement("div");
  actions.style.cssText = "display:flex;justify-content:flex-end;gap:8px;margin-top:12px;";
  const mkBtn = (text, css) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = text;
    b.style.cssText = "padding:6px 14px;border-radius:6px;cursor:pointer;" + css;
    return b;
  };
  const cancel = mkBtn("Cancel", "border:1px solid #555;background:#2a2a2a;color:#ddd;");
  const ok = mkBtn("Apply", "border:1px solid #567;background:#345;color:#fff;font-weight:600;");

  const onKey = (e) => {
    if (e.key === "Escape") close();
    else if (e.key === "Enter") ok.click();
  };
  const close = () => {
    overlay.remove();
    window.removeEventListener("keydown", onKey);
  };
  cancel.addEventListener("click", close);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  window.addEventListener("keydown", onKey);

  ok.addEventListener("click", () => {
    let min = num(inputs.min.value, p.min);
    let max = num(inputs.max.value, p.max);
    let step = num(inputs.step.value, p.step);
    let decimals = num(inputs.decimals.value, p.decimals);
    if (min > max) [min, max] = [max, min];
    if (!(step > 0)) step = 1;
    decimals = Math.max(0, Math.min(4, Math.floor(decimals)));
    Object.assign(node.properties, { min, max, step, decimals });
    applyFace(node);
    close();
  });

  actions.appendChild(cancel);
  actions.appendChild(ok);
  panel.appendChild(actions);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);
  inputs.min.focus();
  inputs.min.select();
}

// ---- the face ----

function ensureStyle() {
  if (document.getElementById("lc123-slider-style")) return;
  const st = document.createElement("style");
  st.id = "lc123-slider-style";
  st.textContent = `
.lc-sl{display:flex;align-items:center;gap:8px;width:100%;box-sizing:border-box;padding:0 6px;height:${FACE_H}px;color:#ddd;font:13px system-ui,sans-serif;user-select:none}
.lc-sl input[type=range]{--lc-p:0%;flex:1 1 auto;min-width:0;height:16px;margin:0;background:transparent;cursor:pointer;-webkit-appearance:none;appearance:none}
.lc-sl input[type=range]:focus{outline:none}
.lc-sl input[type=range]::-webkit-slider-runnable-track{height:3px;border-radius:2px;background:linear-gradient(to right,#cfcfcf var(--lc-p),#555 var(--lc-p))}
.lc-sl input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:13px;height:13px;margin-top:-5px;border-radius:50%;background:#fff;border:1px solid #00000066}
.lc-sl input[type=range]::-moz-range-track{height:3px;border-radius:2px;background:#555}
.lc-sl input[type=range]::-moz-range-progress{height:3px;border-radius:2px;background:#cfcfcf}
.lc-sl input[type=range]::-moz-range-thumb{width:11px;height:11px;border-radius:50%;background:#fff;border:1px solid #00000066}
.lc-sl .lc-val{flex:0 0 auto;min-width:34px;max-width:80px;text-align:right;font-variant-numeric:tabular-nums;cursor:text;padding:1px 2px;border-radius:3px}
.lc-sl .lc-val:hover{background:#ffffff14}
.lc-sl input.lc-edit{flex:0 0 auto;width:64px;font:inherit;text-align:right;color:#fff;background:#111;border:1px solid #666;border-radius:3px;padding:1px 3px}
.lc-sl .lc-gear{flex:0 0 auto;opacity:.25;cursor:pointer;font-size:12px;line-height:1;padding:2px}
.lc-sl:hover .lc-gear{opacity:.8}
`;
  document.head.appendChild(st);
}

function layoutFace(node) {
  const ui = node._lc123Face;
  if (!ui) return;
  // Classic LiteGraph pins a fixed pixel width on the DOM widget host; make it follow the node body.
  const w = Math.max(80, (node.size?.[0] || NODE_SIZE[0]) - 20);
  const host = ui.wrap.parentElement;
  if (host) {
    host.style.width = w + "px";
    host.style.maxWidth = w + "px";
    host.style.boxSizing = "border-box";
  }
}

function startEdit(node) {
  const ui = node._lc123Face;
  if (!ui || ui.editing) return;
  ui.editing = true;
  const input = document.createElement("input");
  input.type = "number";
  input.className = "lc-edit";
  input.step = "any";
  input.value = ui.label.textContent;
  ui.label.replaceWith(input);
  input.focus();
  input.select();
  const done = (commit) => {
    if (!ui.editing) return;
    ui.editing = false;
    input.replaceWith(ui.label);
    if (commit && input.value !== "") setFromFace(node, input.value);
  };
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") done(true);
    else if (e.key === "Escape") done(false);
  });
  input.addEventListener("blur", () => done(true));
}

function attachFace(node) {
  if (node._lc123FaceAttached) {
    applyFace(node);
    layoutFace(node);
    return;
  }
  node._lc123FaceAttached = true;
  ensureStyle();

  const wrap = document.createElement("div");
  wrap.className = "lc-sl";

  const range = document.createElement("input");
  range.type = "range";
  range.addEventListener("input", () => setFromFace(node, range.value));

  const label = document.createElement("div");
  label.className = "lc-val";
  label.title = "Double-click to type a value";
  label.addEventListener("dblclick", (e) => {
    e.stopPropagation();
    startEdit(node);
  });

  const gear = document.createElement("div");
  gear.className = "lc-gear";
  gear.textContent = "⚙";
  gear.title = "Slider settings (min, max, step, decimals)";
  gear.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    openSettingsModal(node);
  });

  wrap.append(range, label, gear);
  node._lc123Face = { range, label, wrap, editing: false };

  try {
    node._lc123DomWidget = node.addDOMWidget("lc123_face", "LC123_FACE", wrap, {
      getMinHeight: () => FACE_H,
      getHeight: () => FACE_H,
      serialize: false,
      afterResize: () => layoutFace(node),
    });
  } catch (e) {
    console.warn("LC Slider face widget failed", e);
  }

  const prevResize = node.onResize;
  node.onResize = function () {
    prevResize?.apply(this, arguments);
    layoutFace(this);
  };
  const prevDraw = node.onDrawForeground;
  node.onDrawForeground = function () {
    const r = prevDraw?.apply(this, arguments);
    if (!this.flags?.collapsed) layoutFace(this);
    return r;
  };

  applyFace(node);
  layoutFace(node);
  requestAnimationFrame(() => layoutFace(node));
}

// The frontend re-sizes nodes with hidden widgets while a workflow loads (a slider came back 160 tall instead of
// its saved 86). For the first moments after the node exists, put it back to the saved size, or to the compact
// default for a brand-new node. After that the user's own resizing is never touched.
function enforceSize(node) {
  if (performance.now() - (node._lc123Born || 0) > 900) return;
  const target = node._lc123Saved || [Math.max(node.size?.[0] || NODE_SIZE[0], 200), NODE_SIZE[1]];
  if (!node.size || Math.abs(node.size[1] - target[1]) > 1 || Math.abs(node.size[0] - target[0]) > 1) {
    try {
      node.setSize?.([target[0], target[1]]);
    } catch (_) {}
  }
}

function boot(node) {
  ensureProps(node);
  hideBackendWidgets(node);
  attachFace(node);
  applyFace(node);
  enforceSize(node);
}

app.registerExtension({
  name: "LC123.Slider",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (!NODE_NAMES.has(nodeData.name)) return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      onNodeCreated?.apply(this, arguments);
      lcApplyLaunchColor(this, "#28281E");
      this._lc123Born = performance.now();

      requestAnimationFrame(() => boot(this));
      setTimeout(() => boot(this), 0);
      setTimeout(() => boot(this), 150);
      setTimeout(() => boot(this), 450);
      setTimeout(() => boot(this), 850);

      const prevProp = this.onPropertyChanged;
      this.onPropertyChanged = function () {
        prevProp?.apply(this, arguments);
        applyFace(this);
      };

      const onConfigure = this.onConfigure;
      this.onConfigure = function (info) {
        this._lc123Saved = Array.isArray(info?.size) ? [info.size[0], info.size[1]] : null;
        this._lc123Born = performance.now();
        onConfigure?.apply(this, arguments);
        requestAnimationFrame(() => {
          for (const key of ["min", "max", "step", "decimals"]) {
            const w = findWidget(this, key);
            if (w !== undefined && w.value !== undefined && w.value !== null) this.properties[key] = w.value;
          }
          boot(this);
        });
      };

      const getExtra = this.getExtraMenuOptions;
      this.getExtraMenuOptions = function (_, options) {
        getExtra?.apply(this, arguments);
        options.push({ content: "🎚️ Slider settings…", callback: () => openSettingsModal(this) });
      };
    };
  },

  async nodeCreated(node) {
    if (!NODE_NAMES.has(node.comfyClass) && !NODE_NAMES.has(node.type)) return;
    requestAnimationFrame(() => boot(node));
  },
});
