"""
LC Skin Beauty, torch version (GPU when available). Not a node: lc_skin_beauty.py calls process_frame_torch.

A line-by-line mirror of the numpy maths in lc_skin_beauty.py (same constants, same order, float32),
so the result matches the CPU path to within float rounding. Keep the two in sync when either changes.
"""

from __future__ import annotations

import torch
import torch.nn.functional as F

_M = torch.tensor(
    [
        [0.4124564, 0.3575761, 0.1804375],
        [0.2126729, 0.7151522, 0.0721750],
        [0.0193339, 0.1191920, 0.9503041],
    ],
    dtype=torch.float32,
)
_M_INV = torch.tensor(
    [
        [3.2404542, -1.5371385, -0.4985314],
        [-0.9692660, 1.8760108, 0.0415560],
        [0.0556434, -0.2040259, 1.0572252],
    ],
    dtype=torch.float32,
)
_DELTA = 6.0 / 29.0


def _srgb_to_linear(rgb):
    a = 0.055
    return torch.where(rgb <= 0.04045, rgb / 12.92, ((rgb + a) / (1.0 + a)) ** 2.4)


def _linear_to_srgb(rgb):
    a = 0.055
    return torch.where(rgb <= 0.0031308, rgb * 12.92, (1.0 + a) * torch.clamp(rgb, min=0) ** (1.0 / 2.4) - a)


def _rgb_to_lab(rgb):
    lin = _srgb_to_linear(torch.clamp(rgb, 0, 1))
    xyz = lin @ _M.to(rgb.device).T
    xyz = xyz / torch.tensor([0.95047, 1.0, 1.08883], device=rgb.device)

    def f(t):
        return torch.where(t > _DELTA**3, torch.sign(t) * t.abs() ** (1.0 / 3.0), t / (3 * _DELTA**2) + 4.0 / 29.0)

    fx, fy, fz = f(xyz[..., 0]), f(xyz[..., 1]), f(xyz[..., 2])
    return torch.stack([116.0 * fy - 16.0, 500.0 * (fx - fy), 200.0 * (fy - fz)], dim=-1)


def _lab_to_rgb(lab):
    L, a, b = lab[..., 0], lab[..., 1], lab[..., 2]
    fy = (L + 16.0) / 116.0
    fx = fy + a / 500.0
    fz = fy - b / 200.0

    def finv(t):
        return torch.where(t > _DELTA, t**3, 3 * _DELTA**2 * (t - 4.0 / 29.0))

    xyz = torch.stack([finv(fx) * 0.95047, finv(fy), finv(fz) * 1.08883], dim=-1)
    lin = xyz @ _M_INV.to(lab.device).T
    return torch.clamp(_linear_to_srgb(torch.clamp(lin, min=0)), 0, 1)


def _box_blur(ch, radius: int):
    """Separable box blur with edge padding, same cumulative-sum method as the numpy version."""
    if radius <= 0:
        return ch
    pad = int(radius)
    k = 2 * pad + 1
    h0, w0 = int(ch.shape[0]), int(ch.shape[1])
    x = F.pad(ch[None, None], (pad, pad, 0, 0), mode="replicate")[0, 0]
    c = torch.zeros((h0, w0 + 2 * pad + 1), dtype=ch.dtype, device=ch.device)
    c[:, 1:] = torch.cumsum(x, dim=1)
    hz = (c[:, k : k + w0] - c[:, 0:w0]) / float(k)
    y = F.pad(hz[None, None], (0, 0, pad, pad), mode="replicate")[0, 0]
    c = torch.zeros((h0 + 2 * pad + 1, w0), dtype=ch.dtype, device=ch.device)
    c[1:, :] = torch.cumsum(y, dim=0)
    return (c[k : k + h0, :] - c[0:h0, :]) / float(k)


