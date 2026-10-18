"""
LC Fast cancel
--------------
ComfyUI only checks the Cancel button between sampling steps, so a heavy model (H3, LTX, a big USDU tile pass) can
keep you waiting a whole step, often 30 s or more. With Fast cancel on, every model block checks it too, so Cancel
lands within a fraction of a step. Works for every sampler (KSampler, USDU, custom samplers, video), no wiring:
when sampling starts, a tiny check is hooked onto each block of the model (once per model).

Setting: LC Settings > Optimization > Fast cancel (LC123.Optimization.FastCancel, default on), read from the user's
ComfyUI settings file. Idea from blepping's ComfyUI-bleh ModelPatchFastTerminate (Apache-2.0); written for LC123
as a global hook instead of a node.
"""
from __future__ import annotations

import json
import os

import torch

import comfy.model_management as mm
import comfy.samplers
import folder_paths

SETTING = "LC123.Optimization.FastCancel"
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


AHEAD = 3  # blocks the GPU may run behind Python: Cancel lands within this many blocks
_events = []


def _check(_module, args):
    if not _cache["on"]:
        return
    # The GPU runs behind Python: a whole step's blocks are queued in a blink, then Python waits. Keep Python at most
    # AHEAD blocks in front of the GPU, so the check sees Cancel within a few blocks, not a step later. Waiting for the
    # block AHEAD back (a recorded event) instead of a full synchronize keeps a few blocks queued, so the GPU never
    # stalls on Python between blocks.
    x = args[0] if args and isinstance(args[0], torch.Tensor) else None
    if x is not None and x.is_cuda:
        ev = torch.cuda.Event()
        ev.record(torch.cuda.current_stream(x.device))
        _events.append(ev)
        if len(_events) > AHEAD:
            _events.pop(0).synchronize()
    # cheap read first: the locked check (which also resets the flag and raises) only runs when Cancel was pressed
    if mm.interrupt_processing:
        mm.throw_exception_if_processing_interrupted()


def hook_model(diffusion_model) -> int:
    """Hook every block of the model's block lists (transformer blocks, UNet input/output blocks...). Once per model."""
    if diffusion_model is None or getattr(diffusion_model, "_lc_fast_cancel", False):
        return 0
    n = 0
    for _name, child in diffusion_model.named_children():
        if isinstance(child, torch.nn.ModuleList) and len(child) >= 2:
            for block in child:
                block.register_forward_pre_hook(_check)
                n += 1
    diffusion_model._lc_fast_cancel = True
    return n


_orig = comfy.samplers.CFGGuider.outer_sample


def _outer_sample(self, *args, **kwargs):
    try:
        if enabled():
            n = hook_model(getattr(getattr(self.model_patcher, "model", None), "diffusion_model", None))
            if n:
                print(f"[LC123] Fast cancel: Cancel is now checked in {n} model blocks.")
    except Exception as e:  # never stop a run over this
        print(f"[LC123] Fast cancel skipped: {e}")
    return _orig(self, *args, **kwargs)


if not getattr(comfy.samplers.CFGGuider, "_lc_fast_cancel", False):
    comfy.samplers.CFGGuider.outer_sample = _outer_sample
    comfy.samplers.CFGGuider._lc_fast_cancel = True

NODE_CLASS_MAPPINGS = {}
