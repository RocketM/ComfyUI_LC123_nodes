"""
LC Phone Filters -- color-grade recipes
----------------------------------------
Same 37 named looks as WAS Node Suite's Image Style Filter (1977, Aden, Brooklyn, Xpro2, and the rest),
reimplemented here in plain NumPy/Pillow so this pack still declares zero third-party dependencies. Each
recipe is a small composition of the primitives below -- brightness/contrast/saturation, a sepia matrix, a
CSS-spec hue rotation, split-toning and shadow-tinting, a handful of Photoshop/CSS blend modes against a
solid color or a gradient, and a closing halation (soft bloom) pass -- mirroring WAS's own recipe shape
(each style is "grade, then glow") rather than a LUT or curve file.

Everything operates on HxWx3 float32 arrays in [0, 1]. `apply_style(plane, name, strength)` is the entry
point the node calls.
"""

import numpy as np
from PIL import Image, ImageFilter

# ---------------------------------------------------------------------------------------------- primitives

def _held(x):
    return np.clip(x, 0.0, 1.0).astype(np.float32)


def luminance(plane):
    return (plane[..., 0] * 0.2126 + plane[..., 1] * 0.7152 + plane[..., 2] * 0.0722).astype(np.float32)


def brightness(plane, amount):
    return _held(plane * amount)


def contrast(plane, amount, pivot=0.5):
    return _held((plane - pivot) * amount + pivot)


def saturation(plane, amount):
    grey = luminance(plane)[..., None]
    return _held(grey + (plane - grey) * amount)


def fade(plane, amount):
    """Lifts the black point toward a matte gray without moving white -- the 'faded film' look."""
    return _held(plane * (1.0 - amount) + amount)


_SEPIA_MATRIX = np.array(
    [[0.393, 0.769, 0.189], [0.349, 0.686, 0.168], [0.272, 0.534, 0.131]], dtype=np.float32
)


def sepia(plane, amount=1.0):
    toned = plane @ _SEPIA_MATRIX.T
    return _held(plane + (toned - plane) * min(float(amount), 1.0))


def hue_rotate(plane, degrees):
    """CSS Filter Effects spec hueRotate() matrix (W3C), applied as a 3x3 linear transform."""
    a = np.deg2rad(degrees)
    c, s = np.cos(a), np.sin(a)
    m = np.array(
        [
            [0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928],
            [0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.140, 0.072 - c * 0.072 - s * 0.283],
            [0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072],
        ],
        dtype=np.float32,
    )
    return _held(plane @ m.T)


def temperature(plane, warmth):
    """warmth > 0 = warmer (gain red, cut blue); < 0 = cooler."""
    gain = 1.0 + float(warmth) * 0.06
    out = plane.copy()
    out[..., 0] = out[..., 0] * gain
    out[..., 2] = out[..., 2] * (2.0 - gain)
    return _held(out)


def split_tone(plane, shadows, highlights, strength=1.0, reach=0.14):
    lum = luminance(plane)[..., None]
    shadow_w = np.clip(1.0 - lum / 0.5, 0.0, 1.0)
    highlight_w = np.clip((lum - 0.5) / 0.5, 0.0, 1.0)
    shadows_arr = np.array(shadows, dtype=np.float32)
    highlights_arr = np.array(highlights, dtype=np.float32)
    tint = shadow_w * shadows_arr + highlight_w * highlights_arr
    return _held(plane + (tint - 0.5) * reach * strength * 2.0)


def tint_shadows(plane, colour, amount, reach=0.30):
    lum = luminance(plane)[..., None]
    w = (1.0 - lum) ** 2
    colour_arr = np.array(colour, dtype=np.float32)
    return _held(plane + (colour_arr - plane) * w * reach * amount)


def rgb8(r, g, b):
    return (r / 255.0, g / 255.0, b / 255.0)


