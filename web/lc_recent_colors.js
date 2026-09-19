/**
 * LC123 Recent Colors — a row of your last 8 custom colors in the right-click
 * Colors menu.
 *
 * Colors get recorded when you pick one through the Colors > Custom picker
 * (pysssss Custom Scripts adds that entry). If Custom Scripts isn't installed
 * this adds its own "🎨 Custom" entry, so it works standalone.
 * Standard palette colors are never recorded. Toggle: Settings > LC123 >
 * Performance > Recent colors.
 */
import { app } from "../../scripts/app.js";

const SETTING_ID = "LC123.Performance.RecentColors";
const STORE_KEY = "LC123.RecentColors";
const MAX_RECENT = 8;
const PICK_WINDOW_MS = 120000; // a color pick counts if the Colors menu was opened this recently
const DEFAULT_PICK = "#353535";

function enabled() {
  try {
    const v = app.extensionManager?.setting?.get?.(SETTING_ID);
    if (v !== undefined && v !== null) return v === true;
  } catch (_) {}
  try {
    const v = app.ui?.settings?.getSettingValue?.(SETTING_ID);
    if (v !== undefined && v !== null) return v === true;
  } catch (_) {}
  return true;
}

function normalize(hex) {
  if (typeof hex !== "string") return null;
  let h = hex.trim().toLowerCase();
  if (!h.startsWith("#")) return null;
  if (h.length === 4) h = "#" + h[1] + h[1] + h[2] + h[2] + h[3] + h[3];
  return /^#[0-9a-f]{6}$/.test(h) ? h : null;
}

// same lighter-title rule as Custom Scripts' Custom picker
function shade(hex, amt) {
  const h = hex.replace(/^#/, "");
  const ch = [0, 2, 4].map((i) => Math.max(0, Math.min(255, parseInt(h.slice(i, i + 2), 16) + amt)));
  return "#" + ch.map((v) => v.toString(16).padStart(2, "0")).join("");
}

function standardColors() {
  const set = new Set();
  const palette = globalThis.LGraphCanvas?.node_colors || {};
  for (const c of Object.values(palette)) {
    for (const k of ["color", "bgcolor", "groupcolor"]) {
      const n = normalize(c?.[k]);
      if (n) set.add(n);
    }
  }
  return set;
}

function loadRecents() {
  try {
    const arr = JSON.parse(localStorage.getItem(STORE_KEY) || "[]");
    return Array.isArray(arr) ? arr.map(normalize).filter(Boolean).slice(0, MAX_RECENT) : [];
  } catch (_) {
    return [];
  }
}

function saveRecents(list) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(list));
  } catch (_) {}
}

function addRecent(hex) {
  const n = normalize(hex);
  if (!n || standardColors().has(n)) return;
  const list = [n, ...loadRecents().filter((c) => c !== n)].slice(0, MAX_RECENT);
  saveRecents(list);
}

function applyColor(node, hex) {
  const targets = [];
  const canvas = globalThis.LGraphCanvas?.active_canvas;
  const sel = canvas?.selected_nodes ? Object.values(canvas.selected_nodes) : [];
  if (sel.length > 1) targets.push(...sel);
  else targets.push(node);
  for (const t of targets) {
    if (!t) continue;
    if (t.constructor === globalThis.LiteGraph?.LGraphGroup) {
      t.color = hex;
    } else {
      t.color = shade(hex, 20);
      t.bgcolor = hex;
    }
  }
  (node || targets[0])?.setDirtyCanvas?.(true, true);
}

let _menuOpenedAt = 0;
let _fallbackPicker = null;
let _fallbackNode = null;

function openFallbackPicker(node) {
  if (!_fallbackPicker) {
    _fallbackPicker = document.createElement("input");
    _fallbackPicker.type = "color";
    _fallbackPicker.style.display = "none";
    document.body.appendChild(_fallbackPicker);
    _fallbackPicker.addEventListener("change", () => {
      const hex = normalize(_fallbackPicker.value);
      if (hex && _fallbackNode) {
        applyColor(_fallbackNode, hex);
        addRecent(hex);
      }
    });
  }
  _fallbackNode = node;
  _fallbackPicker.value = normalize(node?.bgcolor) || DEFAULT_PICK;
  _fallbackPicker.click();
}

function makeEntry(parent, label) {
  const el = document.createElement("div");
  el.className = "litemenu-entry submenu";
  const span = document.createElement("span");
  span.style.paddingLeft = "4px";
  span.style.display = "block";
  span.textContent = label;
  el.appendChild(span);
  parent.appendChild(el);
  return el;
}

function decorateMenu(node) {
  const menus = document.querySelectorAll(".litecontextmenu");
  let menu = null;
  for (let i = menus.length - 1; i >= 0; i--) {
    const first = menus[i].firstElementChild;
    if (first && (first.textContent.includes("No color") || first.value?.content?.includes("No color"))) {
      menu = menus[i];
      break;
    }
  }
  if (!menu || menu.dataset.lcRecent === "1") return;
  menu.dataset.lcRecent = "1";

  const hasCustom = Array.from(menu.children).some((c) => c.textContent.includes("Custom"));
  if (!hasCustom) {
    const entry = makeEntry(menu, "🎨 Custom");
    entry.onclick = () => {
      globalThis.LiteGraph?.closeAllContextMenus?.();
      openFallbackPicker(node);
    };
  }

  const recents = loadRecents();
  if (!recents.length) return;

  const row = document.createElement("div");
  row.className = "litemenu-entry";
  Object.assign(row.style, {
    display: "flex",
    alignItems: "center",
    gap: "4px",
    padding: "4px 6px",
    cursor: "default",
  });
  const tag = document.createElement("span");
  tag.textContent = "🕘";
  tag.title = "Recent colors";
  tag.style.marginRight = "2px";
  row.appendChild(tag);

  for (const hex of recents) {
    const sw = document.createElement("span");
    sw.title = hex;
    Object.assign(sw.style, {
      width: "14px",
      height: "14px",
      borderRadius: "3px",
      border: "1px solid #666",
      background: hex,
      cursor: "pointer",
      display: "inline-block",
    });
    sw.onclick = (e) => {
      e.stopPropagation();
      applyColor(node, hex);
      addRecent(hex);
      globalThis.LiteGraph?.closeAllContextMenus?.();
    };
    row.appendChild(sw);
  }
  menu.appendChild(row);
}

app.registerExtension({
  name: "LC123.RecentColors",
  setup() {
    const LGC = globalThis.LGraphCanvas;
    if (!LGC?.onMenuNodeColors) return;

    const onMenuNodeColors = LGC.onMenuNodeColors;
    LGC.onMenuNodeColors = function (value, options, e, menu, node) {
      const r = onMenuNodeColors.apply(this, arguments);
      if (enabled()) {
        _menuOpenedAt = Date.now();
        // two frames: lets Custom Scripts add its own Custom entry first
        requestAnimationFrame(() => requestAnimationFrame(() => decorateMenu(node)));
      }
      return r;
    };

    // Record colors picked through a hidden color input shortly after the Colors
    // menu was opened (Custom Scripts' picker). Runs before its own handler.
    document.addEventListener(
      "change",
      (e) => {
        const t = e.target;
        if (!enabled() || !t || t.tagName !== "INPUT" || t.type !== "color") return;
        if (t === _fallbackPicker) return; // recorded by our own handler
        if (t.style.display !== "none") return; // visible widgets belong to other nodes
        if (Date.now() - _menuOpenedAt > PICK_WINDOW_MS) return;
        addRecent(t.value);
      },
      true
    );
  },
});
