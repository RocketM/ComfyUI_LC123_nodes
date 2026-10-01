"""
LC Optimizer nodes: loader + optimizer in one. Four versions share lc_optimizer_engine:

  LC Optimizer             model, clip, vae, summary            (image models)
  LC Optimizer (pipe)      LC_PIPE, model, clip, vae, summary                     (model_2 = Ideogram 4's unconditional model)
  LC Optimizer Video       model, clip, vae, audio vae, latent upscaler, summary
  LC Optimizer Video (pipe) LC_PIPE + the Video outputs          (vae_2 = audio VAE)

File widgets hold "★ Recommended", "⬇ Download: <file>", "From checkpoint", "None" or a file under the model
folders. The node face (web/lc_optimizer_node.js) draws the pickers and the status panel.
"""

from __future__ import annotations

import hashlib
import json

from . import lc_optimizer_engine as E

MANUAL = {
    "attention": (E.ATTENTION, "auto", "Attention backend. auto = the fastest one that passed the report's test."),
    "fp16_accumulation": (["auto", "on", "off"], "auto", "Faster fp16 math with a small quality cost. auto = Fast goal only."),
    "step_cache": (["auto", "on", "off"], "auto", "EasyCache: skips steps that barely change. auto = Fast goal, 20+ steps."),
    "torch_compile": (["off", "on"], "off", "Compiles the model: the first run is slow, later runs are faster. Needs Triton."),
}
QWEN_TIP = ("Qwen-Image 2.1 only (Qwen Image 2.1 Cache): where the KV cache lives and how it is stored. auto = lossless, "
            "int8 on the Fast goal or cards under 16 GB. int8 halves the cache at about bf16 accuracy, int4 quarters it "
            "but roughly doubles the per-step error. RAM costs little speed. off = slowest.")
ROLES_IMAGE = ["model", "clip", "vae"]
ROLES_VIDEO = ["model", "clip", "vae", "audio_vae", "upscaler", "lora"]
CLIP_TIP = ("Custom only: how the text encoder is loaded (CLIPLoader's type). auto = from the encoder's shape when it "
            "matches one known base model. Ignored for the other base models and for a checkpoint's own encoder.")
WIDGET_OF = {"model": "model_file", "clip": "text_encoder", "vae": "vae", "audio_vae": "audio_vae", "upscaler": "latent_upscaler", "lora": "lora"}


def _values(kind, role):
    vals = [E.RECOMMENDED, E.FROM_CKPT, E.NONE]
    for prof in E.profiles(kind).values():
        vals += [E.DOWNLOAD + v["file"] for v in E.variants(prof, role) if E.DOWNLOAD + v["file"] not in vals]
    vals += [n for _, n in E.local_files(role) if n not in vals]
    return vals


DESC_IMAGE = (
    "This node analyzes your machine and loads the model, text encoder and VAE that suit YOUR card, with the speed-ups "
    "that actually work on it (Sage, Comfy Kitchen, etc.).\n"
    "Run the report with the button below, or from the LC123 settings.\n"
    "Missing a file? Pick a ⬇ entry and it downloads on the first run.\n"
    "Finetunes work too. Pick your own file and it still gets the speed-ups, plus a ⚠️ if the text encoder or VAE doesn't match.\n"
    "Any other model: set the base model to Custom and pick your own files (and the text encoder type). The speed-ups "
    "still apply; recommendations, estimates and checks show as unsupported.\n"
    "Current available models: Krea 2, Krea 2 (Raw), Qwen-Image 2.1, Z-Image Turbo, Flux.2 Klein 9B, Ideogram 4, Anima, "
    "SDXL, Illustrious, Pony, Custom."
)
DESC_VIDEO = (
    "This node analyzes your machine and loads the model, text encoder, video and audio VAE and latent upscaler that suit "
    "YOUR card, with the speed-ups that actually work on it (Sage, Comfy Kitchen, etc.).\n"
    "Run the report with the button below, or from the LC123 settings.\n"
    "Missing a file? Pick a ⬇ entry and it downloads on the first run.\n"
    "Finetunes work too. Pick your own file and it still gets the speed-ups, plus a ⚠️ if the text encoder or VAE doesn't match.\n"
    "Any other model: set the base model to Custom and pick your own files (and the text encoder type). The speed-ups "
    "still apply; recommendations, estimates and checks show as unsupported.\n"
    "Current available models: MiniMax H3, LTX 2.5, LTX 2.3, Custom."
)


