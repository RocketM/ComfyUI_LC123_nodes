"""
LC Image Batch From Folder
--------------------------
Load every image in a folder as one IMAGE batch, in alphabetical (natural)
order: img2 comes before img10. start_index + max_images pick a window so low
VRAM setups can test in chunks. Different sizes are fitted to the first image.
"""

from __future__ import annotations

import hashlib
import os
import re

import numpy as np
import torch
from PIL import Image, ImageOps

import folder_paths

EXTS = (".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff", ".gif")


def _natural_key(s: str):
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", s)]


_QUOTES = "\"'\u201c\u201d\u2018\u2019`"


def _resolve(folder_path: str) -> str:
    """Accepts whatever gets pasted: quotes (straight or curly), / or \\ or a mix,
    doubled \\\\, trailing slashes, ~ and %VARS%. A pasted image path uses its folder.
    Relative paths are inside ComfyUI/input."""
    p = (folder_path or "").strip()
    while len(p) >= 2 and p[0] in _QUOTES and p[-1] in _QUOTES:
        p = p[1:-1].strip()
    p = p.strip(_QUOTES).strip()
    if p.lower().startswith("file:///"):
        p = p[8:]
    if not p:
        return ""
    p = os.path.expandvars(os.path.expanduser(p))
    p = p.replace("\\", "/")
    while "//" in p[1:]:
        p = p[0] + p[1:].replace("//", "/")
    p = os.path.normpath(p)
    if not os.path.isabs(p):
        p = os.path.join(folder_paths.get_input_directory(), p)
    if os.path.isfile(p):
        p = os.path.dirname(p)
    return p


def _list(folder_path: str, subfolders: bool) -> list[str]:
    root = _resolve(folder_path)
    if not os.path.isdir(root):
        return []
    found = []
    if subfolders:
        for d, _dirs, files in os.walk(root):
            found += [os.path.join(d, f) for f in files if f.lower().endswith(EXTS)]
    else:
        found = [os.path.join(root, f) for f in os.listdir(root) if f.lower().endswith(EXTS)]
    return sorted(found, key=lambda p: _natural_key(os.path.relpath(p, root)))


def _fit(img: Image.Image, w: int, h: int, mode: str) -> Image.Image:
    if img.size == (w, h):
        return img
    if mode == "stretch":
        return img.resize((w, h), Image.LANCZOS)
    if mode == "pad":
        return ImageOps.pad(img, (w, h), Image.LANCZOS, color=(0, 0, 0))
    return ImageOps.fit(img, (w, h), Image.LANCZOS)  # crop


class LCImageBatchFromFolder:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "folder_path": ("STRING", {
                    "default": "",
                    "tooltip": "Full path or a folder name inside ComfyUI/input. Paste it however you like: with or without quotes, / or \\.",
                }),
                "start_index": ("INT", {
                    "default": 0, "min": 0, "max": 100000,
                    "tooltip": "Skip this many images first (0 = start at the first one).",
                }),
                "max_images": ("INT", {
                    "default": 0, "min": 0, "max": 100000,
                    "tooltip": "Load at most this many. 0 = all of them. Lower it if you run out of memory.",
                }),
                "size_mode": (["crop", "pad", "stretch"], {
                    "default": "crop",
                    "tooltip": "Images that are not the size of the first one: crop to fill, pad with black, or stretch.",
                }),
                "include_subfolders": ("BOOLEAN", {"default": False}),
            }
        }

    RETURN_TYPES = ("IMAGE", "INT", "INT", "STRING")
    RETURN_NAMES = ("images", "count", "total_found", "filenames")
    FUNCTION = "load"
    CATEGORY = "LC123/image"
    DESCRIPTION = (
        "Loads a folder of images as one batch in alphabetical order (img2 before img10). "
        "Valid: png, jpg, jpeg, webp, bmp, tif, tiff, gif (first frame). start_index + max_images "
        "pick a window of the folder. count = images loaded, total_found = images in the folder."
    )

    @classmethod
    def IS_CHANGED(cls, folder_path, include_subfolders=False, **kwargs):
        h = hashlib.sha256()
        for p in _list(folder_path, include_subfolders):
            try:
                h.update(f"{p}|{os.path.getmtime(p)}".encode())
            except OSError:
                pass
        return h.hexdigest()

    def load(self, folder_path, start_index=0, max_images=0, size_mode="crop", include_subfolders=False):
        files = _list(folder_path, include_subfolders)
        if not files:
            where = _resolve(folder_path)
            if not where:
                raise ValueError("LC Image Batch From Folder: folder_path is empty.")
            if not os.path.isdir(where):
                raise ValueError(f"LC Image Batch From Folder: folder not found: '{where}'.")
            raise ValueError(f"LC Image Batch From Folder: no images found in '{where}'.")
        pick = files[start_index:]
        if max_images > 0:
            pick = pick[:max_images]
        if not pick:
            raise ValueError(f"LC Image Batch From Folder: start_index {start_index} is past the last image ({len(files)} found).")

        out, w, h = [], None, None
        for p in pick:
            img = ImageOps.exif_transpose(Image.open(p)).convert("RGB")
            if w is None:
                w, h = img.size
            out.append(torch.from_numpy(np.asarray(_fit(img, w, h, size_mode), dtype=np.float32) / 255.0))
        names = "\n".join(os.path.basename(p) for p in pick)
        return (torch.stack(out), len(out), len(files), names)


NODE_CLASS_MAPPINGS = {"LCImageBatchFromFolder": LCImageBatchFromFolder}
NODE_DISPLAY_NAME_MAPPINGS = {"LCImageBatchFromFolder": "LC Image Batch From Folder 📂"}
