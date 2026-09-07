"""
LC Widget To String
-------------------
KJNodes WidgetToString, LC-named.

any_input unconnected AND id == 0 AND no node_title → dormant:
returns "" and does not search the graph (no error).
Wire any_input (or set id / title) to wake it.
"""

from __future__ import annotations

import logging


class AnyType(str):
    def __ne__(self, __value: object) -> bool:
        return False


any_type = AnyType("*")


def _dormant(id_val, node_title, any_input) -> bool:
    try:
        nid = int(id_val or 0)
    except (TypeError, ValueError):
        nid = 0
    title = (node_title or "").strip()
    return any_input is None and nid == 0 and not title


class LCWidgetToString:
    @classmethod
    def IS_CHANGED(cls, id=0, node_title="", any_input=None, **kwargs):
        if _dormant(id, node_title, any_input):
            return 0
        if any_input is not None and (int(id or 0) != 0 or (node_title or "").strip()):
            return float("NaN")
        return float("NaN")

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "id": (
                    "INT",
                    {
                        "default": 0,
                        "min": 0,
                        "max": 100000,
                        "step": 1,
                        "tooltip": "Target node id. 0 = unused (use any_input or title).",
                    },
                ),
                "widget_name": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": False,
                        "tooltip": "Widget name, or comma-separated list.",
                    },
                ),
                "return_all": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "tooltip": "Dump every widget on the target as name: value.",
                    },
                ),
            },
            "optional": {
                "any_input": (
                    any_type,
                    {
                        "tooltip": "Wire this to the node you want to read. Required for dormant-until-wired behavior. Also used when id and title are empty.",
                    },
                ),
                "node_title": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": False,
                        "tooltip": "Match a manually edited node title.",
                    },
                ),
                "allowed_float_decimals": (
                    "INT",
                    {
                        "default": 2,
                        "min": 0,
                        "max": 10,
                        "tooltip": "Decimal places for floats.",
                    },
                ),
            },
            "hidden": {
                "extra_pnginfo": "EXTRA_PNGINFO",
                "prompt": "PROMPT",
                "unique_id": "UNIQUE_ID",
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("STRING",)
    FUNCTION = "get_widget_value"
    CATEGORY = "LC123/text"
    DESCRIPTION = (
        "Read a widget on another node as STRING (KJ WidgetToString). "
        "No any_input, id 0, empty title → dormant, returns empty string."
    )

    def get_widget_value(
        self,
        id,
        widget_name,
        extra_pnginfo,
        prompt,
        unique_id,
        return_all=False,
        any_input=None,
        node_title="",
        allowed_float_decimals=2,
    ):
        if _dormant(id, node_title, any_input):
            return ("",)

        workflow = (extra_pnginfo or {}).get("workflow") or {}
        results = []
        node_id = link_id = subgraph_prefix = None
        link_to_node_map = {}
        node_to_subgraph_map = {}

        if isinstance(unique_id, str) and ":" in unique_id:
            parts = unique_id.split(":")
            unique_id_int = int(parts[-1])
            subgraph_prefix = ":".join(parts[:-1])
        else:
            unique_id_int = int(unique_id)

        all_nodes = list(workflow.get("nodes", []))
        definitions = workflow.get("definitions", {}) or {}
        subgraphs = definitions.get("subgraphs", []) or []

        subgraph_id_to_parent = {}
        for node in workflow.get("nodes", []):
            node_type = node.get("type", "")
            if "-" in node_type and len(node_type) == 36:
                subgraph_id_to_parent[node_type] = node["id"]

        for subgraph in subgraphs:
            subgraph_id = subgraph.get("id", "")
            parent_node_id = subgraph_id_to_parent.get(subgraph_id)
            for node in subgraph.get("nodes", []) or []:
                if parent_node_id is not None:
                    node_to_subgraph_map[node["id"]] = parent_node_id
            all_nodes.extend(subgraph.get("nodes", []) or [])
            for link in subgraph.get("links", []) or []:
                if isinstance(link, dict):
                    link_to_node_map[link["id"]] = link["origin_id"]
                elif isinstance(link, list) and len(link) >= 2:
                    link_to_node_map[link[0]] = link[1]

        title = (node_title or "").strip()
        for node in all_nodes:
            if title:
                if node.get("title") == title:
                    node_id = node["id"]
                    break
                if "title" not in node:
                    logging.warning("Node title not found.")
            elif int(id or 0) != 0:
                if node["id"] == id:
                    node_id = id
                    break
            elif any_input is not None:
                if (
                    node.get("type") in ("LCWidgetToString", "WidgetToString")
                    and node["id"] == unique_id_int
                    and not link_id
                ):
                    for node_input in node.get("inputs") or []:
                        if node_input.get("name") == "any_input":
                            link_id = node_input.get("link")

                node_outputs = node.get("outputs")
                if not node_outputs:
                    continue
                for output in node_outputs:
                    node_links = output.get("links")
                    if not node_links:
                        continue
                    for link in node_links:
                        link_to_node_map[link] = node["id"]

        if link_id:
            node_id = link_to_node_map.get(link_id, None)

        if node_id is None:
            return ("",)

        target_subgraph_parent = node_to_subgraph_map.get(node_id)
        if target_subgraph_parent is not None:
            prompt_key = f"{target_subgraph_parent}:{node_id}"
        elif subgraph_prefix is not None:
            prompt_key = f"{subgraph_prefix}:{node_id}"
        else:
            prompt_key = str(node_id)

        if prompt_key not in prompt:
            prompt_key = str(node_id)
        if prompt_key not in prompt:
            return ("",)

        values = prompt[prompt_key]
        if "inputs" not in values:
            return ("",)

        inputs = values["inputs"]
        widget_names = []
        if widget_name:
            widget_names = [w.strip() for w in widget_name.split(",") if w.strip()]

        if return_all:
            formatted_items = []
            for k, v in inputs.items():
                if isinstance(v, float):
                    item = f"{k}: {v:.{allowed_float_decimals}f}"
                else:
                    item = f"{k}: {str(v)}"
                formatted_items.append(item)
            results.append(", ".join(formatted_items))
            return (", ".join(results).strip(", "),)

        if len(widget_names) == 1:
            name = widget_names[0]
            if name not in inputs:
                return ("",)
            v = inputs[name]
            if isinstance(v, float):
                v = f"{v:.{allowed_float_decimals}f}"
            else:
                v = str(v)
            return (v,)

        if len(widget_names) > 1:
            formatted_items = []
            for name in widget_names:
                if name not in inputs:
                    continue
                v = inputs[name]
                if isinstance(v, float):
                    v = f"{v:.{allowed_float_decimals}f}"
                else:
                    v = str(v)
                formatted_items.append(f"{name}: {v}")
            return (", ".join(formatted_items),)

        return ("",)


NODE_CLASS_MAPPINGS = {
    "LCWidgetToString": LCWidgetToString,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "LCWidgetToString": "LC Widget To String",
}
