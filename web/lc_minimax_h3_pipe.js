/**
 * LC MiniMax H3 Pipe -- autogrow removed.
 * In and Out use the same fixed socket list.
 *
 * V2's Pack/Out default width is locked to match V1's own natural
 * auto-computed width (measured live: ~173px pack, ~201px out) so a
 * freshly-created V2 node isn't wider than V1 just because it has more
 * widgets. Only applied on first creation -- never overwrites a size
 * already restored from a saved workflow.
 */

import { app } from "../../scripts/app.js";

const PACK_WIDTH = 175;
const OUT_WIDTH = 205;

const PACK_TYPES = new Set(["LCMiniMaxH3Pipe", "LCMiniMaxH3PipeV2"]);
const OUT_TYPES = new Set(["LCMiniMaxH3PipeOut", "LCMiniMaxH3PipeOutV2"]);

app.registerExtension({
  name: "LC123.MiniMaxH3Pipe",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    const name = nodeData?.name;
    if (!PACK_TYPES.has(name) && !OUT_TYPES.has(name)) return;
    const width = PACK_TYPES.has(name) ? PACK_WIDTH : OUT_WIDTH;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated?.apply(this, arguments);
      if (!this._lcH3Sized) {
        this._lcH3Sized = true;
        if (this.size) this.size[0] = width;
      }
      return r;
    };

    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (data) {
      const r = onConfigure?.apply(this, arguments);
      this._lcH3Sized = true;
      return r;
    };
  },
});
