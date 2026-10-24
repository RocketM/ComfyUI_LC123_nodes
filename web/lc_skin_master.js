/**
 * LC Skin Master: preset fills sliders; any manual slider change → Custom. Strength stays the node's own.
 * BASE and PRESETS mirror lc_skin_master.py (DEFAULTS / _P).
 */
import { app } from "../../scripts/app.js";

const TYPE = "LCSkinMaster";

const BASE = {"clean": 0.3, "pores": 1.0, "add_pores": 0.0, "pore_size": 1.0, "even_skin": 0.3, "wrinkles": -0.1, "even_colour": 0.2, "warmth": -0.2, "brightness": 0.05, "rosy": 0.03, "saturation": -0.05, "shadow_lift": 0.1, "pigmentation": 0.0, "eye_detail": 0.5};
const PRESETS = {
  "Natural": {},
  "Clean Even Tone": {"clean": 0.4, "even_skin": 0.5, "even_colour": 0.4, "wrinkles": -0.15, "eye_detail": 0.4},
  "Soft Beauty": {"clean": 0.5, "pores": 0.9, "even_skin": 0.6, "even_colour": 0.4, "wrinkles": -0.35, "warmth": -0.3, "brightness": 0.12, "shadow_lift": 0.2},
  "Editorial Detail": {"clean": 0.2, "pores": 1.4, "add_pores": 0.2, "even_skin": 0.2, "wrinkles": 0.0, "eye_detail": 0.8},
  "Real Skin Restore": {"clean": 0.2, "pores": 1.2, "add_pores": 0.6, "even_skin": 0.05, "even_colour": 0.1, "wrinkles": 0.0, "pigmentation": 0.3},
  "Mature Skin": {"pores": 1.1, "even_skin": 0.2, "wrinkles": 0.0, "even_colour": 0.25},
  "Weathered": {"clean": 0.1, "pores": 1.25, "add_pores": 0.2, "even_skin": 0.0, "even_colour": 0.0, "wrinkles": 0.6, "warmth": 0.1, "saturation": 0.0, "pigmentation": 0.2, "eye_detail": 0.6},
  "Body Skin": {"add_pores": 0.3, "even_skin": 0.35, "even_colour": 0.3, "pigmentation": 0.1, "eye_detail": 0.0},
  "Sun-Kissed": {"pores": 1.05, "add_pores": 0.15, "even_skin": 0.25, "even_colour": 0.1, "wrinkles": 0.0, "warmth": 0.3, "rosy": 0.05, "saturation": 0.05, "pigmentation": 0.6},
};
const SLIDER_KEYS = Object.keys(BASE);

function widgetByName(node, name) {
  return (node.widgets || []).find((w) => w.name === name);
}

function applyPreset(node, name) {
  if (!PRESETS[name]) return;
  const cfg = { ...BASE, ...PRESETS[name] };
  node._lcApplyingPreset = true;
  try {
    for (const key of SLIDER_KEYS) {
      const w = widgetByName(node, key);
      if (!w) continue;
      w.value = cfg[key];
      if (typeof w.callback === "function") {
        try { w.callback(w.value, node, app.canvas); } catch (_) {}
      }
    }
  } finally {
    node._lcApplyingPreset = false;
  }
  node.setDirtyCanvas?.(true, true);
}

function snapToCustom(node) {
  if (node._lcApplyingPreset) return;
  const presetW = widgetByName(node, "preset");
  if (!presetW || presetW.value === "Custom") return;
  presetW.value = "Custom";
  if (typeof presetW.callback === "function") {
    try { presetW.callback("Custom", node, app.canvas); } catch (_) {}
  }
  node.setDirtyCanvas?.(true, true);
}

function hook(node) {
  if (node._lcSkinMasterHooked) return;
  node._lcSkinMasterHooked = true;
  const presetW = widgetByName(node, "preset");
  if (presetW) {
    const prev = presetW.callback;
    presetW.callback = function (value, ...rest) {
      if (value && value !== "Custom") applyPreset(node, value);
      if (typeof prev === "function") return prev.apply(this, [value, ...rest]);
    };
    if (presetW.value && presetW.value !== "Custom") applyPreset(node, presetW.value);
  }
  for (const key of SLIDER_KEYS) {
    const w = widgetByName(node, key);
    if (!w || w._lcSnapCustom) continue;
    w._lcSnapCustom = true;
    const prev = w.callback;
    w.callback = function (value, ...rest) {
      snapToCustom(node);
      if (typeof prev === "function") return prev.apply(this, [value, ...rest]);
    };
  }
}

app.registerExtension({
  name: "LC123.SkinMaster",
  nodeCreated(node) {
    if (node.comfyClass !== TYPE && node.type !== TYPE) return;
    hook(node);
  },
  // a saved workflow set to a preset gets that preset's current values; only Custom keeps what was saved
  loadedGraphNode(node) {
    if (node.comfyClass !== TYPE && node.type !== TYPE) return;
    hook(node);
    const preset = widgetByName(node, "preset")?.value;
    if (preset && preset !== "Custom") applyPreset(node, preset);
  },
});
