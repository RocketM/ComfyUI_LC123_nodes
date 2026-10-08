"""
LC Pipe In / Out / Edit
----------------------
General workflow pipe. Get/Set friendly (KJ Set/Get).

Slots (top → bottom):
  Model 1, Clip 1, VAE 1,
  Model 2, Clip 2, VAE 2,
  Image, Mask, Width, Height, Latent, Batch,
  Positive prompt, Positive conditioning,
  Negative prompt, Negative conditioning,
  Seed,
  total_steps, cfg_1, denoise, step_swap, cfg_2, sampler_name, scheduler,
  detailer_steps
"""

import comfy.samplers

PIPE_TYPE = "LC_PIPE"

SLOT_ORDER = [
    ("model_1", "MODEL"),
    ("clip_1", "CLIP"),
    ("vae_1", "VAE"),
    ("model_2", "MODEL"),
    ("clip_2", "CLIP"),
    ("vae_2", "VAE"),
    ("image", "IMAGE"),
    ("mask", "MASK"),
    ("width", "INT"),
    ("height", "INT"),
    ("latent", "LATENT"),
    ("batch", "INT"),
    ("positive_prompt", "STRING"),
    ("positive", "CONDITIONING"),
    ("negative_prompt", "STRING"),
    ("negative", "CONDITIONING"),
    ("seed", "INT"),
    ("total_steps", "INT"),
    ("cfg_1", "FLOAT"),
    ("denoise", "FLOAT"),
    ("step_swap", "INT"),
    ("cfg_2", "FLOAT"),
    ("sampler_name", "SAMPLER_NAME"),
    ("scheduler", "SCHEDULER_NAME"),
    ("detailer_steps", "INT"),
]

DISPLAY = {
    "model_1": "Model 1",
    "clip_1": "Clip 1",
    "vae_1": "VAE 1",
    "model_2": "Model 2",
    "clip_2": "Clip 2",
    "vae_2": "VAE 2",
    "image": "Image",
    "mask": "Mask",
    "width": "Width",
    "height": "Height",
    "latent": "Latent",
    "batch": "Batch",
    "positive_prompt": "Positive prompt",
    "positive": "Positive conditioning",
    "negative_prompt": "Negative prompt",
    "negative": "Negative conditioning",
    "seed": "Seed",
    "detailer_steps": "detailer_steps",
    "total_steps": "total_steps",
    "cfg_1": "cfg_1",
    "denoise": "denoise",
    "step_swap": "step_swap",
    "cfg_2": "cfg_2",
    "sampler_name": "sampler_name",
    "scheduler": "scheduler",
}


def _rtype(kind):
    if kind == "SAMPLER_NAME":
        return comfy.samplers.KSampler.SAMPLERS
    if kind == "SCHEDULER_NAME":
        return comfy.samplers.KSampler.SCHEDULERS
    return kind


def _empty():
    return {"_type": PIPE_TYPE}


def _slot_input(key, kind):
    """Optional input — forceInput so unconnected slots stay unset."""
    label = DISPLAY.get(key, key)
    if kind == "SAMPLER_NAME":
        return (comfy.samplers.KSampler.SAMPLERS, {
            "tooltip": label,
            "forceInput": True,
        })
    if kind == "SCHEDULER_NAME":
        return (comfy.samplers.KSampler.SCHEDULERS, {
            "tooltip": label,
            "forceInput": True,
        })
    if kind == "STRING":
        return ("STRING", {
            "default": "",
            "multiline": True,
            "tooltip": label,
            "forceInput": True,
        })
    if kind == "INT":
        return ("INT", {
            "default": 0,
            "min": -1,
            "max": 0xFFFFFFFFFFFFFFFF,
            "tooltip": label,
            "forceInput": True,
        })
    if kind == "FLOAT":
        return ("FLOAT", {
            "default": 0.0,
            "min": 0.0,
            "max": 100.0,
            "step": 0.05,
            "tooltip": label,
            "forceInput": True,
        })
    return (kind, {"tooltip": label})


def _is_provided(val):
    if val is None:
        return False
    if isinstance(val, str) and val == "":
        return False
    return True


def _merged(key, old, new):
    """Pipe Combine: the LC detailers' protect masks and SAM 3 finds add up when both pipes carry them for the same
    image (combining a face branch with a hands branch keeps both). Anything else: the edit pipe wins."""
    if key not in ("lc_protect", "lc_found") or not (isinstance(old, dict) and isinstance(new, dict)):
        return new
    if old.get("tag") != new.get("tag"):
        return new
    if key == "lc_found":
        return {"tag": new["tag"], "hits": {**old.get("hits", {}), **new.get("hits", {})}}
    import torch
    a, b = old.get("mask"), new.get("mask")
    if a is None or b is None:
        return new if b is not None else old
    if a.shape != b.shape:
        return new
    return {"tag": new["tag"], "mask": torch.maximum(a, b)}


class LCPipeIn:
    @classmethod
    def INPUT_TYPES(cls):
        optional = {key: _slot_input(key, kind) for key, kind in SLOT_ORDER}
        return {"required": {}, "optional": optional}

    RETURN_TYPES = (PIPE_TYPE,)
    RETURN_NAMES = ("pipe",)
    FUNCTION = "pack"
    CATEGORY = "LC123/pipe"
    DESCRIPTION = (
        "Packs workflow values into an LC_PIPE (shared with Aspect / Sampler / Detail pipes). "
        "Connect any subset. Works with KJ Set/Get."
    )

    def pack(self, **kwargs):
        pipe = _empty()
        for key, _kind in SLOT_ORDER:
            val = kwargs.get(key)
            if _is_provided(val):
                pipe[key] = val
        return (pipe,)


