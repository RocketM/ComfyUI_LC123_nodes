/**
 * LC Image Pass / LC Mask Pass — enable widget drives node mute (mode 2).
 * Muted node does not run; optional MASK/IMAGE consumers see no value.
 */
import { app } from "../../scripts/app.js";
import { NODE_PROPERTY_EVENT, graphEventsAvailable } from "./lc_graph_events.js";
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

// mode -> enable widget (right-click Mute / Ctrl+M on the node itself)
function syncEnableFromMode(node) {
  if (!node || node._lcPassLock) return;
  const w = (node.widgets || []).find((x) => x && x.name === "enable");
  if (!w) return;
  const muted = node.mode === MUTE;
  if (w.value !== !muted) {
    w.value = !muted;
    node.setDirtyCanvas?.(true, true);
  }
}

// Newer frontends never call onModeChange: a mode change is announced on the node's own graph as
// "node:property:changed". One listener per graph (root or subgraph), installed when a Pass node joins it.
const hookedGraphs = new WeakSet();
function hookGraph(graph) {
  if (!graphEventsAvailable(graph) || hookedGraphs.has(graph)) return;
  hookedGraphs.add(graph);
  graph.events.addEventListener(NODE_PROPERTY_EVENT, (e) => {
    const d = e?.detail;
    if (!d || d.property !== "mode") return;
    const node = graph.getNodeById?.(d.nodeId);
    if (!node || !(TYPES.has(node.type) || TYPES.has(node.comfyClass))) return;
    // a workflow load sets the saved mode before onConfigure: leave that to applyMute, as before
    if (!node._lcPassReady) return;
    syncEnableFromMode(node);
  });
}

app.registerExtension({
  name: "lc123.pass",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    const name = nodeData?.name;
    if (!TYPES.has(name)) return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated?.apply(this, arguments);
      this._lcPassReady = false;
      setTimeout(() => {
        this._lcPassReady = true;
      }, 0);
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
      hookGraph(this.graph);
      applyMute(this);
      this._lcPassReady = true;
      return r;
    };

    const onAdded = nodeType.prototype.onAdded;
    nodeType.prototype.onAdded = function () {
      const r = onAdded?.apply(this, arguments);
      hookGraph(this.graph);
      return r;
    };

    const onMode = nodeType.prototype.onModeChange;
    nodeType.prototype.onModeChange = function (mode) {
      const r = onMode?.apply(this, arguments);
      // older frontends call this; newer ones reach syncEnableFromMode through hookGraph
      syncEnableFromMode(this);
      return r;
    };
  },
});
