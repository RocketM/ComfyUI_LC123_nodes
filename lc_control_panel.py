"""
LC Control Panel: up to 16 LC Slider rows on one node, each with its own output. Every row has its own name, min, max,
step and decimals (0 = INT, otherwise FLOAT), set from the gear at the end of the row. The rows live in one hidden
STRING widget (JSON), so moving a slider changes the node's inputs and the next run picks it up.
"""

import json
import math

MAX_ROWS = 16


class AnyType(str):
    def __ne__(self, __value: object) -> bool:
        return False


any_type = AnyType("*")


def _num(v, fb):
    try:
        f = float(v)
    except (TypeError, ValueError, OverflowError):
        return fb
    return f if math.isfinite(f) else fb


def row_value(row):
    """One row -> the value it outputs: snapped to its step, inside min / max, INT at 0 decimals."""
    if not isinstance(row, dict):
        return 0
    lo, hi = _num(row.get("min"), 0.0), _num(row.get("max"), 100.0)
    if lo > hi:
        lo, hi = hi, lo
    st = _num(row.get("step"), 1.0)
    if st <= 0:
        st = 1.0
    v = _num(row.get("value"), lo)
    v = min(hi, max(lo, lo + round((v - lo) / st) * st))
    d = int(max(0, min(4, _num(row.get("decimals"), 0))))
    return int(round(v)) if d == 0 else round(v, d)


class LCControlPanel:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"rows": ("STRING", {"default": "[]", "multiline": False})}}

    RETURN_TYPES = tuple([any_type] * MAX_ROWS)
    RETURN_NAMES = tuple(f"value_{i + 1}" for i in range(MAX_ROWS))
    FUNCTION = "main"
    CATEGORY = "LC123/utils"
    DESCRIPTION = ("One panel of sliders, each with its own output. The gear at the end of a row sets its name, min, max, "
                   "step and decimals (0 = INT, otherwise FLOAT). Plug a new row into a number input and it copies that "
                   "input's name, range and value. Double-click a value to type one.")

    def main(self, rows="[]"):
        try:
            data = json.loads(rows) if isinstance(rows, str) else []
        except (ValueError, TypeError, RecursionError):
            data = []
        if not isinstance(data, list):
            data = []
        return tuple(row_value(data[i]) if i < len(data) else 0 for i in range(MAX_ROWS))


NODE_CLASS_MAPPINGS = {"LCControlPanel": LCControlPanel}
NODE_DISPLAY_NAME_MAPPINGS = {"LCControlPanel": "LC Control Panel 🎛️"}