class LCPipeOut:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "pipe": (PIPE_TYPE, {
                    "tooltip": "LC_PIPE from Pipe In, Pipe Edit, or KJ Get.",
                }),
            },
        }

    RETURN_TYPES = (PIPE_TYPE,) + tuple(_rtype(kind) for _, kind in SLOT_ORDER)
    RETURN_NAMES = ("pipe",) + tuple(DISPLAY[k] for k, _ in SLOT_ORDER)
    FUNCTION = "unpack"
    CATEGORY = "LC123/pipe"
    DESCRIPTION = "Unpacks a pipe back into separate sockets. The pipe keeps going out the top."

    def unpack(self, pipe):
        if not isinstance(pipe, dict):
            pipe = _empty()
        values = tuple(pipe.get(key) for key, _ in SLOT_ORDER)
        return (pipe,) + values


class LCPipeEdit:
    @classmethod
    def INPUT_TYPES(cls):
        optional = {
            "pipe": (PIPE_TYPE, {
                "tooltip": "Existing pipe to modify (optional).",
            }),
        }
        optional.update({key: _slot_input(key, kind) for key, kind in SLOT_ORDER})
        return {"required": {}, "optional": optional}

    RETURN_TYPES = (PIPE_TYPE,)
    RETURN_NAMES = ("pipe",)
    FUNCTION = "edit"
    CATEGORY = "LC123/pipe"
    DESCRIPTION = "Packs anything you wire into one pipe, so one wire carries it all. Wire a pipe in to change only what you connect; everything else rides along."

    def edit(self, pipe=None, **kwargs):
        base = dict(pipe) if isinstance(pipe, dict) else _empty()
        base["_type"] = PIPE_TYPE  # unify aspect/sampler/detail into LC_PIPE
        for key, _kind in SLOT_ORDER:
            val = kwargs.get(key)
            if _is_provided(val):
                base[key] = val
        return (base,)



DETAIL_SLOTS = [
    ("model_1", "MODEL"),
    ("clip_1", "CLIP"),
    ("vae_1", "VAE"),
    ("positive_prompt", "STRING"),
    ("positive", "CONDITIONING"),
    ("negative_prompt", "STRING"),
    ("negative", "CONDITIONING"),
    ("seed", "INT"),
    ("cfg_1", "FLOAT"),
    ("sampler_name", "SAMPLER_NAME"),
    ("scheduler", "SCHEDULER_NAME"),
    ("detailer_steps", "INT"),
]

DETAIL_DISPLAY = {
    "model_1": "Model 1",
    "clip_1": "Clip 1",
    "vae_1": "VAE 1",
    "positive_prompt": "Positive prompt",
    "positive": "Positive conditioning",
    "negative_prompt": "Negative prompt",
    "negative": "Negative conditioning",
    "seed": "Seed",
    "detailer_steps": "detailer_steps",
    "cfg_1": "cfg_1",
    "sampler_name": "sampler_name",
    "scheduler": "scheduler",
}


class LCDetailPipeOut:
    """Unpack a focused subset of LC_PIPE for detail / single-pass work."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "pipe": (PIPE_TYPE, {
                    "tooltip": "LC_PIPE from Pipe In/Edit, Aspect, Sampler, or KJ Get.",
                }),
            },
        }

    RETURN_TYPES = (PIPE_TYPE,) + tuple(_rtype(kind) for _, kind in DETAIL_SLOTS)
    RETURN_NAMES = ("pipe",) + tuple(DETAIL_DISPLAY[k] for k, _ in DETAIL_SLOTS)
    FUNCTION = "unpack"
    CATEGORY = "LC123/pipe"
    DESCRIPTION = "Unpacks what a detailer needs from a pipe: model, clip, VAE, prompts, seed, CFG, sampler, scheduler and detailer steps. The pipe keeps going out the top."

    def unpack(self, pipe):
        if not isinstance(pipe, dict):
            pipe = _empty()
        pipe = dict(pipe)
        pipe["_type"] = PIPE_TYPE
        values = tuple(pipe.get(key) for key, _ in DETAIL_SLOTS)
        return (pipe,) + values


class LCPipeCombine:
    """Top pipe, edited by the bottom pipe: every value set in edit_pipe overwrites the same slot in pipe."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "pipe": (PIPE_TYPE, {"tooltip": "The pipe to edit. Everything the edit pipe doesn't set passes through."}),
                "edit_pipe": (PIPE_TYPE, {"tooltip": "Its values overwrite the top pipe's. Empty slots are ignored."}),
            },
        }

    RETURN_TYPES = (PIPE_TYPE,)
    RETURN_NAMES = ("pipe",)
    FUNCTION = "combine"
    CATEGORY = "LC123/pipe"
    DESCRIPTION = "Edits the top pipe with the bottom one: whatever the edit pipe carries overwrites the top pipe, everything else rides along."

    def combine(self, pipe, edit_pipe):
        out = dict(pipe) if isinstance(pipe, dict) else _empty()
        if isinstance(edit_pipe, dict):
            for key, val in edit_pipe.items():
                if key != "_type" and _is_provided(val):
                    out[key] = _merged(key, out.get(key), val)
        out["_type"] = PIPE_TYPE
        return (out,)


NODE_CLASS_MAPPINGS = {
    "LCPipeOut": LCPipeOut,
    "LCPipeEdit": LCPipeEdit,
    "LCDetailPipeOut": LCDetailPipeOut,
    "LCPipeCombine": LCPipeCombine,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "LCPipeOut": "LC Pipe Out",
    "LCPipeEdit": "LC Pipe (in/edit)",
    "LCDetailPipeOut": "LC Detail Pipe Out",
    "LCPipeCombine": "LC Pipe Combine",
}
