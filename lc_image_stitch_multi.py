"""
LC Image Stitch Multi
---------------------
Stitch images side by side or stacked, from autogrow slots (same slots as LC Batch Image).
Missing / muted / empty sockets are skipped. Batches stitch frame by frame; a shorter batch repeats its last frame.
Same idea as KJNodes' Image Concatenate Multi, written for LC123.
"""

from __future__ import annotations

import torch
import torch.nn.functional as F

from .lc_batch_image import MAX_INPUTS, _as_nchw_batch

DIRECTIONS = ["right", "down", "left", "up"]
MATCH = ["off", "match first"]
ALIGN = ["center", "start", "end"]


def _hex(color: str):
    s = str(color or "").strip().lstrip("#")
    if len(s) == 3:
        s = "".join(ch * 2 for ch in s)
    try:
        return [int(s[i:i + 2], 16) / 255.0 for i in (0, 2, 4)]
    except ValueError:
        return [0.0, 0.0, 0.0]


def _channels(t: torch.Tensor, c: int) -> torch.Tensor:
    if t.shape[-1] == c:
        return t
    if t.shape[-1] == 1:
        t = t.repeat(1, 1, 1, 3)
    if c == 4 and t.shape[-1] == 3:
        return torch.cat([t, torch.ones_like(t[..., :1])], dim=-1)
    return t[..., :c]


def _resize(t: torch.Tensor, h: int, w: int) -> torch.Tensor:
    if t.shape[1] == h and t.shape[2] == w:
        return t
    x = F.interpolate(t.permute(0, 3, 1, 2).float(), size=(h, w), mode="bicubic", antialias=True, align_corners=False)
    return x.clamp(0, 1).permute(0, 2, 3, 1).to(t.dtype)


class LCImageStitchMulti:
    @classmethod
    def INPUT_TYPES(cls):
        optional = {
            f"image_{i:02d}": ("IMAGE", {"tooltip": "Skipped if disconnected, muted, or empty."})
            for i in range(1, MAX_INPUTS + 1)
        }
        return {
            "required": {
                "direction": (DIRECTIONS, {
                    "default": "right",
                    "tooltip": "Where each next image goes: right / left = side by side, down / up = stacked.",
                }),
                "match_size": (MATCH, {
                    "default": "match first",
                    "tooltip": (
                        "match first: every image is scaled (shape kept) to the first image's height (side by side) "
                        "or width (stacked), so the edges line up.\noff: images keep their own size."
                    ),
                }),
                "align": (ALIGN, {
                    "default": "center",
                    "tooltip": "Where a smaller image sits along the seam when sizes differ: center, start (top / left) or end.",
                }),
                "gap": ("INT", {"default": 0, "min": 0, "max": 512, "step": 1,
                                "tooltip": "Space between the images, in pixels."}),
                "gap_color": ("STRING", {"default": "#000000",
                                         "tooltip": "Color of the gap and of any empty space around smaller images (hex)."}),
            },
            "optional": optional,
        }

    RETURN_TYPES = ("IMAGE", "INT", "INT")
    RETURN_NAMES = ("image", "width", "height")
    FUNCTION = "stitch"
    CATEGORY = "LC123/image"
    DESCRIPTION = (
        "Stitch images side by side or stacked from autogrow slots. Muted or empty slots are skipped. "
        "match first lines the edges up by scaling to the first image."
    )

    def stitch(self, direction="right", match_size="match first", align="center", gap=0, gap_color="#000000", **kwargs):
        images = []
        for i in range(1, MAX_INPUTS + 1):
            t = _as_nchw_batch(kwargs.get(f"image_{i:02d}"))
            if t is not None:
                images.append(t)
        if not images:
            raise ValueError("LC Image Stitch Multi: no images received. Every slot is empty, muted, or disconnected.")

        first = images[0]
        device, dtype = first.device, first.dtype
        c = max(t.shape[-1] for t in images)
        c = 4 if c >= 4 else 3
        side = direction in ("right", "left")
        h0, w0 = first.shape[1], first.shape[2]

        parts = []
        for t in images:
            t = _channels(t.to(device=device, dtype=dtype), c)
            if match_size != "off":
                h, w = t.shape[1], t.shape[2]
                if side:
                    t = _resize(t, h0, max(1, round(w * h0 / h)))
                else:
                    t = _resize(t, max(1, round(h * w0 / w)), w0)
            parts.append(t)
        if direction in ("left", "up"):
            parts = parts[::-1]

        b = max(t.shape[0] for t in parts)
        gap = int(gap)
        if side:
            out_h = max(t.shape[1] for t in parts)
            out_w = sum(t.shape[2] for t in parts) + gap * (len(parts) - 1)
        else:
            out_w = max(t.shape[2] for t in parts)
            out_h = sum(t.shape[1] for t in parts) + gap * (len(parts) - 1)

        fill = torch.tensor(_hex(gap_color) + ([1.0] if c == 4 else []), dtype=dtype, device=device)
        out = fill.view(1, 1, 1, c).repeat(b, out_h, out_w, 1)

        def offset(free):
            return 0 if align == "start" else free if align == "end" else free // 2

        pos = 0
        for t in parts:
            if t.shape[0] < b:  # shorter batch: repeat its last frame
                t = torch.cat([t, t[-1:].repeat(b - t.shape[0], 1, 1, 1)], dim=0)
            h, w = t.shape[1], t.shape[2]
            if side:
                y = offset(out_h - h)
                out[:, y:y + h, pos:pos + w] = t
                pos += w + gap
            else:
                x = offset(out_w - w)
                out[:, pos:pos + h, x:x + w] = t
                pos += h + gap
        return (out, int(out_w), int(out_h))


NODE_CLASS_MAPPINGS = {"LCImageStitchMulti": LCImageStitchMulti}
NODE_DISPLAY_NAME_MAPPINGS = {"LCImageStitchMulti": "LC Image Stitch Multi 🖼️🪡"}
