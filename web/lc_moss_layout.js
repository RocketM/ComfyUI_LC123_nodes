import { app } from "../../scripts/app.js";

// LC MOSS Layout Prompt: a little room under the last widget. A fixed spacer, because the prompt box
// soaks up any spare height the node is given.
const BOTTOM_PAD = 12;

app.registerExtension({
  name: "LC123.MOSSLayoutPrompt",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if ((nodeData?.name || "") !== "LCMOSSLayoutPrompt") return;
    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onCreated?.apply(this, arguments);
      if (!(this.widgets || []).some((w) => w.name === "_lc_pad")) {
        this.addCustomWidget({
          name: "_lc_pad",
          type: "lc_pad",
          value: null,
          options: { serialize: false },
          serialize: false,
          draw() {},
          computeSize: (width) => [width, BOTTOM_PAD],
        });
        const sz = this.computeSize();
        this.setSize([Math.max(this.size[0], sz[0]), Math.max(this.size[1], sz[1])]);
      }
      return r;
    };
  },
});
