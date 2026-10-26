// LC Timer: times every run, shows the time left while running (run average + current sampler steps), scores the
// newest run against the 5 runs before it and lists the last 10. Timed from ComfyUI's own events (start -> success).
// Stopped runs and fully cached ones (under half a second) are left out of the scoring. The history saves with the
// workflow (node.properties.lc_runs).
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { lcApplyLaunchColor } from "./lc_color.js";

const TYPE = "LCTimer";
const KEEP = 6; // the current run + the 5 it is scored against
const HISTORY = 10; // runs listed on the node: the current one + the 9 before it
const SAME = 2; // within 2% counts as the same
const MIN_RUN = 0.5; // seconds; anything quicker was all cache
const nodes = new Set();
let runStart = 0;
let ticker = null;
// remaining time while running (idea from KRuins Render ETA, MIT): the run's average from this node's history, and the
// current sampler's seconds per step from ComfyUI's progress events
let samp = { node: null, value: 0, max: 0, t0: 0, v0: 0 };

const secs = (s) => (s >= 60 ? `${Math.floor(s / 60)}:${(s % 60).toFixed(2).padStart(5, "0")}` : `${s.toFixed(2)} s`);
const clock = () => new Date().toTimeString().slice(0, 5);

function ensureStyle() {
  if (document.getElementById("lc-rt-style")) return;
  const st = document.createElement("style");
  st.id = "lc-rt-style";
  st.textContent = `
.lc-rt{box-sizing:border-box;width:100%;height:100%;display:flex;flex-direction:column;overflow:hidden;padding:4px 8px 6px;color:#ddd;font:12px system-ui,sans-serif;user-select:none}
.lc-rt-list{flex:1 1 auto;min-height:0;overflow-y:auto;scrollbar-width:thin;scrollbar-color:#ffffff40 transparent}
.lc-rt-list::-webkit-scrollbar{width:6px}.lc-rt-list::-webkit-scrollbar-thumb{background:#ffffff40;border-radius:3px}
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
  if (runStart) {
    ui.sum.innerHTML = remaining(node, (performance.now() - runStart) / 1000);
  } else if (cur && before.length) {
    const avg = before.reduce((a, r) => a + r.t, 0) / before.length;
    const s = score(cur.t, avg);
    ui.sum.innerHTML = `vs the average of the last ${before.length}: <span class="${s.cls}">${s.text}</span>`;
  } else {
    ui.sum.textContent = cur ? "Run again to compare." : "Times every run.";
  }
  ui.list.textContent = "";
  const lastOk = cur ? rs.lastIndexOf(cur) : -1;
  const list = rs.filter((r, i) => i !== lastOk).slice(-(HISTORY - 1)).reverse(); // newest first, without the current run
  if (!list.length && !runStart) ui.list.innerHTML = `<div class="lc-rt-empty">No earlier runs yet.</div>`;
  for (const r of list) {
    const row = document.createElement("div");
    row.className = "lc-rt-row";
    const s = r.ok && cur ? score(cur.t, r.t) : { cls: "same", text: r.ok ? "" : "stopped" };
    row.innerHTML = `<span>${r.at}</span><span>${r.ok ? secs(r.t) : "--"}</span><span class="${s.cls}">${s.text}</span>`;
    ui.list.appendChild(row);
  }
}

const short = (s) => (s >= 60 ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}` : `${Math.max(1, Math.round(s))} s`);

// "about 12 s left (done 20:31) · step 8/20" while a run is going. The longer of the two estimates wins: the run
// average knows about decode and saving, the sampler's pace knows this run's settings.
function remaining(node, t) {
  const done = runs(node).filter((r) => r.ok).slice(-(KEEP - 1));
  const avgLeft = done.length ? done.reduce((a, r) => a + r.t, 0) / done.length - t : null;
  let sampLeft = null, step = "";
  if (samp.max > 1 && samp.value < samp.max) {
    const steps = samp.value - samp.v0;
    if (steps > 0) sampLeft = ((performance.now() - samp.t0) / 1000 / steps) * (samp.max - samp.value);
    step = `step ${samp.value}/${samp.max}`;
  }
  const left = Math.max(avgLeft ?? -Infinity, sampLeft ?? -Infinity);
  let head = "";
  if (left > 0) head = `about ${short(left)} left (done ${new Date(Date.now() + left * 1000).toTimeString().slice(0, 5)})`;
  else if (avgLeft !== null) head = `<span class="down">${short(-avgLeft)} over the average</span>`;
  return [head, step].filter(Boolean).join(" · ") || "running...";
}

