/**
 * LC Image Denoise: show only the sliders the chosen mode uses.
 * smart  -> luma, chroma, keep_detail
 * legacy -> blur_strength, edge_preservation, radius_multiplier
 * strength (the blend) shows in both. Hidden widgets keep their values and are still saved.
 */
import { app } from "../../scripts/app.js";

const NODE = "LCImageDenoise";
const ONLY = {
  smart: ["luma", "chroma", "keep_detail"],
  legacy: ["blur_strength", "edge_preservation", "radius_multiplier"],
};

function hide(w) {
  if (!w || w._lcHidden) return;
  w._lcOrigType = w.type;
  w._lcOrigCompute = w.computeSize;
  w.type = "hidden";
  w.hidden = true;
  w.computeSize = () => [0, -4];
  w._lcHidden = true;
}

function show(w) {
  if (!w || !w._lcHidden) return;
  w.type = w._lcOrigType;
  w.hidden = false;
  if (w._lcOrigCompute) w.computeSize = w._lcOrigCompute;
  else delete w.computeSize;
  w._lcHidden = false;
}

function apply(node) {
  const mode = (node.widgets || []).find((w) => w.name === "mode")?.value || "smart";
  for (const [m, names] of Object.entries(ONLY)) {
    for (const n of names) {
      const w = (node.widgets || []).find((x) => x.name === n);
      (m === mode ? show : hide)(w);
    }
  }
  // no resize: the LC preview reads the visible widgets (it skips _lcHidden ones) and fills the rest of the node
  node.setDirtyCanvas?.(true, true);
}

app.registerExtension({
  name: "LC123.DenoiseModes",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE) return;
    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onCreated?.apply(this, arguments);
      const w = (this.widgets || []).find((x) => x.name === "mode");
      if (w) {
        const prev = w.callback;
        w.callback = (...a) => {
          prev?.apply(w, a);
          apply(this);
        };
      }
      setTimeout(() => apply(this), 0); // not requestAnimationFrame: it never fires in a hidden tab
      return r;
    };
    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      const r = onConfigure?.apply(this, arguments);
      setTimeout(() => apply(this), 0); // not requestAnimationFrame: it never fires in a hidden tab
      return r;
    };
  },
});
