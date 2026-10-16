/**
 * Update LC nodes: rebuilds every LC node whose saved shape no longer matches its pack's current definition (an
 * input, widget or output the saved node is missing), so old workflows get the new sockets and settings.
 *
 * Each rebuilt node keeps its id (Bypassers, tours and anything else pointing at it keep working), its position,
 * size, title, colors, mode and properties; widget values carry over by NAME and wires by socket NAME. A node is
 * only touched when it is missing something, so extra widgets added by an LC script (a form, a seed control) and
 * sockets an LC node grows itself never flag it. One undo step.
 *
 * Right-click the canvas: "Update LC nodes", then "Undo LC node update" to put the workflow back exactly as it was
 * (a snapshot taken just before, per workflow). Also window.LC_UPDATE.{scan, update, undo, canUndo}.
 */
import { app } from "../../scripts/app.js";

const LC_MODULE = /ComfyUI_LC/i;

function defOf(type) {
  return LiteGraph.registered_node_types?.[type]?.nodeData || null;
}

const isLC = (node) => LC_MODULE.test(defOf(node.type)?.python_module || "");

/** Every graph in the workflow: the root and each subgraph's inside. */
function graphs() {
  const root = app.rootGraph || app.graph;
  const out = [root];
  const subs = root?.subgraphs || root?._subgraphs;
  if (subs) for (const g of subs.values ? subs.values() : Object.values(subs)) out.push(g);
  return out.filter(Boolean);
}

/** What the saved node is missing compared with its current definition: [] when it is up to date. */
function missing(node) {
  const d = defOf(node.type);
  if (!d) return [];
  // a setting (widget) is there when its widget is, or when it was turned into a wired input; a socket when its input is
  const widgets = new Set((node.widgets || []).map((w) => w.name));
  const inputs = node.inputs || [];
  const have = new Set([...widgets, ...inputs.map((i) => i.name)]);
  const WIDGET_TYPES = new Set(["INT", "FLOAT", "STRING", "BOOLEAN", "COMBO"]);
  const gone = [];
  for (const sect of ["required", "optional"]) {
    for (const [name, spec] of Object.entries(d.input?.[sect] || {})) {
      const kind0 = Array.isArray(spec) ? spec[0] : spec;
      const opts = Array.isArray(spec) ? spec[1] || {} : {};
      const isWidget = (Array.isArray(kind0) || WIDGET_TYPES.has(kind0)) && !opts.forceInput;
      const present = isWidget
        ? widgets.has(name) || inputs.some((i) => i.name === name && i.link != null) // its widget, or wired in its place
        : inputs.some((i) => i.name === name) || widgets.has(name);
      if (present) continue;
      // growing sockets (Autogrow, dynamic groups) show as name.child_1 ...
      if ([...have].some((h) => String(h).startsWith(name + "."))) continue;
      const kind = Array.isArray(spec) ? spec[0] : spec;
      if (typeof kind === "string" && kind.startsWith("COMFY_")) continue; // V3 dynamic containers
      gone.push(`input "${name}"`);
    }
  }
  const outs = d.output_name || d.output || [];
  const types = d.output || [];
  const dynamicOuts = types.length > 1 && types.every((t) => t === "*"); // nodes that size their own outputs
  if (!dynamicOuts) {
    const haveOut = new Set((node.outputs || []).map((o) => o.name));
    outs.forEach((name, i) => {
      if (!haveOut.has(name) && !(node.outputs?.[i] && node.outputs[i].type === types[i])) gone.push(`output "${name}"`);
    });
  }
  return gone;
}

/** LC nodes that need rebuilding: [{node, graph, why}]. */
export function scan() {
  const out = [];
  for (const g of graphs()) {
    for (const node of g._nodes || g.nodes || []) {
      if (!isLC(node)) continue;
      const why = missing(node);
      if (why.length) out.push({ node, graph: g, why });
    }
  }
  return out;
}

const wait = () => new Promise((r) => setTimeout(r, 0));

