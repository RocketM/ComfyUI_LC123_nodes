// Download an LC123 report as a .csv file, made in the browser (the server writes nothing). The report's own tables
// and finding cards become rows, each with the section it sits under. Safe to open in Excel / Sheets: a cell that
// starts like a formula (= + - @ or a tab / return) is stored as plain text, so a folder or pack name can never run
// as a formula. UTF-8 with a BOM, so emoji and accents come through.

const NUMBER = /^-?\d+(\.\d+)?$/;

export function csvCell(v) {
  let s = String(v ?? "").replace(/\s+/g, " ").trim();
  if (/^[=+\-@\t\r]/.test(s) && !NUMBER.test(s)) s = "'" + s; // formula injection guard; plain numbers stay numbers
  return /[",\n\r]/.test(s) || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s;
}

const isHeading = (el) =>
  el.tagName === "DIV" && /font-weight:\s*(600|700)/.test(el.getAttribute("style") || "") && !el.querySelector("table, div") &&
  el.textContent.trim().length > 0 && el.textContent.trim().length < 100 && !/[.!]$/.test(el.textContent.trim()); // a sentence is an intro, not a section
const isCard = (el) => el.tagName === "DIV" && /border-left:\s*3px/.test(el.getAttribute("style") || "");

/** Rows ([section, ...cells]) from a rendered report, in reading order. */
export function reportRows(root) {
  const rows = [];
  let section = "Summary";
  const walk = (el) => {
    for (const c of el.children) {
      if (isHeading(c)) {
        section = c.textContent.trim();
      } else if (c.tagName === "TABLE") {
        for (const tr of c.querySelectorAll("tr")) {
          const cells = [...tr.children].map((td) => td.textContent.trim());
          if (cells.some((x) => x)) rows.push([section, ...cells]);
        }
      } else if (isCard(c)) {
        const b = c.querySelector("b");
        const title = b ? b.textContent.trim() : "";
        const full = c.textContent.trim();
        const icon = full.split(title)[0].trim();
        const rest = title ? full.slice(full.indexOf(title) + title.length).replace(/^\s*:\s*/, "") : full;
        rows.push([section, icon, title, rest]);
      } else if (c.children.length) {
        walk(c);
      }
    }
  };
  walk(root);
  return rows;
}

export function downloadCsv(title, root) {
  const rows = reportRows(root);
  if (!rows.length) return false;
  const width = Math.max(...rows.map((r) => r.length));
  const head = ["Section", ...Array.from({ length: width - 1 }, (_, i) => `Column ${i + 1}`)];
  const csv = "﻿" + [head, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}-${p2(d.getMinutes())}`; // local time
  const name = `LC123 ${title} ${stamp}.csv`.replace(/[\\/:*?"<>|]+/g, "-");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  return true;
}

/** Adds a "Download CSV" button next to a report window's Copy report button. */
export function addCsvButton(box, copySelector, bodySelector, title) {
  const copy = box.querySelector(copySelector);
  if (!copy || box.querySelector(".lc-csv-btn")) return;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "lc-csv-btn p-button p-button-sm";
  btn.textContent = "Download CSV";
  btn.title = "Saves this report as a .csv file (made in your browser; safe to open in Excel or Sheets).";
  btn.onclick = () => downloadCsv(title, box.querySelector(bodySelector));
  copy.after(btn);
  // follows the Copy report button: usable exactly when there is a finished report on screen
  const sync = () => (btn.disabled = copy.disabled);
  new MutationObserver(sync).observe(copy, { attributes: true, attributeFilter: ["disabled"] });
  sync();
}
