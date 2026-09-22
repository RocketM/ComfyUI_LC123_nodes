// LC Image Label
// Ported from ComfyUI_RaykoStudio's RS Image Label (Apache-2.0,
// https://github.com/Raykosan/ComfyUI_RaykoStudio) -- same core design
// (custom drawNode override for a chromeless "sticker" node, drag-and-drop
// upload, settings dialog, image baked into the workflow JSON as a webp
// data URL), rebuilt under LC123's own node name, route namespace, and
// widget id so it coexists cleanly with the original if both packs are
// installed. Two real fixes over upstream: pinned-label click-through (so a
// label parked on top of other nodes doesn't block clicking them) actually
// works here -- see the lastCanvasMouseEvent note near the bottom -- and
// dropping a file that carries embedded ComfyUI workflow metadata (i.e. any
// image this app previously saved) no longer gets hijacked by core's
// load-workflow-from-PNG feature and wipes the graph -- see the
// window-capture note in onNodeCreated.
import { app } from "../../scripts/app.js";
import { getLayer, isSelected, screenCentre, setCentreFromScreen, commit, dragHandle, hitRotated, clientToGraph, snapAngle, vueClickThrough } from "./lc_overlay_common.js";

const lcImageLabelState = {
    processingMouseDown: false,
    lastCanvasMouseEvent: null,
};


