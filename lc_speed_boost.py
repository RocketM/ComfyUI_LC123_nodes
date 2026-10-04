"""
LC Speed Boost (BETA): starts the render at half size, then grows it to full size partway through, so the early steps
cost about a quarter as much. The layout is decided while the picture is small (like the model's own trained size), the
detail at full size. Roughly 1.5x to 2x faster first passes on Krea 2, Z-Image and Flux.2 Klein, with the same quality.

Based on SPEED, "Spectral Progressive Diffusion for Efficient Image and Video Generation" (Xiao, Chao, Yariv and
Wetzstein, 2026), and the MIT licensed ComfyUI-SPEED-SwarmNeo. This is LC's own version: it runs on the GPU, it always
grows to full size before the last steps, and it steps aside where it can't help.

How the grow works (flow models: x = (1 - t) * picture + t * noise): the noise is shrunk by keeping the low part of its
cosine spectrum (still pure noise, same strength). At the grow point the small state is padded back to full size in the
same spectrum and the new fine part is filled with fresh noise. Padding leaves the picture 1/r as strong as the noise
(r = full size / small size, per side), so the state is scaled by k = r / (1 + (r - 1) * t) and sampling carries on at
the matching noise level k * t.
"""

from __future__ import annotations

import math

import torch

from comfy.samplers import KSAMPLER

_DCT = {}


def _dct(n, device):
    """Orthonormal DCT-II matrix (n x n): coefficients = D @ signal, signal = D.T @ coefficients."""
    key = (n, str(device))
    if key not in _DCT:
        k = torch.arange(n, dtype=torch.float64).unsqueeze(1)
        i = torch.arange(n, dtype=torch.float64).unsqueeze(0)
        d = torch.cos(math.pi * (2 * i + 1) * k / (2 * n)) * math.sqrt(2.0 / n)
        d[0] /= math.sqrt(2.0)
        _DCT[key] = d.to(device=device, dtype=torch.float32)
    return _DCT[key]


def _spec(x):
    """Cosine spectrum over the last two (height, width) dims."""
    h, w = x.shape[-2:]
    return _dct(h, x.device) @ x.float() @ _dct(w, x.device).T


def _unspec(c):
    h, w = c.shape[-2:]
    return _dct(h, c.device).T @ c @ _dct(w, c.device)


def shrink(x, h, w):
    """Noise at full size -> noise at h x w: keep the low part of its spectrum. White noise stays white, same strength."""
    return _unspec(_spec(x)[..., :h, :w].contiguous()).to(x.dtype)


def grow(y, H, W, t, seed):
    """Small state at noise level t -> full size state, and its noise level. See the module notes."""
    h, w = y.shape[-2:]
    c = torch.zeros(*y.shape[:-2], H, W, device=y.device, dtype=torch.float32)
    c[..., :h, :w] = _spec(y)
    g = torch.Generator(device="cpu").manual_seed(int(seed) & 0xFFFFFFFF)
    fresh = torch.randn(*y.shape[:-2], H, W, generator=g).to(y.device)
    fresh[..., :h, :w] = 0.0  # fresh noise only where the small picture had nothing (white noise in this basis)
    c += t * fresh
    r = math.sqrt((H * W) / float(h * w))
    k = r / (1.0 + (r - 1.0) * t)
    return (_unspec(c) * k).to(y.dtype), k * t


def _patcher(model):
    m = model
    for _ in range(6):
        if hasattr(m, "model_patcher"):
            return m.model_patcher
        m = getattr(m, "inner_model", None)
        if m is None:
            return None
    return None


def _is_flow(model, sigmas):
    try:
        import comfy.model_sampling as ms

        p = _patcher(model)
        if p is not None:
            return isinstance(p.get_model_object("model_sampling"), ms.CONST)
    except Exception:
        pass
    return float(sigmas.max()) <= 1.001


MIN_START = 0.9  # below this it's an upscale / image to image pass: nothing to gain
AUTO_NOISE = 0.7  # tested sweet spot on Krea 2, Z-Image and Klein: about 2x faster, same quality


def plan(sigmas, auto, step):
    """Step where the picture grows to full size, counted from the start of the run. None = stay at full size.
    The last step always runs at full size, the last two when nothing follows (a single pass)."""
    n = len(sigmas) - 1
    if n < 2 or (not auto and step <= 0):
        return None
    s = [float(v) for v in sigmas]
    keep = 1 if s[-1] > 0 else (2 if n >= 4 else 1)  # a pass that ends above 0 hands over to a low pass at full size
    j = next((i for i in range(1, n) if s[i] <= AUTO_NOISE), n - keep) if auto else int(step)
    return max(1, min(j, n - keep))


def _shrink_start(model, x, s0, h, w):
    """The starting state at half size. x = (1 - s0) * latent + s0 * noise: the noise shrinks as noise, the latent as a
    picture (its spectrum is r times its half size version's). An empty latent is just noise."""
    lat, nz = getattr(model, "latent_image", None), getattr(model, "noise", None)
    if lat is not None and nz is not None and lat.shape == x.shape:
        if not torch.count_nonzero(lat):
            return shrink(x, h, w)
        r = math.sqrt((x.shape[-2] * x.shape[-1]) / float(h * w))
        return ((1.0 - s0) * shrink(lat.to(x.device), h, w) / r + s0 * shrink(nz.to(x.device), h, w)).to(x.dtype)
    return shrink(x, h, w) if s0 >= 0.99 else None


