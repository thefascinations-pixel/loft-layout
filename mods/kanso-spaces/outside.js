// Local addition (not Kanso's): agents running outside Herdr — Claude Code, Codex and pi in
// VS Code, a plain terminal or tmux, the SDK — on this computer and every connected machine.
// Read-only: the probe (outside.py, run over Herdr's own connection with `exec … {on}`) reads
// session files and never talks to the agents. A Kanso update replaces this folder: re-apply after one.
import { div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { exec, readTextFile, appHome, window, shared, setShared } from "herdr";
import { paths } from "./platform-paths.js";
import { statusMark, duration } from "./agents.js";

const FRONT_MS = 15000, BEHIND_MS = 60000, TIMEOUT_MS = 90000;
export const OUTSIDE_ROW = 28, OUTSIDE_HEAD = 30;
const WHERE = { vscode: "VS Code", terminal: "Terminal", sdk: "SDK" };
// name; icon: a picture (image) or a one-color glyph (svg, tinted)
const AGENT = {
  claude: { name: "Claude Code", icon: "icons/claude.svg", tint: false },
  codex: { name: "Codex", icon: "icons/codex.svg", tint: true },
  pi: { name: "pi", icon: "icons/pi.svg", tint: true },
};
const STATUS = { busy: "working", idle: "idle" };

const keyOf = (m) => m ?? "";
const agentOf = (a) => AGENT[a.agent] ?? AGENT.claude;
export const whereOf = (a) => WHERE[a.where] ?? (a.where ? String(a.where).replace(/^claude-/, "") : "Outside Herdr");
export const titleOf = (a) => a.name || a.title || a.first || paths.basename(a.cwd || "") || agentOf(a).name;
// Anything other than busy/idle (a permission or input wait) is someone waiting on you.
const statusOf = (s) => STATUS[s] ?? (s ? "blocked" : "idle");
const clock = (ms) => (ms ? new Date(ms).toTimeString().slice(0, 5) : "?");

export class Outside {
  constructor() {
    this.by = new Map(); // machine ("" here) -> [agent]
    this.at = new Map(); // machine -> last look (ms)
    this.busy = new Set();
    this.seen = new Map(); // `${machine}:${session}` -> last status, to tell "done"
    this.done = new Set(); // finished while you weren't looking; cleared by a click
    this.folded = new Set();
    this.script = null;
  }

  async probe() {
    if (this.script == null) this.script = (await readTextFile(paths.join(appHome(), "mods", "kanso-spaces", "outside.py"))) ?? "";
    return this.script;
  }

  // `names`: connected machines' names; null is this computer.
  poll(names, cx, force = false) {
    const now = Date.now(), every = window().active ? FRONT_MS : BEHIND_MS;
    for (const m of [null, ...names]) {
      const k = keyOf(m);
      if (this.busy.has(k) || (!force && now - (this.at.get(k) ?? 0) < every)) continue;
      this.busy.add(k);
      cx.spawn(async (cx) => {
        try {
          const script = await this.probe();
          if (!script) return;
          const r = await exec("sh", ["-c", 'command -v python3 >/dev/null 2>&1 || PATH="$PATH:/usr/bin:/opt/uv/bin:/usr/local/bin"; exec python3 -c "$0"', script], { on: m, timeout: TIMEOUT_MS });
          if (r.code !== 0) return;
          const list = (JSON.parse(r.stdout).agents ?? []).map((a) => this.mark(k, a));
          const live = new Set(list.map((a) => a.id));
          for (const id of [...this.seen.keys()]) if (id.startsWith(`${k}:`) && !live.has(id)) { this.seen.delete(id); this.done.delete(id); }
          this.by.set(k, list.toSorted((x, y) => (y.updated ?? 0) - (x.updated ?? 0)));
        } catch { /* unreachable or a bad read: keep the last list */ }
        finally { this.at.set(k, Date.now()); this.busy.delete(k); this.publish(); cx.notify(); }
      });
    }
    for (const k of [...this.by.keys()]) if (k && !names.includes(k)) this.by.delete(k);
  }

  mark(k, a) {
    const id = `${k}:${a.agent ?? "claude"}:${a.session}`, status = statusOf(a.status), was = this.seen.get(id);
    if (was === "working" && status === "idle") this.done.add(id);
    if (status !== "idle") this.done.delete(id);
    this.seen.set(id, status);
    return { ...a, id, status, machine: k || null };
  }

  listOf(m) { return (this.by.get(keyOf(m)) ?? []).map((a) => (this.done.has(a.id) ? { ...a, status: "done" } : a)); }
  all() { return [...this.by.keys()].flatMap((k) => this.listOf(k || null)); }
  ack(a) { this.done.delete(a.id); this.publish(); }

  // Shared as "kanso.outside" so other mods (the office strip) can show these agents too.
  publish() {
    const list = this.all().map((a) => ({ id: a.id, agent: a.agent ?? "claude", where: a.where ?? null, machine: a.machine,
      status: a.status, title: titleOf(a), cwd: a.cwd ?? null }));
    if (JSON.stringify(shared("kanso.outside") ?? []) !== JSON.stringify(list)) setShared("kanso.outside", list);
  }
}

function tip(a) {
  const lines = [titleOf(a), `${agentOf(a).name} in ${whereOf(a)} · ${a.cwd}`, `started ${clock(a.started)} · pid ${a.pid}${a.version ? ` · v${a.version}` : ""}`];
  if (a.last) lines.push(`last: ${a.last.length > 120 ? a.last.slice(0, 119) + "…" : a.last}`);
  lines.push("Click: copy session ID");
  return lines.join("\n");
}

function iconOf(a, t, live) {
  const { icon, tint } = agentOf(a);
  return (tint ? svg(icon).size(15).text_color(t.foreground) : image(icon).w(15).h(15)).flex_none().opacity(live ? 1 : 0.75);
}

// One agent: its program's mark, its title, how long in this state, the state.
export function outsideRow(a, t, now, indent, { showMachine = false, onClick }) {
  const live = a.status === "working" || a.status === "blocked" || a.status === "done";
  const since = a.status === "idle" ? (a.at ?? a.updated) : a.updated;
  return h_flex().id(`outside-${a.id}`).h(OUTSIDE_ROW).flex_none().pl(indent).pr(8).gap(10).items_center().rounded(6)
    .cursor_pointer().hover((s) => s.bg(t.foreground + "0c"))
    .tooltip(tip(a))
    .on_click((_e, cx) => { cx.write_to_clipboard?.(a.session); onClick(a, cx); })
    .child(iconOf(a, t, live))
    .child(div().flex_1().min_w(0).truncate().text_size(13.5).font_medium().text_color(live ? t.foreground : t.muted).child(titleOf(a)))
    .when(showMachine && Boolean(a.machine), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(a.machine)))
    .when(Boolean(since), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(duration(Math.max(0, now - since)))))
    .child(statusMark(t, a.status));
}

