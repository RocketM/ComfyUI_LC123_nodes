"""
LC ✂️ Duplicate Tags 🏷️
------------------------
Removes repeated tags from a prompt, so a tag that shows up twice (your own prompt plus a generated one) doesn't get
twice the weight. Tags match ignoring case, underscores and weight wrappers: long_hair, Long Hair, (long hair:1.2) and
((long hair)) are one tag. Sentences and long phrases pass through untouched, as do blank-line breaks and BREAK.
"""

from __future__ import annotations

import re


def _as_str(v) -> str:
    return "" if v is None else str(v)


MAX_TAG_WORDS = 6  # longer pieces are sentences, not tags: kept as they are


def _split_top(block: str) -> list[str]:
    """Split on commas / single newlines that are not inside (...) or [...] (a weighted group stays whole)."""
    out, depth, cur, i = [], 0, [], 0
    while i < len(block):
        c = block[i]
        if c == "\\" and i + 1 < len(block):  # escaped bracket, e.g. hatsune miku \(cosplay\)
            cur.append(block[i:i + 2])
            i += 2
            continue
        if c in "([":
            depth += 1
        elif c in ")]":
            depth = max(0, depth - 1)
        if c in ",\n" and depth == 0:
            out.append("".join(cur))
            cur = []
        else:
            cur.append(c)
        i += 1
    out.append("".join(cur))
    return [p.strip() for p in out if p.strip()]


def _is_prose(block: str) -> bool:
    """A block of sentences (e.g. the sentence part of a mixed prompt), not a tag list."""
    pieces = [p for p in block.split(",") if p.strip()]
    words = len(block.split())
    return bool(re.search(r"[.!?](\s|$)", block.strip())) and words / max(1, len(pieces)) > 3


def _key_weight(piece: str) -> tuple[str, float]:
    """Normalised tag (for matching) and its weight. (tag:1.3) = 1.3, (tag) = 1.1 per layer, [tag] = 0.9 per layer."""
    s, w = piece.strip(), 1.0
    m = re.fullmatch(r"\((.+):\s*([0-9.]+)\s*\)", s, flags=re.S)
    if m:
        s, w = m.group(1), float(m.group(2))
    while len(s) > 1 and s[0] == "(" and s[-1] == ")" and not s.endswith("\\)"):
        s, w = s[1:-1].strip(), w * 1.1
    while len(s) > 1 and s[0] == "[" and s[-1] == "]":
        s, w = s[1:-1].strip(), w * 0.9
    key = re.sub(r"\s+", " ", s.replace("_", " ")).strip().lower()
    return key, w


class LCDuplicateTags:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "keep": (["first", "strongest"], {"default": "first", "tooltip": "Which copy of a repeated tag stays. first: "
                         "the first one, as written. strongest: the most heavily weighted one, placed where the first was."}),
            },
            "optional": {
                "text": ("STRING", {"forceInput": True, "tooltip": "The prompt to clean. Optional so either input can be "
                         "bypassed upstream."}),
                "text_2": ("STRING", {"forceInput": True, "tooltip": "Optional second prompt, added after text and cleaned "
                           "together (e.g. your own prompt plus LC Vision Danbooru Caption's)."}),
            },
        }

    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("text", "removed")
    OUTPUT_TOOLTIPS = ("The prompt with every tag once.", "The tags that were taken out, for checking.")
    FUNCTION = "dedupe"
    CATEGORY = "LC123/utils"
    DESCRIPTION = (
        "Removes repeated tags so none gets double weight. Matches ignoring case, underscores and weights "
        "(long_hair = (long hair:1.2)). Sentences, blank-line breaks and BREAK pass through. Optional second prompt to "
        "merge two prompts and clean them together."
    )

    def dedupe(self, keep="first", text=None, text_2=None):
        blocks = [(b, 1) for b in re.split(r"\n\s*\n", _as_str(text).strip()) if b.strip()]
        blocks += [(b, 2) for b in re.split(r"\n\s*\n", _as_str(text_2).strip()) if b.strip()]
        seen: dict[str, tuple[int, int, float]] = {}  # key -> (block, index, weight) of the copy that stays
        out_blocks: list[list[str]] = []
        sources: list[int] = []
        removed: list[str] = []
        for bi, (block, src) in enumerate(blocks):
            sources.append(src)
            if _is_prose(block):
                out_blocks.append([block.strip()])  # a sentence block stays exactly as written
                continue
            pieces = _split_top(re.sub(r"\s+BREAK\s+", ", BREAK, ", block))
            kept: list[str] = []
            for piece in pieces:
                if piece.upper() == "BREAK" or len(piece.split()) > MAX_TAG_WORDS:
                    kept.append(piece)  # long phrases and BREAK are not tags
                    continue
                key, w = _key_weight(piece)
                if not key:
                    continue
                if "," in key:  # a weighted group like (red hoodie, jeans:1.2): its tags count as seen
                    inner = [k.strip() for k in key.split(",") if k.strip()]
                    if all(k in seen for k in inner):
                        removed.append(piece)
                        continue
                    for k in inner:
                        seen.setdefault(k, (bi, -1, w))  # -1: inside a group, never swapped out
                    kept.append(piece)
                    continue
                if key not in seen:
                    seen[key] = (bi, len(kept), w)
                    kept.append(piece)
                    continue
                removed.append(piece)
                fb, fi, fw = seen[key]
                if keep == "strongest" and w > fw and fi >= 0:  # the stronger copy takes the first one's place
                    target = kept if fb == bi else out_blocks[fb]
                    removed[-1] = target[fi]
                    target[fi] = piece
                    seen[key] = (fb, fi, w)
            out_blocks.append(kept)
        # text_2's tags join text's first tag block (not after a sentence)
        first_tags = next((i for i, (b, s) in enumerate(blocks) if s == 1 and not _is_prose(b)), None)
        final: list[list[str]] = []
        for i, (b, s) in enumerate(blocks):
            if s == 2 and first_tags is not None and not _is_prose(b):
                out_blocks[first_tags].extend(out_blocks[i])
                out_blocks[i] = []
        final = [b for b in out_blocks if b]
        return ("\n\n".join(", ".join(b) for b in final), ", ".join(removed))


NODE_CLASS_MAPPINGS = {"LCDuplicateTags": LCDuplicateTags}
NODE_DISPLAY_NAME_MAPPINGS = {"LCDuplicateTags": "LC ✂️ Duplicate Tags 🏷️"}
