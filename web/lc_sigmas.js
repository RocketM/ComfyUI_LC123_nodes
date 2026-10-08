// LC Sigmas (BETA): the schedule as a graph on the node. x = step, y = share of noise in the image (100% at the top).
// First pass orange, second pass blue; dashed behind: the chosen schedule before your curve edit (or the model's plain
// schedule). Drag a point to bend the schedule (edit_mode / smooth_radius); reset curve clears the edit, save curve
// keeps it as a "saved:" schedule. Updates live after the first run.
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE = "LCSigmas";
const GRAPH_MIN = 150, H = GRAPH_MIN; // graph height at the node's fitted size; drag the node taller and the graph grows with it
const LIVE = ["sampler", "sigma_curve_presets", "base_scheduler", "steps", "step_swap", "denoise", "denoise_steps", "low_pass",
  "scheduler_shape_2", "first_pass_resample", "sigma_shift", "custom_shift", "beta_alpha", "beta_beta", "flowmatch_shift",
  "flowmatch_dynamic", "flowmatch_terminal", "hyperbolic_function", "hyperbolic_scale", "gaussian_mean", "gaussian_std",
  "gaussian_operation", "curve_edit"];
// widgets that only matter for some settings: shown when the test passes
const SHOW = {
  base_scheduler: (v) => ["base", "hyperbolic", "gaussian"].includes(v.sigma_curve_presets),
  beta_alpha: (v) => v.sigma_curve_presets === "beta",
  beta_beta: (v) => v.sigma_curve_presets === "beta",
  flowmatch_shift: (v) => v.sigma_curve_presets === "flowmatch" && !v.flowmatch_dynamic,
  flowmatch_dynamic: (v) => v.sigma_curve_presets === "flowmatch",
  flowmatch_terminal: (v) => v.sigma_curve_presets === "flowmatch",
  hyperbolic_function: (v) => v.sigma_curve_presets === "hyperbolic",
  hyperbolic_scale: (v) => v.sigma_curve_presets === "hyperbolic",
  gaussian_mean: (v) => v.sigma_curve_presets === "gaussian",
  gaussian_std: (v) => v.sigma_curve_presets === "gaussian",
  gaussian_operation: (v) => v.sigma_curve_presets === "gaussian",
  custom_shift: (v) => v.sigma_shift === "custom",
  smooth_radius: (v) => v.edit_mode === "smooth",
  curve_edit: () => false,
};
const L = 34, R = 8, T = 8, B = 18;

const W = (node, name) => node.widgets?.find((x) => x.name === name);
const val = (node, name, d) => { const w = W(node, name); return w ? w.value : d; };

function lerp(vals, n) {
  if (!vals || vals.length < 2) return new Array(n + 1).fill(vals?.[0] || 0);
  const out = [];
  for (let i = 0; i <= n; i++) {
    const pos = ((vals.length - 1) * i) / Math.max(n, 1);
    const j = Math.min(Math.floor(pos), vals.length - 2), f = pos - j;
    out.push(vals[j] * (1 - f) + vals[j + 1] * f);
  }
  return out;
}

function edits(node) {
  try { const v = JSON.parse(val(node, "curve_edit", "") || "[]"); return Array.isArray(v) ? v.map(Number) : []; } catch (e) { return []; }
}

// the schedule with the edit on it, the way the server builds it: clamped, downhill, last point untouched
function editedCurve(base, offs) {
  const GAP = 1e-4, n = base.length - 1, o = lerp(offs.length >= 2 ? offs : [0, 0], n), out = [];
  let prev = 1 + GAP;
  for (let i = 0; i <= n; i++) {
    const v = i === n ? base[n] : Math.max(Math.min(base[i] + o[i], 1, prev - GAP), base[n] + (n - i) * GAP);
    out.push(v); prev = v;
  }
  return out;
}

