// Node Pack Usage Report: which installed custom node packs your saved workflows actually use, in the same window style
// as the other LC123 optimization reports. It scans your ComfyUI workflows folder (read-only). Nothing is changed.
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { addCsvButton } from "./lc_report_csv.js";

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);
const LAST_KEY = "lc123.packusage.lastRun";
const loadLast = () => {
  try {
    return JSON.parse(localStorage.getItem(LAST_KEY) || "null");
  } catch (_) {
    return null;
  }
};
const saveLast = (v) => {
  try {
    localStorage.setItem(LAST_KEY, JSON.stringify(v));
  } catch (_) {}
};
let running = false;

const mb = (x) => (x >= 1024 ? `${(x / 1024).toFixed(1)} GB` : `${Math.round(x)} MB`);

function section(h, lines, title, col, note, head, rows) {
  if (!rows.length) return;
  h.push(`<div style="margin:14px 0 4px;color:${col};font-weight:600;font-size:14px">${esc(title)} (${rows.length})</div>`);
  if (note) h.push(`<div style="color:#9aa3ad;font-size:12px;margin-bottom:4px">${note}</div>`);
  h.push(`<table style="width:100%;border-collapse:collapse">`);
  h.push(`<tr>${head.map((c) => `<th style="text-align:left;color:#9aa3ad;font-weight:500;padding:3px 10px 3px 0">${esc(c)}</th>`).join("")}</tr>`);
  lines.push("", `${title} (${rows.length}):`);
  for (const r of rows) {
    h.push(`<tr style="border-top:1px solid #2d333b">${r.map((c) => `<td style="padding:3px 10px 3px 0;vertical-align:top">${esc(c)}</td>`).join("")}</tr>`);
    lines.push("  " + r.filter((c) => c !== "").join(" | "));
  }
  h.push(`</table>`);
}