const RANK = { blocked: 4, done: 3, working: 2, idle: 1 };
const top = (list) => list.reduce((m, a) => ((RANK[a.status] ?? 0) > (RANK[m] ?? 0) ? a.status : m), null);

// Under a machine in Projects: one foldable group per place (VS Code, Terminal, …).
export function outsideGroups(o, m, t, now, notify) {
  const list = o.listOf(m);
  if (!list.length) return [];
  const groups = [...new Set(list.map(whereOf))];
  return groups.flatMap((where, i) => {
    const mine = list.filter((a) => whereOf(a) === where);
    const id = `${keyOf(m)}:${where}`, open = !o.folded.has(id), mark = top(mine);
    const lift = i ? 0 : 6;
    const head = h_flex().id(`outside-head-${id}`).h(OUTSIDE_HEAD + lift).flex_none().px(8).pt(lift).gap(9).items_center().rounded(6)
      .cursor_pointer().text_color(t.muted).hover((s) => s.bg(t.foreground + "0c"))
      .tooltip(`${where}: ${[...new Set(mine.map((a) => agentOf(a).name))].join(", ")} running outside Herdr${m ? ` on ${m}` : ""}`)
      .on_click((_e, cx) => { open ? o.folded.add(id) : o.folded.delete(id); notify(cx); })
      .child(svg("mods/kanso-chrome/icons/monitor.svg").size(15).flex_none().text_color(t.dim))
      .child(div().text_size(12.5).font_medium().child(where))
      .child(div().text_size(12).text_color(t.dim).child(String(mine.length)))
      .child(div().flex_1())
      .when(!open && Boolean(mark) && mark !== "idle", (el) => el.child(statusMark(t, mark)))
      .child(svg(`mods/kanso-chrome/icons/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim));
    const rows = open ? mine.map((a) => ({ el: outsideRow(a, t, now, 34, { onClick: (x, cx) => { o.ack(x); notify(cx); } }), h: OUTSIDE_ROW })) : [];
    return [{ el: head, h: OUTSIDE_HEAD + lift }, ...rows];
  });
}
