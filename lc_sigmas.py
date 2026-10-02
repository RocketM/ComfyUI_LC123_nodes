"""
LC Sigmas (BETA)
----------------
One scheduler node for one- and two-pass sampling: the noise schedule, the split into a high and a low pass, and the
noise for each pass.

  shape    : the curve's family (Comfy's schedulers). focus bends it: structure (more steps at high noise, the big
             shapes) <-> detail (more steps at low noise, the fine detail).
  shift    : the model's own, auto from the image size (Flux-type models: Krea 2, Flux), or a number.
  denoise  : image to image. How much noise the picture starts with. "keep steps" works like KSampler.
  handoff  : the step where the low pass takes over. The low pass always starts at exactly the noise level where the
             high pass stopped, also with a second model (model_2, its own scale and shift) and its own shape.
  renoise  : the low pass restarts with a bit more noise (0.1 = 10% more), added at the right amount, so a clean
             second model can wash out what the first left (e.g. ControlNet).
  preset   : auto (from model) or a model family fills in the sampler and shape that tested best (sigma research, 2026-10-01:
             3,432 images over Krea 2 Turbo / Raw, Z-Image Turbo, Flux 2 Klein 9B, SDXL, Illustrious). manual = yours.

beta57 and bong_tangent are built in (the same maths as RES4LYF on flow models), so workflows do not depend on
RES4LYF. bong_tangent is worked out as a share of noise, so it is also right on SDXL-type models.

Noise levels are compared as the share of noise in the image (flow models: sigma; SDXL-type: sigma / (1 + sigma)),
which is what makes two different models line up.
"""

from __future__ import annotations

import copy
import json
import math

import torch

import comfy.samplers
from comfy_extras.nodes_custom_sampler import Noise_EmptyNoise, Noise_RandomNoise

DENSE = 1000
SAME = "same as high"
AUTO = "auto (from model)"
NAMED = {"Krea 2": "krea2", "Z-Image": "zimage", "Flux 2": "flux2", "SDXL / Illustrious / Pony": "sdxl"}
PRESETS = [AUTO, *NAMED, "manual"]
LEGACY = "recommended"  # value from the first beta: read as auto

