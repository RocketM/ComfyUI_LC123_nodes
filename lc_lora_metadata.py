"""
LoRA settings and image ancestry from the queued graph, for LC Save Image's metadata. No model files are loaded.

Adapted from RainSounds' work in the RocketM fork of this pack (MIT): github.com/RocketM/ComfyUI_LC123_nodes.
Changed here: a switch whose branch cannot be worked out keeps every branch (the resource hashes would rather
list one model too many than lose the real one), and nothing is written to a Civitai resources block.

- image_ancestors(): the nodes the saved image actually depends on, following LC / core / rgthree switches when
  their choice can be read. Resource hashes are limited to these, so a LoRA on a branch that does not feed the
  saved image is not listed.
- collect_lora_metadata(): every LoRA slot with its model / CLIP strength, whether it is on, and whether it sits
  upstream of the saved image.
"""

import json
import math
import os


def _number(value):
    try:
        result = float(value)
        return result if math.isfinite(result) else None
    except (TypeError, ValueError):
        return None


def parse_lc_lora_rows(value):
    """LC LoRA Loader's serialized rows, with the loader's strength default."""
    try:
        rows = json.loads(value)
    except (TypeError, ValueError):
        return []
    if not isinstance(rows, list):
        return []
    return [{**row, "strength": _number(row.get("strength", 1.0)) or 0.0} for row in rows if isinstance(row, dict)]


def _resolve(value, prompt, seen=None):
    """A literal input value, following links only through primitive nodes."""
    if not (isinstance(value, list) and len(value) == 2):
        return value
    nid = str(value[0])
    seen = set() if seen is None else seen
    if nid in seen or value[1] != 0:
        return None
    seen.add(nid)
    node = prompt.get(nid, {})
    if node.get("class_type") not in ("PrimitiveFloat", "PrimitiveInt", "PrimitiveBoolean", "PrimitiveString"):
        return None
    return _resolve(node.get("inputs", {}).get("value"), prompt, seen)


def _cached_values(link, consumer, execution_list):
    if execution_list is None or not isinstance(link, list) or len(link) != 2:
        return None
    try:
        entry = execution_list.get_cache(str(link[0]), str(consumer))
        if entry is None:
            entry = execution_list.output_cache.get_local(str(link[0]))
    except Exception:
        return None
    if entry is None or getattr(entry, "outputs", None) is None or not isinstance(link[1], int) \
            or not 0 <= link[1] < len(entry.outputs):
        return None
    return entry.outputs[link[1]]


def image_ancestors(prompt, save_node_id, execution_list=None, unresolved=None):
    """Node ids the saved image depends on, or None when the save node is not in the graph."""
    node = prompt.get(str(save_node_id))
    if not node:
        return None
    pending = [(node.get("inputs", {}).get("images"), str(save_node_id))]
    visited = set()
    while pending:
        link, consumer = pending.pop()
        if not (isinstance(link, list) and len(link) == 2):
            continue
        nid = str(link[0])
        if nid in visited or nid not in prompt:
            continue
        visited.add(nid)
        inputs = prompt[nid].get("inputs", {})
        kind = prompt[nid].get("class_type")
        links = list(inputs.values())
        if kind in ("BooleanSwitchNode", "LCBooleanSwitch"):
            state = _resolve(inputs.get("state", inputs.get("boolean")), prompt)
            states = _cached_values(inputs.get("state", inputs.get("boolean")), nid, execution_list)
            if states is not None and all(isinstance(v, bool) for v in states):
                links = [inputs.get("on_true" if v else "on_false") for v in set(states)]
            elif isinstance(state, bool):
                links = [inputs.get("on_true" if state else "on_false")]
            elif unresolved is not None:
                unresolved.append(nid)  # keep every branch
        elif kind in ("LCAnySwitch", "Any Switch (rgthree)"):
            candidates = [v for k, v in inputs.items() if k.startswith("any_")]
            if len(candidates) > 1:
                output = _cached_values(link, consumer, execution_list)
                values = [(v, _cached_values(v, nid, execution_list)) for v in candidates]
                selected = []
                if output is not None:
                    for item in output:
                        for candidate, cached in values:
                            if item is not None and cached is not None and any(item is value for value in cached):
                                if candidate not in selected:
                                    selected.append(candidate)
                                break
                        else:
                            selected = []
                            break
                if selected:
                    links = [v for k, v in inputs.items() if not k.startswith("any_")] + selected
                elif unresolved is not None:
                    unresolved.append(nid)  # keep every branch
        pending.extend((value, nid) for value in links)
    return visited


