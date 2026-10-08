// LC Detail Daemon (BETA): the effect over the steps, drawn live from the widgets.
// x = the steps (first -> last), y = amount (the original Detail Daemon's scale: 1.0 = 10% less noise).
// With sigmas wired (and one run), the steps show as ticks: lit ones get detail.
import { app } from "../../scripts/app.js";

const NODES = ["LCDetailDaemon", "LCDetailDaemonModel"];
const GRAPH_MIN = 120, H = GRAPH_MIN; // graph height at the fitted size; drag the node taller and the graph grows with it

// Mirrors schedule() in lc_detail_daemon.py, as a smooth curve: cosine up to the peak, down to the end, ** exponent
function env(p, start, end, peak, exponent) {
  if (end <= start || p < start || p > end) return 0;
  const mid = start + Math.min(Math.max(peak, 0), 1) * (end - start);
  let t = p <= mid ? (mid - start < 1e-6 ? 1 : (p - start) / (mid - start)) : (end - mid < 1e-6 ? 1 : (end - p) / (end - mid));
  t = Math.min(Math.max(t, 0), 1);
  const v = 0.5 - 0.5 * Math.cos(Math.PI * t);
  return Math.pow(v, exponent ?? 1); // 0 ** 0 = 1: exponent 0 = the whole window at full strength
}

function draw(node) {
  const ui = node._lcDD;
  if (!ui) return;
  const val = (k) => Number(node.widgets.find((w) => w.name === k)?.value ?? 0);
  const amount = val("amount"), start = val("start"), end = val("end"), peak = val("peak"), exponent = val("exponent") || 1;
  const mode = node.widgets.find((w) => w.name === "mode")?.value || "classic";
  const cv = ui.canvas, dpr = window.devicePixelRatio || 1, w = cv.clientWidth || 300;
  const H = Math.max(GRAPH_MIN, cv.clientHeight || GRAPH_MIN);
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(H * dpr); }
  const ctx = cv.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, H);
  const L = 34, R = 8, T = 8, B = 18, gw = w - L - R, gh = H - T - B;
  ctx.fillStyle = "#15181c";
  ctx.fillRect(L, T, gw, gh);
  // a fixed scale (0-1, more only when the amount goes past it), so a bigger amount draws a taller curve
  const top = Math.max(1, Math.ceil(Math.abs(amount) * 2) / 2);
  const stepY = top <= 1 ? 0.25 : 0.5;
  const zero = amount < 0 ? T : T + gh;
  const X = (p) => L + p * gw, Y = (v) => (amount < 0 ? T + (-v / top) * gh : T + gh - (v / top) * gh);
  ctx.font = "10px sans-serif";
  ctx.textAlign = "right";
  for (let g = 0; g <= top + 1e-6; g += stepY) {
    const y = amount < 0 ? T + (g / top) * gh : T + gh - (g / top) * gh;
    ctx.strokeStyle = "rgba(255,255,255,0.06)";
    ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(L + gw, y); ctx.stroke();
    ctx.fillStyle = "#8a95a5";
    ctx.fillText(g < 1e-6 ? "0" : `${amount < 0 ? "-" : ""}${+g.toFixed(2)}`, L - 4, y + 3);
  }
  // steps, if known (one run with sigmas wired)
  const n = Number(node._lcDDSteps) || 0;
  const steps = n > 1 ? Array.from({ length: n }, (_, i) => i / (n - 1)) : [];
  let lit = 0;
  for (const p of steps) {
    const on = env(p, start, end, peak, exponent) > 0.02;
    lit += on ? 1 : 0;
    ctx.strokeStyle = on ? "rgba(240,160,80,0.75)" : "rgba(255,255,255,0.15)";
    ctx.beginPath(); ctx.moveTo(X(p), T + gh); ctx.lineTo(X(p), T + gh - 6); ctx.stroke();
  }
  // the curve
  ctx.strokeStyle = amount < 0 ? "#60a5fa" : "#f0a050";
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let i = 0; i <= 200; i++) {
    const p = i / 200, v = amount * env(p, start, end, peak, exponent);
    i ? ctx.lineTo(X(p), Y(v)) : ctx.moveTo(X(p), Y(v));
  }
  ctx.stroke();
  ctx.textAlign = "center";
  ctx.fillStyle = "#8a95a5";
  ctx.fillText("first step", X(0) + 22, T + gh + 12);
  ctx.fillText("last step", X(1) - 20, T + gh + 12);
  const words = amount === 0 ? "off" : `${mode} · ${amount > 0 ? "hides" : "adds"} up to ${Math.abs(amount * 10).toFixed(1)}% of the noise`;
  ui.text.textContent = words + (steps.length ? ` · ${lit} of ${steps.length} steps` : "");
  const tip = node._lcDDTip || "";
  ui.tip.textContent = tip;
  ui.tip.title = tip;
  if ((ui.tip.style.display === "none") !== !tip) {  // the recommendation line only when there is one
    ui.tip.style.display = tip ? "" : "none";
    requestAnimationFrame(() => {
      const need = node.computeSize?.()?.[1];
      if (need && node.size[1] < need - 1) node.setSize([node.size[0], need]);  // never shrinks a node dragged taller
      node.setDirtyCanvas?.(true, true);
    });
  }
}

function ddHeight(node) {
  const ui = node._lcDD;
  return H + 19 + (ui && ui.tip.style.display !== "none" ? 16 : 0);
}

function setup(node) {
  if (node._lcDD) return;
  const wrap = document.createElement("div");
  wrap.style.cssText = "width:100%;height:100%;display:flex;flex-direction:column";
  const canvas = document.createElement("canvas");
  canvas.style.cssText = `width:100%;flex:1 1 auto;min-height:${H}px;height:${H}px;display:block`;
  const text = document.createElement("div");
  text.style.cssText = "height:17px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font:11px sans-serif;color:#dfe5ec;padding:2px 4px 0";
  const tip = document.createElement("div");
  tip.style.cssText = "display:none;height:16px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font:11px sans-serif;color:#9fd0a0;padding:0 4px";
  wrap.append(canvas, text, tip);
  node.addDOMWidget("lc_dd_graph", "LC_DD_GRAPH", wrap, { serialize: false, getMinHeight: () => ddHeight(node), getMaxHeight: () => 4000 });  // drag the node taller: the graph gets the room
  node._lcDD = { canvas, text, tip };
  for (const k of ["amount", "start", "end", "peak", "exponent", "mode"]) {
    const wg = node.widgets.find((x) => x.name === k);
    if (!wg) continue;
    const prev = wg.callback;
    wg.callback = function (...a) { const r = prev?.apply(this, a); draw(node); return r; };
  }
  new ResizeObserver(() => draw(node)).observe(canvas);
  if (node.size[0] < 300) node.setSize([300, node.size[1]]);
  requestAnimationFrame(() => {
    const need = node.computeSize?.()?.[1];
    if (need && node.size[1] < need) node.setSize([node.size[0], need]);
    draw(node);
  });
}

app.registerExtension({
  name: "LC123.DetailDaemon",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (!NODES.includes(nodeData.name)) return;
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
      try {
        const d = JSON.parse(msg?.lc_detail_daemon?.[0] || "{}");
        this._lcDDSteps = d.steps || 0;
        this._lcDDTip = d.tip || "";
      } catch (e) { /* ignore */ }
      draw(this);
    };
  },
});
