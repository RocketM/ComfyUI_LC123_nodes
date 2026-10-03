"""
LC Sigmas (BETA)
----------------
One scheduler node for one- and two-pass sampling: the noise schedule, the step swap to a second model, and the noise
and sampler for each pass.

  scheduler_shape : how the steps are spread from noisy to clean (Comfy's schedulers, plus our beta57 / bong_tangent).
  step_swap       : the step where the second model takes over. The second pass starts at exactly the noise level where
                    the first stopped, also with a second model (model_2, its own scale and shift) and its own shape.
  denoise         : image to image. denoise_steps: full schedule (the whole run) or at step swap (the first pass
                    only; the second pass then refines on its own).
  low_pass        : continue noise schedule (leftover noise, one schedule over two samplers) or renoise (the first
                    pass finishes, fresh noise goes back up to the swap level, and the second pass refines from there).
  sigma_shift     : use model default, by image size (Flux's rule) or custom.

beta57 and bong_tangent are built in (the same maths as RES4LYF on flow models), so workflows do not depend on RES4LYF.

Noise levels are compared as the share of noise in the image (flow models: sigma; SDXL-type: sigma / (1 + sigma)),
which is what makes two different models line up.
"""

from __future__ import annotations

import copy
import json
import math

import torch

import comfy.model_management
import comfy.samplers
from comfy_extras.nodes_custom_sampler import Noise_EmptyNoise, Noise_RandomNoise

DENSE = 1000
SAME = "same as first"
FULL, AT_SWAP = "full schedule", "at step swap"
DENOISE_STEPS = [FULL, AT_SWAP]
CONTINUE, RENOISE = "continue noise schedule", "renoise"
LOW_PASS = [CONTINUE, RENOISE]
SHIFT_MODEL, SHIFT_SIZE, SHIFT_CUSTOM = "use model default", "by image size", "custom"
SHIFTS = [SHIFT_MODEL, SHIFT_SIZE, SHIFT_CUSTOM]
_PREVIEW = {}  # node id -> (model_sampling 1, model_sampling 2, latent size, family) from the last run, for the live graph

# Research results (2026-10-01). Single-call samplers that add no noise of their own (no SDE / ancestral / RES4LYF
# res_* with eta): user testing on Krealism showed an SDE sampler plus Detail Daemon leaves pepper specks. The first
# pick whose sampler and shape exist is used. Turbo vs Raw and SDXL vs Illustrious share an architecture, so a
# family's pick ranked well on both.
FAMILIES = {
    "krea2": dict(name="Krea 2", picks=[("euler", "beta57")], dd="look only 1.0, start 0.15, end 0.85, peak 0, exponent 0"),
    "zimage": dict(name="Z-Image", picks=[("uni_pc", "simple")], dd="start at 0.5"),
    "flux2": dict(name="Flux 2", picks=[("uni_pc", "simple"), ("dpmpp_2m", "sgm_uniform")], dd="little effect at 4 steps"),
    "sdxl": dict(name="SDXL / Illustrious / Pony", picks=[("dpmpp_2m", "karras")], dd="0.5 (Illustrious up to 1.0)"),
    "flow": dict(name="this flow model (not tested)", picks=[("euler", "beta57")], dd="start at 0.5"),
    "eps": dict(name="this model (not tested)", picks=[("dpmpp_2m", "karras")], dd="start at 0.5"),
}
NOISY = ("_sde", "ancestral", "res_2s", "res_3s", "res_5s", "res_6s", "res_2m", "res_3m", "er_sde", "dpmpp_sde", "dpm_2_a", "lcm")


def family(model) -> str:
    try:
        cfg = model.model.model_config.__class__.__name__
        base = model.model.__class__.__name__
    except Exception:
        return "eps"
    if base == "Krea2":
        return "krea2"
    if cfg.startswith("ZImage"):
        return "zimage"
    if base == "Flux2":
        return "flux2"
    if base in ("SDXL",):
        return "sdxl"
    return "flow" if _is_flow(model.get_model_object("model_sampling")) else "eps"


