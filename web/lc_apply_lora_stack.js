/**
 * LC Apply LoRA Stack — deliberately minimal: standard widgets only (bypass checkbox, model/clip/lora_stack
 * sockets), no custom face. All it does here is set the pack's launch color.
 */
import { app } from "../../scripts/app.js";
import { lcApplyLaunchColor } from "./lc_color.js";

app.registerExtension({
  name: "LC123.ApplyLoraStack",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== "LCApplyLoraStack") return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated?.apply(this, arguments);
      lcApplyLaunchColor(this, "#6e5032");
      return r;
    };
  },
});
