/**
 * LC Image Pass / LC Mask Pass — enable widget drives node mute (mode 2).
 * Muted node does not run; optional MASK/IMAGE consumers see no value.
 */
import { app } from "../../scripts/app.js";
import { lcApplyLaunchColor } from "./lc_color.js";

const TYPES = new Set(["LCImagePass", "LCMaskPass"]);
const MUTE = 2;
const LIVE = 0;

function enableValue(node) {
  const w = (node.widgets || []).find((x) => x && x.name === "enable");
  if (!w) return true;
  const v = w.value;
  if (v === false || v === 0 || v === "0" || v === "false") return false;
  return !!v;
}

function applyMute(node) {
  if (!node || node._lcPassLock) return;
  const on = enableValue(node);
  const want = on ? LIVE : MUTE;
  if (node.mode === want) return;
  node._lcPassLock = true;
  try {
    node.mode = want;
    node.setDirtyCanvas?.(true, true);
  } finally {
    node._lcPassLock = false;
  }
}

app.registerExtension({
  name: "lc123.pass",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    const name = nodeData?.name;
    if (!TYPES.has(name)) return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated?.apply(this, arguments);
      lcApplyLaunchColor(this);
      this.color = "#28281E";
      this.bgcolor = "#28281E";
      const w = (this.widgets || []).find((x) => x && x.name === "enable");
      if (w) {
        const prev = w.callback;
        w.callback = (...args) => {
          prev?.apply(this, args);
          applyMute(this);
        };
      }
      applyMute(this);
      return r;
    };

    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      const r = onConfigure?.apply(this, arguments);
      applyMute(this);
      return r;
    };

    const onMode = nodeType.prototype.onModeChange;
    nodeType.prototype.onModeChange = function (mode) {
      const r = onMode?.apply(this, arguments);
      if (this._lcPassLock) return r;
      const w = (this.widgets || []).find((x) => x && x.name === "enable");
      if (!w) return r;
      const muted = this.mode === MUTE;
      if (w.value === !muted) {
        w.value = !muted;
        this.setDirtyCanvas?.(true, true);
      }
      return r;
    };
  },
});
