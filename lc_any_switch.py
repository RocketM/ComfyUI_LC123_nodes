"""
LC AnySwitch
------------
Top-down priority switch (first connected input wins), any type.

Designed so cg-use-everywhere does NOT auto-wire into its inputs
(see companion web/lc_any_switch.js).

Class ID: LCAnySwitch
Display:  LC AnySwitch
"""

from __future__ import annotations


class LCAnySwitch:
    @classmethod
    def INPUT_TYPES(cls):
        # Fixed optional slots; JS trims visibility via inputcount widget
        optional = {
            f"any_{i:02d}": ("*", {"lazy": True}) for i in range(1, 21)
        }
        return {
            "required": {
                "inputcount": (
                    "INT",
                    {
                        "default": 2,
                        "min": 2,
                        "max": 20,
                        "step": 1,
                    },
                ),
            },
            "optional": optional,
            # Not widgets (never serialized): lets check_lazy_status tell an input
            # that evaluated to None apart from one not evaluated yet.
            "hidden": {
                "lc_unique_id": "UNIQUE_ID",
                "lc_dynprompt": "DYNPROMPT",
                "lc_execution_list": "EXECUTION_LIST",
            },
        }

    RETURN_TYPES = ("*",)
    RETURN_NAMES = ("*",)
    FUNCTION = "switch"
    CATEGORY = "LC123/utils"
    DESCRIPTION = (
        "Pick the first connected input among many. Type-locks from the first wire. Blocks Use Everywhere auto-wiring. Dynamic 2–20 inputs."
    )

    @staticmethod
    def _evaluated(key, unique_id, dynprompt, execution_list):
        """True if the linked input `key` already has a value this run (mirrors
        execution.get_input_data), None if that cannot be told."""
        if unique_id is None or dynprompt is None or execution_list is None:
            return None
        try:
            link = dynprompt.get_node(unique_id)["inputs"].get(key)
            if not isinstance(link, (list, tuple)) or len(link) != 2:
                return None
            cached = execution_list.get_cache(link[0], unique_id)
            return cached is not None and cached.outputs is not None and link[1] < len(cached.outputs)
        except Exception:
            return None

    def check_lazy_status(self, inputcount, lc_unique_id=None, lc_dynprompt=None, lc_execution_list=None, **kwargs):
        # Priority order: ask for the first connected input that is not evaluated yet,
        # one at a time, until one gives a non-None value. Inputs that evaluated to
        # None fall through to the next one, same as switch() below.
        n = max(2, min(20, int(inputcount)))
        needed = []
        for i in range(1, n + 1):
            key = f"any_{i:02d}"
            if key not in kwargs:
                continue
            if kwargs[key] is not None:
                return needed
            done = self._evaluated(key, lc_unique_id, lc_dynprompt, lc_execution_list)
            if done is True:
                continue
            needed.append(key)
            if done is False:
                return needed
            # done is None: state unknown, keep collecting (Comfy drops evaluated names)
        return needed

    def switch(self, inputcount: int, **kwargs):
        n = max(2, min(20, int(inputcount)))
        for i in range(1, n + 1):
            key = f"any_{i:02d}"
            if key not in kwargs:
                continue
            val = kwargs[key]
            if val is not None:
                return (val,)
        # Nothing connected — return None; downstream may no-op or error
        return (None,)


NODE_CLASS_MAPPINGS = {
    "LCAnySwitch": LCAnySwitch,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "LCAnySwitch": "LC AnySwitch",
}
