/**
 * LC Is Bypassed / Muted — socket-only face (true / false), same live-signal contract as
 * LC Invert Boolean, but reads the ORIGIN NODE's own .mode instead of coercing a value: bypass/mute
 * is frontend-only state that a real data wire can't carry (a muted node never executes at all), so
 * this is polled directly off the graph into a hidden widget, no queue needed.
 */

import { app } from "../../scripts/app.js";

const NODE_CLASS = "LCIsBypassedOrMuted";
const MODE_NEVER = 2; // Comfy mute
const MODE_BYPASS = 4;

function hideWidget(w) {
  if (!w) return;
  w.computeSize = () => [0, -4];
  w.draw = () => {};
  w.type = "hidden";
}

function ensureHiddenBoolean(node) {
  const w = node.widgets?.find((x) => x && x.name === "is_bypassed_or_muted");
  if (w) hideWidget(w);
  return w;
}

function originOf(node) {
  const inp = (node.inputs || []).find((i) => i && i.name === "value") || node.inputs?.[0];
  if (!inp || inp.link == null) return null;
  const link = app.graph?.links?.[inp.link];
  if (!link) return null;
  return app.graph.getNodeById?.(link.origin_id) || null;
}

function syncLive(node) {
  const origin = originOf(node);
  const w = ensureHiddenBoolean(node);
  if (!w) return null;
  const result = !!origin && (origin.mode === MODE_NEVER || origin.mode === MODE_BYPASS);
  if (w.value !== result) w.value = result;
  node._lcResult = result;
  return result;
}

app.registerExtension({
  name: "LC123.IsBypassedOrMuted",

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if ((nodeData?.name || "") !== NODE_CLASS) return;

    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onCreated?.apply(this, arguments);
      this.color = "#28281E";
      this.bgcolor = "#28281E";
      ensureHiddenBoolean(this);
      this.size = this.size || [200, 50];
      this.size[0] = Math.max(this.size[0] || 0, 180);
      if ((this.size[1] || 0) < 50) this.size[1] = 50;
      syncLive(this);
      return r;
    };

    const onDrawFG = nodeType.prototype.onDrawForeground;
    nodeType.prototype.onDrawForeground = function (ctx) {
      const r = onDrawFG?.apply(this, arguments);
      if (this.flags?.collapsed) return r;

      const out = syncLive(this);
      const label = out ? "true" : "false";
      const color = out ? "#6c6" : "#c66";

      const w = this.size?.[0] || 140;
      const h = this.size?.[1] || 50;
      ctx.save();
      ctx.font = "bold 12px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = color;
      ctx.fillText(label, w * 0.5, h * 0.55);
      ctx.restore();
      return r;
    };

    const onConn = nodeType.prototype.onConnectionsChange;
    nodeType.prototype.onConnectionsChange = function () {
      const r = onConn?.apply(this, arguments);
      syncLive(this);
      this.setDirtyCanvas?.(true, true);
      return r;
    };
  },

  async setup() {
    setInterval(() => {
      const graph = app.graph;
      if (!graph?._nodes) return;
      for (const n of graph._nodes) {
        if (n.type === NODE_CLASS || n.comfyClass === NODE_CLASS) {
          const prev = n._lcResult;
          syncLive(n);
          if (prev !== n._lcResult) n.setDirtyCanvas?.(true, true);
        }
      }
    }, 200);
  },
});

console.log("[LC123.IsBypassedOrMuted] hidden boolean widget + true/false face");
