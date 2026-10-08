"""LC Timer: times every run and scores the last one against the 5 before it. All of it happens in the browser
(web/lc_timer.js); this class only puts the node in the menu. It has no sockets and never runs."""


class LCTimer:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {}}

    RETURN_TYPES = ()
    FUNCTION = "noop"
    CATEGORY = "LC123/utils"
    DESCRIPTION = ("Times every run and scores the last one against the 5 before it: faster in green, slower in red. "
                   "Stopped runs and fully cached runs are left out. Right-click to clear the history.")

    def noop(self):
        return ()


NODE_CLASS_MAPPINGS = {"LCTimer": LCTimer}
NODE_DISPLAY_NAME_MAPPINGS = {"LCTimer": "LC Timer ⏱️"}
