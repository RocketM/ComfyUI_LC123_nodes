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


def _level_weights(c, radii):
    """Linear interpolation weights of each pixel's blur radius across the given levels."""
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
                "haze": ("FLOAT", {"default": 0.15, "min": 0.0, "max": 1.0, "step": 0.01,
                                   "tooltip": "How thick the air is. Distant areas fade toward the haze color. 0 = off."}),
                "haze_distance": ("FLOAT", {"default": 0.40, "min": 0.0, "max": 0.95, "step": 0.01,
                                            "tooltip": "Where the haze starts. 0 = right in front of the camera, higher = only the far background."}),
                "haze_warmth": ("FLOAT", {"default": 0.0, "min": -1.0, "max": 1.0, "step": 0.05,
                                          "tooltip": "The haze color comes from the image's own distance. This nudges it cooler (-) or warmer (+)."}),
                "light_wrap": ("FLOAT", {"default": 0.10, "min": 0.0, "max": 1.0, "step": 0.01,
                                         "tooltip": "Bright background light bleeding over the subject's edges. Kills the cut-out sticker look. 0 = off."}),
                "dof_blur": ("FLOAT", {"default": 0.10, "min": 0.0, "max": 1.0, "step": 0.01,
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
            "optional": {
                "focus_mask": ("MASK", {"tooltip": "Optional. Focus lands on whatever this mask covers (a face or person mask "
                                                   "from LC MaskMaker). Beats auto_focus when connected."}),
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

    def run(self, image, depth_map, look="Natural", haze=0.15, haze_distance=0.4, haze_warmth=0.0, light_wrap=0.10,
            dof_blur=0.10, focus_range=0.15, bokeh=0.2, auto_focus=True, focus_depth=0.2, depth_direction="Auto",
            focus_mask=None):
        src = image
        image = image[..., :3]
        if haze <= 0 and light_wrap <= 0 and dof_blur <= 0 and bokeh <= 0:
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
        if focus_mask is not None:
            m = focus_mask.to(dev).float()
            m = m if m.dim() == 3 else m[..., 0]
            m = F.interpolate(m[:, None], size=(h, w), mode="bilinear", align_corners=False)
            if m.shape[0] != b:
                m = m[:1].expand(b, -1, -1, -1)
            fds = []
            for i in range(b):
                sel = dist[i][m[i] > 0.5]
                fds.append(sel.median() if sel.numel() > 16 else dist[i].median())
            fd = torch.stack(fds).view(b, 1, 1, 1)
        elif auto_focus:
            # the subject is the nearer part of the middle of the frame; focus on its TOP (where the head is),
            # so a body turned toward the camera, a curtain or a railing does not steal focus from the face
            fds = []
            top, bot, lft, rgt = int(h * 0.02), int(h * 0.7), w // 4, 3 * w // 4
            for i in range(b):
                win = dist[i, 0, top:bot, lft:rgt]
                smp = win.reshape(-1)[:: max(1, win.numel() // 200000)]
                # subject = anything clearly nearer than the far background (a head can sit farther back than a body)
                cut = 0.5 * (smp.quantile(0.05) + smp.quantile(0.95))
                ys = torch.nonzero(win <= cut)[:, 0]
                if ys.numel() < 16:
                    fds.append(win.median())
                    continue
                y_cut = ys[:: max(1, ys.numel() // 200000)].float().quantile(0.25)
                fds.append(win[win <= cut][ys <= y_cut].median())  # the top of the subject = the head
            fd = torch.stack(fds).view(b, 1, 1, 1)
        else:
            fd = torch.full((b, 1, 1, 1), float(focus_depth), device=dev)
        rng = float(focus_range)

        s_ = dist - fd
        # 0 = in focus, 1 = the farthest (or nearest) thing in THIS picture. Depth maps are relative, so blur is
        # measured against the scene's own range; a subject standing close to the background still gets it.
        far_room = (1.0 - fd - rng).clamp(min=0.1)
        near_room = (fd - rng).clamp(min=0.1)
        coc_n = torch.where(s_ >= 0, (s_ - rng) / far_room, (-s_ - rng) / near_room).clamp(0, 1)
        behind = (s_ > -rng).float()

        # 1. Atmosphere (aerial perspective): the far distance loses contrast and color toward the TYPICAL
        #    color out there, not its brightest pixel, and only in the real distance. A dark room stays dark.
        if haze > 0:
            flat = dist.reshape(b, -1)
            far = dist >= flat[:, :: max(1, flat.shape[1] // 250000)].quantile(0.85, dim=1).view(b, 1, 1, 1)
            A = []
            for i in range(b):
                cols = lin[i].permute(1, 2, 0)[far[i][0]]
                if cols.shape[0] < 16:
                    A.append(lin[i].mean((1, 2)))
                    continue
                cols = cols[:: max(1, cols.shape[0] // 250000)]
                A.append(cols.median(0).values * 0.7 + cols.mean(0) * 0.3)
            A = torch.stack(A).view(b, 3, 1, 1)
            warm = torch.tensor([0.15, 0.0, -0.15], device=dev).view(1, 3, 1, 1) * float(haze_warmth)
            A = (A * (1 + warm)).clamp(0, 1)
            depth_in = ((dist - haze_distance) / (1.0 - haze_distance + 1e-3)).clamp(0, 1) ** 1.5
            beyond = _smooth(fd + rng, fd + rng + 0.25, dist)  # the subject in focus never gets hazed
            amount = (1.0 - torch.exp(-1.2 * float(haze) * depth_in)) * beyond
            lin = lin + (A - lin) * amount

        # 2. Light wrap: background light screens over the subject's edges. The band widens with the slider.
        if light_wrap > 0:
            lw = float(light_wrap)
            bg = _smooth(fd + rng, fd + rng + 0.1, dist)
            rw = (0.004 + 0.010 * lw) * base
            spread = _gblur(bg, rw)
            bg_col = _gblur(lin * bg, rw) / spread.clamp(min=1e-3)
            edge = ((spread * 2.0).clamp(0, 1) * (1 - bg)).clamp(0, 1)
            k = (bg_col * edge * min(1.0, 1.2 * lw)).clamp(0, 1)
            lin = 1.0 - (1.0 - lin) * (1.0 - k)

        # 3. Depth of field: blur grows with distance from focus; background is blurred without the subject in it,
        #    foreground blur spreads over the subject, like a real lens
        if dof_blur > 0:
            max_r = float(dof_blur) * 0.025 * base
            coc = coc_n * max_r
            front = 1.0 - behind
            radii = [0.0] + [max_r * f for f in (0.12, 0.25, 0.45, 0.7, 1.0)]
            wts = _level_weights(coc, radii)
            bg_out = lin * wts[0]
            f_col = lin * front * wts[0]
            f_a = front * wts[0]
            for k in range(1, len(radii)):
                r = radii[k]
                # background level: only pixels at least this blurry feed it, so the sharp subject never bleeds out
                wb = behind * _smooth(0.4 * r, 0.8 * r, coc)
                num = _disc_blur(lin * wb, r)
                den = _disc_blur(wb, r)
                level = torch.where(den > 1e-3, num / den.clamp(min=1e-3), lin)
                bg_out = bg_out + level * wts[k] * behind
                # foreground level: spreads outward over whatever is behind it
                fk = front * wts[k]
                f_col = f_col + _disc_blur(lin * fk, r)
                f_a = f_a + _disc_blur(fk, r)
            bg_out = bg_out + lin * front * (1 - wts[0])  # front pixels are drawn by the foreground layer
            alpha = f_a.clamp(0, 1)
            fg = f_col / f_a.clamp(min=1e-4)
            lin = fg * alpha + bg_out * (1 - alpha)

        # 4. Bokeh: small bright points out of focus bloom into lens-shaped discs. Their size comes from the
        #    bokeh slider (and grows with dof_blur), so it shows even with a light depth of field.
        if bokeh > 0:
            bk = float(bokeh)
            lx = _luma(x)
            pr = max(1, int(round(0.01 * base)))  # lights up to ~2% of the frame, glow included
            kk = 2 * pr + 1
            eroded = -F.max_pool2d(F.pad(-lx, (pr, pr, pr, pr), mode="replicate"), kk, stride=1)
            opened = F.max_pool2d(F.pad(eroded, (pr, pr, pr, pr), mode="replicate"), kk, stride=1)
            # a light is a small spot clearly brighter than a darker surround (a bright sky's texture is not a light)
            # a real light is near white and several times brighter than what surrounds it; a sunlit window
            # or a bright sky's texture is only a little brighter, so it never becomes a disc
            ratio = lx / (opened + 0.05)
            points = (_smooth(0.7, 0.97, lx) * _smooth(1.8, 3.0, ratio)
                      * (1.0 - _smooth(0.45, 0.7, opened)))
            # only ROUND lights become discs: a lit ledge or rooftop edge is long and thin, a lamp is a dot.
            # The structure tensor of the detected points has one strong direction along an edge, none on a dot.
            gy = F.pad(points[:, :, 2:, 1:-1] - points[:, :, :-2, 1:-1], (1, 1, 1, 1))
            gx = F.pad(points[:, :, 1:-1, 2:] - points[:, :, 1:-1, :-2], (1, 1, 1, 1))
            st = 1.5 * pr
            jxx, jyy, jxy = _gblur(gx * gx, st), _gblur(gy * gy, st), _gblur(gx * gy, st)
            coh = ((jxx - jyy) ** 2 + 4 * jxy * jxy).sqrt() / (jxx + jyy + 1e-6)
            points = points * (1.0 - _smooth(0.35, 0.65, coh))
            # a handful of lights is bokeh; highlights everywhere (sun glinting off a whole city) is texture,
            # so the more of the frame they cover, the fainter their discs
            cover = (points > 0.3).float().mean((1, 2, 3)).view(b, 1, 1, 1)
            sparse = (0.004 / cover.clamp(min=1e-6)).clamp(0.05, 1.0)
            rb = max(float(dof_blur) * 0.025, 0.006 + 0.022 * bk) * base
            # lone lights bloom; tight clusters (sky through hair, glitter) would only stack into a haze
            iso = 1.0 / (1.0 + 30.0 * _gblur(points, 0.5 * rb))
            pts = points * iso * behind * _smooth(0.05, 0.3, coc_n)
            src = _lin(x)
            b_radii = [0.0] + [rb * f for f in (0.35, 0.65, 1.0)]
            bw = _level_weights(coc_n * rb, b_radii)
            col = torch.zeros_like(lin)
            cov = torch.zeros_like(pts)
            alpha = torch.zeros_like(pts)
            pt_area = max(4.0, math.pi * (0.0012 * base) ** 2)  # typical size of a light, independent of the detector
            for k in range(1, len(b_radii)):
                r = b_radii[k]
                pk = pts * bw[k]
                c = _disc_blur(pk, r)
                col = col + _disc_blur(src * pk, r)
                cov = cov + c
                # one light spread over a disc gets its brightness back, so each disc reads as a solid disc
                alpha = alpha + c * min(400.0, math.pi * r * r / pt_area)
            disc_col = col / cov.clamp(min=1e-6)
            # the in-focus subject stands in front of the background's discs
            recv = behind * _smooth(0.02, 0.15, coc_n)
            k_b = (alpha.clamp(0, 1) * recv * sparse * min(1.0, 1.2 * bk)) * (disc_col * (1.0 + bk)).clamp(0, 1)
            lin = 1.0 - (1.0 - lin) * (1.0 - k_b)  # screen: discs add light, overlapping discs never blow out

        out = _srgb(lin.clamp(0, 1)).permute(0, 2, 3, 1)
        if src.shape[-1] == 4:
            out = torch.cat([out, src[..., 3:4].to(out.device)], dim=-1)
        return _preview(self, out.to(src.device, src.dtype), src)


NODE_CLASS_MAPPINGS = {"LCDepthFX": LCDepthFX}
NODE_DISPLAY_NAME_MAPPINGS = {"LCDepthFX": "LC Depth FX 🌫️"}
