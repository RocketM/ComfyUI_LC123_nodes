// LC Timer: times every run and scores the newest one against the 5 runs before it.
// Runs are timed from ComfyUI's own events (start -> success). Stopped runs and fully cached ones (under half a second)
// are left out of the scoring. The history saves with the workflow (node.properties.lc_runs).
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { lcApplyLaunchColor } from "./lc_color.js";

const TYPE = "LCTimer";
const KEEP = 6; // the current run + the 5 it is scored against
const SAME = 2; // within 2% counts as the same
const MIN_RUN = 0.5; // seconds; anything quicker was all cache
const nodes = new Set();
let runStart = 0;
let ticker = null;

const secs = (s) => (s >= 60 ? `${Math.floor(s / 60)}:${(s % 60).toFixed(2).padStart(5, "0")}` : `${s.toFixed(2)} s`);
const clock = () => new Date().toTimeString().slice(0, 5);

function ensureStyle() {
  if (document.getElementById("lc-rt-style")) return;
  const st = document.createElement("style");
  st.id = "lc-rt-style";
  st.textContent = `
.lc-rt{box-sizing:border-box;width:100%;padding:4px 8px 6px;color:#ddd;font:12px system-ui,sans-serif;user-select:none}
.lc-rt-now{font-size:26px;font-weight:600;font-variant-numeric:tabular-nums;text-align:center;padding:2px 0 4px}
.lc-rt-now.run{color:#9fd3ff}
.lc-rt-sum{text-align:center;color:#aaa;margin-bottom:4px;min-height:15px}
.lc-rt-row{display:flex;gap:8px;padding:2px 0;border-top:1px solid #ffffff14;font-variant-numeric:tabular-nums}
.lc-rt-row span:nth-child(1){color:#888;width:38px}
.lc-rt-row span:nth-child(2){width:64px;text-align:right}
.lc-rt-row span:nth-child(3){flex:1;text-align:right}
.lc-rt .up{color:#7bd88f}.lc-rt .down{color:#f08080}.lc-rt .same{color:#999}
.lc-rt-empty{color:#888;text-align:center;padding:4px 0}
`;
  document.head.appendChild(st);
}

function runs(node) {
  node.properties = node.properties || {};
  if (!Array.isArray(node.properties.lc_runs)) node.properties.lc_runs = [];
  return node.properties.lc_runs;
}

// "4.1 s faster (25%)" from the current run's point of view
function score(cur, prev) {
  const pct = ((prev - cur) / prev) * 100;
  if (Math.abs(pct) < SAME) return { cls: "same", text: "same" };
  const d = Math.abs(prev - cur);
  return pct > 0
    ? { cls: "up", text: `${d.toFixed(2)} s faster (${Math.round(pct)}%)` }
    : { cls: "down", text: `${d.toFixed(2)} s slower (${Math.round(-pct)}%)` };
}

function render(node) {
  const ui = node._lcRt;
  if (!ui) return;
  const rs = runs(node);
  const done = rs.filter((r) => r.ok);
  const cur = done[done.length - 1];
  if (!runStart) ui.now.textContent = cur ? secs(cur.t) : "--";
  ui.now.classList.toggle("run", !!runStart);
  const before = done.slice(-KEEP, -1);
  if (cur && before.length) {
    const avg = before.reduce((a, r) => a + r.t, 0) / before.length;
    const s = score(cur.t, avg);
    ui.sum.innerHTML = `vs the average of the last ${before.length}: <span class="${s.cls}">${s.text}</span>`;
  } else {
    ui.sum.textContent = cur ? "Run again to compare." : "Times every run.";
  }
  ui.list.textContent = "";
  const lastOk = cur ? rs.lastIndexOf(cur) : -1;
  const list = rs.filter((r, i) => i !== lastOk).slice(-(KEEP - 1)).reverse(); // newest first, without the current run
  if (!list.length && !runStart) ui.list.innerHTML = `<div class="lc-rt-empty">No earlier runs yet.</div>`;
  for (const r of list) {
    const row = document.createElement("div");
    row.className = "lc-rt-row";
    const s = r.ok && cur ? score(cur.t, r.t) : { cls: "same", text: r.ok ? "" : "stopped" };
    row.innerHTML = `<span>${r.at}</span><span>${r.ok ? secs(r.t) : "--"}</span><span class="${s.cls}">${s.text}</span>`;
    ui.list.appendChild(row);
  }
}

function tick() {
  const t = (performance.now() - runStart) / 1000;
  for (const n of nodes) if (n._lcRt) n._lcRt.now.textContent = secs(t);
}

function startRun() {
  runStart = performance.now();
  clearInterval(ticker);
  ticker = setInterval(tick, 30); // fast enough for the hundredths to roll
  for (const n of nodes) render(n);
}

function endRun(ok) {
  if (!runStart) return;
  const t = (performance.now() - runStart) / 1000;
  runStart = 0;
  clearInterval(ticker);
  if (!ok || t >= MIN_RUN) {
    for (const n of nodes) {
      const rs = runs(n);
      rs.push({ t: Math.round(t * 100) / 100, at: clock(), ok });
      while (rs.length > KEEP * 2) rs.shift(); // stopped runs ride along, so keep a little extra
      n.setDirtyCanvas?.(true, false);
    }
  }
  for (const n of nodes) render(n);
}

let bound = false;
function bindEvents() {
  if (bound) return;
  bound = true;
  api.addEventListener("execution_start", startRun);
  api.addEventListener("execution_success", () => endRun(true));
  api.addEventListener("execution_error", () => endRun(false));
  api.addEventListener("execution_interrupted", () => endRun(false));
}

function attach(node) {
  if (node._lcRt) return render(node);
  ensureStyle();
  const wrap = Object.assign(document.createElement("div"), { className: "lc-rt" });
  const now = Object.assign(document.createElement("div"), { className: "lc-rt-now", textContent: "--" });
  const sum = Object.assign(document.createElement("div"), { className: "lc-rt-sum" });
  const list = document.createElement("div");
  wrap.append(now, sum, list);
  node._lcRt = { wrap, now, sum, list };
  node.addDOMWidget("lc_rt", "LC_RT", wrap, { serialize: false, getMinHeight: () => 150 });
  nodes.add(node);
  render(node);
}

app.registerExtension({
  name: "LC123.Timer",
  setup: bindEvents,
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== TYPE) return;
    const created = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = created?.apply(this, arguments);
      lcApplyLaunchColor(this, "#28281E");
      if (!this.size || this.size[0] < 280) this.size = [300, 220];
      setTimeout(() => attach(this), 0);
      return r;
    };
    const configured = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      const r = configured?.apply(this, arguments);
      setTimeout(() => attach(this), 0);
      return r;
    };
    const removed = nodeType.prototype.onRemoved;
    nodeType.prototype.onRemoved = function () {
      nodes.delete(this);
      return removed?.apply(this, arguments);
    };
    const menu = nodeType.prototype.getExtraMenuOptions;
    nodeType.prototype.getExtraMenuOptions = function (_, options) {
      menu?.apply(this, arguments);
      options.push({ content: "⏱️ Clear timer history", callback: () => { this.properties.lc_runs = []; render(this); } });
    };
  },
});
