"""
LC MiniMax H3 Pipe
------------------
Pack / unpack MiniMax H3 reference media.

Matches MiniMaxH3ReferenceToVideo (Comfy-Org / comfy-core):
  ref_image_0..8, ref_video_0..2, ref_video_audio_0..2, ref_audio_0..2
Prompt tags are 1-based: ref_image_0 = <Picture 1>.
In and Out use the same fixed socket list (no autogrow).

Pipe in accepts LC_H3_PIPE (full merge) or LC_PIPE from Aspect Ratio Simplifier
(width + height only — nothing else is copied).
"""

from __future__ import annotations

import comfy.samplers

PIPE_TYPE = "LC_H3_PIPE"
LC_PIPE = "LC_PIPE"
PIPE_TYPE_V2 = "LC_H3_PIPE_V2"

IMAGE_MAX = 9
VIDEO_MAX = 3
AUDIO_MAX = 3

# Only these keys are taken from an Aspect Ratio / LC_PIPE. Never models, image, mask, latent.
ARS_TAKE = ("width", "height")


def _optional_slot(key, kind, label):
    if kind == "INT":
        specs = {
            "width": dict(default=1344, min=16, max=16384, step=8, tooltip="Video width. ARS pipe on pipe fills this."),
            "height": dict(default=768, min=16, max=16384, step=8, tooltip="Video height."),
            "length": dict(default=124, min=5, max=3600, step=1, tooltip="Frame count. H3 is 24 fps; 124 ≈ 5s, 244 ≈ 10s."),
            "frame_rate": dict(default=24, min=1, max=120, step=1, tooltip="Frame rate. MiniMax H3 is trained at 24."),
        }
        opt = dict(specs.get(key, dict(default=0, min=0, max=0xFFFFFFFF)))
        opt["forceInput"] = True
        return (kind, opt)
    tooltips = {
        "fl2va_model": "First-last-frame to video UNET.",
        "fl2va_clip": "CLIP for FL2VA (MiniMaxH3ImageToVideo).",
        "ref2va_model": "Reference-to-video UNET.",
        "ref2va_clip": "CLIP for REF2VA (MiniMaxH3ReferenceToVideo).",
        "video_vae": "Video VAE (MiniMax vae).",
        "audio_vae": "Audio VAE (MiniMax audio_vae).",
    }
    return (kind, {"tooltip": tooltips.get(key, label)})


# Comma-joined "T1,T2,..." is the actual mechanism ComfyUI's socket-type
# checking understands at BOTH layers -- the frontend's own drag-connect
# validation, and the backend's validate_node_input() in
# comfy_execution/validation.py. A custom str subclass with a __ne__
# override (the previous approach here) only ever affects the backend
# check; confirmed live that it does not make the frontend allow the
# connection at all, so a fresh drag from Aspect Ratio Simplifier / LC
# Pipe was never actually connectable despite being documented as
# accepted -- this fixes that, purely by making more things connectable
# than before (nothing that already worked changes).
h3_pipe_in = f"{PIPE_TYPE},{LC_PIPE}"


def _empty():
    return {"_type": PIPE_TYPE}


def _is_provided(val):
    return val is not None


def _collect(kwargs, prefix, count):
    out = {}
    for i in range(count):
        key = f"{prefix}{i}"
        val = kwargs.get(key)
        if _is_provided(val):
            out[key] = val
    return out


HEAD_SLOTS = [
    ("fl2va_model", "MODEL", "fl2va_model"),
    ("fl2va_clip", "CLIP", "fl2va_clip"),
    ("ref2va_model", "MODEL", "ref2va_model"),
    ("ref2va_clip", "CLIP", "ref2va_clip"),
    ("video_vae", "VAE", "video_vae"),
    ("audio_vae", "VAE", "audio_vae"),
]

SIZE_SLOTS = [
    ("width", "INT", "width"),
    ("height", "INT", "height"),
    ("length", "INT", "length"),
    ("frame_rate", "INT", "frame_rate"),
]


