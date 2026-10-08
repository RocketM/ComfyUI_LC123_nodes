"""
LC Node Snapshot 📋
Wire **source** from the node to inspect (preferred), or set **target** title/id.

widget_name is a STRING so any real widget name validates.
JS fills a dropdown of **widget names** — not the options inside those widgets.
"""

from __future__ import annotations

import json

# Values each node actually ran with (after wires are resolved), by node id. Filled by a thin wrapper around
# ComfyUI's input resolver, so a seed from a seed node or a denoise from a slider shows its real value.
_RAN_WITH = {}
_SIMPLE = (bool, int, float, str)


def _hook_inputs():
    try:
        import execution
    except Exception:
        return
    orig = getattr(execution, "get_input_data", None)
    if orig is None or getattr(orig, "_lc_snapshot", False):
        return

    def get_input_data(inputs, class_def, unique_id, *args, **kwargs):
        out = orig(inputs, class_def, unique_id, *args, **kwargs)
        try:
            data = out[0] if isinstance(out, tuple) else out
            vals = {}
            for k, v in (data or {}).items():
                v = v[0] if isinstance(v, list) and len(v) == 1 else v
                if isinstance(v, _SIMPLE):
                    vals[k] = v
            _RAN_WITH[str(unique_id)] = vals
        except Exception:
            pass
        return out

    get_input_data._lc_snapshot = True
    execution.get_input_data = get_input_data


_hook_inputs()


def _ran_with(node_id):
    """Values the node ran with. Inside a subgraph the id is 'parent:child', so match the last part too."""
    if node_id is None:
        return None
    key = str(node_id)
    if key in _RAN_WITH:
        return _RAN_WITH[key]
    hits = [v for k, v in _RAN_WITH.items() if k.split(":")[-1] == key]
    return hits[0] if len(hits) == 1 else None


def _fmt(v):
    if isinstance(v, (dict, list)):
        try:
            return json.dumps(v, separators=(",", ":"))
        except Exception:
            return str(v)
    if isinstance(v, bool):
        return "true" if v else "false"
    return str(v)


def _use_ran_values(js, widget_name, sel):
    """Swap the widget values in the snapshot for the values the node actually ran with."""
    try:
        snap = json.loads(js)
    except Exception:
        return None
    ran = _ran_with(snap.get("node_id"))
    widgets = snap.get("widgets")
    if not ran or not isinstance(widgets, dict):
        return None
    for k in widgets:
        if k in ran:
            widgets[k] = ran[k]
    lines = [f"node_id: {snap.get('node_id') if snap.get('node_id') is not None else ''}",
             f"node_type: {snap.get('node_type') or ''}", f"node_title: {snap.get('node_title') or ''}"]
    lines += [f"{k}: {_fmt(v)}" for k, v in widgets.items()]
    if widget_name in widgets:
        sel = _fmt(widgets[widget_name])
    return sel, "\n".join(lines), json.dumps(snap, indent=2)


class LCNodeSnapshot:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "widget_name": (
                    "STRING",
                    {
                        "default": "",
                        "tooltip": "Name of a parameter widget on the target (e.g. preset, strength).",
                    },
                ),
            },
            "optional": {
                "source": (
                    "*",
                    {
                        "tooltip": "Wire any output from the node you want to inspect. Takes priority over target text.",
                    },
                ),
                "target": (
                    "STRING",
                    {
                        "default": "",
                        "tooltip": "Fallback: node title (exact) or numeric id if source is not connected.",
                    },
                ),
            },
            # Not shown on the node face — filled by JS into the prompt at queue time
            "hidden": {
                "selected_value": ("STRING", {"default": ""}),
                "lines_dump": ("STRING", {"default": ""}),
                "json_dump": ("STRING", {"default": ""}),
            },
        }

    RETURN_TYPES = ("STRING", "STRING", "STRING")
    RETURN_NAMES = ("selected", "lines", "json")
    FUNCTION = "run"
    CATEGORY = "LC123/utils"
    DESCRIPTION = (
        "Snapshot another node's widgets. Connect **source** (or target title/id). "
        "Dropdown lists **widget names**. Outputs: selected, lines, json."
    )

    def run(
        self,
        widget_name,
        source=None,
        target="",
        selected_value="",
        lines_dump="",
        json_dump="",
        **kwargs,
    ):
        sel = "" if selected_value is None else str(selected_value)
        lines = "" if lines_dump is None else str(lines_dump)
        js = "" if json_dump is None else str(json_dump)
        # Wired source = the target already ran, so its real (wired) values are known.
        if source is not None and js:
            ran = _use_ran_values(js, widget_name, sel)
            if ran:
                return ran
        if not lines and (target or source is not None):
            lines = f"node_id: \nnode_type: \nnode_title: {target or ''}\n"
        if not js:
            js = json.dumps(
                {
                    "node_id": None,
                    "node_type": None,
                    "node_title": target or "",
                    "widgets": {},
                },
                indent=2,
            )
        return (sel, lines, js)


NODE_CLASS_MAPPINGS = {
    "LCNodeSnapshot": LCNodeSnapshot,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "LCNodeSnapshot": "LC Node Snapshot 📋",
}
