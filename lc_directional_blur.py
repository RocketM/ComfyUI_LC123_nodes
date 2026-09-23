"""
LC Directional Blur
--------------------
Motion-style directional blur: every pixel smears along one vector (angle + length). Set it by dragging
the arrow on the node's own face (web/lc_directional_blur.js), or type exact values -- the arrow and the
angle/distance widgets stay in sync either way.

`taps` and `edge` mirror WAS Node Suite's Image Directional Blur:
- taps: WAS builds its smear from `taps` discrete grid_sample reads along the path and averages them --
  few taps looks like a stepped multi-exposure ghost, many taps converges to a smooth streak. We get the
  identical result a cheaper way: instead of `taps` separate image reads, the kernel itself is built as
  `taps` sub-pixel point-samples (bilinear-splatted so a fractional position doesn't snap to one pixel)
  along the same path, each weighted 1/taps, then convolved once via FFT. Averaging N shifted copies of an
  image and convolving with a kernel that is the sum of N unit impulses along that same path are the same
  operation -- this just does it in one FFT instead of N image reads.
- edge: what the kernel reads past the image border, matched to WAS's three options and to what NumPy's
  own np.pad already offers for free: "hold the edge" replicates the border pixel (np.pad mode="edge"),
  "mirror" folds the image back on itself (mode="reflect", this node's only behavior before this option
  existed), "empty" reads black past the edge (mode="constant"), which -- because the kernel is normalized
  to sum to 1 -- naturally darkens the border as more of the kernel's support falls outside the frame.

Still a normalized line kernel convolved via NumPy's FFT. No SciPy/OpenCV -- this pack declares no
dependencies beyond what ComfyUI itself already requires (NumPy, Pillow, Torch), and a hand-rolled FFT
convolution is plenty fast for a single pass over one image (a 1024x1024 image with a 60px kernel is well
under half a second).
"""

import numpy as np
from nodes import PreviewImage

from .lc_image_helpers import tensor_to_np, np_to_tensor

MAX_DISTANCE = 500.0

# Menu order/labels match WAS Node Suite's Image Directional Blur `edge` combo. "mirror" is the default --
# this node's only behavior before `edge` existed -- so loading an older saved workflow (no `edge` widget
# value stored yet) reproduces the exact same output it always did.
EDGES = ("hold the edge", "mirror", "empty")
_EDGE_PAD_MODES = {"hold the edge": "edge", "mirror": "reflect", "empty": "constant"}


def _preview(self, result_tensor, source_tensor=None):
    """Attach after (and before) preview images for the shared on-node wipe (web/lc_image_preview.js)."""
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


def _splat(kernel: np.ndarray, px: float, py: float, weight: float) -> None:
    """Bilinear-splat `weight` onto the 4 pixels nearest (px, py), so a sub-pixel tap position doesn't
    snap to one pixel -- without this, the kernel's effective length would jump in whole-pixel steps as
    `distance` or `taps` changes."""
    x0, y0 = int(np.floor(px)), int(np.floor(py))
    fx, fy = px - x0, py - y0
    h, w = kernel.shape
    for ix, iy, wgt in (
        (x0, y0, (1 - fx) * (1 - fy)),
        (x0 + 1, y0, fx * (1 - fy)),
        (x0, y0 + 1, (1 - fx) * fy),
        (x0 + 1, y0 + 1, fx * fy),
    ):
        if 0 <= ix < w and 0 <= iy < h:
            kernel[iy, ix] += weight * wgt


def _make_line_kernel(angle_deg: float, length: float, taps: int):
    """A small square kernel built from `taps` discrete point-samples spaced evenly along a line of the
    given length/angle -- see the module docstring for why this reproduces WAS's per-tap averaging in one
    kernel instead of `taps` separate image reads. Normalized to sum to 1. None means "no blur" (length
    too small to matter)."""
    length = max(0.0, float(length))
    if length < 1.0:
        return None
    taps = max(2, int(taps))

    size = int(2 * np.ceil(length / 2) + 1) + 2  # +2 slack: a splat can spill one pixel past its center
    size = max(size, 5)
    if size % 2 == 0:
        size += 1

    kernel = np.zeros((size, size), dtype=np.float64)
    c = size / 2.0
    rad = np.deg2rad(angle_deg)
    dx, dy = np.cos(rad), np.sin(rad)
    weight = 1.0 / taps
    for i in range(taps):
        t = (i / (taps - 1)) - 0.5  # taps >= 2 guaranteed above, so taps - 1 != 0
        _splat(kernel, c + dx * length * t, c + dy * length * t, weight)

    s = kernel.sum()
    if s <= 0:
        return None
    return kernel / s


