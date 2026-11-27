// Local addition: OpenCode isn't a program Herdr reports a status for, so its sidebar row had no spinner. This reads
// OpenCode's database (read-only, every 3 s): a session is "working" while its newest message is an assistant message
// that hasn't finished and was touched in the last 2 minutes.
import { exec, home } from "herdr";

const SQL = `select s.title, s.directory, m.time_updated as upd, json_extract(m.data,'$.role') as role, json_extract(m.data,'$.time.completed') as comp
  from session s join message m on m.id=(select id from message where session_id=s.id order by time_created desc limit 1)
  where s.parent_id is null and s.time_updated > (strftime('%s','now')-172800)*1000 order by m.time_updated desc;`;
const WORKING_MS = 120_000;

export const isOpencode = (k) => k?.program?.key === "opencode" || (k?.argv ?? []).some((x) => /(^|\/)opencode$/.test(String(x)));

export class OpenCode {
  constructor() { this.rows = []; this.busy = false; }

  poll(cx) {
    if (this.busy) return;
    this.busy = true;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("sqlite3", ["-readonly", "-cmd", ".timeout 1500", "-json", `${home()}/.local/share/opencode/opencode.db`, SQL], { timeout: 4000 });
        const rows = r.code === 0 && r.stdout.trim() ? JSON.parse(r.stdout) : [];
        if (JSON.stringify(rows) !== JSON.stringify(this.rows)) { this.rows = rows; cx.notify(); }
      } catch { /* no OpenCode here: keep the last look */ }
      finally { this.busy = false; }
    });
  }

  // terminal address -> "working" | "idle"
  statuses(terms) {
    const out = {};
    for (const k of terms) {
      if (k.state !== "live" || !isOpencode(k)) continue;
      const shown = String(k.labels?.["loft.shown"] ?? "").replace(/^OC \| /, "").replace(/…$/, "").trim();
      const cwd = k.cwd ?? k.last_cwd ?? null;
      const row = this.rows.find((r) => shown && r.title.startsWith(shown)) ?? this.rows.find((r) => r.directory === cwd) ?? null;
      out[k.address] = row && row.role === "assistant" && !row.comp && Date.now() - Number(row.upd) < WORKING_MS ? "working" : "idle";
    }
    return out;
  }
}
