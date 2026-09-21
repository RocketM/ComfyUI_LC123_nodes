"""
LC Lighting Control (V2)
------------------------
Relight an image from a normal map + depth map (optional subject mask).
A separate node from LC Lighting Control 🔦 (LCRelight), which stays as it is.

What is new compared with V1
  * Real cast shadows: depth is treated as a height field and rays are marched along the actual light
    direction (elevation included), so shadow length follows the light height and the shadow softens away
    from the occluder. Hard or soft. Depth edges are snapped to the image edges first (guided filter), and
    the subject mask can lift the subject off the background so it casts a clean shadow on it.
  * Spot or sun (directional) per light, and a warmth tint per light.
  * `strength` blends the relit result back over the original inside the node.
  * Outputs the shadow mask (white = lit, black = in shadow) and the light layer next to the image.

Conventions (same as V1): light X/Y/Z = which way the light comes from. +X = from the right of the frame,
+Y = from above, Z = 0..1 toward the camera (0 = side on, 1 = frontal). Depth maps: 0 = near, 1 = far
(auto-flipped like V1 when the centre reads farther than the border).
"""

from __future__ import annotations

import numpy as np
import torch
import torch.nn.functional as F

try:  # ComfyUI
    import comfy.model_management as _mm
except Exception:  # pragma: no cover - stand-alone tests
    _mm = None


def _device() -> torch.device:
    if _mm is not None:
        try:
            return _mm.get_torch_device()
        except Exception:
            pass
    return torch.device("cuda" if torch.cuda.is_available() else "cpu")


# ---------------------------------------------------------------- maps

def _resize_bchw(t: torch.Tensor, h: int, w: int, mode: str = "bilinear") -> torch.Tensor:
    if t.shape[-2] == h and t.shape[-1] == w:
        return t
    return F.interpolate(t, size=(h, w), mode=mode, align_corners=False if mode != "nearest" else None)


def _decode_normals(n: torch.Tensor) -> torch.Tensor:
    """B3HW RGB 0..1 -> unit normals B3HW."""
    v = n * 2.0 - 1.0
    return v / v.norm(dim=1, keepdim=True).clamp_min(1e-6)