def fill(shape, colour):
    h, w = shape[:2]
    return np.broadcast_to(np.array(colour, dtype=np.float32), (h, w, 3)).copy()


def _radial_dist(shape, scale=1.0, cx=0.5, cy=0.5):
    h, w = shape[:2]
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    xx = xx / max(w - 1, 1) - cx
    yy = (yy / max(h - 1, 1) - cy) * (h / w)
    return np.sqrt(xx ** 2 + yy ** 2) / (0.5 * max(scale, 1e-4))


def radial_mask(shape, length=0.0, scale=1.0, centre_x=0.5, centre_y=0.5):
    """1.0 within `length` fraction of the radius, falling off linearly to 0 at the edge."""
    dist = _radial_dist(shape, scale, centre_x, centre_y)
    length = float(length)
    if length >= 1.0:
        return np.ones(shape[:2] + (1,), dtype=np.float32)
    mask = np.clip(1.0 - (dist - length) / max(1.0 - length, 1e-4), 0.0, 1.0)
    return mask[..., None].astype(np.float32)


def linear_mask(shape, start=0.0, stop=1.0, horizontal=True):
    h, w = shape[:2]
    axis = np.linspace(0.0, 1.0, w if horizontal else h, dtype=np.float32)
    t = np.clip((axis - start) / max(stop - start, 1e-4), 0.0, 1.0)
    mask = np.tile(t, (h, 1)) if horizontal else np.tile(t[:, None], (1, w))
    return mask[..., None]


def quarter_turn(mask):
    return np.rot90(mask, k=1).copy()


def linear_gradient(shape, first, last, horizontal=False):
    h, w = shape[:2]
    n = w if horizontal else h
    t = np.linspace(0.0, 1.0, n, dtype=np.float32)[:, None]
    ramp = (1.0 - t) * np.array(first, dtype=np.float32) + t * np.array(last, dtype=np.float32)
    if horizontal:
        return np.broadcast_to(ramp[None, :, :], (h, w, 3)).copy()
    return np.broadcast_to(ramp[:, None, :], (h, w, 3)).copy()


def radial_gradient(shape, colours, positions=None, scale=1.0, cx=0.5, cy=0.5):
    dist = np.clip(_radial_dist(shape, scale, cx, cy), 0.0, 1.0)
    if positions is None:
        positions = np.linspace(0.0, 1.0, len(colours))
    out = np.zeros(shape[:2] + (3,), dtype=np.float32)
    colours = [np.array(c, dtype=np.float32) for c in colours]
    for i in range(len(colours) - 1):
        p0, p1 = positions[i], positions[i + 1]
        t = np.clip((dist - p0) / max(p1 - p0, 1e-4), 0.0, 1.0)[..., None]
        seg = (1.0 - t) * colours[i] + t * colours[i + 1]
        band = (dist >= p0) & (dist <= p1 if i == len(colours) - 2 else dist < p1)
        out[band] = seg[band]
    out[dist < positions[0]] = colours[0]
    out[dist > positions[-1]] = colours[-1]
    return out


def blend_opacity(backdrop, source, opacity):
    return _held(backdrop + (source - backdrop) * opacity)


def composite_mask(over, under, mask):
    return _held(under + (over - under) * mask)


