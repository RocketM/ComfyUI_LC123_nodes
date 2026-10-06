// LC 🚦 - a light for a boolean. One input socket, a round light on the face, and a faint gear that opens a small
// panel to pick the true / false colors (or none). Colors live in node.properties.
// The light follows the upstream boolean widget live when there is one, otherwise the last run's value.
import { app } from "../../scripts/app.js";
import { lcApplyLaunchColor } from "./lc_color.js";

const NODE_NAME = "LCLight";
const FACE_H = 22;
const NODE_SIZE = [120, 32];
const DEFAULTS = { true_color: "#3ddc5a", false_color: "#e5484d" };
const SWATCHES = ["#3ddc5a", "#e5484d", "#f5b83d", "#3d8bfd", "#b57cf2", "#f2f2f2", "none"];

function ensureProps(node) {
  node.properties = node.properties || {};
  for (const [k, v] of Object.entries(DEFAULTS)) if (!node.properties[k]) node.properties[k] = v;
}

// the upstream boolean, read straight from its widget (a toggle, a primitive, an LC switch...)
function upstreamValue(node) {
  const link = node.graph?.links?.[node.inputs?.[0]?.link];
  if (!link) return undefined;
  const src = node.graph.getNodeById(link.origin_id);
  if (!src || src.mode === 2 || src.mode === 4) return undefined;
  const out = src.outputs?.[link.origin_slot];
  const bools = (src.widgets || []).filter((w) => typeof w.value === "boolean");
  const w = bools.find((b) => b.name === out?.name) || (bools.length === 1 ? bools[0] : null);
  return w ? w.value : undefined;
}

function currentState(node) {
  const live = upstreamValue(node);
  if (live !== undefined) return live;
  if (!node.inputs?.[0]?.link) return undefined;
  return node._lcLightRan;
}

function paint(node) {
  const ui = node._lcLight;
  if (!ui) return;
  const state = currentState(node);
  const p = node.properties || {};
  const color = state === true ? p.true_color : state === false ? p.false_color : "none";
  const key = state + "|" + color;
  if (ui.key === key) return;
  ui.key = key;
  const lit = color && color !== "none";
  ui.lamp.style.background = lit ? color : "#2a2a2a";
  ui.lamp.style.boxShadow = lit ? `0 0 8px 1px ${color}aa, inset 0 -2px 3px #0005` : "inset 0 1px 2px #0008";
  ui.lamp.title = state === undefined ? "No value yet" : String(state);
}

function ensureStyle() {
  if (document.getElementById("lc-light-style")) return;
  const st = document.createElement("style");
  st.id = "lc-light-style";
  st.textContent = `
.lc-light{position:relative;display:flex;align-items:center;justify-content:center;width:100%;height:${FACE_H}px;box-sizing:border-box;user-select:none}
.lc-light .lc-lamp{width:14px;height:14px;border-radius:50%;border:1px solid #0008;transition:background .12s,box-shadow .12s}
.lc-light .lc-gear{position:absolute;right:4px;top:50%;transform:translateY(-50%);opacity:.25;cursor:pointer;font-size:12px;line-height:1;padding:2px;color:#ddd}
.lc-light:hover .lc-gear{opacity:.8}
.lc-light-pop{position:fixed;z-index:100000;background:#1e1e1e;color:#ddd;border:1px solid #444;border-radius:8px;padding:8px 10px;font:12px system-ui,sans-serif;box-shadow:0 8px 24px #0008}
.lc-light-pop .row{display:flex;align-items:center;gap:5px;margin:4px 0}
.lc-light-pop .lbl{width:34px;opacity:.8}
.lc-light-pop .sw{width:14px;height:14px;border-radius:50%;cursor:pointer;border:1px solid #0009;box-sizing:border-box}
.lc-light-pop .sw.on{outline:2px solid #fff;outline-offset:1px}
.lc-light-pop .sw.none{background:#2a2a2a;position:relative;overflow:hidden}
.lc-light-pop .sw.none::after{content:"";position:absolute;left:-2px;top:5px;width:18px;height:2px;background:#e5484d;transform:rotate(-45deg)}
.lc-light-pop input[type=color]{width:18px;height:16px;padding:0;border:none;background:none;cursor:pointer}
`;
  document.head.appendChild(st);
}

