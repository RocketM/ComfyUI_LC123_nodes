/**
 * RTX support: when nvidia-vfx (NVIDIA's VFX SDK, about 800 MB) is missing, LC RTX Super Resolution shows an
 * "Install RTX support" button, and picking nvidia_rtx_vsr in an LC resize node offers the same install.
 * It asks first, runs pip with ComfyUI's own Python (progress in the console) and says to restart afterwards.
 */
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const SIZE = "about 800 MB";
let status = null;
let polling = null;

async function getStatus(fresh = false) {
  if (status && !fresh) return status;
  try {
    status = await (await api.fetchApi("/lc123/rtx/status")).json();
  } catch (_) {
    status = { installed: false, works: false, install: {} };
  }
  return status;
}

const toast = (severity, detail, life = 6000) => app.extensionManager?.toast?.add?.({ severity, summary: "RTX support", detail, life });

async function askInstall() {
  const st = await getStatus(true);
  if (st.works) return true;
  if (st.install?.running) return toast("info", "Already installing. Watch the ComfyUI console.");
  if (st.installed) {
    toast("warn", `nvidia-vfx ${st.version} is installed but didn't load. Restart ComfyUI; it also needs an NVIDIA RTX card.`, 9000);
    return false;
  }
  const msg = `RTX Video Super Resolution needs NVIDIA's nvidia-vfx package (${SIZE}). It installs into ComfyUI's own Python with pip.`
    + "\n\nProgress shows in the ComfyUI console. Restart ComfyUI when it's done.";
  const ok = await (app.extensionManager?.dialog?.confirm?.({ title: "Install RTX support?", message: msg }) ?? Promise.resolve(window.confirm(msg)));
  if (ok !== true) return false;
  await api.fetchApi("/lc123/rtx/install", { method: "POST" });
  toast("info", `Installing nvidia-vfx (${SIZE}). This takes a few minutes; progress is in the console.`, 8000);
  clearInterval(polling);
  let lost = 0; // polls with no install news (status route failing): stop after 30 s of that, or after 40 min in all
  const started = Date.now();
  polling = setInterval(async () => {
    const s = await getStatus(true);
    for (const n of app.graph?._nodes || []) if (n._lcRtxBtn) label(n);
    lost = s.install?.running || s.install?.done ? 0 : lost + 1;
    if (!s.install?.done && (lost >= 10 || Date.now() - started > 40 * 60 * 1000)) {
      clearInterval(polling);
      toast("warn", "Lost track of the install. Check the ComfyUI console, then restart ComfyUI.", 12000);
      return;
    }
    if (s.install?.done) {
      clearInterval(polling);
      if (s.install.ok) toast("success", "RTX support installed. Restart ComfyUI to use it.", 12000);
      else toast("error", `The install failed: ${String(s.install.log || "").trim().split("\n").slice(-2).join(" ")}`, 15000);
    }
  }, 3000);
  return false;
}

function label(node) {
  const b = node._lcRtxBtn;
  if (!b || !status) return;
  b.name = b.label = status.install?.running ? "⏳ Installing RTX support… (see console)"
    : status.install?.done && status.install?.ok ? "✅ Installed: restart ComfyUI"
    : status.installed ? "⚠️ RTX support didn't load: restart ComfyUI"
    : `⬇ Install RTX support (nvidia-vfx, ${SIZE})`;
  node.setDirtyCanvas?.(true, true);
}

app.registerExtension({
  name: "LC123.RTXSupport",
  async nodeCreated(node) {
    // any LC node with an nvidia_rtx_vsr choice: offer the install when it's picked and RTX can't run
    for (const w of node.widgets || []) {
      if (!Array.isArray(w.options?.values) || !w.options.values.includes("nvidia_rtx_vsr")) continue;
      const prev = w.callback;
      w.callback = function (v, ...rest) {
        const r = prev?.apply(this, [v, ...rest]);
        if (v === "nvidia_rtx_vsr") getStatus().then((s) => { if (!s.works) askInstall(); });
        return r;
      };
    }
    if ((node.comfyClass || node.constructor?.comfyClass) !== "LCRTXSuperResolution") return;
    const s = await getStatus();
    if (s.works || node._lcRtxBtn) return;
    node._lcRtxBtn = node.addWidget("button", "", null, () => askInstall());
    node._lcRtxBtn.serialize = false;
    label(node);
    node.setSize?.([Math.max(node.size[0], 320), node.computeSize()[1]]);
  },
});