def recommended(fam):
    f = FAMILIES.get(fam, FAMILIES["eps"])
    for sampler, shape in f["picks"]:
        if sampler in comfy.samplers.KSampler.SAMPLERS and shape in comfy.samplers.SCHEDULER_NAMES:
            return sampler, shape, f
    sampler, shape = f["picks"][-1]
    return (sampler if sampler in comfy.samplers.KSampler.SAMPLERS else "euler"), "simple", f


# ---------------------------------------------------------------- RES4LYF (ClownShark) sampler names
def _clown_node():
    """RES4LYF's ClownSampler node class when RES4LYF is installed, else None."""
    try:
        import nodes
        return nodes.NODE_CLASS_MAPPINGS.get("ClownSampler_Beta")
    except Exception:
        return None


def clown_names() -> dict:
    """{name as typed or as a Clown Sampler Selector sends it: folder/name} for RES4LYF's samplers. Empty without RES4LYF.
    The Selector sends the bare name (radau_iia_3s), the dropdowns use folder/name (fully_implicit/radau_iia_3s)."""
    cls = _clown_node()
    if cls is None:
        return {}
    import sys
    try:
        names = list(sys.modules[cls.__module__].get_sampler_name_list())
    except Exception:
        return {}
    out = {}
    for full in names:
        full = str(full)
        if full in ("none", "use_explicit"):
            continue
        out.setdefault(full, full)
        out.setdefault(full.split("/")[-1], full)
    return out


# ---------------------------------------------------------------- built-in shapes (beta57, bong_tangent)
def _bong_piece(steps, slope, pivot, start, end):
    smax = ((2 / math.pi) * math.atan(-slope * (0 - pivot)) + 1) / 2
    smin = ((2 / math.pi) * math.atan(-slope * ((steps - 1) - pivot)) + 1) / 2
    rng, scale = smax - smin, start - end
    return [((((2 / math.pi) * math.atan(-slope * (x - pivot)) + 1) / 2) - smin) * (1 / rng) * scale + end for x in range(steps)]


def bong_tangent(model_sampling, steps, start=1.0, middle=0.5, end=0.0, pivot_1=0.6, pivot_2=0.6, slope_1=0.2, slope_2=0.2):
    """RES4LYF's bong_tangent (two arctan stages), as a share of noise, then turned into this model's sigmas."""
    steps += 2
    midpoint = int((steps * pivot_1 + steps * pivot_2) / 2)
    p1, p2 = int(steps * pivot_1), int(steps * pivot_2)
    s1, s2 = slope_1 / (steps / 40), slope_2 / (steps / 40)
    n2 = steps - midpoint
    n1 = steps - n2
    shares = _bong_piece(n1, s1, p1, start, middle)[:-1] + _bong_piece(n2, s2, p2 - n1, middle, end)
    if not _is_flow(model_sampling):  # SDXL-type: the top is sigma_max (about 94% noise), not 100%
        top = _share(model_sampling, float(model_sampling.sigma_max))
        shares = [f * top for f in shares]
    return torch.tensor([_from_share(model_sampling, f) for f in shares], dtype=torch.float32)


def beta57(model_sampling, steps):
    return comfy.samplers.beta_scheduler(model_sampling, steps, alpha=0.5, beta=0.7)


def _register_shapes():
    """Add beta57 / bong_tangent to Comfy's scheduler list when nobody has (RES4LYF adds the same names)."""
    for name, fn in (("beta57", beta57), ("bong_tangent", bong_tangent)):
        if name not in comfy.samplers.SCHEDULER_HANDLERS:
            comfy.samplers.SCHEDULER_HANDLERS[name] = comfy.samplers.SchedulerHandler(handler=fn, use_ms=True)
            comfy.samplers.SCHEDULER_NAMES.append(name)


_OURS = {"beta57": beta57, "bong_tangent": bong_tangent}


def _calc(ms, shape, steps):
    """Comfy's scheduler, but our own beta57 / bong_tangent (portable, and bong_tangent right on SDXL too)."""
    fn = _OURS.get(shape)
    out = fn(ms, steps) if fn else comfy.samplers.calculate_sigmas(ms, shape, steps)
    return out.float().cpu()