def _slot_keys():
    keys = list(HEAD_SLOTS) + list(SIZE_SLOTS)
    for i in range(IMAGE_MAX):
        keys.append((f"ref_image_{i}", "IMAGE", f"ref_image_{i}"))
    for i in range(VIDEO_MAX):
        keys.append((f"ref_video_{i}", "IMAGE", f"ref_video_{i}"))
    for i in range(VIDEO_MAX):
        keys.append((f"ref_video_audio_{i}", "AUDIO", f"ref_video_audio_{i}"))
    for i in range(AUDIO_MAX):
        keys.append((f"ref_audio_{i}", "AUDIO", f"ref_audio_{i}"))
    return keys


def _merge_incoming(pipe):
    """H3 pipe → copy H3 fields. LC_PIPE (ARS) → width/height only."""
    base = _empty()
    if not isinstance(pipe, dict):
        return base
    t = pipe.get("_type")
    if t == PIPE_TYPE:
        for key, _kind, _label in _slot_keys():
            if key in pipe and pipe[key] is not None:
                base[key] = pipe[key]
        for group in ("ref_images", "ref_videos", "ref_video_audios", "ref_audios"):
            if isinstance(pipe.get(group), dict):
                base[group] = dict(pipe[group])
        # old single clip → both, if the new sockets were empty
        old = pipe.get("clip")
        if old is not None:
            base.setdefault("fl2va_clip", old)
            base.setdefault("ref2va_clip", old)
        return base
    for k in ARS_TAKE:
        if pipe.get(k) is not None:
            base[k] = pipe[k]
    return base


class LCMiniMaxH3Pipe:
    @classmethod
    def INPUT_TYPES(cls):
        optional = {
            "pipe": (h3_pipe_in, {
                "tooltip": "H3 pipe to merge, or Aspect Ratio Simplifier / LC Pipe (copies width + height only).",
            }),
        }
        for key, kind, label in _slot_keys():
            optional[key] = _optional_slot(key, kind, label)
        return {"required": {}, "optional": optional}

    RETURN_TYPES = (PIPE_TYPE,)
    RETURN_NAMES = ("pipe",)
    FUNCTION = "pack"
    CATEGORY = "LC123/pipe"
    DESCRIPTION = (
        "MiniMax H3 pipe in / edit. Same sockets as Pipe Out (all slots always shown, no autogrow). "
        "Pipe accepts an H3 pipe (full merge) or Aspect Ratio Simplifier / LC Pipe (width + height only)."
    )

    def pack(self, pipe=None, **kwargs):
        base = _merge_incoming(pipe)
        for key, _kind, _label in HEAD_SLOTS + SIZE_SLOTS:
            val = kwargs.get(key)
            if _is_provided(val):
                base[key] = val
        images = _collect(kwargs, "ref_image_", IMAGE_MAX)
        videos = _collect(kwargs, "ref_video_", VIDEO_MAX)
        video_audios = _collect(kwargs, "ref_video_audio_", VIDEO_MAX)
        audios = _collect(kwargs, "ref_audio_", AUDIO_MAX)
        if images:
            base["ref_images"] = {**base.get("ref_images", {}), **images}
            for k, v in images.items():
                base[k] = v
        if videos:
            base["ref_videos"] = {**base.get("ref_videos", {}), **videos}
            for k, v in videos.items():
                base[k] = v
        if video_audios:
            base["ref_video_audios"] = {**base.get("ref_video_audios", {}), **video_audios}
            for k, v in video_audios.items():
                base[k] = v
        if audios:
            base["ref_audios"] = {**base.get("ref_audios", {}), **audios}
            for k, v in audios.items():
                base[k] = v
        return (base,)


class LCMiniMaxH3PipeOut:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "pipe": (PIPE_TYPE, {
                    "tooltip": "LC MiniMax H3 Pipe.",
                }),
            },
        }

    RETURN_TYPES = (PIPE_TYPE,) + tuple(kind for _k, kind, _l in _slot_keys())
    RETURN_NAMES = ("pipe",) + tuple(label for _k, _kind, label in _slot_keys())
    FUNCTION = "unpack"
    CATEGORY = "LC123/pipe"
    DESCRIPTION = (
        "Unpacks an LC MiniMax H3 pipe. ref_image_0 = <Picture 1>. "
        "width / height come from the H3 pipe or from an Aspect Ratio Simplifier pipe merged upstream."
    )

    def unpack(self, pipe):
        if not isinstance(pipe, dict):
            pipe = _empty()
        values = tuple(pipe.get(key) for key, _kind, _label in _slot_keys())
        return (pipe,) + values


