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
  d.titles = d.titles || {};
  if (!d.texts[d.source]) d.texts[d.source] = { text: "" };
  return d;
}

// ---------------------------------------------------------------- titles
// Original title alone when the original is on screen; "Original/ Translated" otherwise.
// No translated title yet (or it doesn't translate) = the original twice, so it's clearly not an error.
const DEFAULT_TITLE = "LC Note 📝";

function titleFor(node, code) {
  const d = data(node);
  const src = d.titles[d.source];
  if (!src) return DEFAULT_TITLE;
  if (code === d.source || status(node, code) === "missing") return src;
  return `${src}/ ${d.titles[code] || src}`;
}

function setShownTitle(node, t) {
  node._lcTitleGuard = true;
  try {
    node.title = t;
  } finally {
    node._lcTitleGuard = false;
  }
}

/** Any rename changes the ORIGINAL title, whatever language is on screen. With a translation showing
 *  ("Original/ Translated") the part before the last "/" is the new original. Translations go ⚠️ until
 *  re-translated, same as editing the body. */
function onTitleEdited(node, v) {
  const d = data(node);
  const code = node._lcShown || d.source;
  v = String(v ?? "").trim();
  if (!v || v === DEFAULT_TITLE) {
    d.titles = {};
  } else {
    let original = v;
    const showingPair = code !== d.source && status(node, code) !== "missing";
    const i = v.lastIndexOf("/");
    if (showingPair && i > 0) original = v.slice(0, i).trim() || v;
    d.titles[d.source] = original;
  }
  setShownTitle(node, titleFor(node, code));
  refresh(node);
}

function status(node, code) {
  const d = data(node);
  if (code === d.source) return "source";
  const t = d.texts[code];
  if (!t) return "missing";
  const bodyOk = t.src === hash(d.texts[d.source].text || "");
  // translations made before titles were tracked have no srcTitle: judge those on the body only
  const titleOk = t.srcTitle === undefined || t.srcTitle === (d.titles[d.source] || "");
  return bodyOk && titleOk ? "ok" : "stale";
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
    // typed their own translation
    d.texts[code] = { text: val, src: hash(d.texts[d.source].text || ""), srcTitle: d.titles[d.source] || "" };
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
  setShownTitle(node, titleFor(node, code));
  refresh(node);
}

async function translateNow(node, code) {
  syncFromEditor(node);
  const d = data(node);
  const src = d.texts[d.source].text || "";
  const sentTitle = d.titles[d.source] || "";
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
      body: JSON.stringify({ text: src, target: BY_CODE[code][2], title: sentTitle }),
    });
    const j = await r.json();
    if (!r.ok || j.error) throw new Error(j.error || r.statusText);
    syncFromEditor(node); // keep anything typed while it was translating
    d.texts[code] = { text: j.text, src: hash(src), srcTitle: sentTitle };
    if (j.title) d.titles[code] = j.title;
    else delete d.titles[code]; // no translated title: show the original twice rather than an old one
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
    "The ◀ ▶ arrows only flip between languages that have text; open the list to translate a new one. " +
    "Translate now needs LC Vision installed (nothing to wire). Your pick becomes your default for every LC Note.";

  // ◀ ▶ arrows: step only through languages that have text (skip ❌), wrapping around,
  // so two languages just flip back and forth. The dropdown list still shows everything.
  const combo = node._lcLang;
  const available = () => LANGS.map((l) => l[0]).filter((c) => status(node, c) !== "missing");
  combo.tryChangeValue = function (delta, opts) {
    const codes = available();
    if (codes.length < 2) return;
    if (opts?.canvas) opts.canvas.last_mouseclick = 0;
    const cur = codes.indexOf(codeFromLabel(this.value) || data(node).source);
    const next = codes[(Math.max(cur, 0) + delta + codes.length) % codes.length];
    this.setValue(label(node, next), opts);
  };
  combo.canIncrement = combo.canDecrement = () => available().length > 1;
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
    {
      id: "LC123.Notes.ConvertAll",
      name: "Convert all notes",
      category: ["LC123", "Notes", "Convert all notes"],
      defaultValue: "",
      tooltip:
        "Turns every Markdown Note and Note in the open workflow into an LC Note. " +
        "A note written as English, then ---, then Chinese becomes one LC Note with both languages. " +
        "Position, size and color are kept. Save the workflow afterwards to keep it.",
      type: () => {
        const b = document.createElement("button");
        b.type = "button"; // a plain <button> is a submit button: inside the settings form it reloads ComfyUI
        b.textContent = "Convert all notes in this workflow";
        b.className = "p-button p-component p-button-sm";
        b.onclick = (e) => {
          e.preventDefault();
          e.stopPropagation();
          const n = convertAllNotes();
          b.textContent = n ? `Converted ${n} note${n === 1 ? "" : "s"} ✅` : "No notes to convert";
          setTimeout(() => (b.textContent = "Convert all notes in this workflow"), 3000);
        };
        return b;
      },
    },
  ],

  registerCustomNodes() {
    let proto = LGraphNode.prototype;
    while (proto && !Object.getOwnPropertyDescriptor(proto, "title")) proto = Object.getPrototypeOf(proto);
    const BASE_TITLE = (proto && Object.getOwnPropertyDescriptor(proto, "title")) || {
      get() { return this._lcTitle; },
      set(v) { this._lcTitle = v; },
    };

    class LCNote extends LGraphNode {
      constructor(title) {
        super(title);
        this.isVirtualNode = true;
        this.serialize_widgets = true;
        // a new note is written in the author's ComfyUI language, so that is its ✏️ original
        const src = comfyLocale();
        this.properties = { lc_note: { source: src, texts: { [src]: { text: "" } }, titles: {} } };
        setupNode(this);
        this._lcShown = src;
        this._lcReady = true;
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
          // notes saved before titles were per-language: adopt a custom title as the original
          if (!Object.keys(d.titles).length && info?.title && info.title !== DEFAULT_TITLE) {
            const t = splitTitle(info.title);
            if (t[d.source]) d.titles[d.source] = t[d.source];
            else d.titles[d.source] = String(info.title).trim();
            for (const [k, v] of Object.entries(t)) if (k !== d.source && d.texts[k]) d.titles[k] = v;
          }
        } finally {
          this._lcLoading = false;
        }
        setTimeout(() => show(this, pickLang(this)), 0);
      }

      // renames go through onTitleEdited so each language keeps its own title
      get title() {
        return BASE_TITLE.get.call(this);
      }
      set title(v) {
        if (this._lcReady && !this._lcTitleGuard && !this._lcLoading) onTitleEdited(this, v);
        else BASE_TITLE.set.call(this, v);
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

// ---------------------------------------------------------------- convert old notes

const CJK = /[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿＀-￯]/g;
const LATIN = /[A-Za-z]/g;

function cjkShare(s) {
  const c = (s.match(CJK) || []).length;
  const l = (s.match(LATIN) || []).length;
  return c + l ? c / (c + l) : 0;
}

/** "English --- Chinese" -> {en, zh}. English notes can have their own --- breaks, so it splits at the
 *  rule line with no Chinese above it and the most Chinese below it. */
function splitBilingual(text) {
  const lines = String(text || "").split("\n");
  let best = null;
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i])) continue;
    const before = lines.slice(0, i).join("\n").trim();
    const after = lines.slice(i + 1).join("\n").trim();
    const share = cjkShare(after);
    if (before && after && cjkShare(before) < 0.05 && share > 0.3 && (!best || share > best.share)) {
      best = { en: before, zh: after, share };
    }
  }
  if (best) return { en: best.en, zh: best.zh };
  const all = String(text || "").trim();
  return cjkShare(all) > 0.3 ? { zh: all } : { en: all };
}