# ---------------------------------------------------------------- model types and noise share
def _is_flow(ms) -> bool:
    import comfy.model_sampling as m

    return isinstance(ms, (m.ModelSamplingDiscreteFlow, m.ModelSamplingFlux)) or isinstance(ms, getattr(m, "CONST", ()))


def _share(ms, sigma: float) -> float:
    """sigma -> share of noise in the image (0..1)."""
    return float(sigma) if _is_flow(ms) else float(sigma) / (1.0 + float(sigma))


def _from_share(ms, f: float) -> float:
    f = min(max(f, 0.0), 1.0)
    if _is_flow(ms):
        return f
    return min(f / max(1e-6, 1.0 - f), float(ms.sigma_max))


def _eps(f: float) -> float:
    """Noise share -> noise level in "clean image + sigma * noise" units (what a pass hands to the next)."""
    return f / max(1e-6, 1.0 - f)


# ---------------------------------------------------------------- shift
def _shifted(ms, mode, value, size):
    """A copy of the model's sampling with another sigma shift, and a short label."""
    import comfy.model_sampling as m

    own = getattr(ms, "shift", None)
    if own is None:
        return ms, "this model has no sigma shift"
    if mode == SHIFT_MODEL:
        return ms, f"shift {own:g}"
    if mode == SHIFT_CUSTOM:
        new = float(value)
    else:  # by image size: Flux's rule (ModelSamplingFlux node) from the image's token count
        if not isinstance(ms, m.ModelSamplingFlux) or not size:
            return ms, f"shift {own:g} (by image size needs a Krea 2 / Flux model and image_size_latent)"
        tokens = (size[0] * size[1]) / 256.0  # (w/16) * (h/16)
        new = 0.5 + (1.15 - 0.5) * (tokens - 256.0) / (4096.0 - 256.0)
    ms2 = copy.deepcopy(ms)
    ms2.set_parameters(shift=new)
    return ms2, f"shift {new:.3g}" + (" (by image size)" if mode != SHIFT_CUSTOM else f" (model default {own:g})")


# ---------------------------------------------------------------- curves
def _curve(ms, shape, steps):
    """Descending sigmas, steps + 1 values ending in 0."""
    return _calc(ms, shape, max(1, int(steps)))


def _at(dense, pos):
    pos = pos.clamp(0, len(dense) - 1)
    lo = pos.floor().long()
    hi = (lo + 1).clamp(max=len(dense) - 1)
    t = pos - lo.float()
    return dense[lo] * (1 - t) + dense[hi] * t


def _pos(dense, sigma):
    """Where sigma sits in a descending curve (fractional index)."""
    if sigma <= 0:
        return float(len(dense) - 1)
    rev = dense.flip(0)  # ascending
    i = int(torch.searchsorted(rev, torch.tensor(float(sigma))).item())
    i = min(max(i, 1), len(rev) - 1)
    a, b = float(rev[i - 1]), float(rev[i])
    frac = 0.0 if b == a else (float(sigma) - a) / (b - a)
    return (len(dense) - 1) - (i - 1 + frac)


def _segment(ms, shape, s_hi, s_lo, n):
    """n steps of this curve from s_hi down to s_lo (0 = all the way)."""
    if n <= 0:
        return torch.tensor([float(s_hi), float(s_lo)])
    dense = _curve(ms, shape, DENSE)
    out = _at(dense, torch.linspace(_pos(dense, s_hi), _pos(dense, s_lo), n + 1))
    out[0], out[-1] = float(s_hi), float(s_lo)
    return out


def make_sampler(name: str):
    """A SAMPLER for any Comfy sampler name, or a RES4LYF name (built by RES4LYF's ClownSampler at its own defaults)."""
    if name in comfy.samplers.KSampler.SAMPLERS:
        return comfy.samplers.sampler_object(name)
    full = clown_names().get(name)
    if full is None:
        raise ValueError(f"[LC Sigmas] Unknown sampler: {name}")
    out = _clown_node().execute(sampler_name=full)
    return (getattr(out, "result", None) or out)[0]