def _blend_mode(a, b, mode):
    """a = backdrop, b = source, both HxWx3 in [0,1]. Standard CSS/Photoshop blend formulas."""
    if mode == "normal":
        return b
    if mode == "multiply":
        return a * b
    if mode == "screen":
        return 1.0 - (1.0 - a) * (1.0 - b)
    if mode == "darken":
        return np.minimum(a, b)
    if mode == "lighten":
        return np.maximum(a, b)
    if mode == "overlay":
        return np.where(a <= 0.5, 2 * a * b, 1.0 - 2 * (1.0 - a) * (1.0 - b))
    if mode == "soft-light":
        d = np.where(b <= 0.25, ((16 * b - 12) * b + 4) * b, np.sqrt(np.maximum(b, 0.0)))
        return np.where(b <= 0.5, a - (1.0 - 2 * b) * a * (1.0 - a), a + (2 * b - 1.0) * (d - a))
    if mode == "hard-light":
        return np.where(b <= 0.5, 2 * a * b, 1.0 - 2 * (1.0 - a) * (1.0 - b))
    if mode == "color-dodge":
        return np.where(b >= 1.0, 1.0, np.minimum(1.0, a / np.maximum(1.0 - b, 1e-6)))
    if mode == "color-burn":
        return np.where(b <= 0.0, 0.0, 1.0 - np.minimum(1.0, (1.0 - a) / np.maximum(b, 1e-6)))
    if mode == "exclusion":
        return a + b - 2 * a * b
    raise ValueError(f"unknown blend mode {mode!r}")


def blend_image(backdrop, source, mode):
    return _held(_blend_mode(backdrop, source, mode))


def blend_fill(backdrop, mode, colour, alpha=1.0):
    solid = fill(backdrop.shape, colour)
    blended = _blend_mode(backdrop, solid, mode)
    return _held(backdrop + (blended - backdrop) * alpha)


def greyscale(plane, amount=1.0):
    grey = luminance(plane)[..., None]
    grey3 = np.repeat(grey, 3, axis=-1)
    return _held(plane + (grey3 - plane) * amount)


def bloom(plane, threshold=0.7, radius=0.04, intensity=0.5, colour=None):
    """Soft-knee highlight glow: blur the bright parts and screen them back in."""
    lum = luminance(plane)
    knee = np.clip((lum - threshold) / max(1.0 - threshold, 1e-4), 0.0, 1.0)[..., None]
    hi = plane * knee
    h, w = plane.shape[:2]
    px_radius = max(1, int(radius * max(h, w)))
    img = Image.fromarray((np.clip(hi, 0, 1) * 255).astype(np.uint8))
    blurred = np.asarray(img.filter(ImageFilter.GaussianBlur(px_radius))).astype(np.float32) / 255.0
    if colour is not None:
        tint = np.array(colour, dtype=np.float32)
        blurred = blurred * tint
    glow = 1.0 - (1.0 - plane) * (1.0 - blurred * intensity)
    return _held(glow)


# ---------------------------------------------------------------------------------------- Instagram palette
GOLD = (1.00, 0.78, 0.46)
EMBER = (1.00, 0.62, 0.28)
PEARL = (1.00, 0.95, 0.88)
FROST = (0.80, 0.90, 1.00)
NEON = (1.00, 0.52, 0.92)
ROSE = (1.00, 0.84, 0.88)

# ---------------------------------------------------------------------------------------------------- recipes
# Each takes/returns an HxWx3 float32 [0,1] plane. Faithful to WAS's compositing recipe (same colors, same
# blend modes, same order); the couple of shared primitives WAS keeps private (split_tone/tint_shadows'
# exact curve, radial_mask's exact falloff) are reconstructed above to the same effect, not lifted verbatim.

def _1977(p):
    g = blend_fill(p, "screen", rgb8(243, 106, 188), 0.3)
    return saturation(brightness(contrast(g, 1.1), 1.1), 1.3)


def _aden(p):
    tinted = blend_fill(p, "darken", rgb8(66, 10, 14))
    fading = quarter_turn(linear_mask(p.shape, start=0.8, horizontal=False))
    g = composite_mask(tinted, p, fading)
    g = saturation(contrast(hue_rotate(g, -20.0), 0.9), 0.85)
    return brightness(g, 1.2)


def _bleach_bypass(p):
    blown = blend_image(p, greyscale(p), "screen")
    g = blend_opacity(p, blown, 0.3)
    g = saturation(g, 0.48)
    g = contrast(g, 1.46, 0.40)
    return split_tone(g, (0.64, 0.50, 0.38), (0.40, 0.50, 0.62), 2.1)


