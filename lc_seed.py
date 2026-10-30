"""
🌱LC Seed — standalone INT seed, rgthree Seed-style. One widget, no seed_mode: type a number for a fixed
seed, or -1 for a fresh random number every run. Widget is base_seed (not "seed") so ComfyUI does not
inject its own control_after_generate UI on top of this.

-1 is a sentinel, not a real seed -- the actual value used is resolved here and reported back to the
node's face (web/lc_seed.js) via the `ui` message, same as before.

Capped to JS_SAFE_MAX (2**53 - 1, JavaScript's Number.MAX_SAFE_INTEGER) rather than the full 64-bit range:
any integer bigger than that is not exactly representable as an IEEE-754 double, and a resolved seed has
to cross into JS twice -- once over JSON in the `ui` message the browser uses to build the seed history,
and once if it's ever typed into or displayed by the widget itself. Past 2**53 both of those silently round
to the nearest representable double instead of erroring, so the number the history shows (and the number a
user could type back in) is not necessarily the number that was actually used. A generation seed only needs
enough entropy to avoid collisions -- 2**53 possible values is still astronomically more than that needs --
so there's no reason to keep the full 64-bit range and its silent corruption risk.
"""

from __future__ import annotations

import random
import time

RANDOMIZE = -1
JS_SAFE_MAX = (1 << 53) - 1  # Number.MAX_SAFE_INTEGER -- see module docstring

# The IS_CHANGED value each randomizing LC Seed gave on its last run, by node id. A Continue run (a hold's play
# button, or Run after a hold stopped the last one: web/lc_continue.js) hands it back, so the seed comes from the
# cache with the number it rolled last time and everything below it stays cached too.
_LAST_CHANGE: dict[str, float] = {}


def _continue_handler(json_data):
    """On a Continue run (marked lc_continue in the workflow extra): give every randomizing LC Seed its last
    IS_CHANGED value, so the run reuses its seed. The marker is taken out, so saved images never carry it."""
    try:
        wf = ((json_data.get("extra_data") or {}).get("extra_pnginfo") or {}).get("workflow") or {}
        extra = wf.get("extra") if isinstance(wf, dict) else None
        if not isinstance(extra, dict) or not extra.pop("lc_continue", False):
            return json_data
        for uid, node in (json_data.get("prompt") or {}).items():
            if not isinstance(node, dict) or node.get("class_type") != "LCSeed":
                continue
            try:
                randomizing = int((node.get("inputs") or {}).get("base_seed")) == RANDOMIZE
            except (TypeError, ValueError):
                randomizing = False
            if randomizing and str(uid) in _LAST_CHANGE:
                node["is_changed"] = [_LAST_CHANGE[str(uid)]]
    except Exception as e:
        print(f"[LC Seed] continue: {e}")
    return json_data


try:
    from server import PromptServer

    PromptServer.instance.add_on_prompt_handler(_continue_handler)
except Exception as e:
    print(f"[LC Seed] continue handler not registered: {e}")


def _resolve_seed(base_seed: int) -> int:
    if int(base_seed) == RANDOMIZE:
        return random.randint(0, JS_SAFE_MAX)
    return max(0, min(int(base_seed), JS_SAFE_MAX))


class LCSeed:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "base_seed": ("INT", {
                    "default": 0,
                    "min": RANDOMIZE,
                    "max": JS_SAFE_MAX,
                    "tooltip": "A number = that exact fixed seed, reused every run. -1 = a fresh random "
                               "number every run. Use the node's own buttons rather than typing -1 by "
                               "hand: 'Randomize Each Time' sets this to -1, 'New Fixed Random' rolls one "
                               "number now and writes it here as a real fixed seed. Capped below 2**64 on "
                               "purpose -- see the module docstring.",
                }),
            },
            "hidden": {
                "prompt": "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO",
                "unique_id": "UNIQUE_ID",
            },
        }

    RETURN_TYPES = ("INT",)
    RETURN_NAMES = ("seed",)
    FUNCTION = "emit"
    CATEGORY = "LC123/utils"
    DESCRIPTION = (
        "Utility seed. Type a fixed number, or use the node's face: 'Randomize Each Time', 'New Fixed "
        "Random', manual entry, or pick one of the last 10 seeds this node actually ran with."
    )

    @classmethod
    def IS_CHANGED(cls, base_seed, prompt=None, extra_pnginfo=None, unique_id=None):
        if int(base_seed) == RANDOMIZE:
            t = time.time()
            if unique_id is not None:
                _LAST_CHANGE[str(unique_id)] = t
            return t
        return int(base_seed)

    def emit(self, base_seed, prompt=None, extra_pnginfo=None, unique_id=None):
        used = _resolve_seed(base_seed)
        # Write the seed actually used into this queue's copy of the graph (not the live widget), so saved
        # images carry the real number instead of the randomize setting. From the RocketM fork (MIT).
        if unique_id is not None:
            node_id = str(unique_id)
            if prompt is not None and node_id in prompt:
                prompt[node_id]["inputs"]["base_seed"] = used
            if extra_pnginfo is not None:
                for node in (extra_pnginfo.get("workflow") or {}).get("nodes", []):
                    if str(node.get("id")) != node_id or node.get("type") != "LCSeed":
                        continue
                    if node.get("widgets_values"):
                        node["widgets_values"][0] = used
                    if "widgets_values_named" in node:
                        node["widgets_values_named"]["base_seed"] = used
                    break
        return {
            "ui": {"seed": [used]},
            "result": (used,),
        }


NODE_CLASS_MAPPINGS = {
    "LCSeed": LCSeed,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "LCSeed": "🌱LC Seed",
}