def _sampler(model, x, sigmas, extra_args=None, callback=None, disable=None, *, lc_inner, lc_auto, lc_step, **kw):
    extra_args = dict(extra_args or {})
    inner_fn, inner_opts = lc_inner.sampler_function, dict(lc_inner.extra_options)

    def run(xx, ss, offset):
        cb = None
        if callback is not None:
            cb = lambda d: callback({**d, "i": d["i"] + offset})
        return inner_fn(model, xx, ss, extra_args=extra_args, callback=cb, disable=disable, **inner_opts)

    why = None
    if extra_args.get("denoise_mask") is not None:
        why = "inpaint mask (it only works on the whole picture)"
    elif not _is_flow(model, sigmas):
        why = "not a flow model (Krea 2, Z-Image, Flux, Qwen-Image, Wan work; SDXL-family models don't)"
    elif float(sigmas[0]) < MIN_START:
        why = f"the run starts at noise {float(sigmas[0]):.2f}, too little to start small (upscale / image to image pass)"
    j = None if why else plan(sigmas, lc_auto, lc_step)
    if j is None:
        if not why:
            why = "grow_at_step is 0" if not lc_auto and lc_step <= 0 else "too few steps"
        print(f"[LC Speed Boost] Off for this run: {why}. Sampling at full size.")
        return run(x, sigmas, 0)

    H, W = x.shape[-2:]
    h, w = max(2, round(H / 2)), max(2, round(W / 2))
    t = float(sigmas[j])
    xs = _shrink_start(model, x, float(sigmas[0]), h, w)
    if xs is None:
        print("[LC Speed Boost] Off for this run: can't separate the starting picture from the noise. Sampling at full size.")
        return run(x, sigmas, 0)
    y = run(xs, sigmas[: j + 1], 0)
    X, t2 = grow(y, H, W, t, extra_args.get("seed", 0) + 7)
    rest = torch.cat([torch.tensor([t2], dtype=sigmas.dtype, device=sigmas.device), sigmas[j + 1:]])
    n = len(sigmas) - 1
    print(f"[LC Speed Boost] {j} of {n} steps at half size (latent {w}x{h} of {W}x{H}), grew at noise {t:.3f} "
          f"(carries on at {t2:.3f}), {n - j} at full size.")
    return run(X, rest, j)


def _wrap(sampler, auto, step):
    # The LC Detail Daemon times its window by step. Wrapped inside the size switch, each size part would restart that
    # window, so it goes outside: the Daemon sees the whole schedule, Speed Boost runs inside it.
    opts = getattr(sampler, "extra_options", {}) or {}
    if "lc_wrapped" in opts and "lc_amount" in opts:
        inner = _wrap(opts["lc_wrapped"], auto, step)
        return KSAMPLER(sampler.sampler_function, extra_options={**opts, "lc_wrapped": inner},
                        inpaint_options=getattr(sampler, "inpaint_options", {}))
    return KSAMPLER(_sampler, extra_options={"lc_inner": sampler, "lc_auto": bool(auto), "lc_step": int(step)},
                    inpaint_options=getattr(sampler, "inpaint_options", {}))


class LCSpeedBoost:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "sampler": ("SAMPLER", {"tooltip": "High pass sampler only. From LC Sigmas, KSamplerSelect or LC Detail Daemon."}),
            "auto": ("BOOLEAN", {"default": True, "label_on": "auto", "label_off": "grow_at_step",
                                 "tooltip": "Picks the grow step from the run's own schedule (about 2x faster, same quality)."}),
            "grow_at_step": ("INT", {"default": 4, "min": 0, "max": 200, "step": 1,
                                     "tooltip": "Used when auto is off. The step where the picture grows to full size, counted "
                                                "like step_swap. 0 = every step at full size."}),
        }}

    RETURN_TYPES = ("SAMPLER",)
    FUNCTION = "go"
    CATEGORY = "LC123/sampling"
    DESCRIPTION = ("BETA. Plug it into the high pass sampler only. It starts the picture at half size and grows it to full "
                   "size partway through: about 2x faster, same quality. The layout follows the model's trained size, so a "
                   "seed frames differently with it on.\n"
                   "Put LC Detail Daemon on the low pass. Detail is made in the last steps.\n"
                   "Speeds up passes that start from noise (denoise 0.9 and up). Upscale and image to image passes run as "
                   "normal: their layout comes from your image.\n"
                   "Works on Krea 2, Z-Image, Flux.2 Klein, Qwen-Image and Wan. It switches itself off on SDXL-family models "
                   "and inpaint masks (the console says why).\n"
                   "Based on SPEED (Xiao, Chao, Yariv and Wetzstein, 2026).")

    def go(self, sampler, auto, grow_at_step):
        return (_wrap(sampler, auto, grow_at_step),)


NODE_CLASS_MAPPINGS = {"LCSpeedBoost": LCSpeedBoost}
NODE_DISPLAY_NAME_MAPPINGS = {"LCSpeedBoost": "LC Speed Boost (BETA) 🚀"}
