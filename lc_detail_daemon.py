"""
LC Detail Daemon (BETA)
-----------------------
Adds detail by telling the model there is a little less noise than there really is, so it removes a little less and
keeps more fine texture (the Detail Daemon / Lying Sigma idea). Made easy to read:

  amount : how much of the noise is hidden from the model at the peak (0.05 = 5%). Negative = smoother.
           Not multiplied by CFG: the same amount does the same thing at cfg 1 and cfg 7.
  start / end : how far along the image is, 0% = pure noise, 100% = finished. Measured from the noise level itself,
           so it is the same in a high and a low pass and with any step count.
  peak   : where in that window the effect is strongest. It fades in and out smoothly.

Two versions: SAMPLER (between KSamplerSelect and SamplerCustomAdvanced) and MODEL (works with a plain KSampler).
"""

from __future__ import annotations

import json
import math
from functools import partial

import comfy.patcher_extension as pe
from comfy.samplers import KSAMPLER


def _is_flow(ms) -> bool:
    import comfy.model_sampling as m

    return isinstance(ms, (m.ModelSamplingDiscreteFlow, m.ModelSamplingFlux)) or isinstance(ms, getattr(m, "CONST", ()))


def _progress(sigma: float, flow: bool) -> float:
    """How far along the image is: 0 = pure noise, 1 = finished."""
    share = sigma if flow else sigma / (1.0 + sigma)
    return 1.0 - min(max(share, 0.0), 1.0)


def envelope(p, start, end, peak):
    """0..1: fades in from start to the peak, out to end (smooth)."""
    if end <= start or p <= start or p >= end:
        return 0.0
    mid = start + min(max(peak, 0.0), 1.0) * (end - start)
    t = (p - start) / max(1e-6, mid - start) if p <= mid else (end - p) / max(1e-6, end - mid)
    t = min(max(t, 0.0), 1.0)
    return 0.5 - 0.5 * math.cos(math.pi * t)


def _lie(sigma, flow, amount, start, end, peak):
    s = float(sigma.max())
    k = amount * envelope(_progress(s, flow), start, end, peak)
    return sigma * max(1e-6, 1.0 - k) if k else sigma


MODES = ["auto", "classic", "look only"]


def _call(fn, x, sigma, flow, amount, start, end, peak, mode, *args, **kwargs):
    """classic: the model is told less noise and removes less (Detail Daemon). look only: the model is told less
    noise, but its answer is rescaled to the real noise level, so only what it sees changes."""
    lied = _lie(sigma, flow, amount, start, end, peak)
    out = fn(x, lied, *args, **kwargs)
    if mode == "auto":  # tested: classic breaks flow models (Krea 2) into blocks; look only adds detail there
        mode = "look only" if flow else "classic"
    if mode == "classic" or lied is sigma:
        return out
    r = (sigma / lied).reshape(-1, *([1] * (x.ndim - 1))).to(out.dtype)
    return x - r * (x - out)  # denoised = x - sigma * prediction, at the real sigma


def _find_ms(model):
    """The model_sampling behind a k-diffusion model wrapper (several layers deep)."""
    obj = model
    for _ in range(6):
        ms = getattr(obj, "model_sampling", None)
        if ms is not None:
            return ms
        obj = getattr(obj, "inner_model", None) or getattr(obj, "model", None)
        if obj is None:
            break
    return None


def _sampler(model, x, sigmas, *, lc_wrapped, lc_amount, lc_start, lc_end, lc_peak, lc_mode="auto", **kwargs):
    ms = _find_ms(model)
    flow = _is_flow(ms) if ms is not None else float(sigmas.max()) <= 1.0001

    def model_wrapper(x, sigma, **extra_args):
        return _call(model, x, sigma, flow, lc_amount, lc_start, lc_end, lc_peak, lc_mode, **extra_args)

    for k in ("inner_model", "sigmas"):
        if hasattr(model, k):
            setattr(model_wrapper, k, getattr(model, k))
    return lc_wrapped.sampler_function(model_wrapper, x, sigmas, **kwargs, **lc_wrapped.extra_options)


DD_TIP = ("Tested (2026-10-01): Krea 2 Turbo 0.05-0.10 (breaks into blocks above about 0.2), Krea 2 Raw: leave it off, "
          "Z-Image 0.05-0.15, Illustrious 0.05-0.10, SDXL 0.05 (0.05 max with res_2s / heun / dpmpp_sde, they apply it twice per "
          "step), Flux 2 Klein: little effect at 4 steps. With a sampler that adds its own noise (dpmpp_2m_sde, euler_ancestral, "
          "er_sde, res_* / ClownSampler with eta): halve it, or it leaves pepper specks.")


