"""
LC Model Info — wire a MODEL in and read what its files say about themselves, without opening their workflow.

It follows the model wire upstream (through LoRA loaders, merges and model patches) to the files it came from, then
reads each file's header only (never the weights): a ComfyUI workflow embedded by a save node (the LoRAs and merge
recipe that built it), Kohya training info on LoRAs, modelspec card fields, GGUF metadata. The model passes through
untouched, and the same report shows on the node as soon as it is wired (no queue needed).
"""

import json
import os
import struct

from . import lc_civitai_hashes as hashes

NODE_NAME = "LCModelInfo"

# folders whose files make up the diffusion model itself (text encoders, VAEs etc. are left out)
_MODEL_FOLDERS = {"checkpoints", "diffusion_models", "unet", "unet_gguf", "loras"}
_MAX_HEADER = 100 * 1024 * 1024
# general.file_type numbers (llama.cpp's LLAMA_FTYPE)
_GGUF_FTYPE = {0: "F32", 1: "F16", 2: "Q4_0", 3: "Q4_1", 7: "Q8_0", 8: "Q5_0", 9: "Q5_1", 10: "Q2_K", 11: "Q3_K_S",
               12: "Q3_K_M", 13: "Q3_K_L", 14: "Q4_K_S", 15: "Q4_K_M", 16: "Q5_K_S", 17: "Q5_K_M", 18: "Q6_K", 32: "BF16"}
_DTYPE_BYTES = {"F64": 8, "I64": 8, "U64": 8, "F32": 4, "I32": 4, "U32": 4, "F16": 2, "BF16": 2, "I16": 2, "U16": 2,
                "F8_E4M3": 1, "F8_E5M2": 1, "I8": 1, "U8": 1, "BOOL": 1}


# ------------------------------------------------------------------------------------------------ reading file headers
def _safetensors_header(path):
    with open(path, "rb") as f:
        n = struct.unpack("<Q", f.read(8))[0]
        if n <= 0 or n > _MAX_HEADER:
            return {}, {}
        header = json.loads(f.read(n))
    meta = header.pop("__metadata__", {}) or {}
    return meta, header


def _dtype_mix(tensors):
    """'BF16 92%, F32 8%' by bytes, from the tensor table (no weights read)."""
    sizes = {}
    for t in tensors.values():
        if not isinstance(t, dict):
            continue
        a, b = (t.get("data_offsets") or [0, 0])[:2]
        sizes[t.get("dtype", "?")] = sizes.get(t.get("dtype", "?"), 0) + max(0, b - a)
    total = sum(sizes.values()) or 1
    parts = sorted(sizes.items(), key=lambda kv: -kv[1])
    return ", ".join(f"{k} {round(100 * v / total)}%" for k, v in parts if v / total >= 0.01)


def _gguf_metadata(path):
    """Key/value block of a GGUF file (arrays are skipped, they are tokenizer tables)."""
    out = {}
    with open(path, "rb") as f:
        if f.read(4) != b"GGUF":
            return out
        version = struct.unpack("<I", f.read(4))[0]
        if version < 2:
            return out
        struct.unpack("<Q", f.read(8))  # tensor count
        kv_count = struct.unpack("<Q", f.read(8))[0]
        scalar = {0: "<B", 1: "<b", 2: "<H", 3: "<h", 4: "<I", 5: "<i", 6: "<f", 7: "<?", 10: "<Q", 11: "<q", 12: "<d"}

        def read_str():
            n = struct.unpack("<Q", f.read(8))[0]
            return f.read(n).decode("utf-8", "replace")

        def read_val(t):
            if t == 8:
                return read_str()
            if t == 9:
                at = struct.unpack("<I", f.read(4))[0]
                count = struct.unpack("<Q", f.read(8))[0]
                for _ in range(count):
                    read_val(at)
                return f"[{count} items]"
            fmt = scalar[t]
            return struct.unpack(fmt, f.read(struct.calcsize(fmt)))[0]

        for _ in range(min(kv_count, 100000)):
            key = read_str()
            t = struct.unpack("<I", f.read(4))[0]
            out[key] = read_val(t)
    return out


