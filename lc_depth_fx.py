"""
LC Depth FX: the scene part of a real camera, driven by a depth map.
  atmosphere  = real haze (fades toward a haze color taken from the image itself)
  light wrap  = background light bleeding over the subject's edges
  depth of field = blur that grows with distance from focus, back to front, so the subject never smears
Works in linear light. The depth direction is detected automatically.
"""

import math
import torch
import torch.nn.functional as F
from nodes import PreviewImage

from .lc_image_tools import _preview, _look_input, _lin, _srgb, _luma, LCClarity

_gblur = LCClarity._gblur


def _smooth(e0, e1, x):
    t = ((x - e0) / (e1 - e0 + 1e-6)).clamp(0, 1)
    return t * t * (3 - 2 * t)


def _disc_blur(t, r):
    """Lens-shaped (disc) blur on BCHW. Big radii run at lower resolution, same look, much faster."""
    if r < 0.75:
        return t
    h, w = t.shape[2], t.shape[3]
    f = max(1, int(r // 6))
    small = F.avg_pool2d(t, f, ceil_mode=True) if f > 1 else t
    rr = r / f
    R = int(math.ceil(rr))
    c = torch.arange(-R, R + 1, device=t.device, dtype=t.dtype)
    yy, xx = torch.meshgrid(c, c, indexing="ij")
    k = (rr + 0.5 - torch.sqrt(xx * xx + yy * yy)).clamp(0, 1)
    k = k / k.sum()
    ch = t.shape[1]
    out = F.conv2d(F.pad(small, (R, R, R, R), mode="replicate"), k.expand(ch, 1, -1, -1), groups=ch)
    if f > 1:
        out = F.interpolate(out, size=(h, w), mode="bilinear", align_corners=False)
    return out


def _prep_depth(depth, h, w, direction):
    """-> distance map B1HW, 0 = nearest, 1 = farthest."""
    d = depth[..., :3].mean(-1, keepdim=True).permute(0, 3, 1, 2).float()
    if d.shape[2] != h or d.shape[3] != w:
        d = F.interpolate(d, size=(h, w), mode="bilinear", align_corners=False)
    b = d.shape[0]
    flat = d.reshape(b, -1)[:, :: max(1, (h * w) // 250000)]
    lo = flat.quantile(0.01, dim=1).view(b, 1, 1, 1)
    hi = flat.quantile(0.99, dim=1).view(b, 1, 1, 1)
    d = ((d - lo) / (hi - lo).clamp(min=1e-4)).clamp(0, 1)
    if direction == "Bright = near":
        near = d
    elif direction == "Bright = far":
        near = 1 - d
    else:
        # Auto: the ground (bottom) and the subject (center) are nearer than the sky (top) and the edges.
        top, bot = d[:, :, : h // 5].mean((1, 2, 3)), d[:, :, -(h // 5):].mean((1, 2, 3))
        center = d[:, :, h // 4: 3 * h // 4, w // 4: 3 * w // 4].mean((1, 2, 3))
        score = (bot - top) + 2 * (center - d.mean((1, 2, 3)))
        bright_near = (score >= 0).float().view(b, 1, 1, 1)
        near = bright_near * d + (1 - bright_near) * (1 - d)
    return 1.0 - near


class LCDepthFX(PreviewImage):
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                "depth_map": ("IMAGE", {"tooltip": "Depth map of the same image (LC Depth Anything). Either direction works."}),
                "look": _look_input("Natural"),
                "haze": ("FLOAT", {"default": 0.10, "min": 0.0, "max": 1.0, "step": 0.01,
                                   "tooltip": "How thick the air is. Distant areas fade toward the haze color. 0 = off."}),
                "haze_distance": ("FLOAT", {"default": 0.40, "min": 0.0, "max": 0.95, "step": 0.01,
                                            "tooltip": "Where the haze starts. 0 = right in front of the camera, higher = only the far background."}),
                "haze_warmth": ("FLOAT", {"default": 0.0, "min": -1.0, "max": 1.0, "step": 0.05,
                                          "tooltip": "The haze color comes from the image's own distance. This nudges it cooler (-) or warmer (+)."}),
                "light_wrap": ("FLOAT", {"default": 0.15, "min": 0.0, "max": 1.0, "step": 0.01,
                                         "tooltip": "Bright background light bleeding over the subject's edges. Kills the cut-out sticker look. 0 = off."}),
                "dof_blur": ("FLOAT", {"default": 0.15, "min": 0.0, "max": 1.0, "step": 0.01,
                                       "tooltip": "Depth of field. How blurry things get away from the focus. 0 = off. Scales with resolution."}),
                "focus_range": ("FLOAT", {"default": 0.15, "min": 0.0, "max": 0.8, "step": 0.01,
                                          "tooltip": "How much depth stays sharp around the focus. Low = razor thin (like f/1.4), high = deep (like f/8)."}),
                "bokeh": ("FLOAT", {"default": 0.2, "min": 0.0, "max": 1.0, "step": 0.01,
                                    "tooltip": "Bright out-of-focus lights turn into glowing discs. 0 = plain blur."}),
                "auto_focus": ("BOOLEAN", {"default": True,
                                           "tooltip": "Focus on the main subject in the middle of the frame. Off = use focus_depth."}),
                "focus_depth": ("FLOAT", {"default": 0.2, "min": 0.0, "max": 1.0, "step": 0.01,
                                          "tooltip": "Used when auto_focus is off. 0 = nearest, 1 = farthest."}),
                "depth_direction": (["Auto", "Bright = near", "Bright = far"], {
                    "default": "Auto", "tooltip": "Leave on Auto unless the effects land on the wrong part of the image."}),
            },
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
    FUNCTION = "run"
    CATEGORY = "LC123/image"
    OUTPUT_NODE = True
    DESCRIPTION = (
        "Depth-driven camera effects: atmospheric haze, light wrap and depth of field with real bokeh. "
        "Wire a depth map from LC Depth Anything. Pick a look or set the sliders. On-node preview with before/after wipe."
    )

    def run(self, image, depth_map, look="Natural", haze=0.10, haze_distance=0.4, haze_warmth=0.0, light_wrap=0.15,
            dof_blur=0.15, focus_range=0.15, bokeh=0.2, auto_focus=True, focus_depth=0.2, depth_direction="Auto"):
        src = image
        image = image[..., :3]
        if haze <= 0 and light_wrap <= 0 and dof_blur <= 0:
            return _preview(self, src, src)
        try:
            import comfy.model_management as mm
            dev = mm.get_torch_device()
        except Exception:
            dev = image.device
        x = image.to(dev, torch.float32).permute(0, 3, 1, 2)
        b, _, h, w = x.shape
        base = min(h, w)
        lin = _lin(x)
        dist = _prep_depth(depth_map.to(dev), h, w, depth_direction)

        # focus: the nearer part of the frame's middle (the subject), or the manual depth
        if auto_focus:
            # subjects (and their faces) sit in the upper-middle of the frame; a curtain or railing at the side is ignored
            mid = dist[:, :, int(h * 0.15): int(h * 0.65), w // 3: 2 * w // 3].reshape(b, -1)
            fd = mid[:, :: max(1, mid.shape[1] // 200000)].quantile(0.3, dim=1).view(b, 1, 1, 1)
        else:
            fd = torch.full((b, 1, 1, 1), float(focus_depth), device=dev)
        rng = float(focus_range)

        # 1. Atmosphere: fade toward the color of the image's own distance (Koschmieder haze model)
        if haze > 0:
            flat = dist.reshape(b, -1)
            far = dist >= flat[:, :: max(1, flat.shape[1] // 250000)].quantile(0.9, dim=1).view(b, 1, 1, 1)
            lum = _luma(lin)
            A = []
            for i in range(b):
                fl = lum[i][far[i]]
                cols = lin[i].permute(1, 2, 0)[far[i][0]]
                if fl.numel() < 16:
                    A.append(lin[i].mean((1, 2)))
                    continue
                top = fl >= fl[:: max(1, fl.numel() // 250000)].quantile(0.8)
                A.append(cols[top].mean(0))
            A = torch.stack(A).view(b, 3, 1, 1)
            warm = torch.tensor([0.15, 0.0, -0.15], device=dev).view(1, 3, 1, 1) * float(haze_warmth)
            A = (A * (1 + warm)).clamp(0, 1)
            depth_in = ((dist - haze_distance) / (1.0 - haze_distance + 1e-3)).clamp(0, 1)
            t = torch.exp(-1.5 * float(haze) * depth_in)
            lin = lin * t + A * (1 - t)

        # 2. Light wrap: only BACKGROUND light spills over the subject's edges
        if light_wrap > 0:
            bg = _smooth(fd + rng, fd + rng + 0.15, dist)
            rw = 0.008 * base
            spread = _gblur(bg, rw)
            bg_col = _gblur(lin * bg, rw) / spread.clamp(min=1e-3)
            amt = (0.5 * float(light_wrap) * spread * (1 - bg)).clamp(0, 1)
            lin = lin + (bg_col - lin).clamp(min=0) * amt

        # 3. Depth of field: blur grows with distance from focus; background is blurred without the subject in it,
        #    foreground blur spreads over the subject, like a real lens
        if dof_blur > 0:
            max_r = float(dof_blur) * 0.025 * base
            s = dist - fd
            coc = ((s.abs() - rng) / 0.5).clamp(0, 1) * max_r
            behind = (s > -rng).float()
            front = 1.0 - behind
            radii = [0.0] + [max_r * f for f in (0.12, 0.25, 0.45, 0.7, 1.0)]
            # bokeh: bright highlights carry more light into the blur
            # only small bright points (lamps, sparkles), never a whole bright sky
            lx = _luma(x)
            # top-hat: brightness left after removing everything wider than a few pixels
            pr = max(1, int(round(0.004 * base)))
            k = 2 * pr + 1
            eroded = -F.max_pool2d(F.pad(-lx, (pr, pr, pr, pr), mode="replicate"), k, stride=1)
            opened = F.max_pool2d(F.pad(eroded, (pr, pr, pr, pr), mode="replicate"), k, stride=1)
            peak = (lx - opened).clamp(min=0)
            boost = 1.0 + float(bokeh) * 6.0 * _smooth(0.6, 1.0, lx) * _smooth(0.03, 0.15, peak)
            lin_b = lin * boost

            # interpolation weights of each pixel across the blur levels
            def level_weights(c):
                ws = []
                for k, r in enumerate(radii):
                    lo = radii[k - 1] if k > 0 else None
                    hi = radii[k + 1] if k + 1 < len(radii) else None
                    wk = torch.zeros_like(c)
                    if lo is not None:
                        wk = torch.where((c >= lo) & (c <= r), (c - lo) / max(r - lo, 1e-6), wk)
                    else:
                        wk = torch.where(c <= r, torch.ones_like(c), wk)
                    if hi is not None:
                        wk = torch.where((c > r) & (c <= hi), (hi - c) / max(hi - r, 1e-6), wk)
                    else:
                        wk = torch.where(c > r, torch.ones_like(c), wk)
                    ws.append(wk)
                return ws

            wts = level_weights(coc)
            bg_out = lin * wts[0]
            f_col = lin * front * wts[0]
            f_a = front * wts[0]
            for k in range(1, len(radii)):
                r = radii[k]
                # background level: only pixels at least this blurry feed it, so the sharp subject never bleeds out
                wb = behind * _smooth(0.4 * r, 0.8 * r, coc)
                num = _disc_blur(lin_b * wb, r)
                den = _disc_blur(wb, r)
                level = torch.where(den > 1e-3, num / den.clamp(min=1e-3), lin_b)
                bg_out = bg_out + level * wts[k] * behind
                # foreground level: spreads outward over whatever is behind it
                fk = front * wts[k]
                f_col = f_col + _disc_blur(lin_b * fk, r)
                f_a = f_a + _disc_blur(fk, r)
            bg_out = bg_out + lin * front * (1 - wts[0])  # front pixels are drawn by the foreground layer
            alpha = f_a.clamp(0, 1)
            fg = f_col / f_a.clamp(min=1e-4)
            lin = fg * alpha + bg_out * (1 - alpha)

        out = _srgb(lin.clamp(0, 1)).permute(0, 2, 3, 1)
        if src.shape[-1] == 4:
            out = torch.cat([out, src[..., 3:4].to(out.device)], dim=-1)
        return _preview(self, out.to(src.device, src.dtype), src)


NODE_CLASS_MAPPINGS = {"LCDepthFX": LCDepthFX}
NODE_DISPLAY_NAME_MAPPINGS = {"LCDepthFX": "LC Depth FX 🌫️"}
