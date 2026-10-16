"""
LC pack versions: what is installed and what is newest on the Comfy Registry, for every LC pack. "Update LC nodes"
asks this first, so it can say "update the pack first" instead of rebuilding nodes against old code.

The Registry is only asked when someone runs Update LC nodes (never on start-up), and its answer is kept for an hour.
"""
from __future__ import annotations

import json
import os
import re
import time
import urllib.request

import folder_paths

REGISTRY = "https://api.comfy.org/nodes/{id}/versions?limit=1"
_cache = {"at": 0.0, "latest": {}}
TTL = 3600


def _installed():
    """{folder name: version} for every ComfyUI_LC* pack in custom_nodes."""
    out = {}
    for base in folder_paths.get_folder_paths("custom_nodes"):
        if not os.path.isdir(base):
            continue
        for name in sorted(os.listdir(base)):
            if not name.lower().startswith("comfyui_lc"):
                continue
            toml = os.path.join(base, name, "pyproject.toml")
            try:
                text = open(toml, encoding="utf-8").read()
            except OSError:
                continue
            m = re.search(r'(?m)^version\s*=\s*"([^"]+)"', text)
            reg = re.search(r'(?m)^name\s*=\s*"([^"]+)"', text)
            if m:
                out[name] = {"version": m.group(1), "registry_id": reg.group(1) if reg else name}
    return out


def _latest(ids):
    if time.time() - _cache["at"] < TTL and all(i in _cache["latest"] for i in ids):
        return _cache["latest"]
    for i in ids:
        try:
            req = urllib.request.Request(REGISTRY.format(id=i), headers={"User-Agent": "LC123-update-check"})
            with urllib.request.urlopen(req, timeout=6) as r:
                data = json.loads(r.read().decode("utf-8"))
            versions = data if isinstance(data, list) else data.get("versions", [])
            _cache["latest"][i] = (versions[0] or {}).get("version") if versions else None
        except Exception:
            _cache["latest"].setdefault(i, None)
    _cache["at"] = time.time()
    return _cache["latest"]


def _newer(a, b):
    """True when version a is newer than b (numbers compared part by part)."""
    def parts(v):
        return [int(x) if x.isdigit() else 0 for x in re.split(r"[.\-+]", str(v or ""))]
    return parts(a) > parts(b)


try:
    from aiohttp import web
    from server import PromptServer
    import asyncio

    @PromptServer.instance.routes.get("/lc/pack_versions")
    async def _pack_versions(request):
        inst = _installed()
        latest = await asyncio.get_running_loop().run_in_executor(None, _latest, [v["registry_id"] for v in inst.values()])
        out = {}
        for folder, v in inst.items():
            new = latest.get(v["registry_id"])
            out[folder] = {"installed": v["version"], "latest": new, "behind": bool(new and _newer(new, v["version"]))}
        return web.json_response(out)
except Exception as e:  # no server (tests)
    print(f"[LC123] pack version route not registered: {e}")

NODE_CLASS_MAPPINGS = {}
