"""
LC Optimizer engine, shared by the four LC Optimizer nodes (image, image pipe, video, video pipe).

Picks the model files for a base model and goal (from the System & Model Optimization Report when it has been
run, Comfy's defaults otherwise), downloads missing ones on first use, loads them through ComfyUI's own loaders
(split files, AIO checkpoints, GGUF via ComfyUI-GGUF or the calcuis gguf pack), applies the speed-ups that tested
fine on this machine, and checks the picked files against the base model from their headers alone (hints, never
a block).
"""

from __future__ import annotations

import json
import os
import re
import struct
import threading

import folder_paths

from . import lc_model_calc

RECOMMENDED = "★ Recommended"
DOWNLOAD = "⬇ Download: "
FROM_CKPT = "From checkpoint"
NONE = "None"
GOALS = ["Quality", "Optimal", "Fast"]

# which ComfyUI model folder a loader reads from
FOLDER_BY_LOADER = {
    "UNETLoader": "diffusion_models", "UNETLoader x2": "diffusion_models", "UnetLoaderGGUF": "diffusion_models",
    "CheckpointLoaderSimple": "checkpoints", "CLIPLoader": "text_encoders", "CLIPLoaderGGUF": "text_encoders",
    "LTXAVTextEncoderLoader": "text_encoders", "VAELoader": "vae", "LoraLoaderModelOnly": "loras",
    "LatentUpscaleModelLoader": "latent_upscale_models",
}
ROLE_FOLDERS = {
    "model": ["diffusion_models", "checkpoints"], "clip": ["text_encoders"], "vae": ["vae"], "audio_vae": ["vae", "checkpoints"],
    "upscaler": ["latent_upscale_models"], "lora": ["loras"],
}

# what each base model expects, read from the files ComfyUI ships (layers, hidden size, vision tower) and
# (latent channels, conv dims) for the VAE. Used only for hints.
TE_EXPECTS = {
    "anima": ("Qwen3 0.6B", 28, 1024, False), "flux2_klein_9b": ("Qwen3 8B", 36, 4096, False),
    "ideogram4": ("Qwen3-VL 8B", 36, 4096, True), "krea2": ("Qwen3-VL 4B", 36, 2560, True),
    "ltx23": ("Gemma 3 12B", 48, 3840, True), "ltx25": ("Gemma 4 12B", 48, 3840, True),
    "minimax_h3": ("Qwen3-VL 32B (H3)", 50, 5120, True), "qwen_image_21": ("Qwen3-VL 8B", 36, 4096, True),
    "z_image_turbo": ("Qwen3 4B", 36, 2560, False), "krea2_raw": ("Qwen3-VL 4B", 36, 2560, True),
}
TE_NAMES = {(28, 1024, False): "Qwen3 0.6B", (36, 2560, False): "Qwen3 4B", (36, 4096, False): "Qwen3 8B",
            (36, 2560, True): "Qwen3-VL 4B", (36, 4096, True): "Qwen3-VL 8B", (50, 5120, True): "Qwen3-VL 32B (H3)",
            (48, 3840, True): "Gemma 12B", (32, 4096, True): "Qwen3.5 9B", (32, 4096, False): "Llama 3.1 8B",
            (26, 2304, False): "Gemma 2 2B", (30, 5120, True): "Mistral Small 3", (35, 1536, True): "Gemma 4 E2B",
            (42, 2560, True): "Gemma 4 E4B"}
VAE_EXPECTS = {"anima": (16, 5), "krea2": (16, 5), "z_image_turbo": (16, 4), "flux2_klein_9b": (32, 4), "ideogram4": (32, 4),
               "qwen_image_21": (64, 5), "ltx25": (128, 2), "krea2_raw": (16, 5), "sdxl": (4, 4), "illustrious": (4, 4), "pony": (4, 4)}
VAE_NAMES = {(16, 4): "16-channel 2D (Flux 1 / Z-Image)", (16, 5): "16-channel 3D (Wan / Qwen-Image)", (32, 4): "32-channel (Flux 2)",
             (64, 5): "64-channel (Qwen-Image 2.1)", (4, 4): "4-channel (SD / SDXL)", (128, 2): "128-channel (LTX)"}
MODEL_CLASSES = {"anima": "Anima", "flux2_klein_9b": "Flux2", "ideogram4": "Ideogram4", "krea2": "Krea2", "ltx23": "LTXAV",
                 "ltx25": "LTXAV", "minimax_h3": "MiniMaxH3", "qwen_image_21": "QwenImage21", "z_image_turbo": "ZImage",
                 "krea2_raw": "Krea2", "sdxl": "SDXL", "illustrious": "SDXL", "pony": "SDXL"}


# the extra parts each base model uses (the nodes are static; this only decides which pickers matter)
EXTRAS = {
    "minimax_h3": [("audio_vae", "VAE")],
    "ltx23": [("audio_vae", "VAE"), ("latent_upscaler", "LATENT_UPSCALE_MODEL")],
    "ltx25": [("audio_vae", "VAE"), ("latent_upscaler", "LATENT_UPSCALE_MODEL")],
    "ideogram4": [("model_2", "MODEL")],
}
MAX_EXTRAS = 2

# "Custom": any model and workflow. No files, numbers or checks are known for it, so those show as unsupported;
# the speed-ups from the report still apply.
CUSTOM = {"custom": "image", "custom_video": "video"}
CUSTOM_NAME = "Custom"
UNSUPPORTED = "unsupported"
CLIP_AUTO = "auto"


def is_custom(profile_id):
    return profile_id in CUSTOM