# ------------------------------------------------------------------------------------------------ the embedded workflow
def _num(v):
    try:
        return round(float(v), 3)
    except (TypeError, ValueError):
        return None


def _recipe(prompt_json):
    """What an embedded ComfyUI prompt says built the model: base files, LoRAs with strengths, merges, sampler."""
    try:
        prompt = json.loads(prompt_json) if isinstance(prompt_json, str) else prompt_json
    except (ValueError, TypeError):
        return None
    if not isinstance(prompt, dict):
        return None
    bases, loras, merges, sampler = [], [], [], None
    for node in prompt.values():
        if not isinstance(node, dict):
            continue
        ct = str(node.get("class_type") or "")
        ins = node.get("inputs") if isinstance(node.get("inputs"), dict) else {}
        low = ct.lower()
        if "lora" in low:
            rows = ins.get("lora_rows")
            if isinstance(rows, str):
                try:
                    rows = json.loads(rows)
                except ValueError:
                    rows = None
            if isinstance(rows, list):  # LC LoRA Loader
                for r in rows:
                    if isinstance(r, dict) and r.get("on", True) and r.get("lora") and _num(r.get("strength", 1)):
                        loras.append((r["lora"], _num(r.get("strength", 1))))
            elif isinstance(ins.get("lora_name"), str):
                s = _num(ins.get("strength_model", ins.get("strength", 1)))
                if s:
                    loras.append((ins["lora_name"], s))
            continue
        if "merge" in low:
            ratio = ins.get("ratio", ins.get("multiplier"))
            merges.append(ct + (f" (ratio {_num(ratio)})" if _num(ratio) is not None else ""))
        for key in ("ckpt_name", "unet_name", "model_name", "gguf_name"):
            if isinstance(ins.get(key), str) and hashes._FILE_EXT.search(ins[key]):
                bases.append(ins[key])
        if sampler is None and "steps" in ins and ("sampler_name" in ins or "cfg" in ins):
            parts = [f"{k} {ins[k]}" for k in ("steps", "cfg", "sampler_name", "scheduler", "denoise")
                     if k in ins and not isinstance(ins[k], list)]
            sampler = ", ".join(parts) if len(parts) >= 2 else None  # mostly wired in: nothing worth showing
    counted = [m + (f" x{merges.count(m)}" if merges.count(m) > 1 else "") for m in dict.fromkeys(merges)]
    return {"bases": list(dict.fromkeys(bases)), "loras": loras, "merges": counted, "sampler": sampler}


# ------------------------------------------------------------------------------------------------ one file's report
def _gb(path):
    return f"{os.path.getsize(path) / 1024 ** 3:.2f} GB"


