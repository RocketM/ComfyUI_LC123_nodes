"""LC Image Pass / LC Mask Pass — identity with enable mute."""


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
    """Pass IMAGE through unchanged. enable=False mutes the node (JS) so optional taps drop."""

    CATEGORY = "LC123/image"
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
    FUNCTION = "run"
    DESCRIPTION = (
        "Identity IMAGE. Wire on a side tap, not the main series. "
        "enable off (widget or BOOLEAN) mutes the node so downstream optional sockets see no feed."
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
            return (image,)
        return (image,)


class LCMaskPass:
    """Pass MASK through unchanged. enable=False mutes so Color/Tone Match mask = None."""

    CATEGORY = "LC123/mask"
    RETURN_TYPES = ("MASK",)
    RETURN_NAMES = ("mask",)
    FUNCTION = "run"
    DESCRIPTION = (
        "Identity MASK for a bank tap. Leave Ultra live. "
        "enable off mutes this node only — Color Match / Tone Match then run with mask=None (full frame). "
        "Do not put this on the only mask wire into Skin Beauty / Skin Upscale if those must stay masked."
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
            return (mask,)
        return (mask,)


NODE_CLASS_MAPPINGS = {
    "LCImagePass": LCImagePass,
    "LCMaskPass": LCMaskPass,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "LCImagePass": "LC Image Pass",
    "LCMaskPass": "LC Mask Pass",
}
