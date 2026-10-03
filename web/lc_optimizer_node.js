/**
 * LC Optimizer node face (all four versions): file pickers that drill down through subfolders like the LoRA
 * loader, and a status panel (files, speed-ups, hints, estimate). The real values live in the node's own combo
 * widgets (hidden), so saving and queueing work like any combo. Everything here is one DOM widget, so it works
 * in the classic canvas and in Nodes 2.0.
 */
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { lcApplyLaunchColor } from "./lc_color.js";

const TYPES = { LCOptimizer: "image", LCOptimizerPipe: "image", LCOptimizerVideo: "video", LCOptimizerVideoPipe: "video" };
const COLOR = "#2E4A3B";
const DEFAULT_W = 330;
const REC = "★ Recommended", DL = "⬇ Download: ", CKPT = "From checkpoint", NONE = "None";
const FILE_WIDGETS = [
  ["model_file", "model", "Model file"], ["text_encoder", "clip", "Text encoder"], ["vae", "vae", "VAE"],
  ["audio_vae", "audio_vae", "Audio VAE"], ["latent_upscaler", "upscaler", "Latent upscaler"], ["lora", "lora", "Distilled LoRA"],
];
const MANUAL = ["attention", "fp16_accumulation", "step_cache", "torch_compile", "qwen21_cache"];
const LEGEND = {
  picker: "★ recommended for this machine · ⬇ downloads on the first run · 📦 from the checkpoint",
  file: "✅ on disk · ⬇️ downloads on the first run · 📦 from the checkpoint · ⚠️ not found",
  speed: "✅ on (will apply, then applied) · ➖ off or not available here",
  hint: "⚠️ check this (it still loads) · 💡 tip · ℹ️ info",
};
const tip = (detail, legend) => esc(detail ? `${detail}\n\n${legend}` : legend);
const ICON = { disk: "✅", download: "⬇️", ckpt: "📦", missing: "⚠️", on: "✅", off: "➖", na: "➖", unsupported: "➖" };
const CUSTOM = "Custom";

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const wByName = (node, n) => (node.widgets || []).find((w) => w.name === n);
const baseName = (p) => String(p).replace(/\\/g, "/").split("/").pop();

function hideWidget(w) {
  if (!w || w._lcHidden) return;
  w._lcOrigType = w._lcOrigType ?? w.type;
  w._lcOrigCompute = w.computeSize;
  w.type = "hidden";
  w.hidden = true;
  w.computeSize = () => [0, -4];
  w._lcHidden = true;
}
function showWidget(w) {
  if (!w || !w._lcHidden) return;
  w.type = w._lcOrigType;
  w.hidden = false;
  if (w._lcOrigCompute) w.computeSize = w._lcOrigCompute; else delete w.computeSize;
  w._lcHidden = false;
}

// ---------------------------------------------------------------- the picker popup
let openPop = null;
function closePop() {
  openPop?.remove();
  openPop = null;
  document.removeEventListener("pointerdown", outside, true);
  document.removeEventListener("keydown", escKey, true);
}
function outside(e) { if (openPop && !openPop.contains(e.target)) closePop(); }
function escKey(e) { if (e.key === "Escape") closePop(); }

function buildTree(list) {
  const root = { files: [], folders: new Map() };
  for (const name of list) {
    const parts = name.replace(/\\/g, "/").split("/");
    let n = root;
    for (const seg of parts.slice(0, -1)) {
      if (!n.folders.has(seg)) n.folders.set(seg, { files: [], folders: new Map() });
      n = n.folders.get(seg);
    }
    n.files.push(name);
  }
  return root;
}

