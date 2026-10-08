"""
LC 🚦
-----
A status light for a boolean. One input socket, no widgets, no output: the light on the face shows true or false.
Colors for each state (or none) are set behind the gear on the node.
"""


class LCLight:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "value": ("BOOLEAN", {"forceInput": True, "tooltip": "The boolean to show."}),
            },
        }

    RETURN_TYPES = ()
    FUNCTION = "show"
    OUTPUT_NODE = True
    CATEGORY = "LC123/utils"
    DESCRIPTION = "A light that shows a boolean: one color for true, one for false (or none). Colors behind the gear."

    def show(self, value=False):
        return {"ui": {"lc_light": [bool(value)]}}


NODE_CLASS_MAPPINGS = {"LCLight": LCLight}
NODE_DISPLAY_NAME_MAPPINGS = {"LCLight": "LC 🚦"}
