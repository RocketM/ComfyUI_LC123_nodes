/**
 * LC Note 📝 — markdown note with a language dropdown (frontend-only, never executes).
 *
 * Translations live in the node (saved with the workflow): properties.lc_note =
 *   { source: "en", texts: { en: {text}, zh: {text, src: <hash of the source it came from>} } }
 * Status per language: ✏️ source · ✅ translated and current · ⚠️ source changed since · ❌ missing.
 * "Translate now" only appears when LC Vision is installed (it serves /lc_vision/translate);
 * nothing ever translates on its own. The reader's language is the LC123 › Notes › Language
 * setting (default: follow ComfyUI's own language); picking one on any note updates it.
 */
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { ComfyWidgets } from "../../scripts/widgets.js";

const TYPE = "LCNote";
const SETTING = "LC123.Notes.Language";
const COLOR = "#2E3A46";

// ComfyUI's own interface languages. code, label, name given to the translator, rtl
const LANGS = [
  ["en", "English", "English"],
  ["zh", "中文", "Simplified Chinese"],
  ["zh-TW", "繁體中文", "Traditional Chinese"],
  ["ru", "Русский", "Russian"],
  ["ja", "日本語", "Japanese"],
  ["ko", "한국어", "Korean"],
  ["fr", "Français", "French"],
  ["es", "Español", "Spanish"],
  ["ar", "عربي", "Arabic", true],
  ["tr", "Türkçe", "Turkish"],
  ["pt-BR", "Português (BR)", "Brazilian Portuguese"],
  ["fa", "فارسی", "Persian (Farsi)", true],
  ["he", "עברית", "Hebrew", true],
  ["it", "Italiano", "Italian"],
];
const BY_CODE = Object.fromEntries(LANGS.map((l) => [l[0], l]));
const ICON = { source: "✏️", ok: "✅", stale: "⚠️", missing: "❌" };

let translator = null; // null = unknown yet, false = not installed, object = status
async function translatorStatus() {
  if (translator !== null) return translator;
  try {
    const r = await api.fetchApi("/lc_vision/translate/status");
    translator = r.ok ? await r.json() : false;
    if (translator && !translator.available) translator = false;
  } catch (_) {
    translator = false;
  }
  return translator;
}

function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16);
}

function comfyLocale() {
  const loc = app.extensionManager?.setting?.get?.("Comfy.Locale") || app.ui?.settings?.getSettingValue?.("Comfy.Locale") || "en";
  if (BY_CODE[loc]) return loc;
  const base = String(loc).split(/[-_]/)[0];
  return BY_CODE[base] ? base : "en";
}

function readerLang() {
  const v = app.extensionManager?.setting?.get?.(SETTING) ?? app.ui?.settings?.getSettingValue?.(SETTING);
  return v && v !== "auto" && BY_CODE[v] ? v : comfyLocale();
}

function setReaderLang(code) {
  try {
    if (app.extensionManager?.setting?.set) app.extensionManager.setting.set(SETTING, code);
    else app.ui?.settings?.setSettingValue?.(SETTING, code);
  } catch (_) {}
}

function data(node) {
  node.properties = node.properties || {};
  const d = (node.properties.lc_note = node.properties.lc_note || { source: "en", texts: { en: { text: "" } } });
  d.texts = d.texts || {};
  if (!d.texts[d.source]) d.texts[d.source] = { text: "" };
  return d;
}

function status(node, code) {
  const d = data(node);
  if (code === d.source) return "source";
  const t = d.texts[code];
  if (!t) return "missing";
  return t.src === hash(d.texts[d.source].text || "") ? "ok" : "stale";
}

function label(node, code) {
  return `${BY_CODE[code][1]} ${ICON[status(node, code)]}`;
}

function codeFromLabel(v) {
  const hit = LANGS.find((l) => String(v).startsWith(l[1] + " "));
  return hit ? hit[0] : null;
}

