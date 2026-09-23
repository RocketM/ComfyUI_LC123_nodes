"""
LC Image Pass / LC Mask Pass -- identity with enable mute.

`enable` off used to only work when it stayed a plain widget: the JS side reads that widget's value and mutes the
node (mode 2), so the engine skips it and downstream optional sockets see nothing. Wire a BOOLEAN into `enable`
instead and the widget's own value never updates -- the frontend never knows the wired value, so it can't mute --
and `run()` had a bug on top of that: both branches returned the same thing, so `enable` never did anything at the
Python level either. The result was that a wired `enable=False` was silently ignored and the real value always
passed through.

Fixed here: `run()` now actually returns a blocked signal when `enable` is off, checked at execution time, so it
is correct however `enable` is set -- widget or wire. The JS mute is left in place for a plain widget: it still
skips the node running at all, which is a nice-to-have, but the fix above is the part that makes this node correct.
"""

try:  # ComfyUI: skip downstream nodes without an error, the same way LC Preview Image/Mask do
    from comfy_execution.graph import ExecutionBlocker as _Blocker
except Exception:  # pragma: no cover
    _Blocker = None


def _blocked():
    return _Blocker(None) if _Blocker is not None else None


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
        "enable off (widget or a wired BOOLEAN) blocks the output so downstream optional sockets see no feed."
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
            return (_blocked(),)
        return (image,)


class LCMaskPass:
    """Pass MASK through unchanged. enable=False mutes so Color/Tone Match mask = None."""

    CATEGORY = "LC123/mask"
    RETURN_TYPES = ("MASK",)
    RETURN_NAMES = ("mask",)
    FUNCTION = "run"
    DESCRIPTION = (
        "Identity MASK for a bank tap. Leave Ultra live. "
        "enable off (widget or a wired BOOLEAN) blocks the output — Color Match / Tone Match then run with "
        "mask=None (full frame). Do not put this on the only mask wire into Skin Beauty / Skin Upscale if those "
        "must stay masked."
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
            return (_blocked(),)
        return (mask,)


NODE_CLASS_MAPPINGS = {
    "LCImagePass": LCImagePass,
    "LCMaskPass": LCMaskPass,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "LCImagePass": "LC Image Pass",
    "LCMaskPass": "LC Mask Pass",
}
