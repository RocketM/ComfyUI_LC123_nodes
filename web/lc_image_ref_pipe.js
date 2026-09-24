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

/** Highest wired image_N input on an LC Image Ref Pipe In. */
function upstreamCount(node) {
  const link = node.inputs?.[0]?.link != null ? app.graph?.links?.[node.inputs[0].link] : null;
  let src = link ? app.graph.getNodeById(link.origin_id) : null;
  // follow plain reroute nodes
  for (let hop = 0; src && src.type === "Reroute" && hop < 10; hop++) {
    const l = src.inputs?.[0]?.link != null ? app.graph.links[src.inputs[0].link] : null;
    src = l ? app.graph.getNodeById(l.origin_id) : null;
  }
  if (!src || src.type !== IN_CLASS) return 0;
  let n = 0;
  for (const inp of src.inputs || []) if (inp?.link != null) n = Math.max(n, slotIndex(inp.name));
  return n;
}

function syncOutputs(node) {
  if (!node.outputs) return;
  let wired = 0;
  for (const out of node.outputs) {
    if (slotIndex(out?.name) && out.links?.length) wired = Math.max(wired, slotIndex(out.name));
  }
  const want = Math.min(MAX, Math.max(1, wired + 1, upstreamCount(node)));
  let have = node.outputs.filter((o) => slotIndex(o?.name)).length;
  while (have < want) {
    have++;
    node.addOutput(`image_${have}`, "IMAGE");
  }
  while (have > want) {
    const last = node.outputs[node.outputs.length - 1];
    if (!slotIndex(last?.name) || last.links?.length) break;
    node.removeOutput(node.outputs.length - 1);
    have--;
  }
  const min = node.computeSize();
  node.setSize([Math.max(node.size[0], min[0]), min[1]]);
  node.setDirtyCanvas?.(true, true);
}

function syncDownstream(inNode) {
  for (const out of inNode.outputs || []) {
    for (const id of out.links || []) {
      const l = app.graph?.links?.[id];
      const t = l ? app.graph.getNodeById(l.target_id) : null;
      if (t?.type === OUT_CLASS) syncOutputs(t);
    }
  }
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