function tick() {
  const t = (performance.now() - runStart) / 1000;
  for (const n of nodes) {
    if (!n._lcRt) continue;
    n._lcRt.now.textContent = secs(t);
    const html = remaining(n, t);
    if (n._lcRt.sum.innerHTML !== html) n._lcRt.sum.innerHTML = html;
  }
}

function onProgress(e) {
  const d = e?.detail || {};
  const value = Number(d.value), max = Number(d.max);
  if (!runStart || !(max > 0) || !Number.isFinite(value)) return;
  // a new sampler (other node, other step count, or counting from the start again) starts its own clock
  if (String(d.node) !== String(samp.node) || max !== samp.max || value < samp.value) samp = { node: d.node, value, max, t0: performance.now(), v0: value };
  else samp.value = value;
}

function startRun() {
  samp = { node: null, value: 0, max: 0, t0: 0, v0: 0 };
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
      while (rs.length > HISTORY * 2) rs.shift(); // stopped runs ride along, so keep a little extra
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
  api.addEventListener("progress", onProgress);
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
  const list = Object.assign(document.createElement("div"), { className: "lc-rt-list" }); // squeeze the node: this scrolls
  wrap.append(now, sum, list);
  node._lcRt = { wrap, now, sum, list };
  const dom = node.addDOMWidget("lc_rt", "LC_RT", wrap, { serialize: false, getMinHeight: () => 64 }); // the time + one line; the list scrolls
  // the right side Parameters panel writes its own column width onto widgets it lists: always follow the node
  if (dom) Object.defineProperty(dom, "width", { get: () => undefined, set: () => {}, configurable: true });
  nodes.add(node);
  render(node);
  fitBox(node);
}

// The box gets the node's own height, so a squeezed node scrolls its list instead of spilling past the bottom
// (and in Nodes 2.0 instead of the node growing to fit every row). Checked on resize and twice a second.
const BOX_PAD = 10;
function fitBox(node) {
  const ui = node._lcRt;
  if (!ui || !node.size) return;
  const h = Math.max(54, Math.round(node.size[1] - BOX_PAD)) + "px";
  const st = ui.wrap.style;
  // Nodes 2.0 stretches widget children (flex-1) and lets them grow to their content: pin the box to this height
  if (st.height !== h) { st.height = h; st.maxHeight = h; st.flex = "0 0 auto"; st.minHeight = "0"; }
}
setInterval(() => { for (const n of nodes) fitBox(n); }, 500);

app.registerExtension({
  name: "LC123.Timer",
  setup: bindEvents,
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== TYPE) return;
    const created = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = created?.apply(this, arguments);
      lcApplyLaunchColor(this, "#000000");
      if (!this.size || this.size[0] < 280) this.size = [300, 220];
      setTimeout(() => attach(this), 0);
      return r;
    };
    const configured = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (data) {
      // keep a squeezed (or stretched) size through reloads and tab switches: put the saved size back once loading settles
      const saved = Array.isArray(data?.size) ? [Number(data.size[0]), Number(data.size[1])] : null;
      const r = configured?.apply(this, arguments);
      if (saved && saved[0] > 0 && saved[1] > 0) {
        const put = () => { if (Math.abs(this.size[0] - saved[0]) > 1 || Math.abs(this.size[1] - saved[1]) > 1) this.setSize(saved); };
        for (const ms of [0, 150, 450, 900]) setTimeout(put, ms);
      }
      setTimeout(() => attach(this), 0);
      return r;
    };
    const resized = nodeType.prototype.onResize;
    nodeType.prototype.onResize = function () {
      const r = resized?.apply(this, arguments);
      fitBox(this);
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
