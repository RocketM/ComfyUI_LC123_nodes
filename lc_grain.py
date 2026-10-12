"""
Shared grain models, so every LC node that adds grain makes the same kind (LC Film Grain, LC Photo Style).
"""

import torch

SENSOR_GAIN = (1.25, 1.0, 1.6)  # after white balance blue (and a little red) are the noisiest channels


def _to_linear(x):
    return torch.where(x <= 0.04045, x / 12.92, ((x + 0.055) / 1.055).clamp(min=0) ** 2.4)


def _to_srgb(x):
    return torch.where(x <= 0.0031308, x * 12.92, 1.055 * x.clamp(min=0) ** (1 / 2.4) - 0.055)


def sensor_noise(rgb, noise, amount):
    """Phone / digital camera noise. rgb: (..., 3) sRGB 0-1, noise: (..., 3) unit noise, amount: the noise size at
    full light, in linear light. Shot noise grows with the square root of the light, plus a small read-noise floor,
    so in the finished picture it reads strongest in the shadows but never disappears in the highlights."""
    lin = _to_linear(rgb.float())
    gain = torch.tensor(SENSOR_GAIN, device=lin.device, dtype=lin.dtype)
    sd = (lin + 0.002).sqrt() * gain * float(amount)
    return _to_srgb((lin + noise.to(lin) * sd).clamp(0, 1)).clamp(0, 1).to(rgb.dtype)