def _brannan(p):
    g = blend_fill(p, "lighten", rgb8(161, 44, 199), 0.31)
    return contrast(sepia(g, 0.5), 1.4)


def _brooklyn(p):
    middle = blend_fill(p, "overlay", rgb8(168, 223, 193), 0.4)
    outside = blend_fill(p, "overlay", rgb8(196, 183, 200))
    g = composite_mask(middle, outside, radial_mask(p.shape, length=0.7))
    return brightness(contrast(g, 0.9), 1.1)


def _clarendon(p):
    g = blend_fill(p, "overlay", rgb8(127, 187, 227), 0.2)
    return saturation(contrast(g, 1.2), 1.35)


def _clean_punch(p):
    g = contrast(p, 1.30, 0.24)
    g = saturation(g, 1.36)
    g = split_tone(g, (0.44, 0.46, 0.82), (0.48, 0.46, 0.72))
    return brightness(g, 1.06)


def _cross_process(p):
    g = split_tone(p, (0.50, 0.86, 0.50), (0.68, 0.84, 0.40), 1.6)
    g = saturation(contrast(g, 1.20, 0.44), 1.25)
    return blend_fill(g, "soft-light", rgb8(150, 210, 80), 0.10)


def _earlybird(p):
    ramp = radial_gradient(p.shape, [rgb8(208, 186, 142), rgb8(54, 3, 9), rgb8(29, 2, 16)], [0.2, 0.85, 1.0])
    g = blend_image(p, ramp, "overlay")
    return sepia(contrast(g, 0.9), 0.2)


def _faded_film(p):
    g = contrast(saturation(p, 0.85), 0.85, 0.45)
    g = fade(g, 0.075)
    g = split_tone(g, (0.81, 0.56, 0.02), (0.78, 0.56, 0.08))
    return brightness(g, 1.02)


def _film_noir(p):
    g = contrast(greyscale(p), 1.4, 0.18)
    darkened = blend_fill(g, "multiply", rgb8(46, 50, 58))
    g = composite_mask(g, darkened, radial_mask(p.shape, length=0.35, scale=1.05))
    return tint_shadows(g, (0.40, 0.56, 0.60), 0.8)


def _gingham(p):
    g = blend_fill(p, "soft-light", rgb8(230, 230, 250))
    return hue_rotate(brightness(g, 1.05), -10.0)


def _golden_hour(p):
    sun = linear_gradient(p.shape, rgb8(255, 196, 120), rgb8(112, 116, 140))
    g = blend_opacity(p, blend_image(p, sun, "soft-light"), 0.5)
    g = split_tone(g, (0.86, 0.52, 0.24), (0.92, 0.54, 0.18))
    return saturation(contrast(g, 1.06), 1.12)


def _hudson(p):
    ramp = radial_gradient(p.shape, [rgb8(166, 177, 255), rgb8(52, 33, 52)], [0.5, 1.0])
    darkened = blend_image(p, ramp, "multiply")
    g = blend_opacity(p, darkened, 0.5)
    return saturation(contrast(brightness(g, 1.2), 0.9), 1.1)


def _inkwell(p):
    g = brightness(contrast(sepia(p, 0.3), 1.1), 1.1)
    return greyscale(g)


def _kelvin(p):
    g = blend_fill(p, "color-dodge", rgb8(56, 44, 52))
    return blend_fill(g, "overlay", rgb8(183, 125, 33))


def _lark(p):
    g = blend_fill(p, "color-dodge", rgb8(34, 37, 63))
    g = blend_fill(g, "darken", rgb8(242, 242, 242), 0.8)
    return contrast(g, 0.9)


def _lofi(p):
    darkened = blend_fill(p, "multiply", rgb8(34, 34, 34))
    g = composite_mask(p, darkened, radial_mask(p.shape, length=0.7, scale=1.5))
    return contrast(saturation(g, 1.1), 1.5)


