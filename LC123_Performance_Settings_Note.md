# LC123 Settings ⚙️

**Where are they?** Open **Settings** (the gear), then **LC123**. There are two sections: **Notes** and **Performance**.

- 💡 Missing a setting? Restart ComfyUI, then press **Ctrl+F5** so the browser loads the new files.

---

### 📝 Notes

**Note language**
- Default: **Same as ComfyUI**
- The language every LC Note opens in.
- Only notes that already have that translation switch. The rest stay in their original language.

**Convert all notes**
- One click turns every **Markdown Note** and **Note** in the open workflow into an **LC Note**.
- A note written as English, then `---`, then Chinese becomes one LC Note with both languages.
- Position, size and color are kept.
- ⚠️ Save the workflow afterwards. If you reload without saving, the conversion is gone.

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

**Never affected:** **LC Image Compare 🔎**, **LC Image Split 🖼️** and **LC Dynamic Overlay** keep their full preview and wipe no matter what.

**Suggested setups**
- **Normal use:** leave everything at default.
- **Laggy graph:** turn on **Half-resolution previews** and **Clamp longest side** (Max edge 512). Keep **No preview when collapsed** on.
- **Lightest canvas:** turn on **Hide FX on-node previews**. Use **Image Compare** or **Image Split** when you need to see a before/after.
- 💡 Changes apply on the next redraw. Pan the canvas a little, no restart needed.

---

"True Nothing is. Permitted Everything is"- Yoda Auditore, Assassin's Wars

