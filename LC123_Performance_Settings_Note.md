# LC123 Settings ⚙️

**Where are they?** Open **Settings** (the gear), then **LC123 Settings ⚙️**. There are five sections: **Align**, **Connections**, **Notes**, **Optimization** and **Performance**.

- 💡 Missing a setting? Restart ComfyUI, then press **Ctrl+F5** so the browser loads the new files.

---

### 📐 Align

**Align tool**
- Default: **On**
- The switch for the whole tool. Off = no **Align** button (the LC logo) in the top toolbar and none of the features below.
- With it on, the **Align** button turns Align on or off **for the open workflow**: light gray with the red flame = on, dark gray with a gray flame = off.
    - That on/off is saved in the workflow. Save it with Align on and it opens with Align on, even on a fresh ComfyUI.
    - Every workflow tab keeps its own. Switch tabs and the tool follows that tab (on in one, off in the other, no mix-ups).
    - Turning it on or off counts as a change to the workflow, so you get the unsaved dot.
- Nodes snap to **Node lines**, groups snap to **Group lines**. A line lights up when you get close.
- Works on the classic canvas and in **Nodes 2.0**.
- **Snap distance** is ComfyUI's own **Snap to grid size** (Settings > Lite Graph > Canvas). Smaller grid = tighter snap. New lines land on that grid too.
    - **Shift** while dragging hands the drag to ComfyUI's own grid snap (no line snap). With **Always snap to grid** on, a line snap still wins on the axis it caught.

**Rulers**
- Default: **On**
- Rulers on the top and left edge while Align is on:
    - **Left click** a ruler: adds a **Node line** (blue). Nodes snap to it.
    - **Right click** a ruler: adds a **Group line** (orange). Groups snap to it.
    - **LC Notes** snap to both, since a note can label a node or a group.
    - Click a line's marker again to remove it. Drag a marker to move it.
- Lines save with the workflow.

**Line reveal distance (px)**
- Default: **120**
- Lines stay invisible until the cursor or whatever you drag gets this close.

**Also snap to other nodes and groups**
- Default: **Off**
- On = also snap to other nodes' edges and centers (no line is shown for those).

---

### 🔌 Connections

**Connection FX**
- Default: **Off**
- While you drag a wire, every socket it can plug into glows in its socket color.
- Get close and rings pulse out of the socket. Closer = bigger and brighter.
- **Connection FX reach (px):** how close the cursor has to be before the rings start. Default 160.
- **Connection FX zoomed-out glow (%):** zoomed out, every valid socket glows brighter so you can find it. Default 60.
- Classic canvas only. With **Nodes 2.0** on it stays out of the way.

---

### 📝 Notes

**Note language**
- LC notes will open in the default language set for Comfy if they have already been translated to that

**Translate all notes**
- One click translates every **LC Note** in the open workflow (subgraphs too) into your **Note language**, one after another, then shows them in it.
- Notes already written in that language, or with an up-to-date translation, are skipped. Out-of-date translations (⚠️) are redone.
- Only LC Notes are touched. Other notes are left alone.
- Needs **LC Vision** installed (nothing to wire).
- ⚠️ Save the workflow afterwards to keep the translations.

**Link cards**
- Default: **On**
- A line with just `@[card](https://…)` in an LC Note shows the page as a card: picture, site, title and description. `@[card: caption](https://…)` adds your own caption.
- Put each card on a line of its own, with a blank line before and after it. Without the blank lines they stay plain links.
- Double-click the note to edit: the cards step aside so you can change the `@[card](…)` text. They come back when you click away.
- Wide pictures (banners) get a wider slot so they show whole.
- ComfyUI reads each card's page once, and the picture loads from that site. Only public web addresses, never your own machine or network. Off = cards show as plain links.

---

### 🩺 Optimization

