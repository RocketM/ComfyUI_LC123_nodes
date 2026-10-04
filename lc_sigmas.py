"""
LC Sigmas (BETA)
----------------
One scheduler node for one- and two-pass sampling: the noise schedule, the step swap to a second model, and the noise
and sampler for each pass.

  sigma_curve_presets  : the curve the steps follow, from noisy to clean:
                      base       = a Comfy scheduler (base_scheduler, plus our beta57 / bong_tangent)
                      beta       = Comfy's beta scheduler with your own alpha / beta
                      flowmatch  = the FlowMatch Euler Discrete curve (shift, dynamic shifting, terminal)
                      hyperbolic = the base schedule bent by sinh / cosh / tanh ... (same maths as RES4LYF's Sigmas Hyperbolic)
                      gaussian   = the base schedule bent by pdf / cdf / modulate ... (same maths as RES4LYF's Sigmas Gaussian)
                      saved: ... = a curve you saved from this node or from LC Sigma Curve
  curve edits     : drag the points on the graph to bend the chosen schedule. The edit sits on top of the schedule
                    (reset curve clears it) and follows the steps when you change them.
  first_pass_resample : spreads the first pass over more (or fewer) steps along the same path (LC Sigma Resample).
  step_swap       : the step where the second model takes over. The second pass starts at exactly the noise level where
                    the first stopped, also with a second model (model_2, its own scale and shift) and its own shape.
  denoise         : image to image. denoise_steps: full schedule (the whole run) or at step swap (the first pass
                    only; the second pass then refines on its own).
  low_pass        : continue noise schedule (leftover noise, one schedule over two samplers) or renoise (the first
                    pass finishes, fresh noise goes back up to the swap level, and the second pass refines from there).
  sigma_shift     : use model default, by image size (Flux's rule) or custom.

beta57, bong_tangent, hyperbolic and gaussian are built in (the same maths as RES4LYF), and flowmatch is the diffusers
FlowMatchEulerDiscreteScheduler curve (as in erosDiffusion's FlowMatch node, MIT), so workflows depend on neither.

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
SCHEDULES = ["base", "beta", "flowmatch", "hyperbolic", "gaussian"]
SAVED = "saved: "
HYPER_FUNCS = ["sinh", "cosh", "tanh", "asinh", "acosh", "atanh"]
GAUSS_OPS = ["pdf", "cdf", "inverse_cdf", "transform", "modulate"]
EDIT_MODES = ["smooth", "spike"]
GAP = 1e-4  # smallest drop between two steps of an edited curve (share of noise)
_PREVIEW = {}  # node id -> (model_sampling 1, model_sampling 2, latent size, family, the values it ran with) for the live graph

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


# Research results (2026-10-03): the picks above were tested at each model's own shift (Krea 2: 1.15). With a much
# higher shift (ModelSamplingAuraFlow at 4 in front of Krea 2 / Krealism), beta57 crowds the last steps into very low
# noise: a Turbo-based model draws grain there, and Detail Daemon turns it into crunchy skin and inked-looking eyes.
# simple (or gaussian on simple) stays photographic at that shift.
HIGH_SHIFT = 2.0
CROWDS_LOW_END = ("beta57", "beta", "bong_tangent", "karras", "exponential", "kl_optimal")


def model_shift(ms):
    v = getattr(ms, "shift", None)
    try:
        return float(v) if v is not None else None
    except (TypeError, ValueError):
        return None


def recommended(fam, shift=None):
    f = FAMILIES.get(fam, FAMILIES["eps"])
    if fam in ("krea2", "flow") and shift is not None and shift > HIGH_SHIFT and "euler" in comfy.samplers.KSampler.SAMPLERS:
        return "euler", "simple", f
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


# ---------------------------------------------------------------- schedule presets
def _renorm(r, sig):
    """Stretch r back onto the range of sig (RES4LYF's normalize_output)."""
    span = float(r.max() - r.min())
    if span <= 0 or not math.isfinite(span):
        return sig.clone()
    return (r - r.min()) / span * (sig.max() - sig.min()) + sig.min()


def _hyperbolic(sig, function, scale):
    x = sig * float(scale)
    r = {"sinh": torch.sinh, "cosh": torch.cosh, "tanh": torch.tanh, "asinh": torch.asinh,
         "acosh": lambda v: torch.acosh(v.clamp(min=1.0)), "atanh": lambda v: torch.atanh(v.clamp(-0.99, 0.99))}[function](x)
    return _renorm(r, sig)


def _gaussian(sig, mean, std, operation):
    mean, std = float(mean), max(float(std), 1e-6)
    if operation == "pdf":
        r = (1 / (std * math.sqrt(2 * math.pi))) * torch.exp(-0.5 * ((sig - mean) / std) ** 2)
    elif operation == "cdf":
        r = 0.5 * (1 + torch.erf((sig - mean) / (std * math.sqrt(2))))
    elif operation == "inverse_cdf":
        n = (sig - sig.min()) / (sig.max() - sig.min()).clamp_min(1e-12) * 0.98 + 0.01
        r = mean + std * math.sqrt(2) * torch.erfinv(2 * n - 1)
    elif operation == "transform":
        r = (sig - sig.mean()) / sig.std().clamp_min(1e-12) * std + mean
    else:  # modulate
        r = sig * torch.exp(-0.5 * ((sig - mean) / std) ** 2)
    return _renorm(r, sig)


def _flowmatch(steps, shift, dynamic, terminal, train=1000):
    """diffusers FlowMatchEulerDiscreteScheduler.set_timesteps(steps, mu=0) as a share of noise, ending in 0."""
    import numpy as np

    def sh(v):
        return shift * v / (1 + (shift - 1) * v)

    s_min = 1.0 / train if dynamic else sh(1.0 / train)
    t = np.linspace(1.0 * train, s_min * train, int(steps)) / train
    s = t if dynamic else sh(t)  # dynamic shifting with mu = 0 leaves the curve as it is
    if terminal and terminal > 0:
        omz = 1.0 - s
        s = 1.0 - omz / (omz[-1] / (1.0 - terminal))
    return [float(v) for v in s] + [0.0]


def _lerp(vals, n):
    """vals resampled to n + 1 points along the same path (endpoints kept)."""
    if len(vals) < 2:
        return [vals[0] if vals else 0.0] * (n + 1)
    out = []
    for i in range(n + 1):
        pos = (len(vals) - 1) * i / max(n, 1)
        j = min(int(pos), len(vals) - 2)
        f = pos - j
        out.append(vals[j] * (1 - f) + vals[j + 1] * f)
    return out


def _saved_shares(name):
    try:
        from .lc_sigma_curve import _load_saved
    except Exception:
        return None
    vals = _load_saved(name)
    if not vals or len(vals) < 2:
        return None
    if max(vals) <= 1.0001:  # flow units (LC Sigma Curve's default top of 1): already a share of noise
        return [max(0.0, float(v)) for v in vals]
    return [float(v) / (1.0 + float(v)) for v in vals]  # SDXL-type sigmas


def saved_names():
    try:
        from .lc_sigma_curve import _list_saved
        return [SAVED + n for n in _list_saved()]
    except Exception:
        return []


def _from_shares(ms, shares):
    if not _is_flow(ms):  # SDXL-type: the top is sigma_max (about 94% noise), not 100%
        top = _share(ms, float(ms.sigma_max))
        shares = [f * top for f in shares]
    return torch.tensor([_from_share(ms, f) for f in shares], dtype=torch.float32)


def _preset(ms, spec, steps):
    sch = spec.get("schedule", "base")
    if sch == "beta":
        out = comfy.samplers.beta_scheduler(ms, steps, alpha=float(spec.get("beta_alpha", 0.6)), beta=float(spec.get("beta_beta", 0.6)))
    elif sch == "flowmatch":
        out = _from_shares(ms, _flowmatch(steps, float(spec.get("flowmatch_shift", 3.0)), bool(spec.get("flowmatch_dynamic", True)),
                                          float(spec.get("flowmatch_terminal", 0.0))))
    elif sch.startswith(SAVED):
        shares = _saved_shares(sch[len(SAVED):])
        if shares is None:
            raise ValueError(f"[LC Sigmas] saved curve not found: {sch[len(SAVED):]}")
        out = _from_shares(ms, _lerp(shares, steps))
    else:
        out = _calc(ms, spec.get("base", "simple"), steps)
        if sch == "hyperbolic":
            out = _hyperbolic(out.float(), spec.get("hyperbolic_function", "tanh"), spec.get("hyperbolic_scale", 1.0))
        elif sch == "gaussian":
            out = _gaussian(out.float(), spec.get("gaussian_mean", 0.04), spec.get("gaussian_std", 1.0),
                            spec.get("gaussian_operation", "modulate"))
    return out.float().cpu()


def parse_edit(text):
    """curve_edit widget -> list of offsets (share of noise) at evenly spaced points along the schedule."""
    if not text:
        return []
    try:
        v = json.loads(text) if isinstance(text, str) else text
        return [float(x) for x in v] if isinstance(v, list) and len(v) >= 2 else []
    except (ValueError, TypeError):
        return []


def _edited(ms, sig, edit):
    """The schedule with your curve edit added (as a share of noise), still running downhill and ending in 0."""
    if not edit or not any(abs(e) > 1e-9 for e in edit):
        return sig
    n = len(sig) - 1
    offs = _lerp(edit, n)
    shares = [_share(ms, float(x)) for x in sig]
    top = 1.0 if _is_flow(ms) else _share(ms, float(ms.sigma_max))
    out, prev = [], top + GAP
    for i, (f, d) in enumerate(zip(shares, offs)):
        # every step a little below the one before: equal noise levels make zero-length steps (NaN in dpmpp-type samplers)
        v = shares[-1] if i == n else max(min(f + d, top, prev - GAP), shares[-1] + (n - i) * GAP)
        out.append(v)
        prev = v
    return torch.tensor([_from_share(ms, f) for f in out], dtype=torch.float32)


# ---------------------------------------------------------------- curves
def _curve(ms, shape, steps):
    """Descending sigmas, steps + 1 values ending in 0. shape = a Comfy scheduler name or a schedule spec (dict)."""
    steps = max(1, int(steps))
    if isinstance(shape, str):
        return _calc(ms, shape, steps)
    return _edited(ms, _preset(ms, shape, steps), shape.get("edit"))


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
    dense = torch.cummin(_curve(ms, shape, DENSE), 0).values
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
         low_pass, seed=0, resample=1.0):
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

    rs = float(resample)
    if not skip_high and abs(rs - 1.0) > 1e-6 and len(high_down) >= 2:
        # the first pass walks the same path in more (or fewer) steps; where it starts and stops stays put
        m = max(1, int(round((len(high_down) - 1) * rs)))
        high_down = torch.tensor(_lerp([float(x) for x in high_down], m), dtype=torch.float32)
        notes.append(f"first pass resampled to {m} steps (x{rs:g})")

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
    if isinstance(shape, dict) and (shape.get("schedule") == "flowmatch" or str(shape.get("schedule", "")).startswith(SAVED)):
        shift_txt = ""  # these curves are fixed shares of noise: the model's shift does not bend them
    if shift_txt:
        info.append(shift_txt)
    info += notes
    kx = k if split else steps
    plain = dict(shape, edit=None) if isinstance(shape, dict) else shape
    graph = {
        "high": [] if skip_high else [_share(ms1s, float(s)) for s in high_down],
        "hx": [] if skip_high else [kx * i / max(1, len(high_down) - 1) for i in range(len(high_down))],
        "base": [_share(ms1s, float(s)) for s in _curve(ms1s, plain, steps)],  # the schedule before your curve edit
        "edited": bool(isinstance(shape, dict) and any(abs(e) > 1e-9 for e in (shape.get("edit") or []))),
        "finish": bool(split and mode == RENOISE and not skip_high),
        "low": [_share(second, float(s)) for s in low_down] if split else [],
        "low_mode": mode if split else "",
        "ghost": [_share(ms1, float(s)) for s in _calc(ms1, "simple", steps)],
        "k": k if split else steps, "n": steps, "info": " · ".join(info),
    }
    return high, low, noise_high, noise_low, run, " · ".join(info), graph