# ---------------------------------------------------------------- the plan (shared by the node and the live graph)
def plan(ms1, ms2, size, steps, step_swap, shape, shape_2, sigma_shift, custom_shift, denoise, denoise_steps,
         low_pass, seed=0):
    ms1s, shift_txt = _shifted(ms1, sigma_shift, custom_shift, size)
    second = ms2 if ms2 is not None else ms1s
    shape_lo = shape if shape_2 == SAME else shape_2
    steps = max(1, int(steps))
    k = int(step_swap)
    split = 0 < k < steps
    d = min(max(float(denoise), 0.0), 1.0)
    img = d < 1.0
    notes = []

    ref = _curve(ms1s, shape, steps)  # the text-to-image schedule
    skip_high = False
    if img and denoise_steps == AT_SWAP and split:
        # denoise covers the first pass only: it starts at the denoise level and stops where the schedule swaps
        run = ref
        swap_sigma = float(ref[k])
        s_start = float(_curve(ms1s, shape, max(steps, int(round(steps / max(d, 1e-3)))))[-(steps + 1)])  # as KSampler counts
        if _share(ms1s, s_start) <= _share(ms1s, swap_sigma) + 1e-6:
            skip_high = True
            notes.append("denoise is below the step swap: only the second pass runs")
            low_from = s_start
            high_down = torch.tensor([s_start, s_start])
        else:
            high_down = _segment(ms1s, shape, s_start, swap_sigma, k)
            low_from = swap_sigma
    else:
        if img:  # full schedule: all your steps run, spread from the denoise level down (like KSampler)
            total = max(steps, int(round(steps / max(d, 1e-3))))
            run = _curve(ms1s, shape, total)[-(steps + 1):]
        else:
            run = ref
        high_down = run[:k + 1] if split else run
        low_from = float(run[k]) if split else 0.0

    mode = low_pass
    if skip_high and mode == CONTINUE:
        mode = RENOISE  # nothing was left over: the picture has to get its noise somewhere
    noise_high, noise_low = Noise_RandomNoise(int(seed)), Noise_EmptyNoise()

    if skip_high:
        high = torch.zeros(0)  # empty: SamplerCustomAdvanced passes the picture through untouched, with any sampler
    else:
        high = high_down.clone()
        if split and mode == RENOISE:
            high = torch.cat([high, torch.tensor([0.0])])  # the first pass finishes the picture

    if split:
        n_low = steps - k
        if ms2 is None and shape_2 == SAME and not skip_high and len(run) == steps + 1 and abs(float(run[k]) - low_from) < 1e-9:
            low_down = run[k:].clone()  # same curve: an exact slice
        else:
            low_down = _segment(second, shape_lo, _from_share(second, _share(ms1s, low_from)), 0.0, n_low)
        low = low_down
        if mode == RENOISE:
            noise_low = Noise_RandomNoise(int(seed) + 1)
    else:
        # one pass: the second sampler gets no sigmas, so it hands the picture on untouched. Not [0.0]: RES4LYF reads a
        # schedule starting at 0 as an unsample flag, strips it and fails on what is left
        low_down = torch.zeros(0)
        low = low_down

    start_share = _share(ms1s, float(high_down[0]))
    info = [f"{steps} steps" + (f" ({k} first + {steps - k} second)" if split else ""),
            f"starts at {start_share * 100:.0f}% noise"]
    if split:
        lvl = f"{_share(ms1s, low_from) * 100:.0f}%"
        info.append({CONTINUE: f"second pass continues at {lvl}", RENOISE: f"second pass: renoise to {lvl}"}[mode])
    if shift_txt:
        info.append(shift_txt)
    info += notes
    graph = {
        "high": [] if skip_high else [_share(ms1s, float(s)) for s in high_down],
        "finish": bool(split and mode == RENOISE and not skip_high),
        "low": [_share(second, float(s)) for s in low_down] if split else [],
        "low_mode": mode if split else "",
        "ghost": [_share(ms1, float(s)) for s in _calc(ms1, "simple", steps)],
        "k": k if split else steps, "n": steps, "info": " · ".join(info),
    }
    return high, low, noise_high, noise_low, run, " · ".join(info), graph