const CJK_LOCALES = new Set(["zh", "zh-TW", "ja", "ko"]);

/** Original language for a one-language note: the author's ComfyUI language, unless the script disagrees. */
function authorLang(isCjkText) {
  const loc = comfyLocale();
  if (isCjkText) return CJK_LOCALES.has(loc) ? loc : "zh";
  return CJK_LOCALES.has(loc) ? "en" : loc;
}

/** "⚙️ Settings/ ⚙️ 设置" -> {en, zh}; a one-language title -> {en} or {zh}. */
function splitTitle(title) {
  const t = String(title || "").trim();
  const i = t.lastIndexOf("/");
  if (i > 0) {
    const left = t.slice(0, i).trim();
    const right = t.slice(i + 1).trim();
    if (left && right && cjkShare(left) < 0.05 && cjkShare(right) > 0.3) return { en: left, zh: right };
  }
  return cjkShare(t) > 0.3 ? { zh: t } : { en: t };
}

function allGraphs() {
  const root = app.graph;
  const subs = root?.subgraphs ? [...root.subgraphs.values()] : [];
  return [root, ...subs].filter(Boolean);
}

function convertAllNotes() {
  let count = 0;
  for (const g of allGraphs()) {
    for (const old of [...(g._nodes || [])]) {
      if (old.type !== "MarkdownNote" && old.type !== "Note") continue;
      const parts = splitBilingual(old.widgets?.[0]?.value);
      const note = LiteGraph.createNode(TYPE);
      if (!note) continue;
      const bilingual = parts.en !== undefined && parts.zh !== undefined;
      // one-language notes: the author's ComfyUI language is the original (Chinese text is still read as Chinese)
      const source = bilingual ? "en" : authorLang(parts.zh !== undefined);
      const texts = { [source]: { text: bilingual ? parts.en : parts.en ?? parts.zh } };
      const titles = {};
      let t = null;
      if (old.title && old.title !== old.constructor?.title && old.title !== "Note" && old.title !== "Markdown Note") {
        t = splitTitle(old.title);
        titles[source] = bilingual ? t.en || String(old.title).trim() : String(old.title).trim();
        if (bilingual && t.zh) titles.zh = t.zh;
      }
      if (bilingual) texts.zh = { text: parts.zh, src: hash(parts.en), srcTitle: titles.en || "" };
      note.properties.lc_note = { source, texts, titles };
      note._lcConfigured = true;
      note.pos = [...old.pos];
      note.size = [...old.size];
      if (old.color) note.color = old.color;
      if (old.bgcolor) note.bgcolor = old.bgcolor;
      g.add(note);
      g.remove(old);
      note._lcShown = source;
      show(note, pickLang(note), true);
      count++;
    }
  }
  if (count) {
    app.graph.setDirtyCanvas(true, true);
    app.extensionManager?.workflow?.activeWorkflow?.changeTracker?.checkState?.();
  }
  return count;
}

function pickLang(node) {
  const d = data(node);
  const want = readerLang();
  return d.texts[want] ? want : d.source;
}

