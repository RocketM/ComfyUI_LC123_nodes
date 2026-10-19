"""
LC Image Pass / LC Mask Pass: a firewall for an optional IMAGE / MASK input.

Bypassing or muting the node that makes a mask can crash the node it feeds (Skin Beauty's mask, for example). Put
a Pass in between instead: with enable off, the next node sees nothing on that input and runs without it.

enable as a widget: the JS mutes the node, so it never runs and the link is dropped.
enable wired (a BOOLEAN from a switch): the frontend can't see the wired value, so run() returns None instead,
which an optional input reads as "not connected".
"""

def _as_bool(v, default=True):
    if v is None:
        return default
    if isinstance(v, (list, tuple)):
        v = v[0] if v else default
    if isinstance(v, bool):
        return v
    if isinstance(v, (int, float)):
        return bool(v)
    s = str(v).strip().lower()
    if s in ("", "none", "null"):
        return default
    if s in ("0", "false", "no", "off"):
        return False
    if s in ("1", "true", "yes", "on"):
        return True
    return default


class LCImagePass:
    """Pass IMAGE through unchanged. enable off: the next node sees no image on this input."""

    CATEGORY = "LC123/image"
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
    FUNCTION = "run"
    DESCRIPTION = (
        "Passes the image through. With enable off, the next node sees nothing on that input and runs without it. "
        "Use it on optional inputs only: a required image input will error."
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
            },
            "optional": {
                "enable": ("BOOLEAN", {"default": True, "forceInput": False}),
            },
        }

    def run(self, image, enable=True):
        if not _as_bool(enable, True):
            return (None,)
        return (image,)


class LCMaskPass:
    """Pass MASK through unchanged. enable off: the next node sees no mask on this input."""

    CATEGORY = "LC123/mask"
    RETURN_TYPES = ("MASK",)
    RETURN_NAMES = ("mask",)
    FUNCTION = "run"
    DESCRIPTION = (
        "Passes the mask through. With enable off, the next node sees no mask and runs without one "
        "(Skin Beauty uses its own skin mask, Color / Tone Match use the full frame). "
        "Use it instead of bypassing or muting the node that makes the mask."
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "mask": ("MASK",),
            },
            "optional": {
                "enable": ("BOOLEAN", {"default": True, "forceInput": False}),
            },
        }

    def run(self, mask, enable=True):
        if not _as_bool(enable, True):
            return (None,)
        return (mask,)


NODE_CLASS_MAPPINGS = {
    "LCImagePass": LCImagePass,
    "LCMaskPass": LCMaskPass,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "LCImagePass": "LC Image Pass",
    "LCMaskPass": "LC Mask Pass",
}
