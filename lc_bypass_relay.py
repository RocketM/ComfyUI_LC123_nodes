class LCBypassRelay:
    CATEGORY = "LC123/utils"
    RETURN_TYPES = ("*",)
    RETURN_NAMES = ("OPT_CONNECTION",)
    FUNCTION = "run"
    DESCRIPTION = (
        "Plug nodes into the left. Plug OPT_CONNECTION into LC Bypasser or LC Mute. "
        "When the hub turns this node off, every left-hand node gets the same mute/bypass."
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {},
            "optional": {
                "any_1": ("*",),
            },
        }

    def run(self, any_1=None, **kwargs):
        if any_1 is not None:
            return (any_1,)
        for i in range(2, 17):
            v = kwargs.get(f"any_{i}")
            if v is not None:
                return (v,)
        return (None,)


NODE_CLASS_MAPPINGS = {
    "LCBypassRelay": LCBypassRelay,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "LCBypassRelay": "LC Bypass Relay",
}