def _tip(fam, sampler, shape):
    rec_sampler, rec_shape, f = recommended(fam)
    tip = f"Tested best for {f['name']}: {rec_sampler} + {rec_shape}. Detail Daemon: {f['dd']}."
    if sampler not in comfy.samplers.KSampler.SAMPLERS:
        tip += " RES4LYF sampler at ClownSampler's defaults: eta 0.5 adds noise, so halve Detail Daemon or expect specks."
    elif any(t in sampler for t in NOISY):
        tip += " This sampler adds its own noise: halve Detail Daemon or expect specks."
    return tip


class LCSigmas:
    @classmethod
    def INPUT_TYPES(cls):
        _register_shapes()
        shapes = list(comfy.samplers.SCHEDULER_NAMES)
        samplers = list(comfy.samplers.KSampler.SAMPLERS) + [n for n in dict.fromkeys(clown_names().values())
                                                             if n not in comfy.samplers.KSampler.SAMPLERS]
        return {
            "required": {
                "model": ("MODEL", {"tooltip": "The first pass's model. Its noise range and sigma shift set the schedule."}),
                "sampler": (samplers, {"default": "euler",
                            "tooltip": "The sampler both passes use (the sampler output). With RES4LYF installed its samplers are "
                                       "listed too, and a ClownSampler Selector can be wired in. The line under the graph shows "
                                       "what tested best for your model."}),
                "scheduler_shape": (shapes, {"default": "beta57" if "beta57" in shapes else "simple",
                                    "tooltip": "How the steps are spread from noisy to clean. Flow models (Krea 2, Z-Image, Flux 2): "
                                               "beta, beta57 and simple are safe; karras, kl_optimal and linear_quadratic burn."}),
                "steps": ("INT", {"default": 20, "min": 1, "max": 1000, "tooltip": "Total steps, both passes together."}),
                "step_swap": ("INT", {"default": 0, "min": 0, "max": 1000,
                              "tooltip": "The step where the second model (model_2) takes over. 0 = one pass only."}),
                "denoise": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01,
                            "tooltip": "How much of your input image gets redrawn. 1 = a new image from scratch (text to image)."}),
                "denoise_steps": (DENOISE_STEPS, {"default": FULL,
                                  "tooltip": "full schedule = denoise covers the whole run; the second pass just carries on. "
                                             "at step swap = denoise covers the first pass only; the second pass refines on its own."}),
                "low_pass": (LOW_PASS, {"default": CONTINUE,
                             "tooltip": "What the second pass does at the step swap. continue noise schedule = it takes the "
                                        "leftover noise and finishes the job (one schedule over two samplers). renoise = the first "
                                        "pass finishes the picture, then fresh noise goes back up to the swap point's level, so the "
                                        "second pass has something to refine, like a detailer. The step swap sets how much noise it "
                                        "gets: late = a little (clean-up), earlier = more (heavier refining)."}),
                "scheduler_shape_2": ([SAME] + shapes, {"default": SAME, "tooltip": "The second pass's spread of steps."}),
                "sigma_shift": (SHIFTS, {"default": SHIFT_MODEL,
                                "tooltip": "Bends the schedule without changing the step count. Higher = more steps on composition "
                                           "(the noisy start), lower = more on detail. use model default = what the model was "
                                           "trained with (leave it). by image size = Flux's rule, bigger images get more (needs "
                                           "image_size_latent). custom = custom_shift. SDXL-type models have no shift."}),
                "custom_shift": ("FLOAT", {"default": 1.15, "min": 0.0, "max": 20.0, "step": 0.05,
                                 "tooltip": "The model's own shift number. Krea 2 / Flux: 0.5 small images, 1.15 = Krea 2 Turbo's "
                                            "default, 2+ = strongly composition-heavy. Z-Image / AuraFlow-type: 1 = none, about "
                                            "3 = their default."}),
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xFFFFFFFFFFFFFFFF, "control_after_generate": True,
                         "tooltip": "Seed for noise_high (noise_low uses seed + 1)."}),
            },
            "optional": {
                "model_2": ("MODEL", {"tooltip": "The second pass's model, if different (e.g. without ControlNet). Its own schedule, lined up."}),
                "image_size_latent": ("LATENT", {"tooltip": "Only for sigma_shift = by image size: the empty latent, so the shift "
                                                            "can follow the image size."}),
            },
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    RETURN_TYPES = ("SIGMAS", "SIGMAS", "NOISE", "NOISE", "STRING", "SIGMAS", "SAMPLER")
    RETURN_NAMES = ("sigmas_high", "sigmas_low", "noise_high", "noise_low", "info", "sigmas_full", "sampler")
    OUTPUT_TOOLTIPS = ("First pass (or the only pass).", "Second pass, from the step swap.",
                       "Noise for the first sampler.", "Noise for the second sampler (none when it continues the schedule).",
                       "What the schedule does, in words.", "The whole first-model schedule, unsplit.",
                       "The chosen sampler, for SamplerCustomAdvanced.")
    FUNCTION = "build"
    CATEGORY = "LC123/sampling"
    DESCRIPTION = ("One scheduler for one- and two-pass sampling: the noise schedule, the step swap to a second model, "
                   "image-to-image denoise, what the second pass does (continue the schedule or renoise and refine), "
                   "and the noise and sampler for each pass.")

    @classmethod
    def VALIDATE_INPUTS(cls, sampler):
        # a wired sampler (e.g. a Clown Sampler Selector) arrives as None here; its name is checked when the node runs
        ok = sampler is None or sampler in comfy.samplers.KSampler.SAMPLERS or sampler in clown_names()
        return True if ok else f"Unknown sampler: {sampler}"

    def build(self, model, sampler, scheduler_shape, steps, step_swap, denoise, denoise_steps, low_pass,
              scheduler_shape_2, sigma_shift, custom_shift, seed, model_2=None, image_size_latent=None, unique_id=None):
        ms1 = model.get_model_object("model_sampling")
        ms2 = model_2.get_model_object("model_sampling") if model_2 is not None else None
        size = None
        if image_size_latent is not None:
            s = image_size_latent["samples"].shape
            size = (int(s[-1]) * 8, int(s[-2]) * 8)
        fam = family(model)
        high, low, noise_high, noise_low, full, info, graph = plan(
            ms1, ms2, size, steps, step_swap, scheduler_shape, scheduler_shape_2, sigma_shift, custom_shift, denoise,
            denoise_steps, low_pass, seed)
        info = f"{sampler} + {scheduler_shape} · {info}"
        graph.update(info=info, tip=_tip(fam, sampler, scheduler_shape))
        if unique_id is not None:
            _PREVIEW[str(unique_id)] = (ms1, ms2, size, fam)
        return {"ui": {"lc_sigmas": [json.dumps(graph)]},
                "result": (high, low, noise_high, noise_low, info, full, make_sampler(sampler))}


_register_shapes()
NODE_CLASS_MAPPINGS = {"LCSigmas": LCSigmas}
NODE_DISPLAY_NAME_MAPPINGS = {"LCSigmas": "LC Sigmas (BETA)"}

try:
    from aiohttp import web
    from server import PromptServer

    @PromptServer.instance.routes.post("/lc123/sigmas/preview")
    async def _lc_sigmas_preview(request):
        b = await request.json()
        got = _PREVIEW.get(str(b.get("node")))
        if not got:
            return web.json_response({"error": "run once"})
        ms1, ms2, size, fam = got
        try:
            g = plan(ms1, ms2, size, b["steps"], b["step_swap"], b["scheduler_shape"], b["scheduler_shape_2"], b["sigma_shift"],
                     b["custom_shift"], b["denoise"], b["denoise_steps"], b["low_pass"])[6]
            g.update(info=f"{b.get('sampler') or ''} + {b['scheduler_shape']} · {g['info']}",
                     tip=_tip(fam, b.get("sampler") or "euler", b["scheduler_shape"]))
        except Exception as e:
            return web.json_response({"error": str(e)})
        return web.json_response(g)
except Exception:
    pass