def _auto_skin_mask(rgb, sensitivity: float, feather: float = 0.45):
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    lab = _rgb_to_lab(rgb)
    L, aa, bb = lab[..., 0], lab[..., 1], lab[..., 2]
    chroma = torch.sqrt(aa * aa + bb * bb)
    h, w = int(rgb.shape[0]), int(rgb.shape[1])
    base = min(h, w)

    skin_rgb = (
        (r > 0.36) & (g > 0.16) & (b > 0.09) & (r > g) & (r > b)
        & ((r - g) > 0.05) & ((r - g) < 0.50) & ((r - b) < 0.58)
    ).float()
    skin_lab = (
        (L > 32.0) & (L < 92.0) & (aa > 3.0) & (aa < 38.0) & (bb > 2.0) & (bb < 40.0)
        & (chroma > 6.0) & (chroma < 50.0)
    ).float()
    m = torch.clamp(0.42 * skin_rgb + 0.58 * skin_lab, 0, 1)

    dark = torch.clamp((36.0 - L) / 18.0, 0.0, 1.0)
    rad_d = max(1, int(round(base * 0.004)))
    L_blur = _box_blur(L, max(2, rad_d * 3))
    detail = torch.clamp((L - L_blur).abs() / 14.0, 0.0, 1.0)
    lips = (
        torch.clamp((aa - 24.0) / 16.0, 0.0, 1.0)
        * torch.clamp((chroma - 30.0) / 18.0, 0.0, 1.0)
        * torch.clamp(1.0 - (L - 55.0).abs() / 35.0, 0.0, 1.0)
    )
    bright_low_chroma = torch.clamp((L - 80.0) / 14.0, 0.0, 1.0) * torch.clamp((16.0 - chroma) / 12.0, 0.0, 1.0)
    protect = torch.clamp(dark * 0.92 + detail * 0.35 + lips * 0.88 + bright_low_chroma * 0.65, 0.0, 1.0)
    m = m * (1.0 - protect)

    rad_v = max(2, int(round(base * 0.014)))

    def _local_var(ch, rad):
        mu = _box_blur(ch, rad)
        mu2 = _box_blur(ch * ch, rad)
        return torch.clamp(mu2 - mu * mu, min=0.0)

    var_L = _local_var(L / 100.0, rad_v)
    var_c = _local_var(chroma / 60.0, rad_v)
    pattern = torch.clamp((var_L - 0.004) / 0.016, 0.0, 1.0) * 0.50 + torch.clamp((var_c - 0.006) / 0.022, 0.0, 1.0) * 0.50
    pattern = torch.clamp(pattern, 0.0, 1.0)
    m = m * (1.0 - 0.75 * pattern)

    rad_o = max(1, int(round(base * 0.003)))
    m_s = _box_blur(m, rad_o)
    m = torch.clamp(m * torch.clamp((m_s - 0.08) / 0.55, 0.0, 1.0), 0.0, 1.0)

    f = float(min(max(feather, 0.0), 1.0))
    rad = max(1, int(round(base * (0.003 + 0.012 * f))))
    m = _box_blur(m, rad)
    thr = 0.36 - (sensitivity - 0.5) * 0.22
    m = torch.clamp((m - thr) / max(1e-5, (0.95 - thr)), 0, 1)
    return _box_blur(m, max(1, rad // 2))


def _apply_skin(rgb, mask, coolness, brightness, rosy, evenness, shadow_lift, smooth, texture_preserve, saturation, highlight_protect):
    lab = _rgb_to_lab(rgb)
    L, a, b = lab[..., 0], lab[..., 1], lab[..., 2]
    hp = float(min(max(highlight_protect, 0), 1))
    highlight_zone = torch.clamp((L - 68.0) / 28.0, 0, 1)
    lift_guard = 1.0 - 0.78 * hp * highlight_zone
    m = mask * (1.0 - 0.35 * hp * highlight_zone)

    b = b - m * coolness * 18.0
    a = a + m * rosy * 9.0
    a = a - m * coolness * 3.0
    L = L + m * brightness * 12.0 * lift_guard
    shadow_w = torch.clamp(1.0 - L / 100.0, 0, 1) ** 2
    L = L + m * shadow_lift * 10.0 * shadow_w

    sat = float(saturation)
    if abs(sat) > 1e-4:
        scale = 1.0 + sat * 0.45
        a = a * (1.0 - m) + (a * scale) * m
        b = b * (1.0 - m) + (b * scale) * m

    if evenness > 1e-4:
        rad = max(2, int(round(min(rgb.shape[0], rgb.shape[1]) * 0.04)))
        a_blur, b_blur, L_blur = _box_blur(a, rad), _box_blur(b, rad), _box_blur(L, rad)
        a = a * (1 - m * evenness) + a_blur * (m * evenness)
        b = b * (1 - m * evenness) + b_blur * (m * evenness)
        L = L * (1 - m * evenness * 0.35) + L_blur * (m * evenness * 0.35)

    tp = float(min(max(texture_preserve, 0), 1))
    smooth_eff = smooth * (1.0 - 0.86 * tp)
    if smooth_eff > 1e-4:
        rad = max(1, int(round(min(rgb.shape[0], rgb.shape[1]) * 0.012)))
        L_s = _box_blur(L, rad)
        L = L * (1 - m * smooth_eff * 0.65) + L_s * (m * smooth_eff * 0.65)

    L = torch.clamp(L, 0, 100)
    out = _lab_to_rgb(torch.stack([L, a, b], dim=-1))
    m3 = m[..., None]
    return torch.clamp(rgb * (1.0 - m3) + out * m3, 0, 1)


def _normalize_mask(mask, h: int, w: int):
    m = mask.float()
    if m.ndim == 3:
        m = m[..., 0] if m.shape[-1] in (1, 3, 4) else m.mean(dim=-1)
    if m.shape[0] != h or m.shape[1] != w:
        # nearest resize, same index pick as the numpy version
        ys = torch.linspace(0, m.shape[0] - 1, h).to(torch.int64).to(m.device)
        xs = torch.linspace(0, m.shape[1] - 1, w).to(torch.int64).to(m.device)
        m = m[ys][:, xs]
    return torch.clamp(m, 0, 1)


def process_frame_torch(rgb, mask_in, strength, coolness, brightness, rosy, evenness, shadow_lift, smooth,
                        texture_preserve, saturation, highlight_protect, mask_sensitivity, mask_feather):
    """rgb: HxWx3 float tensor on the target device; mask_in: HxW (or HxWxC) tensor or None."""
    s = float(min(max(strength, 0), 2))
    coolness = float(coolness) * s
    brightness = float(brightness) * s
    rosy = float(rosy) * s
    evenness = float(min(max(evenness * min(s, 1.0), 0), 1))
    shadow_lift = float(shadow_lift) * s
    smooth = float(min(max(smooth * min(s, 1.0), 0), 1))
    saturation = float(saturation) * min(s, 1.0)
    mask_sensitivity = float(min(max(mask_sensitivity, 0), 1))
    mask_feather = float(min(max(mask_feather, 0), 1))

    h, w = rgb.shape[:2]
    auto = _auto_skin_mask(rgb, mask_sensitivity, mask_feather)
    if mask_in is not None:
        ext = _normalize_mask(mask_in, h, w)
        skin = torch.clamp(auto * ext, 0, 1)
        if float(ext.max()) < 0.05:
            skin = auto
    else:
        skin = auto

    out = _apply_skin(rgb, skin, coolness, brightness, rosy, evenness, shadow_lift, smooth, texture_preserve,
                      saturation, highlight_protect)
    mix = float(min(max(s if s <= 1 else 1.0, 0), 1))
    if mix < 0.999:
        m3 = skin[..., None] * mix
        out = rgb * (1 - m3) + out * m3
    return out, skin
