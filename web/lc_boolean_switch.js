/**
 * LC Boolean Switch / Flip / Value — utility color; size retained after manual resize
 */
import { app } from "../../scripts/app.js";
import { lcApplyLaunchColor } from "./lc_color.js";

const TYPES = new Set(["LCBooleanSwitch", "LCBooleanFlip", "LCBooleanValue"]);
const COLOR = "#28281E";
const WIDTH = 270;

function style(node) {
  lcApplyLaunchColor(node, COLOR);
}

function defaultSizeOnce(node) {
  if (node._lcUserSized || node.properties?.lc_w) {
    const w = node.properties?.lc_w;
    const h = node.properties?.lc_h;
    if (w && h) {
      node.size = node.size || [w, h];
      node.size[0] = w;
      node.size[1] = h;
      node._lcUserSized = true;
    }
    return;
  }
  if (!node.size || (node.size[0] || 0) < 40) {
    node.size = [WIDTH, node.computeSize?.()[1] || 80];
  }
}

function hookResize(node) {
  if (node._lcBoolResizeHooked) return;
  node._lcBoolResizeHooked = true;
  const prev = node.onResize;
  node.onResize = function () {
    const r = prev?.apply(this, arguments);
    if (!this.properties) this.properties = {};
    if (this.size) {
      this.properties.lc_w = this.size[0];
      this.properties.lc_h = this.size[1];
    }
    this._lcUserSized = true;
    return r;
  };
  const prevCfg = node.onConfigure;
  node.onConfigure = function (data) {
    const r = prevCfg?.apply(this, arguments);
    if (data?.size) {
      if (!this.properties) this.properties = {};
      this.properties.lc_w = data.size[0];
      this.properties.lc_h = data.size[1];
      this._lcUserSized = true;
      this.size = [data.size[0], data.size[1]];
    }
    return r;
  };
}

// LC Boolean Switch: the state toggle reads as the input it passes. A renamed socket's label wins, then the title of
// the node wired into it, then the socket's own name (on_true / on_false).
function sourceName(node, inputName) {
  const inp = (node.inputs || []).find((i) => i?.name === inputName);
  if (!inp) return inputName;
  if (inp.label && inp.label !== inputName) return inp.label;
  if (inp.link != null) {
    const graph = node.graph ?? app.graph;
    const link = graph?.links?.get?.(inp.link) ?? graph?.links?.[inp.link];
    const src = link ? graph.getNodeById?.(link.origin_id) : null;
    if (src) return src.title || src.type || inputName;
  }
  return inputName;
}

function syncStateLabels(node) {
  const w = (node.widgets || []).find((x) => x?.name === "state");
  if (!w) return;
  const on = sourceName(node, "on_true"), off = sourceName(node, "on_false");
  w.options = w.options || {};
  if (w.options.on !== on || w.options.off !== off) {
    w.options.on = on;
    w.options.off = off;
    w.options.label_on = on;
    w.options.label_off = off;
    node.setDirtyCanvas?.(true, false);
  }
}

app.registerExtension({
  name: "LC123.BooleanSwitch",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (!TYPES.has(nodeData?.name)) return;
    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onCreated?.apply(this, arguments);
      style(this);
      hookResize(this);
      defaultSizeOnce(this);
      return r;
    };
    if (nodeData.name !== "LCBooleanSwitch") return;
    // cheap check on every draw: catches rewiring, renamed sockets and renamed source nodes
    const onDrawFG = nodeType.prototype.onDrawForeground;
    nodeType.prototype.onDrawForeground = function () {
      syncStateLabels(this);
      return onDrawFG?.apply(this, arguments);
    };
  },
  nodeCreated(node) {
    if (!TYPES.has(node.comfyClass) && !TYPES.has(node.type)) return;
    style(node);
    hookResize(node);
    defaultSizeOnce(node);
  },
});
