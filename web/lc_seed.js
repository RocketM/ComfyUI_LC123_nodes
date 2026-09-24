/**
 * 🌱LC Seed — utility color, strip auto control_after_generate, sync base_seed after a randomized run.
 * rgthree Seed-style controls, but folded into ONE widget (base_seed) instead of a separate mode combo:
 * -1 in base_seed is the sentinel for "randomize every run" (resolved server-side in lc_seed.py); any
 * other number is a literal fixed seed. Buttons set/roll that same widget; a history dropdown remembers
 * the last 10 seeds this node actually ran with.
 */
import { app } from "../../scripts/app.js";
import { lcApplyLaunchColor } from "./lc_color.js";

const COLOR = "#822305";
const WIDTH = 270;
const DEFAULT_H = 130; // title + base_seed + 2 buttons + history combo
const RANDOMIZE = -1;

const HISTORY_MAX = 10;
const HISTORY_PLACEHOLDER = "— last used seeds —";

function stripAutoSeedControl(node) {
  if (!node?.widgets) return;
  for (let i = node.widgets.length - 1; i >= 0; i--) {
    const w = node.widgets[i];
    const n = (w?.name || "").toLowerCase();
    if (n === "control_after_generate" || n === "control_before_generate") {
      node.widgets.splice(i, 1);
    }
  }
}

function getHistory(node) {
  if (!node.properties) node.properties = {};
  if (!Array.isArray(node.properties.lc_seed_history)) node.properties.lc_seed_history = [];
  return node.properties.lc_seed_history;
}

/** Record an ACTUALLY-EXECUTED value (called from the "executed" hook only -- staging a value via a
 * button or by typing isn't history until a real queue confirms it ran). Newest first, deduped against
 * the immediately-previous entry so a repeated fixed seed doesn't spam the list every re-queue. */
function pushHistory(node, value) {
  const hist = getHistory(node);
  if (hist[0] === value) return;
  hist.unshift(value);
  if (hist.length > HISTORY_MAX) hist.length = HISTORY_MAX;
}

function historyOptions(node) {
  const hist = getHistory(node);
  if (!hist.length) return [HISTORY_PLACEHOLDER];
  return [HISTORY_PLACEHOLDER, ...hist.map((v) => String(v))];
}

function ensureExtraWidgets(node) {
  if (node._lcSeedWidgetsAdded) return;
  node._lcSeedWidgetsAdded = true;

  const seedWidget = () => node.widgets?.find((w) => w.name === "base_seed");

  node.addWidget(
    "button",
    "\u{1F3B2} Randomize Each Time",
    "",
    () => {
      const sw = seedWidget();
      if (sw) sw.value = RANDOMIZE;
      node.setDirtyCanvas?.(true, true);
    },
    { serialize: false }
  );

  node.addWidget(
    "button",
    "\u{1F3B2} New Fixed Random",
    "",
    () => {
      const sw = seedWidget();
      if (sw) sw.value = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
      node.setDirtyCanvas?.(true, true);
    },
    { serialize: false }
  );

  const historyWidget = node.addWidget(
    "combo",
    "seed history",
    HISTORY_PLACEHOLDER,
    (value) => {
      if (value === HISTORY_PLACEHOLDER) return;
      const sw = seedWidget();
      if (sw) sw.value = Number(value);
      historyWidget.value = HISTORY_PLACEHOLDER;
      node.setDirtyCanvas?.(true, true);
    },
    { values: () => historyOptions(node), serialize: false }
  );
}

function applyChrome(node) {
  try {
    lcApplyLaunchColor(node, COLOR);
  } catch (_) {}
  if (!node.size) node.size = [WIDTH, DEFAULT_H];
  if (node.size[0] < WIDTH) node.size[0] = WIDTH;
  stripAutoSeedControl(node);
  ensureExtraWidgets(node);
}

app.registerExtension({
  name: "LC123.Seed",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== "LCSeed") return;
    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onCreated?.apply(this, arguments);
      applyChrome(this);
      requestAnimationFrame(() => applyChrome(this));
      return r;
    };
  },
  async setup() {
    const api = app.api;
    if (!api?.addEventListener) return;

    api.addEventListener("executed", ({ detail }) => {
      try {
        const id = detail?.node;
        if (id == null) return;
        const node = app.graph?.getNodeById?.(Number(id));
        if (!node || (node.comfyClass !== "LCSeed" && node.type !== "LCSeed")) return;

        stripAutoSeedControl(node);

        const seedW = node.widgets?.find((w) => w.name === "base_seed");
        if (!seedW) return;

        const out = detail?.output;
        let used = null;
        if (out?.seed && out.seed.length) used = Number(out.seed[0]);
        if (used == null || Number.isNaN(used)) return;

        // Deliberately do NOT write `used` back into base_seed here: while base_seed is the -1
        // sentinel, overwriting it with the resolved number would destroy the sentinel after just one
        // run, silently turning "Randomize Each Time" into "randomize once, then repeat that value" the
        // moment a second run inherits the still-fixed number. The history dropdown is where the actual
        // resolved value becomes visible and recoverable instead.
        pushHistory(node, used);
        node.setDirtyCanvas?.(true, true);
      } catch (_) {}
    });
  },
});
