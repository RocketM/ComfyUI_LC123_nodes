"""
LC Is Bypassed / Muted
-----------------------
True if the node wired into `value` is currently bypassed OR muted, false otherwise. Socket type
doesn't matter -- wire literally anything from the node you want to watch, same contract as LC
Invert Boolean's `value` input.

Bypass/mute is a frontend-only concept (LiteGraph's node.mode: 2 = muted, 4 = bypassed), not
something that flows through actual execution -- a MUTED node in particular never runs at all, so
anything wired only to its real output would never execute either and could never report "yes,
that's muted." Same trick as LC Boolean / LC Invert Boolean: a hidden `is_bypassed_or_muted` widget
is kept in sync live by web/lc_is_bypassed_or_muted.js, reading the origin node's own .mode directly
off the graph (no queue needed), and this just reports whatever that widget currently holds.

Class ID: LCIsBypassedOrMuted
Display:  LC Is Bypassed / Muted
"""

from __future__ import annotations


class AnyType(str):
    """Wildcard type so anything can connect -- only which node the wire comes FROM matters."""

    def __ne__(self, __value: object) -> bool:
        return False


any_type = AnyType("*")


class LCIsBypassedOrMuted:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "value": (
                    any_type,
                    {
                        "tooltip": "Wire anything from the node you want to watch -- the type doesn't "
                        "matter, only which node the wire comes from.",
                    },
                ),
                "is_bypassed_or_muted": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "tooltip": "Internal: kept in sync live by this node's own face. Not meant to "
                        "be set by hand.",
                    },
                ),
            },
        }

    RETURN_TYPES = ("BOOLEAN",)
    RETURN_NAMES = ("BOOLEAN",)
    FUNCTION = "check"
    CATEGORY = "LC123/utils"
    DESCRIPTION = (
        "True if the node wired into `value` is currently bypassed OR muted, false otherwise. Read "
        "live off the graph by the node's face -- no need to queue first, same contract as LC Boolean "
        "/ LC Invert Boolean. Shows true/false on the face."
    )

    def check(self, value=None, is_bypassed_or_muted=False):
        return (bool(is_bypassed_or_muted),)


NODE_CLASS_MAPPINGS = {
    "LCIsBypassedOrMuted": LCIsBypassedOrMuted,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "LCIsBypassedOrMuted": "LC Is Bypassed / Muted",
}
