"""
Band-pass detail transfer: move an upscaler's pore and fold structure onto an image without its colour shifts or
1-pixel grain. Only luminance detail in a middle frequency band is taken, softly capped, and eased off at hard edges
and at the darkest and brightest areas. One shared offset per pixel keeps the RGB channels' differences, so skin
tone does not change.

Adapted from ComfyUI-SkinDetailer (texture.py _transfer_detail / _detail_confidence, composite.py
gaussian_blur_image), MIT License, Copyright (c) 2026 ComfyUI-SkinDetailer contributors.
"""

from __future__ import annotations

import math

import torch
import torch.nn.functional as F

_LUMA = (0.2126, 0.7152, 0.0722)


def _blur_bchw(x: torch.Tensor, sigma: float) -> torch.Tensor:
    r = max(1, int(math.ceil(3.0 * sigma)))
    t = torch.arange(-r, r + 1, device=x.device, dtype=x.dtype)
    k = torch.exp(-(t * t) / (2.0 * sigma * sigma))
    k = k / k.sum()
    c = x.shape[1]
    x = F.pad(x, (r, r, 0, 0), mode="replicate")
    x = F.conv2d(x, k.view(1, 1, 1, -1).repeat(c, 1, 1, 1), groups=c)
    x = F.pad(x, (0, 0, r, r), mode="replicate")
    return F.conv2d(x, k.view(1, 1, -1, 1).repeat(c, 1, 1, 1), groups=c)


def blur(img: torch.Tensor, sigma: float) -> torch.Tensor:
    """Gaussian low-pass of a [B,H,W,C] image. Wide blurs run at reduced resolution (only feeds a low band)."""
    if sigma <= 0.0:
        return img
    x = img.movedim(-1, 1)
    f = int(min(8, max(1, round(sigma / 2.0)))) if sigma > 3.0 else 1
    if f > 1:
        h, w = x.shape[-2:]
        small = F.interpolate(x, size=(max(1, h // f), max(1, w // f)), mode="area")
        x = F.interpolate(_blur_bchw(small, sigma / f), size=(h, w), mode="bilinear", align_corners=False)
    else:
        x = _blur_bchw(x, sigma)
    return x.movedim(1, -1)


def _smoothstep(v: torch.Tensor) -> torch.Tensor:
    v = v.clamp(0.0, 1.0)
    return v * v * (3.0 - 2.0 * v)


def _confidence(luma: torch.Tensor) -> torch.Tensor:
    """Full strength in the midtones, less at sharp contours and near black / white."""
    shading = blur(luma, 1.2)
    p = F.pad(shading.movedim(-1, 1), (1, 1, 1, 1), mode="replicate")
    dx = 0.5 * (p[:, :, 1:-1, 2:] - p[:, :, 1:-1, :-2])
    dy = 0.5 * (p[:, :, 2:, 1:-1] - p[:, :, :-2, 1:-1])
    edge = (1.0 / (1.0 + (dx * dx + dy * dy) / 0.04 ** 2)).movedim(1, -1)
    return edge * _smoothstep((shading - 0.02) / 0.12) * _smoothstep((0.99 - shading) / 0.12)


def transfer_detail(source: torch.Tensor, prediction: torch.Tensor, softness: float = 0.5) -> torch.Tensor:
    """source / prediction: [B,H,W,3] 0..1, same size. Returns source plus the prediction's bounded detail band."""
    source = source.float()
    prediction = torch.where(torch.isfinite(prediction), prediction.float(), source)
    wts = source.new_tensor(_LUMA)
    luma = (source * wts).sum(-1, keepdim=True)
    residual = ((prediction - source) * wts).sum(-1, keepdim=True)
    s = max(0.0, min(1.0, float(softness)))
    # band-pass: drop ~1 px grain (fine sigma) and broad shading (sigma 4), keep pore-sized structure
    detail = blur(residual, 0.7 + 0.4 * s) - blur(residual, 4.0)
    band = blur(luma, 1.0) - blur(luma, 3.0)
    detail = detail + band * (0.18 * (1.0 - 0.5 * s))
    contrast = blur(band * band, 3.0).clamp_min(0.0).sqrt()
    limit = (0.025 + 0.75 * contrast).clamp(max=0.065) * (1.0 - 0.5 * s)
    detail = limit * torch.tanh(detail / limit) * _confidence(luma)
    # one offset for all three channels, limited to the headroom of the brightest / darkest channel
    detail = torch.maximum(detail, -source.amin(-1, keepdim=True))
    detail = torch.minimum(detail, 1.0 - source.amax(-1, keepdim=True))
    return (source + detail).clamp(0.0, 1.0)
