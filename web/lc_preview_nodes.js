/**
 * LC Preview Image / LC Preview Mask - the on-node preview window.
 * Standard LC image window: 300 wide, 268 x 335 preview, 16 px padding. With no signal the window just stays empty
 * (dark for the image node, black for the mask node). Drawn as a DOM widget so it works in classic and Nodes 2.0.
 */
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { lcApplyLaunchColor } from "./lc_color.js";

const NODE_W = 300;
// smallest the nodes may be dragged to: a third smaller than the LC standard minimum (the launch size stays 300 x 413)
const MIN_NODE_W = 140;
const MIN_NODE_H = 199;
const MIN_WIDGET_H = 173;
const PREVIEW_H = 335;
const PAD = 16;
const SIZE_H = 16; // the "1024 x 1024" line under the image

const KINDS = {
  LCPreviewImage: { empty: "#1a1f1f" },
  LCPreviewMask: { empty: "#000000" },
};

function viewUrl(d) {
  const rand = typeof app.getRandParam === "function" ? app.getRandParam() : "";
  return api.apiURL(
    `/view?filename=${encodeURIComponent(d.filename)}&type=${d.type || "temp"}&subfolder=${encodeURIComponent(d.subfolder || "")}${rand}`
  );
}

// the preview window is display only: let every click fall through to the node underneath, so the node can be dragged
// from anywhere on it and resized from its corner (the frontend gives its widget container pointer events otherwise)
let styleDone = false;
function injectStyle() {
  if (styleDone) return;
  styleDone = true;
  const st = document.createElement("style");
  // .dom-widget = classic nodes, .lg-node-widget = Nodes 2.0
  st.textContent = `.dom-widget:has(.lc-preview-wrap), .dom-widget:has(.lc-preview-wrap) *,
.lg-node-widget:has(.lc-preview-wrap), .lg-node-widget:has(.lc-preview-wrap) * { pointer-events: none !important; }`;
  document.head.appendChild(st);
}

function installPreview(node, cls) {
  if (node.__lcPreview) return;
  injectStyle();
  const kind = KINDS[cls];

  const wrap = document.createElement("div");
  wrap.className = "lc-preview-wrap";
  // the DOM widget sits 10 px in from each node edge (and 10 px off the rows above and below), so reach out to the edges and pad by 16: 300 - 32 = 268 wide
  // padding is 16 px at the launch width and eases down to 4 px at the minimum width, so a squeezed node still shows most of the image
  wrap.style.cssText = `width:calc(100% + 20px);height:calc(100% + 20px);margin:-10px 0 0 -10px;box-sizing:border-box;padding:clamp(4px, calc(4px + (100% - 120px) * 0.075), ${PAD}px);display:flex;flex-direction:column;`;
  const frame = document.createElement("div");
  // the size line lives inside the window, so the node keeps its size (saved workflows too) and the image gives up the room
  frame.style.cssText = `width:100%;flex:1 1 auto;min-height:0;box-sizing:border-box;background:${kind.empty};border-radius:4px;display:flex;align-items:center;justify-content:center;overflow:hidden;`;
  const img = document.createElement("img");
  img.style.cssText = "max-width:100%;max-height:100%;object-fit:contain;display:none;user-select:none;pointer-events:none;";
  img.draggable = false;
  frame.appendChild(img);
  const size = document.createElement("div");
  size.style.cssText = `flex:0 0 ${SIZE_H}px;line-height:${SIZE_H}px;margin-top:2px;text-align:center;font:11px sans-serif;color:#c8d4d4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;`;
  wrap.append(frame, size);

  const dom = node.addDOMWidget("lc_preview", "LC_PREVIEW", wrap, {
    getMinHeight: () => MIN_WIDGET_H,
    hideOnZoom: false,
    serialize: false,
  });
  dom.serializeValue = () => undefined;
  // the canvas treats a press on a widget as a widget click. This one is display only, so hide it from that hit test:
  // a press on the window then drags the node like a press on any other part of it (a disabled widget would vanish)
  const hitTest = node.getWidgetOnPos;
  node.getWidgetOnPos = function () {
    const w = hitTest.apply(this, arguments);
    return w && w.name === "lc_preview" ? undefined : w;
  };
  node.__lcPreview = {
    img,
    show(list) {
      const first = Array.isArray(list) && list.length ? list[0] : null;
      if (!first) {
        img.style.display = "none";
        img.removeAttribute("src");
        wrap.title = "";
        size.textContent = "";
        return;
      }
      img.onload = () => {
        img.style.display = "block";
        size.textContent = `${img.naturalWidth} × ${img.naturalHeight}` + (list.length > 1 ? `  ·  batch of ${list.length}` : "");
      };
      img.src = viewUrl(first);
      wrap.title = list.length > 1 ? `batch of ${list.length}, showing the first` : "";
    },
  };
}

app.registerExtension({
  name: "LC123.PreviewNodes",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    const cls = nodeData?.name;
    if (!KINDS[cls]) return;

    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onCreated?.apply(this, arguments);
      installPreview(this, cls); // synchronous, so the widget list is final before a saved workflow restores values
      try {
        this.setSize([NODE_W, PREVIEW_H + PAD * 2 + 46]); // + the input row and the bottom margin // a saved workflow overrides this with its own size
      } catch (_) {}
      if (cls === "LCPreviewMask") {
        // launches black; a saved color is restored over this
        this.color = "#222";
        this.bgcolor = "#000";
      } else {
        lcApplyLaunchColor(this, "#324B4B");
      }
      return r;
    };

    // the frontend uses this as the minimum size when the node is dragged smaller
    nodeType.prototype.computeSize = function () {
      return [MIN_NODE_W, MIN_NODE_H];
    };

    // Preview distance setting: hide the image once it is drawn too small on screen to read (only touches the DOM on a change)
    const onDrawFg = nodeType.prototype.onDrawForeground;
    nodeType.prototype.onDrawForeground = function () {
      const r = onDrawFg?.apply(this, arguments);
      const img = this.__lcPreview?.img;
      if (img) {
        const hide = !!window.LC123Perf?.tooSmall?.(this.size[0] - PAD * 2, this.size[1] - 46 - PAD * 2 - SIZE_H);
        if (img.__lcHidden !== hide) {
          img.__lcHidden = hide;
          img.style.visibility = hide ? "hidden" : "";
        }
      }
      return r;
    };

    const onExecuted = nodeType.prototype.onExecuted;
    nodeType.prototype.onExecuted = function (message) {
      const r = onExecuted?.apply(this, arguments);
      try {
        this.__lcPreview?.show(message?.lc_preview);
      } catch (_) {}
      return r;
    };
  },
});