/** Rebuild one node from its current definition, keeping id, values (by name), wires (by name) and looks. */
async function rebuild(old, graph) {
  const fresh = LiteGraph.createNode(old.type);
  if (!fresh) return false;
  const id = old.id;
  // wires, by socket name (index as a fallback)
  const ins = (old.inputs || []).map((inp, i) => {
    const link = inp.link != null ? graph.links?.[inp.link] ?? graph.links?.get?.(inp.link) : null;
    return link ? { name: inp.name, index: i, from: link.origin_id, fromSlot: link.origin_slot } : null;
  }).filter(Boolean);
  const outs = [];
  (old.outputs || []).forEach((o, i) => {
    for (const lid of o.links || []) {
      const link = graph.links?.[lid] ?? graph.links?.get?.(lid);
      if (link) outs.push({ name: o.name, index: i, to: link.target_id, toSlot: link.target_slot });
    }
  });
  const values = {};
  for (const w of old.widgets || []) if (w?.name && w.value !== undefined && typeof w.value !== "function") values[w.name] = w.value;
  const look = {
    pos: [...old.pos], size: [...old.size], title: old.title, color: old.color, bgcolor: old.bgcolor, mode: old.mode,
    flags: { ...(old.flags || {}) }, properties: JSON.parse(JSON.stringify(old.properties || {})),
    titleIsDefault: old.title === (defOf(old.type)?.display_name || old.type),
  };
  graph.remove(old);
  fresh.id = id;
  fresh.pos = look.pos;
  Object.assign(fresh.properties || (fresh.properties = {}), look.properties);
  if (!look.titleIsDefault) fresh.title = look.title; // a renamed node keeps its name, a stock title takes the new one
  if (look.color) fresh.color = look.color;
  if (look.bgcolor) fresh.bgcolor = look.bgcolor;
  fresh.mode = look.mode;
  fresh.flags = look.flags;
  graph.add(fresh);
  await wait();
  for (const w of fresh.widgets || []) {
    if (Object.prototype.hasOwnProperty.call(values, w.name)) {
      w.value = values[w.name];
      try {
        w.callback?.(w.value, app.canvas, fresh);
      } catch (_) {}
    }
  }
  try {
    fresh.onConfigure?.({ widgets_values: (fresh.widgets || []).map((w) => w.value), properties: fresh.properties });
  } catch (_) {}
  await wait();
  const slotIn = (name, index) => {
    const k = (fresh.inputs || []).findIndex((i) => i.name === name);
    return k >= 0 ? k : index < (fresh.inputs || []).length ? index : -1;
  };
  const slotOut = (name, index) => {
    const k = (fresh.outputs || []).findIndex((o) => o.name === name);
    return k >= 0 ? k : index < (fresh.outputs || []).length ? index : -1;
  };
  for (const w of ins) {
    const src = graph.getNodeById(w.from);
    const k = slotIn(w.name, w.index);
    if (src && k >= 0) src.connect(w.fromSlot, fresh, k);
  }
  for (const w of outs) {
    const dst = graph.getNodeById(w.to);
    const k = slotOut(w.name, w.index);
    if (dst && k >= 0) fresh.connect(k, dst, w.toSlot);
  }
  const min = fresh.computeSize();
  fresh.setSize([Math.max(min[0], look.size[0]), Math.max(min[1], look.size[1])]);
  fresh.setDirtyCanvas?.(true, true);
  return true;
}

// the workflow as it was just before the last update, per workflow tab: "Undo LC node update" puts it back
const snapshots = new Map();
const tabKey = () => app.extensionManager?.workflow?.activeWorkflow?.path || "(unsaved)";

export const canUndo = () => snapshots.has(tabKey());

/** Put the workflow back exactly as it was before the last update. */
export async function undo() {
  const snap = snapshots.get(tabKey());
  if (!snap) return false;
  const root = app.rootGraph || app.graph;
  root.configure(JSON.parse(snap));
  snapshots.delete(tabKey());
  try {
    app.extensionManager?.workflow?.activeWorkflow?.changeTracker?.checkState?.();
  } catch (_) {}
  app.canvas?.setDirty?.(true, true);
  return true;
}

