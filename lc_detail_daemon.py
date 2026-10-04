"""
LC Detail Daemon (BETA)
-----------------------
Adds detail by telling the model there is a little less noise than there really is, so it removes a little less and
keeps more fine texture (the Detail Daemon / Lying Sigma idea).

  amount : the same scale as the original Detail Daemon (0.25 = the model is told 2.5% less noise at the peak).
           Negative = smoother. Not multiplied by CFG: the same amount does the same thing at cfg 1 and cfg 7.
  start / end / peak : where in the steps it works, as in the original (0 = first step, 1 = last). Early steps shape
           folds, windows and fabric; the last steps only leave noise behind.
  exponent : the ramp's curve, as in the original (below 1 = fuller, above 1 = narrower).
  mode   : classic = the original method. look only = the model is told less noise but its answer is rescaled to the
           real noise, so only how it sees the picture changes (gentle). keep structure = classic, but only the fine
           part of the change is kept, so the picture's layout and big shapes stay as they were (slower: two model
           calls per step in the window).

The schedule follows ComfyUI-Detail-Daemon (Jonseed, MIT): cosine ramps over the steps, the same amount scale.
Two versions: SAMPLER (between your sampler and SamplerCustomAdvanced) and MODEL (works with a plain KSampler).
"""

from __future__ import annotations

import json
import math

import torch
import torch.nn.functional as F

import comfy.patcher_extension as pe
from comfy.samplers import KSAMPLER

MODES = ["classic", "look only", "keep structure"]
SCALE = 0.1  # the original's: amount 1.0 = 10% less noise


def schedule(steps, start, end, peak, amount, exponent=1.0):
    """Per step multiplier (the original's shape: cosine up to the peak, down to the end, times amount)."""
    steps = max(1, int(steps))
    start = min(max(start, 0.0), 1.0)
    end = min(max(end, start), 1.0)
    mid = start + min(max(peak, 0.0), 1.0) * (end - start)
    i0, im, i1 = (int(round(v * (steps - 1))) for v in (start, mid, end))
    out = [0.0] * steps

    def ramp(n, up):
        vals = []
        for j in range(n):
            t = j / (n - 1) if n > 1 else 0.0  # as numpy's linspace: a one-step ramp is 0 going up, full coming down
            t = t if up else 1.0 - t
            v = 0.5 * (1 - math.cos(t * math.pi))
            vals.append(v ** exponent)  # 0 ** 0 = 1, as the original: exponent 0 = the whole window at full strength
        return vals

    for j, v in enumerate(ramp(im - i0 + 1, True)):
        out[i0 + j] = v * amount
    for j, v in enumerate(ramp(i1 - im + 1, False)):
        out[im + j] = v * amount
    return out


def _at(sigma, sigmas, sched):
    """The multiplier for this sigma: the step it belongs to, blended between neighbours (sub-steps land in between)."""
    if sigmas is None or len(sigmas) < 2 or not sched:
        return 0.0
    s = [float(v) for v in sigmas]
    if not (s[-1] <= sigma <= s[0] + 1e-6) or sigma <= 0:
        return 0.0
    n = len(sched)
    for i in range(min(n, len(s) - 1)):
        hi, lo = s[i], s[i + 1]
        if lo <= sigma <= hi + 1e-9:
            if hi - lo < 1e-9:
                return sched[i]
            t = (hi - sigma) / (hi - lo)  # 0 at this step, 1 at the next
            nxt = sched[i + 1] if i + 1 < n else 0.0
            return sched[i] * (1 - t) + nxt * t
    return 0.0


def _blur(x):
    """Small blur over the last two dimensions (latent pixels), for any latent shape."""
    shape = x.shape
    y = x.reshape(-1, 1, shape[-2], shape[-1]).float()
    k = torch.tensor([1.0, 2.0, 1.0], device=y.device) / 4.0
    for _ in range(2):
        y = F.pad(y, (1, 1, 1, 1), mode="replicate")
        y = F.conv2d(y, k.view(1, 1, 1, 3))
        y = F.conv2d(y, k.view(1, 1, 3, 1))
    return y.reshape(shape).to(x.dtype)