function openWindow() {
  const open = document.querySelector(".lc-pack-overlay");
  if (open && running) return;
  open?.remove();
  const ov = document.createElement("div");
  ov.className = "lc-pack-overlay";
  ov.style.cssText = "position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,0.55);display:flex;align-items:center;justify-content:center;";
  const box = document.createElement("div");
  box.style.cssText =
    "width:min(920px,94vw);max-height:88vh;overflow:auto;background:#1e2227;color:#dfe3e8;border:1px solid #3a4048;border-radius:10px;padding:18px 22px;font:13px/1.45 system-ui,sans-serif;";
  box.innerHTML = `<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
      <div style="font-size:17px;font-weight:600;flex:1">Node Pack Usage Report</div>
      <button class="lc-pack-last p-button p-button-sm p-button-secondary" type="button" style="display:none">Show last run</button>
      <button class="lc-pack-copy p-button p-button-sm" type="button" disabled>Copy report</button>
      <button class="lc-pack-again p-button p-button-sm" type="button" disabled>Run again</button>
      <button class="lc-pack-close p-button p-button-sm p-button-secondary" type="button">Close</button></div>
    <div class="lc-pack-body">Starting…</div>`;
  ov.appendChild(box);
  document.body.appendChild(ov);
  const body = box.querySelector(".lc-pack-body");
  const close = () => !running && ov.remove();
  box.querySelector(".lc-pack-close").onclick = close;
  ov.addEventListener("pointerdown", (e) => e.target === ov && close());
  let text = "";
  let current = "";
  let showingLast = false;
  const lastBtn = box.querySelector(".lc-pack-last");
  const paintLast = () => {
    const last = loadLast();
    lastBtn.style.display = last?.html ? "" : "none";
    lastBtn.textContent = showingLast ? "Back to this run" : "Show last run";
  };
  lastBtn.onclick = () => {
    const last = loadLast();
    if (!last?.html) return;
    showingLast = !showingLast;
    body.innerHTML = showingLast ? `<div style="color:#fbbf24;margin-bottom:8px">Last run: ${esc(last.when)}</div>` + last.html : current;
    paintLast();
  };
  box.querySelector(".lc-pack-copy").onclick = () => navigator.clipboard?.writeText(text);
  box.querySelector(".lc-pack-again").onclick = () => go();
  addCsvButton(box, ".lc-pack-copy", ".lc-pack-body", "Node Pack Usage Report");

  async function go() {
    if (running) return;
    running = true;
    showingLast = false;
    paintLast();
    for (const c of [".lc-pack-again", ".lc-pack-copy", ".lc-pack-close"]) box.querySelector(c).disabled = true;
    lastBtn.disabled = true;
    body.innerHTML = `<div style="padding:30px 0;text-align:center">Scanning your workflows folder… every saved workflow is read (nothing is changed). <b>A few seconds.</b></div>`;
    let rep = null;
    let failed = null;
    try {
      const r = await api.fetchApi("/lc123/packusage/run");
      rep = await r.json();
      if (rep?.error) failed = rep.error;
    } catch (e) {
      failed = e?.message || String(e);
    }
    running = false;
    for (const c of [".lc-pack-again", ".lc-pack-copy", ".lc-pack-close"]) box.querySelector(c).disabled = false;
    lastBtn.disabled = false;
    if (failed) {
      body.innerHTML = `<div style="padding:30px 0;text-align:center;color:#f87171">${esc(failed)}</div>`;
      return;
    }
    try {
      render(rep);
    } catch (e) {
      body.innerHTML = `<div style="padding:30px 0;text-align:center;color:#f87171">The report could not be built: ${esc(e?.message || e)}</div>`;
      console.warn("[LC123] Node pack usage", e);
    }
  }

  function render(p) {
    const h = [];
    const lines = ["Node Pack Usage Report", `${p.when} (${p.seconds} s)`, `Scanned: ${p.folder}`];
    const all = p.packs || [];
    const unused = all.filter((r) => r.workflows === 0 && !r.tool && !r.yours).sort((a, b) => b.size_mb - a.size_mb);
    const keep = all.filter((r) => r.workflows === 0 && (r.tool || r.yours));
    const rare = all.filter((r) => r.workflows >= 1 && r.workflows <= 2).sort((a, b) => a.workflows - b.workflows || b.size_mb - a.size_mb);
    const used = all.filter((r) => r.workflows > 2).sort((a, b) => b.workflows - a.workflows);
    const unusedMb = unused.reduce((s, r) => s + r.size_mb, 0);
    h.push(`<div style="color:#fbbf24;font-weight:700;margin-bottom:6px">Scanned your workflows folder to see which installed node packs your saved workflows use. Nothing is changed or uninstalled.</div>`);
    const rows = [
      ["Workflows folder", p.folder],
      ["Workflows read", `${p.workflows}${p.unreadable?.length ? ` (${p.unreadable.length} could not be read)` : ""}`],
      ["Packs installed", String(all.length)],
      ["Used by no workflow", `${unused.length} packs, ${mb(unusedMb)} on disk`],
      ["Used by only 1 or 2", `${rare.length} packs`],
    ];
    h.push(`<table style="width:100%;border-collapse:collapse;margin-bottom:6px">`);
    for (const [k, v] of rows) {
      h.push(`<tr style="border-top:1px solid #2d333b"><td style="color:#9aa3ad;padding:3px 10px 3px 0;white-space:nowrap">${esc(k)}</td><td>${esc(v)}</td></tr>`);
      lines.push(`${k}: ${v}`);
    }
    h.push(`</table>`);
    section(h, lines, "🛑 Used by no workflow", "#f87171",
      "Candidates to remove. A pack you only use in workflows saved somewhere else still shows here. Sizes leave out models the pack downloaded elsewhere.",
      ["Pack", "Nodes", "Size", ""], unused.map((r) => [r.pack, r.nodes, mb(r.size_mb), r.loaded ? "" : "did not load"]));
    section(h, lines, "✋ Unused, but keep", "#fbbf24", "Tools that work without nodes in a workflow, and your own packs.",
      ["Pack", "Why"], keep.map((r) => [r.pack, r.tool || "yours"]));
    section(h, lines, "🤏 Used by only 1 or 2 workflows", "#c4b5fd", "Worth a look: is the pack worth keeping for these?",
      ["Pack", "Workflows", "Nodes used / has", "Used nodes", "Used in"],
      rare.map((r) => [r.pack, r.workflows, `${r.used_nodes} / ${r.nodes}`, r.top.join(", "), r.examples.join("; ")]));
    section(h, lines, "✅ Used by 3 or more workflows", "#86efac", "",
      ["Pack", "Workflows", "Nodes used / has"], used.map((r) => [r.pack, r.workflows, `${r.used_nodes} / ${r.nodes}`]));
    section(h, lines, "❓ Nodes your workflows use that no installed pack provides", "#9aa3ad",
      "Those workflows open with missing nodes until the pack is installed.",
      ["Node", "Workflows", "Found in"], (p.missing || []).map((m) => [m.type, m.count, m.examples.join("; ")]));
    current = h.join("");
    body.innerHTML = current;
    text = lines.join("\n");
    saveLast({ when: new Date().toLocaleString(), html: current });
    paintLast();
  }

  go();
}

app.registerExtension({
  name: "LC123.PackUsage",
  settings: [
    {
      id: "LC123.Optimization.PackUsage",
      name: "Node Pack Usage Report",
      sortOrder: 5, // under the System & Model Optimization Report
      category: ["LC123 Settings ⚙️", "Optimization", "Node Pack Usage Report"],
      defaultValue: "",
      tooltip:
        "Scans your ComfyUI workflows folder and reads every saved workflow (subgraphs included) to see which installed node packs they actually use. Lists the packs no workflow uses, the ones only one or two use, and nodes your workflows need that no installed pack provides. Read-only: nothing is changed or uninstalled.",
      type: () => {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = "Scan my workflows folder";
        b.className = "p-button p-component p-button-sm";
        b.onclick = (e) => {
          e.preventDefault();
          e.stopPropagation();
          document.querySelector('.p-dialog-mask .p-dialog-close-button, .p-dialog .p-dialog-header-close, [role="dialog"] button[aria-label="Close dialog"]')?.click();
          setTimeout(openWindow, 250);
        };
        return b;
      },
    },
  ],
  getCanvasMenuItems() {
    return [{ content: "Node Pack Usage Report", callback: () => openWindow() }];
  },
});

window.LC123PackUsage = { open: openWindow };