async function showPicker(node, widget, role, anchor) {
  closePop();
  const kind = TYPES[node.comfyClass] || "image";
  const base = wByName(node, "base_model")?.value, goal = wByName(node, "goal")?.value;
  const pop = document.createElement("div");
  openPop = pop;
  pop.style.cssText = "position:fixed;z-index:10000;width:380px;max-height:460px;display:flex;flex-direction:column;background:#1b1f24;color:#e6e9ee;border:1px solid #3a4250;border-radius:8px;box-shadow:0 10px 30px #0009;font:13px sans-serif;overflow:hidden";
  const r = anchor.getBoundingClientRect();
  pop.style.left = Math.min(r.left, innerWidth - 390) + "px";
  pop.style.top = Math.min(r.bottom + 4, innerHeight - 470) + "px";
  pop.innerHTML = `<div style="padding:8px;border-bottom:1px solid #2c333d;display:flex;gap:6px;align-items:center"><button data-back style="display:none;background:#2a313b;color:#cfd6df;border:0;border-radius:4px;padding:3px 8px;cursor:pointer">‹</button><span data-crumb style="flex:1;color:#9aa6b8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">Loading…</span></div><input data-q placeholder="Search" style="margin:6px 8px;padding:5px 8px;background:#12161b;color:#e6e9ee;border:1px solid #333b46;border-radius:4px;outline:none"><div data-list style="overflow:auto;flex:1;padding:0 4px 6px"></div>`;
  document.body.appendChild(pop);
  setTimeout(() => { document.addEventListener("pointerdown", outside, true); document.addEventListener("keydown", escKey, true); }, 0);

  let data;
  try {
    data = await (await api.fetchApi(`/lc123/optimizer_node/choices?kind=${kind}&base=${encodeURIComponent(base)}&role=${role}&goal=${encodeURIComponent(goal)}`)).json();
  } catch (e) { data = { error: String(e) }; }
  if (openPop !== pop) return;
  const listEl = pop.querySelector("[data-list]"), crumb = pop.querySelector("[data-crumb]"), back = pop.querySelector("[data-back]"), q = pop.querySelector("[data-q]");
  const pick = (v) => { widget.value = v; widget.callback?.(v); closePop(); node._lcOptRefresh?.(); };
  const row = (html, onClick, opts = {}) => {
    const el = document.createElement("div");
    el.style.cssText = `padding:6px 8px;border-radius:4px;cursor:pointer;display:flex;gap:8px;align-items:center;${opts.current ? "background:#26303b;" : ""}`;
    el.innerHTML = html;
    el.onmouseenter = () => (el.style.background = "#2b3542");
    el.onmouseleave = () => (el.style.background = opts.current ? "#26303b" : "");
    el.onclick = onClick;
    listEl.appendChild(el);
  };
  const tree = buildTree(data.local || []);
  const known = new Set(data.known || []);
  const extras = role === "model" ? [] : [CKPT, NONE];
  let path = [];

  const render = () => {
    listEl.innerHTML = "";
    const term = q.value.trim().toLowerCase();
    back.style.display = path.length ? "" : "none";
    if (term) {
      crumb.textContent = "Search";
      const all = [...(data.downloads || []).map((d) => d.value), ...(data.local || [])].filter((v) => v.toLowerCase().includes(term));
      for (const v of all.slice(0, 200)) row(`<span>${v.startsWith(DL) ? "⬇️" : "📄"}</span><span style="word-break:break-all">${esc(v.startsWith(DL) ? baseName(v.slice(DL.length)) : v)}</span>`, () => pick(v), { current: v === widget.value });
      if (!all.length) listEl.innerHTML = `<div style="padding:10px;color:#8a95a5">No match.</div>`;
      return;
    }
    if (path[0] === "__dl") {
      crumb.textContent = "⬇ Download";
      for (const d of data.downloads || []) {
        const tag = d.featured ? ` · ${esc(d.featured)}` : d.gated ? " · gated" : d.community ? " · community" : "";
        row(`<span>⬇️</span><span style="flex:1;word-break:break-all">${esc(d.file)}</span><span style="color:#8a95a5;white-space:nowrap">${d.gb ?? "?"} GB${tag}</span>`, () => pick(d.value), { current: d.value === widget.value });
      }
      return;
    }
    if (path[0] === "__known") {
      crumb.textContent = `On disk for ${base}`;
      for (const f of data.known || []) row(`<span>✅</span><span style="word-break:break-all">${esc(f)}</span>`, () => pick(f), { current: f === widget.value });
      return;
    }
    let level = tree;
    for (const seg of path) level = level.folders.get(seg) || { files: [], folders: new Map() };
    crumb.textContent = path.length ? path.join(" / ") : `${base} · ${goal}`;
    if (!path.length) {
      const rec = data.recommended;
      const ckptPart = role !== "model" && node._lcOptPlan?.checkpoint;
      row(`<span>★</span><span style="flex:1"><b>Recommended</b><br><span style="color:#8a95a5">${rec ? esc(rec.file) + (rec.on_disk ? " · on disk" : ` · downloads ${rec.gb ?? "?"} GB`) + (rec.source === "default" ? " · Comfy default" : "") : (ckptPart ? "blank: the checkpoint's own" : data.unsupported ? "unsupported for Custom: pick a file" : "nothing for this part")}</span></span>`, () => pick(REC), { current: widget.value === REC });
      for (const x of extras) row(`<span>${x === CKPT ? "📦" : "∅"}</span><span>${x}</span>`, () => pick(x), { current: widget.value === x });
      if ((data.downloads || []).length) row(`<span>📁</span><span style="flex:1">⬇ Download</span><span style="color:#8a95a5">${data.downloads.length}</span>`, () => { path = ["__dl"]; render(); });
      if (known.size) row(`<span>📁</span><span style="flex:1">On disk for ${esc(base)}</span><span style="color:#8a95a5">${known.size}</span>`, () => { path = ["__known"]; render(); });
    }
    for (const [name, sub] of [...level.folders.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const count = (function c(n) { let k = n.files.length; for (const s of n.folders.values()) k += c(s); return k; })(sub);
      row(`<span>📁</span><span style="flex:1">${esc(name)}</span><span style="color:#8a95a5">${count}</span>`, () => { path = [...path, name]; render(); });
    }
    for (const f of level.files.sort((a, b) => baseName(a).localeCompare(baseName(b))))
      row(`<span>${known.has(f) ? "✅" : "📄"}</span><span style="word-break:break-all">${esc(baseName(f))}</span>`, () => pick(f), { current: f === widget.value });
  };
  back.onclick = () => { path = path.slice(0, -1); render(); };
  q.oninput = render;
  if (data.error) { listEl.innerHTML = `<div style="padding:10px;color:#f0a0a0">${esc(data.error)}</div>`; crumb.textContent = ""; return; }
  render();
  q.focus();
}

// ---------------------------------------------------------------- the face
function display(v, planFile) {
  if (v === REC && planFile?.state === "unsupported") return "unsupported: pick a file";
  if (v === REC && planFile?.state === "ckpt") return ""; // blank: the checkpoint's own text encoder / VAE
  if (v === REC) return `★ ${planFile?.label ? baseName(planFile.label) : "Recommended"}`;
  if (typeof v === "string" && v.startsWith(DL)) return `⬇ ${baseName(planFile?.label || v.slice(DL.length))}`;
  if (v === CKPT) return "📦 From checkpoint";
  return baseName(v ?? "");
}

function renderFace(node) {
  const f = node._lcOptFace;
  if (!f) return;
  const pl = node._lcOptPlan;
  const files = Object.fromEntries((pl?.files || []).map((x) => [x.role, x]));
  f.pickers.innerHTML = "";
  for (const [wn, role, label] of FILE_WIDGETS) {
    const w = wByName(node, wn);
    if (!w) continue;
    const rowEl = document.createElement("div");
    rowEl.style.cssText = "display:flex;align-items:center;gap:6px;margin:0 0 4px";
    rowEl.innerHTML = `<span style="width:92px;color:#9aa6b8;flex:none">${label}</span>`;
    const btn = document.createElement("button");
    btn.style.cssText = "flex:1;min-width:0;text-align:left;background:#20262e;color:#e6e9ee;border:1px solid #333b46;border-radius:5px;padding:4px 8px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font:12px sans-serif";
    const unused = pl?.roles && !pl.roles.includes(role);
    btn.textContent = unused ? `not used by ${pl.base}` : display(w.value, files[role]) + "  ▾";
    btn.title = unused ? "" : `${w.value}\n\n${LEGEND.picker}`;
    if (unused) { btn.style.opacity = "0.45"; btn.style.cursor = "default"; }
    btn.onclick = (e) => { e.stopPropagation(); if (!unused) showPicker(node, w, role, btn); };
    rowEl.appendChild(btn);
    f.pickers.appendChild(rowEl);
  }
  if (!pl) { f.status.innerHTML = `<div style="color:#8a95a5">Checking…</div>`; f.foot.textContent = ""; return; }
  const lines = [];
  for (const x of pl.files || []) {
    const what = x.state === "download" ? `downloads ${x.gb ?? "?"} GB` : x.state === "disk" ? "on disk" : x.state === "ckpt" ? "" : x.state === "unsupported" ? "" : "not found";
    lines.push(`<div style="display:flex;gap:6px" title="${tip(baseName(x.label), LEGEND.file)}"><span>${ICON[x.state] || "•"}</span><span style="flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(baseName(x.label))}</span><span style="color:#8a95a5;white-space:nowrap">${what}</span></div>`);
  }
  for (const s of pl.speedups || []) {
    const applied = !pl.applied || pl.applied.includes(s.label) || s.key === "kitchen";
    lines.push(`<div style="display:flex;gap:6px" title="${tip(s.why, LEGEND.speed)}"><span>${ICON[s.state]}</span><span style="flex:1">${esc(s.label)}</span><span style="color:#8a95a5;white-space:nowrap;max-width:48%;overflow:hidden;text-overflow:ellipsis">${s.state === "on" ? (pl.applied ? (applied ? "applied" : "failed") : "will apply") : esc(s.why)}</span></div>`);
  }
  for (const [icon, text] of pl.hints || [])
    lines.push(`<div style="display:flex;gap:6px;color:${icon === "⚠️" ? "#f3c969" : "#b8c2d0"}" title="${tip("", LEGEND.hint)}"><span>${icon}</span><span style="flex:1">${esc(text)}</span></div>`);
  f.status.innerHTML = lines.join("");
  const e = pl.estimate, rep = pl.report;
  const est = e === "unsupported" ? "Estimate: unsupported" : e ? `~${e.step_s} s/step${e.total_s ? ` · ~${e.total_s} s` : ""}${e.fits === "vram" ? " · fits on the card" : e.fits ? " · streams from RAM" : ""}` : "";
  f.foot.innerHTML = `<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(est || (rep ? `Report: ${rep.when?.slice(0, 10)} · ${rep.gpu}` : "No report yet"))}</span>`;
  const b = document.createElement("button");
  b.textContent = "Run or Open Report";
  b.title = "Run the optimization report or view saved one";
  b.style.cssText = "background:#2a313b;color:#dfe5ec;border:1px solid #3a4250;border-radius:4px;padding:2px 8px;cursor:pointer;font:12px sans-serif";
  b.onclick = (ev) => { ev.stopPropagation(); window.LC123SystemCheck?.open?.({ saved: true }); };
  f.foot.appendChild(b);
  fit(node);
}

// Height of what the face actually shows. Not wrap.scrollHeight: the face is stretched to the space the node gives it
// and scrollHeight never reports less than that, so every time the node grew the "minimum" grew with it (empty
// space at the bottom that never went away).
function faceHeight(node) {
  const f = node._lcOptFace;
  if (!f) return 0;
  const kids = [...f.wrap.children];
  return kids.reduce((h, k) => h + k.offsetHeight, 0) + 6 * Math.max(0, kids.length - 1) + 8 + 8;
}

// The node follows its content both ways: it grows for more status lines and shrinks back when there are fewer.
function fit(node) {
  requestAnimationFrame(() => {
    const need = node.computeSize?.()?.[1];
    if (need && Math.abs(node.size[1] - need) > 1) node.setSize([Math.max(node.size[0], DEFAULT_W), need]);
    node.setDirtyCanvas?.(true, true);
  });
}

async function refreshPlan(node) {
  const kind = TYPES[node.comfyClass];
  const picks = {};
  for (const [wn, role] of FILE_WIDGETS) { const w = wByName(node, wn); if (w) picks[role] = w.value; }
  const body = {
    kind, base: wByName(node, "base_model")?.value, goal: wByName(node, "goal")?.value, speed_ups: wByName(node, "speed_ups")?.value,
    picks, manual: Object.fromEntries(MANUAL.map((k) => [k, wByName(node, k)?.value])),
  };
  const seq = (node._lcOptSeq = (node._lcOptSeq || 0) + 1);
  try {
    const res = await api.fetchApi("/lc123/optimizer_node/plan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (seq !== node._lcOptSeq) return;
    node._lcOptPlan = await res.json();
    // switching to a checkpoint base (SDXL family): the text encoder and VAE go blank (the checkpoint's own)
    if (node._lcOptBaseChanged && node._lcOptPlan.checkpoint_only) {
      node._lcOptBaseChanged = false;
      let changed = false;
      for (const wn of ["text_encoder", "vae"]) {
        const w = wByName(node, wn);
        if (w && w.value !== REC) { w.value = REC; changed = true; }
      }
      if (changed) return refreshPlan(node);
    }
    node._lcOptBaseChanged = false;
  } catch (e) {
    node._lcOptPlan = { hints: [["⚠️", "Could not reach ComfyUI to check the files."]] };
  }
  renderFace(node);
}

function applyManual(node) {
  const manual = wByName(node, "speed_ups")?.value === "Manual";
  for (const k of MANUAL) (manual ? showWidget : hideWidget)(wByName(node, k));
  // the text encoder type is only asked for Custom (the known base models bring their own)
  (wByName(node, "base_model")?.value === CUSTOM ? showWidget : hideWidget)(wByName(node, "clip_type"));
  fit(node);
}

function setup(node) {
  if (node._lcOptFace) return;
  lcApplyLaunchColor?.(node, COLOR);
  for (const [wn] of FILE_WIDGETS) hideWidget(wByName(node, wn));
  const wrap = document.createElement("div");
  wrap.style.cssText = "display:flex;flex-direction:column;gap:6px;padding:4px 2px;font:12px sans-serif;color:#e6e9ee;box-sizing:border-box";
  const pickers = document.createElement("div");
  const status = document.createElement("div");
  status.style.cssText = "display:grid;grid-template-columns:minmax(0,1fr);gap:4px;border:1px solid #333b46;border-radius:6px;padding:6px 8px;background:#161a1f";
  const foot = document.createElement("div");
  foot.style.cssText = "display:flex;gap:6px;align-items:center;color:#8a95a5";
  wrap.append(pickers, status, foot);
  // stop canvas zoom/drag from swallowing clicks inside the face
  for (const ev of ["pointerdown", "mousedown", "wheel"]) wrap.addEventListener(ev, (e) => e.stopPropagation());
  const dom = node.addDOMWidget("lc_optimizer_face", "LC_OPTIMIZER_FACE", wrap, { serialize: false, getMinHeight: () => faceHeight(node), getMaxHeight: () => faceHeight(node) });
  dom.serializeValue = () => undefined;
  node._lcOptFace = { wrap, pickers, status, foot };

  let timer = 0;
  node._lcOptRefresh = () => { clearTimeout(timer); timer = setTimeout(() => refreshPlan(node), 150); };
  for (const n of ["base_model", "goal", "speed_ups", "clip_type", ...MANUAL]) {
    const w = wByName(node, n);
    if (!w) continue;
    const prev = w.callback;
    w.callback = function (...a) {
      const r = prev?.apply(this, a);
      if (n === "speed_ups" || n === "base_model") applyManual(node);
      if (n === "base_model") node._lcOptBaseChanged = true;
      node._lcOptRefresh();
      return r;
    };
  }
  const prevExec = node.onExecuted;
  node.onExecuted = function (msg) {
    prevExec?.apply(this, arguments);
    try {
      const swap = JSON.parse(msg?.lc_optimizer_swap?.[0] || "{}");
      for (const [wn, v] of Object.entries(swap)) { const w = wByName(this, wn); if (w) w.value = v; }
      if (msg?.lc_optimizer?.[0]) this._lcOptPlan = JSON.parse(msg.lc_optimizer[0]);
    } catch (e) { /* keep the last plan */ }
    renderFace(this);
    if (Object.keys(JSON.parse(msg?.lc_optimizer_swap?.[0] || "{}")).length) this._lcOptRefresh();
  };
  if (!node.size || node.size[0] < DEFAULT_W) node.setSize([DEFAULT_W, node.size?.[1] || 300]);
  applyManual(node);
  renderFace(node);
  node._lcOptRefresh();
}

app.registerExtension({
  name: "LC123.OptimizerNode",
  nodeCreated(node) { if (TYPES[node.comfyClass]) setup(node); },
  loadedGraphNode(node) {
    if (!TYPES[node.comfyClass]) return;
    // base model names that changed (MiniMax H3 is now MiniMax H3 Ref2VA, next to FL2VA)
    const bw = wByName(node, "base_model");
    if (bw && bw.value === "MiniMax H3") bw.value = "MiniMax H3 Ref2VA";
    setup(node);
    applyManual(node);
    node._lcOptRefresh?.();
  },
});
