"""
LC Skin Upscale
---------------
One UPSCALE_MODEL + optional mask. Crop to matte, run the CNN, feather composite.
No stack type, no diffusion / USDU sampler.

mode:
  detail 1x — model output is resized back to the source size (SkinContrast).
  scale     — keep the model's native factor; unmasked area is bilinear-upscaled.
"""

from __future__ import annotations

import numpy as np
import torch
from nodes import PreviewImage

from .lc_image_helpers import tensor_to_np, np_to_tensor, blend


def _box_blur(ch: np.ndarray, rad: int) -> np.ndarray:
    if rad <= 0:
        return ch
    pad = np.pad(ch, rad, mode="edge")
    k = 2 * rad + 1
    acc = np.cumsum(np.cumsum(pad, axis=0), axis=1)
    h, w = ch.shape
    out = (
        acc[k - 1 : k - 1 + h, k - 1 : k - 1 + w]
        - acc[0:h, k - 1 : k - 1 + w]
        - acc[k - 1 : k - 1 + h, 0:w]
        + acc[0:h, 0:w]
    )
    return (out / float(k * k)).astype(np.float32)


def _rgb_to_lab(rgb: np.ndarray) -> np.ndarray:
    a = 0.055
    lin = np.where(rgb <= 0.04045, rgb / 12.92, ((rgb + a) / (1.0 + a)) ** 2.4).astype(np.float32)
    m = np.array(
        [
            [0.4124564, 0.3575761, 0.1804375],
            [0.2126729, 0.7151522, 0.0721750],
            [0.0193339, 0.1191920, 0.9503041],
        ],
        dtype=np.float32,
    )
    xyz = lin @ m.T
    xyz = xyz / np.array([0.95047, 1.0, 1.08883], dtype=np.float32)
    eps = 216.0 / 24389.0
    kap = 24389.0 / 27.0
    f = np.where(xyz > eps, np.cbrt(np.clip(xyz, 1e-8, None)), (kap * xyz + 16.0) / 116.0)
    L = 116.0 * f[..., 1] - 16.0
    aa = 500.0 * (f[..., 0] - f[..., 1])
    bb = 200.0 * (f[..., 1] - f[..., 2])
    return np.stack([L, aa, bb], axis=-1).astype(np.float32)


