// Local patch: Kanso self-update disabled (an accidental update replaced the customized mods on 2026-11-27). Restore update.js.orig to re-enable.
// and must never install Kanso's releases over its own files. This stub keeps the callers' API.
export const SOURCE = null;
export const footerPx = (_hidden, _update) => 84 + 36 * 2;
export class Updater {
  busy = false;
  start() {}
  available() { return null; }
  async check() {}
  async install() {}
  fit() {}
}
