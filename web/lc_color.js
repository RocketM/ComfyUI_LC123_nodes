/**
 * Launch color for LC nodes: apply pack default only if the node still has
 * Comfy stock / empty color. Never overwrite a user-chosen or workflow-saved color.
 *
 * Comfy's own palette colors (green #232, blue #223, black #222/#000) look like "stock" to the
 * check below, and several nodes repaint after the saved workflow has been applied. So the ids of
 * every node that carries a saved color are remembered when a graph loads, and those nodes are
 * never repainted.
 */
import { app } from "../../scripts/app.js";

const savedColorIds = new Set();

function collectSavedColors(graphData) {
  const add = (nodes) => {
    for (const n of nodes || []) {
      if (n && (n.color || n.bgcolor)) savedColorIds.add(String(n.id));
    }
  };
  add(graphData?.nodes);
  for (const sg of graphData?.definitions?.subgraphs || []) add(sg?.nodes);
}

export function lcHasSavedColor(node) {
  return !!node && savedColorIds.has(String(node.id));
}

app.registerExtension({
  name: "LC123.SavedColorLock",
  beforeConfigureGraph(graphData) {
    savedColorIds.clear();
    try { collectSavedColors(graphData); } catch (_) {}
  },
});

const STOCK = new Set([
  "",
  "#333",
  "#333333",
  "#353535",
  "#232",
  "#223",
  "#222",
  "#222222",
  "#2a2a2a",
  "#1a1a1a",
  "#444",
  "#444444",
  "#3d3d3d",
  "#0f0f0f",
  "#111",
  "#111111",
  "#000",
  "#000000",
]);

function norm(c) {
  return String(c ?? "").trim().toLowerCase();
}

export function lcColorIsStock(c) {
  const n = norm(c);
  if (!n || n === "undefined" || n === "null") return true;
  return STOCK.has(n);
}

export function lcApplyLaunchColor(node, color, bgcolor) {
  if (!node) return;
  if (lcHasSavedColor(node)) return;
  if (!lcColorIsStock(node.color)) return;
  try {
    node.color = color;
    node.bgcolor = bgcolor || color;
  } catch (_) {}
}

export function lcRestoreSerializedColor(node, data) {
  if (!node || !data || !data.color) return false;
  if (lcColorIsStock(data.color)) return false;
  try {
    node.color = data.color;
    node.bgcolor = data.bgcolor || data.color;
  } catch (_) {}
  return true;
}
