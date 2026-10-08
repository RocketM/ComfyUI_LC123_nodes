"""
Guided filter (He, Sun, Tang, "Guided Image Filtering", ECCV 2010): an edge-aware blur in constant time per pixel.
Splitting two images with the SAME guide gives both low-frequency layers the same edges, so swapping or mixing
them cannot leave a halo along a hard edge.

Box filter and guided filter adapted from ComfyUI-ChromaGrade (chromagrade/guided.py), MIT License,
Copyright (c) 2026 MONKEYFOREVER2. Changed to work on NCHW tensors.
"""

from __future__ import annotations

import torch


def _box_1d(x: torch.Tensor, radius: int, dim: int) -> torch.Tensor:
    """Moving average along dim, with correct counts at the borders (cumulative-sum form)."""
    n = x.shape[dim]
    if radius <= 0 or n < 2:
        return x
    cum = torch.cat([torch.zeros_like(x.narrow(dim, 0, 1)), torch.cumsum(x, dim=dim)], dim=dim)
    ar = torch.arange(n, device=x.device)
    hi = (ar + radius + 1).clamp(0, n)
    lo = (ar - radius).clamp(0, n)
    count = (hi - lo).to(x.dtype)
    shape = [1] * x.ndim
    shape[dim] = n
    return (cum.index_select(dim, hi) - cum.index_select(dim, lo)) / count.reshape(shape).clamp_min(1.0)


def box(x: torch.Tensor, radius: int) -> torch.Tensor:
    """Separable box filter over the last two dims (H, W)."""
    return _box_1d(_box_1d(x, radius, -2), radius, -1)


def guided(guide: torch.Tensor, src: torch.Tensor, radius: int, eps: float = 1e-3) -> torch.Tensor:
    """guide: [N,1,H,W]; src: [N,C,H,W]. Edge-aware low-pass of src that follows the guide's edges."""
    mean_i = box(guide, radius)
    mean_p = box(src, radius)
    var_i = (box(guide * guide, radius) - mean_i * mean_i).clamp_min(0.0)
    cov_ip = box(guide * src, radius) - mean_i * mean_p
    a = cov_ip / (var_i + eps)
    b = mean_p - a * mean_i
    return box(a, radius) * guide + box(b, radius)


def luma(x: torch.Tensor) -> torch.Tensor:
    """[N,3,H,W] RGB to [N,1,H,W] Rec.709 luminance."""
    w = x.new_tensor([0.2126, 0.7152, 0.0722]).view(1, 3, 1, 1)
    return (x[:, :3] * w).sum(1, keepdim=True)
