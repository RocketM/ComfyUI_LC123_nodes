"""
CivitAI 🚩🔪
------------
Strip terms from a prompt using an external list file under assets/lists/.
Default list: civitai_compliance_remove.txt

Why it exists: LLMs sometimes (and abliterated models especially) write "child" or "young adult in their late teens or
early 20s" about adults. This catches those words before a prompt ends up in a post you did not mean to make.
It is an off-by-default tool: the user has to switch it on. Workflows saved before the switch existed keep stripping.
"""

from __future__ import annotations

import os
import re

_ASSETS_LISTS = os.path.join(
    os.path.dirname(os.path.realpath(__file__)), "assets", "lists"
)
_DEFAULT_LIST = "civitai_compliance_remove.txt"

DISCLAIMER = (
    "DISCLAIMER: a convenience filter, not a safety system. It only removes the exact words in the list, it cannot "
    "understand an image or a prompt, and it will miss things. It does not make any content allowed. You alone are "
    "responsible for what you create and post, and for following CivitAI's Terms of Service and the law. No "
    "guarantee the list is complete, current or enough for approval. Not affiliated with CivitAI."
)


def _list_files():
    files = []
    if os.path.isdir(_ASSETS_LISTS):
        for name in sorted(os.listdir(_ASSETS_LISTS)):
            low = name.lower()
            if low.endswith((".txt", ".csv", ".list")) and not name.upper().startswith(
                "README"
            ):
                files.append(name)
    if _DEFAULT_LIST not in files:
        files.insert(0, _DEFAULT_LIST)
    return files or [_DEFAULT_LIST]


def _load_terms(filename: str):
    path = os.path.join(_ASSETS_LISTS, os.path.basename(filename or _DEFAULT_LIST))
    terms = []
    if not os.path.isfile(path):
        return terms
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            terms.append(line)
    # longest first so multi-word phrases win
    terms.sort(key=len, reverse=True)
    return terms


def _strip_terms(text: str, terms: list) -> str:
    if not text:
        return text
    out = text
    for term in terms:
        if not term:
            continue
        # case-insensitive whole word / phrase remove (no hits inside other words)
        pattern = re.compile(r"(?<![\w])" + re.escape(term) + r"(?![\w])", re.IGNORECASE)
        out = pattern.sub("", out)
    # tidy leftover commas / spaces
    out = re.sub(r"[ \t]{2,}", " ", out)
    out = re.sub(r" *, *", ", ", out)
    out = re.sub(r",\s*,+", ", ", out)
    out = re.sub(r"^\s*,\s*", "", out)
    out = re.sub(r"\s*,\s*$", "", out)
    return out.strip()


class LCCivitaiStrip:
    @classmethod
    def INPUT_TYPES(cls):
        lists = _list_files()
        return {
            "required": {
                "text": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": True,
                        "forceInput": True,
                        "tooltip": "Prompt / text to strip.",
                    },
                ),
                "list_file": (
                    lists,
                    {
                        "default": lists[0],
                        "tooltip": "List file under assets/lists/ (one term per line, # comments ok).",
                    },
                ),
            },
            "optional": {
                "enabled": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "label_on": "ON",
                        "label_off": "OFF",
                        "tooltip": DISCLAIMER + " Off = the text passes through untouched. You have to switch it on yourself.",
                    },
                ),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("text",)
    FUNCTION = "strip"
    CATEGORY = "LC123/text"
    DESCRIPTION = (
        "CivitAI 🚩🔪: removes listed words and phrases (whole words only) from a prompt, for example the "
        "\"child\" / \"late teens\" wording LLMs (abliterated models especially) sometimes add to adults. Off until you switch it on. " + DISCLAIMER
    )

    # enabled defaults to True here on purpose: prompts saved before the switch existed (and API scripts that
    # never send it) keep stripping. A newly placed node sends False until the user turns it on.
    def strip(self, text, list_file=_DEFAULT_LIST, enabled=True):
        if not enabled:
            return (text if text is not None else "",)
        terms = _load_terms(list_file)
        cleaned = _strip_terms(text if text is not None else "", terms)
        return (cleaned,)


NODE_CLASS_MAPPINGS = {
    "LCCivitaiStrip": LCCivitaiStrip,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "LCCivitaiStrip": "CivitAI 🚩🔪",
}
