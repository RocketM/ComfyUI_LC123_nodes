// LC Control Panel: LC Slider rows on one node, each row on its own output. The gear at the end of a row sets its name,
// min, max, step and decimals (0 = INT, otherwise FLOAT). The rows live in node.properties.lc_rows and are mirrored into
// the hidden "rows" widget (JSON), which is what a run reads. A fresh row plugged into a number input copies that
// input's name, range, step and value.
import { app } from "../../scripts/app.js";
import { lcApplyLaunchColor } from "./lc_color.js";

const TYPE = "LCControlPanel";
const MAX_ROWS = 16;
const ADD_H = 22;
const DEFAULT_ROW = { name: "value", value: 1, min: 0, max: 100, step: 1, decimals: 0, auto: true };

const num = (v, fb) => (Number.isFinite(Number(v)) ? Number(v) : fb);
const clampDec = (d) => Math.max(0, Math.min(4, Math.floor(num(d, 0))));
const vueOn = () => {
  if (window.LiteGraph?.vueNodesMode === true) return true;
  try {
    return !!app.extensionManager?.setting?.get?.("Comfy.VueNodes.Enabled");
  } catch (_) {
    return false;
  }
};
// one row per output socket: classic LiteGraph slot rows are NODE_SLOT_HEIGHT; in Nodes 2.0 the pitch is measured from
// the node's own sockets (see alignVue), starting from 20
let vuePitch = 20;
const rowH = () => (vueOn() ? vuePitch : window.LiteGraph?.NODE_SLOT_HEIGHT || 20);

function snap(r, v) {
  let lo = num(r.min, 0), hi = num(r.max, 100);
  if (lo > hi) [lo, hi] = [hi, lo];
  const st = num(r.step, 1) > 0 ? num(r.step, 1) : 1;
  let x = lo + Math.round((num(v, lo) - lo) / st) * st;
  x = Math.min(hi, Math.max(lo, Math.round(x * 1e10) / 1e10));
  const d = clampDec(r.decimals);
  return d === 0 ? Math.round(x) : Math.round(x * 10 ** d) / 10 ** d;
}
const fmt = (r) => (clampDec(r.decimals) === 0 ? String(Math.round(num(r.value, 0))) : num(r.value, 0).toFixed(clampDec(r.decimals)));

function rows(node) {
  node.properties = node.properties || {};
  let rs = node.properties.lc_rows;
  if (!Array.isArray(rs)) {
    try {
      const w = (node.widgets || []).find((x) => x.name === "rows");
      rs = JSON.parse(w?.value || "[]");
    } catch (_) {
      rs = [];
    }
  }
  if (!Array.isArray(rs) || !rs.length) rs = [{ ...DEFAULT_ROW }];
  node.properties.lc_rows = rs.slice(0, MAX_ROWS);
  return node.properties.lc_rows;
}

// the hidden widget is what execution reads; keep it (and the output sockets) in step with the rows
function sync(node) {
  const rs = rows(node);
  const w = (node.widgets || []).find((x) => x.name === "rows");
  const json = JSON.stringify(rs.map(({ name, value, min, max, step, decimals }) => ({ name, value, min, max, step, decimals })));
  if (w && w.value !== json) w.value = json;
  node.outputs = node.outputs || [];
  while (node.outputs.length > rs.length) node.removeOutput(node.outputs.length - 1);
  while (node.outputs.length < rs.length) node.addOutput(`value_${node.outputs.length + 1}`, "*");
  rs.forEach((r, i) => {
    const o = node.outputs[i];
    o.type = "*";
    o.label = " "; // the name is on the face, on the same row
    o.lcRowName = r.name;
  });
  try {
    node.graph?.setisChangedFlag?.(node.id);
  } catch (_) {}
}

function hideRowsWidget(node) {
  const w = (node.widgets || []).find((x) => x.name === "rows");
  if (!w) return;
  w.type = "hidden";
  w.computeSize = () => [0, -4];
  if (w.options) w.options.hidden = true;
  try {
    Object.defineProperty(w, "hidden", { configurable: true, get: () => true, set: () => {} });
  } catch (_) {
    w.hidden = true;
  }
}

