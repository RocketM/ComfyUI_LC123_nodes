/**
 * LC Sampler Configure family — hide layout spacer widgets (_gap1, _gap2)
 * and keep a thin vertical gap without showing empty STRING fields.
 */
import { app } from "../../scripts/app.js";

const TYPES = new Set([
  "LCSamplerConfigure",
  "LCSamplerConfigurePipeOut",
  "LCSamplerConfigurePipe",
  "LCSamplerConfigureSimple",
  "LCSamplerConfigureSimplePipeOut",
  "LCSpeedBoostKSampler",
]);

const GAP_PX = 6;

function hideGaps(node) {
  if (!node?.widgets) return;
  for (const w of node.widgets) {
    const n = (w.name || "").toString();
    if (!n.startsWith("_gap")) continue;
    w.type = "converted-widget"; // not drawn as text field
    w.computeSize = () => [0, GAP_PX];
    w.draw = function () {};
    w.serializeValue = () => "";
    try {
      w.hidden = true;
    } catch (_) {}
  }
  // Force layout refresh
  try {
    node.setDirtyCanvas?.(true, true);
  } catch (_) {}
}

// A brand-new node was sized while the gap widgets were still full STRING fields, which left empty space at the
// bottom. Shrink it to what its widgets need now; nodes loaded from a workflow keep their size.
function fitHeight(node) {
  if (!node || node._lcCfgConfigured || !node.computeSize || !node.size) return;
  const h = node.computeSize([node.size[0], 0])?.[1];
  if (h && h < node.size[1]) {
    node.size = [node.size[0], h];
    node.setDirtyCanvas?.(true, true);
  }
}

app.registerExtension({
  name: "LC123.SamplerConfigureGaps",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (!TYPES.has(nodeData?.name)) return;
    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onCreated?.apply(this, arguments);
      hideGaps(this);
      fitHeight(this);
      requestAnimationFrame(() => {
        hideGaps(this);
        fitHeight(this);
      });
      // the add-node search dialog re-assigns size right after this hook
      setTimeout(() => fitHeight(this), 0);
      return r;
    };

    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      this._lcCfgConfigured = true; // restored from a workflow: keep its saved size
      return onConfigure?.apply(this, arguments);
    };
  },
  nodeCreated(node) {
    const t = node.comfyClass || node.type;
    if (TYPES.has(t)) hideGaps(node);
  },
});