function draw(node) {
  const ui = node._lcSig;
  if (!ui) return;
  const cv = ui.canvas, dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth || 300, Hh = Math.max(GRAPH_MIN, cv.clientHeight || GRAPH_MIN);
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(Hh * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(Hh * dpr); }
  const ctx = cv.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, Hh);
  const gw = w - L - R, gh = Hh - T - B;
  ctx.fillStyle = "#15181c";
  ctx.fillRect(L, T, gw, gh);
  ctx.font = "10px sans-serif";
  ctx.fillStyle = "#8a95a5";
  ctx.textAlign = "right";
  for (const v of [0, 0.5, 1]) {
    const y = T + gh - v * gh;
    ctx.fillText(`${v * 100}%`, L - 4, y + 3);
    ctx.strokeStyle = "rgba(255,255,255,0.06)";
    ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(L + gw, y); ctx.stroke();
  }
  const g = node._lcSigGraph;
  if (!g || g.error) {
    setText(node, g?.error === "run once" || !g ? "Run once to see the schedule (then it updates live and you can drag it)." : g.error, "");
    return;
  }
  const n = Math.max(1, g.n);
  const X = (i) => L + (i / n) * gw, Y = (f) => T + gh - f * gh;
  const line = (pts, xs, color, dash, dots, r = 2.2) => {
    if (!pts.length) return;
    ctx.setLineDash(dash || []);
    ctx.strokeStyle = color;
    ctx.lineWidth = dash ? 1 : 2;
    ctx.beginPath();
    pts.forEach((f, i) => (i ? ctx.lineTo(X(xs(i)), Y(f)) : ctx.moveTo(X(xs(i)), Y(f))));
    ctx.stroke();
    ctx.setLineDash([]);
    if (dots) { ctx.fillStyle = color; pts.forEach((f, i) => { ctx.beginPath(); ctx.arc(X(xs(i)), Y(f), r, 0, 7); ctx.fill(); }); }
  };
  const upright = (i, f0, f1, color, label) => {
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(X(i), Y(f0)); ctx.lineTo(X(i), Y(f1)); ctx.stroke();
    ctx.setLineDash([]);
    if (label) { ctx.fillStyle = color; ctx.textAlign = "left"; ctx.fillText(label, X(i) + 4, Y((f0 + f1) / 2) + 3); }
  };
  const step = (x0) => (i) => x0 + i;
  line(g.edited ? g.base || [] : g.ghost || [], step(0), "rgba(200,200,200,0.35)", [4, 3], false);
  const hx = g.hx && g.hx.length === g.high.length ? (i) => g.hx[i] : step(0);
  if (ui.drag) {
    line(ui.drag.curve, step(0), "#8fd4c4", null, true, 2.6); // the curve under your mouse, before the server redraws it
  } else {
    line(g.high, hx, "#f0a050", null, true);
    if (g.low.length) {
      if (g.finish && g.high.length) upright(g.k, g.high[g.high.length - 1], 0, "rgba(240,160,80,0.6)", "");
      if (g.low_mode === "renoise") upright(g.k, 0, g.low[0], "#60a5fa", "renoise");
      line(g.low, step(g.k), "#60a5fa", null, true);
    }
  }
  if (g.low.length) {
    ctx.strokeStyle = "rgba(255,255,255,0.25)";
    ctx.setLineDash([2, 3]);
    ctx.beginPath(); ctx.moveTo(X(g.k), T); ctx.lineTo(X(g.k), T + gh); ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.textAlign = "center";
  ctx.fillStyle = "#8a95a5";
  ctx.fillText("0", X(0), T + gh + 11);
  ctx.fillText(String(n), X(n), T + gh + 11);
  if (g.low.length) ctx.fillText(`swap ${g.k}`, X(g.k), T + gh + 11);
  setText(node, g.info || "", g.tip || "");
}

// ---------------------------------------------------------------- dragging the curve
function local(cv, e) {
  const r = cv.getBoundingClientRect(); // the canvas can be scaled by the graph zoom
  return [((e.clientX - r.left) * cv.clientWidth) / Math.max(1, r.width), ((e.clientY - r.top) * cv.clientHeight) / Math.max(1, r.height)];
}

function dragTo(node, e) {
  const ui = node._lcSig, g = node._lcSigGraph, d = ui.drag;
  const cv = ui.canvas, [, y] = local(cv, e);
  const gh = Math.max(GRAPH_MIN, cv.clientHeight) - T - B;
  const target = Math.min(1, Math.max(0, 1 - (y - T) / gh));
  const base = g.base, n = base.length - 1, k = d.k;
  const vals = d.start.slice();
  const radius = Number(val(node, "smooth_radius", 1.5)) || 0;
  if (val(node, "edit_mode", "smooth") === "spike" || radius <= 0) vals[k] = target;
  else for (let i = 0; i < vals.length; i++) { const t = (i - k) / radius, wgt = Math.exp(-0.5 * t * t); vals[i] = (1 - wgt) * vals[i] + wgt * target; }
  d.curve = editedCurve(base, vals.map((v, i) => v - base[i]));
  d.curve[n] = base[n];
  draw(node);
}

