/**
 * LC Wildcard — strip auto control_after_generate; sync base_seed from ui.seed after run.
 */
import { app } from "../../scripts/app.js";

function stripAutoSeedControl(node) {
  if (!node?.widgets) return;
  for (let i = node.widgets.length - 1; i >= 0; i--) {
    const w = node.widgets[i];
    const n = (w?.name || "").toLowerCase();
    if (n === "control_after_generate" || n === "control_before_generate") {
      node.widgets.splice(i, 1);
    }
  }
}

app.registerExtension({
  name: "LC123.WildcardSeed",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== "LCWildcard") return;
    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onCreated?.apply(this, arguments);
      stripAutoSeedControl(this);
      requestAnimationFrame(() => stripAutoSeedControl(this));
      return r;
    };

    // per-node executed hook: ComfyUI resolves the execution id (also "12:5" style ids inside subgraphs)
    const onExecuted = nodeType.prototype.onExecuted;
    nodeType.prototype.onExecuted = function (output) {
      const r = onExecuted?.apply(this, arguments);
      try {
        const node = this;
        stripAutoSeedControl(node);

        const modeW = node.widgets?.find((w) => w.name === "seed_mode");
        const seedW = node.widgets?.find((w) => w.name === "base_seed");
        if (!seedW) return r;

        const mode = (modeW?.value || "fixed").toString().toLowerCase();
        if (mode === "fixed") return r;

        let used = null;
        if (output?.seed && output.seed.length) used = Number(output.seed[0]);
        if (used != null && !Number.isNaN(used)) {
          seedW.value = used;
          node.setDirtyCanvas?.(true, true);
        }
      } catch (_) {}
      return r;
    };
  },
});
