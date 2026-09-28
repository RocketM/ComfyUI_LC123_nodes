// Fonts that ship with LC123 (web/fonts, licenses next to them). Shared by LC Label and the LC Text Overlay
// live preview, so each face is registered with the browser once. lc_text_overlay.py lists the same files.
export const BUNDLED_FONTS = [
  { name: "Bebas Neue", file: "BebasNeue-Regular.ttf", weight: "400" },
  { name: "Oswald", file: "Oswald-Variable.ttf", weight: "200 700" },
  { name: "Permanent Marker", file: "PermanentMarker-Regular.ttf", weight: "400" },
  { name: "Pacifico", file: "Pacifico-Regular.ttf", weight: "400" },
  { name: "Lobster", file: "Lobster-Regular.ttf", weight: "400" },
  { name: "Great Vibes", file: "GreatVibes-Regular.ttf", weight: "400" },
  { name: "Abril Fatface", file: "AbrilFatface-Regular.ttf", weight: "400" },
  { name: "Cinzel Decorative", file: "CinzelDecorative-Regular.ttf", weight: "400" },
  { name: "UnifrakturMaguntia", file: "UnifrakturMaguntia-Book.ttf", weight: "400" },
  { name: "Monoton", file: "Monoton-Regular.ttf", weight: "400" },
  { name: "Bangers", file: "Bangers-Regular.ttf", weight: "400" },
  { name: "Creepster", file: "Creepster-Regular.ttf", weight: "400" },
  { name: "Rubik Glitch", file: "RubikGlitch-Regular.ttf", weight: "400" },
  { name: "Press Start 2P", file: "PressStart2P-Regular.ttf", weight: "400" },
];

let started = false;
const listeners = new Set();

/** Registers the bundled faces once. onLoaded runs whenever a face finishes loading (redraw there). */
export function loadBundledFonts(onLoaded) {
  if (onLoaded) listeners.add(onLoaded);
  if (started) return;
  started = true;
  const notify = () => listeners.forEach((fn) => { try { fn(); } catch (_) {} });
  document.fonts?.ready?.then(notify);
  for (const f of BUNDLED_FONTS) {
    try {
      const face = new FontFace(f.name, `url(${new URL("./fonts/" + f.file, import.meta.url).href})`, { weight: f.weight });
      document.fonts.add(face);
      face.load().then(notify).catch(() => {});
    } catch (_) {}
  }
}
