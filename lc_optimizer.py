"""
LC Optimization report, server side.

GET /lc123/optimizer/scan reads the front-end files (.js / .css) of every installed pack that has a web folder and
lists the patterns that tend to slow down the canvas: timers, animation loops, patches on the canvas draw calls,
blur / backdrop filters, CSS animations, pixel read-backs and DOM observers. Read only, nothing is changed.
"""

from __future__ import annotations

import os
import re

KINDS = {
    "interval": (re.compile(r"\bsetInterval\s*\("), "timer (setInterval)"),
    "raf": (re.compile(r"\brequestAnimationFrame\s*\("), "animation loop (requestAnimationFrame)"),
    "canvas_patch": (
        re.compile(r"\bLGraphCanvas\.prototype\.(draw\w*|render\w*|process\w+|computeVisibleNodes)\s*=(?!=)"),
        "patches a canvas draw call",
    ),
    "node_patch": (
        re.compile(r"\bLGraphNode\.prototype\.(onDrawForeground|onDrawBackground|draw\w*)\s*=(?!=)"),
        "patches drawing for every node",
    ),
    "blur": (re.compile(r"backdrop-filter|filter\s*:\s*[^;\"'`\n]{0,40}blur\("), "blur / backdrop filter"),
    "css_anim": (re.compile(r"@keyframes|\banimation\s*:\s*[a-z]"), "CSS animation"),
    "pixels": (re.compile(r"\bgetImageData\s*\("), "reads canvas pixels (getImageData)"),
    "observer": (re.compile(r"\bnew\s+MutationObserver\s*\("), "DOM observer"),
}
MAX_FILE = 3 * 1024 * 1024
MAX_EXAMPLES = 4


_CACHE = {}  # web dir -> (newest mtime, result)


def _newest_mtime(root):
    newest = 0.0
    for dp, dns, fns in os.walk(root):
        dns[:] = [d for d in dns if d not in ("node_modules", ".git", "__pycache__")]
        for fn in fns:
            if fn.endswith((".js", ".mjs", ".css")):
                try:
                    newest = max(newest, os.path.getmtime(os.path.join(dp, fn)))
                except OSError:
                    pass
    return newest


def scan_all(dirs):
    """Runs in a worker thread. Re-reads a folder only when one of its files changed since the last scan."""
    packs = {}
    for name, web_dir in dirs:
        if not os.path.isdir(web_dir):
            continue
        try:
            stamp = _newest_mtime(web_dir)
            hit = _CACHE.get(web_dir)
            if hit and hit[0] == stamp:
                packs[name] = hit[1]
                continue
            res = scan_dir(web_dir)
            _CACHE[web_dir] = (stamp, res)
        except Exception as e:  # one broken pack must not stop the report
            res = {"error": str(e)}
        packs[name] = res
    return packs


def scan_dir(root):
    found = {k: {"count": 0, "examples": []} for k in KINDS}
    for dp, dns, fns in os.walk(root):
        dns[:] = [d for d in dns if d not in ("node_modules", ".git", "__pycache__")]
        for fn in fns:
            if not fn.endswith((".js", ".mjs", ".css")):
                continue
            path = os.path.join(dp, fn)
            try:
                if os.path.getsize(path) > MAX_FILE:
                    continue
                with open(path, encoding="utf-8", errors="ignore") as f:
                    lines = f.read().splitlines()
            except OSError:
                continue
            rel = os.path.relpath(path, root).replace("\\", "/")
            for i, line in enumerate(lines, 1):
                stripped = line.lstrip()
                # skip comment lines, but not a minified bundle that happens to start with a license banner
                if stripped.startswith("//") or (stripped.startswith(("*", "/*")) and len(stripped) < 400):
                    continue
                for k, (rx, _label) in KINDS.items():
                    hits = rx.findall(line)
                    if not hits:
                        continue
                    found[k]["count"] += len(hits)
                    if len(found[k]["examples"]) < MAX_EXAMPLES:
                        found[k]["examples"].append({"file": rel, "line": i, "text": stripped[:140]})
    return {k: v for k, v in found.items() if v["count"]}


try:
    from aiohttp import web
    from server import PromptServer

    @PromptServer.instance.routes.get("/lc123/optimizer/scan")
    async def _lc123_optimizer_scan(request):
        import asyncio
        import nodes

        dirs = sorted(getattr(nodes, "EXTENSION_WEB_DIRS", {}).items())
        # file reading happens in a worker thread so ComfyUI (queue, progress, websocket) keeps running meanwhile
        packs = await asyncio.get_running_loop().run_in_executor(None, scan_all, dirs)
        return web.json_response({"labels": {k: v[1] for k, v in KINDS.items()}, "packs": packs})

except Exception:
    pass