/** Write what the editor currently holds back into the language on screen. */
function syncFromEditor(node) {
  if (node._lcLoading) return;
  const d = data(node);
  const code = node._lcShown || d.source;
  const w = node._lcText;
  if (!w) return;
  const val = String(w.value ?? "");
  const st = status(node, code);
  if (st === "missing") {
    if (val === (d.texts[d.source].text || "")) return; // just the source being shown
    d.texts[code] = { text: val, src: hash(d.texts[d.source].text || "") }; // typed their own translation
  } else if (!d.texts[code] || d.texts[code].text !== val) {
    d.texts[code] = { ...(d.texts[code] || {}), text: val };
  }
}

function applyDirection(node, code) {
  const el = node._lcText?.element;
  if (el) el.dir = BY_CODE[code]?.[3] ? "rtl" : "ltr";
}

function removeButton(node) {
  const i = node.widgets?.indexOf(node._lcButton);
  if (node._lcButton && i >= 0) node.widgets.splice(i, 1);
  node._lcButton = null;
}

async function refresh(node) {
  const d = data(node);
  const code = node._lcShown || d.source;
  const combo = node._lcLang;
  if (combo) {
    combo.options.values = LANGS.map((l) => label(node, l[0]));
    combo.value = label(node, code);
  }
  const st = status(node, code);
  const t = await translatorStatus();
  removeButton(node);
  if ((st === "missing" || st === "stale") && t) {
    const name = BY_CODE[code][1];
    node._lcButton = node.addWidget("button", st === "stale" ? `⚠️ Source changed: re-translate to ${name} now` : `🌐 Translate to ${name} now`, null, () => translateNow(node, code));
    // keep the button right under the dropdown
    node.widgets.splice(node.widgets.indexOf(node._lcButton), 1);
    node.widgets.splice(1, 0, node._lcButton);
  }
  node.setDirtyCanvas?.(true, true);
}

function show(node, code, skipSync = false) {
  if (!skipSync) syncFromEditor(node);
  const d = data(node);
  node._lcShown = code;
  const st = status(node, code);
  const text = st === "missing" ? d.texts[d.source].text || "" : d.texts[code].text;
  node._lcLoading = true;
  node._lcText.value = text;
  node._lcLoading = false;
  applyDirection(node, st === "missing" ? d.source : code);
  refresh(node);
}

async function translateNow(node, code) {
  syncFromEditor(node);
  const d = data(node);
  const src = d.texts[d.source].text || "";
  if (!src.trim()) return;
  const btn = node._lcButton;
  if (btn) {
    btn.name = btn.label = `⏳ Translating to ${BY_CODE[code][1]}…`;
    btn.callback = () => {};
    node.setDirtyCanvas?.(true, true);
  }
  try {
    const r = await api.fetchApi("/lc_vision/translate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: src, target: BY_CODE[code][2] }),
    });
    const j = await r.json();
    if (!r.ok || j.error) throw new Error(j.error || r.statusText);
    syncFromEditor(node); // keep anything typed while it was translating
    d.texts[code] = { text: j.text, src: hash(src) };
    // the editor still holds the original text: don't sync it over the new translation
    if (node._lcShown === code) show(node, code, true);
    else refresh(node);
    app.graph?.setDirtyCanvas?.(true, true);
  } catch (e) {
    app.extensionManager?.toast?.add?.({ severity: "error", summary: "LC Note", detail: `Translation failed: ${e.message}`, life: 6000 });
    refresh(node);
  }
}