def _call(fn, x, sigma, mult, mode, *args, **kwargs):
    """mult = this step's multiplier. classic: the model is told less noise. look only: its answer is rescaled to the
    real noise. keep structure: classic, but only the fine part of the change is kept."""
    if not mult:
        return fn(x, sigma, *args, **kwargs)
    lied = sigma * max(1e-6, 1.0 - mult * SCALE)
    out = fn(x, lied, *args, **kwargs)
    if mode == "look only":
        r = (sigma / lied).reshape(-1, *([1] * (x.ndim - 1))).to(out.dtype)
        return x - r * (x - out)  # denoised = x - sigma * prediction, at the real sigma
    if mode == "keep structure":
        true = fn(x, sigma, *args, **kwargs)
        d = out - true
        return true + (d - _blur(d))
    return out


def _sampler(model, x, sigmas, *, lc_wrapped, lc_amount, lc_start, lc_end, lc_peak, lc_exponent=1.0, lc_mode="classic", **kwargs):
    sched = schedule(len(sigmas) - 1, lc_start, lc_end, lc_peak, lc_amount, lc_exponent)
    sig = sigmas.detach().float().cpu()

    def model_wrapper(x, sigma, **extra_args):
        mult = _at(float(sigma.max()), sig, sched)
        return _call(model, x, sigma, mult, lc_mode, **extra_args)

    for k in ("inner_model", "sigmas", "latent_image", "noise"):  # LC Speed Boost reads the last two
        if hasattr(model, k):
            setattr(model_wrapper, k, getattr(model, k))
    return lc_wrapped.sampler_function(model_wrapper, x, sigmas, **kwargs, **lc_wrapped.extra_options)


DD_TIP = ("Put it on the low pass sampler. Detail is made in the last steps; on the high pass it moves the layout.\n"
          "Krea 2 / Krealism: look only 0.5 to 1.0, start 0.15, end 0.85, peak 0, exponent 0. classic and keep "
          "structure hit harder: start lower. At 16+ steps use less. Samplers that add their own noise (dpmpp_2m_sde, euler_ancestral, "
          "er_sde, res_* / ClownSampler with eta): lower it, or it can leave specks.")


def _inputs(first):
    return {
        "required": {
            **first,
            "amount": ("FLOAT", {"default": 1.0, "min": -5.0, "max": 5.0, "step": 0.01,
                       "tooltip": "How much detail. The same scale as the original Detail Daemon: 0.25 = the model is told 2.5% "
                                  "less noise at the peak. Negative = smoother. Not multiplied by CFG.\n" + DD_TIP}),
            "start": ("FLOAT", {"default": 0.15, "min": 0.0, "max": 1.0, "step": 0.01,
                      "tooltip": "The step where it begins: 0 = first step, 1 = last. Early steps shape folds and fabric."}),
            "end": ("FLOAT", {"default": 0.85, "min": 0.0, "max": 1.0, "step": 0.01,
                    "tooltip": "The step where it ends. Leave the last steps alone, or noise can stay in the image."}),
            "peak": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 1.0, "step": 0.05,
                     "tooltip": "Where in the window it is strongest (the original's bias): 0 = right at start, on the noisy steps, "
                                "where it shapes things (works best); higher = later, a gentler sharpen."}),
            "exponent": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 10.0, "step": 0.05,
                         "tooltip": "The ramp's curve: 0 = flat, full strength across the whole window (works best); "
                                    "1 = a smooth bump; above 1 = narrower."}),
            "mode": (MODES, {"default": "look only",
                     "tooltip": "look only = the model sees less noise, but its answer is rescaled to the real noise: crisp, without "
                                "big reshuffles. classic = the original Detail Daemon (more detail, small things shift). keep structure = "
                                "classic, but only the fine part of the change is kept, so the layout stays (two model calls per step "
                                "in the window)."}),
        },
        "optional": {
            "sigmas": ("SIGMAS", {"tooltip": "Draws the graph only. Wire the sigmas of the sampler this feeds (sigmas_low for the "
                                              "low pass). The window always follows that sampler's own steps."}),
        },
    }