function ensureStyle() {
  if (document.getElementById("lc-cp-style")) return;
  const st = document.createElement("style");
  st.id = "lc-cp-style";
  st.textContent = `
.lc-cp{display:flex;flex-direction:column;width:100%;box-sizing:border-box;padding:0 22px 0 6px;color:#ddd;font:12px system-ui,sans-serif;user-select:none}
.lc-cp-row{display:flex;align-items:center;gap:6px;min-width:0}
.lc-cp-name{flex:0 0 auto;width:var(--lc-cp-name,78px);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#bbb}
.lc-cp-row input[type=range]{--lc-p:0%;flex:1 1 auto;min-width:30px;height:14px;margin:0;background:transparent;cursor:pointer;-webkit-appearance:none;appearance:none}
.lc-cp-row input[type=range]:focus{outline:none}
.lc-cp-row input[type=range]::-webkit-slider-runnable-track{height:3px;border-radius:2px;background:linear-gradient(to right,#cfcfcf var(--lc-p),#555 var(--lc-p))}
.lc-cp-row input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:12px;height:12px;margin-top:-4.5px;border-radius:50%;background:#fff;border:1px solid #00000066}
.lc-cp-row input[type=range]::-moz-range-track{height:3px;border-radius:2px;background:#555}
.lc-cp-row input[type=range]::-moz-range-progress{height:3px;border-radius:2px;background:#cfcfcf}
.lc-cp-row input[type=range]::-moz-range-thumb{width:10px;height:10px;border-radius:50%;background:#fff;border:1px solid #00000066}
.lc-cp-val{flex:0 0 auto;min-width:32px;max-width:70px;text-align:right;font-variant-numeric:tabular-nums;cursor:text;padding:0 2px;border-radius:3px}
.lc-cp-val:hover{background:#ffffff14}
.lc-cp input.lc-cp-edit{flex:0 0 auto;width:58px;font:inherit;text-align:right;color:#fff;background:#111;border:1px solid #666;border-radius:3px;padding:0 3px}
.lc-cp-gear{flex:0 0 auto;opacity:.3;cursor:pointer;font-size:12px;line-height:1;padding:2px}
.lc-cp-row:hover .lc-cp-gear{opacity:.85}
.lc-cp-add{display:flex;align-items:center;justify-content:center;margin-top:2px;border:1px dashed #ffffff30;border-radius:4px;color:#9aa;cursor:pointer;font-size:11px}
.lc-cp-add:hover{border-color:#ffffff70;color:#ddd}
.lg-node:has(.lc-cp) .lg-node-widgets{margin-top:var(--lc-cp-up,0px)}
.lg-node:has(.lc-cp) .lg-slot--output span{display:none}
`;
  document.head.appendChild(st);
}

