// LC Sigmas (BETA): the schedule as a graph on the node. x = step, y = share of noise in the image (100% at the top).
// High pass orange, low pass blue, the model's plain schedule dashed behind. Updates live after the first run.
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE = "LCSigmas";
const H = 150; // graph
let PRESETS = null; // name -> {sampler, shape}, from the server
const MANUAL_TRIGGERS = ["shape", "sampler"];
const LIVE = ["preset", "sampler", "steps", "handoff", "shape", "focus", "shift", "shift_value", "denoise", "i2i_steps", "shape_2", "renoise"];

function draw(node) {
  const ui = node._lcSig;
  if (!ui) return;
  const cv = ui.canvas, dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth || 300;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(H * dpr); }
  const ctx = cv.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, H);
  const L = 34, R = 8, T = 8, B = 18, gw = w - L - R, gh = H - T - B;
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
    setText(node, g?.error === "run once" || !g ? "Run once to see the schedule (then it updates live)." : g.error, "");
    return;
  }
  const n = Math.max(1, g.n);
  const X = (i) => L + (i / n) * gw, Y = (f) => T + gh - f * gh;
  const line = (pts, x0, color, dash, dots) => {
    if (!pts.length) return;
    ctx.setLineDash(dash || []);
    ctx.strokeStyle = color;
    ctx.lineWidth = dash ? 1 : 2;
    ctx.beginPath();
    pts.forEach((f, i) => (i ? ctx.lineTo(X(x0 + i), Y(f)) : ctx.moveTo(X(x0 + i), Y(f))));
    ctx.stroke();
    ctx.setLineDash([]);
    if (dots) { ctx.fillStyle = color; pts.forEach((f, i) => { ctx.beginPath(); ctx.arc(X(x0 + i), Y(f), 2.2, 0, 7); ctx.fill(); }); }
  };
  line(g.ghost || [], 0, "rgba(200,200,200,0.35)", [4, 3], false);
  line(g.high, 0, "#f0a050", null, true);
  if (g.low.length) {
    line(g.low, g.k, "#60a5fa", null, true);
    ctx.strokeStyle = "rgba(255,255,255,0.25)";
    ctx.setLineDash([2, 3]);
    ctx.beginPath(); ctx.moveTo(X(g.k), T); ctx.lineTo(X(g.k), T + gh); ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.textAlign = "center";
  ctx.fillStyle = "#8a95a5";
  ctx.fillText("0", X(0), T + gh + 11);
  ctx.fillText(String(n), X(n), T + gh + 11);
  if (g.low.length) ctx.fillText(`handoff ${g.k}`, X(g.k), T + gh + 11);
  setText(node, g.info || "", g.tip || "");
}

// Show what the preset picked in the widgets themselves (set directly, so it does not count as a manual change).
function applyUsed(node, used) {
  if (!used) return;
  const preset = node.widgets.find((x) => x.name === "preset");
  if (preset && preset.value === "manual") return;
  for (const k of ["sampler", "shape"]) {
    const w = node.widgets.find((x) => x.name === k);
    if (w && used[k] && w.value !== used[k]) w.value = used[k];
  }
  node.setDirtyCanvas?.(true, true);
}

async function presetTable() {
  if (!PRESETS) {
    try { PRESETS = await (await api.fetchApi("/lc123/sigmas/presets")).json(); } catch (e) { PRESETS = {}; }
  }
  return PRESETS;
}

// The lines under the graph take only the room they need, and the node follows its content both ways
// (grows for a two-line info, shrinks back when it is shorter or empty).
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
    const need = node.computeSize?.()?.[1];
    if (need && Math.abs(node.size[1] - need) > 1) node.setSize([Math.max(node.size[0], 320), need]);
    node.setDirtyCanvas?.(true, true);
  });
}

async function refresh(node) {
  const body = { node: String(node.id) };
  for (const k of LIVE) body[k] = node.widgets.find((w) => w.name === k)?.value;
  const seq = (node._lcSigSeq = (node._lcSigSeq || 0) + 1);
  try {
    const r = await api.fetchApi("/lc123/sigmas/preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const g = await r.json();
    if (seq === node._lcSigSeq) { node._lcSigGraph = g; applyUsed(node, g.used); draw(node); }
  } catch (e) { /* keep the last graph */ }
}

function setup(node) {
  if (node._lcSig) return;
  const wrap = document.createElement("div");
  wrap.style.cssText = "width:100%";
  const canvas = document.createElement("canvas");
  canvas.style.cssText = `width:100%;height:${H}px;display:block`;
  const text = document.createElement("div");
  text.style.cssText = "max-height:30px;overflow:hidden;font:11px sans-serif;color:#dfe5ec;padding:2px 4px 0;line-height:15px";
  const tip = document.createElement("div");
  tip.style.cssText = "height:16px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font:11px sans-serif;color:#9fd0a0;padding:0 4px";
  wrap.append(canvas, text, tip);
  node.addDOMWidget("lc_sigmas_graph", "LC_SIGMAS_GRAPH", wrap, { serialize: false, getMinHeight: () => faceHeight(node), getMaxHeight: () => faceHeight(node) });
  node._lcSig = { canvas, text, tip };
  let t = 0;
  for (const k of LIVE) {
    const w = node.widgets.find((x) => x.name === k);
    if (!w) continue;
    const prev = w.callback;
    w.callback = function (...a) {
      const r = prev?.apply(this, a);
      const p = node.widgets.find((x) => x.name === "preset");
      // picking a shape or sampler by hand means you want it: the preset becomes manual
      if (MANUAL_TRIGGERS.includes(k) && p && p.value !== "manual") p.value = "manual";
      // a family preset fills in its sampler and shape right away
      if (k === "preset") presetTable().then((tbl) => { if (tbl[w.value]) applyUsed(node, tbl[w.value]); });
      clearTimeout(t); t = setTimeout(() => refresh(node), 120); return r;
    };
  }
  new ResizeObserver(() => draw(node)).observe(canvas);
  // the first beta saved "recommended": show it as auto / euler
  const p0 = node.widgets.find((x) => x.name === "preset"), s0 = node.widgets.find((x) => x.name === "sampler");
  if (p0 && p0.value === "recommended") p0.value = "auto (from model)";
  if (s0 && s0.value === "recommended") s0.value = "euler";
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
    const onExecuted = nodeType.prototype.onExecuted;
    nodeType.prototype.onExecuted = function (msg) {
      onExecuted?.apply(this, arguments);
      try { this._lcSigGraph = JSON.parse(msg?.lc_sigmas?.[0] || "null"); this._lcSigRan = true; } catch (e) { /* ignore */ }
      applyUsed(this, this._lcSigGraph?.used);
      draw(this);
    };
  },
});
