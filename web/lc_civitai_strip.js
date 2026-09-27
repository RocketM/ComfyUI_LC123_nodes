/**
 * CivitAI 🚩🔪: the enabled switch.
 * - A newly placed node starts OFF: the user has to switch it on.
 * - A node saved before the switch existed has no value for it: it loads ON, so it keeps stripping like it always did.
 * - A status line on the node says plainly whether text is being stripped or passed through.
 */
import { app } from "../../scripts/app.js";

const TYPE = "LCCivitaiStrip";
const enabledWidget = (node) => (node.widgets || []).find((w) => w && w.name === "enabled");

app.registerExtension({
  name: "LC123.CivitaiStrip",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== TYPE) return;

    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (info) {
      const r = onConfigure?.apply(this, arguments);
      const w = enabledWidget(this);
      const saved = info?.widgets_values;
      // saved before the switch: only list_file was stored, so the switch was never a choice. Keep it stripping.
      if (w && Array.isArray(saved) && saved.length < 2) w.value = true;
      return r;
    };

    // the switch reads as a switch: a plain label with ON / OFF (the name "enabled" stays for saved workflows)
    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated?.apply(this, arguments);
      const w = enabledWidget(this);
      if (w) {
        w.label = "strip listed terms";
        w.options = { ...(w.options || {}), on: "ON", off: "OFF" };
      }
      return r;
    };

    const onDrawForeground = nodeType.prototype.onDrawForeground;
    nodeType.prototype.onDrawForeground = function (ctx) {
      const r = onDrawForeground?.apply(this, arguments);
      if (this.flags?.collapsed) return r;
      const on = enabledWidget(this)?.value === true;
      const text = on ? "ON: listed terms are removed" : "OFF: text passes through unchanged";
      ctx.save();
      ctx.font = "bold 11px sans-serif";
      ctx.fillStyle = on ? "#86efac" : "#fca5a5";
      ctx.textAlign = "left";
      ctx.fillText(text, 10, this.size[1] - 8);
      ctx.restore();
      return r;
    };

    const computeSize = nodeType.prototype.computeSize;
    nodeType.prototype.computeSize = function () {
      const s = computeSize ? computeSize.apply(this, arguments) : [220, 80];
      return [Math.max(s[0], 230), s[1] + 18]; // room for the status line
    };
  },
});
