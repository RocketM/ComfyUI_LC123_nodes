class LCBypassRelay:
    CATEGORY = "LC123/utils"
    RETURN_TYPES = ()
    FUNCTION = "noop"
    OUTPUT_NODE = True
    DESCRIPTION = (
        "Plug nodes into the left. Plug OPT_CONNECTION into LC Bypasser or LC Mute. "
        "When the hub turns this node off, every left-hand node gets the same mute/bypass."
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {}}

    def noop(self):
        return ()


NODE_CLASS_MAPPINGS = {
    "LCBypassRelay": LCBypassRelay,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "LCBypassRelay": "LC Bypass Relay",
}