def collect_lora_metadata(prompt, save_node_id=None, execution_list=None):
    """{'loras': [{node_id, slot, filename, name, enabled, active, strength_model, strength_clip, upstream}]}"""
    prompt = {str(k): v for k, v in (prompt or {}).items() if isinstance(v, dict)}
    ancestors = image_ancestors(prompt, save_node_id, execution_list) if save_node_id is not None else None

    def resolve(value, consumer):
        literal = _resolve(value, prompt)
        if literal is not None:
            return literal
        cached = _cached_values(value, consumer, execution_list)
        if cached and all(isinstance(v, (str, bool, int, float)) for v in cached) and all(v == cached[0] for v in cached):
            return cached[0]
        return None

    records = []
    for nid, node in prompt.items():
        kind = node.get("class_type", "")
        inputs = node.get("inputs", {})
        slots = []
        if kind == "LCLoraLoader":
            for index, row in enumerate(parse_lc_lora_rows(resolve(inputs.get("lora_rows", "[]"), nid))):
                model = row["strength"] if inputs.get("model") is not None else 0.0
                clip = row["strength"] if inputs.get("clip") is not None else 0.0
                slots.append((f"lora_rows[{index}]", row.get("lora"), bool(row.get("on")), model, clip))
        else:
            # core / rgthree style: lora_name + strength(s) on the node, or per-row dicts (Power Lora Loader)
            for slot, values in [("lora", inputs)] + [(k, v) for k, v in inputs.items() if isinstance(v, dict)]:
                name = resolve(values.get("lora_name", values.get("lora")), nid)
                if name is None or not any(k in values for k in ("strength", "strength_model", "strength_clip", "strengthTwo")):
                    continue
                model = _number(resolve(values.get("strength_model", values.get("strength")), nid))
                if "strength_clip" in values:
                    clip_value = values["strength_clip"]
                elif values.get("strengthTwo") is not None:
                    clip_value = values["strengthTwo"]
                elif inputs.get("clip") is not None:
                    clip_value = values.get("strength")
                else:
                    clip_value = 0.0
                clip = _number(resolve(clip_value, nid))
                enabled = all(bool(resolve(values.get(k, True), nid)) for k in ("on", "enabled"))
                slots.append((slot, name, enabled, model, clip))
        for slot, name, enabled, model, clip in slots:
            if not isinstance(name, str) or not name or name.lower() == "none":
                continue
            # an unreadable strength (None) counts as applied
            active = enabled and (model is None or clip is None or model != 0.0 or clip != 0.0)
            records.append({
                "node_id": nid, "slot": slot, "filename": name,
                "name": os.path.splitext(name.replace("\\", "/").rsplit("/", 1)[-1])[0],
                "enabled": enabled, "active": active, "strength_model": model, "strength_clip": clip,
                "upstream": None if ancestors is None else nid in ancestors,
            })
    return {"loras": records}


def inactive_lora_files(metadata):
    """LoRA files that are seen and NOT in use for this image: off, at strength 0, or off the image's branch.
    A file used anywhere upstream with a non-zero strength is never in here."""
    used, seen = set(), set()
    for r in metadata.get("loras", []):
        seen.add(r["filename"])
        if r["active"] and r["upstream"] is not False:
            used.add(r["filename"])
    return seen - used
