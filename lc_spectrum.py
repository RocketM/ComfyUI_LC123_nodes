"""Spectrum for image models, applied by LC Model Optimizer (feature forecasting, arXiv 2603.01623, written from the paper).
Real steps run the model and keep the image tokens going into its output layer; forecast steps predict those tokens with
a Chebyshev ridge fit over the recent real steps and run only the output layer, skipping the text encoder blocks and
every transformer block. The warm-up (where the layout forms) and the last steps always run for real.

MOSS Image: tokens leaving the last of its 42 layers (block-replace patch), head = modulated norm + final linear.
Krea 2 (Turbo, Raw): its block loop has no block-replace hook, so a forward pre-hook on `last` catches the tokens during
the real call only; its latents arrive as one-frame 5D tensors.

2026-10-22 benches (Sage on, every 2nd middle step): MOSS SFT 25 steps 2 MP 1.71x on a 5090, 2.08x on an 8 GB laptop;
Krea 2 Turbo 10 steps 2 MP 1.36x; Krea 2 Raw 52 steps 1 MP 1.60x. Faces, hands and text unchanged at full size. A fixed
4-step warm-up re-laid-out Raw's scene at 52 steps; 20% of the steps kept it, so the warm-up scales with the run."""
import math

import torch

import comfy.patcher_extension
from comfy.ldm.flux.layers import timestep_embedding

KEY = "lc_spectrum"
MIN_STEPS = 8
WARMUP_SHARE, DEGREE, WINDOW, RIDGE = 0.2, 2, 4, 0.1


def _cheb(tau, degree):
    feats = [torch.ones_like(tau), tau]
    for _ in range(2, degree + 1):
        feats.append(2 * tau * feats[-1] - feats[-2])
    return torch.stack(feats[:degree + 1], dim=-1)


def _kind(model):
    dm = model.model.diffusion_model
    if hasattr(dm, "final_linear_video") and hasattr(dm, "layers"):
        return "moss"
    if hasattr(dm, "last") and hasattr(dm, "tmlp") and hasattr(dm, "patch"):
        return "krea2"
    if hasattr(dm, "perceiver") and hasattr(dm, "noise_refiner") and hasattr(dm, "final_layer"):
        return "fibo2"
    return None


def supported(model):
    return _kind(model) is not None


class _Run:
    def __init__(self):
        self.hist = {}  # (batch, h, w, cond_or_uncond) -> [(tau, tokens)]
        self.last_sigma = None
        self.real = self.forecast = 0
        self.told = False


def _forecast(hist, tau):
    P = _cheb(torch.tensor([t for t, _ in hist], dtype=torch.float64), DEGREE)
    phi = _cheb(torch.tensor([tau], dtype=torch.float64), DEGREE)
    a = (phi @ torch.linalg.solve(P.T @ P + RIDGE * torch.eye(DEGREE + 1, dtype=torch.float64), P.T)).flatten().float()
    return sum(a[i] * h for i, (_, h) in enumerate(hist))


