"""
LC Image Ref Pipe In / Out
--------------------------
Carry up to 16 reference images on one wire.

In:  image_1..image_16, autogrow (same socket names and growth as core's
     Text Encode Qwen Image 2.1). Out: one LC_IMAGE_REF_PIPE.
Out: pipe passthrough first, then image_1..image_16 in the same slots they
     went in on. An empty slot comes out as None, which Text Encode Qwen
     Image 2.1 skips. Output sockets grow in the JS (web/lc_image_ref_pipe.js).
"""

from __future__ import annotations

import torch
from comfy_api.latest import io

PIPE_TYPE = "LC_IMAGE_REF_PIPE"
MAX_IMAGES = 16
NAMES = [f"image_{i}" for i in range(1, MAX_IMAGES + 1)]


def _live(v):
    """Real IMAGE tensor or None (muted / blocked / empty)."""
    if not torch.is_tensor(v) or v.ndim != 4 or v.shape[0] == 0:
        return None
    return v


class LCImageRefPipeIn(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="LCImageRefPipeIn",
            display_name="LC Image Ref Pipe In 🖼️",
            category="LC123/pipe",
            description="Bundle up to 16 reference images into one pipe. A new socket appears as you fill the last one, "
                        "same as Text Encode Qwen Image 2.1. Slot numbers are kept, so image_3 in is image_3 out.",
            inputs=[
                io.Autogrow.Input(
                    "images",
                    template=io.Autogrow.TemplateNames(
                        io.Image.Input("image"),
                        names=NAMES,
                        min=0,
                    ),
                    tooltip="Reference images. Empty or muted slots are carried as empty.",
                ),
            ],
            outputs=[io.Custom(PIPE_TYPE).Output(display_name="pipe")],
        )

    @classmethod
    def execute(cls, images: io.Autogrow.Type = None) -> io.NodeOutput:
        images = images or {}
        return io.NodeOutput({"images": [_live(images.get(n)) for n in NAMES]})


class LCImageRefPipeOut(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="LCImageRefPipeOut",
            display_name="LC Image Ref Pipe Out 🖼️",
            category="LC123/pipe",
            description="Unpack an LC Image Ref Pipe. Pipe passes through first, then image_1..image_16 in their "
                        "original slots. Image sockets grow to match the pipe in, plus one as you wire them.",
            inputs=[io.Custom(PIPE_TYPE).Input("pipe")],
            outputs=[io.Custom(PIPE_TYPE).Output(display_name="pipe")]
            + [io.Image.Output(display_name=n) for n in NAMES],
        )

    @classmethod
    def execute(cls, pipe) -> io.NodeOutput:
        imgs = list((pipe or {}).get("images") or [])
        imgs = (imgs + [None] * MAX_IMAGES)[:MAX_IMAGES]
        return io.NodeOutput(pipe, *imgs)


NODE_CLASS_MAPPINGS = {
    "LCImageRefPipeIn": LCImageRefPipeIn,
    "LCImageRefPipeOut": LCImageRefPipeOut,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "LCImageRefPipeIn": "LC Image Ref Pipe In 🖼️",
    "LCImageRefPipeOut": "LC Image Ref Pipe Out 🖼️",
}
