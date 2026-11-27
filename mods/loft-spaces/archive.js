// Local addition: the Archive, a history of every Claude Code and Codex session stored on each machine (archive.py reads the
// transcript files), newest first, collapsed by default. A click resumes the conversation in a new tab.
import { div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { exec, readTextFile, appHome, window, run } from "herdr";
import { paths } from "./platform-paths.js";
import { programIcon } from "./marks.js";

const OPEN_KEY = "loft.archive.open", PAGE = 25;
export const ARCHIVE_ROW = 30, ARCHIVE_HEAD = 32;
const FRONT_MS = 60_000, BEHIND_MS = 300_000, TIMEOUT_MS = 20_000;

const load = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? d; } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* blocked storage */ } };
const base = (p) => String(p ?? "").split("/").filter(Boolean).at(-1) ?? "~";
const key = (m) => m ?? "";
function ago(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return d < 14 ? `${d}d` : d < 60 ? `${Math.floor(d / 7)}w` : `${Math.floor(d / 30)}mo`;
}

export class Archive {
  constructor() {
    this.by = new Map(); // machine ("" here) -> [session]
    this.at = new Map();
    this.busy = new Set();
    this.script = null;
    this.open = load(OPEN_KEY, false); // collapsed by default
    this.shown = PAGE;
  }

  setOpen(v) { this.open = v; save(OPEN_KEY, v); if (!v) this.shown = PAGE; }

  async probe() {
    if (this.script == null) this.script = (await readTextFile(paths.join(appHome(), "mods", "loft-spaces", "archive.py"))) ?? "";
    return this.script;
  }

  // `names`: connected machines; null is this computer. Looked at more often while the Archive is open.
  poll(names, cx, force = false) {
    const now = Date.now(), every = this.open && window().active ? FRONT_MS : BEHIND_MS;
    for (const m of [null, ...names]) {
      const k = key(m);
      if (this.busy.has(k) || (!force && now - (this.at.get(k) ?? 0) < every)) continue;
      this.busy.add(k);
      cx.spawn(async (cx) => {
        try {
          const script = await this.probe();
          if (!script) return;
          const r = await exec("sh", ["-c", 'command -v python3 >/dev/null 2>&1 || PATH="$PATH:/usr/bin:/opt/uv/bin:/usr/local/bin"; exec python3 -c "$0"', script], { on: m, timeout: TIMEOUT_MS });
          if (r.code !== 0) return;
          this.by.set(k, (JSON.parse(r.stdout).sessions ?? []).map((s) => ({ ...s, machine: m })));
        } catch { /* unreachable or a bad read: keep the last list */ }
        finally { this.at.set(k, Date.now()); this.busy.delete(k); cx.notify(); }
      });
    }
    for (const k of [...this.by.keys()]) if (k && !names.includes(k)) this.by.delete(k);
  }

  // Newest first across machines, minus the conversations running right now.
  list(running) {
    return [...this.by.values()].flat().filter((s) => !running.has(s.session)).toSorted((a, b) => b.at - a.at);
  }

  resume(s) {
    const argv = s.agent === "codex" ? ["codex", "resume", s.session] : s.agent === "pi" ? ["pi", "--session", s.session]
      : s.agent === "opencode" ? ["opencode", "--session", s.session] : ["claude", "--resume", s.session];
    if (s.machine) run("space.new", { machine: s.machine, name: s.title, folder: s.cwd, argv });
    else run("tab.new", { name: s.title, folder: s.cwd, argv });
  }
}

const PROGRAM = { claude: { icon: "icons/claude.svg", tint: false }, codex: { icon: "icons/codex.svg", tint: true }, pi: { icon: "icons/pi.svg", tint: true }, opencode: { icon: "icons/opencode.svg", tint: true } };
const LABEL = { claude: "Claude Code", codex: "Codex", pi: "pi", opencode: "OpenCode" };

// Items for the sidebar list: { el, h }.
export function archiveItems(a, running, t, now, notify) {
  const all = a.list(running);
  if (!all.length) return [];
  const head = h_flex().id("archive-head").h(ARCHIVE_HEAD).flex_none().px(8).gap(9).items_center().rounded(8).cursor_pointer()
    .bg(t.foreground + "0a").text_color(t.dim).hover((s) => s.bg(t.foreground + "14"))
    .tooltip("Every Claude Code, Codex, pi and OpenCode session stored on your machines. Click one to resume it in a new tab.")
    .on_click((_e, cx) => { a.setOpen(!a.open); notify(cx); })
    .child(div().w(3).h(18).flex_none().rounded_full().bg(t.dim))
    .child(svg("mods/loft-chrome/icons/clock.svg").size(15).flex_none().text_color(t.dim))
    .child(div().text_size(12).font_semibold().child("ARCHIVE"))
    .child(div().text_size(12).text_color(t.dim).child(String(all.length)))
    .child(div().text_size(10.5).text_color(t.dim).child("past sessions"))
    .child(div().flex_1())
    .child(svg(`mods/loft-chrome/icons/chevron-${a.open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim));
  const rule = div().h(1).mx(8).mt(12).mb(0).flex_none().bg(t.foreground + "14");
  const out = [{ el: rule, h: 13 }, { el: head, h: ARCHIVE_HEAD + 8 }];
  if (!a.open) return out;
  const hasRemote = all.some((s) => s.machine);
  for (const [i, s] of all.slice(0, a.shown).entries()) {
    const icon = programIcon(PROGRAM[s.agent], 15, t.muted);
    out.push({ h: ARCHIVE_ROW, el: h_flex().id(`archive-${i}-${s.session}`).h(ARCHIVE_ROW).flex_none().pl(18).pr(8).gap(9).items_center().rounded(6).cursor_pointer()
      .hover((x) => x.bg(t.foreground + "0c"))
      .tooltip(`${s.title}\n${LABEL[s.agent] ?? s.agent} · ${s.cwd}${s.machine ? ` · ${s.machine}` : ""}\nClick to resume`)
      .on_click((_e, cx) => { a.resume(s); notify(cx); })
      .child(icon ?? div().w(15).flex_none())
      .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(t.muted).child(s.title))
      .when(hasRemote && Boolean(s.machine), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(s.machine)))
      .child(div().flex_none().text_size(11).text_color(t.dim).child(`${base(s.cwd)} · ${ago(Math.max(0, now - s.at))}`)) });
  }
  if (all.length > a.shown) {
    out.push({ h: ARCHIVE_ROW, el: h_flex().id("archive-more").h(ARCHIVE_ROW).flex_none().pl(18).items_center().rounded(6).cursor_pointer().text_size(12).text_color(t.dim)
      .hover((x) => x.bg(t.foreground + "0c").text_color(t.foreground))
      .on_click((_e, cx) => { a.shown += PAGE; notify(cx); }).child(`Show ${Math.min(PAGE, all.length - a.shown)} more`) });
  }
  return out;
}
