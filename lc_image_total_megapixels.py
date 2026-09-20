"""
LC Image to Total Megapixels
----------------------------
Same scaling as the native "Scale Image to Total Pixels" (megapixels are counted as 1024 x 1024 pixels,
sizes snap to resolution_steps), with two extra outputs: the resulting resolution (longer side in pixels)
and the resulting megapixels.
"""

import math

import comfy.utils

UPSCALE_METHODS = ["nearest-exact", "bilinear", "area", "bicubic", "lanczos"]


class LCImageToTotalMegapixels:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE", {"tooltip": "Image to scale."}),
                "upscale_method": (UPSCALE_METHODS, {"default": "lanczos", "tooltip": "Resampling method."}),
                "megapixels": ("FLOAT", {
                    "default": 1.0, "min": 0.01, "max": 16.0, "step": 0.01,
                    "tooltip": "Target size in megapixels, counted like the native node (1.0 = 1024 x 1024 pixels). The aspect ratio is kept.",
                }),
                "resolution_steps": ("INT", {
                    "default": 1, "min": 1, "max": 256,
                    "tooltip": "Width and height are rounded to a multiple of this (8, 16, 32, 64 for models that need it). 1 = off.",
                }),
            },
        }

    RETURN_TYPES = ("IMAGE", "INT", "FLOAT")
    RETURN_NAMES = ("image", "resolution", "megapixels")
    FUNCTION = "scale"
    CATEGORY = "LC123/image"
    DESCRIPTION = (
        "Scale an image to a total megapixel count, like Scale Image to Total Pixels. "
        "Also outputs the resulting resolution (longer side in pixels) and megapixels."
    )

    def scale(self, image, upscale_method, megapixels, resolution_steps):
        samples = image.movedim(-1, 1)
        total = megapixels * 1024 * 1024
        scale_by = math.sqrt(total / (samples.shape[3] * samples.shape[2]))
        step = max(1, int(resolution_steps))
        width = max(step, round(samples.shape[3] * scale_by / step) * step)
        height = max(step, round(samples.shape[2] * scale_by / step) * step)

        out = comfy.utils.common_upscale(samples, int(width), int(height), upscale_method, "disabled")
        out = out.movedim(1, -1)

        resolution = int(max(width, height))
        result_mp = round((int(width) * int(height)) / (1024.0 * 1024.0), 2)
        return (out, resolution, float(result_mp))


NODE_CLASS_MAPPINGS = {
    "LCImageToTotalMegapixels": LCImageToTotalMegapixels,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "LCImageToTotalMegapixels": "LC Image to Total Megapixels 📐",
}
