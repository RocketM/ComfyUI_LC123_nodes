"""
LC Phone Filters
-----------------
The same 37 named "phone app" style presets as WAS Node Suite's Image Style Filter (1977, Aden, Brooklyn,
Xpro2, and the rest) -- just a preset dropdown and a strength slider, on-node preview + wipe like every
other LC image FX node. The actual recipes live in lc_phone_filters_recipes.py.
"""

from nodes import PreviewImage

from .lc_image_helpers import tensor_to_np, np_to_tensor
from .lc_phone_filters_recipes import apply_style, STYLE_NAMES


def _preview(self, result_tensor, source_tensor=None):
    out = {"ui": {}, "result": (result_tensor,)}
    try:
        after = self.save_images(result_tensor, filename_prefix="lc_after")
        out["ui"]["lc_preview"] = after["ui"]["images"]
        if source_tensor is not None:
            before = self.save_images(source_tensor, filename_prefix="lc_before")
            out["ui"]["lc_before"] = before["ui"]["images"]
    except Exception:
        pass
    return out


class LCPhoneFilters(PreviewImage):
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                "preset": (
                    STYLE_NAMES,
                    {
                        "default": STYLE_NAMES[0],
                        "tooltip": "Same 37 looks as WAS Node Suite's Image Style Filter -- 1977, Aden, "
                        "Brooklyn, Xpro2, and the rest.",
                    },
                ),
                "strength": (
                    "FLOAT",
                    {
                        "default": 1.0, "min": 0.0, "max": 1.0, "step": 0.05,
                        "tooltip": "Blend toward the graded result. 1 = full look, 0 = original image.",
                    },
                ),
            }
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
    FUNCTION = "run"
    CATEGORY = "LC123/image"
    OUTPUT_NODE = True
    DESCRIPTION = (
        "37 phone-app style presets (same set as WAS Node Suite's Image Style Filter). Pick a look, dial "
        "strength, drag the on-node wipe to compare."
    )

    def run(self, image, preset, strength):
        if strength <= 0:
            return _preview(self, image, image)
        arrays = tensor_to_np(image)
        out = [apply_style(img, preset, strength) for img in arrays]
        return _preview(self, np_to_tensor(out), image)


NODE_CLASS_MAPPINGS = {"LCPhoneFilters": LCPhoneFilters}
NODE_DISPLAY_NAME_MAPPINGS = {"LCPhoneFilters": "LC Phone Filters 📱"}