def _depth_01(d: torch.Tensor) -> torch.Tensor:
    """B1HW depth -> 0 = near, 1 = far, normalised to the 2..98 percentile range (auto-flip like V1)."""
    out = []
    for i in range(d.shape[0]):
        x = d[i, 0]
        flat = x.flatten()
        if flat.numel() > 4_000_000:  # quantile() has an input size limit
            flat = flat[:: max(1, flat.numel() // 4_000_000)]
        lo, hi = torch.quantile(flat, 0.02), torch.quantile(flat, 0.98)
        x = ((x - lo) / (hi - lo).clamp_min(1e-4)).clamp(0, 1)
        h, w = x.shape
        if h >= 16 and w >= 16:
            c = x[h // 2 - max(h // 6, 2): h // 2 + max(h // 6, 2), w // 2 - max(w // 6, 2): w // 2 + max(w // 6, 2)].mean()
            b = max(h // 12, 1)
            border = torch.cat([x[:b].flatten(), x[-b:].flatten(), x[:, :b].flatten(), x[:, -b:].flatten()]).mean()
            if c > border + 0.04:
                x = 1.0 - x
        out.append(x)
    return torch.stack(out, 0).unsqueeze(1)


def _box(x: torch.Tensor, r: int) -> torch.Tensor:
    if r <= 0:
        return x
    return F.avg_pool2d(F.pad(x, (r, r, r, r), mode="replicate"), 2 * r + 1, stride=1)


def _guided_filter(guide: torch.Tensor, src: torch.Tensor, r: int, eps: float) -> torch.Tensor:
    """Edge-preserving smoothing of src by guide (both B1HW). Snaps soft depth edges to image edges."""
    mean_g, mean_s = _box(guide, r), _box(src, r)
    cov_gs = _box(guide * src, r) - mean_g * mean_s
    var_g = _box(guide * guide, r) - mean_g * mean_g
    a = cov_gs / (var_g + eps)
    b = mean_s - a * mean_g
    return _box(a, r) * guide + _box(b, r)


# ---------------------------------------------------------------- subject dome (V1 behaviour)

def _np_box(m: np.ndarray, radius: int) -> np.ndarray:
    if radius <= 0:
        return m.astype(np.float32)
    h, w = m.shape
    r = int(radius)
    k = r * 2 + 1
    mp = np.pad(m.astype(np.float32), ((r, r), (r, r)), mode="edge")
    c = np.zeros((mp.shape[0] + 1, mp.shape[1]), dtype=np.float64)
    c[1:] = np.cumsum(mp, axis=0)
    vert = (c[k: k + h] - c[0:h]) / float(k)
    c2 = np.zeros((vert.shape[0], vert.shape[1] + 1), dtype=np.float64)
    c2[:, 1:] = np.cumsum(vert, axis=1)
    return ((c2[:, k: k + w] - c2[:, 0:w]) / float(k)).astype(np.float32)


def _dome_normals(mask_hw: np.ndarray, softness: float = 0.45) -> tuple[np.ndarray, np.ndarray]:
    h, w = mask_hw.shape
    radius = int(max(0, min(h, w) * 0.02 * float(softness) * 10))
    feather = np.clip(_np_box(mask_hw, max(radius, 0)), 0.0, 1.0)
    height = _np_box(feather, max(radius + 1, 1))
    gy = np.zeros_like(height)
    gx = np.zeros_like(height)
    gy[1:-1, :] = (height[2:, :] - height[:-2, :]) * 0.5
    gx[:, 1:-1] = (height[:, 2:] - height[:, :-2]) * 0.5
    n = np.stack([-gx * 2.5, -gy * 2.5, np.ones_like(height)], axis=-1)
    n = n / np.maximum(np.linalg.norm(n, axis=-1, keepdims=True), 1e-6)
    return n.astype(np.float32), feather


# ---------------------------------------------------------------- light

def _light_dir(lx: float, ly: float, lz: float) -> tuple[float, float, float]:
    """Unit vector (x right, y up, z toward camera) the light comes from."""
    v = np.array([float(lx), float(ly), max(float(lz), 0.0)], dtype=np.float32)
    n = float(np.linalg.norm(v))
    if n < 1e-6:
        v, n = np.array([0.0, 0.0, 1.0], dtype=np.float32), 1.0
    v = v / n
    return float(v[0]), float(v[1]), float(v[2])


# gel colours (RGB multipliers at full amount). "none" leaves the light as it is.
LIGHT_COLORS = {
    "none": (1.0, 1.0, 1.0),
    "red": (1.0, 0.2, 0.2),
    "orange": (1.0, 0.55, 0.15),
    "yellow": (1.0, 0.9, 0.2),
    "green": (0.25, 1.0, 0.3),
    "cyan": (0.2, 0.9, 1.0),
    "blue": (0.25, 0.35, 1.0),
    "purple": (0.6, 0.25, 1.0),
    "magenta": (1.0, 0.2, 0.8),
}


def _tint(warmth: float, color: str = "none", amount: float = 0.5) -> torch.Tensor:
    """Colour of one light: warmth (blue..orange) times an optional gel colour, kept at the same overall brightness."""
    w = float(np.clip(warmth, -1.0, 1.0))
    t = np.array([1.0 + 0.30 * w, 1.0 + 0.05 * w, 1.0 - 0.30 * w], dtype=np.float32)
    rgb = np.array(LIGHT_COLORS.get(str(color), LIGHT_COLORS["none"]), dtype=np.float32)
    a = float(np.clip(amount, 0.0, 1.0))
    t = t * (1.0 + a * (rgb - 1.0))
    t = t / float(t @ np.array([0.299, 0.587, 0.114], dtype=np.float32))
    return torch.from_numpy(t)


def _diffuse(normals, depth, dev, light_type, lx, ly, lz, size, depth_falloff, wrap=0.0):
    """Lambert x cone (spot) x depth falloff, same look as V1. Returns B1HW."""
    b, _, h, w = depth.shape
    sx, sy, sz = _light_dir(lx, ly, lz)
    ln = torch.tensor([-sx, sy, sz], device=dev, dtype=torch.float32)  # X flipped for estimated normals
    ln = ln / ln.norm().clamp_min(1e-6)
    ndotl = (normals * ln.view(1, 3, 1, 1)).sum(dim=1, keepdim=True)
    wr = float(np.clip(wrap, 0.0, 1.0))
    if wr > 1e-6:  # wrap lighting: the light turns to shade gradually instead of at a hard line
        ndotl = ((ndotl + wr) / (1.0 + wr)).clamp(0, 1) ** (1.0 + wr)
    else:
        ndotl = ndotl.clamp(0, 1)

    if light_type == "spot":
        soft = float(np.clip(size, 0.02, 1.5))
        cone_r = 0.12 + soft * 1.10 + soft * soft * 0.40
        xs = (torch.arange(w, device=dev, dtype=torch.float32) + 0.5) / w * 2.0 - 1.0
        ys = 1.0 - (torch.arange(h, device=dev, dtype=torch.float32) + 0.5) / h * 2.0
        yy, xx = torch.meshgrid(ys, xs, indexing="ij")
        aim_x, aim_y = sx * 0.22 * min(soft, 1.0), sy * 0.22 * min(soft, 1.0)
        rho = ((xx - aim_x) ** 2 + (yy - aim_y) ** 2 + 1e-8).sqrt()
        inner, outer = cone_r * 0.35, cone_r * 1.05
        t = ((rho - inner) / max(outer - inner, 1e-4)).clamp(0, 1)
        cone = (1.0 - t * t * t * (t * (t * 6.0 - 15.0) + 10.0)).view(1, 1, h, w)
    else:
        cone = torch.ones((1, 1, h, w), device=dev)

    ds = max(float(depth_falloff), 0.0)
    if ds > 1e-6:
        steep = 0.35 + (1.0 - min(float(size) / 1.5, 1.0)) * 1.0 if light_type == "spot" else 0.6
        flat = depth.flatten()
        if flat.numel() > 4_000_000:
            flat = flat[:: max(1, flat.numel() // 4_000_000)]
        d_near = torch.quantile(flat, 0.05)
        atten = torch.exp(-(depth - d_near).clamp(0, 1) * ds * steep * 2.2)
        f2 = atten.flatten()
        if f2.numel() > 4_000_000:
            f2 = f2[:: max(1, f2.numel() // 4_000_000)]
        peak = torch.quantile(f2, 0.95)
        if float(peak) > 1e-6:
            atten = atten / peak
        atten = atten.clamp(0, 1)
    else:
        atten = torch.ones_like(depth)
    return ndotl * cone * atten


# ---------------------------------------------------------------- shadows

def _cast_shadow(height, lx, ly, elevation, length, softness, mode, steps=80):
    """
    Height-field shadow. height: B1HW in PIXELS (near = high). Returns B1HW, 1 = fully shadowed.

    Direction: away from the light on the stage (X/Y of the light, like V1), at its own `elevation` (0..1, low =
    long shadows) that does NOT depend on Light Z. A light near the centre of the stage is head-on, and a head-on
    light throws no sideways shadow, so the shadow fades out as the light nears the middle.

    From every pixel a ray goes toward the light. At each step the slope up to the surface there is compared with
    the slope of the light: visibility = clamp((light slope - occluder slope) / width + 0.5). Taking the minimum over
    the steps gives the shadow. `width` is an ANGLE, so the penumbra widens with distance from the occluder (sharp at
    contact, soft farther away). Hard mode uses a small width, soft mode a wide one. Each pixel starts its ray at a
    slightly different distance (jitter), which removes the stair-step banding.
    """
    b, _, h, w = height.shape
    dev = height.device
    lat = float(np.hypot(lx, ly))
    fade = float(np.clip((lat - 0.05) / 0.45, 0.0, 1.0))
    fade = fade * fade * (3.0 - 2.0 * fade)
    if fade <= 1e-4:
        return torch.zeros_like(height)
    ax, ay = float(lx) / lat, float(ly) / lat
    ang = float(np.radians(8.0 + 72.0 * float(np.clip(elevation, 0.0, 1.0))))
    dx, dy, dzn = ax * float(np.cos(ang)), -ay * float(np.cos(ang)), float(np.sin(ang))
    horiz = max(float(np.cos(ang)), 1e-3)
    tan_l = dzn / horiz                     # rise of the light per horizontal pixel

    m = float(max(h, w))
    t_min = 0.003 * m + 1.0
    t_max = max(float(length), 0.02) * 0.5 * m
    width = 0.05 if mode == "hard" else 0.10 + float(np.clip(softness, 0.0, 1.0)) * 0.9
    bias = 1.0

    ys, xs = torch.meshgrid(
        torch.arange(h, device=dev, dtype=torch.float32), torch.arange(w, device=dev, dtype=torch.float32), indexing="ij"
    )
    base = torch.stack([xs, ys], dim=-1).unsqueeze(0).expand(b, -1, -1, -1)  # pixel coords
    scale = torch.tensor([2.0 / max(w - 1, 1), 2.0 / max(h - 1, 1)], device=dev)
    gen = torch.Generator(device=dev)
    gen.manual_seed(7)
    jit = torch.rand((1, h, w, 1), device=dev, generator=gen) - 0.5
    step = (t_max - t_min) / float(steps)

    vis = torch.ones_like(height)
    for i in range(steps):
        u = (i + 0.5) / float(steps)
        t = t_min + (t_max - t_min) * (u ** 1.5)
        tt = t + jit * step * 1.5 * (u ** 0.5)                       # 1,H,W,1
        pos = base + torch.cat([dx * tt, dy * tt], dim=-1)
        hs = F.grid_sample(height, pos * scale - 1.0, mode="bilinear", padding_mode="border", align_corners=True)
        tan_occ = (hs - height - bias) / (tt.permute(0, 3, 1, 2) * horiz)
        v = ((tan_l - tan_occ) / width + 0.5).clamp(0.0, 1.0)
        vis = torch.minimum(vis, v)
    shadow = 1.0 - vis
    r = max(1, int(round((0.0015 + (float(np.clip(softness, 0, 1)) * 0.003 if mode == "soft" else 0.0)) * m)))
    shadow = _box(shadow, r)
    return (shadow * fade).clamp(0, 1)


# ---------------------------------------------------------------- node

TYPES = ["spot", "sun"]
SHADOW_MODES = ["soft", "hard", "off"]
PRESETS = [
    "custom", "Soft window (left)", "Soft window (right)", "Rembrandt", "Split (hard side)", "Top light",
    "Under light", "Rim / back light", "Golden hour", "Campfire", "Cyberpunk", "Key + fill", "Flat front",
]


def _light_inputs(n: int, d: dict):
    p = f"light{n}_"
    tip_dir = "Where the light is on the stage: X = left/right, Y = down/up, Z = how frontal (0 side-on, 1 head-on). Drag the handle on the stage, or type here."
    return {
        p + "type": (TYPES, {"default": d["type"], "tooltip": "spot = a soft beam that lights part of the frame. sun = even light over the whole frame."}),
        p + "x": ("FLOAT", {"default": d["x"], "min": -1.0, "max": 1.0, "step": 0.05, "tooltip": tip_dir}),
        p + "y": ("FLOAT", {"default": d["y"], "min": -1.0, "max": 1.0, "step": 0.05, "tooltip": tip_dir}),
        p + "z": ("FLOAT", {"default": d["z"], "min": 0.0, "max": 1.0, "step": 0.05, "tooltip": tip_dir + " Z changes the shading and the beam. It does not change the shadow length."}),
        p + "brightness": ("FLOAT", {"default": d["brightness"], "min": 0.0, "max": 4.0, "step": 0.01, "tooltip": "How bright the light is. About 1.2 to 1.5 is a natural key light."}),
        p + "spread": ("FLOAT", {"default": d["spread"], "min": 0.05, "max": 1.5, "step": 0.01, "tooltip": "Spot only: how wide the beam is. Small = tight spotlight, large = soft flood over the whole face."}),
        p + "warmth": ("FLOAT", {"default": d["warmth"], "min": -1.0, "max": 1.0, "step": 0.05, "tooltip": "Color of the light. Negative = cool blue, 0 = neutral, positive = warm orange."}),
        p + "color": (list(LIGHT_COLORS), {"default": d.get("color", "none"), "tooltip": "Optional colored gel on this light. Works together with warmth. The color only shows where this light reaches, so shadows fall back to the neutral fill."}),
        p + "color_amount": ("FLOAT", {"default": d.get("color_amount", 0.5), "min": 0.0, "max": 1.0, "step": 0.01, "tooltip": "How strong the colored gel is. 0.3 to 0.6 looks natural, 1 is a saturated stage light."}),
    }


class LCLightingControlV2:
    @classmethod
    def INPUT_TYPES(cls):
        d = {
            "image": ("IMAGE", {"tooltip": "Image to relight."}),
            "normal_map": ("IMAGE", {"tooltip": "Normal map of the same image (LC Normal Map)."}),
            "depth_map": ("IMAGE", {"tooltip": "Depth map of the same image (LC Depth Anything V2)."}),
            "preset": (PRESETS, {"default": "Rembrandt", "tooltip": "A starting look. Picking one sets the lights and shadows below, then you can adjust anything. Editing a light or shadow value switches this to custom."}),
            "blend": ("FLOAT", {"default": 0.8, "min": 0.0, "max": 1.0, "step": 0.01, "tooltip": "How much of the relit result is mixed over the original. 0 = original, 1 = fully relit. 0.7 to 0.9 looks best."}),
            "enable_light_2": ("BOOLEAN", {"default": False, "tooltip": "Add a second light (fill or rim)."}),
            "light_wrap": ("FLOAT", {"default": 0.3, "min": 0.0, "max": 1.0, "step": 0.01, "tooltip": "Softens where light turns to shade on the face and body. 0 = a sharp line like a hard lamp, higher = a gradual roll-off."}),
            "fill": ("FLOAT", {"default": 0.18, "min": 0.0, "max": 1.5, "step": 0.01, "tooltip": "Base light that everything keeps, including the shadow side. 0 = pitch black shadows, 0.2 = natural, 0.5 = flat."}),
            "shadows": (SHADOW_MODES, {"default": "soft", "tooltip": "soft = edges soften away from the object. hard = sharp edges (sun, spotlight). off = no cast shadows, only shading."}),
            "shadow_amount": ("FLOAT", {"default": 0.55, "min": 0.0, "max": 1.0, "step": 0.01, "tooltip": "How dark cast shadows get. They never go below the fill light."}),
            "shadow_blur": ("FLOAT", {"default": 0.35, "min": 0.0, "max": 1.0, "step": 0.01, "tooltip": "Blurs the edges of cast shadows, in both soft and hard mode. Raise it if a shadow looks cut out."}),
            "background_shadow": ("FLOAT", {"default": 0.5, "min": 0.0, "max": 1.0, "step": 0.01, "tooltip": "How much of the shadow shows on the background behind the subject. 1 = a wall right behind, 0 = a distant background with nothing near enough to catch a shadow. Uses the mask if connected, otherwise the depth map."}),
            "self_shadow": ("FLOAT", {"default": 0.5, "min": 0.0, "max": 1.0, "step": 0.01, "tooltip": "Needs a mask. How strongly the subject shadows itself (nose, chin, hair) compared with the shadow it throws on the background."}),
            "relief": ("FLOAT", {"default": 0.3, "min": 0.0, "max": 1.0, "step": 0.01, "tooltip": "How deep the face and scene are in 3D. More = longer, stronger shadows from noses, chins and hair."}),
            "depth_falloff": ("FLOAT", {"default": 0.4, "min": 0.0, "max": 2.0, "step": 0.01, "tooltip": "Far areas get less light. 0 = no falloff."}),
            "shadow_height": ("FLOAT", {"default": 0.4, "min": 0.0, "max": 1.0, "step": 0.01, "tooltip": "Height of the light for SHADOWS only. Low = long stretched shadows, high = short shadows right under things. Separate from Light Z."}),
            "shadow_length": ("FLOAT", {"default": 0.3, "min": 0.02, "max": 1.0, "step": 0.01, "tooltip": "The farthest a shadow can reach (fraction of the image)."}),
            "shadow_softness": ("FLOAT", {"default": 0.5, "min": 0.0, "max": 1.0, "step": 0.01, "tooltip": "Soft shadows only: how quickly the edge softens with distance from the object."}),
            "subject_distance": ("FLOAT", {"default": 0.15, "min": 0.0, "max": 1.0, "step": 0.01, "tooltip": "Needs a mask. How far the subject stands in front of the background, so it throws a shadow on it. 0 = flat against the wall."}),
            "mask_dome": ("FLOAT", {"default": 0.4, "min": 0.0, "max": 1.0, "step": 0.01, "tooltip": "Needs a mask. Blends a rounded shape over the subject to smooth the form shading."}),
            "advanced": ("BOOLEAN", {"default": False, "tooltip": "Show the fine controls (depth, shadow shape, mask options)."}),
        }
        l1 = _light_inputs(1, {"type": "spot", "x": 0.65, "y": 0.6, "z": 0.5, "brightness": 1.4, "spread": 0.9, "warmth": 0.1})
        l2 = _light_inputs(2, {"type": "spot", "x": -0.8, "y": -0.1, "z": 0.5, "brightness": 0.6, "spread": 1.2, "warmth": -0.15})
        # widget order on the node (saved workflows restore values by position, so keep this order stable once released):
        # preset, blend, light 1, [light 2 toggle + light 2], wrap, fill, shadows, shadow controls, advanced toggle, then the fine controls under it
        order = (
            ["image", "normal_map", "depth_map", "preset", "blend"] + list(l1) + ["enable_light_2"] + list(l2)
            + ["light_wrap", "fill", "shadows", "shadow_amount", "shadow_blur", "background_shadow", "self_shadow", "relief", "advanced",
               "depth_falloff", "shadow_height", "shadow_length", "shadow_softness", "subject_distance", "mask_dome"]
        )
        d.update(l1)
        d.update(l2)
        req = {k: d[k] for k in order}
        return {"required": req, "optional": {"mask": ("MASK", {"tooltip": "Subject mask (LC Remove Background / LC Person Mask). Optional."})}}

    RETURN_TYPES = ("IMAGE", "MASK", "IMAGE")
    RETURN_NAMES = ("image", "shadow_mask", "light_layer")
    FUNCTION = "relight"
    CATEGORY = "LC123/image"
    DESCRIPTION = (
        "Relight an image from a normal map and a depth map with one or two lights (spot or sun), warmth, and real "
        "hard or soft cast shadows. Pick a preset, drag the light on the stage, and blend it back over the original."
    )

    def relight(self, image, normal_map, depth_map, preset="custom", blend=0.8,
                light1_type="spot", light1_x=0.65, light1_y=0.6, light1_z=0.5, light1_brightness=1.4, light1_spread=0.9, light1_warmth=0.1, light1_color="none", light1_color_amount=0.5,
                fill=0.18, shadows="soft", shadow_amount=0.55, advanced=False, enable_light_2=False,
                light2_type="spot", light2_x=-0.8, light2_y=-0.1, light2_z=0.5, light2_brightness=0.6, light2_spread=1.2, light2_warmth=-0.15, light2_color="none", light2_color_amount=0.5,
                relief=0.3, depth_falloff=0.4, shadow_height=0.4, shadow_length=0.3, shadow_softness=0.5,
                subject_distance=0.15, self_shadow=0.5, mask_dome=0.4, shadow_blur=0.35, light_wrap=0.3, background_shadow=0.5, mask=None):
        dev = _device()
        img = image.detach().float()[..., :3]
        b, h, w, _ = img.shape
        rgb = img.permute(0, 3, 1, 2).to(dev)                                    # B3HW
        nmap = normal_map.detach().float()[..., :3].permute(0, 3, 1, 2).to(dev)
        dmap = depth_map.detach().float()[..., :3].mean(dim=-1, keepdim=True).permute(0, 3, 1, 2).to(dev)
        if nmap.shape[0] != b:
            nmap = nmap[:1].expand(b, -1, -1, -1)
        if dmap.shape[0] != b:
            dmap = dmap[:1].expand(b, -1, -1, -1)
        normals = _decode_normals(_resize_bchw(nmap, h, w))
        depth = _depth_01(_resize_bchw(dmap, h, w))

        # subject mask
        m_t = None
        if mask is not None:
            mm = mask.detach().float()
            if mm.ndim == 2:
                mm = mm[None]
            if mm.ndim == 4:
                mm = mm[..., 0]
            m_t = _resize_bchw(mm.unsqueeze(1).to(dev), h, w).clamp(0, 1)
            if m_t.shape[0] != b:
                m_t = m_t[:1].expand(b, -1, -1, -1)
            if float(mask_dome) > 1e-6:
                doms = [_dome_normals(m_t[i, 0].cpu().numpy(), 0.45) for i in range(b)]
                vn_full = torch.stack([torch.from_numpy(d[0]) for d in doms], 0).permute(0, 3, 1, 2).to(dev)
                mix_t = torch.stack([torch.from_numpy(d[1]) for d in doms], 0).unsqueeze(1).to(dev) * float(np.clip(mask_dome, 0, 1))
                normals = normals * (1.0 - mix_t) + vn_full * mix_t
                normals = normals / normals.norm(dim=1, keepdim=True).clamp_min(1e-6)

        # height field for shadows (pixels; near = high), edges snapped to the image
        m_dim = float(max(h, w))
        hf = (1.0 - depth) * float(relief) * 0.5 * m_dim
        use_shadows = shadows != "off" and float(shadow_amount) > 1e-6
        if use_shadows:
            gray = (rgb * torch.tensor([0.299, 0.587, 0.114], device=dev).view(1, 3, 1, 1)).sum(dim=1, keepdim=True)
            r = max(2, int(round(0.006 * min(h, w))))
            span = max(float(relief) * 0.5 * m_dim, 1.0)
            hf = _guided_filter(gray, hf / span, r, 1e-3) * span
            if m_t is not None and float(subject_distance) > 1e-6:
                # a broad, smooth lift (not per-hair-strand) so fuzzy mask edges do not speckle the shadow
                rr = max(2, int(round(0.008 * m_dim)))
                lift = _box(_box(m_t, rr), rr)
                hf = hf + lift * float(subject_distance) * 0.35 * m_dim

        lit = torch.full((b, 3, h, w), float(fill), device=dev)
        shadow_out = torch.zeros((b, 1, h, w), device=dev)
        lights = [(1, light1_type, light1_x, light1_y, light1_z, light1_brightness, light1_spread, light1_warmth, light1_color, light1_color_amount)]
        if enable_light_2:
            lights.append((2, light2_type, light2_x, light2_y, light2_z, light2_brightness, light2_spread, light2_warmth, light2_color, light2_color_amount))
        for n, ltype, lx, ly, lz, bright, spread, warmth, lcolor, lamount in lights:
            if float(bright) <= 1e-6:
                continue
            term = _diffuse(normals, depth, dev, ltype, lx, ly, lz, spread, depth_falloff, light_wrap) * float(bright)
            if use_shadows:
                sh = _cast_shadow(hf, lx, ly, shadow_height, shadow_length, shadow_softness, shadows)
                br = int(round(float(np.clip(shadow_blur, 0.0, 1.0)) * 0.04 * m_dim))
                if br >= 1:  # two box passes ~ a smooth tent blur
                    sh = _box(_box(sh, br), max(1, br // 2 + 1))
                if m_t is not None:
                    inside = _box(m_t, max(1, int(round(0.004 * m_dim))))
                    sh = sh * ((1.0 - inside) * float(background_shadow) + inside * float(self_shadow))
                else:
                    # no mask: treat the far part of the depth map as the background
                    t = ((depth - 0.4) / 0.3).clamp(0.0, 1.0)
                    bgw = t * t * (3.0 - 2.0 * t)
                    sh = sh * ((1.0 - bgw) + bgw * float(background_shadow))
                term = term * (1.0 - sh * float(np.clip(shadow_amount, 0, 1)))
                shadow_out = torch.maximum(shadow_out, sh)
            lit = lit + term * _tint(warmth, lcolor, lamount).to(dev).view(1, 3, 1, 1)

        relit = (rgb * lit).clamp(0, 1)
        s = float(np.clip(blend, 0.0, 1.0))
        out = (rgb * (1.0 - s) + relit * s).clamp(0, 1)
        layer = (lit / lit.amax(dim=(1, 2, 3), keepdim=True).clamp_min(1e-4)).clamp(0, 1)
        return (
            out.permute(0, 2, 3, 1).cpu(),
            (1.0 - shadow_out[:, 0]).cpu(),  # inverted: white = lit, black = in shadow
            layer.permute(0, 2, 3, 1).cpu(),
        )


NODE_CLASS_MAPPINGS = {"LCLightingControlV2": LCLightingControlV2}
NODE_DISPLAY_NAME_MAPPINGS = {"LCLightingControlV2": "LC Lighting Control V2 🔦"}