function openPanel(node, anchor) {
  document.getElementById("lc-light-pop")?.remove();
  ensureProps(node);
  const pop = document.createElement("div");
  pop.id = "lc-light-pop";
  pop.className = "lc-light-pop";

  const rows = [];
  for (const [key, label] of [["true_color", "true"], ["false_color", "false"]]) {
    const row = document.createElement("div");
    row.className = "row";
    const l = document.createElement("span");
    l.className = "lbl";
    l.textContent = label;
    row.appendChild(l);
    const sws = [];
    for (const c of SWATCHES) {
      const sw = document.createElement("div");
      sw.className = "sw" + (c === "none" ? " none" : "");
      if (c !== "none") sw.style.background = c;
      sw.title = c === "none" ? "No light" : c;
      sw.dataset.c = c;
      sw.addEventListener("click", () => set(c));
      row.appendChild(sw);
      sws.push(sw);
    }
    const pick = document.createElement("input");
    pick.type = "color";
    pick.title = "Any color";
    pick.addEventListener("input", () => set(pick.value));
    row.appendChild(pick);
    const mark = () => {
      const v = node.properties[key];
      for (const sw of sws) sw.classList.toggle("on", sw.dataset.c === v);
      if (v && v !== "none") pick.value = v;
    };
    const set = (c) => {
      node.properties[key] = c;
      mark();
      paint(node);
      node.setDirtyCanvas?.(true, true);
    };
    mark();
    rows.push(row);
    pop.appendChild(row);
  }

  document.body.appendChild(pop);
  const r = anchor.getBoundingClientRect();
  const pw = pop.offsetWidth;
  let left = r.right + 8;
  if (left + pw > window.innerWidth - 8) left = Math.max(8, r.left - pw - 8);
  pop.style.left = left + "px";
  pop.style.top = Math.max(8, Math.min(r.top - 10, window.innerHeight - pop.offsetHeight - 8)) + "px";

  const close = (e) => {
    if (e?.type === "keydown") {
      if (e.key !== "Escape") return;
    } else if (e && e.target instanceof Node && (pop.contains(e.target) || anchor.contains(e.target))) return;
    pop.remove();
    window.removeEventListener("pointerdown", close, true);
    window.removeEventListener("keydown", close, true);
  };
  setTimeout(() => {
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("keydown", close, true);
  }, 0);
}

function layoutFace(node) {
  const host = node._lcLight?.wrap.parentElement;
  if (!host) return;
  const px = Math.max(60, (node.size?.[0] || NODE_SIZE[0]) - 20) + "px";
  if (host.style.width !== px) host.style.width = px;
  if (host.style.maxWidth !== px) host.style.maxWidth = px;
}

function attachFace(node) {
  if (node._lcLight) return;
  ensureStyle();
  ensureVueStyle();
  ensureProps(node);
  node.widgets_start_y = 0;
  if (node.inputs?.[0]) node.inputs[0].label = " ";

  const wrap = document.createElement("div");
  wrap.className = "lc-light";
  const lamp = document.createElement("div");
  lamp.className = "lc-lamp";
  const gear = document.createElement("div");
  gear.className = "lc-gear";
  gear.textContent = "⚙";
  gear.title = "Light colors";
  gear.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    openPanel(node, gear);
  });
  wrap.append(lamp, gear);
  node._lcLight = { wrap, lamp, gear, key: null };

  try {
    node.addDOMWidget("lc_light_face", "LC_LIGHT_FACE", wrap, {
      getMinHeight: () => FACE_H,
      getHeight: () => FACE_H,
      serialize: false,
    });
  } catch (e) {
    console.warn("LC Light face widget failed", e);
  }
  paint(node);
}

