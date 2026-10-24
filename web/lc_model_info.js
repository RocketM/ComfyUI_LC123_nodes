/**
 * LC Model Info ℹ️ — shows what the wired model's files say about themselves, live (no queue needed).
 * The report comes from /lc123/model_info, which follows the model wire upstream on the server. It refreshes when the
 * node is wired, when the workflow loads, whenever something on the model wire upstream changes, and after a run.
 */
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { ComfyWidgets } from "../../scripts/widgets.js";
import { lcApplyLaunchColor } from "./lc_color.js";

const TYPE = "LCModelInfo";
const COLOR = "#28281E";
const DEFAULT_SIZE = [420, 300];
const EMPTY = "Wire a MODEL output into this node.";

function display(node) {
  let w = node.widgets?.find((x) => x.name === "lc_info");
  if (w) return w;
  try {
    w = ComfyWidgets["STRING"](node, "lc_info", ["STRING", { multiline: true }], app).widget;
  } catch (_) {
    return null;
  }
  w.serialize = false; // never saved into widgets_values or sent as an input
  w.options = { ...(w.options || {}), serialize: false };
  if (w.inputEl) {
    w.inputEl.readOnly = true;
    w.inputEl.style.opacity = "0.9";
    w.inputEl.placeholder = EMPTY;
  }
  return w;
}

function show(node, text) {
  const w = display(node);
  if (!w) return;
  w.value = text;
  if (w.inputEl) w.inputEl.value = text;
  node.properties = node.properties || {};
  node.properties.lc_display_text = text;
  node.graph?.setDirtyCanvas?.(true, true);
}

/** Ids, modes and widget values of everything upstream on the model wire: changes here mean a new report. */
function upstreamSig(node) {
  const g = node.graph;
  if (!g) return "";
  const parts = [];
  const seen = new Set();
  const walk = (n, depth) => {
    if (!n || seen.has(n.id) || depth > 60) return;
    seen.add(n.id);
    parts.push(`${n.id}:${n.mode}:${JSON.stringify((n.widgets || []).map((w) => w.value))}`);
    for (const inp of n.inputs || []) {
      if (inp.link == null || !/model/i.test(inp.name || "")) continue;
      const link = g.links?.[inp.link] ?? g.links?.get?.(inp.link);
      if (link) walk(g.getNodeById(link.origin_id), depth + 1);
    }
  };
  walk(node, 0);
  return parts.join("|");
}

// the id this node has in the prompt: its plain id at the root, "outer:inner" inside a subgraph
function execIdOf(node, g = app.rootGraph || app.graph, prefix = "") {
  for (const n of g?._nodes || []) {
    if (n === node) return prefix + n.id;
    if (n.subgraph) {
      const hit = execIdOf(node, n.subgraph, prefix + n.id + ":");
      if (hit) return hit;
    }
  }
  return null;
}

async function refresh(node) {
  const inp = node.inputs?.find((i) => i.name === "model");
  if (!inp || inp.link == null) {
    show(node, EMPTY);
    return;
  }
  const ticket = (node._lcInfoTicket = (node._lcInfoTicket || 0) + 1);
  try {
    const p = await app.graphToPrompt();
    const r = await api.fetchApi("/lc123/model_info", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: p.output, node_id: execIdOf(node) || String(node.id) }),
    });
    const j = await r.json();
    if (ticket === node._lcInfoTicket) show(node, j.info || EMPTY);
  } catch (e) {
    if (ticket === node._lcInfoTicket) show(node, `Couldn't read the model info: ${e?.message || e}`);
  }
}

function schedule(node, ms = 400) {
  clearTimeout(node._lcInfoTimer);
  node._lcInfoTimer = setTimeout(() => refresh(node), ms);
}

function watch(node) {
  if (node._lcInfoWatch) return;
  node._lcInfoWatch = setInterval(() => {
    if (!node.graph || app.canvas?.graph !== node.graph) return; // only the workflow on screen
    const sig = upstreamSig(node);
    if (sig !== node._lcInfoSig) {
      node._lcInfoSig = sig;
      schedule(node, 300);
    }
  }, 1500);
}

app.registerExtension({
  name: "LC123.ModelInfo",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== TYPE) return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated?.apply(this, arguments);
      lcApplyLaunchColor(this, COLOR);
      display(this);
      if (!this.size || this.size[0] < DEFAULT_SIZE[0]) this.size = [...DEFAULT_SIZE];
      watch(this);
      return r;
    };

    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (data) {
      const saved = Array.isArray(data?.size) ? [data.size[0], data.size[1]] : null;
      const r = onConfigure?.apply(this, arguments);
      lcApplyLaunchColor(this, COLOR);
      if (saved && saved[0] > 40 && saved[1] > 40) this.size = saved;
      const text = this.properties?.lc_display_text;
      if (text != null) requestAnimationFrame(() => show(this, String(text)));
      this._lcInfoSig = ""; // the watcher refreshes it once the graph is in place
      return r;
    };

    const onConnectionsChange = nodeType.prototype.onConnectionsChange;
    nodeType.prototype.onConnectionsChange = function () {
      const r = onConnectionsChange?.apply(this, arguments);
      schedule(this);
      return r;
    };

    const onRemoved = nodeType.prototype.onRemoved;
    nodeType.prototype.onRemoved = function () {
      clearInterval(this._lcInfoWatch);
      clearTimeout(this._lcInfoTimer);
      return onRemoved?.apply(this, arguments);
    };

    const onExecuted = nodeType.prototype.onExecuted;
    nodeType.prototype.onExecuted = function (message) {
      onExecuted?.apply(this, arguments);
      const t = message?.text;
      if (t != null) show(this, Array.isArray(t) ? t.join("") : String(t));
    };
  },
});
