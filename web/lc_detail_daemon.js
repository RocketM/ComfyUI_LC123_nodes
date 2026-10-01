// LC Detail Daemon (BETA): the effect over the render, drawn live from the widgets.
// x = how far along the image is (0% pure noise -> 100% finished), y = how much noise is hidden from the model.
// With sigmas wired (and one run), the steps show as ticks: lit ones get detail.
import { app } from "../../scripts/app.js";

const NODES = ["LCDetailDaemon", "LCDetailDaemonModel"];
const H = 120;

// Mirrors envelope() in lc_detail_daemon.py
function env(p, start, end, peak) {
  if (end <= start || p <= start || p >= end) return 0;
  const mid = start + Math.min(Math.max(peak, 0), 1) * (end - start);
  let t = p <= mid ? (p - start) / Math.max(1e-6, mid - start) : (end - p) / Math.max(1e-6, end - mid);
  t = Math.min(Math.max(t, 0), 1);
  return 0.5 - 0.5 * Math.cos(Math.PI * t);
}

function draw(node) {
  const ui = node._lcDD;
  if (!ui) return;
  const val = (k) => Number(node.widgets.find((w) => w.name === k)?.value ?? 0);
  const amount = val("amount"), start = val("start"), end = val("end"), peak = val("peak");
  const cv = ui.canvas, dpr = window.devicePixelRatio || 1, w = cv.clientWidth || 300;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(H * dpr); }
  const ctx = cv.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, H);
  const L = 34, R = 8, T = 8, B = 18, gw = w - L - R, gh = H - T - B;
  ctx.fillStyle = "#15181c";
  ctx.fillRect(L, T, gw, gh);
  const top = Math.max(0.05, Math.abs(amount));
  const zero = amount < 0 ? T : T + gh;
  const X = (p) => L + p * gw, Y = (v) => (amount < 0 ? T + (-v / top) * gh : T + gh - (v / top) * gh);
  ctx.font = "10px sans-serif";
  ctx.fillStyle = "#8a95a5";
  ctx.textAlign = "right";
  ctx.fillText(`${(amount < 0 ? -top : top) * 100 >= 10 ? Math.round((amount < 0 ? -top : top) * 100) : ((amount < 0 ? -top : top) * 100).toFixed(1)}%`, L - 4, amount < 0 ? T + gh : T + 8);
  ctx.fillText("0", L - 4, zero + (amount < 0 ? 8 : 0));
  // steps, if known
  const steps = node._lcDDSteps || [];
  let lit = 0;
  for (const p of steps) {
    const on = env(p, start, end, peak) > 0.02;
    lit += on ? 1 : 0;
    ctx.strokeStyle = on ? "rgba(240,160,80,0.75)" : "rgba(255,255,255,0.15)";
    ctx.beginPath(); ctx.moveTo(X(p), T + gh); ctx.lineTo(X(p), T + gh - 6); ctx.stroke();
  }
  // the curve
  ctx.strokeStyle = amount < 0 ? "#60a5fa" : "#f0a050";
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let i = 0; i <= 200; i++) {
    const p = i / 200, v = amount * env(p, start, end, peak);
    i ? ctx.lineTo(X(p), Y(v)) : ctx.moveTo(X(p), Y(v));
  }
  ctx.stroke();
  ctx.textAlign = "center";
  ctx.fillStyle = "#8a95a5";
  ctx.fillText("noise", X(0) + 12, T + gh + 12);
  ctx.fillText("finished", X(1) - 20, T + gh + 12);
  const words = amount === 0 ? "off" : `${amount > 0 ? "hides" : "adds"} up to ${Math.abs(amount * 100).toFixed(1)}% of the noise, ${Math.round(start * 100)}-${Math.round(end * 100)}% of the way`;
  ui.text.textContent = words + (steps.length ? ` · ${lit} of ${steps.length} steps` : "");
  const tip = node._lcDDTip || "";
  ui.tip.textContent = tip;
  ui.tip.title = tip;
  if ((ui.tip.style.display === "none") !== !tip) {  // the recommendation line only when there is one
    ui.tip.style.display = tip ? "" : "none";
    requestAnimationFrame(() => {
      const need = node.computeSize?.()?.[1];
      if (need && Math.abs(node.size[1] - need) > 1) node.setSize([node.size[0], need]);
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
  wrap.style.cssText = "width:100%";
  const canvas = document.createElement("canvas");
  canvas.style.cssText = `width:100%;height:${H}px;display:block`;
  const text = document.createElement("div");
  text.style.cssText = "height:17px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font:11px sans-serif;color:#dfe5ec;padding:2px 4px 0";
  const tip = document.createElement("div");
  tip.style.cssText = "display:none;height:16px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font:11px sans-serif;color:#9fd0a0;padding:0 4px";
  wrap.append(canvas, text, tip);
  node.addDOMWidget("lc_dd_graph", "LC_DD_GRAPH", wrap, { serialize: false, getMinHeight: () => ddHeight(node), getMaxHeight: () => ddHeight(node) });
  node._lcDD = { canvas, text, tip };
  for (const k of ["amount", "start", "end", "peak"]) {
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
        this._lcDDSteps = d.steps || [];
        this._lcDDTip = d.tip || "";
      } catch (e) { /* ignore */ }
      draw(this);
    };
  },
});
