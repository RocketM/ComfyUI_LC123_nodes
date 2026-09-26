"""LC Show Any — show any value on the node and pass the SAME value through (type kept)."""

import torch

from .lc_show_text import _pretty_if_json


class AnyType(str):
    def __ne__(self, other):
        return False


any_type = AnyType("*")


def _describe(v, depth=0) -> str:
    if v is None:
        return "None"
    if isinstance(v, str):
        return _pretty_if_json(v)
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return str(v)
    if torch.is_tensor(v):
        s = list(v.shape)
        if v.ndim == 4 and s[-1] in (1, 3, 4):
            return f"IMAGE  {s[2]} x {s[1]}, batch {s[0]}, {s[3]} channels"
        if v.ndim == 3:
            return f"MASK  {s[2]} x {s[1]}, batch {s[0]}"
        return f"TENSOR  shape {s}, {str(v.dtype).replace('torch.', '')}"
    if isinstance(v, dict) and torch.is_tensor(v.get("samples")):
        s = list(v["samples"].shape)
        return f"LATENT  shape {s}"
    if isinstance(v, (list, tuple)):
        if depth == 0 and all(isinstance(x, (str, int, float, bool)) or x is None for x in v):
            return "\n".join(_describe(x, 1) for x in v)
        head = ", ".join(_describe(x, depth + 1) for x in v[:5])
        return f"{type(v).__name__} of {len(v)}: [{head}{', ...' if len(v) > 5 else ''}]"
    return type(v).__name__


class LCShowAny:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "any": (any_type, {"tooltip": "Anything. Numbers, text, dropdown values and booleans show as-is. Images, masks and latents show their size."}),
            },
        }

    RETURN_TYPES = (any_type,)
    RETURN_NAMES = ("any",)
    FUNCTION = "show"
    CATEGORY = "LC123/utils"
    OUTPUT_NODE = True
    DESCRIPTION = (
        "Show any value on the node and pass the same value through, type unchanged. "
        "An INT stays an INT and a sampler name stays a sampler name, so it can sit in the middle of a wire."
    )

    def show(self, any):
        return {"ui": {"text": [_describe(any)]}, "result": (any,)}


NODE_CLASS_MAPPINGS = {"LCShowAny": LCShowAny}
NODE_DISPLAY_NAME_MAPPINGS = {"LCShowAny": "LC Show Any 🔤"}
