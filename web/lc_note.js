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
const CARD_SETTING = "LC123.Notes.LinkCards";
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
        syncFromEditor(node); // the text is stored right away; only the dropdown/button refresh waits
        clearTimeout(node._lcRefreshTimer);
        node._lcRefreshTimer = setTimeout(() => refresh(node), 250);
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
      sortOrder: 30, // Notes section order: Note language, Translate all notes, Link cards
      name: "Note language",
      type: "combo",
      defaultValue: "auto",
      options: [{ text: "Same as ComfyUI", value: "auto" }, ...LANGS.map((l) => ({ text: l[1], value: l[0] }))],
      tooltip: "Language LC Notes open in. A note without that translation shows its original text.",
      category: ["LC123 Settings ⚙️", "Notes", "Note language"],
      onChange: () => {
        // only switch notes that actually have the new language; leave the rest alone
        const want = readerLang();
        for (const n of app.graph?._nodes || []) if (n.type === TYPE && data(n).texts[want]) show(n, want);
      },
    },
    {
      id: CARD_SETTING,
      sortOrder: 10,
      name: "Link cards",
      type: "boolean",
      defaultValue: true,
      tooltip:
        "A line with just @[card](https://…) in an LC Note shows the page as a card: picture, site, title and description. " +
        "@[card: your caption](https://…) adds your own caption. Plain links stay plain. ComfyUI reads each card's page " +
        "once to get its title and picture, and the picture loads from that site. Off = cards show as plain links.",
      category: ["LC123 Settings ⚙️", "Notes", "Link cards"],
    },
    {
      id: "LC123.Notes.TranslateAll",
      sortOrder: 20,
      name: "Translate all notes",
      category: ["LC123 Settings ⚙️", "Notes", "Translate all notes"],
      defaultValue: "",
      tooltip:
        "Translates every LC Note in the open workflow (subgraphs too) into the Note language above, one after " +
        "another, then shows them in it. Notes already in that language, or with an up-to-date translation, are skipped. " +
        "Needs LC Vision installed. Only LC Notes are touched; other notes are left alone. Save the workflow afterwards to keep it.",
      type: () => {
        const IDLE = "Translate all notes in this workflow";
        const b = document.createElement("button");
        b.type = "button"; // a plain <button> is a submit button: inside the settings form it reloads ComfyUI
        b.textContent = IDLE;
        b.className = "p-button p-component p-button-sm";
        let busy = false;
        b.onclick = async (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (busy) return;
          busy = true;
          b.disabled = true;
          try {
            const r = await translateAllNotes((i, n, name) => (b.textContent = `Translating ${i} of ${n} to ${name}…`));
            if (r.error) b.textContent = r.error;
            else if (!r.total) b.textContent = "No LC Notes in this workflow";
            else if (!r.done && !r.failed) b.textContent = `All notes are already in ${r.name} ✅`;
            else b.textContent = `Translated ${r.done} to ${r.name} ✅` + (r.failed ? ` · ${r.failed} failed` : "");
          } finally {
            busy = false;
            b.disabled = false;
            setTimeout(() => {
              if (!busy) b.textContent = IDLE;
            }, 6000);
          }
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

// ---------------------------------------------------------------- titles saved before they were per-language

const CJK =/[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿＀-￯]/g;
const LATIN = /[A-Za-z]/g;

function cjkShare(s) {
  const c = (s.match(CJK) || []).length;
  const l = (s.match(LATIN) || []).length;
  return c + l ? c / (c + l) : 0;
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

/** Translate every LC Note in the open workflow (subgraphs too) into the Note language, one after another, with the
 *  same translator as each note's own button. Notes already in that language, or with an up-to-date translation, are
 *  skipped; afterwards every note that has the language shows it. Only LC Notes are touched. */
async function translateAllNotes(progress) {
  const code = readerLang();
  const name = BY_CODE[code]?.[1] || code;
  if (!(await translatorStatus())) return { error: "Needs LC Vision installed to translate", name };
  const notes = [];
  for (const g of allGraphs()) for (const n of g._nodes || []) if (n.type === TYPE) notes.push(n);
  const todo = notes.filter((n) => {
    const d = data(n);
    const st = status(n, code);
    return d.source !== code && (d.texts[d.source]?.text || "").trim() && (st === "missing" || st === "stale");
  });
  let done = 0;
  let failed = 0;
  for (const n of todo) {
    progress?.(done + failed + 1, todo.length, name);
    await translateNow(n, code); // it reports its own failures
    if (status(n, code) === "ok") done++;
    else failed++;
  }
  for (const n of notes) if (data(n).texts[code] || data(n).source === code) show(n, code);
  if (done) {
    app.graph?.setDirtyCanvas?.(true, true);
    const ct = app.extensionManager?.workflow?.activeWorkflow?.changeTracker;
    if (typeof ct?.captureCanvasState === "function") ct.captureCanvasState();
    else ct?.checkState?.();
  }
  return { name, done, failed, total: notes.length };
}

function pickLang(node) {
  const d = data(node);
  const want = readerLang();
  return d.texts[want] ? want : d.source;
}

// ---------------------------------------------------------------- Nodes 2.0: the note keeps its own size
// Nodes 2.0 lets the markdown push the node as tall as the whole text (and saving then keeps that stretched size).
// Here the text area is capped at the room the node has and scrolls inside it; resizing the node moves the cap.
// Classic is untouched: none of this runs there.
function fitVueNote(node) {
  const el = document.querySelector(`[data-node-id="${node.id}"]`);
  const md = el?.querySelector(".widget-markdown");
  if (!md) return;
  const scale = app.canvas?.ds?.scale || 1;
  // the node's own height as Nodes 2.0 lays it out (title included), falling back to litegraph's size
  const nodeH = parseFloat(el.style.getPropertyValue("--node-height")) || node.size[1] + (window.LiteGraph?.NODE_TITLE_HEIGHT ?? 30);
  // everything around the text (title, language row, button, badges) = node minus text, measured with the cap off.
  // All in one go, so nothing is painted in between.
  const box = md.querySelector(".comfy-markdown-content") || md;
  const scrolled = box.scrollTop; // taking the cap off resets the scroll, so it is put back afterwards
  const prev = md.style.maxHeight;
  md.style.maxHeight = "";
  const around = (el.getBoundingClientRect().height - md.getBoundingClientRect().height) / scale;
  const room = Math.max(40, Math.floor(nodeH - around));
  md.style.maxHeight = prev;
  if (md.style.maxHeight !== room + "px") md.style.maxHeight = room + "px";
  if (box.scrollTop !== scrolled) box.scrollTop = scrolled;
}

// ComfyUI's markdown scrolls inside .comfy-markdown-content once its box is capped, but Nodes 2.0 only hands the wheel
// to a box that has keyboard focus. Over an LC Note with more text than fits, the wheel scrolls the note straight away;
// Ctrl+wheel, and any note whose text all fits, still zoom the canvas.
window.addEventListener("wheel", (e) => {
  if (!window.LiteGraph?.vueNodesMode || e.ctrlKey) return;
  const md = e.target?.closest?.(".widget-markdown");
  const el = md?.closest?.("[data-node-id]");
  if (!el || app.canvas?.graph?.getNodeById?.(el.dataset.nodeId)?.type !== TYPE) return;
  const box = md.querySelector(".comfy-markdown-content") || md;
  if (box.scrollHeight <= box.clientHeight + 1) return;
  box.scrollTop += e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
  e.preventDefault();
  e.stopPropagation();
}, { capture: true, passive: false });

setInterval(() => {
  if (!window.LiteGraph?.vueNodesMode) return;
  for (const n of app.canvas?.graph?._nodes || []) if (n.type === TYPE) fitVueNote(n);
}, 400);

// ---------------------------------------------------------------- link cards
// A line holding only @[card](https://…) or @[card: caption](https://…) shows as a card: the page's picture, site,
// title and description, read once by the LC123 server route (/lc123/link_card). Plain links stay plain.
// The note text itself is never changed: cards are only drawn over what the markdown renders.
//  - Nodes 2.0 renders the note as plain HTML, so the card line is swapped for the card in place.
//  - Classic renders it inside a ProseMirror view that watches its own DOM, so nothing inside it is touched:
//    a style rule keeps the card line's space empty, and the card floats over that space on a layer beside it.
const cardsOn = () => {
  try {
    return (app.extensionManager?.setting?.get?.(CARD_SETTING) ?? app.ui?.settings?.getSettingValue?.(CARD_SETTING)) !== false;
  } catch (_) {
    return true;
  }
};
const CARD_H = 76;
const CARD_RE = /^card(?:\s*:\s*(.*))?$/i;
const cardInfo = new Map(); // url -> card data, "loading", or a failed card

function loadCard(url) {
  if (cardInfo.has(url)) return;
  cardInfo.set(url, "loading");
  api.fetchApi(`/lc123/link_card?url=${encodeURIComponent(url)}`)
    .then((r) => r.json())
    .catch(() => ({ ok: false }))
    .then((c) => {
      cardInfo.set(url, c || { ok: false });
      document.querySelectorAll(".lc-link-card").forEach((el) => {
        if (el.dataset.url === url) fillCard(el);
      });
    });
}

let cardCss = false;
function addCardCss() {
  if (cardCss) return;
  cardCss = true;
  const s = document.createElement("style");
  s.textContent = `
.lc-link-card{display:flex;gap:10px;height:${CARD_H}px;box-sizing:border-box;margin:0;padding:0;border:1px solid rgba(255,255,255,.14);
  border-radius:8px;background:rgba(0,0,0,.28);overflow:hidden;text-decoration:none!important;color:inherit!important;cursor:pointer;pointer-events:auto}
.lc-link-card:hover{border-color:rgba(255,255,255,.35);background:rgba(0,0,0,.4)}
.lc-link-card .lc-lc-img{flex:0 0 ${CARD_H}px;width:${CARD_H}px;height:100%;object-fit:contain;background:rgba(0,0,0,.35)}
.lc-link-card .lc-lc-txt{display:flex;flex-direction:column;justify-content:center;min-width:0;padding:4px 8px 4px 0;line-height:1.25}
.lc-link-card .lc-lc-site{font-size:10px;opacity:.6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.lc-link-card .lc-lc-title{font-size:12px;font-weight:600;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.lc-link-card .lc-lc-desc{font-size:11px;opacity:.7;display:-webkit-box;-webkit-line-clamp:1;-webkit-box-orient:vertical;overflow:hidden}
.lc-link-card .lc-lc-cap{font-size:11px;color:#7dd3fc;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.lc-link-card.lc-has-cap .lc-lc-title{-webkit-line-clamp:1}
.lc-card-layer{position:absolute;pointer-events:none;overflow:hidden;z-index:2}
.lc-card-layer .lc-link-card{position:absolute;left:0;right:0}`;
  document.head.appendChild(s);
}

function makeCard(url, caption) {
  const a = document.createElement("a");
  a.className = "lc-link-card";
  a.href = url;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.dataset.url = url;
  a.dataset.caption = caption || "";
  // a click opens the page; it must not start a node drag or put the note into edit mode
  for (const ev of ["pointerdown", "mousedown", "dblclick"]) a.addEventListener(ev, (e) => e.stopPropagation());
  fillCard(a);
  loadCard(url);
  return a;
}

function fillCard(a) {
  const url = a.dataset.url;
  const caption = a.dataset.caption;
  const c = cardInfo.get(url);
  let host = url;
  try {
    host = new URL(url).hostname.replace(/^www\./, "");
  } catch (_) {}
  const info = c && c !== "loading" ? c : null;
  a.textContent = "";
  a.title = url;
  a.classList.toggle("lc-has-cap", !!caption); // a caption line takes the title's second line
  if (info?.image) {
    const img = document.createElement("img");
    img.className = "lc-lc-img";
    img.src = info.image;
    img.referrerPolicy = "no-referrer";
    img.loading = "lazy";
    img.alt = "";
    img.onerror = () => img.remove();
    // a wide picture (a banner) gets a wider slot, up to 2.2x the card's height; past that it fits inside with bars
    img.onload = () => {
      const r = img.naturalWidth / Math.max(1, img.naturalHeight);
      if (r > 1.15) {
        const w = Math.round(Math.min(CARD_H * r, CARD_H * 2.2));
        img.style.width = img.style.flexBasis = w + "px";
      }
    };
    a.appendChild(img);
  }
  const t = document.createElement("div");
  t.className = "lc-lc-txt";
  const line = (cls, text) => {
    if (!text) return;
    const d = document.createElement("div");
    d.className = cls;
    d.textContent = text;
    t.appendChild(d);
  };
  line("lc-lc-site", info?.site || host);
  line("lc-lc-title", info?.ok ? info.title || host : c === "loading" || !c ? "Loading…" : host);
  if (info?.ok) line("lc-lc-desc", info.description);
  line("lc-lc-cap", caption);
  if (!info?.image && !t.childNodes.length) line("lc-lc-title", host);
  if (!info?.image) t.style.paddingLeft = "10px";
  a.appendChild(t);
}

// the card lines in a rendered note: a paragraph holding "@" then a link whose text is "card" / "card: caption"
function cardLines(root) {
  const out = [];
  for (const p of root.children) {
    if (p.tagName !== "P") continue;
    const a = p.querySelector("a[href]");
    if (!a || p.children.length !== 1) continue;
    const m = CARD_RE.exec(a.textContent.trim());
    if (!m) continue;
    const before = p.textContent.slice(0, p.textContent.indexOf(a.textContent)).trim();
    if (before !== "@" || p.textContent.trim() !== "@" + a.textContent.trim()) continue;
    if (!/^https?:\/\//i.test(a.getAttribute("href"))) continue;
    out.push({ p, url: a.getAttribute("href"), caption: (m[1] || "").trim() });
  }
  return out;
}

// Nodes 2.0: swap the card line for the card (the HTML is ComfyUI's plain render, redrawn when the text changes)
function vueCards(node) {
  const box = document.querySelector(`[data-node-id="${node.id}"] .widget-markdown .comfy-markdown-content`);
  if (!box) return;
  // editing: Nodes 2.0 shows its text box over the note; the card lines go back to plain text meanwhile
  const ta = box.parentElement?.querySelector(":scope > textarea");
  const editing = !!ta && ta.style.display !== "none" && getComputedStyle(ta).display !== "none";
  if (!cardsOn() || editing) {
    box.querySelectorAll("p[data-lc-card]").forEach((p) => {
      p.innerHTML = p._lcOrig ?? p.innerHTML;
      delete p.dataset.lcCard;
    });
    return;
  }
  for (const { p, url, caption } of cardLines(box)) {
    if (p.dataset.lcCard === url) continue;
    addCardCss();
    p._lcOrig = p.innerHTML;
    p.dataset.lcCard = url;
    p.textContent = "";
    p.appendChild(makeCard(url, caption));
  }
}

// classic: nothing inside ProseMirror is changed. A style rule keeps each card line's space empty (by position),
// and the cards sit on a layer beside it that follows the scroll.
const classicState = new WeakMap(); // widget element -> {layer, style, key}
function classicCards(node) {
  const el = node._lcText?.element;
  const pm = el?.querySelector?.(".ProseMirror");
  let st = el ? classicState.get(el) : null;
  const clear = () => {
    if (!st) return;
    st.layer.remove();
    st.style.remove();
    classicState.delete(el);
  };
  // editing (double-click): ComfyUI fades the rendered note out and its text box in; the cards go too, so the
  // @[card](…) text is there to edit. They come back once the edit ends.
  if (!pm || !cardsOn() || el.classList.contains("editing") || getComputedStyle(pm).display === "none" || !el.isConnected) return clear();
  const lines = cardLines(pm);
  if (!lines.length) return clear();
  addCardCss();
  if (!st) {
    el.dataset.lcNote = String(node.id);
    if (getComputedStyle(el).position === "static") el.style.position = "relative";
    const layer = document.createElement("div");
    layer.className = "lc-card-layer";
    el.appendChild(layer);
    const style = document.createElement("style");
    document.head.appendChild(style);
    st = { layer, style, key: "" };
    classicState.set(el, st);
    pm.addEventListener("scroll", () => placeClassic(el, pm), { passive: true });
  }
  const kids = [...pm.children];
  const key = lines.map((l) => kids.indexOf(l.p) + "|" + l.url + "|" + l.caption).join(";");
  if (key !== st.key) {
    st.key = key;
    const sel = `.comfy-markdown[data-lc-note="${String(node.id).replace(/"/g, "")}"] .ProseMirror`;
    st.style.textContent = lines
      .map((l) => `${sel} > :nth-child(${kids.indexOf(l.p) + 1}){visibility:hidden;height:${CARD_H}px;margin:6px 0;overflow:hidden}`)
      .join("\n");
    st.layer.textContent = "";
    for (const l of lines) st.layer.appendChild(makeCard(l.url, l.caption)).dataset.child = String(kids.indexOf(l.p));
  }
  placeClassic(el, pm);
}

function placeClassic(el, pm) {
  const st = classicState.get(el);
  if (!st) return;
  const er = el.getBoundingClientRect();
  const k = er.width / (el.offsetWidth || 1) || 1; // the widget is scaled with the canvas
  const pr = pm.getBoundingClientRect();
  Object.assign(st.layer.style, {
    left: (pr.left - er.left) / k + "px",
    top: (pr.top - er.top) / k + "px",
    width: pr.width / k + "px",
    height: pr.height / k + "px",
  });
  for (const card of st.layer.children) {
    const p = pm.children[Number(card.dataset.child)];
    if (!p) continue;
    const r = p.getBoundingClientRect();
    card.style.top = (r.top - pr.top) / k + "px";
    card.style.left = (r.left - pr.left) / k + "px";
    card.style.width = r.width / k + "px";
    card.style.right = "auto";
  }
}

setInterval(() => {
  const vue = !!window.LiteGraph?.vueNodesMode;
  for (const n of app.canvas?.graph?._nodes || []) {
    if (n.type !== TYPE) continue;
    try {
      if (vue) vueCards(n);
      else classicCards(n);
    } catch (e) {
      console.warn("[LC123] link cards", e);
    }
  }
}, 500);