# Research results (2026-10-01). Single-call samplers that add no noise of their own (no SDE / ancestral / RES4LYF
# res_* with eta): user testing on Krealism showed an SDE sampler plus Detail Daemon leaves pepper specks. The first
# pick whose sampler and shape exist is used. Turbo vs Raw and SDXL vs Illustrious share an architecture, so a
# family's pick ranked well on both.
FAMILIES = {
    "krea2": dict(name="Krea 2", picks=[("euler", "beta57")], dd="Turbo 0.05-0.10, Raw: leave it off"),
    "zimage": dict(name="Z-Image", picks=[("uni_pc", "simple")], dd="0.05-0.15"),
    "flux2": dict(name="Flux 2", picks=[("uni_pc", "simple"), ("dpmpp_2m", "sgm_uniform")], dd="little effect at 4 steps"),
    "sdxl": dict(name="SDXL / Illustrious / Pony", picks=[("dpmpp_2m", "karras")], dd="0.05 (Illustrious up to 0.10)"),
    "flow": dict(name="this flow model (not tested)", picks=[("euler", "beta57")], dd="start at 0.05"),
    "eps": dict(name="this model (not tested)", picks=[("dpmpp_2m", "karras")], dd="start at 0.05"),
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


def make_sampler(name: str):
    """A SAMPLER for any Comfy sampler name, or a RES4LYF name (built by RES4LYF's ClownSampler at its own defaults)."""
    if name in comfy.samplers.KSampler.SAMPLERS:
        return comfy.samplers.sampler_object(name)
    full = clown_names().get(name)
    if full is None:
        raise ValueError(f"[LC Sigmas] Unknown sampler: {name}")
    out = _clown_node().execute(sampler_name=full)
    return (getattr(out, "result", None) or out)[0]


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
SHIFTS = ["model", "auto (image size)", "custom"]
_PREVIEW = {}  # node id -> (model_sampling 1, model_sampling 2, latent size) from the last run, for the live graph


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
    """A copy of the model's sampling with another shift, and a short label."""
    import comfy.model_sampling as m

    own = getattr(ms, "shift", None)
    if mode == "model" or own is None:
        return ms, (f"shift {own:g}" if own is not None else "")
    if mode == "custom":
        new = float(value)
    else:  # auto: Flux's rule (ModelSamplingFlux node) from the image's token count
        if not isinstance(ms, m.ModelSamplingFlux) or not size:
            return ms, f"shift {own:g} (auto needs a Flux-type model and a latent)"
        tokens = (size[0] * size[1]) / 256.0  # (w/16) * (h/16)
        new = 0.5 + (1.15 - 0.5) * (tokens - 256.0) / (4096.0 - 256.0)
    ms2 = copy.deepcopy(ms)
    ms2.set_parameters(shift=new)
    return ms2, f"shift {new:.3g}" + (" (auto)" if mode != "custom" else "")


# ---------------------------------------------------------------- curves
def _curve(ms, shape, steps, focus):
    """Descending sigmas, steps + 1 values ending in 0. focus bends the curve (0 = Comfy's own)."""
    steps = max(1, int(steps))
    if abs(focus) < 1e-6:
        return _calc(ms, shape, steps)
    dense = _calc(ms, shape, DENSE)
    p = 2.0 ** (-float(focus))  # >1: more steps at high noise (structure), <1: at low noise (detail)
    u = torch.linspace(0, 1, steps + 1) ** p
    return _at(dense, u * (len(dense) - 1))


def _at(dense, pos):
    pos = pos.clamp(0, len(dense) - 1)
    lo = pos.floor().long()
    hi = (lo + 1).clamp(max=len(dense) - 1)
    t = pos - lo.float()
    return dense[lo] * (1 - t) + dense[hi] * t


def _tail(ms, shape, focus, start_sigma, n):
    """n steps of this curve from start_sigma down to 0 (the low pass of another model or shape)."""
    if n <= 0:
        return torch.tensor([start_sigma, 0.0])
    dense = _curve(ms, shape, DENSE, focus)
    rev = dense.flip(0)  # ascending
    i = int(torch.searchsorted(rev, torch.tensor(float(start_sigma))).item())
    i = min(max(i, 1), len(rev) - 1)
    a, b = float(rev[i - 1]), float(rev[i])
    frac = 0.0 if b == a else (float(start_sigma) - a) / (b - a)
    pos0 = (len(dense) - 1) - (i - 1 + frac)  # position in the descending curve
    out = _at(dense, torch.linspace(pos0, len(dense) - 1, n + 1))
    out[0], out[-1] = float(start_sigma), 0.0
    return out


class _ScaledNoise(Noise_RandomNoise):
    """Seeded noise times a factor: tops a half-denoised latent up to a higher noise level exactly."""

    def __init__(self, seed, scale):
        super().__init__(seed)
        self.scale = float(scale)

    def generate_noise(self, input_latent):
        return super().generate_noise(input_latent) * self.scale


# ---------------------------------------------------------------- the plan (shared by the node and the live graph)
def plan(ms1, ms2, size, steps, handoff, shape, focus, shift, shift_value, denoise, i2i, shape_2, renoise, seed=0):
    ms1s, shift_txt = _shifted(ms1, shift, shift_value, size)
    steps = max(1, int(steps))
    denoise = float(denoise)
    if denoise < 1.0:
        if i2i == "keep steps":
            total = max(steps, int(round(steps / max(denoise, 1e-3))))
            full = _curve(ms1s, shape, total, focus)[-(steps + 1):]
        else:
            full = _curve(ms1s, shape, steps, focus)
            full = full[-(max(1, int(steps * denoise)) + 1):]
    else:
        full = _curve(ms1s, shape, steps, focus)
    n = len(full) - 1
    k = int(handoff)
    split = 0 < k < n
    second = ms2 if ms2 is not None else ms1s
    if not split:
        high, low = full.clone(), full[-1:].clone()
        f_h = f_2 = 0.0
    else:
        high = full[:k + 1].clone()
        f_h = _share(ms1s, float(high[-1]))
        f_2 = min(1.0, f_h * (1.0 + max(0.0, float(renoise))))
        if ms2 is None and shape_2 == SAME and f_2 == f_h:
            low = full[k:].clone()  # same curve: an exact slice
        else:
            low = _tail(second, shape if shape_2 == SAME else shape_2, focus, _from_share(second, f_2), n - k)
    noise_low = Noise_EmptyNoise()
    if split and f_2 > f_h + 1e-6:
        e_h, e_2 = _eps(f_h), _eps(f_2)
        noise_low = _ScaledNoise(int(seed) + 1, math.sqrt(max(0.0, e_2 * e_2 - e_h * e_h)) / e_2)
    start = _share(ms1s, float(full[0]))
    info = [f"{n} steps" + (f" ({k} high + {n - k} low)" if split else ""), f"starts at {start * 100:.0f}% noise"]
    if split:
        info.append(f"handoff at {f_h * 100:.0f}% noise" + (f", low restarts at {f_2 * 100:.0f}%" if f_2 > f_h + 1e-6 else ""))
    if shift_txt:
        info.append(shift_txt)
    graph = {
        "high": [_share(ms1s, float(s)) for s in high],
        "low": [_share(second, float(s)) for s in low] if split else [],
        "ghost": [_share(ms1, float(s)) for s in _calc(ms1, "simple", n)],
        "k": k if split else n, "n": n, "info": " · ".join(info),
    }
    return high, low, noise_low, full, " · ".join(info), graph


class LCSigmas:
    @classmethod
    def INPUT_TYPES(cls):
        _register_shapes()
        shapes = list(comfy.samplers.SCHEDULER_NAMES)
        return {
            "required": {
                "model": ("MODEL", {"tooltip": "The high-pass model. Its noise range and shift set the schedule."}),
                "preset": (PRESETS, {"default": AUTO,
                           "tooltip": "Fills in the sampler and shape that tested best. auto = for the model you load (written into the "
                                      "widgets when it runs). A family name fills them in right away. manual = your own: touching shape or "
                                      "sampler switches to manual."}),
                "steps": ("INT", {"default": 20, "min": 1, "max": 1000, "tooltip": "Total steps, both passes together."}),
                "handoff": ("INT", {"default": 0, "min": 0, "max": 1000,
                            "tooltip": "The step where the low pass takes over. 0 (or steps or more) = one pass: use sigmas_high."}),
                "shape": (shapes, {"default": "beta57" if "beta57" in shapes else "simple",
                          "tooltip": "The curve's family. Filled in by the preset; changing it switches the preset to manual. Tested: on flow models (Krea 2, Z-Image, Flux 2) beta, beta57 and "
                                     "simple are safe; karras, kl_optimal and linear_quadratic burn. SDXL takes almost anything."}),
                "sampler": (list(comfy.samplers.KSampler.SAMPLERS) + [n for n in dict.fromkeys(clown_names().values())
                                                                      if n not in comfy.samplers.KSampler.SAMPLERS],
                            {"default": "euler",
                             "tooltip": "For the sampler output. Filled in by the preset; changing it switches the preset to manual. "
                                        "With RES4LYF installed its samplers are listed too (folder/name), and a ClownSampler "
                                        "Selector can be wired in here. A RES4LYF sampler always wins over the preset's pick and "
                                        "runs at ClownSampler's defaults (eta 0.5 adds noise: halve Detail Daemon). For eta and "
                                        "the other Clown options, wire a ClownSampler into your sampler node instead."}),
                "focus": ("FLOAT", {"default": 0.0, "min": -1.0, "max": 1.0, "step": 0.05,
                          "tooltip": "Where the steps go. Negative = structure (more steps at high noise: composition). Positive = detail "
                                     "(more steps at low noise: texture). A creative control: in testing it changed the look but did not "
                                     "make the best combos better. 0 = the shape as made."}),
                "shift": (SHIFTS, {"default": "model",
                          "tooltip": "model = the model's own shift. auto = from the image size (Flux-type models: Krea 2, Flux; needs a latent). "
                                     "custom = shift_value. Higher shift = more time at high noise."}),
                "shift_value": ("FLOAT", {"default": 1.15, "min": 0.0, "max": 20.0, "step": 0.05, "tooltip": "Used when shift is custom."}),
                "denoise": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01,
                            "tooltip": "Image to image: how much noise the picture starts with. 1 = text to image."}),
                "i2i_steps": (["keep steps", "fewer steps"], {"default": "keep steps",
                              "tooltip": "keep steps = like KSampler: denoise 0.5 still runs all your steps (finer). "
                                         "fewer steps = only the matching part of the schedule runs."}),
                "shape_2": ([SAME] + shapes, {"default": SAME, "tooltip": "The low pass's curve. Starts where the high pass stopped."}),
                "renoise": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 1.0, "step": 0.01,
                            "tooltip": "The low pass restarts with this much more noise (0.1 = 10% more), so it can clean up what "
                                       "the high pass left (e.g. ControlNet). Use noise_low on the low sampler."}),
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xFFFFFFFFFFFFFFFF, "control_after_generate": True,
                         "tooltip": "Seed for noise_high (noise_low uses seed + 1)."}),
            },
            "optional": {
                "model_2": ("MODEL", {"tooltip": "The low-pass model, if different (e.g. without ControlNet). Its own schedule, lined up."}),
                "auto_shift_latent": ("LATENT", {"tooltip": "Only used when shift = auto: the empty latent, so the shift can follow the "
                                                    "image size (Flux rule, Krea 2 / Flux models). Ignored otherwise."}),
            },
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    RETURN_TYPES = ("SIGMAS", "SIGMAS", "NOISE", "NOISE", "STRING", "SIGMAS", "SAMPLER")
    RETURN_NAMES = ("sigmas_high", "sigmas_low", "noise_high", "noise_low", "info", "sigmas_full", "sampler")
    OUTPUT_TOOLTIPS = ("High pass (or the only pass).", "Low pass: starts exactly where the high pass stopped.",
                       "Seeded noise for the high sampler.", "For the low sampler: none, or the renoise top-up.",
                       "What the schedule does, in words.", "The whole high-model schedule, unsplit.",
                       "The recommended (or chosen) sampler, for SamplerCustomAdvanced.")
    FUNCTION = "build"
    CATEGORY = "LC123/sampling"

    @classmethod
    def VALIDATE_INPUTS(cls, preset, sampler):
        # the first beta saved "recommended" in both: still accepted (read as auto)
        ok_preset = preset in PRESETS or preset == LEGACY
        # a wired sampler (e.g. a Clown Sampler Selector) arrives as None here; its name is checked when the node runs
        ok_sampler = sampler is None or sampler in comfy.samplers.KSampler.SAMPLERS or sampler == LEGACY or sampler in clown_names()
        return True if ok_preset and ok_sampler else f"Unknown preset or sampler: {preset} / {sampler}"

    DESCRIPTION = ("One scheduler for one- and two-pass sampling. The preset fills in the sampler and shape that tested best "
                   "for your model. Also: focus (structure <-> detail), shift, image-to-image denoise, the high / low split with an "
                   "optional second model, renoise, and the noise and sampler for each pass.")

    def build(self, model, preset, steps, handoff, shape, sampler, focus, shift, shift_value, denoise, i2i_steps, shape_2,
              renoise, seed, model_2=None, auto_shift_latent=None, unique_id=None):
        ms1 = model.get_model_object("model_sampling")
        ms2 = model_2.get_model_object("model_sampling") if model_2 is not None else None
        size = None
        if auto_shift_latent is not None:
            s = auto_shift_latent["samples"].shape
            size = (int(s[-1]) * 8, int(s[-2]) * 8)
        fam = family(model)
        g = _describe(fam, preset, shape, sampler)
        high, low, noise_low, full, info, graph = plan(ms1, ms2, size, steps, handoff, g["shape"], focus, shift, shift_value,
                                                       denoise, i2i_steps, shape_2, renoise, seed)
        info = f"{g['sampler']} + {g['shape']} · {info}"
        graph.update(info=info, tip=g["tip"], used={"sampler": g["sampler"], "shape": g["shape"]})
        if unique_id is not None:
            _PREVIEW[str(unique_id)] = (ms1, ms2, size, fam)
        return {"ui": {"lc_sigmas": [json.dumps(graph)]},
                "result": (high, low, Noise_RandomNoise(int(seed)), noise_low, info, full,
                           make_sampler(g["sampler"]))}