def _inputs(first):
    return {
        "required": {
            **first,
            "amount": ("FLOAT", {"default": 0.05, "min": -0.5, "max": 0.5, "step": 0.005,
                       "tooltip": "How much of the noise is hidden from the model at the peak: 0.05 = 5% (subtle), 0.10 = strong. "
                                  "Negative = smoother. Same effect at any CFG.\n" + DD_TIP}),
            "start": ("FLOAT", {"default": 0.2, "min": 0.0, "max": 1.0, "step": 0.01,
                      "tooltip": "When it begins: how far along the image is (0 = pure noise, 1 = finished). Early = changes shapes too."}),
            "end": ("FLOAT", {"default": 0.8, "min": 0.0, "max": 1.0, "step": 0.01,
                    "tooltip": "When it ends. The last steps are best left alone, or noise can stay in the image."}),
            "peak": ("FLOAT", {"default": 0.5, "min": 0.0, "max": 1.0, "step": 0.05,
                     "tooltip": "Where in the window it is strongest: 0 = right at start, 1 = right at end."}),
            "mode": (MODES, {"default": "auto",
                     "tooltip": "auto = the right one for the model (positive amount = more detail on every model). "
                                "classic = Detail Daemon: the model is told less noise and removes less (SDXL-type models). "
                                "look only = the model is told less noise, but the real amount is removed (flow models: Krea 2, Flux)."}),
        },
        "optional": {
            "sigmas": ("SIGMAS", {"tooltip": "Optional, for the graph only: shows where your steps land (e.g. LC Sigmas' sigmas_full)."}),
        },
    }


def _ui(amount, start, end, peak, sigmas, tip=""):
    steps = []
    if sigmas is not None and len(sigmas):
        flow = float(sigmas.max()) <= 1.0001
        steps = [_progress(float(s), flow) for s in sigmas[:-1]]
    return {"lc_detail_daemon": [json.dumps({"amount": amount, "start": start, "end": end, "peak": peak, "steps": steps, "tip": tip})]}


class LCDetailDaemon:
    @classmethod
    def INPUT_TYPES(cls):
        return _inputs({"sampler": ("SAMPLER", {"tooltip": "From KSamplerSelect (or any SAMPLER)."})})

    RETURN_TYPES = ("SAMPLER",)
    FUNCTION = "go"
    CATEGORY = "LC123/sampling"
    DESCRIPTION = ("Adds fine detail by hiding a little of the noise from the model in a window of the render. "
                   "amount is a plain % (no CFG maths); start / end are how far along the image is.")

    def go(self, sampler, amount, start, end, peak, mode="auto", sigmas=None):
        s = KSAMPLER(_sampler, extra_options={"lc_wrapped": sampler, "lc_amount": float(amount), "lc_start": float(start),
                                              "lc_end": float(end), "lc_peak": float(peak), "lc_mode": mode},
                     inpaint_options=getattr(sampler, "inpaint_options", {}))
        return {"ui": _ui(amount, start, end, peak, sigmas), "result": (s,)}


class LCDetailDaemonModel:
    @classmethod
    def INPUT_TYPES(cls):
        return _inputs({"model": ("MODEL", {"tooltip": "The model going into your KSampler."})})

    RETURN_TYPES = ("MODEL",)
    FUNCTION = "go"
    CATEGORY = "LC123/sampling"
    DESCRIPTION = ("Detail Daemon for a plain KSampler: the same as the sampler version, as a model patch. "
                   "Stacks with other model patches.")

    def go(self, model, amount, start, end, peak, mode="auto", sigmas=None):
        m = model.clone()
        flow = _is_flow(model.get_model_object("model_sampling"))
        a, s0, s1, pk = float(amount), float(start), float(end), float(peak)

        def wrapper(executor, x, t, *args, **kwargs):
            return _call(executor, x, t, flow, a, s0, s1, pk, mode, *args, **kwargs)

        m.add_wrapper_with_key(pe.WrappersMP.APPLY_MODEL, "lc_detail_daemon", wrapper)
        from .lc_sigmas import FAMILIES, family

        f = FAMILIES.get(family(model), FAMILIES["eps"])
        return {"ui": _ui(amount, start, end, peak, sigmas, f"Recommended for {f['name']}: {f['dd']}"), "result": (m,)}


NODE_CLASS_MAPPINGS = {"LCDetailDaemon": LCDetailDaemon, "LCDetailDaemonModel": LCDetailDaemonModel}
NODE_DISPLAY_NAME_MAPPINGS = {"LCDetailDaemon": "LC Detail Daemon (BETA)", "LCDetailDaemonModel": "LC Detail Daemon (model) (BETA)"}