def _maven(p):
    g = blend_fill(p, "color-dodge", rgb8(3, 230, 26), 0.2)  # closest std blend for WAS's blend_hue
    g = contrast(brightness(sepia(g, 0.25), 0.95), 0.95)
    return saturation(g, 1.5)


def _mayfair(p):
    white = blend_fill(p, "overlay", rgb8(255, 255, 255), 0.8)
    pink = blend_fill(p, "overlay", rgb8(255, 200, 200), 0.6)
    dark = blend_fill(p, "overlay", rgb8(17, 17, 17))
    lit = composite_mask(white, pink, radial_mask(p.shape, scale=0.3, centre_x=0.4, centre_y=0.4))
    lit = composite_mask(lit, dark, radial_mask(p.shape, length=0.3, scale=0.6, centre_x=0.4, centre_y=0.4))
    g = blend_opacity(p, lit, 0.4)
    return saturation(contrast(g, 1.1), 1.1)


def _moody_blue(p):
    g = temperature(p, -1.2)
    g = tint_shadows(g, (0.32, 0.46, 0.90), 0.6)
    return saturation(contrast(g, 1.12, 0.42), 0.85)


def _moon(p):
    g = blend_fill(p, "soft-light", rgb8(160, 160, 160))
    g = blend_fill(g, "lighten", rgb8(56, 56, 56))
    return brightness(contrast(greyscale(g), 1.1), 1.1)


def _nashville(p):
    g = blend_fill(p, "darken", rgb8(247, 176, 153), 0.56)
    g = blend_fill(g, "lighten", rgb8(0, 70, 150), 0.4)
    g = brightness(contrast(sepia(g, 0.2), 1.2), 1.05)
    return saturation(g, 1.2)


def _neon_night(p):
    g = split_tone(p, (0.25, 0.42, 0.98), (0.90, 0.40, 0.85))
    g = blend_fill(g, "screen", rgb8(46, 0, 20), 0.5)
    return saturation(contrast(g, 1.15, 0.40), 1.3)


def _perpetua(p):
    ramp = linear_gradient(p.shape, rgb8(0, 91, 154), rgb8(230, 193, 61), horizontal=False)
    lit = blend_image(p, ramp, "soft-light")
    return blend_opacity(p, lit, 0.5)


def _reyes(p):
    lit = blend_fill(p, "soft-light", rgb8(239, 205, 173))
    g = blend_opacity(p, lit, 0.5)
    g = contrast(brightness(sepia(g, 0.22), 1.1), 0.85)
    return saturation(g, 0.75)


def _rise(p):
    middle = blend_fill(p, "multiply", rgb8(236, 205, 169), 0.15)
    outside = blend_fill(p, "multiply", rgb8(50, 30, 7), 0.4)
    shaded = composite_mask(middle, outside, radial_mask(p.shape, length=0.55))
    glow = blend_fill(shaded, "overlay", rgb8(232, 197, 152), 0.8)
    lit = composite_mask(glow, shaded, radial_mask(p.shape, scale=0.9))
    g = blend_opacity(shaded, lit, 0.6)
    g = contrast(sepia(brightness(g, 1.05), 0.2), 0.9)
    return saturation(g, 0.9)


def _slumber(p):
    g = blend_fill(p, "lighten", rgb8(69, 41, 12), 0.4)
    g = blend_fill(g, "soft-light", rgb8(125, 105, 24), 0.5)
    return brightness(saturation(g, 0.66), 1.05)


def _soft_portrait(p):
    g = split_tone(p, (0.74, 0.50, 0.68), (0.92, 0.52, 0.58), 1.6)
    g = contrast(g, 0.88, 0.52)
    shaded = blend_fill(g, "multiply", rgb8(168, 148, 154))
    g = composite_mask(g, shaded, radial_mask(p.shape, length=0.25, scale=1.0))
    return saturation(fade(g, 0.05), 0.86)


