// Local addition: Herdr never gets a status from pi (it sends no OSC 7501 report), so a terminal
// running pi stays "null" in the office and never sits down to work. This worker closes that gap:
// it finds each live pi terminal, runs piwork.py (read-only) over Herdr's own connection, and the
// probe reads the session file pi writes for each one — working while the turn is unfinished, else
// idle — plus the turn's start, so the strip's bar can show how long the worker has run.
import { exec, terminals, appHome, readTextFile, setShared, shared } from "herdr";

const KEY = "office.piwork"; // shared: what the strip draws, address -> { ... }
const TIMEOUT_MS = 15000;

export default class PiWork {
  constructor(cx) {
    this.cx = cx;
    this.last = new Map(); // address -> last published row
    this.busy = false; // a probe is running
    this.script = null;
  }

  async probe() {
    if (this.script == null) this.script = (await readTextFile(appHome() + "/mods/office/piwork.py")) ?? "";
    return this.script;
  }

  // Live pi terminals: herdr launches agents as `zsh -lic <wrapper> /bin/zsh pi`, so "pi" is an
  // argv word of its own, or the app's program table says so. Remote machines are skipped (their
  // session files are not on this Mac). created_ms falls back to the loft.id label's suffix.
  piTerminals() {
    const out = [];
    for (const k of terminals()) {
      if (k.state !== "live" || String(k.address).includes("/")) continue;
      const args = k.argv ?? [];
      const byArgv = args.some((x) => String(x) === "pi" || /(^|\/)(bin\/)?pi$/.test(String(x)));
      const byProg = k.program?.key === "pi";
      if (!byArgv && !byProg) continue;
      const created = k.created_ms ?? (Number(String(k.labels?.["loft.id"] ?? "").split("-").pop()) || null);
      out.push({ address: k.address, cwd: k.cwd ?? null, created_ms: created, title: k.title ?? null });
    }
    // Newest first, so the probe hands the most recently written file to the newest terminal.
    return out.toSorted((a, b) => (b.created_ms ?? 0) - (a.created_ms ?? 0));
  }

  // One look at every live pi terminal, in a single probe.
  async tick() {
    if (this.busy) return;
    const list = this.piTerminals();
    const live = new Set(list.map((t) => t.address));
    for (const a of [...this.last.keys()]) if (!live.has(a)) this.last.delete(a);
    if (!list.length) { this.publish(); return; }
    this.busy = true;
    try {
      const script = await this.probe();
      if (!script) return;
      // sh -c '<cmd>' <script> <json>  ->  $0 is the script, $1 the terminal list.
      const r = await exec("sh", ["-c", 'command -v python3 >/dev/null 2>&1 || PATH="$PATH:/usr/bin:/opt/uv/bin:/usr/local/bin"; exec python3 -c "$0" "$1"', script, JSON.stringify(list)], { timeout: TIMEOUT_MS });
      if (r.code !== 0) return;
      const res = JSON.parse(r.stdout || "{}");
      for (const t of list) {
        const s = res[t.address] ?? {};
        this.last.set(t.address, {
          address: t.address, cwd: t.cwd, started: t.created_ms,
          since: s.since ?? null, title: s.title ?? null,
          first: s.first ? String(s.first).slice(0, 80) : null,
          status: s.status === "working" ? "working" : "idle", at: Date.now(),
        });
      }
      this.publish();
      this.cx.notify();
    } catch { /* keep the last look */ }
    finally { this.busy = false; }
  }

  // Shared as "office.piwork" so the strip (this same mod) draws the bars.
  publish() {
    const list = [...this.last.values()];
    if (JSON.stringify(shared(KEY) ?? []) !== JSON.stringify(list)) setShared(KEY, list);
  }
}
