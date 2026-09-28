/**
 * LC Any Empty Bool / Int / Float — autogrow any_* sockets. Keep one empty slot.
 * computeSize is the minimum only. Height hugs the last socket.
 */
import { app } from "../../scripts/app.js";
import { lcApplyLaunchColor } from "./lc_color.js";

const TYPES = new Set(["LCAnyEmptyBool", "LCAnyEmptyInt", "LCAnyEmptyFloat"]);
const MAX_INPUTS = 20;
const MIN_INPUTS = 1;
const LAUNCH_WIDTH = 240;
const MIN_WIDTH = 180;
const COLOR = "#28281E";
const PREFIX = "any_";

function inputName(i) {
  return `any_${String(i).padStart(2, "0")}`;
}

function slotHeight() {
  return (typeof LiteGraph !== "undefined" && LiteGraph.NODE_SLOT_HEIGHT) || 20;
}

function titleHeight() {
  return (typeof LiteGraph !== "undefined" && LiteGraph.NODE_TITLE_HEIGHT) || 30;
}

function anySlots(node) {
  return (node.inputs || []).filter((i) => i && String(i.name || "").startsWith("any_"));
}

function widgetH(node) {
  const n = (node.widgets || []).filter((w) => w && w.type !== "hidden").length;
  return n * 24;
}

function desiredHeight(node, slots) {
  const n = Math.max(slots || 0, MIN_INPUTS);
  return titleHeight() + widgetH(node) + n * slotHeight() + 8;
}

/** Is input slot `idx` wired? Uses the 1.53+ helper, falls back to the old slot read on older frontends. */
function isLinked(node, idx) {
  if (typeof node.isInputConnected === "function") return node.isInputConnected(idx);
  return node.inputs?.[idx]?.link != null;
}

/** Highest socket number (the NN in any_NN) that has a wire; 0 when none. */
function highestLinked(node) {
  let hi = 0;
  (node.inputs || []).forEach((inp, idx) => {
    const name = String(inp?.name || "");
    if (!name.startsWith(PREFIX)) return;
    const n = parseInt(name.slice(PREFIX.length), 10);
    if (Number.isFinite(n) && isLinked(node, idx)) hi = Math.max(hi, n);
  });
  return hi;
}

/** Disconnect the wire on an input that is about to be removed. */
function dropLink(node, inp) {
  const idx = (node.inputs || []).indexOf(inp);
  if (idx < 0 || !isLinked(node, idx)) return;
  try {
    if (typeof node.disconnectInput === "function") node.disconnectInput(idx);
    else (node.graph ?? app.graph)?.removeLink(inp.link);
  } catch (_) {}
}

function hugHeight(node) {
  const n = anySlots(node).length || MIN_INPUTS;
  const minH = desiredHeight(node, n);
  const w = Math.max(MIN_WIDTH, node.size?.[0] || LAUNCH_WIDTH);
  if (typeof node.setSize === "function") node.setSize([w, minH]);
  else node.size = [w, minH];
}

function syncInputs(node) {
  if (!node.inputs) node.inputs = [];
  const byName = new Map();
  const keepOther = [];
  for (const inp of node.inputs) {
    if (!inp) continue;
    if (String(inp.name || "").startsWith("any_")) byName.set(inp.name, inp);
    else keepOther.push(inp);
  }
  // keep every socket up to the highest wired one (a wire above an empty gap stays), plus one empty
  let want = Math.max(MIN_INPUTS, highestLinked(node) + 1);
  want = Math.min(MAX_INPUTS, want);
  for (let i = want + 1; i <= MAX_INPUTS; i++) {
    const old = byName.get(inputName(i));
    if (old) dropLink(node, old);
  }
  const next = keepOther.slice();
  const missing = [];
  let gap = false;
  for (let i = 1; i <= want; i++) {
    const name = inputName(i);
    if (byName.has(name)) {
      if (missing.length) gap = true;
      const inp = byName.get(name);
      inp.type = "*";
      inp.name = name;
      next.push(inp);
    } else {
      missing.push(name);
    }
  }
  if (!gap && typeof node.addInput === "function") {
    // new sockets are real input slots (addInput), appended in order after the kept ones
    node.inputs = next;
    for (const name of missing) node.addInput(name, "*");
  } else {
    for (const name of missing) next.splice(keepOther.length + parseInt(name.slice(PREFIX.length), 10) - 1, 0, { name, type: "*", link: null });
    node.inputs = next;
  }
  hugHeight(node);
  node.setDirtyCanvas?.(true, true);
}

app.registerExtension({
  name: "LC123.AnyEmpty",

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (!TYPES.has(nodeData?.name || "")) return;

    const origCompute = nodeType.prototype.computeSize;
    nodeType.prototype.computeSize = function (out) {
      const slots = anySlots(this).length || MIN_INPUTS;
      const size = [MIN_WIDTH, desiredHeight(this, slots)];
      if (out) {
        out[0] = size[0];
        out[1] = size[1];
        return out;
      }
      return size;
    };

    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onCreated?.apply(this, arguments);
      try {
        lcApplyLaunchColor(this, COLOR);
      } catch (_) {}
      syncInputs(this);
      if (!this.size || this.size[0] < LAUNCH_WIDTH) {
        hugHeight(this);
        if (this.size) this.size[0] = LAUNCH_WIDTH;
      }
      return r;
    };

    const onConfig = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      const r = onConfig?.apply(this, arguments);
      setTimeout(() => syncInputs(this), 0);
      return r;
    };

    const onConn = nodeType.prototype.onConnectionsChange;
    nodeType.prototype.onConnectionsChange = function () {
      const r = onConn?.apply(this, arguments);
      setTimeout(() => syncInputs(this), 0);
      return r;
    };
  },
});
