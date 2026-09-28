/**
 * LC Is Bypassed / Muted — socket-only face (true / false), same live-signal contract as
 * LC Invert Boolean, but reads the ORIGIN NODE's own .mode instead of coercing a value: bypass/mute
 * is frontend-only state that a real data wire can't carry (a muted node never executes at all), so
 * this is polled directly off the graph into a hidden widget, no queue needed.
 */

import { app } from "../../scripts/app.js";
import { NODE_PROPERTY_EVENT, graphEventsAvailable } from "./lc_graph_events.js";

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
  const g = node.graph ?? app.graph; // the node's own graph, so it also works inside a subgraph
  const link = g?.links?.[inp.link];
  if (!link) return null;
  return g.getNodeById?.(link.origin_id) || null;
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

// re-read one node and redraw it only when the result changed
function refresh(node) {
  const prev = node._lcResult;
  syncLive(node);
  if (prev !== node._lcResult) node.setDirtyCanvas?.(true, true);
}

// live instances, so the timer costs nothing in a workflow without this node
const live = new Set();

// Mode changes are announced on each graph (root or subgraph) as "node:property:changed": one listener per graph
// re-reads this graph's instances the moment any node's mode changes.
const hookedGraphs = new WeakSet();
function hookGraph(graph) {
  if (!graphEventsAvailable(graph) || hookedGraphs.has(graph)) return;
  hookedGraphs.add(graph);
  graph.events.addEventListener(NODE_PROPERTY_EVENT, (e) => {
    if (e?.detail?.property !== "mode" || !live.size) return;
    for (const n of live) {
      if (n.graph === graph) refresh(n);
    }
  });
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
      live.add(this);
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

      // drawn from the cached result: mode events, connection changes and the fallback timer keep it current
      const out = this._lcResult === undefined ? syncLive(this) : this._lcResult;
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

    const onAdded = nodeType.prototype.onAdded;
    nodeType.prototype.onAdded = function () {
      const r = onAdded?.apply(this, arguments);
      live.add(this);
      hookGraph(this.graph);
      return r;
    };

    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      const r = onConfigure?.apply(this, arguments);
      live.add(this);
      hookGraph(this.graph);
      // links may still be loading: forget the cached result so the first draw (or the next tick) reads it fresh
      this._lcResult = undefined;
      setTimeout(() => {
        if (this.graph) refresh(this);
      }, 0);
      return r;
    };

    const onRemoved = nodeType.prototype.onRemoved;
    nodeType.prototype.onRemoved = function () {
      const r = onRemoved?.apply(this, arguments);
      live.delete(this);
      return r;
    };
  },

  async setup() {
    // Safety net only: mode events and onConnectionsChange update the face at once. Graphs with events get a full
    // re-read once a second; a frontend without graph events keeps the old 200 ms poll.
    let lastFull = 0;
    setInterval(() => {
      if (!live.size) return;
      const now = Date.now();
      const full = now - lastFull >= 1000;
      if (full) lastFull = now;
      for (const n of live) {
        const g = n.graph;
        if (!g) continue;
        hookGraph(g);
        if (g.events && !full) continue;
        refresh(n);
      }
    }, 200);
  },
});

console.log("[LC123.IsBypassedOrMuted] hidden boolean widget + true/false face");