def _tip(fam, sampler, spec, shift=None):
    rec_sampler, rec_shape, f = recommended(fam, shift)
    at = f" at shift {shift:g}" if shift is not None else ""
    tip = f"Tested best for {f['name']}{at}: {rec_sampler} + base {rec_shape}. Detail Daemon: {f['dd']}."
    uses_base = spec.get("schedule") in ("base", "hyperbolic", "gaussian")
    if shift is not None and shift > HIGH_SHIFT and uses_base and spec.get("base") in CROWDS_LOW_END and fam in ("krea2", "flow"):
        tip = (f"{spec.get('base')} at shift {shift:g} gives grain and crunchy skin on {f['name']}: use simple "
               f"(or gaussian on simple). " + tip)
    if sampler not in comfy.samplers.KSampler.SAMPLERS:
        tip += " RES4LYF sampler at ClownSampler's defaults: eta 0.5 adds noise, so halve Detail Daemon or expect specks."
    elif any(t in sampler for t in NOISY):
        tip += " This sampler adds its own noise: halve Detail Daemon or expect specks."
    return tip


SPEC_KEYS = ("beta_alpha", "beta_beta", "flowmatch_shift", "flowmatch_dynamic", "flowmatch_terminal", "hyperbolic_function",
             "hyperbolic_scale", "gaussian_mean", "gaussian_std", "gaussian_operation")


