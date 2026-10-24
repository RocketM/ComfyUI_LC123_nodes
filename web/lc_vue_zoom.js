/**
 * Nodes 2.0 only: the click zoom of the LC on-node previews (the classic canvas has its own, in lc_image_preview.js and
 * MaskMaker's lc_mask_refine.js).
 *
 * Nodes 2.0 shows a node's picture with its own image element. Click it on an LC node that has a before picture: a
 * layer is laid over it at 100% (one picture pixel per screen pixel) and the pointer wipes before (left) | after (right).
 * The wheel zooms in and out, double-click takes the layer away. It also goes when the canvas is zoomed out until the
 * picture is tiny or the node leaves the screen. Nothing is added to the node until you click.
 */
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const vue = () => !!window.LiteGraph?.vueNodesMode;
let open = null; // {node, key, el, img, canvas, after, before, u, v, mag, pointer}

function viewUrl(meta) {
  const p = new URLSearchParams({ filename: meta.filename ?? "", type: meta.type || "temp", subfolder: meta.subfolder || "" });
  return api.apiURL(`/view?${p}`);
}

function load(src) {
  return new Promise((resolve) => {
    const i = new Image();
    i.crossOrigin = "anonymous";
    i.onload = () => resolve(i);
    i.onerror = () => resolve(null);
    i.src = src;
  });
}

function close() {
  if (!open) return;
  open.canvas.remove();
  open = null;
}

function draw() {
  const z = open;
  if (!z) return;
  const ds = app.canvas?.ds?.scale || 1;
  const cw = z.img.clientWidth, ch = z.img.clientHeight; // the picture element, in node units
  const c = z.canvas;
  const dpr = window.devicePixelRatio || 1;
  c.style.left = `${z.img.offsetLeft}px`;
  c.style.top = `${z.img.offsetTop}px`;
  c.style.width = `${cw}px`;
  c.style.height = `${ch}px`;
  c.width = Math.max(1, Math.round(cw * ds * dpr));
  c.height = Math.max(1, Math.round(ch * ds * dpr));
  const ctx = c.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = "#1b1b1b";
  ctx.fillRect(0, 0, c.width, c.height);
  const a = z.after, iw = a.naturalWidth, ih = a.naturalHeight;
  const sw = Math.min(iw, (cw * ds) / z.mag), sh = Math.min(ih, (ch * ds) / z.mag); // picture pixels shown
  const dw = (sw * z.mag * dpr), dh = (sh * z.mag * dpr); // their size on the layer, in layer pixels
  const dx = (c.width - dw) / 2, dy = (c.height - dh) / 2;
  const u0 = Math.max(0, Math.min(iw - sw, z.u * iw - sw / 2)), v0 = Math.max(0, Math.min(ih - sh, z.v * ih - sh / 2));
  z.view = { dx: dx / (ds * dpr), dy: dy / (ds * dpr), dw: dw / (ds * dpr), dh: dh / (ds * dpr), u0, v0, sw, sh, iw, ih };
  const crop = (img, w) => {
    const k = img.naturalWidth / iw;
    ctx.drawImage(img, u0 * k, v0 * k, sw * k, sh * k, dx, dy, w, dh);
  };
  const split = z.before && z.pointer != null ? Math.max(0, Math.min(dw, z.pointer * ds * dpr - dx)) : 0;
  crop(a, dw); // after underneath, before left of the pointer
  if (split > 0) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(dx, dy, split, dh);
    ctx.clip();
    crop(z.before, dw);
    ctx.restore();
  }
  if (z.before && z.pointer != null) {
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.lineWidth = 2 * dpr;
    ctx.beginPath();
    ctx.moveTo(dx + split, dy);
    ctx.lineTo(dx + split, dy + dh);
    ctx.stroke();
  }
  const label = `${Math.round(z.mag * 100)}%${z.before ? " · before | after" : ""} · double-click: back`;
  ctx.font = `${11 * dpr}px sans-serif`;
  const tw = ctx.measureText(label).width;
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.fillRect(dx + dw - tw - 10 * dpr, dy + dh - 18 * dpr, tw + 10 * dpr, 18 * dpr);
  ctx.fillStyle = "#fff";
  ctx.textAlign = "right";
  ctx.textBaseline = "bottom";
  ctx.fillText(label, dx + dw - 5 * dpr, dy + dh - 4 * dpr);
}

