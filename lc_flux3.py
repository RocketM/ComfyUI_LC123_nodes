"""
LC Flux 3 nodes
---------------
- LC Bounding Boxes 🔲: draw boxes on a picture (a DOM canvas, so it works in the classic canvas and in Nodes 2.0). Each box
  has a name, a description and what happens to it (new, change, move, remove). Outputs the same BOUNDING_BOX and ARRAY
  as ComfyUI's Create Bounding Boxes, so it plugs into any node that takes those.
- LC Flux 3 Layout Prompt 🗺️: adds the boxes to a FLUX 3 prompt as BFL's element table. New pictures get the layout table
  {id, bbox, desc}; edits get the edit table {id, from, src_bbox, tgt_bbox, desc}. Write <1>, <2> in the prompt for box 1,
  box 2: they become the box ids (<earring_1>).
- LC Flux 3 Reference Latent 🖼️: up to 4 reference pictures on the positive and negative, the negative FLUX 3 wants
  (zeroed for the distilled model, an empty prompt for Base) and the latent to sample, from picture 1 or a size you set.

Box tables follow BFL's prompt upsampler instructions (flux-3-image-klein-pup system_prompts.json, Apache-2.0): boxes are
[y_min, x_min, y_max, x_max] on a 0 to 1000 grid, top-left origin.
"""
from __future__ import annotations

import json
import math
import re

import numpy as np
import torch
from PIL import Image, ImageDraw, ImageEnhance, ImageFont

import comfy.utils
import node_helpers
import nodes

KINDS = ["new", "change", "move", "remove"]
KIND_COLORS = {"new": (90, 200, 120), "change": (90, 160, 240), "move": (240, 180, 60), "remove": (230, 80, 80)}


# ---------------------------------------------------------------- boxes
def _grid(v):
    return max(0, min(1000, int(round(v * 1000))))


def _frac_box(b):
    """[y_min, x_min, y_max, x_max] on the 0-1000 grid from a {x, y, w, h} box in 0-1 fractions."""
    x, y, w, h = (float(b.get(k, 0.0)) for k in ("x", "y", "w", "h"))
    x0, x1 = sorted((x, x + w))
    y0, y1 = sorted((y, y + h))
    return [_grid(y0), _grid(x0), _grid(y1), _grid(x1)]


def _clean_name(name, fallback="object"):
    name = re.sub(r"[^a-z0-9]+", "_", str(name or "").strip().lower()).strip("_")
    return name or fallback


def parse_boxes(raw):
    """The canvas state: [{x, y, w, h, name, kind, desc, text, to: {x, y, w, h} | None, ref}] in 0-1 fractions."""
    try:
        data = json.loads(raw) if isinstance(raw, str) else raw
    except (ValueError, TypeError):
        return []
    out = []
    for b in data if isinstance(data, list) else []:
        if not isinstance(b, dict) or float(b.get("w", 0)) == 0 or float(b.get("h", 0)) == 0:
            continue
        kind = b.get("kind") if b.get("kind") in KINDS else "new"
        to = b.get("to") if kind == "move" and isinstance(b.get("to"), dict) else None
        out.append({**b, "kind": kind, "to": to})
    return out


def number_ids(boxes):
    """BFL ids: the class noun plus an index per class (person_1, person_2, cup_1); text blocks are En_Text_N."""
    count, ids = {}, []
    for b in boxes:
        stem = "En_Text" if b.get("type") == "text" else _clean_name(b.get("name"))
        count[stem] = count.get(stem, 0) + 1
        ids.append(f"{stem}_{count[stem]}")
    return ids