def _stinson(p):
    g = blend_fill(p, "soft-light", rgb8(240, 149, 128), 0.2)
    return brightness(saturation(contrast(g, 0.75), 0.85), 1.15)


def _teal_and_orange(p):
    g = contrast(p, 1.18, 0.42)
    g = split_tone(g, (0.16, 0.58, 0.76), (0.96, 0.48, 0.08), 2.4)
    return saturation(g, 1.10)


def _toaster(p):
    ramp = radial_gradient(p.shape, [rgb8(128, 78, 15), rgb8(59, 0, 59)])
    g = blend_image(p, ramp, "screen")
    return brightness(contrast(g, 1.5), 0.9)


def _valencia(p):
    lifted = blend_fill(p, "exclusion", rgb8(58, 3, 57))
    g = blend_opacity(p, lifted, 0.5)
    return sepia(brightness(contrast(g, 1.08), 1.08), 0.08)


def _walden(p):
    washed = blend_fill(p, "screen", rgb8(0, 68, 204))
    g = blend_opacity(p, washed, 0.3)
    g = sepia(hue_rotate(brightness(g, 1.1), -10.0), 0.3)
    return saturation(g, 1.6)


def _willow(p):
    # WAS's final step is a "color" blend against a warm gray, which needs the HSL-style non-separable
    # blend modes this port doesn't carry; the radial overlay above already sets the same warm/dark cast.
    ramp = radial_gradient(p.shape, [rgb8(212, 169, 175), rgb8(0, 0, 0)], [0.55, 1.5])
    g = blend_image(p, ramp, "overlay")
    return brightness(contrast(greyscale(g, 0.5), 0.95), 0.9)


def _xpro2(p):
    paper = fill(p.shape, rgb8(230, 231, 224))
    surround = blend_opacity(p, fill(p.shape, rgb8(43, 42, 161)), 0.6)
    mask = radial_mask(p.shape, length=0.4, scale=1.1)
    layer = composite_mask(paper, surround, mask)
    burned = blend_image(p, layer, "color-burn")
    softened = blend_opacity(p, burned, 0.6)
    return sepia(composite_mask(burned, softened, mask), 0.3)