function startDrag(node, e) {
  const ui = node._lcSig, g = node._lcSigGraph;
  if (!g || g.error || !g.base || g.base.length < 2 || e.button !== 0) return;
  const cv = ui.canvas, [x, y] = local(cv, e);
  const gw = cv.clientWidth - L - R, gh = Math.max(GRAPH_MIN, cv.clientHeight) - T - B;
  if (x < L - 6 || x > L + gw + 6 || y < T - 6 || y > T + gh + 6) return;
  const n = g.base.length - 1;
  const k = Math.max(0, Math.min(n - 1, Math.round(((x - L) / gw) * n))); // the last point stays at 0
  e.preventDefault(); e.stopPropagation();
  cv.setPointerCapture?.(e.pointerId);
  const start = editedCurve(g.base, edits(node));
  ui.drag = { k, start, curve: start };
  dragTo(node, e);
}

function endDrag(node) {
  const ui = node._lcSig, g = node._lcSigGraph, d = ui?.drag;
  if (!d) return;
  ui.drag = null;
  const offs = d.curve.map((v, i) => Math.round((v - g.base[i]) * 10000) / 10000);
  const w = W(node, "curve_edit");
  if (w) { w.value = offs.some((o) => Math.abs(o) > 1e-6) ? JSON.stringify(offs) : ""; w.callback?.(w.value); }
  node.setDirtyCanvas?.(true, true);
}

function resetCurve(node) {
  const w = W(node, "curve_edit");
  if (w) { w.value = ""; w.callback?.(""); }
}

async function saveCurve(node) {
  const g = node._lcSigGraph;
  if (!g?.base) { alert("Run once first, so the node knows the model's schedule."); return; }
  const name = prompt("Name for this curve (it shows up under sigma_curve_presets as saved: name):", "");
  if (!name) return;
  const values = editedCurve(g.base, edits(node));
  try {
    const r = await api.fetchApi("/lc123/sigmas/save", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, values, source: g.info || "LC Sigmas" }) });
    const res = await r.json();
    if (res.error) { alert(res.error); return; }
    const sch = W(node, "sigma_curve_presets");
    if (sch) {
      const list = sch.options.values;
      if (!list.includes(res.name)) list.push(res.name);
      sch.value = res.name; // the saved curve has the edit baked in
    }
    resetCurve(node);
    sch?.callback?.(sch.value);
  } catch (e) { alert(String(e)); }
}

// ---------------------------------------------------------------- layout
function setText(node, info, tip) {
  const ui = node._lcSig;
  ui.text.textContent = info;
  ui.tip.textContent = tip;
  ui.tip.title = tip; // full text on hover
  ui.text.style.display = info ? "" : "none";
  ui.tip.style.display = tip ? "" : "none";
  fit(node);
}

function faceHeight(node) {
  const ui = node._lcSig;
  if (!ui) return H;
  const vis = (el) => (el.style.display === "none" ? 0 : el.offsetHeight || 16);
  return H + vis(ui.text) + vis(ui.tip) + 4;
}

function fit(node) {
  requestAnimationFrame(() => {
    // grows when the content needs room; shrinks when widgets hide, but never below a height you dragged it to
    const need = node.computeSize?.()?.[1];
    if (!need) return;
    if (node.size[1] < need - 1) node.setSize([Math.max(node.size[0], 320), need]);
    node.setDirtyCanvas?.(true, true);
  });
}

// widgets that do not apply right now are hidden the frontend's way, so the ones below close up
function syncVisible(node) {
  const v = {};
  for (const w of node.widgets || []) v[w.name] = w.value;
  // a wired input shows what the last run received, not its stale widget
  const ran = node._lcSigGraph?.ran;
  if (ran) for (const i of node.inputs || []) if (i.widget && i.link != null && i.widget.name in ran) v[i.widget.name] = ran[i.widget.name];
  for (const [name, test] of Object.entries(SHOW)) {
    const w = W(node, name);
    if (!w) continue;
    if (!w._lcOrig) w._lcOrig = { type: w.type, computeSize: w.computeSize };
    const show = test(v);
    w.hidden = !show;
    w.type = show ? w._lcOrig.type : "hidden";
    w.computeSize = show ? w._lcOrig.computeSize : () => [0, -4];
  }
  const shrink = node.computeSize?.()?.[1];
  if (shrink && !node._lcUserTall && Math.abs(node.size[1] - shrink) > 1) node.setSize([node.size[0], shrink]);
  fit(node);
}

