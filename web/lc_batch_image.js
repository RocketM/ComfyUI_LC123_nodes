/**
 * LC Batch Image / LC Image Stitch Multi — autogrow IMAGE slots. Keep one empty socket.
 * computeSize returns the minimum only. this.size may grow and shrink to that min.
 * Height hugs the last socket. Launch width 270; shrink min ~180.
 */
import { app } from "../../scripts/app.js";
import { lcApplyLaunchColor } from "./lc_color.js";

const NODE_CLASSES = new Set(["LCBatchImage", "LCImageStitchMulti"]);
const MAX_INPUTS = 20;
const MIN_INPUTS = 2;
const LAUNCH_WIDTH = 270;
const MIN_WIDTH = 180;
const COLOR = "#324B4B";
const PREFIX = "image_";

function inputName(i) {
  return `image_${String(i).padStart(2, "0")}`;
}

function slotHeight() {
  return (typeof LiteGraph !== "undefined" && LiteGraph.NODE_SLOT_HEIGHT) || 20;
}

function titleHeight() {
  return (typeof LiteGraph !== "undefined" && LiteGraph.NODE_TITLE_HEIGHT) || 30;
}

function widgetRows(node) {
  return (node?.widgets || []).filter((w) => w && w.type !== "hidden" && !w._lcHidden).length;
}

/** Minimum box that still shows every socket (and any widgets below them) — hugs the last one. */
function desiredHeight(slots, node) {
  const n = Math.max(slots || 0, MIN_INPUTS, node?.outputs?.length || 0);
  const wh = ((typeof LiteGraph !== "undefined" && LiteGraph.NODE_WIDGET_HEIGHT) || 20) + 4;
  const rows = widgetRows(node);
  return titleHeight() + n * slotHeight() + 6 + (rows ? rows * wh + 8 : 0);
}

function slotCount(node) {
  return (node.inputs || []).filter((i) => i && String(i.name || "").startsWith("image_")).length;
}

function setSize(node, w, h) {
  w = Math.max(MIN_WIDTH, w || MIN_WIDTH);
  h = Math.max(desiredHeight(MIN_INPUTS, node), h || desiredHeight(MIN_INPUTS, node));
  if (typeof node.setSize === "function") node.setSize([w, h]);
  else if (node.size) {
    node.size[0] = w;
    node.size[1] = h;
  } else {
    node.size = [w, h];
  }
}

/** Is input slot `idx` wired? Uses the 1.53+ helper, falls back to the old slot read on older frontends. */
function isLinked(node, idx) {
  if (typeof node.isInputConnected === "function") return node.isInputConnected(idx);
  return node.inputs?.[idx]?.link != null;
}

/** Highest socket number (the NN in image_NN) that has a wire; 0 when none. */
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
  const n = slotCount(node) || MIN_INPUTS;
  const minH = desiredHeight(n, node);
  const w = Math.max(MIN_WIDTH, node.size?.[0] || LAUNCH_WIDTH);
  setSize(node, w, minH);
}

function syncInputs(node) {
  if (!node.inputs) node.inputs = [];
  const byName = new Map();
  const keepOther = [];
  for (const inp of node.inputs) {
    if (!inp) continue;
    if (String(inp.name || "").startsWith("image_")) byName.set(inp.name, inp);
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
      inp.type = "IMAGE";
      inp.name = name;
      next.push(inp);
    } else {
      missing.push(name);
    }
  }
  if (!gap && typeof node.addInput === "function") {
    // new sockets are real input slots (addInput), appended in order after the kept ones
    node.inputs = next;
    for (const name of missing) node.addInput(name, "IMAGE");
  } else {
    for (const name of missing) next.splice(keepOther.length + parseInt(name.slice(PREFIX.length), 10) - 1, 0, { name, type: "IMAGE", link: null });
    node.inputs = next;
  }
  hugHeight(node);
  node.setDirtyCanvas?.(true, true);
}

app.registerExtension({
  name: "LC123.BatchImage",

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (!NODE_CLASSES.has(nodeData?.name || "")) return;

    const origCompute = nodeType.prototype.computeSize;
    nodeType.prototype.computeSize = function (out) {
      const slots = slotCount(this) || MIN_INPUTS;
      const minW = MIN_WIDTH;
      const minH = desiredHeight(slots, this);
      // Minimum only — never feed saved lc_h back or the node cannot shrink.
      const size = [minW, minH];
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
      if (!this.size) this.size = [LAUNCH_WIDTH, desiredHeight(MIN_INPUTS, this)];
      else this.size[0] = Math.max(MIN_WIDTH, this.size[0] || LAUNCH_WIDTH);
      if (!this.size[0] || this.size[0] < LAUNCH_WIDTH) this.size[0] = LAUNCH_WIDTH;
      syncInputs(this);
      const prevResize = this.onResize;
      this.onResize = function (size) {
        if (size) {
          if (size[0] < MIN_WIDTH) size[0] = MIN_WIDTH;
          const minH = desiredHeight(slotCount(this) || MIN_INPUTS, this);
          if (size[1] < minH) size[1] = minH;
        }
        return prevResize?.apply(this, arguments);
      };
      setTimeout(() => syncInputs(this), 0);
      return r;
    };

    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (data) {
      const r = onConfigure?.apply(this, arguments);
      setTimeout(() => {
        syncInputs(this);
        if (data?.size?.[0]) {
          const w = Math.max(MIN_WIDTH, data.size[0]);
          setSize(this, w, desiredHeight(slotCount(this) || MIN_INPUTS, this));
        }
      }, 20);
      return r;
    };

    const onConnectionsChange = nodeType.prototype.onConnectionsChange;
    nodeType.prototype.onConnectionsChange = function () {
      const r = onConnectionsChange?.apply(this, arguments);
      setTimeout(() => syncInputs(this), 0);
      return r;
    };
  },
});
