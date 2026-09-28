"""
Shared image helpers for LC darkroom-style nodes.
"""

import functools
import os

import numpy as np
import torch


def tensor_to_np(image):
    """[B,H,W,C] float tensor 0-1 → list of HxWxC float32 arrays."""
    if image is None:
        raise ValueError(
            "LC image node received no image (None). "
            "Upstream node output is empty — check switches, bypassers, or disconnected IMAGE wires."
        )
    # Some nodes pass a list of tensors
    if isinstance(image, (list, tuple)):
        if not image:
            raise ValueError("LC image node received an empty image list.")
        image = image[0]
    if not hasattr(image, "detach"):
        raise TypeError(
            f"LC image node expected an IMAGE tensor, got {type(image).__name__}."
        )
    # .float() first: numpy has no bfloat16, so bf16/fp16 images would fail in .numpy()
    t = image.detach().float().cpu().numpy().astype(np.float32)
    return [t[i] for i in range(t.shape[0])]


# The on-node wipe only shows the first frame, so a big batch should not write a PNG pair per frame.
PREVIEW_MAX_FRAMES = 4


def preview_frames(t):
    """First few frames of a batch for the on-node preview PNGs. The IMAGE output is not affected."""
    if torch.is_tensor(t) and t.dim() == 4 and t.shape[0] > PREVIEW_MAX_FRAMES:
        return t[:PREVIEW_MAX_FRAMES]
    return t


def attach_alpha(t, alpha):
    """Put an untouched alpha channel back on an RGB result when the frames still line up."""
    if torch.is_tensor(t) and t.dim() == 4 and t.shape[-1] == 3 and t.shape[:3] == alpha.shape[:3]:
        return torch.cat([t, alpha.to(t.device, t.dtype)], dim=-1)
    return t


def _alpha_safe(run):
    """RGBA safety for nodes that work on RGB: an image with an alpha channel (a cutout, for example)
    has its color processed and its alpha handed back untouched."""
    @functools.wraps(run)
    def wrapper(self, image, *args, **kwargs):
        if not (torch.is_tensor(image) and image.dim() == 4 and image.shape[-1] == 4):
            return run(self, image, *args, **kwargs)
        alpha = image[..., 3:4]
        self._lc_alpha = alpha
        try:
            out = run(self, image[..., :3], *args, **kwargs)
        finally:
            self._lc_alpha = None

        if isinstance(out, dict) and "result" in out:
            out["result"] = (attach_alpha(out["result"][0], alpha),) + tuple(out["result"][1:])
            return out
        if isinstance(out, tuple) and out:
            return (attach_alpha(out[0], alpha),) + tuple(out[1:])
        return out

    return wrapper


def np_to_tensor(arrays):
    return torch.from_numpy(np.stack(arrays, axis=0).astype(np.float32))


def srgb_to_linear(img):
    a = 0.055
    return np.where(img <= 0.04045, img / 12.92, ((img + a) / (1 + a)) ** 2.4).astype(np.float32)


def linear_to_srgb(img):
    a = 0.055
    return np.where(img <= 0.0031308, img * 12.92, (1 + a) * np.power(np.clip(img, 0, None), 1 / 2.4) - a).astype(np.float32)


def blend(a, b, t):
    t = float(np.clip(t, 0.0, 1.0))
    if t <= 0:
        return a
    if t >= 1:
        return b
    return (a * (1.0 - t) + b * t).astype(np.float32)


def save_temp_preview(pil_image, prefix="lc_preview"):
    """Save a PIL image to ComfyUI's temp folder; returns the {filename, subfolder, type} dict the UI uses."""
    import uuid

    import folder_paths

    name = f"{prefix}_{uuid.uuid4().hex[:10]}.png"
    pil_image.save(os.path.join(folder_paths.get_temp_directory(), name), compress_level=1)
    return {"filename": name, "subfolder": "", "type": "temp"}


def luminance(img):
    return (img[..., 0] * 0.2126 + img[..., 1] * 0.7152 + img[..., 2] * 0.0722).astype(np.float32)