/** Rebuild the given scan items (default: everything scan() finds). -> number rebuilt. */
export async function update(items = scan()) {
  let n = 0;
  if (items.length) {
    try {
      snapshots.set(tabKey(), JSON.stringify((app.rootGraph || app.graph).serialize()));
    } catch (e) {
      console.warn("[LC] Update LC nodes: no undo snapshot", e);
    }
  }
  for (const it of items) {
    try {
      if (await rebuild(it.node, it.graph)) n += 1;
    } catch (e) {
      console.warn("[LC] Update LC nodes: could not rebuild", it.node?.type, e);
    }
  }
  try {
    app.extensionManager?.workflow?.activeWorkflow?.changeTracker?.checkState?.();
  } catch (_) {}
  app.canvas?.setDirty?.(true, true);
  return n;
}

function toast(severity, summary, detail) {
  try {
    app.extensionManager?.toast?.add?.({ severity, summary, detail, life: 6000 });
  } catch (_) {
    console.log(`[LC] ${summary}: ${detail}`);
  }
}

/** LC packs this workflow uses that are older than their newest Registry version: [{pack, installed, latest}]. */
async function packsBehind() {
  let info = {};
  try {
    const r = await fetch("/lc/pack_versions", { cache: "no-store" });
    if (r.ok) info = await r.json();
  } catch (_) {
    return [];
  }
  const used = new Set();
  for (const g of graphs()) {
    for (const node of g._nodes || g.nodes || []) {
      const m = String(defOf(node.type)?.python_module || "").match(/(ComfyUI_LC[^.]*)/i);
      if (m) used.add(m[1]);
    }
  }
  return Object.entries(info).filter(([pack, v]) => used.has(pack) && v.behind)
    .map(([pack, v]) => ({ pack, installed: v.installed, latest: v.latest }));
}

// ComfyUI's own confirm dialog when there is one (window.confirm is blocked in some frontends)
const confirmBox = async (title, message) => {
  const ask = app.extensionManager?.dialog?.confirm;
  return ask ? await ask({ title, message }) : window.confirm(`${title}\n\n${message}`);
};

/** The menu action: packs first, then say what is out of date, ask, then rebuild. */
async function runFromMenu() {
  const old = await packsBehind();
  if (old.length) {
    const lines = old.map((p) => `• ${p.pack.replace(/^ComfyUI_/, "").replace(/_nodes$/, "")}: ${p.installed} installed, ${p.latest} is out`).join("\n");
    const go = await confirmBox("Update the LC packs first",
      `${lines}\n\nUpdate ${old.length > 1 ? "these packs" : "this pack"} in ComfyUI-Manager and restart ComfyUI, then run Update LC nodes again: `
      + "the nodes are rebuilt from the pack you have installed.\n\nUpdate the nodes anyway, with the packs you have now?");
    if (!go) return;
  }
  const items = scan();
  if (!items.length) {
    toast("success", "LC nodes are up to date", "Every LC node in this workflow matches its pack.");
    return;
  }
  const list = items.slice(0, 12).map((it) => `• ${it.node.title || it.node.type}: missing ${it.why.join(", ")}`).join("\n");
  const more = items.length > 12 ? `\n… and ${items.length - 12} more` : "";
  const ok = await confirmBox(`Update ${items.length} LC node${items.length > 1 ? "s" : ""}?`,
    `${list}${more}\n\nValues and wires carry over by name. Undo LC node update (right-click the canvas) puts it back.`);
  if (!ok) return;
  const n = await update(items);
  toast("success", `Updated ${n} LC node${n === 1 ? "" : "s"}`, "Not what you expected? Right-click the canvas: Undo LC node update.");
}

async function undoFromMenu() {
  if (await undo()) toast("info", "LC node update undone", "The workflow is back exactly as it was before the update.");
  else toast("warn", "Nothing to undo", "There is no LC node update to undo in this workflow.");
}

window.LC_UPDATE = { scan, update, undo, canUndo, packsBehind };

app.registerExtension({
  name: "LC123.UpdateLCNodes",
  commands: [
    { id: "LC.UpdateLCNodes", label: "Update LC nodes", icon: "pi pi-refresh", function: runFromMenu },
    { id: "LC.UndoUpdateLCNodes", label: "Undo LC node update", icon: "pi pi-undo", function: undoFromMenu },
  ],
  getCanvasMenuItems() {
    const items = [null, { content: "🔄 Update LC nodes", callback: runFromMenu }];
    if (canUndo()) items.push({ content: "↩️ Undo LC node update", callback: undoFromMenu });
    return items;
  },
});