def file_report(name, folder):
    path, _kind = hashes._resolve(name, folder)
    if not path:
        return {"name": name, "lines": [f"{name}: not found on disk"], "loras": [], "raw": {}}
    lines, found_loras, raw = [], [], {}
    try:
        if path.lower().endswith(".gguf"):
            meta = _gguf_metadata(path)
            raw = meta
            arch = meta.get("general.architecture")
            ftype = _GGUF_FTYPE.get(meta.get("general.file_type"), meta.get("general.file_type"))
            fmt = f"GGUF {ftype}" if ftype not in (None, "") else "GGUF"
            lines.append(f"{name}  ·  {fmt}  ·  {_gb(path)}" + (f"  ·  {arch}" if arch else ""))
            for key, label in (("general.name", "Name"), ("general.basename", "Base"), ("general.size_label", "Size"),
                               ("general.finetune", "Finetune"), ("general.author", "Author"), ("general.license", "License")):
                if meta.get(key) not in (None, ""):
                    lines.append(f"  {label}: {meta[key]}")
        elif path.lower().endswith((".safetensors", ".sft")):
            meta, tensors = _safetensors_header(path)
            raw = meta
            lines.append(f"{name}  ·  {_gb(path)}  ·  {_dtype_mix(tensors) or '?'}")
            card = [(k.split(".", 1)[1], meta[k]) for k in ("modelspec.title", "modelspec.author", "modelspec.architecture",
                                                             "modelspec.trigger_phrase", "modelspec.description")
                    if meta.get(k)]
            for label, value in card:
                lines.append(f"  {label.capitalize()}: {str(value)[:300]}")
            rec = _recipe(meta.get("prompt")) if meta.get("prompt") else None
            if rec:
                lines.append("  Built with (workflow saved inside the file):")
                for b in rec["bases"]:
                    lines.append(f"    base: {b}")
                for ln, s in rec["loras"]:
                    lines.append(f"    LoRA: {ln} @ {s}")
                    found_loras.append(f"{ln} @ {s} (baked in)")
                for m in rec["merges"]:
                    lines.append(f"    merge: {m}")
                if rec["sampler"]:
                    lines.append(f"    sampler: {rec['sampler']}")
                if not (rec["bases"] or rec["loras"] or rec["merges"]):
                    lines.append("    (a workflow is saved, but it names no model files)")
            if any(k.startswith("ss_") for k in meta):
                train = [("Base", meta.get("ss_base_model_version") or meta.get("ss_sd_model_name")),
                         ("Rank / alpha", f"{meta.get('ss_network_dim')} / {meta.get('ss_network_alpha')}"
                          if meta.get("ss_network_dim") else None),
                         ("Steps", meta.get("ss_steps") or meta.get("ss_max_train_steps")),
                         ("Epochs", meta.get("ss_num_epochs")),
                         ("Resolution", meta.get("ss_resolution")),
                         ("Learning rate", meta.get("ss_learning_rate"))]
                lines.append("  Training (Kohya):")
                lines += [f"    {k}: {v}" for k, v in train if v not in (None, "", "None")]
                try:
                    from .lc_lora_loader import _trigger_words_from_metadata

                    words = _trigger_words_from_metadata(meta)[:12]
                    if words:
                        lines.append("    Top tags: " + ", ".join(words))
                except Exception:
                    pass
            other = [k for k in meta if not k.startswith(("ss_", "modelspec.")) and k not in ("prompt", "workflow")]
            if other:
                lines.append("  Other fields: " + ", ".join(sorted(other)[:15]) + (" ..." if len(other) > 15 else ""))
            if not meta:
                lines.append("  No metadata in this file (stripped, or the tool that saved it wrote none).")
        else:
            lines.append(f"{name}  ·  {_gb(path)}  ·  this format keeps no readable header")
    except Exception as e:
        lines.append(f"{name}: couldn't read the header ({e})")
    return {"name": name, "lines": lines, "loras": found_loras, "raw": raw}


# ------------------------------------------------------------------------------------------------ following the wire
def _src(val):
    return str(val[0]) if isinstance(val, list) and len(val) == 2 and isinstance(val[1], int) else None


def model_files(prompt, node_id):
    """[(file, folder, strength or None)] that make up the MODEL wired into node_id, nearest first."""
    node_id = str(node_id)
    if node_id not in prompt:  # inside a subgraph the id gets a parent prefix
        node_id = next((k for k in prompt if str(k).endswith(":" + node_id)), node_id)
    start = _src((prompt.get(node_id) or {}).get("inputs", {}).get("model"))
    out, seen, todo = [], set(), [start] if start else []
    while todo:
        nid = todo.pop(0)
        if nid in seen or nid not in prompt:
            continue
        seen.add(nid)
        node = prompt[nid]
        ins = node.get("inputs") if isinstance(node.get("inputs"), dict) else {}
        strength = _num(ins.get("strength_model", ins.get("strength")))
        row_strength = {}
        try:  # LC LoRA Loader keeps every row (name, on, strength) in one JSON string
            for r in json.loads(ins.get("lora_rows") or "[]"):
                if isinstance(r, dict) and r.get("lora"):
                    row_strength[r["lora"]] = _num(r.get("strength", 1))
        except (ValueError, TypeError):
            pass
        for name, folder in hashes._collect_from_prompt({nid: node}):
            _path, kind = hashes._resolve(name, folder)
            if kind in ("model", "unet", "lora") or (kind is None and folder in _MODEL_FOLDERS):
                lora = kind == "lora" or folder == "loras"
                out.append((name, "loras" if lora else folder, row_strength.get(name, strength) if lora else None))
        # keep walking along model wires (model, model1, model2 ...)
        for key, val in ins.items():
            if "model" in key.lower() and _src(val):
                todo.append(_src(val))
    return out