def _auto_skin_mask(rgb: np.ndarray, sensitivity: float, feather: float) -> np.ndarray:
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    lab = _rgb_to_lab(rgb)
    L, aa, bb = lab[..., 0], lab[..., 1], lab[..., 2]
    chroma = np.sqrt(aa * aa + bb * bb).astype(np.float32)
    h, w = int(rgb.shape[0]), int(rgb.shape[1])
    base = min(h, w)
    skin_rgb = (
        (r > 0.36) & (g > 0.16) & (b > 0.09) & (r > g) & (r > b)
        & ((r - g) > 0.05) & ((r - g) < 0.50) & ((r - b) < 0.58)
    ).astype(np.float32)
    skin_lab = (
        (L > 32.0) & (L < 92.0) & (aa > 3.0) & (aa < 38.0)
        & (bb > 2.0) & (bb < 40.0) & (chroma > 6.0) & (chroma < 50.0)
    ).astype(np.float32)
    m = np.clip(0.42 * skin_rgb + 0.58 * skin_lab, 0, 1)
    f = float(np.clip(feather, 0.0, 1.0))
    rad = max(1, int(round(base * (0.003 + 0.012 * f))))
    m = _box_blur(m, rad)
    thr = 0.36 - (float(sensitivity) - 0.5) * 0.22
    m = np.clip((m - thr) / max(1e-5, (0.95 - thr)), 0, 1)
    return _box_blur(m, max(1, rad // 2)).astype(np.float32)


def _as_hw(mask, h: int, w: int) -> np.ndarray | None:
    if mask is None:
        return None
    m = mask.detach().cpu().numpy() if hasattr(mask, "detach") else np.asarray(mask)
    m = m.astype(np.float32)
    m = np.squeeze(m)
    if m.ndim == 3:
        # [C,H,W] or [H,W,C] or leftover batch of 1
        if m.shape[0] in (1, 3, 4) and m.shape[-1] not in (1, 3, 4):
            m = m[0]
        elif m.shape[-1] in (1, 3, 4):
            m = m.mean(axis=-1) if m.shape[-1] > 1 else m[..., 0]
        elif m.shape[0] != h and m.shape[-2:] == (h, w):
            m = m[0]
        else:
            m = m.mean(axis=0)
    if m.ndim == 1:
        if m.size == h * w:
            m = m.reshape(h, w)
        else:
            return None
    if m.ndim != 2:
        return None
    if m.shape[0] != h or m.shape[1] != w:
        ys = (np.linspace(0, m.shape[0] - 1, h)).astype(np.int32)
        xs = (np.linspace(0, m.shape[1] - 1, w)).astype(np.int32)
        m = m[ys][:, xs]
    return np.clip(m, 0, 1).astype(np.float32)


def _feather_mask(m: np.ndarray, feather: float) -> np.ndarray:
    if m is None or m.ndim < 2:
        return m if m is not None else np.zeros((1, 1), np.float32)
    f = float(np.clip(feather, 0.0, 1.0))
    if f <= 0.001:
        return m
    base = min(int(m.shape[0]), int(m.shape[1]))
    rad = max(1, int(round(base * (0.004 + 0.02 * f))))
    return _box_blur(m, rad)


def _bbox(m: np.ndarray, pad: int):
    ys, xs = np.where(m > 0.02)
    if ys.size == 0:
        return None
    h, w = m.shape
    y0 = max(0, int(ys.min()) - pad)
    y1 = min(h, int(ys.max()) + 1 + pad)
    x0 = max(0, int(xs.min()) - pad)
    x1 = min(w, int(xs.max()) + 1 + pad)
    # pad to multiple of 8
    y1 += (8 - (y1 - y0) % 8) % 8
    x1 += (8 - (x1 - x0) % 8) % 8
    y1 = min(h, y1)
    x1 = min(w, x1)
    return y0, y1, x0, x1


def _resize_hw(img: np.ndarray, h: int, w: int) -> np.ndarray:
    import torch.nn.functional as F

    t = torch.from_numpy(np.clip(img, 0, 1).astype(np.float32))
    if t.ndim == 2:
        t = t[None, None]
        t = F.interpolate(t, size=(h, w), mode="bilinear", align_corners=False)
        return t[0, 0].numpy()
    t = t.permute(2, 0, 1)[None]
    t = F.interpolate(t, size=(h, w), mode="bilinear", align_corners=False)
    return t[0].permute(1, 2, 0).numpy()


def _run_model(upscale_model, image_bhwc: torch.Tensor, tile: int, overlap: int) -> torch.Tensor:
    import comfy.utils

    scale = float(getattr(upscale_model, "scale", 1.0) or 1.0)
    s = image_bhwc.movedim(-1, -3).contiguous()
    in_img = s
    tile = int(tile)
    overlap = int(max(0, overlap))
    if tile <= 0:
        tile = max(s.shape[-1], s.shape[-2])

    def _fn(a):
        return upscale_model(a)

    oom = True
    cur = max(64, tile)
    last = None
    while oom:
        try:
            s = comfy.utils.tiled_scale(
                in_img,
                _fn,
                tile_x=cur,
                tile_y=cur,
                overlap=min(overlap, max(0, cur // 4)),
                upscale_amount=scale,
                out_channels=in_img.shape[1],
            )
            oom = False
        except Exception as e:
            last = e
            nxt = cur // 2
            if nxt < 64:
                raise last
            cur = nxt
    return torch.clamp(s.movedim(-3, -1), 0.0, 1.0)


class LCSkinUpscale(PreviewImage):
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE", {"tooltip": "Source image (batch ok)."}),
                "upscale_model": ("UPSCALE_MODEL", {"tooltip": "One CNN upscaler. 1× SkinContrast for detail."}),
                "mode": (
                    ["detail 1x", "scale"],
                    {
                        "default": "detail 1x",
                        "tooltip": "detail 1x = paste back at original size. scale = keep the model's native factor.",
                    },
                ),
                "blend": (
                    "FLOAT",
                    {
                        "default": 0.75,
                        "min": 0.0,
                        "max": 1.0,
                        "step": 0.05,
                        "tooltip": "How hard the upscaled patch replaces the original under the mask.",
                    },
                ),
                "mask_source": (
                    ["input", "chroma", "input+chroma"],
                    {
                        "default": "input+chroma",
                        "tooltip": "input = wired mask only. chroma = auto skin. input+chroma = AND.",
                    },
                ),
                "mask_sensitivity": (
                    "FLOAT",
                    {
                        "default": 0.55,
                        "min": 0.0,
                        "max": 1.0,
                        "step": 0.05,
                        "tooltip": "Auto-skin reach when chroma is used.",
                    },
                ),
                "mask_feather": (
                    "FLOAT",
                    {
                        "default": 0.45,
                        "min": 0.0,
                        "max": 1.0,
                        "step": 0.05,
                        "tooltip": "Soft edge on the composite matte.",
                    },
                ),
                "tile": (
                    "INT",
                    {
                        "default": 512,
                        "min": 0,
                        "max": 2048,
                        "step": 64,
                        "tooltip": "CNN tile size. 0 = try full crop, shrink on OOM.",
                    },
                ),
                "overlap": (
                    "INT",
                    {
                        "default": 32,
                        "min": 0,
                        "max": 256,
                        "step": 8,
                        "tooltip": "Tile overlap in pixels.",
                    },
                ),
            },
            "optional": {
                "mask": (
                    "MASK",
                    {"tooltip": "Person / skin matte from RMBG or similar. Stay external."},
                ),
            },
        }

    RETURN_TYPES = ("IMAGE", "MASK")
    RETURN_NAMES = ("image", "skin_mask")
    FUNCTION = "run"
    CATEGORY = "LC123/image"
    OUTPUT_NODE = True
    DESCRIPTION = (
        "Skin-masked CNN upscale. One model, bbox crop, feather composite, "
        "on-node before/after wipe. RMBG stays an external MASK."
    )

    def run(
        self,
        image,
        upscale_model,
        mode="detail 1x",
        blend=0.75,
        mask_source="input+chroma",
        mask_sensitivity=0.55,
        mask_feather=0.45,
        tile=512,
        overlap=32,
        mask=None,
    ):
        frames = tensor_to_np(image)
        mask_raw = None
        if mask is not None:
            mask_raw = mask.detach().cpu().numpy().astype(np.float32) if hasattr(mask, "detach") else np.asarray(mask, dtype=np.float32)

        out_imgs = []
        out_masks = []
        for i, fr in enumerate(frames):
            rgb = np.clip(fr[..., :3], 0, 1).astype(np.float32)
            h, w = rgb.shape[0], rgb.shape[1]
            ext = None
            if mask_raw is not None:
                piece = mask_raw
                if mask_raw.ndim >= 3 and mask_raw.shape[0] == len(frames):
                    piece = mask_raw[min(i, mask_raw.shape[0] - 1)]
                ext = _as_hw(piece, h, w)

            chroma = None
            if mask_source in ("chroma", "input+chroma"):
                chroma = _auto_skin_mask(rgb, mask_sensitivity, mask_feather)

            if mask_source == "input":
                matte = ext if ext is not None else np.ones((h, w), np.float32)
            elif mask_source == "chroma":
                matte = chroma if chroma is not None else np.ones((h, w), np.float32)
            else:
                if ext is None:
                    matte = chroma if chroma is not None else np.ones((h, w), np.float32)
                else:
                    matte = ext * (chroma if chroma is not None else 1.0)

            matte = _feather_mask(np.clip(matte, 0, 1), mask_feather)
            box = _bbox(matte, pad=16)
            if box is None or float(blend) <= 0.001:
                out_imgs.append(fr)
                out_masks.append(matte)
                continue

            y0, y1, x0, x1 = box
            crop = rgb[y0:y1, x0:x1]
            crop_t = torch.from_numpy(crop[None, ...])
            up = _run_model(upscale_model, crop_t, tile, overlap)[0].cpu().numpy()

            scale = float(getattr(upscale_model, "scale", 1.0) or 1.0)
            if mode == "detail 1x":
                up_fit = _resize_hw(up, y1 - y0, x1 - x0)
                patch = rgb.copy()
                patch[y0:y1, x0:x1] = up_fit
                m3 = matte[..., None] * float(blend)
                composed = rgb * (1.0 - m3) + patch * m3
                out_h, out_w = h, w
                matte_out = matte
            else:
                out_h, out_w = int(round(h * scale)), int(round(w * scale))
                base = _resize_hw(rgb, out_h, out_w)
                cy0, cy1 = int(round(y0 * scale)), int(round(y1 * scale))
                cx0, cx1 = int(round(x0 * scale)), int(round(x1 * scale))
                up_fit = _resize_hw(up, max(1, cy1 - cy0), max(1, cx1 - cx0))
                patch = base.copy()
                patch[cy0:cy1, cx0:cx1] = up_fit
                matte_out = _resize_hw(matte, out_h, out_w)
                m3 = matte_out[..., None] * float(blend)
                composed = base * (1.0 - m3) + patch * m3

            if fr.shape[-1] == 4:
                a = fr[..., 3:4]
                if composed.shape[0] != h:
                    a = _resize_hw(a[..., 0], composed.shape[0], composed.shape[1])[..., None]
                composed = np.concatenate([composed, a], axis=-1)
            out_imgs.append(np.clip(composed, 0, 1).astype(np.float32))
            out_masks.append(matte_out.astype(np.float32))

        result = np_to_tensor(out_imgs)
        mask_t = torch.from_numpy(np.stack(out_masks, axis=0).astype(np.float32))
        out = {"ui": {}, "result": (result, mask_t)}
        try:
            after = self.save_images(result, filename_prefix="lc_after")
            out["ui"]["lc_preview"] = after["ui"]["images"]
            before = self.save_images(image, filename_prefix="lc_before")
            out["ui"]["lc_before"] = before["ui"]["images"]
        except Exception:
            pass
        return out


NODE_CLASS_MAPPINGS = {"LCSkinUpscale": LCSkinUpscale}
NODE_DISPLAY_NAME_MAPPINGS = {"LCSkinUpscale": "LC Skin Upscale"}