def checkpoint_only(profile_id):
    """Base models shipped as one checkpoint (the SDXL family): the text encoder and VAE come from it."""
    prof = profiles().get(profile_id) or {}
    vs = variants(prof, "model") if prof.get("components") else []
    return bool(vs) and all(v.get("loader") == "CheckpointLoaderSimple" for v in vs)


def roles_for(profile_id):
    """The file pickers this base model uses."""
    prof = profiles().get(profile_id) or {}
    roles = ["model", "clip", "vae"]
    if profile_id == "custom_video":
        return roles + ["audio_vae", "upscaler", "lora"]
    extras = [n for n, _ in EXTRAS.get(profile_id, [])]
    if "audio_vae" in extras:
        roles.append("audio_vae")
    if "latent_upscaler" in extras:
        roles.append("upscaler")
    if prof and variants(prof, "lora"):
        roles.append("lora")
    return roles


# ---------------------------------------------------------------- profiles, report, files on disk
def profiles(kind=None):
    out = dict(lc_model_calc.load_profiles())
    for pid, k in CUSTOM.items():
        out[pid] = {"id": pid, "name": CUSTOM_NAME, "kind": k, "custom": True, "components": {}, "notes": []}
    return {k: v for k, v in out.items() if kind is None or v.get("kind") == kind}


def base_names(kind):
    """[(id, name)] for the base model dropdown, image or video. Custom goes last."""
    return sorted(((k, v["name"]) for k, v in profiles(kind).items()), key=lambda x: (is_custom(x[0]), x[1].lower()))


def clip_types(kind):
    """The text encoder types a Custom pick can use (CLIPLoader's list, plus LTX 2.3's own loader for video)."""
    try:
        import nodes

        types = list(nodes.NODE_CLASS_MAPPINGS["CLIPLoader"].INPUT_TYPES()["required"]["type"][0])
    except Exception:
        types = ["stable_diffusion"]
    if kind == "video":
        types.append("LTXAVTextEncoderLoader")
    return [CLIP_AUTO] + types


def auto_clip_type(path):
    """Custom + auto: the clip type of the known base models whose text encoder has this shape, when only one fits."""
    sig = te_signature(path) if path else None
    if sig is None:
        return None, []
    found = set()
    for pid, want in TE_EXPECTS.items():
        if want[1:] == sig:
            prof = profiles().get(pid) or {}
            found |= {c.get("clip_type") for c in prof.get("components", {}).values() if c.get("role") == "text_encoder" and c.get("clip_type")}
    return (found.pop() if len(found) == 1 else None), sorted(found)


