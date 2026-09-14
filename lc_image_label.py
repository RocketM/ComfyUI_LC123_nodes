"""
LC Image Label
--------------
Floating, chromeless "sticker" node: drag an image onto it, drag it
anywhere on the canvas, done. No title bar, no sockets, no execution --
purely a visual label you use to annotate a workflow (mark a region,
caption a group, drop a reference thumbnail next to the nodes it's for).

Ported from ComfyUI_RaykoStudio's RS Image Label (Apache-2.0,
https://github.com/Raykosan/ComfyUI_RaykoStudio) -- same design (custom
drawNode override for chromeless rendering, drag-and-drop upload, image
baked into the workflow JSON as a webp data URL so the label survives
sharing without the original file), rebuilt under LC123's own naming,
route namespace, and conventions. All of the actual behavior lives in
web/lc_image_label.js; this file is just the backend stub ComfyUI
requires plus the one route that serves the uploaded image back to the
node for its live-loaded preview.
"""

import os

NODE_NAME = "LCImageLabel"


class LCImageLabel:
    CATEGORY = "LC123/image"
    FUNCTION = "noop"
    OUTPUT_NODE = True
    DESCRIPTION = (
        "Floating image sticker with drag-and-drop upload. No title, no sockets -- purely a visual "
        "label for annotating a workflow. Double-click to open settings (size, border, radius, "
        "background). The image is baked into the saved workflow as a small webp data URL, so it "
        "survives sharing even if the original upload is gone."
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {},
            "hidden": {"_image_path": ("STRING", {"default": ""})},
        }

    RETURN_TYPES = ()
    OUTPUT_IS_LIST = (False,)

    def noop(self, _image_path=""):
        return {}


try:
    from server import PromptServer
    from aiohttp import web
    import folder_paths

    @PromptServer.instance.routes.get("/lc123/image_label/get_image")
    async def lc_image_label_get_image(request):
        filename = request.rel_url.query.get("filename", "")
        subfolder = request.rel_url.query.get("subfolder", "")
        folder_type = request.rel_url.query.get("type", "temp")

        if not filename:
            return web.Response(status=400, text="No filename provided")

        try:
            base_dir = folder_paths.get_temp_directory() if folder_type == "temp" else folder_paths.get_output_directory()
            filepath = os.path.join(base_dir, subfolder, filename) if subfolder else os.path.join(base_dir, filename)
            filepath = os.path.abspath(filepath)

            if not filepath.startswith(os.path.abspath(base_dir)):
                return web.Response(status=403, text="Access denied")
            if not os.path.isfile(filepath):
                return web.Response(status=404, text="File not found")

            with open(filepath, "rb") as f:
                data = f.read()

            ext = os.path.splitext(filename)[1].lower()
            content_types = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp"}
            return web.Response(body=data, content_type=content_types.get(ext, "application/octet-stream"))
        except Exception as e:
            return web.Response(status=500, text=str(e))

except Exception as e:
    print(f"[LC123] Image Label: API route not registered yet ({e})")


NODE_CLASS_MAPPINGS = {NODE_NAME: LCImageLabel}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "LC Image Label"}