SAMPLING_SLOTS_V2 = [
    ("prompt", "STRING", "prompt"),
    ("total_steps", "INT", "total_steps"),
    ("cfg", "FLOAT", "cfg"),
    ("sampler_name", "SAMPLER", "sampler_name"),
    ("scheduler", "SCHEDULER", "scheduler"),
]


# Same comma-joined "T1,T2,..." mechanism as h3_pipe_in above -- accepts
# LC_H3_PIPE_V2 (full merge), LC_H3_PIPE (upgrades a V1 pipe -- reference
# media carries over, sampling fields take this node's own defaults/
# widgets), or LC_PIPE (Aspect Ratio Simplifier / LC Pipe, width + height
# only). Confirmed live this is what actually makes the connection
# draggable in the UI, not just backend-valid.
h3_pipe_in_v2 = f"{PIPE_TYPE_V2},{PIPE_TYPE},{LC_PIPE}"


def _empty_v2():
    return {"_type": PIPE_TYPE_V2}


def _merge_incoming_v2(pipe):
    """V2 pipe -> full merge (reference media + sampling fields).
    V1 H3 pipe -> upgrade: reference media merges in, sampling fields are
    left for this node's own widgets to set. LC_PIPE (ARS) -> width/height
    only, same as V1."""
    base = _empty_v2()
    if not isinstance(pipe, dict):
        return base
    t = pipe.get("_type")
    if t in (PIPE_TYPE_V2, PIPE_TYPE):
        for key, _kind, _label in _slot_keys():
            if key in pipe and pipe[key] is not None:
                base[key] = pipe[key]
        for group in ("ref_images", "ref_videos", "ref_video_audios", "ref_audios"):
            if isinstance(pipe.get(group), dict):
                base[group] = dict(pipe[group])
        old = pipe.get("clip")
        if old is not None:
            base.setdefault("fl2va_clip", old)
            base.setdefault("ref2va_clip", old)
        if t == PIPE_TYPE_V2:
            for key, _kind, _label in SAMPLING_SLOTS_V2:
                if key in pipe and pipe[key] is not None:
                    base[key] = pipe[key]
        return base
    for k in ARS_TAKE:
        if pipe.get(k) is not None:
            base[k] = pipe[k]
    return base


class LCMiniMaxH3PipeV2:
    @classmethod
    def INPUT_TYPES(cls):
        optional = {
            "pipe": (h3_pipe_in_v2, {
                "tooltip": "H3 Pipe V2 to merge, a V1 H3 pipe to upgrade (reference media only -- sampling fields use this node's own widgets), or Aspect Ratio Simplifier / LC Pipe (width + height only).",
            }),
        }
        for key, kind, label in _slot_keys():
            optional[key] = _optional_slot(key, kind, label)
        optional["prompt"] = ("STRING", {"multiline": True, "default": "", "tooltip": "Positive prompt text."})
        optional["total_steps"] = ("INT", {"default": 40, "min": 1, "max": 10000, "tooltip": "Sampling steps."})
        optional["cfg"] = ("FLOAT", {"default": 8.0, "min": 0.0, "max": 100.0, "step": 0.1, "tooltip": "Classifier-free guidance scale."})
        optional["sampler_name"] = (comfy.samplers.KSampler.SAMPLERS, {"default": "euler", "tooltip": "Sampler algorithm."})
        optional["scheduler"] = (comfy.samplers.KSampler.SCHEDULERS, {"default": "normal", "tooltip": "Noise schedule."})
        return {"required": {}, "optional": optional}

    RETURN_TYPES = (PIPE_TYPE_V2,)
    RETURN_NAMES = ("pipe",)
    FUNCTION = "pack"
    CATEGORY = "LC123/pipe"
    DESCRIPTION = (
        "MiniMax H3 pipe in / edit, V2 -- adds prompt / total_steps / cfg / sampler_name / scheduler on "
        "top of everything LC MiniMax H3 Pipe already carries, matching LC Sampler Configure's own "
        "field names and defaults. New pipe type (LC_H3_PIPE_V2) -- the original LC MiniMax H3 Pipe / "
        "Pipe Out are completely unchanged and unaffected by this node's existence, so no existing "
        "workflow can break from adding it."
    )

    def pack(self, pipe=None, prompt="", total_steps=40, cfg=8.0, sampler_name="euler", scheduler="normal", **kwargs):
        base = _merge_incoming_v2(pipe)
        for key, _kind, _label in HEAD_SLOTS + SIZE_SLOTS:
            val = kwargs.get(key)
            if _is_provided(val):
                base[key] = val
        images = _collect(kwargs, "ref_image_", IMAGE_MAX)
        videos = _collect(kwargs, "ref_video_", VIDEO_MAX)
        video_audios = _collect(kwargs, "ref_video_audio_", VIDEO_MAX)
        audios = _collect(kwargs, "ref_audio_", AUDIO_MAX)
        if images:
            base["ref_images"] = {**base.get("ref_images", {}), **images}
            for k, v in images.items():
                base[k] = v
        if videos:
            base["ref_videos"] = {**base.get("ref_videos", {}), **videos}
            for k, v in videos.items():
                base[k] = v
        if video_audios:
            base["ref_video_audios"] = {**base.get("ref_video_audios", {}), **video_audios}
            for k, v in video_audios.items():
                base[k] = v
        if audios:
            base["ref_audios"] = {**base.get("ref_audios", {}), **audios}
            for k, v in audios.items():
                base[k] = v
        base["prompt"] = prompt
        base["total_steps"] = total_steps
        base["cfg"] = cfg
        base["sampler_name"] = sampler_name
        base["scheduler"] = scheduler
        return (base,)