function openRowSettings(node, i) {
  const rs = rows(node);
  const r = rs[i];
  document.getElementById("lc-cp-modal")?.remove();
  const ov = document.createElement("div");
  ov.id = "lc-cp-modal";
  ov.style.cssText = "position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,0.55);display:flex;align-items:center;justify-content:center;font-family:system-ui,sans-serif;";
  const p = document.createElement("div");
  p.style.cssText = "background:#1e1e1e;color:#eee;border:1px solid #444;border-radius:10px;padding:16px 18px;min-width:270px;box-shadow:0 12px 40px rgba(0,0,0,0.5);";
  p.innerHTML = `<div style="font-size:15px;font-weight:600;margin-bottom:10px">Slider ${i + 1} settings</div>`;
  const fields = [
    ["name", "Name", "text"],
    ["min", "Min", "number"],
    ["max", "Max", "number"],
    ["step", "Step", "number"],
    ["decimals", "Decimals (0 = INT)", "number"],
  ];
  const ins = {};
  for (const [k, label, t] of fields) {
    const row = document.createElement("label");
    row.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:12px;margin:8px 0;font-size:13px;";
    const inp = document.createElement("input");
    inp.type = t;
    if (t === "number") inp.step = k === "decimals" ? "1" : "any";
    inp.value = String(r[k] ?? DEFAULT_ROW[k]);
    inp.style.cssText = "width:120px;padding:4px 8px;border-radius:6px;border:1px solid #555;background:#111;color:#eee;";
    row.append(Object.assign(document.createElement("span"), { textContent: label }), inp);
    p.appendChild(row);
    ins[k] = inp;
  }
  const bar = document.createElement("div");
  bar.style.cssText = "display:flex;gap:8px;margin-top:12px;align-items:center;";
  const btn = (text, css) => Object.assign(document.createElement("button"), { type: "button", textContent: text, style: `padding:6px 14px;border-radius:6px;cursor:pointer;${css}` });
  const del = btn("Delete", "border:1px solid #733;background:#3a1f1f;color:#f99;");
  const cancel = btn("Cancel", "border:1px solid #555;background:#2a2a2a;color:#ddd;margin-left:auto;");
  const ok = btn("Apply", "border:1px solid #567;background:#345;color:#fff;font-weight:600;");
  if (rs.length > 1) bar.appendChild(del);
  bar.append(cancel, ok);
  p.appendChild(bar);
  ov.appendChild(p);
  const close = () => {
    ov.remove();
    window.removeEventListener("keydown", onKey, true);
  };
  const onKey = (e) => {
    if (e.key === "Escape") close();
    else if (e.key === "Enter") ok.click();
  };
  window.addEventListener("keydown", onKey, true);
  ov.addEventListener("pointerdown", (e) => e.target === ov && close());
  cancel.onclick = close;
  del.onclick = () => {
    rs.splice(i, 1);
    node.removeOutput(i); // links on the rows below shift up with their sockets
    close();
    refresh(node);
  };
  ok.onclick = () => {
    let min = num(ins.min.value, r.min), max = num(ins.max.value, r.max);
    if (min > max) [min, max] = [max, min];
    const step = num(ins.step.value, r.step) > 0 ? num(ins.step.value, r.step) : 1;
    Object.assign(r, { name: ins.name.value.trim() || r.name, min, max, step, decimals: clampDec(ins.decimals.value), auto: false });
    r.value = snap(r, r.value);
    close();
    refresh(node);
  };
  document.body.appendChild(ov);
  ins.name.focus();
  ins.name.select();
}

function setValue(node, i, raw) {
  const r = rows(node)[i];
  if (!r) return;
  r.value = snap(r, raw);
  paintRow(node, i);
  sync(node);
  node.setDirtyCanvas?.(true, true);
}

function paintRow(node, i) {
  const ui = node._lcCp?.rows[i];
  const r = rows(node)[i];
  if (!ui || !r) return;
  let lo = num(r.min, 0), hi = num(r.max, 100);
  if (lo > hi) [lo, hi] = [hi, lo];
  ui.range.min = String(lo);
  ui.range.max = String(hi);
  ui.range.step = String(num(r.step, 1) > 0 ? r.step : 1);
  ui.range.value = String(r.value);
  ui.range.style.setProperty("--lc-p", (hi > lo ? Math.max(0, Math.min(100, ((r.value - lo) / (hi - lo)) * 100)) : 0) + "%");
  if (!ui.editing) ui.val.textContent = fmt(r);
  ui.name.textContent = r.name;
  ui.name.title = `${r.name}: ${clampDec(r.decimals) === 0 ? "INT" : "FLOAT"}, ${lo} to ${hi}, step ${r.step}`;
}

function startEdit(node, i) {
  const ui = node._lcCp?.rows[i];
  if (!ui || ui.editing) return;
  ui.editing = true;
  const inp = Object.assign(document.createElement("input"), { type: "number", className: "lc-cp-edit", step: "any", value: ui.val.textContent });
  ui.val.replaceWith(inp);
  inp.focus();
  inp.select();
  const done = (commit) => {
    if (!ui.editing) return;
    ui.editing = false;
    inp.replaceWith(ui.val);
    if (commit && inp.value !== "") setValue(node, i, inp.value);
    else paintRow(node, i);
  };
  inp.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") done(true);
    else if (e.key === "Escape") done(false);
  });
  inp.addEventListener("blur", () => done(true));
}

