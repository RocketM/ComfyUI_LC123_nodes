/**
 * LC Easy / Advanced Folder — default color #324B4B (image bucket) + default sizes
 */
import { app } from "../../scripts/app.js";

const DEFAULTS = {
    LCEasyFolder: { color: "#324B4B", bgcolor: "#324B4B", size: [300, 160] },
    LCAdvancedFolder: { color: "#324B4B", bgcolor: "#324B4B", size: [300, 200] },
};

app.registerExtension({
    name: "LC123.FolderColors",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        const cfg = DEFAULTS[nodeData.name];
        if (!cfg) return;
        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            if (onNodeCreated) onNodeCreated.apply(this, arguments);
            this.color = cfg.color;
            this.bgcolor = cfg.bgcolor;
            this.size = cfg.size.slice();
        };
    },
});