def _fairy_tale(p):
    """The one non-deterministic style (matches WAS's own 'sparkle' -- a different result every run):
    contrast + saturate, a soft bloom, then a scatter of random colored glitter dots screened in."""
    g = saturation(contrast(p, 1.25), 1.5)
    g = bloom(g, threshold=0.6, radius=0.03, intensity=0.35)
    h, w = p.shape[:2]
    glitter = Image.new("RGB", (w, h), (0, 0, 0))
    draw_img = np.asarray(glitter).copy()
    n = max(1, (h * w) // 400)
    ys = np.random.randint(0, h, n)
    xs = np.random.randint(0, w, n)
    colours = np.random.randint(80, 256, (n, 3))
    draw_img[ys, xs] = colours
    glitter_arr = draw_img.astype(np.float32) / 255.0
    glitter_img = Image.fromarray((glitter_arr * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(0.6))
    glitter_arr = np.asarray(glitter_img).astype(np.float32) / 255.0
    return _held(1.0 - (1.0 - g) * (1.0 - glitter_arr * 0.5))


RECIPES = {
    "1977": _1977,
    "aden": _aden,
    "bleach bypass": _bleach_bypass,
    "brannan": _brannan,
    "brooklyn": _brooklyn,
    "clarendon": _clarendon,
    "clean punch": _clean_punch,
    "cross process": _cross_process,
    "earlybird": _earlybird,
    "faded film": _faded_film,
    "fairy tale": _fairy_tale,
    "film noir": _film_noir,
    "gingham": _gingham,
    "golden hour": _golden_hour,
    "hudson": _hudson,
    "inkwell": _inkwell,
    "kelvin": _kelvin,
    "lark": _lark,
    "lofi": _lofi,
    "maven": _maven,
    "mayfair": _mayfair,
    "moody blue": _moody_blue,
    "moon": _moon,
    "nashville": _nashville,
    "neon night": _neon_night,
    "perpetua": _perpetua,
    "reyes": _reyes,
    "rise": _rise,
    "slumber": _slumber,
    "soft portrait": _soft_portrait,
    "stinson": _stinson,
    "teal and orange": _teal_and_orange,
    "toaster": _toaster,
    "valencia": _valencia,
    "walden": _walden,
    "willow": _willow,
    "xpro2": _xpro2,
}

# (threshold, radius, intensity, colour) -- a light closing halation pass per style, colourless where WAS
# leaves it colourless (None). Every recipe gets a subtle one; a handful get none (kept flat on purpose).
HALATION = {
    "1977": (0.66, 0.050, 0.55, GOLD),
    "aden": (0.75, 0.035, 0.25, ROSE),
    "bleach bypass": (0.55, 0.045, 0.30, None),
    "brannan": (0.70, 0.040, 0.35, EMBER),
    "brooklyn": (0.78, 0.030, 0.20, PEARL),
    "clarendon": (0.80, 0.030, 0.20, FROST),
    "clean punch": (0.82, 0.025, 0.15, None),
    "cross process": (0.68, 0.045, 0.30, None),
    "earlybird": (0.70, 0.050, 0.40, EMBER),
    "faded film": (0.78, 0.035, 0.20, PEARL),
    "fairy tale": None,
    "film noir": (0.60, 0.060, 0.55, None),
    "gingham": (0.80, 0.030, 0.18, FROST),
    "golden hour": (0.62, 0.055, 0.55, GOLD),
    "hudson": (0.72, 0.045, 0.35, FROST),
    "inkwell": (0.72, 0.040, 0.35, None),
    "kelvin": (0.66, 0.050, 0.55, EMBER),
    "lark": (0.80, 0.030, 0.20, FROST),
    "lofi": (0.68, 0.040, 0.30, None),
    "maven": (0.70, 0.040, 0.30, None),
    "mayfair": (0.75, 0.035, 0.30, PEARL),
    "moody blue": (0.75, 0.040, 0.25, FROST),
    "moon": (0.72, 0.040, 0.35, None),
    "nashville": (0.70, 0.045, 0.35, ROSE),
    "neon night": (0.60, 0.055, 0.60, NEON),
    "perpetua": (0.72, 0.040, 0.30, GOLD),
    "reyes": (0.78, 0.035, 0.25, PEARL),
    "rise": (0.70, 0.045, 0.40, GOLD),
    "slumber": (0.75, 0.040, 0.25, None),
    "soft portrait": (0.80, 0.035, 0.25, ROSE),
    "stinson": (0.75, 0.040, 0.30, EMBER),
    "teal and orange": (0.68, 0.045, 0.30, None),
    "toaster": (0.62, 0.050, 0.45, EMBER),
    "valencia": (0.72, 0.040, 0.30, GOLD),
    "walden": (0.68, 0.045, 0.35, FROST),
    "willow": (0.62, 0.055, 0.50, None),
    "xpro2": (0.70, 0.045, 0.35, None),
}

STYLE_NAMES = list(RECIPES.keys())


def apply_style(plane, name, strength=1.0):
    """plane: HxWx3 float32 [0,1]. Returns the graded plane blended back toward the source by `strength`."""
    recipe = RECIPES.get(name)
    if recipe is None:
        return plane
    graded = recipe(plane.astype(np.float32))
    halation = HALATION.get(name)
    if halation is not None:
        threshold, radius, intensity, colour = halation
        graded = bloom(graded, threshold=threshold, radius=radius, intensity=intensity, colour=colour)
    strength = float(np.clip(strength, 0.0, 1.0))
    if strength >= 1.0:
        return graded
    return _held(plane + (graded - plane) * strength)