def _fft_convolve_same(channel: np.ndarray, kernel: np.ndarray, edge: str) -> np.ndarray:
    """2D convolution, same-size output, edge-padded per `edge` (see EDGES / _EDGE_PAD_MODES)."""
    kh, kw = kernel.shape
    pad_h, pad_w = kh // 2, kw // 2
    pad_mode = _EDGE_PAD_MODES.get(edge, "reflect")
    pad_kwargs = {"constant_values": 0.0} if pad_mode == "constant" else {}
    padded = np.pad(channel, ((pad_h, pad_h), (pad_w, pad_w)), mode=pad_mode, **pad_kwargs)
    ph, pw = padded.shape

    kfull = np.zeros((ph, pw), dtype=np.float64)
    kfull[:kh, :kw] = kernel
    kfull = np.roll(kfull, (-pad_h, -pad_w), axis=(0, 1))  # center the kernel's own center at index (0,0)

    spec = np.fft.rfft2(padded) * np.fft.rfft2(kfull)
    conv = np.fft.irfft2(spec, s=padded.shape)
    h, w = channel.shape
    return conv[pad_h:pad_h + h, pad_w:pad_w + w]


class LCDirectionalBlur(PreviewImage):
    CATEGORY = "LC123/image"
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
    FUNCTION = "run"
    OUTPUT_NODE = True
    DESCRIPTION = (
        "Motion-style directional blur -- every pixel smears along one angle/length vector. Drag the arrow "
        "on the node's face to set it (angle from the arrow's direction, length from how far you drag), or "
        "type exact values. 0 length or 0 strength is a no-op. `taps` and `edge` match WAS Node Suite's "
        "Image Directional Blur -- fewer taps gives a stepped multi-exposure look instead of a smooth "
        "streak, and `edge` picks what the blur reads past the image border. On-node preview + wipe."
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                "angle": (
                    "FLOAT",
                    {
                        "default": 0.0, "min": 0.0, "max": 360.0, "step": 0.1,
                        "tooltip": "Blur direction in degrees, screen convention: 0 = right, 90 = down.",
                    },
                ),
                "distance": (
                    "FLOAT",
                    {
                        "default": 0.0, "min": 0.0, "max": MAX_DISTANCE, "step": 0.5,
                        "tooltip": "Blur length in pixels. 0 = no blur.",
                    },
                ),
                "strength": (
                    "FLOAT",
                    {
                        "default": 1.0, "min": 0.0, "max": 1.0, "step": 0.05,
                        "tooltip": "Blend toward the blurred result. The blur itself is a hard, full-strength "
                        "smear over its length -- turn this down rather than the distance if it's too much.",
                    },
                ),
                "taps": (
                    "INT",
                    {
                        "default": 64, "min": 2, "max": 128, "step": 1,
                        "tooltip": "How many samples are averaged along the path (WAS Node Suite's `taps`). "
                        "Low (2-8) reads as a visibly stepped multi-exposure ghost instead of a smooth streak "
                        "-- an effect in its own right, not just a quality knob. High (64+) is smooth even on "
                        "a long distance.",
                    },
                ),
                "edge": (
                    EDGES,
                    {
                        "default": "mirror",
                        "tooltip": "What the blur reads past the image border. 'hold the edge' repeats the "
                        "border pixel outward. 'mirror' folds the image back on itself (this node's original, "
                        "only behavior). 'empty' reads black past the edge, which darkens the border as the "
                        "smear runs off it.",
                    },
                ),
            },
        }

    def run(self, image, angle, distance, strength=1.0, taps=64, edge="mirror"):
        arrays = tensor_to_np(image)
        if strength <= 0:
            return _preview(self, image, image)

        kernel = _make_line_kernel(float(angle), float(distance), int(taps))
        if kernel is None:
            return _preview(self, image, image)

        out = []
        for img in arrays:
            img = np.clip(img, 0.0, 1.0).astype(np.float64)
            channels = [_fft_convolve_same(img[..., c], kernel, edge) for c in range(img.shape[-1])]
            blurred = np.stack(channels, axis=-1)
            if strength < 1.0:
                blurred = img * (1.0 - strength) + blurred * strength
            out.append(np.clip(blurred, 0.0, 1.0).astype(np.float32))
        return _preview(self, np_to_tensor(out), image)


NODE_CLASS_MAPPINGS = {"LCDirectionalBlur": LCDirectionalBlur}
NODE_DISPLAY_NAME_MAPPINGS = {"LCDirectionalBlur": "LC Directional Blur"}