// Nodes 2.0: the face shares the input socket's row, like LC Slider.
function vueNodesOn() {
  let flag = window.LiteGraph?.vueNodesMode;
  if (flag !== true) {
    try {
      const s = app.extensionManager?.setting?.get?.("Comfy.VueNodes.Enabled");
      if (s != null) flag = !!s;
    } catch (_) {}
  }
  return flag !== false;
}
let vueWatch = null;
function ensureVueStyle() {
  if (document.getElementById("lc-light-vue-style")) return;
  if (!vueNodesOn()) {
    vueWatch ??= setInterval(() => {
      if (!vueNodesOn()) return;
      clearInterval(vueWatch);
      vueWatch = null;
      ensureVueStyle();
    }, 1000);
    return;
  }
  const st = document.createElement("style");
  st.id = "lc-light-vue-style";
  st.textContent = `
.lg-node:has(.lc-light) .lg-node-widgets{margin-top:-24px;pointer-events:none}
.lg-node:has(.lc-light) .lg-node-widgets .lc-light .lc-gear{pointer-events:auto}
.lg-node:has(.lc-light) .lg-slot--input span{display:none}
div:has(> .lg-node-widgets .lc-light){padding-bottom:2px !important}
`;
  document.head.appendChild(st);
}

// Nodes 2.0 does not draw node foregrounds, so the live follow also runs on a slow timer
setInterval(() => {
  for (const n of app.graph?._nodes || []) if (n._lcLight) paint(n);
}, 250);

app.registerExtension({
  name: "LC123.Light",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_NAME) return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated?.apply(this, arguments);
      lcApplyLaunchColor(this, "#000000");
      attachFace(this);
      this.setSize?.([...NODE_SIZE]);
      return r;
    };

    // the frontend fits nodes to their widgets while a workflow loads; this one is always the small light
    nodeType.prototype.computeSize = function () {
      return [...NODE_SIZE];
    };

    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (info) {
      const r = onConfigure?.apply(this, arguments);
      attachFace(this);
      if (this.inputs?.[0]) this.inputs[0].label = " ";
      const saved = Array.isArray(info?.size) ? [info.size[0], info.size[1]] : null;
      const restore = () => {
        if (saved) this.setSize?.(saved);
        paint(this);
      };
      requestAnimationFrame(restore);
      setTimeout(restore, 300);
      return r;
    };

    const onExecuted = nodeType.prototype.onExecuted;
    nodeType.prototype.onExecuted = function (msg) {
      onExecuted?.apply(this, arguments);
      const v = msg?.lc_light?.[0];
      if (typeof v === "boolean") this._lcLightRan = v;
      paint(this);
    };

    const onConnectionsChange = nodeType.prototype.onConnectionsChange;
    nodeType.prototype.onConnectionsChange = function () {
      const r = onConnectionsChange?.apply(this, arguments);
      if (!this.inputs?.[0]?.link) this._lcLightRan = undefined;
      if (this.inputs?.[0]) this.inputs[0].label = " ";
      paint(this);
      return r;
    };

    const onPropertyChanged = nodeType.prototype.onPropertyChanged;
    nodeType.prototype.onPropertyChanged = function () {
      const r = onPropertyChanged?.apply(this, arguments);
      paint(this);
      return r;
    };

    // runs every frame while the canvas draws: cheap (the lamp is only touched when its color changes)
    const onDrawForeground = nodeType.prototype.onDrawForeground;
    nodeType.prototype.onDrawForeground = function () {
      const r = onDrawForeground?.apply(this, arguments);
      if (!this.flags?.collapsed) {
        layoutFace(this);
        paint(this);
      }
      return r;
    };

    const getExtra = nodeType.prototype.getExtraMenuOptions;
    nodeType.prototype.getExtraMenuOptions = function (_, options) {
      getExtra?.apply(this, arguments);
      options.push({
        content: "🚦 Light colors…",
        callback: () => this._lcLight && openPanel(this, this._lcLight.gear),
      });
    };
  },
});