class _LCOptimizerBase:
    KIND = "image"
    ROLES = ROLES_IMAGE
    PIPE = False
    CATEGORY = "LC123/optimizer"
    FUNCTION = "run"

    @classmethod
    def INPUT_TYPES(cls):
        names = [n for _, n in E.base_names(cls.KIND)] or ["(no profiles)"]
        req = {
            "base_model": (names, {"tooltip": "The model family. Picks the recommended files and the checks."}),
            "goal": (E.GOALS, {"default": "Optimal", "tooltip": "Quality = closest to bf16. Optimal = fast and near identical. Fast = fastest that still looks right."}),
        }
        for role in cls.ROLES:
            w = WIDGET_OF[role]
            default = E.RECOMMENDED
            req[w] = (_values(cls.KIND, role), {"default": default})  # hidden: the face draws the picker
        req["speed_ups"] = (["Auto", "Manual"], {"default": "Auto", "tooltip": "Auto = from the System & Model Optimization Report. Manual = choose each one below."})
        for k, (opts, d, tip) in MANUAL.items():
            req[k] = (opts, {"default": d, "tooltip": tip})
        if cls.KIND == "image":  # last, so saved workflows keep their widget order
            req["qwen21_cache"] = (["auto"] + list(E.QWEN_CACHE), {"default": "auto", "tooltip": QWEN_TIP})
        req["clip_type"] = (E.clip_types(cls.KIND), {"default": E.CLIP_AUTO, "tooltip": CLIP_TIP})  # last: Custom only
        return {"required": req}

    @classmethod
    def VALIDATE_INPUTS(cls, **kw):
        # file lists change as files download; the values are checked (and downloaded) when the node runs
        return True

    @classmethod
    def IS_CHANGED(cls, **kw):
        sysp = E.report() or {}
        return hashlib.sha1((json.dumps(kw, sort_keys=True, default=str) + str(sysp.get("when"))).encode()).hexdigest()

    # ------------------------------------------------------------------
    def _profile_id(self, base_model):
        for pid, name in E.base_names(self.KIND):
            if name == base_model:
                return pid
        raise ValueError(f"[LC Optimizer] Unknown base model {base_model}.")

    def run(self, base_model, goal, speed_ups, **kw):
        pid = self._profile_id(base_model)
        prof = E.profiles()[pid]
        manual = {k: kw.get(k) for k in list(MANUAL) + ["qwen21_cache"]} if speed_ups == "Manual" else None
        picks = {role: kw.get(WIDGET_OF[role]) for role in self.ROLES}
        loaded, swap = [], {}
        got = {}

        def res(role):
            r = E.resolve(pid, role, picks[role], goal)
            if r and isinstance(picks[role], str) and picks[role].startswith(E.DOWNLOAD):
                swap[WIDGET_OF[role]] = r[1]
            return r

        custom = E.is_custom(pid)
        got["model"] = res("model")
        if not got["model"]:
            raise ValueError("[LC Optimizer] Custom: ★ Recommended is unsupported. Pick your own model file." if custom
                             else "[LC Optimizer] Pick a model file.")
        folder, name, _ = got["model"]
        model, clip, vae, how = E.load_model(folder, name)
        loaded.append(("model", f"{name} ({how})"))
        ckpt_name = name if folder == "checkpoints" else None
        from_ckpt = {"clip": clip is not None, "vae": vae is not None, "audio_vae": ckpt_name is not None}
        for role in self.ROLES[1:]:
            # an all-in-one checkpoint brings its own text encoder / VAE: Recommended keeps those
            got[role] = None if (from_ckpt.get(role) and picks[role] == E.RECOMMENDED) else res(role)
        if ckpt_name and picks.get("audio_vae") == E.RECOMMENDED:
            picks["audio_vae"] = E.FROM_CKPT
        if got.get("clip"):
            f, n, v = got["clip"]
            if custom:
                ctype = kw.get("clip_type") or E.CLIP_AUTO
                if ctype == E.CLIP_AUTO:
                    ctype, seen = E.auto_clip_type(E.full_path(f, n))
                    if not ctype:
                        raise ValueError("[LC Optimizer] Custom: could not tell how to load this text encoder"
                                         + (f" (it fits {', '.join(seen)})" if seen else "") + ". Set clip_type on the node.")
            else:
                ctype = (v or {}).get("clip_type") or next((c.get("clip_type") for c in prof["components"].values() if c["role"] == "text_encoder"), "stable_diffusion")
            clip = E.load_clip(f, n, ctype, ckpt_name)
            loaded.append(("clip", f"{n} ({ctype})" if custom else n))
        elif clip is not None:
            loaded.append(("clip", "from the checkpoint"))
        if got.get("vae"):
            f, n, _ = got["vae"]
            vae = E.load_vae(f, n)
            loaded.append(("vae", n))
        elif vae is not None:
            loaded.append(("vae", "from the checkpoint"))
        extra = {}
        if "audio_vae" in self.ROLES:
            if got.get("audio_vae"):
                f, n, _ = got["audio_vae"]
                extra["audio_vae"] = E.load_vae(f, n, audio=True)
                loaded.append(("audio vae", n))
            elif picks.get("audio_vae") == E.FROM_CKPT and ckpt_name:
                extra["audio_vae"] = E.load_vae("checkpoints", ckpt_name, audio=True)
                loaded.append(("audio vae", "from the checkpoint"))
        if "upscaler" in self.ROLES and got.get("upscaler"):
            extra["upscaler"] = E.load_upscaler(got["upscaler"][1])
            loaded.append(("upscaler", got["upscaler"][1]))
        if "lora" in self.ROLES and got.get("lora"):
            model = E.apply_lora(model, got["lora"][1], 0.5)
            loaded.append(("lora", f"{got['lora'][1]} at 0.5"))

        pl = E.plan(pid, goal, picks, manual)
        model, applied = E.apply_speedups(model, pl["speedups"])
        model_2 = None
        if self.PIPE and pid == "ideogram4":
            model_2 = self._ideogram_uncond(got["model"])
            if model_2 is not None:
                model_2, _ = E.apply_speedups(model_2, pl["speedups"])
                loaded.append(("model_2", "Ideogram 4 unconditional"))
        text = E.summary_text(pl, applied, loaded)
        pl["applied"] = applied
        ui = {"lc_optimizer": [json.dumps(pl, default=str)], "lc_optimizer_swap": [json.dumps(swap)]}
        return {"ui": ui, "result": self._outputs(model, clip, vae, model_2, extra, text)}

    def _ideogram_uncond(self, got_model):
        folder, name, v = got_model
        base = name.replace("\\", "/").split("/")[-1]
        if "unconditional" in base or not base.startswith("ideogram4_"):
            return None
        uname = base.replace("ideogram4_", "ideogram4_unconditional_", 1)
        hit = E.find_on_disk(uname, [folder])
        if not hit and v:
            hit = E.download(dict(v, file=uname))
        return E.load_model(hit[0], hit[1])[0] if hit else None

    def _outputs(self, model, clip, vae, model_2, extra, text):
        return (model, clip, vae, text)


