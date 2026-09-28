/**
 * LC graph event bridge.
 *
 * ComfyUI 1.53 announces node property changes (mode, title, ...) through graph.trigger("node:property:changed"),
 * which only reaches graph.onTrigger, not graph.events. This forwards them once, as "lc123:node-property", on the
 * same graph's events target, so LC nodes can react to a mute / bypass the moment it happens instead of polling.
 * A separate event name, so nothing in ComfyUI or other packs sees a duplicate.
 */
export const NODE_PROPERTY_EVENT = "lc123:node-property";

let installed = false;

export function ensureGraphEventBridge() {
  if (installed) return true;
  const LGraph = window.LiteGraph?.LGraph || window.LGraph;
  const proto = LGraph?.prototype;
  if (!proto || typeof proto.trigger !== "function") return false;
  installed = true;
  const orig = proto.trigger;
  proto.trigger = function (type, detail) {
    const r = orig.apply(this, arguments);
    if (type === "node:property:changed" && detail && this.events?.dispatchEvent) {
      try {
        this.events.dispatchEvent(new CustomEvent(NODE_PROPERTY_EVENT, { detail }));
      } catch (_) {}
    }
    return r;
  };
  return true;
}

/** true when mode changes will be announced (bridge installed on a frontend that has graph events) */
export function graphEventsAvailable(graph) {
  return ensureGraphEventBridge() && !!graph?.events?.addEventListener;
}

ensureGraphEventBridge(); // install on load (LiteGraph is ready before extensions are imported); later calls are no-ops