class LCMiniMaxH3PipeOutV2:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "pipe": (PIPE_TYPE_V2, {
                    "tooltip": "LC MiniMax H3 Pipe V2.",
                }),
            },
        }

    RETURN_TYPES = (
        (PIPE_TYPE_V2,)
        + tuple(kind for _k, kind, _l in _slot_keys())
        + ("STRING", "INT", "FLOAT", comfy.samplers.KSampler.SAMPLERS, comfy.samplers.KSampler.SCHEDULERS)
    )
    RETURN_NAMES = (
        ("pipe",)
        + tuple(label for _k, _kind, label in _slot_keys())
        + ("prompt", "total_steps", "cfg", "sampler_name", "scheduler")
    )
    FUNCTION = "unpack"
    CATEGORY = "LC123/pipe"
    DESCRIPTION = (
        "Unpacks an LC MiniMax H3 pipe V2. Same reference-media outputs as LC MiniMax H3 Pipe Out, plus "
        "prompt / total_steps / cfg / sampler_name / scheduler."
    )

    def unpack(self, pipe):
        if not isinstance(pipe, dict):
            pipe = _empty_v2()
        values = tuple(pipe.get(key) for key, _kind, _label in _slot_keys())
        prompt = pipe.get("prompt") or ""
        total_steps = pipe.get("total_steps")
        total_steps = int(total_steps) if total_steps is not None else 40
        cfg = pipe.get("cfg")
        cfg = float(cfg) if cfg is not None else 8.0
        sampler_name = pipe.get("sampler_name") or "euler"
        scheduler = pipe.get("scheduler") or "normal"
        return (pipe,) + values + (prompt, total_steps, cfg, sampler_name, scheduler)


NODE_CLASS_MAPPINGS = {
    "LCMiniMaxH3Pipe": LCMiniMaxH3Pipe,
    "LCMiniMaxH3PipeOut": LCMiniMaxH3PipeOut,
    "LCMiniMaxH3PipeV2": LCMiniMaxH3PipeV2,
    "LCMiniMaxH3PipeOutV2": LCMiniMaxH3PipeOutV2,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "LCMiniMaxH3Pipe": "LC MiniMax H3 Pipe",
    "LCMiniMaxH3PipeOut": "LC MiniMax H3 Pipe Out",
    "LCMiniMaxH3PipeV2": "LC MiniMax H3 Pipe V2",
    "LCMiniMaxH3PipeOutV2": "LC MiniMax H3 Pipe Out V2",
}
