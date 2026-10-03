"""
LC Skin Texture
---------------
Adds real pore texture to skin that came out too smooth. The fine brightness relief of a real skin close-up (pores,
fine creases) is cut into patches, re-arranged with matching overlaps so it never tiles, and added to the skin only:
less where the skin already has detail, eased off at hard edges and in deep shadow / bright highlight. The
reference's colour and lighting are never copied.

Texture synthesis adapted from ComfyUI-SkinDetailer (reference_texture.py _reference_bank / _quilt /
apply_reference_texture), MIT License, Copyright (c) 2026 ComfyUI-SkinDetailer contributors. Bundled reference:
assets/skin_texture/skin_reference_cc0.jpg (CC0, see the README there).
"""

from __future__ import annotations

import os
from functools import lru_cache

import numpy as np
import torch
import torch.nn.functional as F
from nodes import PreviewImage

import comfy.model_management

from .lc_detail_band import _confidence, blur
from .lc_image_tools import _preview
from .lc_skin_upscale import _auto_skin_mask, _bbox, _feather_mask

PATCH = 48
OVERLAP = 16
_W = (0.2126, 0.7152, 0.0722)
_REF = os.path.join(os.path.dirname(os.path.abspath(__file__)), "assets", "skin_texture", "skin_reference_cc0.jpg")


def _luma(x):
    return (x * x.new_tensor(_W)).sum(-1, keepdim=True)


@lru_cache(maxsize=1)
def _bundled_reference() -> torch.Tensor:
    from PIL import Image, ImageOps

    if not os.path.isfile(_REF):
        raise RuntimeError("[LC Skin Texture] assets/skin_texture/skin_reference_cc0.jpg is missing. "
                           "Reinstall the pack or wire a skin close-up into reference.")
    with Image.open(_REF) as im:
        im = ImageOps.exif_transpose(im).convert("RGB")
        im.thumbnail((1024, 1024), Image.LANCZOS)
        return torch.from_numpy(np.asarray(im, np.float32) / 255.0)[None]


def _bank(reference: torch.Tensor, pore_size: float) -> torch.Tensor:
    """Skin photo -> library of lighting-free, contrast-calibrated relief patches (N, PATCH, PATCH) on CPU."""
    ref = reference[:1, ..., :3].detach().float().cpu()
    h, w = ref.shape[1:3]
    if min(h, w) < PATCH:
        raise ValueError("[LC Skin Texture] reference must be at least 48 x 48 pixels.")
    size = max(1.0, min(2.0, float(pore_size)))
    scale = min(512 * size / (1.5 * w), 1024 / max(h, w))
    scale = max(scale, PATCH / min(h, w))
    th, tw = max(PATCH, round(h * scale)), max(PATCH, round(w * scale))
    ref = F.interpolate(ref.movedim(-1, 1), size=(th, tw), mode="bicubic", antialias=True,
                        align_corners=False).movedim(1, -1).clamp(0, 1)
    y = _luma(ref)
    relief = blur(y, 0.45) - blur(y, 6.0)
    rms = relief.square().mean().sqrt()
    if float(rms) < 0.001:
        raise ValueError("[LC Skin Texture] the reference has almost no texture. Use a sharp close-up of bare skin.")
    relief = 3.0 * torch.tanh(relief / (3.0 * rms))
    patches = relief[0, ..., 0].unfold(0, PATCH, 16).unfold(1, PATCH, 16).reshape(-1, PATCH, PATCH)
    energy = patches.square().mean(dim=(-1, -2))
    med = energy.median().clamp_min(1e-6)
    usable = (energy > med * 0.3) & (energy < med * 2.5)  # skip blank patches and strong creases
    return (patches[usable] if bool(usable.any()) else patches).contiguous()


@lru_cache(maxsize=4)
def _bundled_bank(pore_size: float) -> torch.Tensor:
    return _bank(_bundled_reference(), pore_size)


def _quilt(bank: torch.Tensor, height: int, width: int, seed: int) -> torch.Tensor:
    """Lay patches so each one agrees with what is already down in the overlap; crossfade the seams."""
    stride = PATCH - OVERLAP
    canvas = torch.zeros((height, width))
    cover = torch.zeros_like(canvas)
    gen = torch.Generator(device="cpu").manual_seed(int(seed) % (1 << 63))
    axis = torch.ones(PATCH)
    ramp = torch.sin(torch.linspace(0.0, torch.pi / 2, OVERLAP + 2)[1:-1]).square()
    axis[:OVERLAP] = ramp
    axis[-OVERLAP:] = ramp.flip(0)
    window = axis[:, None] * axis[None, :]
    for y in range(0, height, stride):
        comfy.model_management.throw_exception_if_processing_interrupted()
        for x in range(0, width, stride):
            ph, pw = min(PATCH, height - y), min(PATCH, width - x)
            cand = bank[torch.randint(len(bank), (8,), generator=gen)]
            cand = torch.rot90(cand, int(torch.randint(4, (), generator=gen)), dims=(-2, -1))[:, :ph, :pw]
            tgt, cov = canvas[y:y + ph, x:x + pw], cover[y:y + ph, x:x + pw]
            known = cov > 0.0
            if bool(known.any()):
                err = ((cand - tgt / cov.clamp_min(1e-8)).square() * known).sum(dim=(-1, -2))
                pick = cand[int(err.argmin())]
            else:
                pick = cand[0]
            wgt = window[:ph, :pw]
            tgt.add_(pick * wgt)
            cov.add_(wgt)
    return (canvas / cover.clamp_min(1e-8))[None, ..., None]


