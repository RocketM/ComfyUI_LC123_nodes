"""
Smart denoise for LC Image Denoise.

1. Measure the noise in each image (robust MAD of the finest luminance band, the same floor LC Sharpen Pro uses).
2. Split into luminance and two colour-difference channels.
3. Luminance: guided filter guided by itself, with its edge threshold tied to the measured noise, so variations
   about the size of the noise are smoothed and real edges are kept.
4. Colour: guided by the cleaned luminance over a wider window. Colour noise (the blotchy kind) goes, colour
   edges follow the luminance edges and stay sharp.
5. Detail back: the original's luminance texture is returned only where it stands clearly above the noise
   (pores, hair, fabric), so smooth areas stay clean and textured areas do not go plastic.
Works on the GPU in float, no 8-bit steps.
"""

from __future__ import annotations

import math

import torch
import torch.nn.functional as F

from .lc_guided import guided

_W = (0.2126, 0.7152, 0.0722)


def _gblur(t: torch.Tensor, sigma: float) -> torch.Tensor:
    if sigma < 0.2:
        return t
    r = max(1, int(math.ceil(sigma * 3.0)))
    r = min(r, (min(t.shape[2], t.shape[3]) - 1) // 2 or 1)
    c = torch.arange(-r, r + 1, device=t.device, dtype=t.dtype)
    k = torch.exp(-(c * c) / (2.0 * sigma * sigma))
    k = k / k.sum()
    ch = t.shape[1]
    t = F.conv2d(F.pad(t, (r, r, 0, 0), mode="replicate"), k.view(1, 1, 1, -1).expand(ch, 1, 1, -1), groups=ch)
    return F.conv2d(F.pad(t, (0, 0, r, r), mode="replicate"), k.view(1, 1, -1, 1).expand(ch, 1, -1, 1), groups=ch)


def _sigma(t: torch.Tensor) -> torch.Tensor:
    """Noise level per image and channel from the finest band (MAD / 0.6745), shape (B, C, 1, 1)."""
    b, c = t.shape[:2]
    fine = (t - _gblur(t, 0.8))[:, :, ::2, ::2].abs().reshape(b, c, -1)
    # the 0.8 blur leaves about 0.62 of white noise in the band; undo that so sigma is the real noise level
    return (fine.median(dim=2).values / 0.6745 / 0.62).clamp(min=1e-4).view(b, c, 1, 1)


def _smoothstep(e0, e1, x):
    t = ((x - e0) / (e1 - e0).clamp(min=1e-6)).clamp(0, 1)
    return t * t * (3 - 2 * t)


def smart_denoise(img_bhwc: torch.Tensor, luma: float = 1.0, chroma: float = 1.0, keep_detail: float = 0.5,
                  device=None):
    """img (B,H,W,3) 0..1. Returns (denoised (B,H,W,3) on img's device, list of per-image noise reports)."""
    src_dev = img_bhwc.device
    dev = device or src_dev
    x = img_bhwc[..., :3].to(dev, torch.float32).permute(0, 3, 1, 2)
    b, _, h, w = x.shape
    wr, wg, wb = _W
    y = wr * x[:, 0:1] + wg * x[:, 1:2] + wb * x[:, 2:3]
    cb, cr = x[:, 2:3] - y, x[:, 0:1] - y

    sy = _sigma(y)
    sc = _sigma(torch.cat([cb, cr], 1)).amax(1, keepdim=True)
    scale = max(1.0, min(h, w) / 1024.0)
    r = max(1, int(round(2 * scale)))

    # luminance: two light passes beat one heavy one (less smearing of fine edges)
    yd = y
    if luma > 0:
        eps = (1.0 * float(luma) * sy) ** 2  # tuned: 1.0 = best PSNR over noise 2/255 to 18/255
        for _ in range(2):
            yd = guided(yd, yd, r, eps)
    # colour: wider window, guided by the clean luminance so colour edges stay where the luminance edges are
    cbd, crd = cb, cr
    if chroma > 0:
        rc = max(2, int(round(r * 3)))
        eps_c = (1.5 * float(chroma) * torch.maximum(sc, sy)) ** 2
        cbd = guided(yd, cb, rc, eps_c)
        crd = guided(yd, cr, rc, eps_c)
    # texture back where the original stands well above the noise
    if keep_detail > 0 and luma > 0:
        s_loc = 1.5 * scale
        m1 = _gblur(y, s_loc)
        lstd = (_gblur(y * y, s_loc) - m1 * m1).clamp(min=0).sqrt()
        mask = _smoothstep(2.0 * sy, 6.0 * sy, lstd)
        yd = yd + float(keep_detail) * mask * (y - yd)

    rr = yd + crd
    bb = yd + cbd
    gg = (yd - wr * rr - wb * bb) / wg
    out = torch.cat([rr, gg, bb], 1).clamp(0, 1).permute(0, 2, 3, 1).to(src_dev)
    reports = []
    for i in range(b):
        ly, lc = float(sy[i]), float(sc[i])
        grade = "clean" if ly < 0.004 else "light" if ly < 0.012 else "noticeable" if ly < 0.03 else "heavy"
        reports.append(f"noise: brightness {ly * 255:.1f}/255, colour {lc * 255:.1f}/255 ({grade})")
    return out, reports
