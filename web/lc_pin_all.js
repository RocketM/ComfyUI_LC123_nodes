// LC Pin (all) / Unpin (all)
// Right-click menu entries that pin or unpin every node and group in the graph you are looking at, nothing
// selected needed. Each item is checked first and only changed if it is not already in that state, so a
// half-pinned workflow ends up fully pinned (or fully unpinned). Nothing is locked: pin or unpin anything by
// hand afterwards as usual.
import { app } from "../../scripts/app.js";

function setAll(pinned) {
  const canvas = app.canvas;
  const graph = canvas?.graph || app.graph;
  if (!graph) return;
  let changed = 0;
  for (const node of graph._nodes || graph.nodes || []) {
    if (!!node.pinned !== pinned && typeof node.pin === "function") {
      node.pin(pinned);
      changed++;
    }
  }
  for (const group of graph._groups || graph.groups || []) {
    if (!!group.pinned !== pinned && typeof group.pin === "function") {
      group.pin(pinned);
      changed++;
    }
  }
  if (changed) {
    canvas?.setDirty?.(true, true);
    const ct = app.extensionManager?.workflow?.activeWorkflow?.changeTracker;
    if (typeof ct?.captureCanvasState === "function") ct.captureCanvasState(); // replaced checkState in newer frontends
    else ct?.checkState?.();
  }
}

const items = () => [
  { content: "Pin (all)", callback: () => setAll(true) },
  { content: "Unpin (all)", callback: () => setAll(false) },
];

// put the two entries right under the menu's own Pin / Unpin
function insertAfterPin(options) {
  if (!Array.isArray(options)) return options;
  if (options.some((o) => o?.content === "Pin (all)")) return options;
  const i = options.findIndex((o) => o && (o.content === "Pin" || o.content === "Unpin"));
  if (i >= 0) options.splice(i + 1, 0, ...items());
  else options.push(null, ...items());
  return options;
}

function wrap(proto, name) {
  const orig = proto?.[name];
  if (typeof orig !== "function" || orig._lcPinAll) return;
  const wrapped = function (...args) {
    return insertAfterPin(orig.apply(this, args));
  };
  wrapped._lcPinAll = true;
  proto[name] = wrapped;
}

app.registerExtension({
  name: "LC123.PinAll",
  // empty canvas right-click: nothing has to be selected
  getCanvasMenuItems() {
    return [null, ...items()];
  },
  setup() {
    // node right-click (the frontend has already added its extension hooks by now, so this wraps the final menu)
    wrap(app.canvas?.constructor?.prototype, "getNodeMenuOptions");
    // group right-click
    wrap(window.LiteGraph?.LGraphGroup?.prototype, "getMenuOptions");
  },
});