def make_spec(schedule, base_scheduler, curve_edit="", **params):
    spec = {"schedule": schedule, "base": base_scheduler, "edit": parse_edit(curve_edit)}
    spec.update({k: params[k] for k in SPEC_KEYS if k in params})
    return spec


def label(spec):
    sch = spec["schedule"]
    name = {"base": spec["base"], "beta": f"beta {spec.get('beta_alpha', 0.6):g}/{spec.get('beta_beta', 0.6):g}",
            "flowmatch": "flowmatch", "hyperbolic": f"{spec.get('hyperbolic_function', 'tanh')} on {spec['base']}",
            "gaussian": f"gaussian {spec.get('gaussian_operation', 'modulate')} on {spec['base']}"}.get(sch, sch)
    return name + (" (edited)" if any(abs(e) > 1e-9 for e in spec.get("edit") or []) else "")


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
                "sigma_curve_presets": (SCHEDULES + saved_names(), {"default": "base",
                             "tooltip": "The curve the steps follow, from noisy to clean.\n"
                                        "base = a plain scheduler (base_scheduler).\n"
                                        "beta = the beta curve with your own alpha and beta.\n"
                                        "flowmatch = the FlowMatch Euler Discrete curve.\n"
                                        "hyperbolic = the base curve bent by sinh / cosh / tanh.\n"
                                        "gaussian = the base curve bent by a bell curve.\n"
                                        "saved: = a curve you saved. Drag the points on the graph to bend any of them."}),
                "base_scheduler": (shapes, {"default": "beta57" if "beta57" in shapes else "simple",
                                   "tooltip": "The scheduler under base, hyperbolic and gaussian (sigma_curve_presets). Flow models (Krea 2, Z-Image, Flux 2): "
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
                                        "second pass has something to refine, like a detailer."}),
                "scheduler_shape_2": ([SAME] + shapes, {"default": SAME,
                                      "tooltip": "The second pass's curve. same as first = the schedule above, curve edits included."}),
                "first_pass_resample": ("FLOAT", {"default": 1.0, "min": 0.25, "max": 4.0, "step": 0.05,
                                        "tooltip": "Walks the first pass in more (or fewer) steps along the same path; where it starts "
                                                   "and stops stays put. 1 = off. 1.15 = 15% more first-pass steps."}),
                "sigma_shift": (SHIFTS, {"default": SHIFT_MODEL,
                                "tooltip": "Bends the schedule without changing the step count. Higher = more steps on composition "
                                           "(the noisy start), lower = more on detail. use model default = what the model was "
                                           "trained with. by image size = Flux's rule (needs image_size_latent). custom = custom_shift. "
                                           "SDXL-type models have no shift. flowmatch and saved curves ignore it."}),
                "custom_shift": ("FLOAT", {"default": 1.15, "min": 0.0, "max": 20.0, "step": 0.05,
                                 "tooltip": "The model's own shift number. Krea 2 / Flux: 0.5 small images, 1.15 = Krea 2 Turbo's "
                                            "default, 2+ = strongly composition-heavy."}),
                "beta_alpha": ("FLOAT", {"default": 0.6, "min": 0.0, "max": 50.0, "step": 0.01,
                               "tooltip": "beta: higher = more steps at the noisy start."}),
                "beta_beta": ("FLOAT", {"default": 0.6, "min": 0.0, "max": 50.0, "step": 0.01,
                              "tooltip": "beta: higher = more steps at the clean end (detail)."}),
                "flowmatch_shift": ("FLOAT", {"default": 3.0, "min": 0.0, "max": 20.0, "step": 0.01,
                                    "tooltip": "flowmatch: the curve's shift (used when flowmatch_dynamic is off)."}),
                "flowmatch_dynamic": ("BOOLEAN", {"default": True, "label_on": "dynamic shifting", "label_off": "fixed shift",
                                      "tooltip": "flowmatch: dynamic shifting (as in V23.2) or the fixed flowmatch_shift."}),
                "flowmatch_terminal": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 0.99, "step": 0.01,
                                       "tooltip": "flowmatch: stretch the curve so the last step lands here. 0 = off."}),
                "hyperbolic_function": (HYPER_FUNCS, {"default": "tanh", "tooltip": "hyperbolic: the function that bends the base curve."}),
                "hyperbolic_scale": ("FLOAT", {"default": 1.0, "min": 0.01, "max": 10.0, "step": 0.01,
                                     "tooltip": "hyperbolic: how hard the function bends it."}),
                "gaussian_mean": ("FLOAT", {"default": 0.04, "min": -10.0, "max": 10.0, "step": 0.01,
                                  "tooltip": "gaussian: where the bell curve sits (a noise level)."}),
                "gaussian_std": ("FLOAT", {"default": 1.0, "min": 0.01, "max": 10.0, "step": 0.01,
                                 "tooltip": "gaussian: how wide the bell curve is."}),
                "gaussian_operation": (GAUSS_OPS, {"default": "modulate", "tooltip": "gaussian: how the bell curve bends the base curve."}),
                "edit_mode": (EDIT_MODES, {"default": "smooth",
                              "tooltip": "Dragging a point on the graph: smooth pulls its neighbours along, spike moves only that point."}),
                "smooth_radius": ("FLOAT", {"default": 1.5, "min": 0.0, "max": 20.0, "step": 0.5,
                                  "tooltip": "smooth: how many steps around the point come along."}),
                "curve_edit": ("STRING", {"default": "", "tooltip": "Your curve edit (set by dragging on the graph)."}),
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
    DESCRIPTION = ("One scheduler for one- and two-pass sampling: schedule presets (base, beta, flowmatch, hyperbolic, "
                   "gaussian, your saved curves) you can bend by dragging on the graph, the step swap to a second model, "
                   "image-to-image denoise, what the second pass does (continue or renoise), and the noise and sampler for "
                   "each pass.")

    @classmethod
    def VALIDATE_INPUTS(cls, sampler, sigma_curve_presets):
        # a wired sampler (e.g. a Clown Sampler Selector) arrives as None here; its name is checked when the node runs
        if not (sampler is None or sampler in comfy.samplers.KSampler.SAMPLERS or sampler in clown_names()):
            return f"Unknown sampler: {sampler}"
        if sigma_curve_presets is not None and sigma_curve_presets not in SCHEDULES and not str(sigma_curve_presets).startswith(SAVED):
            return f"Unknown sigma_curve_presets: {sigma_curve_presets}"
        return True

    def build(self, model, sampler, sigma_curve_presets, base_scheduler, steps, step_swap, denoise, denoise_steps, low_pass,
              scheduler_shape_2, first_pass_resample, sigma_shift, custom_shift, edit_mode, smooth_radius, curve_edit, seed,
              model_2=None, image_size_latent=None, unique_id=None, **params):
        if model is None:
            raise ValueError("[LC Sigmas] model arrived empty: whatever feeds it (a pipe, or a switch whose chosen input is "
                             "bypassed or unplugged) sent nothing. Check that node.")
        ms1 = model.get_model_object("model_sampling")
        ms2 = model_2.get_model_object("model_sampling") if model_2 is not None else None
        size = None
        if image_size_latent is not None:
            s = image_size_latent["samples"].shape
            size = (int(s[-1]) * 8, int(s[-2]) * 8)
        fam = family(model)
        spec = make_spec(sigma_curve_presets, base_scheduler, curve_edit, **params)
        high, low, noise_high, noise_low, full, info, graph = plan(
            ms1, ms2, size, steps, step_swap, spec, scheduler_shape_2, sigma_shift, custom_shift, denoise,
            denoise_steps, low_pass, seed, first_pass_resample)
        info = f"{sampler} + {label(spec)} · {info}"
        shift = model_shift(_shifted(ms1, sigma_shift, custom_shift, size)[0])
        graph.update(info=info, tip=_tip(fam, sampler, spec, shift))
        ran = dict(sampler=sampler, sigma_curve_presets=sigma_curve_presets, base_scheduler=base_scheduler, steps=steps,
                   step_swap=step_swap, denoise=denoise, denoise_steps=denoise_steps, low_pass=low_pass,
                   scheduler_shape_2=scheduler_shape_2, first_pass_resample=first_pass_resample, sigma_shift=sigma_shift,
                   custom_shift=custom_shift, curve_edit=curve_edit, edit_mode=edit_mode, **params)
        graph["ran"] = ran  # what this run received (wired inputs included), for the node face
        if unique_id is not None:
            _PREVIEW[str(unique_id)] = (ms1, ms2, size, fam, ran)
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
        ms1, ms2, size, fam, ran = got
        for k in b.get("linked") or []:  # a wired input: its widget is stale, use what the last run actually received
            if k in ran:
                b[k] = ran[k]
        try:
            spec = make_spec(b["sigma_curve_presets"], b["base_scheduler"], b.get("curve_edit") or "", **{k: b[k] for k in SPEC_KEYS if k in b})
            g = plan(ms1, ms2, size, b["steps"], b["step_swap"], spec, b["scheduler_shape_2"], b["sigma_shift"],
                     b["custom_shift"], b["denoise"], b["denoise_steps"], b["low_pass"], 0, b.get("first_pass_resample", 1.0))[6]
            shift = model_shift(_shifted(ms1, b["sigma_shift"], b["custom_shift"], size)[0])
            g.update(info=f"{b.get('sampler') or ''} + {label(spec)} · {g['info']}", tip=_tip(fam, b.get("sampler") or "euler", spec, shift))
            g["ran"] = ran
        except Exception as e:
            return web.json_response({"error": str(e)})
        return web.json_response(g)

    @PromptServer.instance.routes.post("/lc123/sigmas/save")
    async def _lc_sigmas_save(request):
        """Save the graph's whole schedule (as a share of noise, top = 1) as a curve LC Sigmas and LC Sigma Curve both list."""
        b = await request.json()
        try:
            from .lc_sigma_curve import _sanitize, _save_curve

            vals = [max(0.0, min(1.0, float(v))) for v in b.get("values") or []]
            name = _sanitize(str(b.get("name") or ""))
            if len(vals) < 2 or not name:
                return web.json_response({"error": "nothing to save"})
            _save_curve(name, vals, str(b.get("source") or "LC Sigmas"), len(vals) - 1)
            return web.json_response({"name": SAVED + name})
        except Exception as e:
            return web.json_response({"error": str(e)})
except Exception:
    pass