def report():
    """The saved System & Model Optimization Report, or None when it has not been run."""
    try:
        from . import lc_system_check

        with open(lc_system_check.profile_path(), encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def _list(folder):
    names = []
    try:
        names += folder_paths.get_filename_list(folder)
    except Exception:
        pass
    gguf_key = {"diffusion_models": "unet_gguf", "text_encoders": "clip_gguf"}.get(folder)
    if gguf_key and gguf_key in folder_paths.folder_names_and_paths:
        try:
            names += [n for n in folder_paths.get_filename_list(gguf_key) if n not in names]
        except Exception:
            pass
    elif folder in ("diffusion_models", "text_encoders"):  # no GGUF pack: list the .gguf files ourselves
        for root in folder_paths.get_folder_paths(folder):
            for dp, _, fs in os.walk(root, followlinks=True):
                for f in fs:
                    if f.lower().endswith(".gguf"):
                        rel = os.path.relpath(os.path.join(dp, f), root)
                        if rel not in names:
                            names.append(rel)
    return names


def local_files(role):
    """[(folder, relative name)] of everything a role can load, all subfolders."""
    out = []
    for folder in ROLE_FOLDERS[role]:
        out += [(folder, n) for n in _list(folder)]
    return out


def find_on_disk(filename, folders):
    base = filename.lower()
    for folder in folders:
        for n in _list(folder):
            if os.path.basename(n.replace("\\", "/")).lower() == base:
                return folder, n
    return None


def full_path(folder, name):
    p = folder_paths.get_full_path(folder, name)
    if p:
        return p
    for root in folder_paths.get_folder_paths(folder):  # .gguf listed by us when no GGUF pack registered its folder
        cand = os.path.join(root, name)
        if os.path.exists(cand):
            return cand
    return None


# ---------------------------------------------------------------- roles per profile
def role_of(variant, comp_role):
    ld = variant.get("loader", "")
    if comp_role == "diffusion":
        return "model"
    if comp_role == "text_encoder":
        return "clip"
    if ld == "VAELoader":
        return "audio_vae" if "audio" in variant["file"].lower() else "vae"
    if ld == "LatentUpscaleModelLoader":
        return "upscaler"
    if ld == "LoraLoaderModelOnly":
        return "lora"
    return None


def variants(profile, role):
    out = []
    for comp in profile["components"].values():
        for v in comp["variants"]:
            if role_of(v, comp["role"]) == role:
                out.append(dict(v, clip_type=comp.get("clip_type")))
    return out


def recommended(profile, role, goal):
    """The file the report (or Comfy's default) picks for this role, with its details."""
    return _prefer_on_disk(role, _recommended(profile, role, goal), profile)


def _recommended(profile, role, goal):
    vs = variants(profile, role)
    if not vs:
        return None
    sysp = report()
    if sysp:
        try:
            rec = lc_model_calc.recommend(profile, sysp, goal)
            files = {p["file"]: p for p in rec["picks"]}
            for v in vs:
                if v["file"] in files:
                    return dict(v, pick=files[v["file"]], source="report")
        except Exception:
            pass
    v = next((v for v in vs if v.get("default") or v.get("always")), vs[0])
    return dict(v, source="default")


def _prefer_on_disk(role, rec, prof):
    """For the small fixed parts (VAEs), a variant already on disk beats downloading the default."""
    if not rec or role not in ("vae", "audio_vae"):
        return rec
    folder = FOLDER_BY_LOADER.get(rec["loader"], ROLE_FOLDERS[role][0])
    if find_on_disk(rec["file"], [folder]):
        return rec
    for v in variants(prof, role):
        if find_on_disk(v["file"], [FOLDER_BY_LOADER.get(v["loader"], folder)]):
            return dict(v, source="on disk")
    return rec


def choices(profile_id, role, goal):
    """What the picker shows: the recommended file, downloads for the profile's files not on disk, local files
    (files known for this base model first)."""
    prof = profiles().get(profile_id)
    out = {"recommended": None, "downloads": [], "local": [], "known": [], "unsupported": is_custom(profile_id)}
    if not prof:
        return out
    rec = recommended(prof, role, goal)
    folders = ROLE_FOLDERS[role]
    if role == "model":  # Lonecat's featured models first (Krealism V3.1 for Krea 2 Turbo)
        for m in shipped_all():
            if m.get("featured") and m.get("profile") == profile_id and not find_on_disk(m["file"], ROLE_FOLDERS[role]):
                out["downloads"].append({"value": DOWNLOAD + m["file"], "file": m["file"], "gb": m.get("gb"), "format": m.get("format"),
                                         "community": False, "gated": False, "featured": m["family"]})
    if rec:
        hit = find_on_disk(rec["file"], [FOLDER_BY_LOADER.get(rec["loader"], folders[0])])
        out["recommended"] = {"file": rec["file"], "gb": rec.get("gb"), "on_disk": bool(hit), "source": rec["source"]}
    known = set()
    for v in variants(prof, role):
        hit = find_on_disk(v["file"], [FOLDER_BY_LOADER.get(v["loader"], folders[0])])
        if hit:
            known.add(hit[1])
        elif not v.get("unconfirmed"):
            out["downloads"].append({"value": DOWNLOAD + v["file"], "file": v.get("display") or v["file"], "gb": v.get("gb"), "format": v.get("format"),
                                     "community": bool(v.get("community")), "gated": v["repo"].startswith(("black-forest-labs",))})
    out["local"] = [n for _, n in local_files(role)]
    if role == "model":  # every version of Lonecat's own models made for this base model
        known.update(n for _, n in local_files(role) if own_profile(n) == profile_id)
    out["known"] = sorted(known)
    return out


# ---------------------------------------------------------------- header checks (hints only, nothing is loaded)
_SIG_CACHE = {}


def _header_shapes(path):
    key = (path, os.path.getmtime(path))
    if key in _SIG_CACHE:
        return _SIG_CACHE[key]
    if path.lower().endswith(".gguf"):
        try:
            import gguf  # ships with ComfyUI-GGUF
        except Exception:
            _SIG_CACHE[key] = None
            return None
        r = gguf.GGUFReader(path)
        shapes = {t.name: list(reversed([int(x) for x in t.shape])) for t in r.tensors}
        dtypes = {}
    else:
        with open(path, "rb") as f:
            n = struct.unpack("<Q", f.read(8))[0]
            h = json.loads(f.read(n))
        h.pop("__metadata__", None)
        shapes = {k: v["shape"] for k, v in h.items()}
        dtypes = {k: v["dtype"] for k, v in h.items()}
    _SIG_CACHE[key] = (shapes, dtypes)
    return _SIG_CACHE[key]


def te_signature(path):
    got = _header_shapes(path)
    if not got:
        return None
    shapes = got[0]
    layers = set()
    for k in shapes:
        m = re.search(r"(?:^|\.)(?:layers|blk)\.(\d+)\.", k)
        if m and "visual" not in k and "vision" not in k:
            layers.add(int(m.group(1)))
    emb = next((v for k, v in shapes.items() if re.search(r"embed_tokens\.weight$|token_embd\.weight$", k)), None)
    if not layers or not emb:
        return None
    return (len(layers), emb[-1], any("visual" in k or "vision" in k for k in shapes))


def vae_signature(path):
    got = _header_shapes(path)
    if not got:
        return None
    for k, s in got[0].items():
        if re.search(r"(?:^|\.)decoder\.(conv_in|conv1)(\.conv)?\.weight$", k) and not k.startswith("audio_vae"):
            return (s[1], len(s))
    return None


def model_class(path):
    """ComfyUI's own model detection, run on empty placeholder tensors built from the header."""
    got = _header_shapes(path)
    if not got or path.lower().endswith(".gguf"):
        return None
    import torch
    import comfy.model_detection

    shapes, dtypes = got
    dt = {"F32": torch.float32, "BF16": torch.bfloat16, "F16": torch.float16}
    sd = {k: torch.empty(s, dtype=dt.get(dtypes.get(k), torch.uint8), device="meta") for k, s in shapes.items()}
    try:
        prefix = comfy.model_detection.unet_prefix_from_state_dict(sd)
        cfg = comfy.model_detection.model_config_from_unet(sd, prefix)
        return type(cfg).__name__ if cfg else None
    except Exception:
        return None


def check_files(profile_id, picks):
    """Hints for known mismatches. picks: {role: path or None}. Returns [(icon, text)]."""
    prof = profiles().get(profile_id, {})
    name = prof.get("name", profile_id)
    hints = []
    p = picks.get("model")
    if is_custom(profile_id):
        cls = model_class(p) if p else None
        if cls:
            hints.append(("ℹ️", f"This model file looks like {cls}."))
        return hints
    if p and profile_id in MODEL_CLASSES:
        cls = model_class(p)
        want = MODEL_CLASSES[profile_id]
        if cls and cls != want and not (want == "ZImage" and cls.startswith("ZImage")):
            hints.append(("⚠️", f"This model file looks like {cls}, not {name}. Check the base model setting."))
    p = picks.get("clip")
    if p and checkpoint_only(profile_id) and MODEL_CLASSES.get(profile_id) == "SDXL":
        hints.append(("⚠️", f"{name} needs CLIP-L and CLIP-G together. One text encoder file loads as a single CLIP: expect errors. "
                             "Leave the text encoder blank to use the checkpoint's own."))
    elif p and profile_id in TE_EXPECTS:
        want = TE_EXPECTS[profile_id]
        sig = te_signature(p)
        if sig is None:
            hints.append(("ℹ️", "Could not check this text encoder."))
        elif sig != want[1:]:
            got = TE_NAMES.get(sig, f"{sig[0]} layers, width {sig[1]}{', with vision' if sig[2] else ''}")
            hints.append(("⚠️", f"{name} expects {want[0]}. This text encoder looks like {got}: expect errors or bad results."))
    p = picks.get("vae")
    if p and profile_id in VAE_EXPECTS:
        sig = vae_signature(p)
        want = VAE_EXPECTS[profile_id]
        if sig and sig != want:
            hints.append(("⚠️", f"{name} expects a {VAE_NAMES.get(want, want)} VAE. This one is {VAE_NAMES.get(sig, f'{sig[0]}-channel')}: expect errors or wrong colors."))
    return hints


# ---------------------------------------------------------------- downloads (first run, like LC Vision)
_DL_LOCK = threading.Lock()


def _repo_path(repo, filename):
    """Where the file sits inside the Hugging Face repo (Comfy-Org repos keep them in split_files/...)."""
    try:
        from huggingface_hub import HfApi

        files = HfApi().list_repo_files(repo)
    except Exception:
        import urllib.request

        with urllib.request.urlopen(f"https://huggingface.co/api/models/{repo}/tree/main?recursive=true", timeout=30) as r:
            files = [x["path"] for x in json.load(r) if x.get("type") == "file"]
    for f in files:
        if f.split("/")[-1] == filename:
            return f
    raise FileNotFoundError(f"[LC Optimizer] {filename} is not in https://huggingface.co/{repo}")


def download(variant):
    """Download a profile file into the root of its ComfyUI model folder. Returns (folder, name)."""
    folder = FOLDER_BY_LOADER.get(variant["loader"], "diffusion_models")
    hit = find_on_disk(variant["file"], [folder])
    if hit:
        return hit
    target = folder_paths.get_folder_paths(folder)[0]
    os.makedirs(target, exist_ok=True)
    dest = os.path.join(target, variant["file"])
    with _DL_LOCK:
        repo = variant["repo"]
        path_in_repo = _repo_path(repo, variant["file"])
        print(f"[LC Optimizer] Downloading {variant['file']} ({variant.get('gb', '?')} GB) from {repo} ...")
        try:
            from huggingface_hub import hf_hub_download

            got = hf_hub_download(repo_id=repo, filename=path_in_repo, local_dir=target)
            if os.path.abspath(got) != os.path.abspath(dest):
                os.replace(got, dest)
                sub = os.path.join(target, path_in_repo.split("/")[0])
                if "/" in path_in_repo and os.path.isdir(sub):
                    try:
                        for dp, dn, fn in os.walk(sub, topdown=False):
                            if not fn and not dn:
                                os.rmdir(dp)
                    except OSError:
                        pass
        except ImportError:
            import urllib.request

            part = dest + ".part"
            urllib.request.urlretrieve(f"https://huggingface.co/{repo}/resolve/main/{path_in_repo}", part)
            os.replace(part, dest)
        except Exception as e:
            if "401" in str(e) or "403" in str(e) or "gated" in str(e).lower():
                raise RuntimeError(f"[LC Optimizer] {repo} is gated: accept its license on https://huggingface.co/{repo} and log in "
                                   "with `huggingface-cli login`, or pick another file.") from e
            raise
    print(f"[LC Optimizer] Finished downloading {variant['file']}.")
    folder_paths.filename_list_cache.clear() if hasattr(folder_paths, "filename_list_cache") else None
    return folder, os.path.relpath(dest, target)


# ---------------------------------------------------------------- Lonecat's own models (Krealism, Animosity)
# Never a choice in the picker. When a workflow opens with one of these as its model file and the file is missing,
# it downloads from Lonecat's Hugging Face repo into the same folder path the workflow saved, so the value stays valid.
_SHIPPED = None


def shipped(name):
    global _SHIPPED
    if _SHIPPED is None:
        _SHIPPED = {}
        try:
            path = os.path.join(os.path.dirname(__file__), "optimizer_shipped_models.json")
            for m in json.load(open(path, encoding="utf-8")).get("models", []):
                for n in m.get("names", []):
                    _SHIPPED[n.lower()] = m
        except Exception:
            pass
    return _SHIPPED.get(os.path.basename(str(name).replace("\\", "/")).lower())


def shipped_all():
    shipped("")  # loads the list
    return list({id(m): m for m in _SHIPPED.values()}.values())


# Lonecat's model families by name, for files the shipped list does not name (other versions, renamed files)
_OWN = [(re.compile(r"krealism[ _-]?v\d", re.I), "krea2"),
        (re.compile(r"animosity.*krea|krea.*animosity", re.I), "krea2"),
        (re.compile(r"animosity.*illustrious", re.I), "illustrious"),
        (re.compile(r"animosity.*anima", re.I), "anima")]


def own_profile(name):
    """The base model one of Lonecat's own model files (Krealism, Animosity) is for, or None."""
    entry = shipped(name)
    if entry:
        return entry.get("profile")
    base = os.path.basename(str(name).replace("\\", "/"))
    return next((pid for rx, pid in _OWN if rx.search(base)), None)


def download_shipped(entry, value, folder="diffusion_models"):
    """Download one of Lonecat's models to <folder root>/<the path the workflow saved>. Returns (folder, value)."""
    root = folder_paths.get_folder_paths(folder)[0]
    dest = os.path.join(root, value.replace("\\", "/"))
    if os.path.exists(dest):
        return folder, value
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    with _DL_LOCK:
        print(f"[LC Optimizer] The workflow uses {entry['family']} ({os.path.basename(dest)}, {entry['gb']} GB): downloading from "
              f"https://huggingface.co/{entry['repo']} ...")
        tmp = os.path.join(os.path.dirname(dest), ".lc_download")
        try:
            from huggingface_hub import hf_hub_download

            got = hf_hub_download(repo_id=entry["repo"], filename=entry["path"], local_dir=tmp)
        except ImportError:
            import urllib.request

            got = os.path.join(tmp, os.path.basename(entry["path"]))
            os.makedirs(tmp, exist_ok=True)
            urllib.request.urlretrieve(f"https://huggingface.co/{entry['repo']}/resolve/main/{entry['path']}", got + ".part")
            os.replace(got + ".part", got)
        os.replace(got, dest)
        try:
            import shutil

            shutil.rmtree(tmp, ignore_errors=True)
        except Exception:
            pass
    print(f"[LC Optimizer] Finished downloading {os.path.basename(dest)}.")
    return folder, value


# ---------------------------------------------------------------- resolve a widget value to a file
def resolve(profile_id, role, value, goal):
    """Widget value -> (folder, name, variant or None). Downloads when needed. None for 'None' / From checkpoint."""
    if value in (NONE, FROM_CKPT, "", None):
        return None
    prof = profiles().get(profile_id)
    vs = variants(prof, role) if prof else []
    if value == RECOMMENDED:
        rec = recommended(prof, role, goal) if prof else None
        if not rec:
            return None
        v = rec
    elif value.startswith(DOWNLOAD):
        if is_custom(profile_id):
            raise FileNotFoundError(f"[LC Optimizer] Custom: downloads are {UNSUPPORTED}. Pick a file you have for the {role}.")
        fname = value[len(DOWNLOAD):]
        v = next((x for x in vs if x["file"] == fname), None)
        if v is None:
            for other in profiles().values():  # the base model changed after picking: still find it
                v = next((x for x in variants(other, role) if x["file"] == fname), None)
                if v:
                    break
        if v is None:
            entry = shipped(fname) if role == "model" else None
            if entry:  # one of Lonecat's models, offered as a featured download
                hit = find_on_disk(entry["file"], ROLE_FOLDERS[role])
                if hit:
                    return hit[0], hit[1], None
                folder, name = download_shipped(entry, f"{entry['family']}/{entry['file']}", entry.get("folder", "diffusion_models"))
                return folder, name, None
            raise FileNotFoundError(f"[LC Optimizer] No download known for {fname}.")
    else:
        for folder in ROLE_FOLDERS[role]:
            if value in _list(folder):
                v = next((x for x in vs if x["file"] == os.path.basename(value.replace("\\", "/"))), None)
                return folder, value, v
        entry = shipped(value) if role == "model" else None
        if entry:
            folder, name = download_shipped(entry, value, entry.get("folder", "diffusion_models"))  # checkpoints (SDXL family) go to checkpoints
            return folder, name, None
        raise FileNotFoundError(f"[LC Optimizer] {value} was not found in the {'/'.join(ROLE_FOLDERS[role])} folders.")
    folder = FOLDER_BY_LOADER.get(v["loader"], ROLE_FOLDERS[role][0])
    hit = find_on_disk(v["file"], [folder]) or download(v)
    return hit[0], hit[1], v


# ---------------------------------------------------------------- what a node actually loads (for LC Save Metadata)
_META_ROLES = {"model_file": ("model", "diffusion_models"), "text_encoder": ("clip", "text_encoders"), "vae": ("vae", "vae"),
               "audio_vae": ("audio_vae", "vae"), "latent_upscaler": ("upscaler", "latent_upscale_models"), "lora": ("lora", "loras")}


def loaded_files(inputs):
    """[(file name relative to its folder, folder)] an LC Model Optimizer node loads with these inputs. Never downloads:
    by the time metadata is written the node has run, so the files are on disk."""
    out = []
    base = inputs.get("base_model")
    pid = next((p for p, n in base_names(None) if n == base), None)
    prof = profiles().get(pid) if pid else None
    goal = inputs.get("goal") or "Optimal"
    roles = roles_for(pid) if pid else ["model", "clip", "vae"]
    for widget, (role, folder) in _META_ROLES.items():
        value = inputs.get(widget)
        if role not in roles or not isinstance(value, str) or value in (NONE, FROM_CKPT, ""):
            continue
        try:
            if value == RECOMMENDED or value.startswith(DOWNLOAD):
                if value == RECOMMENDED:
                    v = recommended(prof, role, goal) if prof else None
                    fname = v["file"] if v else None
                    folder = FOLDER_BY_LOADER.get(v["loader"], folder) if v else folder
                else:
                    fname = value[len(DOWNLOAD):]
                hit = find_on_disk(fname, [folder] + [f for f in ROLE_FOLDERS.get(role, []) if f != folder]) if fname else None
                if hit:
                    out.append((hit[1], hit[0]))
            else:
                hit = next(((value, f) for f in ROLE_FOLDERS.get(role, [folder]) if value in _list(f)), None)
                out.append(hit or (value, folder))
        except Exception:
            continue
    return out


# ---------------------------------------------------------------- loading through ComfyUI's own loaders
def _node(name):
    import nodes

    cls = nodes.NODE_CLASS_MAPPINGS.get(name)
    if cls is None:
        raise RuntimeError(f"[LC Optimizer] The {name} loader is not installed.")
    return cls


def _call(name, **kw):
    cls = _node(name)
    if hasattr(cls, "execute") and hasattr(cls, "define_schema"):  # new-style io.ComfyNode
        out = cls.execute(**kw)
        return tuple(out.result) if hasattr(out, "result") else tuple(out)
    inst = cls()
    return tuple(getattr(inst, cls.FUNCTION)(**kw))


def load_model(folder, name):
    """-> (model, clip or None, vae or None, how)"""
    if folder == "checkpoints":
        m, c, v = _call("CheckpointLoaderSimple", ckpt_name=name)
        return m, c, v, "checkpoint"
    if name.lower().endswith(".gguf"):
        import nodes

        if "UnetLoaderGGUF" in nodes.NODE_CLASS_MAPPINGS:
            try:
                return _call("UnetLoaderGGUF", unet_name=name)[0], None, None, "GGUF"
            except Exception as e:
                if "LoaderGGUF" not in nodes.NODE_CLASS_MAPPINGS:
                    raise
                print(f"[LC Optimizer] ComfyUI-GGUF could not load {name} ({e}); trying the calcuis gguf pack.")
        if "LoaderGGUF" in nodes.NODE_CLASS_MAPPINGS:
            return _call("LoaderGGUF", gguf_name=name)[0], None, None, "GGUF (calcuis)"
        raise RuntimeError("[LC Optimizer] GGUF files need the ComfyUI-GGUF pack (install it from ComfyUI-Manager).")
    return _call("UNETLoader", unet_name=name, weight_dtype="default")[0], None, None, "diffusion model"


def load_clip(folder, name, clip_type, ckpt_name=None):
    if clip_type == "LTXAVTextEncoderLoader":
        if not ckpt_name:
            raise RuntimeError("[LC Optimizer] LTX 2.3's text encoder also reads the LTX 2.3 checkpoint: pick a checkpoint as the model.")
        return _call("LTXAVTextEncoderLoader", text_encoder=name, ckpt_name=ckpt_name)[0]
    if name.lower().endswith(".gguf"):
        import nodes

        if "CLIPLoaderGGUF" in nodes.NODE_CLASS_MAPPINGS:
            return _call("CLIPLoaderGGUF", clip_name=name, type=clip_type)[0]
        if "ClipLoaderGGUF" in nodes.NODE_CLASS_MAPPINGS:
            return _call("ClipLoaderGGUF", clip_name=name, type=clip_type)[0]
        raise RuntimeError("[LC Optimizer] GGUF text encoders need the ComfyUI-GGUF pack.")
    return _call("CLIPLoader", clip_name=name, type=clip_type)[0]


def load_vae(folder, name, audio=False):
    if audio and folder == "checkpoints":
        return _call("LTXVAudioVAELoader", ckpt_name=name)[0]
    return _call("VAELoader", vae_name=name)[0]


def load_upscaler(name):
    return _call("LatentUpscaleModelLoader", model_name=name)[0]


def apply_lora(model, name, strength=1.0):
    return _call("LoraLoaderModelOnly", model=model, lora_name=name, strength_model=strength)[0]


# ---------------------------------------------------------------- speed-ups
ATTENTION = ["auto", "pytorch", "sage", "sage3", "flash", "xformers", "comfy_kitchen_int8"]
ATTN_LABEL = {"pytorch": "Standard (PyTorch)", "sage": "Sage", "sage3": "Sage 3", "flash": "Flash", "xformers": "xformers",
              "comfy_kitchen_int8": "Comfy Kitchen int8"}


QWEN_CACHE = {"lossless": ("auto", "default"), "int8": ("auto", "int8"), "int4": ("auto", "int4"), "RAM": ("cpu", "default"),
              "RAM + int8": ("cpu", "int8"), "off": ("off", "default")}
QWEN_CACHE_LABEL = {"lossless": "lossless", "int8": "int8", "int4": "int4", "RAM": "in RAM", "RAM + int8": "int8 in RAM", "off": "off"}


def _registered():
    try:
        from comfy.ldm.modules.attention import REGISTERED_ATTENTION_FUNCTIONS

        return set(REGISTERED_ATTENTION_FUNCTIONS)
    except Exception:
        return {"pytorch"}


def plan_speedups(profile_id, goal, manual=None):
    """What to apply and why. manual: {attention, fp16_accumulation, step_cache, torch_compile} or None (Auto).
    Returns [{key, label, state: on/off/na, value, why}]."""
    sysp = report() or {}
    t = sysp.get("tests") or {}
    reg = _registered()
    steps = lc_model_calc.STEPS.get(profile_id, 20)
    manual = manual or {}
    rows = []

    # attention: the fastest one that ran AND matched standard attention in the report
    want = manual.get("attention", "auto")
    if want == "auto":
        pick = next((k for k, tk in (("sage", "sageattention"), ("flash", "flash_attn")) if (t.get(tk) or {}).get("ok") and k in reg), None)
        if pick:
            why = f"{(t.get('sageattention' if pick == 'sage' else 'flash_attn') or {}).get('detail', 'tested fine')}"
            rows.append({"key": "attention", "label": f"Attention: {ATTN_LABEL[pick]}", "state": "on", "value": pick, "why": why})
        else:
            why = "Sage not installed or failed its test: see Recommended to install in the report" if sysp else "run the report to pick one"
            rows.append({"key": "attention", "label": "Attention: standard", "state": "off", "value": None, "why": why})
    elif want == "pytorch" or want in reg:
        rows.append({"key": "attention", "label": f"Attention: {ATTN_LABEL.get(want, want)}", "state": "on", "value": want, "why": "set by hand"})
    else:
        rows.append({"key": "attention", "label": f"Attention: {ATTN_LABEL.get(want, want)}", "state": "na", "value": None, "why": "not installed: see Recommended to install in the report"})

    kit = sysp.get("kitchen") or {}
    if kit.get("installed"):
        cuda = ((kit.get("backends") or {}).get("cuda") or {}).get("available")
        rows.append({"key": "kitchen", "label": "Comfy Kitchen (int8 / fp8 / nvfp4 files)", "state": "on" if cuda else "off", "value": None,
                     "why": "used automatically for those files" if cuda else "GPU backend not available: slower path"})
    elif sysp:
        rows.append({"key": "kitchen", "label": "Comfy Kitchen", "state": "na", "value": None, "why": "not installed: see Recommended to install in the report"})

    want = manual.get("fp16_accumulation", "auto")
    fp16_ok = (t.get("matmul_fp16") or {}).get("ok")
    on = want == "on" or (want == "auto" and goal == "Fast" and fp16_ok)
    rows.append({"key": "fp16_accumulation", "label": "fp16 accumulation", "state": "on" if on else "off", "value": bool(on),
                 "why": "set by hand" if want != "auto" else ("Fast goal" if on else "Fast goal only (small quality cost)")})

    want = manual.get("step_cache", "auto")
    on = want == "on" or (want == "auto" and goal == "Fast" and steps >= 20)
    why = "set by hand" if want != "auto" else ("Fast goal, skips near-duplicate steps" if on else
                                                 ("Fast goal only" if steps >= 20 else f"not worth it at {steps} steps"))
    rows.append({"key": "step_cache", "label": "Step cache (EasyCache)", "state": "on" if on else "off", "value": bool(on), "why": why})

    if profile_id == "qwen_image_21":
        # Qwen Image 2.1 Cache (ComfyUI core): where the KV cache lives and how it is stored. int4 is never picked
        # automatically: its tooltip says it roughly doubles the per-step error.
        want = manual.get("qwen21_cache", "auto")
        vram = ((sysp.get("gpus") or [{}])[0].get("vram_gb") or 0)
        if want == "auto":
            if goal == "Fast" or (goal == "Optimal" and vram and vram < 16):
                want, why = "int8", ("Fast goal" if goal == "Fast" else f"{vram:g} GB card: halves the cache, about bf16 accuracy")
            else:
                want, why = "lossless", "Comfy's default: spare VRAM first, then RAM"
        else:
            why = "set by hand"
        dev, dt = QWEN_CACHE[want]
        # "off" is the one choice that turns the cache off; every other choice is an active cache
        rows.append({"key": "qwen21_cache", "label": f"Qwen 2.1 cache: {QWEN_CACHE_LABEL[want]}",
                     "state": "off" if want == "off" else "on", "value": (dev, dt), "why": why})

    want = manual.get("torch_compile", "off")
    tri = (t.get("triton") or {}).get("ok")
    if want == "on":
        rows.append({"key": "torch_compile", "label": "torch.compile", "state": "on" if tri or not sysp else "na", "value": True,
                     "why": "first run compiles (slow), later runs are faster" if tri or not sysp else "Triton failed the report's test"})
    return rows


def apply_speedups(model, rows):
    m = model.clone()
    applied = []
    for r in rows:
        if r["state"] != "on" and r["key"] != "qwen21_cache":  # the cache is set even when switched off
            continue
        if r["key"] == "attention" and r["value"]:
            from comfy.ldm.modules.attention import get_attention_function

            m.set_model_optimized_attention(get_attention_function(r["value"]))
            applied.append(r["label"])
        elif r["key"] == "fp16_accumulation":
            import torch
            import comfy.patcher_extension as pe

            def outer(executor, *args, **kwargs):
                old = getattr(torch.backends.cuda.matmul, "allow_fp16_accumulation", False)
                try:
                    torch.backends.cuda.matmul.allow_fp16_accumulation = True
                    return executor(*args, **kwargs)
                finally:
                    torch.backends.cuda.matmul.allow_fp16_accumulation = old

            if hasattr(torch.backends.cuda.matmul, "allow_fp16_accumulation"):
                m.add_wrapper_with_key(pe.WrappersMP.OUTER_SAMPLE, "lc_optimizer_fp16acc", outer)
                applied.append(r["label"])
            else:
                r["state"], r["why"] = "na", "needs PyTorch 2.7 or newer"
        elif r["key"] == "step_cache":
            m = _call("EasyCache", model=m, reuse_threshold=0.2, start_percent=0.15, end_percent=0.95, verbose=False)[0]
            applied.append(r["label"])
        elif r["key"] == "qwen21_cache":
            dev, dt = r["value"]
            m = _call("QwenImage21Cache", model=m, device=dev, dtype=dt)[0]
            if r["state"] == "on":
                applied.append(r["label"])
        elif r["key"] == "torch_compile":
            m = _call("TorchCompileModel", model=m, backend="inductor")[0]
            applied.append(r["label"])
    return m, applied


# ---------------------------------------------------------------- the plan shown on the node before a run
def plan(profile_id, goal, picks, manual=None):
    """picks: {role: widget value}. Everything the face shows, without loading or downloading anything."""
    prof = profiles().get(profile_id)
    custom = is_custom(profile_id)
    out = {"base": prof["name"] if prof else profile_id, "roles": roles_for(profile_id), "extras": EXTRAS.get(profile_id, []), "files": [], "speedups": plan_speedups(profile_id, goal, manual),
           "hints": [], "report": None, "estimate": UNSUPPORTED if custom else None, "custom": custom, "checkpoint_only": checkpoint_only(profile_id)}
    sysp = report()
    if sysp:
        g = (sysp.get("gpus") or [{}])[0]
        out["report"] = {"when": sysp.get("when"), "gpu": g.get("name"), "vram_gb": g.get("vram_gb")}
    elif custom:
        out["hints"].append(("💡", "No report yet: run the System & Model Optimization Report so the speed-ups suit this machine."))
    else:
        out["hints"].append(("💡", "No report yet: using Comfy's default files. Run the System & Model Optimization Report for picks that suit this machine."))
    if custom:
        out["hints"].append(("ℹ️", "Custom: recommended files, downloads, estimates and file checks are unsupported. Pick your own files; the speed-ups still apply."))
    paths = {}
    ckpt = False
    for role, value in picks.items():
        if role not in out["roles"] or value in (NONE, None, ""):
            continue
        if value == FROM_CKPT:
            out["files"].append({"role": role, "label": "from the checkpoint", "state": "ckpt"})
            continue
        row = {"role": role, "value": value}
        if custom and (value == RECOMMENDED or value.startswith(DOWNLOAD)):
            if not (ckpt and role in ("clip", "vae", "audio_vae")):
                out["files"].append(dict(row, label=f"{role}: {UNSUPPORTED}", state=UNSUPPORTED))
            else:
                out["files"].append({"role": role, "label": "from the checkpoint", "state": "ckpt"})
            continue
        try:
            if value == RECOMMENDED or value.startswith(DOWNLOAD):
                if value == RECOMMENDED:
                    v = recommended(prof, role, goal) if prof else None
                else:
                    fname = value[len(DOWNLOAD):]
                    v = next((x for x in variants(prof, role) if x["file"] == fname), None) if prof else None
                    entry = shipped(fname) if (role == "model" and not v) else None
                    if entry:  # a featured download of Lonecat's (Krealism V3.1)
                        hit = find_on_disk(entry["file"], ROLE_FOLDERS[role])
                        row.update(label=entry["file"], gb=entry["gb"], state="disk" if hit else "download")
                        if hit:
                            paths[role] = full_path(*hit)
                        else:
                            out["hints"].append(("ℹ️", f"{entry['family']} downloads from huggingface.co/{entry['repo']} on the first run."))
                        out["files"].append(row)
                        continue
                if not v:
                    if ckpt and role in ("clip", "vae", "audio_vae"):
                        out["files"].append({"role": role, "label": "from the checkpoint", "state": "ckpt"})
                    continue
                folder = FOLDER_BY_LOADER.get(v["loader"], ROLE_FOLDERS[role][0])
                hit = find_on_disk(v["file"], [folder])
                row.update(label=v.get("display") or v["file"], gb=v.get("gb"), state="disk" if hit else "download")
                ckpt = ckpt or (role == "model" and folder == "checkpoints")  # also before it is downloaded
                if hit:
                    paths[role] = full_path(*hit)
                if role == "model" and v.get("pick", {}).get("step_s"):
                    pk = v["pick"]
                    out["estimate"] = {"step_s": pk["step_s"], "total_s": pk.get("total_s"), "steps": pk.get("steps"), "fits": pk.get("fits"),
                                       "confidence": pk.get("confidence")}
            else:
                folder = next((f for f in ROLE_FOLDERS[role] if value in _list(f)), None)
                row.update(label=os.path.basename(value.replace("\\", "/")), state="disk" if folder else "missing")
                entry = shipped(value) if (role == "model" and not folder) else None
                if entry:
                    row.update(state="download", gb=entry["gb"])
                    out["hints"].append(("ℹ️", f"This workflow uses {entry['family']}: it downloads from huggingface.co/{entry['repo']} on the first run."))
                    if prof and entry.get("profile") and entry["profile"] != profile_id:
                        out["hints"].append(("⚠️", f"{entry['family']} is a {profiles().get(entry['profile'], {}).get('name', entry['profile'])} model: set the base model to match."))
                if folder:
                    paths[role] = full_path(folder, value)
                    ckpt = ckpt or (role == "model" and folder == "checkpoints")
        except Exception as e:
            row.update(label=str(value), state="missing", error=str(e))
        out["files"].append(row)
    out["checkpoint"] = ckpt
    try:
        out["hints"] += check_files(profile_id, paths)
    except Exception as e:
        out["hints"].append(("ℹ️", f"Could not check the files ({type(e).__name__})."))
    if prof and "Needs BOTH" in " ".join(prof.get("notes", [])):
        out["hints"].append(("ℹ️", "Ideogram 4 samples with two models: LC Optimizer (pipe) loads the unconditional one into model 2."))
    return out


def summary_text(pl, applied, loaded):
    lines = [f"LC Optimizer: {pl['base']}"]
    for role, name in loaded:
        lines.append(f"{role}: {name}")
    lines.append("speed-ups: " + (", ".join(applied) if applied else "none"))
    if pl.get("estimate") == UNSUPPORTED:
        lines.append(f"estimate: {UNSUPPORTED}")
    elif pl.get("estimate"):
        e = pl["estimate"]
        lines.append(f"estimate: ~{e['step_s']} s/step" + (f", ~{e['total_s']} s for {e['steps']} steps" if e.get("total_s") else ""))
    for icon, text in pl["hints"]:
        lines.append(f"{icon} {text}")
    return "\n".join(lines)
