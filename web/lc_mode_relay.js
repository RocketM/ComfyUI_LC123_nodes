/**
 * LC Bypass Relay — JS-only virtual node, same registration as LC Bypasser.
 */
import { app } from "../../scripts/app.js";

const TYPE = "LCBypassRelay";
const TYPES = new Set([TYPE]);
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

function hug(node) {
  const slots = (node.inputs || []).filter((i) => i && i.type !== "BOOLEAN").length;
  const h = Math.max(52, 28 + slots * 24);
  if (!node.size) node.size = [270, h];
  node.size[0] = Math.max(node.size[0] || 270, 240);
  node.size[1] = h;
}

function grow(node) {
  if (!node.inputs) node.inputs = [];
  const stars = node.inputs.filter((i) => i && i.type !== "BOOLEAN");
  stars.forEach((inp, i) => {
    inp.name = "any_" + (i + 1);
    inp.type = "*";
  });
  if (!stars.length) node.addInput("any_1", "*");
  const last = node.inputs.filter((i) => i && i.type !== "BOOLEAN").pop();
  const filled = last && last.link != null;
  const count = node.inputs.filter((i) => i && i.type !== "BOOLEAN").length;
  if (filled && count < 16) node.addInput("any_" + (count + 1), "*");
  let empty = 0;
  for (let i = node.inputs.length - 1; i >= 0; i--) {
    const inp = node.inputs[i];
    if (!inp || inp.type === "BOOLEAN") continue;
    if (inp.link == null) {
      empty++;
      if (empty > 1) node.removeInput(i);
    }
  }
  hug(node);
}

const OLD_TYPES = new Set([
  "LC Bypass Relay",
  "LC Mute Bypass Relay",
  "LC Mute Bypass Repeater",
  "LC Bypass Fanout",
]);

function remapType(node) {
  if (!node) return;
  if (OLD_TYPES.has(node.type)) {
    node.type = TYPE;
    node.comfyClass = TYPE;
    node.constructor.comfyClass = TYPE;
  }
}

function isRelay(n) {
  return n && TYPES.has(n.type);
}

function patchHubSettle() {
  for (const hubType of HUBS) {
    const cls = LiteGraph.registered_node_types?.[hubType];
    if (!cls || cls.prototype._lcSettlePatched) continue;
    cls.prototype._lcSettlePatched = true;
    const onCfg = cls.prototype.onConfigure;
    cls.prototype.onConfigure = function (info) {
      const r = onCfg?.apply(this, arguments);
      this._lcHubReady = false;
      clearTimeout(this._lcHubReadyTimer);
      this._lcHubReadyTimer = setTimeout(() => {
        this._lcHubReady = true;
      }, 1500);
      return r;
    };
  }
}

function hubMode(relay, g) {
  for (const hub of allNodes(g)) {
    if (!HUBS.has(hub.type)) continue;
    if (hub._lcHubReady === false || hub._lcStabilizing) continue;
    const pairs = Math.floor((hub.inputs?.length || 0) / 2);
    for (let p = 0; p < pairs; p++) {
      const o = originOf(g, hub.inputs[p * 2]);
      if (!o || o.id !== relay.id) continue;
      const w = hub.widgets?.[p];
      // Connections can arrive before the hub has rebuilt its toggle widgets.
      if (!w) return null;
      const on = w.value !== false;
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

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== TYPE) return;
    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onCreated?.apply(this, arguments);
      this.color = this.color || COLOR;
      this.bgcolor = this.bgcolor || COLOR;
      if (!this.inputs?.length) this.addInput("", "*");
      if (!this.outputs?.length) this.addOutput("OPT_CONNECTION", "*");
      grow(this);
      this.properties = this.properties || {};
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

  loadedGraphNode(node) {
    remapType(node);
  },

  async setup() {
    setInterval(() => {
      try {
        patchHubSettle();
        for (const n of allNodes(graph())) {
          if (isRelay(n)) stamp(n);
        }
      } catch (_) {}
    }, 80);
  },
});

console.log("[LC123.BypassRelay] chrome on LCBypassRelay");