// A reloaded node (refresh, tab switch) forgets that it was dragged taller, so the widget show / hide above would
// shrink it back to the fitted height. Take the size from the saved workflow: taller than fitted = the user's size.
// Put back once now and again after the graph and the frontend's own fit have settled.
function restoreSize(node, saved) {
  const apply = () => {
    const need = node.computeSize?.()?.[1] || 0;
    node._lcUserTall = saved[1] > need + 2;
    const h = Math.max(saved[1], need);
    const w = Math.max(saved[0], 320);
    if (Math.abs(node.size[0] - w) > 1 || Math.abs(node.size[1] - h) > 1) node.setSize([w, h]);
    node.setDirtyCanvas?.(true, true);
  };
  apply();
  for (const ms of [0, 150, 450, 900]) setTimeout(apply, ms);
}

async function refresh(node) {
  const body = { node: String(node.id) };
  for (const k of LIVE) body[k] = W(node, k)?.value;
  // wired inputs: their widgets keep a stale value, so the server uses what the last run received
  body.linked = (node.inputs || []).filter((i) => i.widget && i.link != null).map((i) => i.widget.name);
  const seq = (node._lcSigSeq = (node._lcSigSeq || 0) + 1);
  try {
    const r = await api.fetchApi("/lc123/sigmas/preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const g = await r.json();
    if (seq === node._lcSigSeq) { node._lcSigGraph = g; draw(node); syncVisible(node); }
  } catch (e) { /* keep the last graph */ }
}

// Older saves load onto the new widgets by name.
const OLD_PRESETS = ["auto (from model)", "Krea 2", "Z-Image", "Flux 2", "SDXL / Illustrious / Pony", "manual", "recommended"];
const OLD_SHIFT = { model: "use model default", "auto (image size)": "by image size", custom: "custom" };
function migrate(node, wv) {
  if (!Array.isArray(wv)) return;
  const set = (name, v) => { const w = W(node, name); if (w && v !== undefined) w.value = v; };
  // the frontend has already dropped the old values onto the new widgets by position: put every widget back to its
  // default first, then map the old values by name
  const defaults = () => { for (const [k, v] of Object.entries(node._lcDefaults || {})) set(k, v); };
  if (wv.length >= 13 && OLD_PRESETS.includes(wv[0])) {
    defaults();
    // first beta: preset, steps, handoff, shape, sampler, focus, shift, shift_value, denoise, i2i_steps, shape_2, renoise, seed, (control)
    set("sampler", wv[4] === "recommended" ? "euler" : wv[4]);
    set("sigma_curve_presets", "base"); set("base_scheduler", wv[3]);
    set("steps", wv[1]); set("step_swap", wv[2]); set("denoise", wv[8]); set("denoise_steps", "full schedule");
    set("low_pass", Number(wv[11]) > 0 ? "renoise" : "continue noise schedule");
    set("scheduler_shape_2", wv[10] === "same as high" ? "same as first" : wv[10]);
    set("sigma_shift", OLD_SHIFT[wv[6]] || "use model default"); set("custom_shift", wv[7]);
    set("seed", wv[12]); if (wv.length > 13) set("control_after_generate", wv[13]);
  } else if (wv.length >= 11 && wv.length <= 13 && ["full schedule", "at step swap"].includes(wv[5])) {
    defaults();
    // 1.47.0: sampler, scheduler_shape, steps, step_swap, denoise, denoise_steps, low_pass, shape_2, sigma_shift, custom_shift, seed, (control)
    set("sampler", wv[0]); set("sigma_curve_presets", "base"); set("base_scheduler", wv[1]);
    set("steps", wv[2]); set("step_swap", wv[3]); set("denoise", wv[4]); set("denoise_steps", wv[5]); set("low_pass", wv[6]);
    set("scheduler_shape_2", wv[7]); set("sigma_shift", wv[8]); set("custom_shift", wv[9]); set("seed", wv[10]);
    if (wv.length > 11) set("control_after_generate", wv[11]);
    set("first_pass_resample", 1.0); set("curve_edit", "");
  }
}

// Before 1.48 the scheduler socket was scheduler_shape. The frontend drops a wire into a socket name that no longer
// exists, so note where it came from now and plug it into base_scheduler once the graph has settled.
function rewire(node, data) {
  const old = data?.inputs?.find((i) => i.name === "scheduler_shape" && i.link != null);
  const g = node.graph;
  if (!old || !g) return;
  const link = g.links?.get ? g.links.get(old.link) : g.links?.[old.link];
  if (!link) return;
  const from = { id: link.origin_id, slot: link.origin_slot };
  setTimeout(() => {
    const slot = node.inputs?.findIndex((i) => i.name === "base_scheduler");
    const src = g.getNodeById(from.id);
    if (slot < 0 || !src || node.inputs[slot].link != null) return;
    src.connect(from.slot, node, slot);
  }, 0);
}

function setup(node) {
  if (node._lcSig) return;
  node._lcDefaults = {};
  for (const w of node.widgets || []) if (w.serialize !== false && w.type !== "button") node._lcDefaults[w.name] = w.value;
  for (const [label, fn] of [["reset curve", resetCurve], ["save curve", saveCurve]]) {
    const b = node.addWidget("button", label, null, () => fn(node));
    b.serialize = false; // buttons are not settings: keep them out of the saved values
  }
  const wrap = document.createElement("div");
  wrap.style.cssText = "width:100%;height:100%;display:flex;flex-direction:column";
  const canvas = document.createElement("canvas");
  canvas.style.cssText = `width:100%;flex:1 1 auto;min-height:${H}px;height:${H}px;display:block;cursor:crosshair;touch-action:none`;
  const text = document.createElement("div");
  text.style.cssText = "max-height:30px;overflow:hidden;font:11px sans-serif;color:#dfe5ec;padding:2px 4px 0;line-height:15px";
  const tip = document.createElement("div");
  tip.style.cssText = "height:16px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font:11px sans-serif;color:#9fd0a0;padding:0 4px";
  wrap.append(canvas, text, tip);
  node.addDOMWidget("lc_sigmas_graph", "LC_SIGMAS_GRAPH", wrap, { serialize: false, getMinHeight: () => faceHeight(node), getMaxHeight: () => 4000 });  // drag the node taller: the graph gets the room
  node._lcSig = { canvas, text, tip, drag: null };
  canvas.addEventListener("pointerdown", (e) => startDrag(node, e));
  canvas.addEventListener("pointermove", (e) => { if (node._lcSig.drag) { e.preventDefault(); e.stopPropagation(); dragTo(node, e); } });
  const up = (e) => { if (node._lcSig.drag) { e.stopPropagation(); canvas.releasePointerCapture?.(e.pointerId); endDrag(node); } };
  canvas.addEventListener("pointerup", up);
  canvas.addEventListener("pointercancel", up);
  let t = 0;
  for (const w of node.widgets) {
    if (!LIVE.includes(w.name) && !SHOW[w.name] && w.name !== "edit_mode") continue;
    const prev = w.callback;
    w.callback = function (...a) {
      const r = prev?.apply(this, a);
      syncVisible(node);
      if (LIVE.includes(w.name)) { clearTimeout(t); t = setTimeout(() => refresh(node), 120); }
      return r;
    };
  }
  new ResizeObserver(() => draw(node)).observe(canvas);
  syncVisible(node);
  if (node.size[0] < 320) node.setSize([320, node.size[1]]);
  requestAnimationFrame(() => {
    draw(node);
    refresh(node); // the server remembers the model from an earlier run: show the graph straight away
  });
}

app.registerExtension({
  name: "LC123.Sigmas",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE) return;
    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onCreated?.apply(this, arguments);
      this.color = "#643264"; this.bgcolor = "#643264";
      setup(this);
      return r;
    };
    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (data) {
      // the saved size, read from the workflow before anything here (or the frontend's auto-fit) moves it
      const saved = Array.isArray(data?.size) ? [Number(data.size[0]), Number(data.size[1])] : null;
      const r = onConfigure?.apply(this, arguments);
      migrate(this, data?.widgets_values);
      rewire(this, data);
      syncVisible(this);
      if (saved && saved[0] > 0 && saved[1] > 0) restoreSize(this, saved);
      setTimeout(() => refresh(this), 50); // now the saved id and the wires are in place: ask for the graph again
      return r;
    };
    const onResize = nodeType.prototype.onResize;
    nodeType.prototype.onResize = function (size) {
      const r = onResize?.apply(this, arguments);
      const need = this.computeSize?.()?.[1];
      this._lcUserTall = !!(need && size?.[1] > need + 2); // dragged taller by hand: keep that height
      return r;
    };
    const onExecuted = nodeType.prototype.onExecuted;
    nodeType.prototype.onExecuted = function (msg) {
      onExecuted?.apply(this, arguments);
      try { this._lcSigGraph = JSON.parse(msg?.lc_sigmas?.[0] || "null"); this._lcSigRan = true; } catch (e) { /* ignore */ }
      draw(this);
      syncVisible(this);
    };
  },
});