async function openOn(img, node, key, e) {
  close();
  // the picture sits letterboxed (contain) in its element: measure the click on the picture itself
  const b = img.getBoundingClientRect();
  const s = Math.min(b.width / img.naturalWidth, b.height / img.naturalHeight);
  const pw = img.naturalWidth * s, ph = img.naturalHeight * s;
  const px = b.left + (b.width - pw) / 2, py = b.top + (b.height - ph) / 2;
  if (e.clientX < px || e.clientX > px + pw || e.clientY < py || e.clientY > py + ph) return;
  const u = (e.clientX - px) / pw, v = (e.clientY - py) / ph;
  const beforeMeta = window.LC123VueBefore?.[key];
  const [after, before] = await Promise.all([load(img.currentSrc || img.src), beforeMeta ? load(viewUrl(beforeMeta)) : null]);
  if (!after) return;
  const canvas = document.createElement("canvas");
  canvas.style.cssText = "position:absolute;z-index:5;cursor:crosshair;";
  const parent = img.offsetParent || img.parentElement;
  parent.appendChild(canvas);
  // 100%, or the on-screen size when the canvas already shows the picture bigger than that
  open = { node, key, img, canvas, after, before, u, v, mag: Math.max(1, pw / img.naturalWidth), pointer: null,
    ds0: app.canvas?.ds?.scale || 1 };
  // zooming the canvas well out from where it was clicked (70%) closes it, like the classic previews
  const watch = setInterval(() => {
    if (!open || open.canvas !== canvas) return clearInterval(watch);
    if ((app.canvas?.ds?.scale || 1) < open.ds0 * 0.7) close();
  }, 250);
  canvas.addEventListener("pointermove", (ev) => {
    if (!open) return;
    const b = canvas.getBoundingClientRect();
    open.pointer = ((ev.clientX - b.left) / b.width) * canvas.clientWidth;
    draw();
  });
  canvas.addEventListener("pointerleave", () => {
    if (open) {
      open.pointer = null;
      draw();
    }
  });
  canvas.addEventListener("dblclick", (ev) => {
    ev.stopPropagation();
    close();
  });
  canvas.addEventListener("pointerdown", (ev) => ev.stopPropagation()); // no node drag while looking
  draw();
}

// the wheel over the layer magnifies the picture; caught before Nodes 2.0's canvas zoom sees it
window.addEventListener("wheel", (ev) => {
  if (!open?.view || ev.target !== open.canvas) return;
  ev.preventDefault();
  ev.stopImmediatePropagation();
  const canvas = open.canvas;
  const z = open, w = z.view, b = canvas.getBoundingClientRect();
  const px = ((ev.clientX - b.left) / b.width) * canvas.clientWidth, py = ((ev.clientY - b.top) / b.height) * canvas.clientHeight;
  const fx = Math.max(0, Math.min(1, (px - w.dx) / w.dw)), fy = Math.max(0, Math.min(1, (py - w.dy) / w.dh));
  const pu = (w.u0 + fx * w.sw) / w.iw, pv = (w.v0 + fy * w.sh) / w.ih; // the picture point under the pointer
  const step = Math.pow(1.25, Math.max(1, Math.min(4, Math.abs(ev.deltaY) / 100))); // a harder flick steps further
  const mag = Math.min(16, z.mag * (ev.deltaY > 0 ? 1 / step : step));
  const ds = app.canvas?.ds?.scale || 1;
  const fitMag = ds * Math.min(canvas.clientWidth / w.iw, canvas.clientHeight / w.ih);
  if (ev.deltaY > 0 && mag <= fitMag * 1.05) return close(); // out past the whole picture
  const vw = (w.sw * z.mag) / mag / w.iw, vh = (w.sh * z.mag) / mag / w.ih;
  z.u = pu - fx * vw + vw / 2;
  z.v = pv - fy * vh + vh / 2;
  z.mag = mag;
  draw();
}, { capture: true, passive: false });

document.addEventListener("click", (e) => {
  if (!vue() || open?.canvas === e.target) return;
  const nodeEl = e.target?.closest?.("[data-node-id]");
  if (!nodeEl) return;
  // the picture under the pointer (Nodes 2.0 lays a panel over it, so the click lands on that)
  const img = [...nodeEl.querySelectorAll("img")].find((i) => {
    const r = i.getBoundingClientRect();
    return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
  });
  if (!img?.naturalWidth) return;
  const key = nodeEl.getAttribute("data-node-id");
  const node = app.graph?.getNodeById?.(Number(key)) || app.graph?.getNodeById?.(key);
  const cls = String(node?.comfyClass || node?.type || "");
  if (!node || !/^LC/.test(cls) || !(key in (window.LC123VueBefore || {}))) return; // LC nodes with an LC preview only
  e.stopPropagation();
  openOn(img, node, key, e);
}, true);

// the canvas zoomed out until the picture is tiny, the node off screen, or Nodes 2.0 off: the layer goes
setInterval(() => {
  if (!open) return;
  if (!vue() || !open.img.isConnected) return close();
  const r = open.img.getBoundingClientRect();
  if (Math.sqrt(r.width * r.height) < 40 || r.right < 0 || r.bottom < 0 || r.left > innerWidth || r.top > innerHeight) return close();
  draw(); // follows the canvas zoom
}, 400);