def apply(model, interval=2):
    """A clone of model with Spectrum on: after the warm-up, one real step every `interval`, the rest forecast."""
    kind = _kind(model)
    if kind is None:
        return model
    m = model.clone()
    run = _Run()
    captured = {}

    def plan(topts):
        """(step, n, real?) for this call, or None when Spectrum sits this call out."""
        sigmas, cur = topts.get("sample_sigmas"), topts.get("sigmas")
        if sigmas is None or cur is None:
            return None
        s_cur = float(cur.flatten()[0])
        if run.last_sigma is not None and s_cur > run.last_sigma + 1e-6:  # a new sampling run
            if run.forecast:
                print(f"[LC Optimizer] Spectrum: {run.forecast} of {run.real + run.forecast} model calls forecast")
            run.__init__()
        run.last_sigma = s_cur
        n = len(sigmas) - 1
        if n < MIN_STEPS:
            if not run.told:
                print(f"[LC Optimizer] Spectrum sits out ({n} steps): it only pays off from {MIN_STEPS} steps up.")
                run.told = True
            return None
        step = int(torch.argmin((sigmas[:-1].float().cpu() - s_cur).abs()))
        warmup = max(2, round(n * WARMUP_SHARE))
        tail = 1 if n <= 12 else 2
        return step, n, step < warmup or step >= n - tail or (step - warmup) % interval == 0

    if kind == "moss":
        def last_block(args, extra):
            out = extra["original_block"](args)
            captured["tokens"] = out["img"]
            return out

        def wrapper(executor, x, timestep, context, transformer_options, **kwargs):
            p = plan(transformer_options)
            if p is None:
                return executor(x, timestep, context, transformer_options, **kwargs)
            step, n, real = p
            tau = 2.0 * step / n - 1.0
            B, _, H, W = x.shape
            hist = run.hist.setdefault((B, H, W, tuple(transformer_options.get("cond_or_uncond", ()))), [])
            if real or len(hist) < DEGREE + 1:
                captured.clear()
                out = executor(x, timestep, context, transformer_options, **kwargs)
                if "tokens" in captured:
                    hist.append((tau, captured["tokens"][:, :H * W].detach().float()))
                    del hist[:-WINDOW]
                run.real += 1
                return out
            from comfy.ldm.moss_image.model import modulated_rms_norm

            dm = executor.class_obj
            vec = dm.time_embedding(timestep_embedding(timestep, 256).to(x.dtype))
            head_shift, head_scale = dm.video_head_modulation(vec).unflatten(-1, (2, -1)).unsqueeze(2).unbind(1)
            out = dm.final_linear_video(modulated_rms_norm(_forecast(hist, tau).to(x.dtype), dm.final_norm_video, head_scale, head_shift))
            run.forecast += 1
            return out.transpose(1, 2).reshape(B, dm.latent_channels, H, W)

        m.set_model_patch_replace(last_block, "dit", "single_block", len(m.model.diffusion_model.layers) - 1)
    elif kind == "fibo2":
        def wrapper(executor, x, timestep, context, transformer_options, **kwargs):
            p = plan(transformer_options)
            if p is None:
                return executor(x, timestep, context, transformer_options, **kwargs)
            step, n, real = p
            tau = 2.0 * step / n - 1.0
            B, C, H, W = x.shape
            hist = run.hist.setdefault((B, H, W, tuple(transformer_options.get("cond_or_uncond", ()))), [])
            dm = executor.class_obj
            if real or len(hist) < DEGREE + 1:
                cap = {}
                hook = dm.final_layer.register_forward_pre_hook(lambda mod, inp: cap.__setitem__("c", inp[0]))
                try:
                    out = executor(x, timestep, context, transformer_options, **kwargs)
                finally:
                    hook.remove()
                if "c" in cap:  # the image tokens going into the final layer (gist and references already cut off)
                    hist.append((tau, cap["c"].detach().float()))
                    del hist[:-WINDOW]
                run.real += 1
                return out
            out = dm.final_layer(_forecast(hist, tau).to(x.dtype), dm.t_embedder(timestep * 1000, x.dtype))
            run.forecast += 1
            return out.transpose(1, 2).reshape(B, C, H, W)
    else:
        from einops import rearrange

        def wrapper(executor, *args, **kwargs):
            x, timesteps = args[0], args[1]
            topts = kwargs.get("transformer_options") or next((a for a in args if isinstance(a, dict)), {})
            one_frame = x.ndim == 5 and x.shape[2] == 1
            refs = kwargs.get("ref_latents") or (args[4] if len(args) > 4 and not isinstance(args[4], dict) else None)
            p = None if refs or not (x.ndim == 4 or one_frame) else plan(topts)  # reference (edit) runs: left alone
            if p is None:
                return executor(*args, **kwargs)
            step, n, real = p
            tau = 2.0 * step / n - 1.0
            x4 = x[:, :, 0] if one_frame else x
            dm = executor.class_obj
            B, _, H, W = x4.shape
            hp, wp = math.ceil(H / dm.patch), math.ceil(W / dm.patch)
            ntok = hp * wp
            hist = run.hist.setdefault((B, H, W, tuple(topts.get("cond_or_uncond", ()))), [])
            if real or len(hist) < DEGREE + 1:
                cap = {}
                hook = dm.last.register_forward_pre_hook(lambda mod, inp: cap.__setitem__("c", inp[0]))
                try:
                    out = executor(*args, **kwargs)
                finally:
                    hook.remove()
                if "c" in cap:
                    txtlen = cap["c"].shape[1] - ntok
                    hist.append((tau, cap["c"][:, txtlen:txtlen + ntok].detach().float()))
                    del hist[:-WINDOW]
                run.real += 1
                return out
            t = dm.tmlp(timestep_embedding(timesteps, dm.tdim).unsqueeze(1).to(x.dtype))
            final = dm.last(_forecast(hist, tau).to(x.dtype), t)
            out = rearrange(final, "b (h w) (c ph pw) -> b c (h ph) (w pw)", h=hp, w=wp, ph=dm.patch, pw=dm.patch, c=dm.channels)[:, :, :H, :W]
            run.forecast += 1
            return out.unsqueeze(2) if one_frame else out

    m.add_wrapper_with_key(comfy.patcher_extension.WrappersMP.DIFFUSION_MODEL, KEY, wrapper)
    return m