def to_elements(boxes, ref=0):
    """Elements for ARRAY consumers. Core keys (type, bbox, desc, text) plus the edit keys (id, from, src_bbox, tgt_bbox)."""
    ids = number_ids(boxes)
    els = []
    for b, bid in zip(boxes, ids):
        src = _frac_box(b)
        tgt = _frac_box(b["to"]) if b["kind"] == "move" and b.get("to") else src
        el = {"id": bid, "type": "text" if b.get("type") == "text" else "obj", "desc": str(b.get("desc") or "").strip(),
              "bbox": tgt if b["kind"] != "remove" else src, "kind": b["kind"]}
        if el["type"] == "text":
            el["text"] = str(b.get("text") or "")
        if b["kind"] == "new":
            el.update({"from": "target", "src_bbox": None, "tgt_bbox": src})
        elif b["kind"] == "remove":
            el.update({"from": f"ref_image_{int(b.get('ref', ref) or 0)}", "src_bbox": src, "tgt_bbox": None})
        else:  # change keeps its place, move goes to its second box
            el.update({"from": f"ref_image_{int(b.get('ref', ref) or 0)}", "src_bbox": src, "tgt_bbox": tgt})
        els.append(el)
    return els


def _font(size):
    try:
        return ImageFont.load_default(size)
    except Exception:
        return ImageFont.load_default()


