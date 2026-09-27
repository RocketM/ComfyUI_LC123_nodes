/**
 * LC Image Ref Pipe Out — grow the image output sockets.
 * Visible image_N outputs = max(1, last wired output + 1, last wired input on the
 * LC Image Ref Pipe In feeding it). Only the tail is ever removed, and never a wired
 * socket, so saved links keep their slot index. The In node grows natively (Autogrow).
 */
import { app } from "../../scripts/app.js";

const OUT_CLASS = "LCImageRefPipeOut";
const IN_CLASS = "LCImageRefPipeIn";
const MAX = 16;

function slotIndex(name) {
  const m = /image_(\d+)$/.exec(String(name || ""));
  return m ? parseInt(m[1], 10) : 0;
}

// Connectivity helpers: the 1.53+ node methods (they also work inside subgraphs), falling back to the old
// slot reads on older frontends.
function graphOf(node) {
  return node?.graph ?? app.graph;
}

function inputConnected(node, i) {
  if (typeof node.isInputConnected === "function") return node.isInputConnected(i);
  return node.inputs?.[i]?.link != null;
}

function outputConnected(node, i) {
  if (typeof node.isOutputConnected === "function") return node.isOutputConnected(i);
  return !!node.outputs?.[i]?.links?.length;
}

/** The node wired into input `i`, or null. */
function inputOrigin(node, i) {
  const g = graphOf(node);
  if (!g || !node.inputs?.[i] || !inputConnected(node, i)) return null;
  let link = null;
  try {
    link = typeof node.getInputLink === "function" ? node.getInputLink(i) : g.links?.[node.inputs[i].link];
  } catch (_) {}
  return link ? g.getNodeById(link.origin_id) : null;
}

/** Nodes wired to output `i`. */
function outputTargets(node, i) {
  if (typeof node.getOutputNodes === "function") return node.getOutputNodes(i) || [];
  const g = graphOf(node);
  const res = [];
  for (const id of node.outputs?.[i]?.links || []) {
    const l = g?.links?.[id];
    const t = l ? g.getNodeById(l.target_id) : null;
    if (t) res.push(t);
  }
  return res;
}

/** Highest wired image_N input on an LC Image Ref Pipe In. */
function upstreamCount(node) {
  let src = inputOrigin(node, 0);
  // follow plain reroute nodes
  for (let hop = 0; src && src.type === "Reroute" && hop < 10; hop++) {
    src = inputOrigin(src, 0);
  }
  if (!src || src.type !== IN_CLASS) return 0;
  let n = 0;
  (src.inputs || []).forEach((inp, i) => {
    if (inp && inputConnected(src, i)) n = Math.max(n, slotIndex(inp.name));
  });
  return n;
}

function syncOutputs(node) {
  if (!node.outputs) return;
  let wired = 0;
  node.outputs.forEach((out, i) => {
    if (slotIndex(out?.name) && outputConnected(node, i)) wired = Math.max(wired, slotIndex(out.name));
  });
  const want = Math.min(MAX, Math.max(1, wired + 1, upstreamCount(node)));
  let have = node.outputs.filter((o) => slotIndex(o?.name)).length;
  while (have < want) {
    have++;
    node.addOutput(`image_${have}`, "IMAGE");
  }
  while (have > want) {
    const last = node.outputs[node.outputs.length - 1];
    if (!slotIndex(last?.name) || outputConnected(node, node.outputs.length - 1)) break;
    node.removeOutput(node.outputs.length - 1);
    have--;
  }
  const min = node.computeSize();
  node.setSize([Math.max(node.size[0], min[0]), min[1]]);
  node.setDirtyCanvas?.(true, true);
}

function syncDownstream(inNode) {
  (inNode.outputs || []).forEach((out, i) => {
    for (const t of outputTargets(inNode, i)) {
      if (t?.type === OUT_CLASS) syncOutputs(t);
    }
  });
}

app.registerExtension({
  name: "LC123.ImageRefPipe",

  async beforeRegisterNodeDef(nodeType, nodeData) {
    const name = nodeData?.name;
    if (name !== OUT_CLASS && name !== IN_CLASS) return;

    const onConnectionsChange = nodeType.prototype.onConnectionsChange;
    nodeType.prototype.onConnectionsChange = function () {
      const r = onConnectionsChange?.apply(this, arguments);
      setTimeout(() => (name === OUT_CLASS ? syncOutputs(this) : syncDownstream(this)), 0);
      return r;
    };

    if (name !== OUT_CLASS) return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated?.apply(this, arguments);
      // start with pipe + image_1 only
      for (let i = this.outputs.length - 1; i >= 0; i--) {
        if (slotIndex(this.outputs[i].name) > 1) this.removeOutput(i);
      }
      setTimeout(() => syncOutputs(this), 0);
      return r;
    };

    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      const r = onConfigure?.apply(this, arguments);
      setTimeout(() => syncOutputs(this), 50);
      return r;
    };
  },
});