function setupNode(node) {
  data(node);
  node._lcLang = node.addWidget("combo", "language", LANGS[0][1] + " " + ICON.source, (v) => {
    const code = codeFromLabel(v);
    if (!code) return;
    setReaderLang(code);
    show(node, code);
  }, { values: LANGS.map((l) => l[1]) });
  node._lcLang.tooltip =
    "Pick a language. ✏️ original, ✅ translated, ⚠️ original changed since it was translated, ❌ not translated. " +
    "Translate now needs LC Vision installed (nothing to wire). Your pick becomes your default for every LC Note.";
  node._lcText = ComfyWidgets.MARKDOWN(node, "text", ["MARKDOWN", {}], app).widget;
  node._lcText.serializeValue = () => {
    syncFromEditor(node);
    const d = data(node);
    return d.texts[d.source].text || "";
  };

  // edits land in the language on screen (classic canvas and Nodes 2.0 both set .value)
  const w = node._lcText;
  const origSet = w.options?.setValue;
  if (origSet) {
    w.options.setValue = function (v) {
      origSet.call(this, v);
      if (!node._lcLoading) {
        syncFromEditor(node);
        refresh(node);
      }
    };
  }

  node.color = node.color || COLOR;
  node.bgcolor = node.bgcolor || COLOR;
  if (!node.size || node.size[0] < 200) node.size = [420, 300];
}

app.registerExtension({
  name: "LC123.Note",
  settings: [
    {
      id: SETTING,
      name: "Note language",
      type: "combo",
      defaultValue: "auto",
      options: [{ text: "Same as ComfyUI", value: "auto" }, ...LANGS.map((l) => ({ text: l[1], value: l[0] }))],
      tooltip: "Language LC Notes open in. A note without that translation shows its original text.",
      category: ["LC123", "Notes", "Note language"],
      onChange: () => {
        // only switch notes that actually have the new language; leave the rest alone
        const want = readerLang();
        for (const n of app.graph?._nodes || []) if (n.type === TYPE && data(n).texts[want]) show(n, want);
      },
    },
  ],

  registerCustomNodes() {
    class LCNote extends LGraphNode {
      constructor(title) {
        super(title);
        this.isVirtualNode = true;
        this.serialize_widgets = true;
        this.properties = { lc_note: { source: "en", texts: { en: { text: "" } } } };
        setupNode(this);
        this._lcShown = "en";
        // brand-new notes only; loaded ones are shown from configure()
        setTimeout(() => { if (!this._lcConfigured) show(this, pickLang(this)); }, 0);
      }

      configure(info) {
        // widgets_values (the source text) is restored during configure; don't let that write into a translation
        this._lcConfigured = true;
        this._lcLoading = true;
        try {
          super.configure(info);
          // the editor comes back holding whatever language was on screen at save time:
          // reset it to the original so nothing gets synced into the wrong language
          const d = data(this);
          this._lcShown = d.source;
          if (this._lcText) this._lcText.value = d.texts[d.source].text || "";
        } finally {
          this._lcLoading = false;
        }
        setTimeout(() => show(this, pickLang(this)), 0);
      }

      getExtraMenuOptions(_canvas, options) {
        const d = data(this);
        options.unshift(
          {
            content: "LC Note: original language",
            has_submenu: true,
            submenu: {
              options: LANGS.map((l) => ({ content: (l[0] === d.source ? "● " : "") + l[1], lang: l[0] })),
              callback: (item) => {
                syncFromEditor(this);
                const cur = this._lcShown || d.source;
                const text = d.texts[cur]?.text ?? d.texts[d.source].text;
                d.source = item.lang;
                d.texts[item.lang] = { text };
                show(this, item.lang);
              },
            },
          },
          null,
        );
      }
    }
    LCNote.title = "LC Note 📝";
    LCNote.description =
      "Markdown note with a language dropdown. Translations are saved in the workflow, so readers just pick a language. " +
      "Translating needs LC Vision installed (nothing to wire) and only ever happens when you click Translate now. " +
      "Right-click to change the original language.";
    LCNote.category = "LC123/utils";
    LCNote.comfyClass = TYPE;
    LCNote.collapsable = true;
    LiteGraph.registerNodeType(TYPE, LCNote);
  },
});

function pickLang(node) {
  const d = data(node);
  const want = readerLang();
  return d.texts[want] ? want : d.source;
}