def _texture(base: torch.Tensor, mask: torch.Tensor, bank: torch.Tensor, amount: float, softness: float, seed: int):
    """base (1,H,W,3) crop, mask (H,W). Returns base with skin relief added under the mask."""
    h, w = base.shape[1:3]
    relief = _quilt(bank, h, w, seed)
    relief = blur(relief, 0.35 + softness * 0.25)
    relief = relief - blur(relief, 6.0)
    support = (mask > 0.0)[None, ..., None]
    energy = (relief.square() * support).sum() / support.sum().clamp_min(1)
    if float(energy) < 1e-6:
        return base
    relief = relief / energy.sqrt()
    y = _luma(base)
    existing = blur(y, 0.6) - blur(y, 2.0)
    existing_rms = blur(existing.square(), 4.0).clamp_min(0.0).sqrt()
    needs = 1.0 / (1.0 + (existing_rms / 0.012).square())  # skin that already has detail gets less
    detail = relief * (0.026 * amount * (1.0 - 0.3 * softness))
    detail = 0.055 * torch.tanh(detail / 0.055) * _confidence(y) * needs
    detail = torch.maximum(detail, -base.amin(-1, keepdim=True))  # one offset for all channels: skin tone stays
    detail = torch.minimum(detail, 1.0 - base.amax(-1, keepdim=True))
    return (base + detail).clamp(0.0, 1.0)


class LCSkinTexture(PreviewImage):
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                "strength": ("FLOAT", {"default": 0.45, "min": 0.0, "max": 1.0, "step": 0.05,
                                       "tooltip": "How much pore texture is added. 0 = none."}),
                "pore_size": ("FLOAT", {"default": 1.0, "min": 1.0, "max": 2.0, "step": 0.05,
                                        "tooltip": "1 = fine pores. Higher = larger pores and creases (for close-ups)."}),
                "softness": ("FLOAT", {"default": 0.5, "min": 0.0, "max": 1.0, "step": 0.05,
                                       "tooltip": "Higher = softer, gentler texture. Lower = crisper."}),
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xFFFFFFFF,
                                 "tooltip": "Changes how the texture patches are arranged."}),
            },
            "optional": {
                "mask": ("MASK", {"tooltip": "Skin to texture (white). LC Person Mask with mediapipe, face + body and "
                                             "remove_features is ideal. Unwired: skin is found by colour."}),
                "reference": ("IMAGE", {"tooltip": "Your own sharp close-up of bare skin. Unwired: the bundled CC0 skin photo."}),
            },
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
    FUNCTION = "run"
    CATEGORY = "LC123/image"
    OUTPUT_NODE = True
    DESCRIPTION = ("Adds real pore texture to skin that came out too smooth, from a real skin photo (only its fine "
                   "relief, never its colour). Skin that already has detail gets less. On-node before/after wipe.")

    def run(self, image, strength=0.45, pore_size=1.0, softness=0.5, seed=0, mask=None, reference=None):
        if strength <= 0:
            return _preview(self, image, image)
        bank = _bundled_bank(round(float(pore_size), 3)) if reference is None else _bank(reference, pore_size)
        out = []
        for i in range(image.shape[0]):
            frame = image[i:i + 1, ..., :3].float().cpu()
            rgb = frame[0].numpy()
            h, w = rgb.shape[:2]
            if mask is not None:
                m = mask[min(i, mask.shape[0] - 1)] if mask.ndim == 3 else mask
                m = F.interpolate(m[None, None].float().cpu(), size=(h, w), mode="bilinear", align_corners=False)[0, 0]
                m = m.numpy()
            else:
                m = _feather_mask(_auto_skin_mask(rgb, 0.55, 0.45), 0.45)
            box = _bbox(m, 32)
            if box is None:
                out.append(frame)
                continue
            y0, y1, x0, x1 = box
            y1, x1 = min(y1, h), min(x1, w)
            crop_m = torch.from_numpy(np.ascontiguousarray(m[y0:y1, x0:x1], dtype=np.float32))
            textured = _texture(frame[:, y0:y1, x0:x1], crop_m, bank, 1.0, float(softness),
                                seed * 2654435761 + y0 * 73856093 + x0 * 19349663 + (y1 - y0) * 83492791)
            a = (crop_m * float(strength))[None, ..., None]
            res = frame.clone()
            res[:, y0:y1, x0:x1] = frame[:, y0:y1, x0:x1] * (1 - a) + textured * a
            out.append(res)
        return _preview(self, torch.cat(out, 0), image)


NODE_CLASS_MAPPINGS = {"LCSkinTexture": LCSkinTexture}
NODE_DISPLAY_NAME_MAPPINGS = {"LCSkinTexture": "LC Skin Texture ✨ (BETA)"}
