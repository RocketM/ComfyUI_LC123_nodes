"""
Node Pack Usage Report (LC123 Settings > Optimization): which installed custom node packs your saved workflows actually
use. Reads every workflow in your ComfyUI workflows folder (subgraphs included, UTF-8) and matches each node to the pack
that registered it. Read-only: nothing is moved, changed or uninstalled.
"""

from __future__ import annotations

import json
import os
import re
import time

# frontend-only nodes have no Python side, so ComfyUI's registry does not know their pack
JS_ONLY = {
    "SetNode": "ComfyUI-KJNodes", "GetNode": "ComfyUI-KJNodes",
    "LCNote": "ComfyUI_LC123_nodes", "LC Bypasser": "ComfyUI_LC123_nodes", "LC Bypasser Panel": "ComfyUI_LC123_nodes",
    "LC Groups Bypasser": "ComfyUI_LC123_nodes", "LC Mute": "ComfyUI_LC123_nodes",
    "MarkdownNote": "(core)", "Note": "(core)", "Reroute": "(core)", "PrimitiveNode": "(core)",
    "Anything Everywhere": "cg-use-everywhere", "Anything Everywhere3": "cg-use-everywhere",
    "Anything Everywhere?": "cg-use-everywhere", "Prompts Everywhere": "cg-use-everywhere",
}
# packs that do their job without placing nodes in a workflow
TOOLS = {
    "ComfyUI-Manager": "the Manager itself", "ComfyUI-Crystools": "GPU / CPU monitor in the menu bar",
    "ComfyUI-BlackwellAttentionFix": "attention patch", "ComfyUI-sol-attn": "attention backend",
    "ComfyUI-INT8-Fast": "int8 speed-up", "comfyui-workflow-recovery": "workflow backup",
    "ComfyUI-Custom-Scripts": "UI helpers", "cg-use-everywhere": "wireless links",
    "comfyui-vslinx-nodes": "frontend fixes", "websocket_image_save": "API helper",
    "rgthree-comfy": "UI helpers and nodes",
}
_UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")


def _norm(s):
    return re.sub(r"[^a-z0-9]", "", str(s).lower())


def _packs():
    import folder_paths

    out = {}
    for base in folder_paths.get_folder_paths("custom_nodes"):
        try:
            names = os.listdir(base)
        except OSError:
            continue
        for n in names:
            p = os.path.join(base, n)
            if n.startswith(("__", ".")) or n.endswith(".disabled"):
                continue
            if os.path.isdir(p):
                out[n] = p
            elif n.endswith(".py"):
                out[n[:-3]] = p
    return out


def _size_mb(path):
    if os.path.isfile(path):
        return os.path.getsize(path) / 2**20
    tot = 0
    for root, dirs, files in os.walk(path):
        dirs[:] = [d for d in dirs if d not in (".git", "__pycache__")]
        for f in files:
            try:
                tot += os.path.getsize(os.path.join(root, f))
            except OSError:
                pass
    return tot / 2**20


def _type_pack():
    import nodes

    out = {}
    for name, cls in nodes.NODE_CLASS_MAPPINGS.items():
        mod = str(getattr(cls, "RELATIVE_PYTHON_MODULE", "") or "")
        out[name] = mod.split(".", 1)[1] if mod.startswith("custom_nodes.") else "(core)"
    return out


def _nodes_of(wf):
    for n in wf.get("nodes", []) or []:
        yield n
    for sg in ((wf.get("definitions") or {}).get("subgraphs") or []):
        for n in sg.get("nodes", []) or []:
            yield n


def run(workflows_dir):
    t0 = time.time()
    packs = _packs()
    by_norm = {_norm(p): p for p in packs}
    type_pack = _type_pack()
    provides = {}
    for t, p in type_pack.items():
        provides.setdefault(p, set()).add(t)

    usage, used_types, missing, unreadable = {}, {}, {}, []
    files = []
    for root, _, fs in os.walk(workflows_dir):
        files += [os.path.join(root, f) for f in fs if f.lower().endswith(".json")]
    for f in files:
        rel = os.path.relpath(f, workflows_dir)
        try:
            with open(f, encoding="utf-8") as fh:
                wf = json.load(fh)
        except Exception as e:
            unreadable.append([rel, str(e)[:100]])
            continue
        if not isinstance(wf, dict) or "nodes" not in wf:
            continue
        for n in _nodes_of(wf):
            t = n.get("type")
            if not isinstance(t, str) or _UUID.fullmatch(t):  # a subgraph's instance: its own nodes are read above
                continue
            p = type_pack.get(t) or JS_ONLY.get(t) or ("rgthree-comfy" if t.endswith("(rgthree)") else None)
            if p is None:
                cnr = str((n.get("properties") or {}).get("cnr_id") or "")
                p = "(core)" if cnr == "comfy-core" else by_norm.get(_norm(cnr)) if cnr else None
            if p is None or (p != "(core)" and p not in packs):
                missing.setdefault(t, set()).add(rel)
                continue
            usage.setdefault(p, set()).add(rel)
            used_types.setdefault(p, {}).setdefault(t, set()).add(rel)

    rows = []
    for p, path in sorted(packs.items(), key=lambda kv: kv[0].lower()):
        ut = used_types.get(p, {})
        rows.append({
            "pack": p, "workflows": len(usage.get(p, ())), "nodes": len(provides.get(p, ())), "used_nodes": len(ut),
            "size_mb": round(_size_mb(path), 1), "loaded": p in provides,
            "top": [t for t, _ in sorted(ut.items(), key=lambda kv: -len(kv[1]))[:3]],
            "examples": sorted(usage.get(p, ()))[:3], "tool": TOOLS.get(p, ""),
            "yours": p.startswith(("ComfyUI_LC", "LC_")),
        })
    return {
        "when": time.strftime("%Y-%m-%d %H:%M"), "seconds": round(time.time() - t0, 1), "folder": workflows_dir,
        "workflows": len(files), "unreadable": unreadable, "packs": rows,
        "missing": [{"type": t, "count": len(v), "examples": sorted(v)[:3]} for t, v in sorted(missing.items(), key=lambda kv: -len(kv[1]))],
    }


try:
    from aiohttp import web
    from server import PromptServer

    @PromptServer.instance.routes.get("/lc123/packusage/run")
    async def _lc123_packusage_run(request):
        import asyncio

        import folder_paths

        user = "default"
        try:
            user = PromptServer.instance.user_manager.get_request_user_id(request) or "default"
        except Exception:
            pass
        wdir = os.path.join(folder_paths.get_user_directory(), user, "workflows")
        if not os.path.isdir(wdir):
            return web.json_response({"error": f"No workflows folder found at {wdir}."}, status=404)
        try:
            rep = await asyncio.get_running_loop().run_in_executor(None, run, wdir)
        except Exception as e:
            return web.json_response({"error": f"The scan failed: {e}"}, status=500)
        return web.json_response(rep)
except Exception:
    pass