class LCOptimizer(_LCOptimizerBase):
    RETURN_TYPES = ("MODEL", "CLIP", "VAE", "STRING")
    RETURN_NAMES = ("model", "clip", "vae", "summary")
    DESCRIPTION = DESC_IMAGE


class LCOptimizerPipe(_LCOptimizerBase):
    PIPE = True
    RETURN_TYPES = ("LC_PIPE", "MODEL", "CLIP", "VAE", "STRING")
    RETURN_NAMES = ("pipe", "model", "clip", "vae", "summary")
    DESCRIPTION = DESC_IMAGE

    def _outputs(self, model, clip, vae, model_2, extra, text):
        pipe = {"_type": "LC_PIPE", "model_1": model, "clip_1": clip, "vae_1": vae}
        if model_2 is not None:
            pipe["model_2"] = model_2
        return (pipe, model, clip, vae, text)


class LCOptimizerVideo(_LCOptimizerBase):
    KIND = "video"
    ROLES = ROLES_VIDEO
    RETURN_TYPES = ("MODEL", "CLIP", "VAE", "VAE", "LATENT_UPSCALE_MODEL", "STRING")
    RETURN_NAMES = ("model", "clip", "vae", "audio_vae", "latent_upscaler", "summary")
    DESCRIPTION = DESC_VIDEO

    def _outputs(self, model, clip, vae, model_2, extra, text):
        return (model, clip, vae, extra.get("audio_vae"), extra.get("upscaler"), text)