// ---- the on-canvas look: an HTML layer above the canvas, with rotate / grow / stretch handles ------------------------
// (the label used to be drawn on the canvas, which could not rotate and could get buried under nodes)
const ilNodes = new Set();
let ilLoopOn = false;
function ilStart() {
    if (ilLoopOn) return;
    ilLoopOn = true;
    const tick = () => {
        if (!ilNodes.size) { ilLoopOn = false; return; }
        for (const n of ilNodes) ilRender(n);
        requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
}

function ilDims(node) {
    const p = node.properties;
    const pad = Math.max(Number(p.padding) || 0, 5);
    const bw = Number(p.borderWidth) || 0;
    const m = pad + bw;
    const iw = p.imgW > 0 ? p.imgW : 100;
    const ih = p.imgH > 0 ? p.imgH : 100;
    return { pad, bw, m, iw, ih, W: iw + 2 * m, H: ih + 2 * m };
}

function ilBuild(node) {
    const box = document.createElement("div");
    box.style.cssText = "position:absolute;left:0;top:0;transform-origin:0 0;pointer-events:none;will-change:transform;display:none;";
    const frame = document.createElement("div");
    frame.style.cssText = "position:absolute;left:0;top:0;box-sizing:border-box;overflow:visible;";
    const img = document.createElement("img");
    img.draggable = false;
    img.style.cssText = "display:block;width:100%;height:100%;object-fit:fill;user-select:none;";
    const ph = document.createElement("div");
    ph.textContent = "Drop an image";
    ph.style.cssText = "position:absolute;inset:0;display:none;align-items:center;justify-content:center;color:#777;font:12px Arial,sans-serif;border:1px dashed #555;";
    frame.append(img, ph);
    box.appendChild(frame);
    const sel = document.createElement("div");
    sel.style.cssText = "position:absolute;left:0;top:0;right:0;bottom:0;pointer-events:none;display:none;";
    box.appendChild(sel);

    const mk = (cursor, w, h, round) => {
        const el = document.createElement("div");
        el.style.cssText = `position:absolute;width:${w}px;height:${h}px;background:#fff;border:2px solid #6cf;border-radius:${round ? "50%" : "3px"};cursor:${cursor};pointer-events:auto;display:none;box-sizing:border-box;touch-action:none;align-items:center;justify-content:center;font-size:15px;font-weight:bold;color:#246;line-height:1;`;
        box.appendChild(el);
        return el;
    };
    const corners = [[0, 0, "nwse-resize"], [1, 0, "nesw-resize"], [0, 1, "nesw-resize"], [1, 1, "nwse-resize"]].map(([fx, fy, c]) => ({ el: mk(c, 12, 12), fx, fy }));
    const sides = [
        { el: mk("ew-resize", 10, 18), fx: 0, fy: 0.5 },
        { el: mk("ew-resize", 10, 18), fx: 1, fy: 0.5 },
        { el: mk("ns-resize", 18, 10), fx: 0.5, fy: 0 },
        { el: mk("ns-resize", 18, 10), fx: 0.5, fy: 1 },
    ];
    const rot = mk("grab", 24, 24, true);
    rot.textContent = "⟳";
    const stem = document.createElement("div");
    stem.style.cssText = "position:absolute;background:#6cf;pointer-events:none;display:none;";
    box.appendChild(stem);
    const badge = document.createElement("div");
    badge.style.cssText = "position:absolute;padding:2px 8px;background:#111;border:1px solid #6cf;color:#6cf;border-radius:10px;font:12px Arial,sans-serif;white-space:nowrap;pointer-events:none;display:none;";
    box.appendChild(badge);

    const v = { box, frame, img, ph, sel, corners, sides, rot, stem, badge, w: 110, h: 110, key: "", sig: "", src: "" };
    getLayer().appendChild(box);
    ilWire(node, v);
    return v;
}

// style from the properties; the box is the image plus padding and border, exactly as it was on the canvas
function ilApplyStyle(node) {
    const v = node.__il;
    const p = node.properties;
    const d = ilDims(node);
    const br = Number(p.borderRadius) || 0;
    const bc = p.borderColor || "#FF0000";
    const fs = v.frame.style;
    fs.width = d.W + "px";
    fs.height = d.H + "px";
    fs.padding = d.pad + "px";
    fs.border = d.bw > 0 ? `${d.bw}px solid ${bc}` : "none";
    fs.borderRadius = br + "px";
    fs.background = !p.bgTransparent && p.backgroundColor && p.backgroundColor !== "transparent" ? p.backgroundColor : "transparent";
    let ir = p.syncImageRadius ? Math.max(0, br - d.bw - d.pad) : Number(p.imageRadius) || 0;
    ir = Math.min(ir, Math.min(d.iw, d.ih) / 2);
    v.img.style.borderRadius = ir + "px";
    const src = node.imageLoaded && node.cachedImage ? node.cachedImage.src : "";
    if (src !== v.src) {
        v.src = src;
        if (src) v.img.src = src; else v.img.removeAttribute("src");
    }
    v.img.style.display = src ? "block" : "none";
    v.ph.style.display = src ? "none" : "flex";
}

// size the node to the rotated bounding box, keeping the centre where it was (the exact box is kept in the properties,
// because ComfyUI rounds a reloaded node's size up to its grid)
function ilLayout(node, topLeft = false) {
    const v = node.__il;
    if (!v) return;
    ilApplyStyle(node);
    const d = ilDims(node);
    const a = (node.properties.angle * Math.PI) / 180;
    const W = Math.abs(d.W * Math.cos(a)) + Math.abs(d.H * Math.sin(a));
    const H = Math.abs(d.W * Math.sin(a)) + Math.abs(d.H * Math.cos(a));
    const pr = node.properties;
    const ow = Number.isFinite(pr._w) ? pr._w : node.size[0];
    const oh = Number.isFinite(pr._h) ? pr._h : node.size[1];
    if (topLeft) {
        node.size = [W, H];
    } else if (Math.abs(W - ow) < 0.75 && Math.abs(H - oh) < 0.75) {
        node.size = [ow, oh];
    } else {
        const cx = node.pos[0] + ow / 2;
        const cy = node.pos[1] + oh / 2;
        node.size = [W, H];
        node.pos = [cx - W / 2, cy - H / 2];
    }
    pr._w = node.size[0];
    pr._h = node.size[1];
    v.w = d.W;
    v.h = d.H;
    v.key = "";
    v.box.style.display = "block";
    app.canvas?.setDirty?.(true, true);
}

function ilRender(node) {
    const v = node.__il;
    if (!v) return;
    const c = app.canvas;
    if (!c || !node.graph || node.graph !== c.graph) { v.box.style.display = "none"; return; }
    const p = node.properties;
    const sig = JSON.stringify([p.imgW, p.imgH, p.angle, p.padding, p.borderWidth, p.borderColor, p.borderRadius, p.backgroundColor, p.bgTransparent, p.syncImageRadius, p.imageRadius, node.imageLoaded, node.cachedImage && node.cachedImage.src && node.cachedImage.src.length]);
    if (sig !== v.sig) { v.sig = sig; ilLayout(node); }
    const ds = c.ds;
    const s = ds.scale;
    const cr = c.canvas.getBoundingClientRect();
    const lr = getLayer().getBoundingClientRect();
    const ex = Number.isFinite(p._w) ? p._w : node.size[0];
    const ey = Number.isFinite(p._h) ? p._h : node.size[1];
    const cx = (node.pos[0] + ex / 2 + ds.offset[0]) * s + (cr.left - lr.left);
    const cy = (node.pos[1] + ey / 2 + ds.offset[1]) * s + (cr.top - lr.top);
    const sel = isSelected(node) && !node.dialogOpen;
    const pinned = !!(node.flags && node.flags.pinned);
    vueClickThrough(node, pinned);
    const edit = sel && !pinned; // a pinned label is locked: frame only, no handles
    const key = [cx.toFixed(2), cy.toFixed(2), s.toFixed(4), p.angle, v.w, v.h, sel, edit, v.badgeText || ""].join("|");
    if (key === v.key) return;
    v.key = key;
    v.box.style.display = "block";
    v.box.style.transform = `translate(${cx}px,${cy}px) rotate(${p.angle}deg) scale(${s}) translate(${-v.w / 2}px,${-v.h / 2}px)`;
    const inv = 1 / s;
    v.sel.style.display = sel ? "block" : "none";
    v.sel.style.border = `${2 * inv}px dashed #6cf`;
    for (const k of [...v.corners, ...v.sides]) {
        k.el.style.display = edit ? "block" : "none";
        k.el.style.left = k.fx * v.w + "px";
        k.el.style.top = k.fy * v.h + "px";
        k.el.style.transform = `translate(-50%,-50%) scale(${inv})`;
    }
    const off = 38 * inv;
    v.rot.style.display = edit ? "flex" : "none";
    v.rot.style.left = v.w / 2 + "px";
    v.rot.style.top = -off + "px";
    v.rot.style.transform = `translate(-50%,-50%) scale(${inv})`;
    v.stem.style.display = edit ? "block" : "none";
    v.stem.style.left = v.w / 2 - inv + "px";
    v.stem.style.top = -off + "px";
    v.stem.style.width = 2 * inv + "px";
    v.stem.style.height = off + "px";
    const showBadge = edit && v.badgeText;
    v.badge.style.display = showBadge ? "block" : "none";
    if (showBadge) {
        v.badge.textContent = v.badgeText;
        v.badge.style.left = v.w / 2 + 26 * inv + "px";
        v.badge.style.top = -off - 10 * inv + "px";
        v.badge.style.transformOrigin = "0 0";
        v.badge.style.transform = `scale(${inv}) rotate(${-p.angle}deg)`;
    }
}

// set the image size, keeping one anchor point (a corner or an edge midpoint) fixed on screen
function ilResizeTo(node, iw, ih, afx, afy, anchor) {
    const p = node.properties;
    const d0 = ilDims(node);
    iw = Math.max(16, iw);
    ih = Math.max(16, ih);
    p.imgW = Math.round(iw * 10) / 10;
    p.imgH = Math.round(ih * 10) / 10;
    p.size = Math.round(Math.max(p.imgW, p.imgH)); // kept for older versions
    const s = app.canvas.ds.scale;
    const a = (p.angle * Math.PI) / 180;
    const W2 = iw + 2 * d0.m;
    const H2 = ih + 2 * d0.m;
    const lx = (afx - 0.5) * W2 * s;
    const ly = (afy - 0.5) * H2 * s;
    setCentreFromScreen(node, anchor[0] - (lx * Math.cos(a) - ly * Math.sin(a)), anchor[1] - (lx * Math.sin(a) + ly * Math.cos(a)));
    ilLayout(node);
}

function ilWire(node, v) {
    const local = (fx, fy) => {
        const s = app.canvas.ds.scale;
        const a = (node.properties.angle * Math.PI) / 180;
        const [cx, cy] = screenCentre(node);
        const lx = (fx - 0.5) * v.w * s;
        const ly = (fy - 0.5) * v.h * s;
        return [cx + lx * Math.cos(a) - ly * Math.sin(a), cy + lx * Math.sin(a) + ly * Math.cos(a)];
    };

    // rotate: 5 degree steps with a magnet at 0 / 90 / 180, Shift = 15, Alt = free
    dragHandle(
        v.rot,
        () => { v.badgeText = Math.round(node.properties.angle) + "°"; },
        (e) => {
            const [cx, cy] = screenCentre(node);
            const a = snapAngle((Math.atan2(e.clientY - cy, e.clientX - cx) * 180) / Math.PI + 90, e);
            node.properties.angle = a;
            v.badgeText = node.properties.angle + "°";
            ilLayout(node);
        },
        () => { v.badgeText = ""; v.key = ""; commit(); }
    );

    // grow from a corner: proportional, the opposite corner stays put
    for (const k of v.corners) {
        let st = null;
        dragHandle(
            k.el,
            () => {
                const d = ilDims(node);
                const anchor = local(1 - k.fx, 1 - k.fy);
                const corner = local(k.fx, k.fy);
                st = { anchor, d0: Math.max(1, Math.hypot(corner[0] - anchor[0], corner[1] - anchor[1])), iw: d.iw, ih: d.ih };
            },
            (e) => {
                if (!st) return;
                const r = Math.hypot(e.clientX - st.anchor[0], e.clientY - st.anchor[1]) / st.d0;
                ilResizeTo(node, st.iw * r, st.ih * r, 1 - k.fx, 1 - k.fy, st.anchor);
            },
            () => { st = null; commit(); }
        );
    }

    // stretch from a side: one axis only, the opposite edge stays put. Shift keeps the proportions.
    for (const k of v.sides) {
        const horizontal = k.fy === 0.5;
        let st = null;
        dragHandle(
            k.el,
            () => {
                const d = ilDims(node);
                const a = (node.properties.angle * Math.PI) / 180;
                const afx = horizontal ? 1 - k.fx : 0.5;
                const afy = horizontal ? 0.5 : 1 - k.fy;
                st = {
                    afx, afy, anchor: local(afx, afy), iw: d.iw, ih: d.ih, m: d.m,
                    axis: horizontal ? [Math.cos(a), Math.sin(a)] : [-Math.sin(a), Math.cos(a)],
                    sign: (horizontal ? k.fx : k.fy) === 1 ? 1 : -1,
                    s: app.canvas.ds.scale,
                };
            },
            (e) => {
                if (!st) return;
                const proj = (((e.clientX - st.anchor[0]) * st.axis[0] + (e.clientY - st.anchor[1]) * st.axis[1]) * st.sign) / st.s;
                let iw = st.iw, ih = st.ih;
                if (horizontal) {
                    iw = proj - 2 * st.m;
                    if (e.shiftKey) ih = st.ih * (Math.max(16, iw) / st.iw);
                } else {
                    ih = proj - 2 * st.m;
                    if (e.shiftKey) iw = st.iw * (Math.max(16, ih) / st.ih);
                }
                ilResizeTo(node, iw, ih, st.afx, st.afy, st.anchor);
            },
            () => { st = null; commit(); }
        );
    }
}

app.registerExtension({
    name: "LC123.ImageLabel",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "LCImageLabel") return;

        const origOnCreated = nodeType.prototype.onNodeCreated;

        nodeType.prototype._lcDnDHandler = function (e) {
            const canvas = app.canvas;
            if (!canvas || !this.graph) return false;
            const point = canvas.convertEventToCanvasOffset(e);
            return point[0] >= this.pos[0] && point[0] <= this.pos[0] + this.size[0] &&
                   point[1] >= this.pos[1] && point[1] <= this.pos[1] + this.size[1];
        };

        nodeType.prototype.onNodeCreated = function () {
            if (origOnCreated) origOnCreated.apply(this, arguments);

            this.title = "";
            this.resizable = false;
            this.collapsable = false;
            this.flags = {};

            this.shape = LiteGraph.CUSTOM_SHAPE;
            this.color = "#fff0";
            this.bgcolor = "#fff0";
            this.shadow_color = "transparent";
            this.onDrawBackground = function (ctx) {};

            this.properties = {
                size: 125,
                imgW: 0,
                imgH: 0,
                angle: 0,
                padding: 5,
                borderWidth: 1,
                borderColor: "#ffffff",
                borderRadius: 0,
                backgroundColor: "transparent",
                bgTransparent: true,
                syncImageRadius: true,
                imageRadius: 0,
                embeddedData: "",
            };

            const pathWidget = this.addWidget("text", "_image_path", "", () => {});
            pathWidget.hidden = true;
            pathWidget.serializeValue = () => pathWidget.value || "";

            this.cachedImage = null;
            this.imageLoaded = false;
            this.dialogOpen = false;
            this.__il = ilBuild(this);
            ilNodes.add(this);
            ilStart();
            this.__ilPlaced = false;

            // Prefer the baked-in image; fall back to re-fetching by path.
            if (this.properties.embeddedData) {
                this.loadImage(this.properties.embeddedData);
            } else if (pathWidget.value) {
                this.loadImage(this.getImageUrl());
            } else {
                this.updateNodeSize();
            }

            this._boundDragEnter = (e) => {
                if (this._lcDnDHandler(e)) { e.preventDefault(); e.stopImmediatePropagation(); }
            };
            this._boundDragOver = (e) => {
                if (this._lcDnDHandler(e)) { e.preventDefault(); e.stopImmediatePropagation(); }
            };
            this._boundDrop = (e) => {
                if (this._lcDnDHandler(e)) {
                    e.preventDefault();
                    e.stopImmediatePropagation();
                    e.stopPropagation();
                    const files = e.dataTransfer?.files;
                    if (files && files.length > 0 && files[0].type.startsWith("image/")) {
                        this.uploadImage(files[0]);
                    }
                }
            };

            // Registered on window's capture phase, not the canvas element. ComfyUI's own
            // core drop handler treats any dropped image carrying embedded workflow/prompt
            // metadata (i.e. basically anything this app previously saved) as "load this
            // workflow" and replaces the whole graph -- wiping this node along with
            // everything else -- no matter which node the file visually lands on. That
            // handler already sits on the canvas element by the time any node exists, so a
            // listener added here later never gets a turn: same-element listeners run in
            // registration order during the target phase regardless of the capture flag.
            // A window-level capture listener runs earlier in the actual DOM capture phase,
            // ahead of canvas entirely, so it can claim the drop for this node before core
            // ever sees it.
            window.addEventListener("dragenter", this._boundDragEnter, { capture: true });
            window.addEventListener("dragover", this._boundDragOver, { capture: true });
            window.addEventListener("drop", this._boundDrop, { capture: true });
        };

        nodeType.prototype.onConfigure = function (info) {
            this.properties = Object.assign({ imgW: 0, imgH: 0, angle: 0 }, this.properties);
            {
                // an older label has no image size of its own: its saved node size is the exact display size, so take it from there
                const p = this.properties;
                if (!(p.imgW > 0 && p.imgH > 0) && info && Array.isArray(info.size)) {
                    const m = Math.max(Number(p.padding) || 0, 5) + (Number(p.borderWidth) || 0);
                    const iw = info.size[0] - 2 * m, ih = info.size[1] - 2 * m;
                    if (iw >= 16 && ih >= 16) {
                        p.imgW = iw; p.imgH = ih;
                        p._w = info.size[0]; p._h = info.size[1];
                    }
                }
            }
            if (this.__il) ilLayout(this);
            if (info && info.widgets_values) {
                const widgetIndex = this.widgets?.findIndex((w) => w.name === "_image_path");
                if (widgetIndex !== -1 && info.widgets_values[widgetIndex]) {
                    this.widgets[widgetIndex].value = info.widgets_values[widgetIndex];
                }
            }
            if (this.properties.embeddedData) {
                this.loadImage(this.properties.embeddedData);
            } else if (this.widgets?.find((w) => w.name === "_image_path")?.value) {
                this.loadImage(this.getImageUrl());
            }
        };

        nodeType.prototype.onSerialize = function (o) {
            if (!o.properties) o.properties = {};
            for (const key in this.properties) {
                o.properties[key] = this.properties[key];
            }
            const pathWidget = this.widgets?.find((w) => w.name === "_image_path");
            if (pathWidget) {
                if (!o.widgets_values) o.widgets_values = [];
                const index = this.widgets.indexOf(pathWidget);
                if (index !== -1) {
                    while (o.widgets_values.length <= index) o.widgets_values.push(null);
                    o.widgets_values[index] = pathWidget.value;
                }
            }
        };

        nodeType.prototype.onRemoved = function () {
            ilNodes.delete(this);
            try { this.__il?.box.remove(); } catch (_) {}
            this.__il = null;
            if (this._boundDragEnter) window.removeEventListener("dragenter", this._boundDragEnter, { capture: true });
            if (this._boundDragOver) window.removeEventListener("dragover", this._boundDragOver, { capture: true });
            if (this._boundDrop) window.removeEventListener("drop", this._boundDrop, { capture: true });
        };

        nodeType.prototype.getImageUrl = function () {
            const pathWidget = this.widgets?.find((w) => w.name === "_image_path");
            if (!pathWidget || !pathWidget.value) return null;
            let filename, subfolder;
            try {
                ({ filename, subfolder = "" } = JSON.parse(pathWidget.value));
            } catch {
                // Legacy "filename subfolder" format (single space-joined string), from
                // before filenames containing a space were handled correctly -- a plain
                // split broke on any upload whose original filename had a space in it.
                const parts = pathWidget.value.split(" ");
                filename = parts[0];
                subfolder = parts.slice(1).join(" ") || "";
            }
            return `/lc123/image_label/get_image?filename=${encodeURIComponent(filename)}&subfolder=${encodeURIComponent(subfolder)}&type=temp`;
        };

        nodeType.prototype.updateEmbeddedData = function () {
            if (!this.imageLoaded || !this.cachedImage) return;
            const img = this.cachedImage;
            let w = img.width;
            let h = img.height;
            const maxEmbedSize = 512;
            if (w > maxEmbedSize || h > maxEmbedSize) {
                const aspect = w / h;
                if (aspect >= 1) { w = maxEmbedSize; h = Math.round(maxEmbedSize / aspect); }
                else { h = maxEmbedSize; w = Math.round(maxEmbedSize * aspect); }
            }
            const canvas = document.createElement("canvas");
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext("2d");
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = "high";
            ctx.drawImage(img, 0, 0, w, h);
            this.properties.embeddedData = canvas.toDataURL("image/webp", 0.9);
        };

        nodeType.prototype.loadImage = function (src) {
            if (!src) {
                this.cachedImage = null;
                this.imageLoaded = false;
                this.updateNodeSize();
                this.setDirtyCanvas(true, true);
                return;
            }
            const img = new Image();
            img.crossOrigin = "Anonymous";
            img.onload = () => {
                this.cachedImage = img;
                this.imageLoaded = true;
                if (!src.startsWith("data:")) this.updateEmbeddedData();
                this.updateNodeSize();
                this.setDirtyCanvas(true, true);
            };
            img.onerror = () => {
                console.warn("[LC Image Label] Failed to load image:", src);
                this.cachedImage = null;
                this.imageLoaded = false;
                this.updateNodeSize();
                this.setDirtyCanvas(true, true);
            };
            img.src = src;
        };

        nodeType.prototype.uploadImage = async function (file) {
            const pathWidget = this.widgets?.find((w) => w.name === "_image_path");
            if (!pathWidget) return;
            const formData = new FormData();
            formData.append("image", file);
            formData.append("subfolder", "");
            formData.append("type", "temp");
            formData.append("overwrite", "true");
            try {
                const resp = await fetch("/upload/image", { method: "POST", body: formData });
                if (!resp.ok) throw new Error(`Upload failed: ${resp.status}`);
                const data = await resp.json();
                if (data.name) {
                    pathWidget.value = JSON.stringify({ filename: data.name, subfolder: data.subfolder || "" });
                    this.properties.imgW = 0; // a new image takes its own proportions, at the current longest side
                    this.properties.imgH = 0;
                    this.loadImage(this.getImageUrl());
                }
            } catch (e) {
                console.error("[LC Image Label] Upload failed:", e);
            }
        };

        nodeType.prototype.updateNodeSize = function () {
            const p = this.properties;
            let derived = false;
            if (this.imageLoaded && this.cachedImage && !(p.imgW > 0 && p.imgH > 0)) {
                derived = true;
                // an older label: its size was the longest side, capped at 200. The cap is gone, the look is the same.
                const maxSize = Math.max(16, Number(p.size) || 100);
                const aspect = this.cachedImage.width / this.cachedImage.height;
                if (aspect >= 1) { p.imgW = maxSize; p.imgH = maxSize / aspect; }
                else { p.imgH = maxSize; p.imgW = maxSize * aspect; }
            }
            if (this.__il) {
                this.__il.sig = "";
                ilLayout(this, derived || !this.__ilPlaced); // a fresh image keeps the top-left corner where it was dropped
                this.__ilPlaced = true;
            }
        };

        // the HTML layer above the canvas draws the label now (see ilBuild)
        nodeType.prototype.drawLabel = function () {};

        nodeType.prototype.onDblClick = function () {
            this.showSettingsDialog();
        };

        nodeType.prototype.showSettingsDialog = async function () {
            if (this.dialogOpen) return;
            this.dialogOpen = true;
            this.setDirtyCanvas(true, true);

            const dialog = document.createElement("div");
            dialog.style.cssText = "position:fixed;background:#1a1a1a;border:2px solid #333;border-radius:8px;padding:20px;z-index:10000;min-width:350px;color:#fff;font-family:Arial,sans-serif;";

            const title = document.createElement("h3");
            title.textContent = "LC Image Label Settings ⚙️";
            title.style.cssText = "margin:0 0 15px 0;color:#fff;cursor:grab;user-select:none;padding-bottom:5px;border-bottom:1px solid #333;";
            dialog.appendChild(title);

            let isDragging = false, dragOffsetX = 0, dragOffsetY = 0;
            title.addEventListener("mousedown", (e) => {
                isDragging = true;
                const rect = dialog.getBoundingClientRect();
                dragOffsetX = e.clientX - rect.left;
                dragOffsetY = e.clientY - rect.top;
                title.style.cursor = "grabbing";
                e.preventDefault();
            });
            document.addEventListener("mousemove", (e) => {
                if (!isDragging) return;
                const newX = Math.max(10, Math.min(window.innerWidth - dialog.offsetWidth - 10, e.clientX - dragOffsetX));
                const newY = Math.max(10, Math.min(window.innerHeight - 20, e.clientY - dragOffsetY));
                dialog.style.left = newX + "px";
                dialog.style.top = newY + "px";
            });
            document.addEventListener("mouseup", () => {
                if (isDragging) { isDragging = false; title.style.cursor = "grab"; }
            });

            const originalPushState = history.pushState;
            const originalReplaceState = history.replaceState;
            const onNavigate = () => closeDialog();
            history.pushState = function (...args) { originalPushState.apply(this, args); onNavigate(); };
            history.replaceState = function (...args) { originalReplaceState.apply(this, args); onNavigate(); };

            const closeDialog = () => {
                history.pushState = originalPushState;
                history.replaceState = originalReplaceState;
                document.removeEventListener("keydown", escHandler);
                document.removeEventListener("visibilitychange", visibilityHandler);
                if (dialog.parentNode) document.body.removeChild(dialog);
                this.dialogOpen = false;
                this.setDirtyCanvas(true, true);
            };
            const escHandler = (e) => { if (e.key === "Escape") closeDialog(); };
            document.addEventListener("keydown", escHandler);
            const visibilityHandler = () => { if (document.hidden) closeDialog(); };
            document.addEventListener("visibilitychange", visibilityHandler);

            const createRow = (label, createControl) => {
                const row = document.createElement("div");
                row.style.cssText = "display:flex;align-items:center;margin-bottom:10px;gap:10px;";
                const labelEl = document.createElement("label");
                labelEl.textContent = label;
                labelEl.style.cssText = "min-width:120px;color:#ccc;";
                const control = createControl();
                row.appendChild(labelEl);
                row.appendChild(control);
                dialog.appendChild(row);
            };

            const uploadRow = document.createElement("div");
            uploadRow.style.cssText = "margin-bottom:15px;text-align:center;";
            const uploadBtn = document.createElement("button");
            uploadBtn.textContent = "Load Image";
            uploadBtn.style.cssText = "width:100%;padding:8px;background:#2a2a2a;color:#fff;border:1px solid #444;border-radius:4px;cursor:pointer;";
            const fileInput = document.createElement("input");
            fileInput.type = "file";
            fileInput.accept = "image/png,image/jpeg,image/webp";
            fileInput.style.display = "none";
            fileInput.addEventListener("change", (e) => {
                if (e.target.files.length > 0) this.uploadImage(e.target.files[0]);
            });
            uploadBtn.addEventListener("click", () => fileInput.click());
            uploadRow.appendChild(uploadBtn);
            uploadRow.appendChild(fileInput);
            dialog.appendChild(uploadRow);

            const numRow = (label, key, min, max, step = 1) => createRow(label, () => {
                const input = document.createElement("input");
                input.type = "number";
                input.min = min; input.max = max; input.step = step;
                input.value = key === "imgW" ? Math.round(ilDims(this).iw) : key === "imgH" ? Math.round(ilDims(this).ih) : this.properties[key];
                input.style.cssText = "width:80px;padding:6px;background:#2a2a2a;color:#fff;border:1px solid #444;border-radius:4px;";
                input.addEventListener("input", () => {
                    const n = parseFloat(input.value);
                    if (!Number.isFinite(n)) return;
                    this.properties[key] = Math.min(max, Math.max(min, n));
                    if (key === "imgW" || key === "imgH") {
                        if (!(this.properties.imgW > 0)) this.properties.imgW = ilDims(this).iw;
                        if (!(this.properties.imgH > 0)) this.properties.imgH = ilDims(this).ih;
                        this.properties.size = Math.round(Math.max(this.properties.imgW, this.properties.imgH));
                    }
                });
                return input;
            });
            numRow("Width (px):", "imgW", 16, 4000);
            numRow("Height (px):", "imgH", 16, 4000);
            createRow("Original shape:", () => {
                const b = document.createElement("button");
                b.textContent = "Reset proportions";
                b.style.cssText = "padding:6px 10px;background:#2a2a2a;color:#fff;border:1px solid #444;border-radius:4px;cursor:pointer;";
                b.addEventListener("click", () => {
                    if (!this.cachedImage) return;
                    const d = ilDims(this);
                    this.properties.imgH = Math.round((d.iw * this.cachedImage.height) / this.cachedImage.width);
                });
                return b;
            });
            numRow("Angle:", "angle", -180, 180);

            createRow("Padding:", () => {
                const input = document.createElement("input");
                input.type = "number"; input.value = Math.max(0, this.properties.padding - 5);
                input.min = 0; input.max = 45;
                input.style.cssText = "width:80px;padding:6px;background:#2a2a2a;color:#fff;border:1px solid #444;border-radius:4px;";
                input.addEventListener("change", (e) => {
                    this.properties.padding = Math.max(5, parseInt(e.target.value) + 5);
                    this.updateNodeSize(); this.setDirtyCanvas(true, true);
                });
                return input;
            });

            createRow("Border Width:", () => {
                const input = document.createElement("input");
                input.type = "number"; input.value = this.properties.borderWidth;
                input.min = 0; input.max = 10;
                input.style.cssText = "width:80px;padding:6px;background:#2a2a2a;color:#fff;border:1px solid #444;border-radius:4px;";
                input.addEventListener("change", (e) => {
                    this.properties.borderWidth = parseInt(e.target.value);
                    this.updateNodeSize(); this.setDirtyCanvas(true, true);
                });
                return input;
            });

            createRow("Border Radius:", () => {
                const input = document.createElement("input");
                input.type = "number"; input.value = this.properties.borderRadius;
                input.min = 0; input.max = 120;
                input.style.cssText = "width:80px;padding:6px;background:#2a2a2a;color:#fff;border:1px solid #444;border-radius:4px;";
                input.addEventListener("change", (e) => {
                    this.properties.borderRadius = parseInt(e.target.value);
                    this.setDirtyCanvas(true, true);
                });
                return input;
            });

            createRow("Sync Image Radius:", () => {
                const checkbox = document.createElement("input");
                checkbox.type = "checkbox";
                checkbox.checked = this.properties.syncImageRadius !== false;
                checkbox.addEventListener("change", (e) => {
                    this.properties.syncImageRadius = e.target.checked;
                    this.setDirtyCanvas(true, true);
                    const imgRadiusInput = document.getElementById("lc-img-radius-input");
                    if (imgRadiusInput) {
                        imgRadiusInput.disabled = this.properties.syncImageRadius;
                        imgRadiusInput.style.opacity = this.properties.syncImageRadius ? "0.3" : "1";
                    }
                });
                return checkbox;
            });

            createRow("Image Radius:", () => {
                const input = document.createElement("input");
                input.id = "lc-img-radius-input";
                input.type = "number";
                input.value = this.properties.imageRadius;
                input.min = 0; input.max = 100;
                input.disabled = this.properties.syncImageRadius;
                input.style.cssText = `width:80px;padding:6px;background:#2a2a2a;color:#fff;border:1px solid #444;border-radius:4px;opacity:${this.properties.syncImageRadius ? "0.3" : "1"};`;
                input.addEventListener("change", (e) => {
                    this.properties.imageRadius = parseInt(e.target.value);
                    this.setDirtyCanvas(true, true);
                });
                return input;
            });

            createRow("Border Color:", () => {
                const container = document.createElement("div");
                container.style.cssText = "display:flex;align-items:center;gap:8px;";
                const preview = document.createElement("div");
                preview.style.cssText = "width:24px;height:24px;border:1px solid #555;border-radius:4px;cursor:pointer;";
                preview.style.backgroundColor = this.properties.borderColor || "#FF0000";
                const colorInput = document.createElement("input");
                colorInput.type = "color"; colorInput.value = this.properties.borderColor || "#FF0000"; colorInput.style.display = "none";
                preview.addEventListener("click", () => colorInput.click());
                colorInput.addEventListener("input", (e) => {
                    this.properties.borderColor = e.target.value;
                    preview.style.backgroundColor = e.target.value;
                    this.setDirtyCanvas(true, true);
                });
                container.appendChild(preview); container.appendChild(colorInput);
                return container;
            });

            createRow("Transparent Background:", () => {
                const checkbox = document.createElement("input");
                checkbox.type = "checkbox";
                checkbox.checked = this.properties.bgTransparent !== false;
                checkbox.addEventListener("change", (e) => {
                    this.properties.bgTransparent = e.target.checked;
                    this.setDirtyCanvas(true, true);
                });
                return checkbox;
            });

            createRow("Background Color:", () => {
                const container = document.createElement("div");
                container.style.cssText = "display:flex;align-items:center;gap:8px;";
                const preview = document.createElement("div");
                preview.style.cssText = "width:24px;height:24px;border:1px solid #555;border-radius:4px;cursor:pointer;";
                preview.style.backgroundColor = this.properties.backgroundColor || "#ffffff";
                const colorInput = document.createElement("input");
                colorInput.type = "color"; colorInput.value = this.properties.backgroundColor || "#ffffff"; colorInput.style.display = "none";
                const updatePreviewState = () => {
                    preview.style.opacity = this.properties.bgTransparent ? "0.3" : "1";
                    preview.style.cursor = this.properties.bgTransparent ? "not-allowed" : "pointer";
                };
                updatePreviewState();
                preview.addEventListener("click", () => { if (!this.properties.bgTransparent) colorInput.click(); });
                colorInput.addEventListener("input", (e) => {
                    this.properties.backgroundColor = e.target.value;
                    preview.style.backgroundColor = e.target.value;
                    this.setDirtyCanvas(true, true);
                });
                container.appendChild(preview); container.appendChild(colorInput);
                return container;
            });

            const okButton = document.createElement("button");
            okButton.textContent = "OK";
            okButton.style.cssText = "margin-top:15px;padding:8px 20px;background:#324B4B;color:#fff;border:none;border-radius:4px;cursor:pointer;width:100%;";
            okButton.addEventListener("click", closeDialog);
            dialog.appendChild(okButton);
            document.body.appendChild(dialog);

            requestAnimationFrame(() => {
                const canvas = LGraphCanvas.active_canvas?.canvas;
                if (!canvas) return;
                const canvasRect = canvas.getBoundingClientRect();
                const ds = LGraphCanvas.active_canvas.ds;
                const nodeRightScreenX = canvasRect.left + (this.pos[0] + this.size[0] + ds.offset[0]) * ds.scale;
                const nodeLeftScreenX = canvasRect.left + (this.pos[0] + ds.offset[0]) * ds.scale;
                const nodeBottomScreenY = canvasRect.top + (this.pos[1] + this.size[1] + ds.offset[1]) * ds.scale;
                const margin = 10;
                let leftPos = nodeRightScreenX + margin;
                let topPos = nodeBottomScreenY + margin;
                if (leftPos + dialog.offsetWidth > window.innerWidth - margin) {
                    leftPos = nodeLeftScreenX - dialog.offsetWidth - margin;
                }
                if (topPos + dialog.offsetHeight > window.innerHeight - margin) {
                    topPos = Math.max(margin, window.innerHeight - dialog.offsetHeight - margin);
                }
                if (leftPos < margin) {
                    leftPos = Math.max(margin, window.innerWidth / 2 - dialog.offsetWidth / 2);
                }
                dialog.style.left = leftPos + "px";
                dialog.style.top = topPos + "px";
            });
        };

        nodeType.prototype.getHelp = function () {
            return `<p>LC Image Label displays an image as a floating, chromeless label.</p>
            <p><strong>Double-click</strong> to open settings. <strong>Drag &amp; drop</strong> an image onto the node to upload. Select it: drag the round handle to rotate (snaps to 5&deg;, magnet at 0, 90 and 180; Shift = 15&deg;, Alt = free), a corner to grow, a side to stretch (Shift keeps the proportions).</p>`;
        };

        nodeType.title_mode = LiteGraph.NO_TITLE;
    },

    async setup() {
        const oldDrawNode = LGraphCanvas.prototype.drawNode;
        LGraphCanvas.prototype.drawNode = function (node, ctx) {
            if (node.comfyClass === "LCImageLabel" || node.type === "LCImageLabel") {
                node.color = "#fff0"; node.bgcolor = "#fff0"; node.shadow_color = "transparent";
                if (node.drawLabel) node.drawLabel(ctx);
                return;
            }
            return oldDrawNode.apply(this, arguments);
        };

        const oldGetNodeOnPos = LGraph.prototype.getNodeOnPos;
        LGraph.prototype.getNodeOnPos = function (x, y, nodes_list) {
            const e = lcImageLabelState.lastCanvasMouseEvent;
            if (nodes_list && lcImageLabelState.processingMouseDown && e && e.type.includes("down") && e.button === 0) {
                // a pinned label ignores left clicks entirely: they reach the node under it. Ctrl+drag a box to select it.
                nodes_list = [...nodes_list].filter((n) => !(n.comfyClass === "LCImageLabel" && n.flags && n.flags.pinned));
            }
            return oldGetNodeOnPos.apply(this, [x, y, nodes_list]);
        };

        // Upstream (RaykoStudio) declares lastCanvasMouseEvent but never assigns it, so its
        // pinned-label click-through check is permanently false -- fixed here by actually
        // capturing the event.
        // double-click on the image opens its settings in classic and in Nodes 2.0 (where nodes are HTML and never call onDblClick)
        document.addEventListener("dblclick", (e) => {
            const c = app.canvas;
            if (!c || !ilNodes.size) return;
            if (e.target?.closest?.("input,textarea,button,select")) return;
            const [gx, gy, cr] = clientToGraph(e);
            if (e.clientX < cr.left || e.clientX > cr.right || e.clientY < cr.top || e.clientY > cr.bottom) return;
            let hit = null;
            for (const n of ilNodes) {
                if (!n.__il || n.graph !== c.graph) continue;
                if (n.flags && n.flags.pinned) continue; // pinned = locked
                if (hitRotated(n, gx, gy, n.__il.w, n.__il.h, n.properties.angle)) hit = n;
            }
            if (hit) { e.preventDefault(); e.stopPropagation(); hit.showSettingsDialog(); }
        }, true);

        // pointerdown, not mousedown: LiteGraph reads the press before the mouse event exists
        document.addEventListener("pointerdown", (e) => {
            lcImageLabelState.processingMouseDown = true;
            lcImageLabelState.lastCanvasMouseEvent = e;
        }, true);
        document.addEventListener("pointerup", () => { lcImageLabelState.processingMouseDown = false; }, true);
        document.addEventListener("pointercancel", () => { lcImageLabelState.processingMouseDown = false; }, true);
    },
});