function buildRows(node) {
  const f = node._lcCp;
  const rs = rows(node);
  const h = rowH();
  f.list.textContent = "";
  f.rows = rs.map((r, i) => {
    const row = Object.assign(document.createElement("div"), { className: "lc-cp-row" });
    row.style.height = h + "px";
    const name = Object.assign(document.createElement("div"), { className: "lc-cp-name" });
    const range = Object.assign(document.createElement("input"), { type: "range" });
    range.addEventListener("input", () => setValue(node, i, range.value));
    const val = Object.assign(document.createElement("div"), { className: "lc-cp-val", title: "Double-click to type a value" });
    val.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      startEdit(node, i);
    });
    const gear = Object.assign(document.createElement("div"), { className: "lc-cp-gear", textContent: "⚙", title: "Name, min, max, step, decimals (0 = INT)" });
    gear.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      openRowSettings(node, i);
    });
    row.append(name, range, val, gear);
    f.list.appendChild(row);
    return { row, name, range, val, editing: false };
  });
  rs.forEach((_, i) => paintRow(node, i));
  f.add.style.height = ADD_H - 2 + "px";
  f.add.style.display = rs.length >= MAX_ROWS ? "none" : "";
}

function faceHeight(node) {
  return rows(node).length * rowH() + ADD_H + 2;
}

function fit(node) {
  const w = Math.max(node.size?.[0] || 0, 260);
  const h = faceHeight(node) + (vueOn() ? 0 : 6);
  node._lcCpHeight = h;
  if (!node.size || Math.abs(node.size[1] - h) > 1 || node.size[0] !== w) node.setSize?.([w, h]);
  if (vueOn()) requestAnimationFrame(() => alignVue(node));
}

// Nodes 2.0: put each row beside its output socket. Measured from the live sockets, so it holds at any zoom
// (both are drawn under the same transform, so ratios of their on-screen sizes are exact).
function alignVue(node, tries = 0) {
  const f = node._lcCp;
  const el = f?.wrap.closest?.(".lg-node");
  const slots = el ? [...el.querySelectorAll(".lg-slot--output")] : [];
  if (!el || !slots.length || !f.rows.length) return tries < 10 && setTimeout(() => alignVue(node, tries + 1), 100);
  const r0 = f.rows[0].row.getBoundingClientRect();
  if (!r0.height) return tries < 10 && setTimeout(() => alignVue(node, tries + 1), 100);
  const k = rowH() / r0.height; // screen px -> css px
  if (slots.length > 1) {
    const pitch = Math.round((slots[1].getBoundingClientRect().top - slots[0].getBoundingClientRect().top) * k);
    if (pitch > 8 && Math.abs(pitch - vuePitch) > 0.5) {
      vuePitch = pitch;
      buildRows(node);
      return requestAnimationFrame(() => alignVue(node, tries + 1));
    }
  }
  const s0 = slots[0].getBoundingClientRect();
  const cur = parseFloat(el.style.getPropertyValue("--lc-cp-up")) || 0;
  const shift = Math.round((s0.top + s0.height / 2 - (r0.top + r0.height / 2)) * k);
  if (Math.abs(shift) > 0.5) el.style.setProperty("--lc-cp-up", `${cur + shift}px`);
}

function refresh(node) {
  if (!node._lcCp) return;
  sync(node);
  buildRows(node);
  fit(node);
  node.setDirtyCanvas?.(true, true);
}

function attach(node) {
  if (node._lcCp) return refresh(node);
  ensureStyle();
  const wrap = Object.assign(document.createElement("div"), { className: "lc-cp" });
  const list = document.createElement("div");
  const add = Object.assign(document.createElement("div"), { className: "lc-cp-add", textContent: "+ Add slider" });
  add.addEventListener("click", (e) => {
    e.stopPropagation();
    const rs = rows(node);
    if (rs.length >= MAX_ROWS) return;
    rs.push({ ...DEFAULT_ROW, name: `value ${rs.length + 1}` });
    refresh(node);
  });
  wrap.append(list, add);
  node._lcCp = { wrap, list, add, rows: [] };
  try {
    node.addDOMWidget("lc_cp_face", "LC_CP_FACE", wrap, {
      getMinHeight: () => faceHeight(node),
      getHeight: () => faceHeight(node),
      serialize: false,
    });
  } catch (e) {
    console.warn("LC Control Panel face failed", e);
  }
  refresh(node);
}

