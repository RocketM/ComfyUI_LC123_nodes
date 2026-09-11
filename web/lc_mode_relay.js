/**
 * LC Bypass Relay — JS-only virtual node, same registration as LC Bypasser.
 */
import { app } from "../../scripts/app.js";

const TYPE = "LC Bypass Relay";
const TYPE_PY = "LCBypassRelay";
const TYPES = new Set([TYPE, TYPE_PY]);
const HUBS = new Set(["LC Bypasser", "LC Mute"]);
const COLOR = "#28281E";
const LIVE = 0;
const MUTE = 2;
const BYPASS = 4;

function graph() {
  return app.graph || app.canvas?.graph || null;
}

function linkById(g, id) {
  if (!g || id == null) return null;
  if (g.links?.[id]) return g.links[id];
  if (typeof g.getLink === "function") {
    try { return g.getLink(id); } catch (_) {}
  }
  if (g.links && typeof g.links.get === "function") {
    try { return g.links.get(id); } catch (_) {}
  }
  return null;
}

function nodeById(g, id) {
  return g?.getNodeById?.(id) || null;
}

function originOf(g, input) {
  if (!input || input.link == null) return null;
  const l = linkById(g, input.link);
  if (!l) return null;
  return nodeById(g, l.origin_id ?? l.sourceId ?? l.fromId);
}

function allNodes(g) {
  if (!g) return [];
  if (Array.isArray(g._nodes)) return g._nodes;
  if (Array.isArray(g.nodes)) return g.nodes;
  return [];
}

function allLinks(g) {
  const L = g?.links;
  if (!L) return [];
  if (Array.isArray(L)) return L.filter(Boolean);
  if (typeof L.values === "function") return [...L.values()].filter(Boolean);
  return Object.values(L).filter((x) => x && typeof x === "object");
}

function setMode(n, mode) {
  if (!n || n.mode === mode) return;
  n.mode = mode;
  try {
    n.onModeChange?.(mode);
    n.setDirtyCanvas?.(true, true);
  } catch (_) {}
}

function grow(node) {
  if (!node.inputs) node.inputs = [];
  const last = node.inputs[node.inputs.length - 1];
  if (!last || last.link != null) node.addInput("", "*");
  let empty = 0;
  for (let i = node.inputs.length - 1; i >= 0; i--) {
    if (node.inputs[i]?.link == null) {
      empty++;
      if (empty > 1) node.removeInput(i);
    }
  }
}

function isRelay(n) {
  return n && TYPES.has(n.type);
}

function hubMode(relay, g) {
  for (const hub of allNodes(g)) {
    if (!HUBS.has(hub.type)) continue;
    const pairs = Math.floor((hub.inputs?.length || 0) / 2);
    for (let p = 0; p < pairs; p++) {
      const o = originOf(g, hub.inputs[p * 2]);
      if (!o || o.id !== relay.id) continue;
      const w = hub.widgets?.[p];
      const on = !w || w.value !== false;
      if (on) return LIVE;
      return hub.type === "LC Mute" || hub._lcOffMode === MUTE ? MUTE : BYPASS;
    }
  }
  return null;
}

function stamp(relay) {
  const g = graph();
  if (!g || !relay) return;
  let mode = hubMode(relay, g);
  if (mode == null) {
    mode = relay.mode === MUTE || relay.mode === BYPASS ? relay.mode : LIVE;
  }
  relay._lcMode = mode;
  setMode(relay, mode);
  for (const inp of relay.inputs || []) {
    if (!inp || inp.link == null) continue;
    const o = originOf(g, inp);
    if (o && !HUBS.has(o.type) && !isRelay(o)) setMode(o, mode);
  }
  for (const l of allLinks(g)) {
    const tid = l.target_id ?? l.targetId ?? l.toId;
    if (tid !== relay.id) continue;
    const child = nodeById(g, l.origin_id ?? l.sourceId ?? l.fromId);
    if (child && !HUBS.has(child.type) && !isRelay(child)) setMode(child, mode);
  }
}

app.registerExtension({
  name: "LC123.BypassRelay",

  registerCustomNodes() {
    class LCBypassRelayNode extends LGraphNode {
      constructor(title) {
        const t =
          typeof title === "string" && title.trim() && title !== "Unnamed"
            ? title
            : TYPE;
        super(t);
        this.isVirtualNode = true;
        this.addInput("", "*");
        this.addOutput("OPT_CONNECTION", "*");
        this.color = COLOR;
        this.bgcolor = COLOR;
        this.size = [270, 64];
        this._lcMode = LIVE;
      }
      onConnectionsChange() {
        grow(this);
        stamp(this);
      }
      onDrawForeground(ctx) {
        if (this.flags?.collapsed) return;
        const m = this._lcMode ?? LIVE;
        ctx.save();
        ctx.font = "bold 11px sans-serif";
        ctx.textAlign = "center";
        ctx.fillStyle = m === LIVE ? "#6c6" : m === MUTE ? "#c66" : "#fc0";
        ctx.fillText(
          m === MUTE ? "MUTE" : m === BYPASS ? "BYPASS" : "ACTIVE",
          (this.size?.[0] || 270) * 0.5,
          (this.size?.[1] || 64) - 8
        );
        ctx.restore();
      }
    }

    LCBypassRelayNode.title = TYPE;
    LCBypassRelayNode.type = TYPE;
    LCBypassRelayNode.category = "LC123/utils";
    LCBypassRelayNode.comfyClass = TYPE;
    LiteGraph.registerNodeType(TYPE, LCBypassRelayNode);
    LiteGraph.registerNodeType(TYPE_PY, LCBypassRelayNode);
    console.log("[LC123.BypassRelay] LiteGraph registered", TYPE);
  },

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (!TYPES.has(nodeData?.name)) return;
    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onCreated?.apply(this, arguments);
      this.color = this.color || COLOR;
      this.bgcolor = this.bgcolor || COLOR;
      if (!this.inputs?.length) this.addInput("", "*");
      if (!this.outputs?.length) this.addOutput("OPT_CONNECTION", "*");
      grow(this);
      return r;
    };
    const onConn = nodeType.prototype.onConnectionsChange;
    nodeType.prototype.onConnectionsChange = function () {
      const r = onConn?.apply(this, arguments);
      grow(this);
      stamp(this);
      return r;
    };
  },

  async setup() {
    setInterval(() => {
      try {
        for (const n of allNodes(graph())) {
          if (isRelay(n)) stamp(n);
        }
      } catch (_) {}
    }, 80);
  },
});
