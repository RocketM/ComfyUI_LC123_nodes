/**
 * Nodes 2.0 only: what the classic canvas draws live, shown as it was at the last run instead.
 *
 * Nodes 2.0 never calls the canvas drawing LC nodes use for their previews and readouts, and it only shows a node's
 * standard "images" output. So in Nodes 2.0, after each run:
 * - Image FX / Skin / Phone / Text Overlay / Watermark / Compare: the result picture ("images")
 * - Image Crop: the cropped result; Sigma Curve: a picture of the curve; Dynamic Overlay: the blend, not input A
 * - Get Image, Image-Mask Resize and LC Boolean: their readout as a small text line on the node (never saved)
 * Nothing here runs on the classic canvas, and the readout lines are taken off again if Nodes 2.0 is switched off.
 */
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const vue = () => !!window.LiteGraph?.vueNodesMode;

// ---------------------------------------------------------------- pictures
function pictureFor(out) {
  if (out.lc_result?.length) return out.lc_result; // Image Crop: the crop, not the source
  if (out.lc_plot?.length) return out.lc_plot; // Sigma Curve
  if (out.images?.length) {
    const blend = out.images.filter((m) => String(m?.filename || "").startsWith("lc_ov_out")); // Dynamic Overlay
    return blend.length && blend.length < out.images.length ? blend : null; // anything else already shows itself
  }
  return out.lc_preview || out.a_images || out.lc_before || null;
}

// ---------------------------------------------------------------- readout line
// A small text line under the node's widgets, Nodes 2.0 only. It is never saved (serialize: false), and it is taken
// off again when Nodes 2.0 is switched off, so the classic node looks exactly as before.
const READOUT = "lc_readout";
function setReadout(node, text) {
  if (!node) return;
  let w = (node.widgets || []).find((x) => x.name === READOUT);
  if (!text) {
    if (w) removeReadout(node, w);
    return;
  }
  if (!w) {
    const div = document.createElement("div");
    div.style.cssText = "font:12px sans-serif;color:#e5e7eb;padding:4px 6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
    w = node.addDOMWidget(READOUT, "LC_READOUT", div, { serialize: false, getMinHeight: () => 24, getMaxHeight: () => 24 });
    w.serialize = false;
  }
  w.element.textContent = text;
  w.element.title = text;
  node.setDirtyCanvas?.(true, true);
}
function removeReadout(node, w) {
  try {
    if (typeof node.removeWidget === "function") node.removeWidget(w);
    else {
      node.widgets.splice(node.widgets.indexOf(w), 1);
      w.onRemove?.();
    }
  } catch (_) {}
}
function clearReadouts() {
  for (const g of [app.graph, ...(app.graph?.subgraphs?.values?.() || [])])
    for (const n of g?._nodes || []) {
      n._lcVueTag = undefined;
      if (n.widgets?.some((x) => x.name === READOUT)) setReadout(n, null);
    }
}
function readoutFor(out) {
  if (out.lc_mp && out.lc_w && out.lc_h) return `${out.lc_mp[0]} MP · ${out.lc_w[0]}×${out.lc_h[0]} · ${out.lc_aspect?.[0] ?? ""} · batch ${out.lc_batch?.[0] ?? 1}`;
  if (out.lc_size?.length) return String(out.lc_size[0]);
  return null;
}

api.addEventListener("executed", ({ detail }) => {
  if (!vue()) return;
  const out = detail?.output;
  if (!out) return;
  const key = String(detail.display_node || detail.node);
  // LC Preview Image / Mask draw their own window (a DOM widget, fine in Nodes 2.0): a copy would show it twice
  const node = app.graph?.getNodeById?.(Number(key)) || app.graph?.getNodeById?.(key);
  if (["LCPreviewImage", "LCPreviewMask"].includes(node?.comfyClass || node?.type)) return;
  const pics = pictureFor(out);
  const text = readoutFor(out);
  // after the frontend has stored this node's output (it would overwrite an earlier write)
  setTimeout(() => {
    try {
      if (pics) app.nodeOutputs[key] = { ...(app.nodeOutputs?.[key] || {}), images: pics };
      if (text) setReadout(app.graph?.getNodeById?.(Number(key)) || app.graph?.getNodeById?.(key), text);
    } catch (_) {}
  }, 0);
});

// LC Boolean has no run output: its live true / false becomes the readout line (Invert / Is Bypassed draw fine in Nodes 2.0)
let wasVue = null;
setInterval(() => {
  const v = vue();
  if (v !== wasVue) {
    if (wasVue && !v) clearReadouts(); // back to classic: no readout lines left behind
    wasVue = v;
  }
  if (!v) return;
  for (const n of app.graph?._nodes || []) {
    if (n.type !== "LCBoolean" && n.comfyClass !== "LCBoolean") continue;
    const val = n._lcBool;
    const text = val === undefined ? null : String(!!val);
    if (n._lcVueTag !== text) {
      n._lcVueTag = text;
      setReadout(n, text === null ? null : `value: ${text}`);
    }
  }
}, 500);