def report(prompt, node_id):
    files = model_files(prompt, node_id) if isinstance(prompt, dict) else []
    if not files:
        prompt = prompt if isinstance(prompt, dict) else {}
        me = prompt.get(str(node_id)) or next((v for k, v in prompt.items() if str(k).endswith(":" + str(node_id))), {})
        if _src((me.get("inputs") or {}).get("model")):
            return ("No model file found on this wire: the file isn't on disk yet (a ★ Recommended pick downloads on the "
                    "first run), or its loader keeps the name somewhere this node can't read."), "", "{}"
        return "Wire a MODEL output into this node.", "", "{}"
    lines, loras, raw = [], [], {}
    applied = [(n, s) for n, f, s in files if f == "loras"]
    if applied:
        lines.append("LoRAs on this wire: " + ", ".join(f"{n} @ {s}" if s is not None else n for n, s in applied))
        loras += [f"{n} @ {s}" if s is not None else n for n, s in applied]
        lines.append("")
    for name, folder, _s in files:
        r = file_report(name, folder)
        lines += r["lines"] + [""]
        loras += r["loras"]
        raw[name] = r["raw"]
    return "\n".join(lines).strip(), "\n".join(dict.fromkeys(loras)), json.dumps(raw, indent=1, ensure_ascii=False, default=str)


class LCModelInfo:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {"model": ("MODEL", {"tooltip": "Any diffusion model output: a loader, a LoRA loader, a merge."})},
            "hidden": {"prompt": "PROMPT", "unique_id": "UNIQUE_ID"},
        }

    RETURN_TYPES = ("MODEL", "STRING", "STRING", "STRING")
    RETURN_NAMES = ("model", "info", "loras", "metadata")
    OUTPUT_TOOLTIPS = ("The same model, untouched.",
                       "The report shown on the node.",
                       "Every LoRA found: on this wire and baked into the files, one per line.",
                       "All header fields of every file, as JSON (the embedded workflow included).")
    FUNCTION = "run"
    CATEGORY = "LC123/utils"
    OUTPUT_NODE = True
    DESCRIPTION = ("Reads what a model's files say about themselves, from the header only: the workflow a save node "
                   "embedded (LoRAs, strengths, merges), Kohya training info, card fields, GGUF info. Shows on the node "
                   "as soon as it's wired. The model passes through untouched.")

    def run(self, model, prompt=None, unique_id=None):
        info, loras, raw = report(prompt or {}, unique_id)
        return {"ui": {"text": [info]}, "result": (model, info, loras, raw)}


try:
    from aiohttp import web
    from server import PromptServer

    @PromptServer.instance.routes.post("/lc123/model_info")
    async def _model_info_route(request):
        import asyncio

        data = await request.json()
        info, loras, _raw = await asyncio.get_running_loop().run_in_executor(
            None, report, data.get("prompt") or {}, data.get("node_id"))
        return web.json_response({"info": info, "loras": loras})
except Exception:  # pragma: no cover - the node still works when it runs, only the live preview needs the route
    pass


NODE_CLASS_MAPPINGS = {NODE_NAME: LCModelInfo}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "LC Model Info ℹ️"}
