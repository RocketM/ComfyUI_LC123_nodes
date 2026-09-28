/**
 * LC Stop — mxStop-style Continue button + color #963232
 * Adapted from ComfyUI-mxToolkit StopProc.js (Max Smirnov)
 */

import { app } from "../../scripts/app.js";

class LCStopUI {
    constructor(node) {
        this.node = node;
        this.node.properties = this.node.properties || {};
        this.node.color = "#963232";
        this.node.bgcolor = "#963232";

        // the per-instance hooks below chain whatever the node already had (other extensions' prototype hooks)
        const prevGraphConfigured = this.node.onGraphConfigured;
        const prevDrawForeground = this.node.onDrawForeground;

        this.node.onGraphConfigured = function () {
            const r = prevGraphConfigured?.apply(this, arguments);
            this.configured = true;
            return r;
        };

        const prevConnectionsChange = this.node.onConnectionsChange;
        const prevAdded = this.node.onAdded;
        const prevMouseDown = this.node.onMouseDown;

        // back to an untyped passthrough (was this.onAdded(); kept separate so a disconnect does not re-run onAdded hooks)
        const resetTypes = function () {
            this.inputs[0].type = "*";
            this.outputs[0].name = "";
            this.outputs[0].type = "*";
        };

        this.node.onConnectionsChange = function (type, index, connected, link_info) {
            const r = prevConnectionsChange?.apply(this, arguments);
            // the node's own graph, so it also works inside a subgraph
            const graph = this.graph ?? app.graph;
            if (link_info) {
                if (connected) {
                    const cnode = type === LiteGraph.INPUT ? graph?.getNodeById(link_info.origin_id) : null;
                    // a link whose origin is gone (mid-load, or already removed) used to throw here: skip it
                    if (type === LiteGraph.INPUT && cnode?.outputs?.[link_info.origin_slot]) {
                        const ctype = cnode.outputs[link_info.origin_slot].type;
                        const color = LGraphCanvas.link_type_colors[ctype];
                        this.outputs[0].type = ctype;
                        this.outputs[0].name = ctype;
                        this.inputs[0].type = ctype;
                        if (link_info.id && graph.links[link_info.id]) {
                            graph.links[link_info.id].color = color;
                        }
                        if (this.outputs[0].links !== null) {
                            for (let i = this.outputs[0].links.length; i > 0; i--) {
                                const tlinkId = this.outputs[0].links[i - 1];
                                const tlink = graph.links[tlinkId];
                                if (this.configured && tlink && ctype !== tlink.type) {
                                    graph.getNodeById(tlink.target_id)?.disconnectInput(tlink.target_slot);
                                }
                            }
                        }
                    }
                    if (type === LiteGraph.OUTPUT && this.inputs[0].link === null) {
                        this.inputs[0].type = link_info.type;
                        this.outputs[0].type = link_info.type;
                        this.outputs[0].name = link_info.type;
                    }
                } else if (
                    ((type === LiteGraph.INPUT) && (this.outputs[0].links === null || this.outputs[0].links.length === 0)) ||
                    ((type === LiteGraph.OUTPUT) && (this.inputs[0].link === null))
                ) {
                    resetTypes.call(this);
                }
            }
            this.computeSize();
            return r;
        };

        this.node.onAdded = function () {
            const r = prevAdded?.apply(this, arguments);
            resetTypes.call(this);
            return r;
        };

        // Click on the title-bar play button → queue again (continue past stop)
        this.node.onMouseDown = function (e, pos, canvas) {
            let cWidth = this._collapsed_width || LiteGraph.NODE_COLLAPSED_WIDTH;
            // Only title bar
            // not on the button: hand the click to whatever handler the node had before (false when none, as before)
            const passOn = () => (prevMouseDown ? prevMouseDown.apply(this, arguments) : false);
            if (e.canvasY - this.pos[1] > 0) return passOn();
            if (this.flags.collapsed && (e.canvasX - this.pos[0] < LiteGraph.NODE_TITLE_HEIGHT)) return passOn();
            if (!this.flags.collapsed && ((e.canvasX - this.pos[0]) < (this.size[0] - cWidth + LiteGraph.NODE_TITLE_HEIGHT))) return passOn();
            this.updateThisNodeGraph?.();
            this.onTmpMouseUp(e, pos, canvas);
            return true;
        };

        this.node.onTmpMouseUp = function (e, pos, canvas) {
            app.queuePrompt(0);
        };

        this.node.onDrawForeground = function (ctx) {
            prevDrawForeground?.apply(this, arguments);
            this.configured = true;
            if (this.size[1] > LiteGraph.NODE_SLOT_HEIGHT * 1.3) {
                this.size[1] = LiteGraph.NODE_SLOT_HEIGHT * 1.3;
            }

            // Only show Continue button when enable is ON
            const enableWidget = (this.widgets || []).find((w) => w.name === "enable");
            const enabled = enableWidget ? enableWidget.value : true;
            if (!enabled) return;

            let titleHeight = LiteGraph.NODE_TITLE_HEIGHT;
            let cWidth = this._collapsed_width || LiteGraph.NODE_COLLAPSED_WIDTH;
            let buttonWidth = cWidth - titleHeight - 6;
            let cx = (this.flags.collapsed ? cWidth : this.size[0]) - buttonWidth - 6;

            ctx.fillStyle = this.color || LiteGraph.NODE_DEFAULT_COLOR;
            ctx.beginPath();
            ctx.rect(cx, 2 - titleHeight, buttonWidth, titleHeight - 4);
            ctx.fill();

            cx += buttonWidth / 2;

            ctx.lineWidth = 1;
            if (this.mouseOver) {
                // Play arrows when hovered
                ctx.fillStyle = LiteGraph.NODE_SELECTED_TITLE_COLOR;
                ctx.beginPath();
                ctx.moveTo(cx - 8, -titleHeight / 2 - 8);
                ctx.lineTo(cx + 0, -titleHeight / 2);
                ctx.lineTo(cx - 8, -titleHeight / 2 + 8);
                ctx.fill();
                ctx.beginPath();
                ctx.moveTo(cx + 1, -titleHeight / 2 - 8);
                ctx.lineTo(cx + 9, -titleHeight / 2);
                ctx.lineTo(cx + 1, -titleHeight / 2 + 8);
                ctx.fill();
            } else {
                // Pause bars when idle
                ctx.fillStyle = this.boxcolor || LiteGraph.NODE_DEFAULT_BOXCOLOR;
                ctx.beginPath();
                ctx.rect(cx - 10, -titleHeight / 2 - 8, 4, 16);
                ctx.fill();
                ctx.beginPath();
                ctx.rect(cx - 2, -titleHeight / 2 - 8, 4, 16);
                ctx.fill();
            }
        };

        // not chained on purpose: LC Stop is a fixed one-row node, so its size is the only answer that fits
        this.node.computeSize = function () {
            return [
                (this.properties.showOutputText && this.outputs && this.outputs.length)
                    ? LiteGraph.NODE_TEXT_SIZE * (this.outputs[0].name.length + 5) * 0.6 + 140
                    : 140,
                LiteGraph.NODE_SLOT_HEIGHT * 1.3,
            ];
        };
    }
}

app.registerExtension({
    name: "LC123.Stop",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "LCStop") return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            if (onNodeCreated) onNodeCreated.apply(this, []);
            this.color = "#963232";
            this.bgcolor = "#963232";
            this.lcStop = new LCStopUI(this);
        };
    },
});