**Comfy Optimization Report**
- One button. It pans the canvas by itself for a few seconds, times what every pack in the open workflow draws and runs, and scans their files.
- You get a list of what slows your canvas down, biggest first, sorted into:
    - **That pack's own settings** (the exact setting name, where it lives and its current value)
    - **LC123 optimization settings**
    - **ComfyUI settings**
    - **Sidebar tabs**
    - **Required to function** (no setting, it is how that pack works)
- Only node packs used in the open workflow are analyzed.
- Every setting it suggests is checked against its current value:
    - ⚠️ big gain · ✅ worthwhile gain · 💡 small gain
    - ⚪ already set · ➖ does not apply · ℹ️ required, no setting for it
- **Show last run:** the button at the top flips to the previous report. Each new run also shows what got faster and which fixes are done since last time.
    - Only the last run is kept (it survives a refresh). Each run replaces it.
- Nothing is changed. (Keep the mouse still while it runs.)
- 💡 Also in the right-click menu on the empty canvas.

**System & Model Optimization Report**
- One button. It tests this machine in about 10 seconds: graphics card, VRAM, RAM, page file, drive speed, and which speed-ups really work here (Sage, Triton, Sol-Attn, Comfy Kitchen, fp8 / int8 / nvfp4, llama-cpp).
- ⚠️ problem · 💡 worth changing · ✅ works · ℹ️ info · ➖ not installed
- Then it tells you which model files suit this machine:
    - **LC Vision model suggestion** (Quality / Optimal / Fast, with the context size to set)
    - **When picking a model (includes custom models):** what to get for Quality, Optimal and Fast, a size guide, and what to avoid
    - **Model recommendations:** exact files with download links for the tested base models, plus **All base models at a glance**
- **Show last run** and **Copy report** work like the Comfy Optimization Report. It will not run while ComfyUI is generating.
- Nothing is changed. (Also in the right-click menu on the empty canvas.)

---

### ⚡ Performance

These only change what you see on the canvas. Generation, VRAM, **Save Image** and every **IMAGE** output stay full resolution. (A lighter preview never means a lighter image.)

| Setting | Default | What it does |
|---|---|---|
| **Remove wipe** | Off | Turns off the hover A/B wipe on LC image FX nodes. The last result still shows. |
| **Half-resolution previews** | Off | Draws FX previews at half size. Less work while panning. |
| **Clamp longest side** | Off | Shrinks on-node previews so the longest side fits **Max edge**. |
| **Max edge (px)** | 768 | Only used when **Clamp longest side** is on. Range 256 to 2048. Try 512 on heavy graphs. |
| **No preview when collapsed** | On | Collapsed FX nodes skip drawing their preview. |
| **Hide FX on-node previews** | Off | Hides every LC image FX preview. |
| **Recent colors** | On | Keeps your last 8 custom colors in the right-click **Colors** menu. Adds a Custom picker if Custom Scripts is not installed. |
| **Skin Beauty full preview override** | On | **LC Skin Beauty** keeps a full-quality preview even with half-res or clamp on, so you can still zoom into skin. Wipe still follows **Remove wipe**. |
| **LoRA loader info button** | On | Shows the ℹ button on each **LC LoRA Loader** row. Trigger words come from the LoRA file itself (no internet). Turn off to declutter. |
| **Preview distance (px)** | 40 | Like node text, an on-node image switches off when you zoom out far enough that it is drawn smaller than this. Smaller previews switch off first. 0 = always draw. |

**Never affected:** **LC Image Compare 🔎**, **LC Image Split 🖼️** and **LC Dynamic Overlay** keep their full preview and wipe no matter what (only **Preview distance** switches them off when zoomed far out).

**Suggested setups**
- **Normal use:** leave everything at default.
- **Laggy graph:** turn on **Half-resolution previews** and **Clamp longest side** (Max edge 512). Keep **No preview when collapsed** on.
- **Lightest canvas:** turn on **Hide FX on-node previews**. Use **Image Compare** or **Image Split** when you need to see a before/after.
- 💡 Changes apply on the next redraw. Pan the canvas a little, no restart needed.

---

"True Nothing is. Permitted Everything is"- Yoda Auditore, Assassin's Wars

