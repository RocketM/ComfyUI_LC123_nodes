// LC Image Label
// Ported from ComfyUI_RaykoStudio's RS Image Label (Apache-2.0,
// https://github.com/Raykosan/ComfyUI_RaykoStudio) -- same core design
// (custom drawNode override for a chromeless "sticker" node, drag-and-drop
// upload, settings dialog, image baked into the workflow JSON as a webp
// data URL), rebuilt under LC123's own node name, route namespace, and
// widget id so it coexists cleanly with the original if both packs are
// installed. One real fix over upstream: pinned-label click-through (so a
// label parked on top of other nodes doesn't block clicking them) actually
// works here -- see the lastCanvasMouseEvent note near the bottom.
import { app } from "../../scripts/app.js";

const lcImageLabelState = {
    processingMouseDown: false,
    lastCanvasMouseEvent: null,
};

app.registerExtension({
    name: "LC123.ImageLabel",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "LCImageLabel") return;

        const origOnCreated = nodeType.prototype.onNodeCreated;

        nodeType.prototype._lcDnDHandler = function (e) {
            const canvas = LGraphCanvas.active_canvas;
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
                size: 100,
                padding: 5,
                borderWidth: 2,
                borderColor: "#FF0000",
                borderRadius: 5,
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

            // Prefer the baked-in image; fall back to re-fetching by path.
            if (this.properties.embeddedData) {
                this.loadImage(this.properties.embeddedData);
            } else if (pathWidget.value) {
                this.loadImage(this.getImageUrl());
            } else {
                this.updateNodeSize();
            }

            this._boundDragOver = (e) => {
                if (this._lcDnDHandler(e)) e.preventDefault();
            };
            this._boundDrop = (e) => {
                if (this._lcDnDHandler(e)) {
                    e.preventDefault();
                    e.stopPropagation();
                    const files = e.dataTransfer?.files;
                    if (files && files.length > 0 && files[0].type.startsWith("image/")) {
                        this.uploadImage(files[0]);
                    }
                }
            };

            const canvas = app.canvas?.canvas;
            if (canvas) {
                canvas.addEventListener("dragover", this._boundDragOver, { capture: true });
                canvas.addEventListener("drop", this._boundDrop, { capture: true });
            }
        };

        nodeType.prototype.onConfigure = function (info) {
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
            const canvas = app.canvas?.canvas;
            if (canvas && this._boundDragOver && this._boundDrop) {
                canvas.removeEventListener("dragover", this._boundDragOver, { capture: true });
                canvas.removeEventListener("drop", this._boundDrop, { capture: true });
            }
        };

        nodeType.prototype.getImageUrl = function () {
            const pathWidget = this.widgets?.find((w) => w.name === "_image_path");
            if (!pathWidget || !pathWidget.value) return null;
            const parts = pathWidget.value.split(" ");
            const filename = parts[0];
            const subfolder = parts.slice(1).join(" ") || "";
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
                    const fullPath = data.subfolder ? `${data.name} ${data.subfolder}` : data.name;
                    pathWidget.value = fullPath;
                    this.loadImage(this.getImageUrl());
                }
            } catch (e) {
                console.error("[LC Image Label] Upload failed:", e);
            }
        };

        nodeType.prototype.updateNodeSize = function () {
            const internalPadding = Math.max(Number(this.properties.padding) || 0, 5);
            const bw = Number(this.properties.borderWidth) || 0;
            let displayW = 100, displayH = 100;
            if (this.imageLoaded && this.cachedImage) {
                const maxSize = Math.max(16, Math.min(200, Number(this.properties.size) || 100));
                const aspect = this.cachedImage.width / this.cachedImage.height;
                if (aspect >= 1) { displayW = maxSize; displayH = maxSize / aspect; }
                else { displayH = maxSize; displayW = maxSize * aspect; }
            }
            this.size[0] = displayW + internalPadding * 2 + bw * 2;
            this.size[1] = displayH + internalPadding * 2 + bw * 2;
        };

        nodeType.prototype.drawLabel = function (ctx) {
            ctx.save();
            const internalPadding = Math.max(Number(this.properties.padding) || 0, 5);
            const bw = Number(this.properties.borderWidth) || 0;
            const br = Number(this.properties.borderRadius) || 0;
            const bc = this.properties.borderColor || "#FF0000";
            const bg = this.properties.backgroundColor;

            if (!this.properties.bgTransparent && bg && bg !== "transparent") {
                ctx.beginPath();
                ctx.roundRect(0, 0, this.size[0], this.size[1], [br]);
                ctx.fillStyle = bg;
                ctx.fill();
            }
            if (bw > 0) {
                ctx.beginPath();
                ctx.roundRect(0, 0, this.size[0], this.size[1], [br]);
                ctx.strokeStyle = bc;
                ctx.lineWidth = bw;
                ctx.stroke();
            }
            if (this.imageLoaded && this.cachedImage) {
                const maxSize = Math.max(16, Math.min(200, Number(this.properties.size) || 100));
                const aspect = this.cachedImage.width / this.cachedImage.height;
                let drawW, drawH;
                if (aspect >= 1) { drawW = maxSize; drawH = maxSize / aspect; }
                else { drawH = maxSize; drawW = maxSize * aspect; }
                const x = bw + internalPadding;
                const y = bw + internalPadding;
                let imageRadius = this.properties.syncImageRadius
                    ? Math.max(0, br - bw - internalPadding)
                    : Number(this.properties.imageRadius) || 0;
                imageRadius = Math.min(imageRadius, Math.min(drawW, drawH) / 2);
                if (imageRadius > 0) {
                    ctx.save();
                    ctx.beginPath();
                    ctx.roundRect(x, y, drawW, drawH, [imageRadius]);
                    ctx.clip();
                    ctx.drawImage(this.cachedImage, x, y, drawW, drawH);
                    ctx.restore();
                } else {
                    ctx.drawImage(this.cachedImage, x, y, drawW, drawH);
                }
            }
            ctx.restore();
        };

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
            title.textContent = "LC Image Label Settings";
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

            createRow("Size (max side):", () => {
                const input = document.createElement("input");
                input.type = "number"; input.value = this.properties.size;
                input.min = 16; input.max = 200;
                input.style.cssText = "width:80px;padding:6px;background:#2a2a2a;color:#fff;border:1px solid #444;border-radius:4px;";
                input.addEventListener("change", (e) => {
                    this.properties.size = parseInt(e.target.value);
                    this.updateNodeSize(); this.setDirtyCanvas(true, true);
                });
                return input;
            });

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

            createRow("BG Transparent:", () => {
                const checkbox = document.createElement("input");
                checkbox.type = "checkbox";
                checkbox.checked = this.properties.bgTransparent !== false;
                checkbox.addEventListener("change", (e) => {
                    this.properties.bgTransparent = e.target.checked;
                    this.setDirtyCanvas(true, true);
                });
                return checkbox;
            });

            createRow("BG Color:", () => {
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
            <p><strong>Double-click</strong> to open settings. <strong>Drag &amp; drop</strong> an image onto the node to upload.</p>`;
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
            if (nodes_list && lcImageLabelState.processingMouseDown &&
                lcImageLabelState.lastCanvasMouseEvent &&
                lcImageLabelState.lastCanvasMouseEvent.type.includes("down") &&
                lcImageLabelState.lastCanvasMouseEvent.which === 1) {
                const isDoubleClick = LiteGraph.getTime() - LGraphCanvas.active_canvas.last_mouseclick < 300;
                if (!isDoubleClick) {
                    nodes_list = [...nodes_list].filter((n) => !(n.comfyClass === "LCImageLabel" && n.flags && n.flags.pinned));
                }
            }
            return oldGetNodeOnPos.apply(this, [x, y, nodes_list]);
        };

        // Upstream (RaykoStudio) declares lastCanvasMouseEvent but never assigns it, so its
        // pinned-label click-through check is permanently false -- fixed here by actually
        // capturing the event.
        document.addEventListener("mousedown", (e) => {
            lcImageLabelState.processingMouseDown = true;
            lcImageLabelState.lastCanvasMouseEvent = e;
        });
        document.addEventListener("mouseup", () => { lcImageLabelState.processingMouseDown = false; });
    },
});
