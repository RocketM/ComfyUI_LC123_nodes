"""
LC Free text encoder
--------------------
Once the prompt is encoded the text encoder is dead weight, but ComfyUI leaves it sitting in VRAM until it runs out
of room. With a big encoder (H3's 32B Qwen, Krea 2's Qwen 3) that means the diffusion model loads partly offloaded and
every step runs slower. With this on, any text encoder still in VRAM is moved to RAM the moment sampling starts. It is
not deleted: a new prompt reloads it from RAM in a second or two.

Only encoders of 1 GB or more are moved (small CLIP-L / CLIP-G encoders cost more to reload than they save).

Setting: LC Settings > Optimization > Free text encoder before sampling (LC123.Optimization.FreeTextEncoder, default
on). Idea from Deno2026's text encoder unload barrier (ideas only, written fresh for LC123).
"""
from __future__ import annotations

import json
import os

import comfy.model_management as mm
import comfy.samplers
import folder_paths

SETTING = "LC123.Optimization.FreeTextEncoder"
MIN_BYTES = 1 << 30
_cache = {"mtime": None, "on": True}


def enabled() -> bool:
    path = os.path.join(folder_paths.get_user_directory(), "default", "comfy.settings.json")
    try:
        mtime = os.path.getmtime(path)
    except OSError:
        return True
    if mtime != _cache["mtime"]:
        try:
            with open(path, encoding="utf-8") as f:
                _cache["on"] = json.load(f).get(SETTING, True) is not False
        except Exception:
            _cache["on"] = True
        _cache["mtime"] = mtime
    return _cache["on"]


def _is_text_encoder(loaded) -> bool:
    m = getattr(loaded.model, "model", None)  # the ModelPatcher's module: a CLIP's is the cond_stage_model
    return m is not None and hasattr(m, "encode_token_weights")


def free_text_encoders() -> float:
    """Move every big text encoder that is in VRAM to RAM. Returns GB freed."""
    freed = 0
    for i in range(len(mm.current_loaded_models) - 1, -1, -1):
        lm = mm.current_loaded_models[i]
        try:
            if lm.is_dead() or not _is_text_encoder(lm):
                continue
            used = lm.model_loaded_memory() if hasattr(lm, "model_loaded_memory") else lm.model_memory()
            if used < MIN_BYTES:
                continue
            if lm.model_unload():
                mm.current_loaded_models.pop(i)
            freed += used
        except Exception as e:  # never stop a run over this
            print(f"[LC123] Free text encoder skipped one model: {e}")
    if freed:
        mm.soft_empty_cache()
    return freed / (1 << 30)


_orig = comfy.samplers.CFGGuider.outer_sample


def _outer_sample(self, *args, **kwargs):
    try:
        if enabled():
            gb = free_text_encoders()
            if gb > 0:
                print(f"[LC123] Free text encoder: moved {gb:.1f} GB of text encoder from VRAM to RAM before sampling.")
    except Exception as e:
        print(f"[LC123] Free text encoder skipped: {e}")
    return _orig(self, *args, **kwargs)


if not getattr(comfy.samplers.CFGGuider, "_lc_free_te", False):
    comfy.samplers.CFGGuider.outer_sample = _outer_sample
    comfy.samplers.CFGGuider._lc_free_te = True

NODE_CLASS_MAPPINGS = {}
