// LC Sigmas (BETA): the schedule as a graph on the node. x = step, y = share of noise in the image (100% at the top).
// First pass orange, second pass blue, the model's plain schedule dashed behind. A dashed upright shows the noise going
// back in when the second pass renoises. Updates live after the first run.
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE = "LCSigmas";
const GRAPH_MIN = 150, H = GRAPH_MIN; // graph height at the node's fitted size; drag the node taller and the graph grows with it
const LIVE = ["sampler", "scheduler_shape", "steps", "step_swap", "denoise", "denoise_steps", "low_pass",
  "scheduler_shape_2", "sigma_shift", "custom_shift"];

function draw(node) {
  const ui = node._lcSig;
  if (!ui) return;
  const cv = ui.canvas, dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth || 300, H = Math.max(GRAPH_MIN, cv.clientHeight || GRAPH_MIN);
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
  const upright = (i, f0, f1, color, label) => {
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(X(i), Y(f0)); ctx.lineTo(X(i), Y(f1)); ctx.stroke();
    ctx.setLineDash([]);
    if (label) { ctx.fillStyle = color; ctx.textAlign = "left"; ctx.fillText(label, X(i) + 4, Y((f0 + f1) / 2) + 3); }
  };
  line(g.ghost || [], 0, "rgba(200,200,200,0.35)", [4, 3], false);
  line(g.high, 0, "#f0a050", null, true);
  if (g.low.length) {
    if (g.finish && g.high.length) upright(g.k, g.high[g.high.length - 1], 0, "rgba(240,160,80,0.6)", "");
    if (g.low_mode === "renoise") upright(g.k, 0, g.low[0], "#60a5fa", "renoise");
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
  if (g.low.length) ctx.fillText(`swap ${g.k}`, X(g.k), T + gh + 11);
  setText(node, g.info || "", g.tip || "");
}

// The lines under the graph take only the room they need.
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
    // grows when the content needs room; never shrinks a node you dragged taller (that room goes to the graph)
    const need = node.computeSize?.()?.[1];
    if (need && node.size[1] < need - 1) node.setSize([Math.max(node.size[0], 320), need]);
    node.setDirtyCanvas?.(true, true);
  });
}

// custom_shift only shows when sigma_shift is custom. Hidden the frontend's way, so the widgets below close up.
function syncCustomShift(node) {
  const mode = node.widgets?.find((x) => x.name === "sigma_shift");
  const cs = node.widgets?.find((x) => x.name === "custom_shift");
  if (!mode || !cs) return;
  if (!cs._lcOrig) cs._lcOrig = { type: cs.type, computeSize: cs.computeSize };
  const show = mode.value === "custom";
  cs.hidden = !show;
  cs.type = show ? cs._lcOrig.type : "hidden";
  cs.computeSize = show ? cs._lcOrig.computeSize : () => [0, -4];
  fit(node);
}

async function refresh(node) {
  const body = { node: String(node.id) };
  for (const k of LIVE) body[k] = node.widgets.find((w) => w.name === k)?.value;
  const seq = (node._lcSigSeq = (node._lcSigSeq || 0) + 1);
  try {
    const r = await api.fetchApi("/lc123/sigmas/preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const g = await r.json();
    if (seq === node._lcSigSeq) { node._lcSigGraph = g; draw(node); }
  } catch (e) { /* keep the last graph */ }
}

// Saves from the first beta (preset, handoff, shape, focus, shift, renoise ...) load onto the new widgets by name.
const OLD_PRESETS = ["auto (from model)", "Krea 2", "Z-Image", "Flux 2", "SDXL / Illustrious / Pony", "manual", "recommended"];
const OLD_SHIFT = { model: "use model default", "auto (image size)": "by image size", custom: "custom" };
function migrate(node, wv) {
  if (!Array.isArray(wv) || wv.length < 13 || !OLD_PRESETS.includes(wv[0])) return;
  // old order: preset, steps, handoff, shape, sampler, focus, shift, shift_value, denoise, i2i_steps, shape_2, renoise, seed, (control)
  const set = (name, v) => { const w = node.widgets.find((x) => x.name === name); if (w && v !== undefined) w.value = v; };
  set("sampler", wv[4] === "recommended" ? "euler" : wv[4]);
  set("scheduler_shape", wv[3]);
  set("steps", wv[1]);
  set("step_swap", wv[2]);
  set("denoise", wv[8]);
  set("denoise_steps", "full schedule");
  set("low_pass", Number(wv[11]) > 0 ? "renoise" : "continue noise schedule");
  set("scheduler_shape_2", wv[10] === "same as high" ? "same as first" : wv[10]);
  set("sigma_shift", OLD_SHIFT[wv[6]] || "use model default");
  set("custom_shift", wv[7]);
  set("seed", wv[12]);
  if (wv.length > 13) set("control_after_generate", wv[13]);
}

function setup(node) {
  if (node._lcSig) return;
  const wrap = document.createElement("div");
  wrap.style.cssText = "width:100%;height:100%;display:flex;flex-direction:column";
  const canvas = document.createElement("canvas");
  canvas.style.cssText = `width:100%;flex:1 1 auto;min-height:${H}px;height:${H}px;display:block`;
  const text = document.createElement("div");
  text.style.cssText = "max-height:30px;overflow:hidden;font:11px sans-serif;color:#dfe5ec;padding:2px 4px 0;line-height:15px";
  const tip = document.createElement("div");
  tip.style.cssText = "height:16px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font:11px sans-serif;color:#9fd0a0;padding:0 4px";
  wrap.append(canvas, text, tip);
  node.addDOMWidget("lc_sigmas_graph", "LC_SIGMAS_GRAPH", wrap, { serialize: false, getMinHeight: () => faceHeight(node), getMaxHeight: () => 4000 });  // drag the node taller: the graph gets the room
  node._lcSig = { canvas, text, tip };
  let t = 0;
  for (const k of LIVE) {
    const w = node.widgets.find((x) => x.name === k);
    if (!w) continue;
    const prev = w.callback;
    w.callback = function (...a) {
      const r = prev?.apply(this, a);
      if (k === "sigma_shift") syncCustomShift(node);
      clearTimeout(t); t = setTimeout(() => refresh(node), 120); return r;
    };
  }
  new ResizeObserver(() => draw(node)).observe(canvas);
  syncCustomShift(node);
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
      const r = onConfigure?.apply(this, arguments);
      migrate(this, data?.widgets_values);
      syncCustomShift(this);
      return r;
    };
    const onExecuted = nodeType.prototype.onExecuted;
    nodeType.prototype.onExecuted = function (msg) {
      onExecuted?.apply(this, arguments);
      try { this._lcSigGraph = JSON.parse(msg?.lc_sigmas?.[0] || "null"); this._lcSigRan = true; } catch (e) { /* ignore */ }
      draw(this);
    };
  },
});
