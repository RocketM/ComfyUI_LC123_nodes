"""
LC Sampler Scheduler: one place to pick the sampler and scheduler, wired out to every KSampler in a workflow.
Outputs use ComfyUI's own sampler / scheduler lists (the same list objects, so samplers other packs add show up too).
"""

import comfy.samplers


class LCSamplerScheduler:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "sampler_name": (comfy.samplers.KSampler.SAMPLERS, {"default": "euler"}),
            "scheduler": (comfy.samplers.KSampler.SCHEDULERS, {"default": "simple"}),
        }}

    RETURN_TYPES = (comfy.samplers.KSampler.SAMPLERS, comfy.samplers.KSampler.SCHEDULERS)
    RETURN_NAMES = ("sampler_name", "scheduler")
    FUNCTION = "main"
    CATEGORY = "LC123/utils"
    DESCRIPTION = "Pick the sampler and scheduler once and wire them to every KSampler, so they all change together."

    def main(self, sampler_name, scheduler):
        return (sampler_name, scheduler)


NODE_CLASS_MAPPINGS = {"LCSamplerScheduler": LCSamplerScheduler}
NODE_DISPLAY_NAME_MAPPINGS = {"LCSamplerScheduler": "LC Sampler Scheduler ⚙️"}