function boot(node) {
  node.widgets_start_y = 0; // classic: the rows sit on the output socket rows
  rows(node);
  hideRowsWidget(node);
  attach(node);
}

// a fresh row plugged into a number widget copies its name, range, step and value
function adopt(node, slot, link) {
  const r = rows(node)[slot];
  if (!r || !r.auto || !link) return;
  const target = node.graph?.getNodeById?.(link.target_id);
  const input = target?.inputs?.[link.target_slot];
  if (!input) return;
  const wname = input.widget?.name || input.name;
  const w = (target.widgets || []).find((x) => x.name === wname);
  const t = String(input.type || "").toUpperCase();
  if (!w || (t !== "INT" && t !== "FLOAT")) return;
  const o = w.options || {};
  const v = num(w.value, r.value);
  const isInt = t === "INT";
  let step = num(o.step2, NaN);
  if (!(step > 0)) step = isInt ? 1 : num(o.round, 0) > 0 ? num(o.round, 0.01) : 0.01;
  let min = num(o.min, 0), max = num(o.max, isInt ? 100 : 1);
  if (Math.abs(min) > 1e6) min = Math.min(0, v);
  // a huge range (steps: 1 to 10000) makes a useless slider: keep it to a few times the current value
  const roomy = Math.max(isInt ? 100 : 10, Math.ceil(Math.abs(v) * 4));
  if (max > roomy) max = roomy;
  const dec = isInt ? 0 : Math.max(1, Math.min(4, num(o.precision, String(step).split(".")[1]?.length || 2)));
  Object.assign(r, { name: input.label || input.localized_name || input.name, min, max, step, decimals: dec, value: v, auto: false });
  r.value = snap(r, v);
  refresh(node);
}

app.registerExtension({
  name: "LC123.ControlPanel",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== TYPE) return;

    // keep the height to the rows (except while the user is dragging a resize handle)
    const rawSetSize = nodeType.prototype.setSize;
    let mouseDown = false;
    window.addEventListener("pointerdown", () => (mouseDown = true), true);
    window.addEventListener("pointerup", () => (mouseDown = false), true);
    nodeType.prototype.setSize = function (size) {
      if (!mouseDown && this._lcCpHeight && Array.isArray(size) && Math.abs(size[1] - this._lcCpHeight) > 1) size = [size[0], this._lcCpHeight];
      return rawSetSize.call(this, size);
    };

    // Connection FX: each output is an INT at 0 decimals and a FLOAT otherwise
    nodeType.prototype.lcFxType = function (isInput, index) {
      if (isInput) return null;
      const r = rows(this)[index];
      return r ? (clampDec(r.decimals) > 0 ? "FLOAT" : "INT") : null;
    };

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated?.apply(this, arguments);
      lcApplyLaunchColor(this, "#28281E");
      requestAnimationFrame(() => boot(this));
      setTimeout(() => boot(this), 150);
      return r;
    };

    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      const r = onConfigure?.apply(this, arguments);
      requestAnimationFrame(() => boot(this));
      return r;
    };

    const onConn = nodeType.prototype.onConnectionsChange;
    nodeType.prototype.onConnectionsChange = function (type, slot, connected, link) {
      const r = onConn?.apply(this, arguments);
      if (type === window.LiteGraph?.OUTPUT && connected && link) setTimeout(() => adopt(this, slot, link), 0);
      return r;
    };

    const getExtra = nodeType.prototype.getExtraMenuOptions;
    nodeType.prototype.getExtraMenuOptions = function (_, options) {
      getExtra?.apply(this, arguments);
      options.push({
        content: "🎛️ Add slider",
        callback: () => {
          const rs = rows(this);
          if (rs.length < MAX_ROWS) rs.push({ ...DEFAULT_ROW, name: `value ${rs.length + 1}` });
          refresh(this);
        },
      });
    };
  },
});