def _ui(amount, start, end, peak, exponent, mode, sigmas, tip=""):
    n = int(len(sigmas) - 1) if sigmas is not None and len(sigmas) > 1 else 0
    return {"lc_detail_daemon": [json.dumps({"amount": amount, "start": start, "end": end, "peak": peak, "exponent": exponent,
                                             "mode": mode, "steps": n, "tip": tip})]}


class LCDetailDaemon:
    @classmethod
    def INPUT_TYPES(cls):
        return _inputs({"sampler": ("SAMPLER", {"tooltip": "From KSamplerSelect, LC Sigmas or ClownSampler (any SAMPLER)."})})

    RETURN_TYPES = ("SAMPLER",)
    FUNCTION = "go"
    CATEGORY = "LC123/sampling"
    DESCRIPTION = ("Adds fine detail by telling the model there is a little less noise than there really is, in a window of "
                   "the steps. Same scale and window as the original Detail Daemon, plus keep structure mode, and no CFG maths.\n"
                   "Put it on the low pass sampler. Detail is made in the last steps.")

    def go(self, sampler, amount, start, end, peak, exponent=0.0, mode="look only", sigmas=None):
        s = KSAMPLER(_sampler, extra_options={"lc_wrapped": sampler, "lc_amount": float(amount), "lc_start": float(start),
                                              "lc_end": float(end), "lc_peak": float(peak), "lc_exponent": float(exponent),
                                              "lc_mode": mode},
                     inpaint_options=getattr(sampler, "inpaint_options", {}))
        return {"ui": _ui(amount, start, end, peak, exponent, mode, sigmas), "result": (s,)}


class LCDetailDaemonModel:
    @classmethod
    def INPUT_TYPES(cls):
        return _inputs({"model": ("MODEL", {"tooltip": "The model going into your KSampler."})})

    RETURN_TYPES = ("MODEL",)
    FUNCTION = "go"
    CATEGORY = "LC123/sampling"
    DESCRIPTION = ("Detail Daemon for a plain KSampler: the same as the sampler version, as a model patch. "
                   "Stacks with other model patches.")

    def go(self, model, amount, start, end, peak, exponent=0.0, mode="look only", sigmas=None):
        m = model.clone()
        a, s0, s1, pk, ex = float(amount), float(start), float(end), float(peak), float(exponent)
        cache = {}

        def wrapper(executor, x, t, *args, **kwargs):
            to = kwargs.get("transformer_options") or next((v for v in args if isinstance(v, dict) and "sample_sigmas" in v), {})
            sig = to.get("sample_sigmas")
            if sig is None:
                return executor(x, t, *args, **kwargs)
            key = (len(sig), float(sig[0]), float(sig[-1]))
            if key not in cache:  # one schedule per sampler run
                cache.clear()
                cache[key] = (sig.detach().float().cpu(), schedule(len(sig) - 1, s0, s1, pk, a, ex))
            sc, sched = cache[key]
            mult = _at(float(t.max()), sc, sched)
            return _call(executor, x, t, mult, mode, *args, **kwargs)

        m.add_wrapper_with_key(pe.WrappersMP.APPLY_MODEL, "lc_detail_daemon", wrapper)
        return {"ui": _ui(amount, start, end, peak, exponent, mode, sigmas), "result": (m,)}


NODE_CLASS_MAPPINGS = {"LCDetailDaemon": LCDetailDaemon, "LCDetailDaemonModel": LCDetailDaemonModel}
NODE_DISPLAY_NAME_MAPPINGS = {"LCDetailDaemon": "LC Detail Daemon (BETA)", "LCDetailDaemonModel": "LC Detail Daemon (model) (BETA)"}