def _describe(fam, preset, shape, sampler):
    """The sampler and shape to use. A family preset uses its pick, auto the loaded model's, manual the widgets."""
    if preset == LEGACY:
        preset = AUTO
    rec_sampler, rec_shape, f = recommended(NAMED.get(preset, fam))
    if preset == "manual":
        use_sampler = rec_sampler if sampler == LEGACY else sampler
        use_shape = shape
    else:
        use_sampler, use_shape = rec_sampler, rec_shape
        # a RES4LYF name (picked, or wired from a Clown Sampler Selector) is never a preset's pick: it was chosen on purpose
        if sampler not in comfy.samplers.KSampler.SAMPLERS and sampler in clown_names():
            use_sampler = sampler
    tip = f"Tested best for {f['name']}: {rec_sampler} + {rec_shape}. Detail Daemon: {f['dd']}."
    if use_sampler not in comfy.samplers.KSampler.SAMPLERS:
        tip += " RES4LYF sampler at ClownSampler's defaults: eta 0.5 adds noise, so halve Detail Daemon or expect specks."
    elif any(t in use_sampler for t in NOISY):
        tip += " This sampler adds its own noise: halve Detail Daemon or expect specks."
    return {"shape": use_shape, "sampler": use_sampler, "tip": tip}


def preset_table():
    """What each named preset fills in (for the node face)."""
    out = {}
    for name, fam in NAMED.items():
        sampler, shape, _ = recommended(fam)
        out[name] = {"sampler": sampler, "shape": shape}
    return out


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
            d = _describe(fam, b.get("preset", "manual"), b["shape"], b.get("sampler", "euler"))
            g = plan(ms1, ms2, size, b["steps"], b["handoff"], d["shape"], b["focus"], b["shift"], b["shift_value"],
                     b["denoise"], b["i2i_steps"], b["shape_2"], b["renoise"])[5]
            g.update(info=f"{d['sampler']} + {d['shape']} · {g['info']}", tip=d["tip"], used={"sampler": d["sampler"], "shape": d["shape"]})
        except Exception as e:
            return web.json_response({"error": str(e)})
        return web.json_response(g)

    @PromptServer.instance.routes.get("/lc123/sigmas/presets")
    async def _lc_sigmas_presets(request):
        return web.json_response(preset_table())
except Exception:
    pass