def render_preview(boxes, width, height, image=None):
    long_edge = 1024
    if image is not None:
        arr = (image[0, ..., :3].clamp(0, 1).cpu().numpy() * 255).astype(np.uint8)
        bg = Image.fromarray(arr)
        s = min(1.0, long_edge / max(bg.size))
        bg = bg.resize((max(1, round(bg.width * s)), max(1, round(bg.height * s))), Image.LANCZOS)
        bg = ImageEnhance.Brightness(bg).enhance(0.45)
    else:
        s = min(1.0, long_edge / max(width, height))
        bg = Image.new("RGB", (max(1, round(width * s)), max(1, round(height * s))), (40, 40, 40))
    rw, rh = bg.size
    draw = ImageDraw.Draw(bg)
    fs = max(12, rh // 48)
    font = _font(fs)
    ids = number_ids(boxes)

    def rect(b):
        x0, x1 = sorted((b["x"] * rw, (b["x"] + b["w"]) * rw))
        y0, y1 = sorted((b["y"] * rh, (b["y"] + b["h"]) * rh))
        return [x0, y0, x1, y1]

    for b, bid in zip(boxes, ids):
        c = KIND_COLORS[b["kind"]]
        r = rect(b)
        draw.rectangle(r, outline=c, width=3)
        if b["kind"] == "remove":
            draw.line([r[0], r[1], r[2], r[3]], fill=c, width=2)
            draw.line([r[0], r[3], r[2], r[1]], fill=c, width=2)
        if b["kind"] == "move" and b.get("to"):
            t = rect(b["to"])
            draw.rectangle(t, outline=c, width=2)
            draw.line([(r[0] + r[2]) / 2, (r[1] + r[3]) / 2, (t[0] + t[2]) / 2, (t[1] + t[3]) / 2], fill=c, width=2)
        label = f"{bid} ({b['kind']})"
        tw = draw.textlength(label, font=font)
        draw.rectangle([r[0], r[1], r[0] + tw + 8, r[1] + fs + 4], fill=c)
        draw.text((r[0] + 4, r[1] + 1), label, fill=(0, 0, 0), font=font)
    arr = np.asarray(bg, dtype=np.float32) / 255.0
    return torch.from_numpy(arr).unsqueeze(0)


def _incoming(data, width, height):
    """Upstream boxes (core BOUNDING_BOX frames, core elements or JSON) as canvas boxes."""
    if data is None:
        return []
    if isinstance(data, str):
        try:
            data = json.loads(data) if data.strip() else []
        except ValueError:
            return []
    if isinstance(data, dict):
        data = [data]
    if isinstance(data, list) and data and isinstance(data[0], list):
        data = data[0]
    out = []
    for d in data if isinstance(data, list) else []:
        if not isinstance(d, dict):
            continue
        if isinstance(d.get("bbox") or d.get("src_bbox") or d.get("tgt_bbox"), (list, tuple)):
            bb = d.get("src_bbox") or d.get("bbox") or d.get("tgt_bbox")
            y0, x0, y1, x1 = (float(v) / 1000 for v in bb)
            kind = d.get("kind") or ("new" if d.get("from") == "target" else "remove" if d.get("from") and d.get("tgt_bbox") is None
                                     else "move" if d.get("src_bbox") and d.get("tgt_bbox") and d["src_bbox"] != d["tgt_bbox"] else "change")
            box = {"x": x0, "y": y0, "w": x1 - x0, "h": y1 - y0, "kind": kind, "desc": d.get("desc", ""),
                   "name": re.sub(r"_\d+$", "", str(d.get("id") or "object")), "type": "text" if d.get("type") == "text" else "obj",
                   "text": d.get("text", ""), "to": None}
            if kind == "move" and d.get("tgt_bbox"):
                ty0, tx0, ty1, tx1 = (float(v) / 1000 for v in d["tgt_bbox"])
                box["to"] = {"x": tx0, "y": ty0, "w": tx1 - tx0, "h": ty1 - ty0}
            out.append(box)
        elif all(k in d for k in ("x", "y", "width", "height")):
            meta = d.get("metadata") if isinstance(d.get("metadata"), dict) else {}
            out.append({"x": d["x"] / max(1, width), "y": d["y"] / max(1, height), "w": d["width"] / max(1, width), "h": d["height"] / max(1, height),
                        "kind": "new", "desc": meta.get("desc", ""), "name": "object", "type": meta.get("type", "obj"), "text": meta.get("text", ""), "to": None})
    return out


class LCBoundingBoxes:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "width": ("INT", {"default": 1024, "min": 64, "max": 16384, "step": 16,
                                  "tooltip": "Canvas width when no picture is connected (a connected picture sets the size)."}),
                "height": ("INT", {"default": 1024, "min": 64, "max": 16384, "step": 16,
                                   "tooltip": "Canvas height when no picture is connected."}),
                "boxes": ("STRING", {"default": "[]", "multiline": False, "tooltip": "The boxes drawn on the canvas (kept by the node)."}),
            },
            "optional": {
                "image": ("IMAGE", {"tooltip": "The picture to draw on. Its size sets the box grid. For an edit, this is ref_image_0."}),
                "bboxes": ("BOUNDING_BOX,ARRAY,STRING", {"tooltip": "Boxes from another node (Create Bounding Boxes, a layout JSON) to start the canvas with. "
                                                                    "Boxes drawn here win until the incoming boxes change."}),
            },
        }

    RETURN_TYPES = ("IMAGE", "BOUNDING_BOX", "ARRAY")
    RETURN_NAMES = ("preview", "bboxes", "elements")
    OUTPUT_TOOLTIPS = ("The picture with the boxes drawn on it.",
                       "Pixel boxes (the same as Create Bounding Boxes).",
                       "The boxes with their names, descriptions and what happens to them, for LC Flux 3 Layout Prompt "
                       "(or FLUX.3 Layout Prompt).")
    FUNCTION = "run"
    CATEGORY = "LC123/Flux 3"
    OUTPUT_NODE = True
    DESCRIPTION = ("Draw boxes on a picture: drag on empty space for a new box, drag a box to move it, its corner to resize. "
                   "Each box gets a name, a description and what happens to it: new, change, move (drag its second box) "
                   "or remove. Works in the classic canvas and in Nodes 2.0.")

    def run(self, width, height, boxes, image=None, bboxes=None):
        if image is not None:
            height, width = int(image.shape[1]), int(image.shape[2])
        drawn = parse_boxes(boxes)
        incoming = _incoming(bboxes, width, height)
        ui = {"lc_size": [{"width": width, "height": height}]}
        if incoming:
            ui["lc_incoming"] = [json.dumps(incoming)]
            if not drawn:
                drawn = parse_boxes(incoming)
        if image is not None:
            saved = nodes.PreviewImage().save_images(image[:1], "lc.bboxes.background")
            ui["lc_background"] = saved["ui"]["images"]
        preview = render_preview(drawn, width, height, image)
        pixels = [{"x": round(min(b["x"], b["x"] + b["w"]) * width), "y": round(min(b["y"], b["y"] + b["h"]) * height),
                   "width": round(abs(b["w"]) * width), "height": round(abs(b["h"]) * height)} for b in drawn]
        return {"ui": ui, "result": (preview, [pixels] if pixels else [], to_elements(drawn))}


