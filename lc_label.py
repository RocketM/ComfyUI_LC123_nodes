"""
LC Label
--------
A floating, chromeless text label for annotating a workflow: no title bar, no sockets, no execution. Pick a font
and a color, drag the rotate handle like the one in Word or Paint, drag a corner handle to scale it.

The label is drawn as HTML on top of the canvas so it never gets buried under nodes or links. All of the behavior
lives in web/lc_label.js (settings dialog on double-click, like LC Image Label); this file is only the backend stub
ComfyUI requires. Fonts bundled in web/fonts (Bebas Neue, Oswald, Pacifico: SIL OFL 1.1; Permanent Marker: Apache 2.0).
"""

NODE_NAME = "LCLabel"


class LCLabel:
    CATEGORY = "LC123/utils"
    FUNCTION = "noop"
    OUTPUT_NODE = True
    DESCRIPTION = (
        "Floating text label for annotating a workflow. No title, no sockets. Double-click to open settings "
        "(text, font, size, color, outline, shadow, background). Drag the round handle above it to rotate, "
        "hold Shift to snap to 15 degrees, drag a corner to scale."
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {}}

    RETURN_TYPES = ()

    def noop(self):
        return {}


NODE_CLASS_MAPPINGS = {NODE_NAME: LCLabel}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "LC Label 🏷️"}
