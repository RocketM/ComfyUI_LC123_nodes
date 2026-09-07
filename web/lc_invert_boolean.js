/**
 * LC Invert Boolean — socket-only face (true / false), Flip-style live signal.
 *
 * LC Bypasser / Mute resolve BOOLEAN by reading a widget named
 * value|boolean|… on the origin, then invert if the origin looks like Flip/Invert.
 * This node has no visible widget, so we keep a hidden `boolean` widget that
 * stores the *upstream* (pre-invert) value — same contract as LC Boolean Flip.
 */

import { app } from "../../scripts/app.js";

const NODE_CLASS = "LCInvertBoolean";

function coerceBool(v) {
  if (v === true || v === false) return v;
  if (v === 1 || v === "1" || v === "true" || v === "yes" || v === "on") return true;
  if (v === 0 || v === "0" || v === "false" || v === "no" || v === "off") return false;
  if (typeof v === "number") return v !== 0;
  return null;
}

function isInvertNode(node) {
  if (!node) return false;
  const s = `${node.type || ""} ${node.comfyClass || ""} ${node.title || ""}`.toLowerCase();
  return /invert|flip|negate|boolean.?not|not.?boolean|lcinvert/.test(s);
}

function readWidgets(origin) {
  if (!origin?.widgets?.length) return null;
  const preferred = ["value", "boolean", "boolean_value", "toggle", "enabled", "enable"];
  for (const name of preferred) {
    const w = origin.widgets.find((x) => x && x.name === name);
    if (!w) continue;
    const c = coerceBool(w.value);
    if (c !== null) return c;
    if (w.type === "toggle") return !!w.value;
  }
  for (const w of origin.widgets) {
    if (!w) continue;
    const c = coerceBool(w.value);
    if (c !== null) return c;
    if (w.type === "toggle") return !!w.value;
  }
  return null;
}

function resolveBoolean(graph, input, depth = 0) {
  if (!input || input.link == null || !graph || depth > 24) return null;
  const link = graph.links?.[input.link];
  if (!link) return null;
  const origin = graph.getNodeById?.(link.origin_id);
  if (!origin) return null;

  const invert = isInvertNode(origin);

  const boolIns = (origin.inputs || []).filter(
    (i) =>
      i &&
      (i.type === "BOOLEAN" ||
        i.type === "boolean" ||
        String(i.name || "").toLowerCase().includes("bool") ||
        String(i.name || "").toLowerCase() === "value")
  );
  for (const bi of boolIns) {
    if (bi.link == null) continue;
    const up = resolveBoolean(graph, bi, depth + 1);
    if (up !== null) return invert ? !up : up;
  }
  if (!boolIns.some((i) => i.link != null)) {
    for (const bi of origin.inputs || []) {
      if (!bi || bi.link == null) continue;
      const up = resolveBoolean(graph, bi, depth + 1);
      if (up !== null) return invert ? !up : up;
    }
  }

  const local = readWidgets(origin);
  if (local !== null) return invert ? !local : local;
  return null;
}

function rawUpstream(node) {
  const inp = (node.inputs || []).find((i) => i && i.name === "value") || node.inputs?.[0];
  if (!inp || inp.link == null) return null;
  return resolveBoolean(app.graph, inp);
}

function hideWidget(w) {
  if (!w) return;
  w.computeSize = () => [0, -4];
  w.draw = () => {};
  w.type = "hidden";
}

function ensureHiddenBoolean(node) {
  if (!node.widgets) node.widgets = [];
  let w = node.widgets.find((x) => x && x.name === "boolean");
  if (!w) {
    w = node.addWidget("toggle", "boolean", false, () => {}, { serialize: false });
    hideWidget(w);
  } else {
    hideWidget(w);
  }
  return w;
}

function syncLive(node) {
  const raw = rawUpstream(node);
  const w = ensureHiddenBoolean(node);
  if (raw !== null && w.value !== raw) {
    w.value = raw;
  }
  node._lcRaw = raw;
  node._lcBool = raw === null ? null : !raw;
  return node._lcBool;
}

app.registerExtension({
  name: "LC123.InvertBoolean",

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if ((nodeData?.name || "") !== NODE_CLASS) return;

    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onCreated?.apply(this, arguments);
      this.color = "#28281E";
      this.bgcolor = "#28281E";
      for (const w of this.widgets || []) {
        if (w.name === "value" || w.name === "boolean") hideWidget(w);
      }
      ensureHiddenBoolean(this);
      this.size = this.size || [270, 50];
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
      const label = out === null ? "—" : out ? "true" : "false";
      const color = out === null ? "#888" : out ? "#6c6" : "#c66";

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
          const prev = n._lcBool;
          syncLive(n);
          if (prev !== n._lcBool) n.setDirtyCanvas?.(true, true);
        }
      }
    }, 200);
  },
});

console.log("[LC123.InvertBoolean] hidden boolean widget + true/false face");