# ---------------------------------------------------------------- layout prompt
class LCFlux3LayoutPrompt:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "prompt": ("STRING", {"multiline": True, "dynamic_prompts": True, "default": "",
                                      "tooltip": "The caption (new picture) or instruction (edit). Write <1>, <2> for box 1, box 2, or the box ids "
                                                 "themselves (<earring_1>). Every box should be named once."}),
                "elements": ("ARRAY", {"tooltip": "The boxes from LC Bounding Boxes (or Create Bounding Boxes)."}),
                "table": (["auto", "layout (new picture)", "edit (from a reference)"], {"default": "auto",
                          "tooltip": "auto: the edit table when a box changes, moves or removes something, otherwise the layout table."}),
            },
            "optional": {
                "keep_rest": ("BOOLEAN", {"default": True, "tooltip": "Edits: end with BFL's closing clause that everything else stays identical."}),
            },
        }

    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("prompt", "info")
    FUNCTION = "run"
    CATEGORY = "LC123/Flux 3"
    DESCRIPTION = "Adds the boxes to a FLUX 3 prompt as BFL's element table, the way the model was trained."

    def run(self, prompt, elements, table, keep_rest=True):
        els = [e for e in (elements if isinstance(elements, list) else []) if isinstance(e, dict) and e.get("bbox")]
        if not els:
            return (prompt, "No boxes: the prompt goes through unchanged.")
        ids = [e.get("id") or f"obj_{i + 1}" for i, e in enumerate(els)]
        text = re.sub(r"<(\d+)>", lambda m: f"<{ids[int(m.group(1)) - 1]}>" if 0 < int(m.group(1)) <= len(ids) else m.group(0), prompt.strip())
        edit = table.startswith("edit") or (table == "auto" and any(e.get("kind") in ("change", "move", "remove") for e in els))
        rows = []
        for e, bid in zip(els, ids):
            desc = str(e.get("desc") or "").strip()
            if e.get("type") == "text" and e.get("text"):
                desc = f'{desc} "{e["text"]}"'.strip()
            if edit:
                src, tgt = e.get("src_bbox", e["bbox"]), e.get("tgt_bbox", e["bbox"])
                rows.append({"id": bid, "from": e.get("from") or "ref_image_0", "src_bbox": src, "tgt_bbox": tgt, "desc": desc})
            else:
                rows.append({"id": bid, "bbox": e.get("tgt_bbox") or e["bbox"], "desc": desc})
        if edit and keep_rest and not re.search(r"(stays?|remains?|kept|keep)\b[^.]*\b(identical|unchanged|same)", text, re.I):
            text = text.rstrip(". ") + ". Everything else stays identical to the source."
        missing = [b for b in ids if f"<{b}>" not in text]
        info = f"{'Edit' if edit else 'Layout'} table, {len(rows)} box{'es' if len(rows) != 1 else ''}."
        if missing:
            info += " Not named in the prompt: " + ", ".join(f"<{m}>" for m in missing) + " (name each box once)."
        return (f"{text} {json.dumps(rows, ensure_ascii=False)}", info)


