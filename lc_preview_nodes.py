"""
LC Preview Image / LC Preview Mask
----------------------------------
Preview nodes that stay quiet when nothing arrives.

The core PreviewImage / MaskPreview nodes raise "required input missing" or crash on None when an upstream node
is muted, bypassed or hands over a null. These two take an OPTIONAL input: with no signal (nothing connected, a
muted branch, None, or an empty batch) they just sit there, show their empty preview window and do not error.

They pass the image / mask through like the core previews do. With no signal they pass an ExecutionBlocker, so
anything wired after them is skipped quietly too instead of choking on None.

The on-node preview lives in web/lc_preview_nodes.js and uses the standard LC image window (300 wide, 268 x 335
preview, 16 px padding). This file writes the temp PNGs it shows.
"""

from __future__ import annotations

import torch

import nodes as _nodes

try:  # newer ComfyUI: skip downstream nodes without an error
    from comfy_execution.graph import ExecutionBlocker as _Blocker
except Exception:  # pragma: no cover
    _Blocker = None


def _blocked():
    return _Blocker(None) if _Blocker is not None else None


def _is_signal(t) -> bool:
    """True when t is a real, non-empty tensor."""
    return isinstance(t, torch.Tensor) and t.numel() > 0 and t.shape[0] > 0


class _LCPreviewBase(_nodes.PreviewImage):
    """Writes temp PNGs the same way the core PreviewImage does. The UI key is our own so the stock preview
    widget stays out of the way of the LC preview window."""

    CATEGORY = "LC123/image"
    FUNCTION = "preview"
    OUTPUT_NODE = True

    def _ui(self, images):
        res = self.save_images(images, filename_prefix="LC.preview")
        return {"lc_preview": res["ui"]["images"]}


class LCPreviewImage(_LCPreviewBase):
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {}, "optional": {"image": ("IMAGE", {"tooltip": "Image to show. Nothing connected or a null signal is fine: the node just waits."})}}

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
    DESCRIPTION = "Preview an image. If no signal arrives it sits there quietly without an error."

    def preview(self, image=None):
        if not _is_signal(image):
            return {"ui": {"lc_preview": []}, "result": (_blocked(),)}
        if image.ndim == 3:  # a single HWC image
            image = image.unsqueeze(0)
        return {"ui": self._ui(image), "result": (image,)}


class LCPreviewMask(_LCPreviewBase):
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {}, "optional": {"mask": ("MASK", {"tooltip": "Mask to show (white = masked). Nothing connected or a null signal is fine: the node just waits."})}}

    RETURN_TYPES = ("MASK",)
    RETURN_NAMES = ("mask",)
    DESCRIPTION = "Preview a mask. If no signal arrives it sits there quietly, black, without an error."

    def preview(self, mask=None):
        if not _is_signal(mask):
            return {"ui": {"lc_preview": []}, "result": (_blocked(),)}
        m = mask
        if m.ndim == 2:  # a single HW mask
            m = m.unsqueeze(0)
        if m.ndim == 4:  # B1HW or BHW1: squeeze the channel
            m = m.reshape(-1, m.shape[-2], m.shape[-1]) if m.shape[1] == 1 else m[..., 0]
        img = m.clamp(0, 1).unsqueeze(-1).expand(-1, -1, -1, 3).cpu()
        return {"ui": self._ui(img), "result": (mask,)}


NODE_CLASS_MAPPINGS = {
    "LCPreviewImage": LCPreviewImage,
    "LCPreviewMask": LCPreviewMask,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "LCPreviewImage": "LC Preview Image 🖼️",
    "LCPreviewMask": "LC Preview Mask 🎭",
}
