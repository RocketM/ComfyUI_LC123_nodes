"""
"Recommended to install" for the System & Model Optimization Report.

Links only: LC123 never installs anything. For each speed-up that is missing (or failed its test) on this machine,
it names the project, why it helps, where to get it, and one or two notes for this card / PyTorch / install type.
The projects are other people's; the fine print says so.
"""

from __future__ import annotations

import os
import sys

TRITON = "https://github.com/woct0rdho/triton-windows"
TRITON_PORTABLE = "https://github.com/woct0rdho/triton-windows#8-special-notes-for-comfyui-with-embeded-python"
SAGE_WIN = "https://github.com/woct0rdho/SageAttention/releases"
SAGE = "https://github.com/thu-ml/SageAttention"
KITCHEN = "https://github.com/Comfy-Org/comfy-kitchen"
COMFY_AMD = "https://github.com/comfyanonymous/ComfyUI#amd-gpus-linux"
LC_VISION = "https://github.com/lonecatone23/ComfyUI_LC_Vision_nodes"

FINE_PRINT = ("These are other people's projects; LC123 doesn't maintain them. Close ComfyUI before installing and back up "
              "your python_embeded folder. After installing, run this report again: it checks that Sage really works "
              "(a broken build shows up as ⚠️ instead of gray images).")

# PyTorch minor -> the triton-windows pin its README gives
TRITON_PIN = {(2, 7): "<3.4", (2, 8): "<3.5", (2, 9): "<3.6", (2, 10): "<3.7"}


def _ver(s):
    try:
        a, b = str(s).split("+")[0].split(".")[:2]
        return int(a), int(b)
    except Exception:
        return None


def _cc(g):
    try:
        a, b = str(g.get("capability", "0.0")).split(".")
        return int(a) * 10 + int(b)
    except Exception:
        return 0


def _python_cmd():
    """How to call pip for THIS ComfyUI (portable = its own python_embeded)."""
    exe = sys.executable or "python"
    portable = "python_embeded" in exe.replace("\\", "/").lower()
    if portable:
        return portable, r"python_embeded\python.exe -m pip install"
    return portable, "python -m pip install"


def install_recs(prof: dict) -> dict:
    g = (prof.get("gpus") or [{}])[0]
    sw = prof.get("software") or {}
    t = prof.get("tests") or {}
    vendor = (g.get("vendor") or "").upper()
    cc = _cc(g)
    torch_v = _ver(sw.get("torch"))
    win = os.name == "nt"
    portable, pip = _python_cmd()
    py = ".".join(str((prof.get("machine") or {}).get("python", "")).split(".")[:2])
    detected = " · ".join(x for x in [
        g.get("name"), g.get("arch"), sw.get("torch") and f"PyTorch {sw['torch'].split('+')[0]}",
        sw.get("cuda") and f"CUDA {sw['cuda']}", sw.get("hip") and f"ROCm {sw['hip']}", py and f"Python {py}",
        "portable" if portable else None] if x)
    items = []
    out = {"detected": detected, "items": items, "fine_print": FINE_PRINT}

    if vendor == "AMD" or sw.get("hip"):
        items.append({"name": "PyTorch for AMD (ROCm)", "status": "info", "link": COMFY_AMD,
                      "why": "AMD cards run ComfyUI through ROCm. ComfyUI's own README has the install lines for Linux and Windows.",
                      "notes": ["Sage and Triton for Windows are NVIDIA builds: they don't apply to AMD cards."]})
        return out
    if vendor and vendor != "NVIDIA":
        return out
    if cc and cc < 75:
        items.append({"name": "Sage / Triton", "status": "info", "link": None,
                      "why": f"{g.get('arch') or 'This card'} is older than RTX 20 / GTX 16: Sage and Triton don't support it.", "notes": []})
        return out

    rtx50 = cc >= 120
    turing = cc == 75
    sdpa = (t.get("attention_sdpa") or {}).get("ms")

    tri = t.get("triton") or {}
    if not tri.get("ok"):
        notes = []
        if turing:
            notes.append("RTX 20 / GTX 16: Triton 3.2 at most (with PyTorch 2.6 or older).")
        elif rtx50:
            notes.append("RTX 50 needs Triton 3.3 or newer.")
        pin = "<3.3" if turing else (TRITON_PIN.get(torch_v) if torch_v else None)  # RTX 20 / GTX 16: the card sets the limit
        if win:
            spec = f'triton-windows{pin}' if pin else "triton-windows"
            notes.append(f'Command: {pip} -U "{spec}"' + ("" if pin else " (match it to your PyTorch: see the table on the page)"))
            if portable:
                notes.append("Portable ComfyUI: also add the include and libs folders for your Python version (step on the same page). "
                             "This is the step most people miss.")
        items.append({"name": "Triton", "status": "failed" if tri.get("ok") is False else "missing", "link": TRITON if win else "https://github.com/triton-lang/triton",
                      "why": "Needed by Sage and by torch.compile. On Linux it usually comes with PyTorch.", "notes": notes,
                      "more": [["The portable step", TRITON_PORTABLE]] if win and portable else []})

    sage = t.get("sageattention") or {}
    if not sage.get("ok"):
        failed = sage.get("ok") is False
        notes = ["Install Triton first."] if not tri.get("ok") else []
        if win:
            if torch_v and torch_v >= (2, 10):
                notes.append("Your PyTorch is 2.10 or newer: the current release wheels fit (they cover GTX 16 to RTX 50).")
            else:
                notes.append("PyTorch older than 2.10: pick an older release whose wheel name matches your PyTorch and CUDA.")
            notes.append(f"Command: {pip} <the .whl file you downloaded>")
        else:
            notes.append(f"Command: {pip} sageattention")
        if rtx50:
            notes.append("RTX 50: Sage 3 (FP4, Blackwell only) is an optional extra from the official project.")
        notes.append("Then the LC Model Optimizer turns it on per model. Don't add --use-sage-attention to your .bat: it forces Sage on "
                     "every model, and some models give black images with it.")
        why = ("Installed but it failed the test (wrong build for this card or PyTorch): reinstall a matching one." if failed else
               "Faster attention, the biggest single speed-up for image and video models" + (f" (standard attention here: {sdpa} ms per call; Sage is usually 3 to 5x faster)." if sdpa else "."))
        items.append({"name": "SageAttention", "status": "failed" if failed else "missing", "link": SAGE_WIN if win else SAGE, "why": why, "notes": notes})

    kit = prof.get("kitchen") or {}
    if not kit.get("installed"):
        notes = [f"Command: {pip} comfy-kitchen" + (" (or comfy-kitchen[cublas] for nvfp4 on RTX 50)" if rtx50 else "")]
        items.append({"name": "Comfy Kitchen", "status": "missing", "link": KITCHEN,
                      "why": "Comfy's fast kernels for int8 / fp8 / nvfp4 model files.", "notes": notes})

    llama = prof.get("llama_cpp") or {}
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    if os.path.isdir(os.path.join(here, "ComfyUI_LC_Vision_nodes")) and not (llama.get("installed") and llama.get("gpu_offload")):
        items.append({"name": "llama-cpp for LC Vision", "status": "missing", "link": LC_VISION,
                      "why": "LC Vision needs a GPU build of llama-cpp-python.",
                      "notes": ["LC Vision's own installer picks the right build: run its install.py with ComfyUI's Python (see its README)."]})
    return out