# ---------------------------------------------------------------- reference latent
class LCFlux3ReferenceLatent:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "positive": ("CONDITIONING", {"tooltip": "The encoded prompt."}),
                "vae": ("VAE",),
                "model": (["distilled (cfg 1)", "base (cfg 3.5)"], {"default": "distilled (cfg 1)",
                          "tooltip": "Sets the negative when none is connected: distilled = the zeroed prompt, Base = an empty prompt "
                                     "(needs the clip)."}),
                "reference_size": (["1 MP", "2 MP", "4 MP", "keep size"], {"default": "1 MP",
                                   "tooltip": "Each reference picture is scaled to this many megapixels (shape kept). BFL keeps references "
                                              "at their own size: more detail, slower."}),
                "width": ("INT", {"default": 0, "min": 0, "max": 16384, "step": 16, "tooltip": "Size of the result. 0 = the size of picture 1 "
                                                                                              "(1024 when there is none)."}),
                "height": ("INT", {"default": 0, "min": 0, "max": 16384, "step": 16, "tooltip": "0 = the size of picture 1."}),
            },
            "optional": {
                "image_1": ("IMAGE", {"tooltip": "<ref_image_0> in the prompt."}),
                "image_2": ("IMAGE", {"tooltip": "<ref_image_1>."}),
                "image_3": ("IMAGE", {"tooltip": "<ref_image_2>."}),
                "image_4": ("IMAGE", {"tooltip": "<ref_image_3>."}),
                "negative": ("CONDITIONING", {"tooltip": "Your own negative. Empty = set by model."}),
                "clip": ("CLIP", {"tooltip": "Only for Base without a negative: encodes the empty prompt."}),
            },
        }

    RETURN_TYPES = ("CONDITIONING", "CONDITIONING", "LATENT", "INT", "INT")
    RETURN_NAMES = ("positive", "negative", "latent", "width", "height")
    FUNCTION = "run"
    CATEGORY = "LC123/Flux 3"
    DESCRIPTION = ("FLUX 3 references in one node: up to 4 pictures on the positive and negative, the negative the model wants, "
                   "and the latent to sample (picture 1's size, or your own). No pictures = plain text to image.")

    def run(self, positive, vae, model, reference_size, width, height, image_1=None, image_2=None, image_3=None, image_4=None,
            negative=None, clip=None):
        if negative is None:
            if model.startswith("base"):
                if clip is None:
                    raise ValueError("[LC Flux 3 Reference Latent] Base needs a negative: connect the clip (it encodes the empty prompt) "
                                     "or your own negative.")
                negative = clip.encode_from_tokens_scheduled(clip.tokenize(""))
            else:
                negative = [[torch.zeros_like(c[0]), {k: (torch.zeros_like(v) if k == "pooled_output" and v is not None else v)
                                                      for k, v in c[1].items()}] for c in positive]
        refs, first = [], None
        for img in (image_1, image_2, image_3, image_4):
            if img is None:
                continue
            img = img[..., :3]
            if reference_size != "keep size":
                mp = float(reference_size.split()[0])
                h, w = img.shape[1:3]
                s = math.sqrt(mp * 1024 * 1024 / (w * h))
                img = comfy.utils.common_upscale(img.movedim(-1, 1), max(16, round(w * s / 16) * 16), max(16, round(h * s / 16) * 16),
                                                 "lanczos", "disabled").movedim(1, -1)
            if first is None:
                first = img.shape[1:3]
            refs.append(vae.encode(img))
        if refs:
            positive = node_helpers.conditioning_set_values(positive, {"reference_latents": refs}, append=True)
            negative = node_helpers.conditioning_set_values(negative, {"reference_latents": refs}, append=True)
        if not width or not height:
            h, w = first if first is not None else (1024, 1024)
            width, height = width or int(w), height or int(h)
        width, height = max(16, width // 16 * 16), max(16, height // 16 * 16)
        if refs and (width, height) == (int(first[1]), int(first[0])):
            latent = {"samples": torch.zeros_like(refs[0])}
        else:
            from comfy_extras.nodes_flux import EmptyFlux2LatentImage
            out = EmptyFlux2LatentImage.execute(width, height, 1)
            latent = (out.result if hasattr(out, "result") else out)[0]
        return (positive, negative, latent, width, height)


NODE_CLASS_MAPPINGS = {
    "LCBoundingBoxes": LCBoundingBoxes,
    "LCFlux3LayoutPrompt": LCFlux3LayoutPrompt,
    "LCFlux3ReferenceLatent": LCFlux3ReferenceLatent,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "LCBoundingBoxes": "LC Bounding Boxes 🔲",
    "LCFlux3LayoutPrompt": "LC Flux 3 Layout Prompt 🗺️",
    "LCFlux3ReferenceLatent": "LC Flux 3 Reference Latent 🖼️",
}