class LCOptimizerVideoPipe(_LCOptimizerBase):
    KIND = "video"
    ROLES = ROLES_VIDEO
    PIPE = True
    RETURN_TYPES = ("LC_PIPE", "MODEL", "CLIP", "VAE", "VAE", "LATENT_UPSCALE_MODEL", "STRING")
    RETURN_NAMES = ("pipe", "model", "clip", "vae", "audio_vae", "latent_upscaler", "summary")
    DESCRIPTION = DESC_VIDEO

    def _outputs(self, model, clip, vae, model_2, extra, text):
        pipe = {"_type": "LC_PIPE", "model_1": model, "clip_1": clip, "vae_1": vae}
        if extra.get("audio_vae") is not None:
            pipe["vae_2"] = extra["audio_vae"]
        return (pipe, model, clip, vae, extra.get("audio_vae"), extra.get("upscaler"), text)


NODE_CLASS_MAPPINGS = {
    "LCOptimizer": LCOptimizer,
    "LCOptimizerPipe": LCOptimizerPipe,
    "LCOptimizerVideo": LCOptimizerVideo,
    "LCOptimizerVideoPipe": LCOptimizerVideoPipe,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "LCOptimizer": "LC Model Optimizer ⚡",
    "LCOptimizerPipe": "LC Model Optimizer (pipe) ⚡",
    "LCOptimizerVideo": "LC Model Optimizer Video ⚡",
    "LCOptimizerVideoPipe": "LC Model Optimizer Video (pipe) ⚡",
}


# ---------------------------------------------------------------- routes for the node face
try:
    from aiohttp import web
    from server import PromptServer

    @PromptServer.instance.routes.get("/lc123/optimizer_node/choices")
    async def _lc_opt_choices(request):
        q = request.rel_url.query
        kind = q.get("kind", "image")
        pid = next((p for p, n in E.base_names(kind) if n == q.get("base")), None)
        return web.json_response(E.choices(pid, q.get("role", "model"), q.get("goal", "Optimal")) if pid else {"error": "unknown base model"})

    @PromptServer.instance.routes.post("/lc123/optimizer_node/plan")
    async def _lc_opt_plan(request):
        import asyncio

        body = await request.json()
        kind = body.get("kind", "image")
        pid = next((p for p, n in E.base_names(kind) if n == body.get("base")), None)
        if not pid:
            return web.json_response({"error": "unknown base model"}, status=400)
        manual = body.get("manual") if body.get("speed_ups") == "Manual" else None
        pl = await asyncio.get_running_loop().run_in_executor(None, lambda: E.plan(pid, body.get("goal", "Optimal"), body.get("picks") or {}, manual))
        return web.json_response(json.loads(json.dumps(pl, default=str)))

except Exception:
    pass
