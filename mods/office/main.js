// The office: every agent is a coworker with a desk of their own. Working: typing.
// Idle: they walk to the water cooler and chat; idle long enough, they nap on the couch.
// Blocked: hand up at their desk (five minutes and the fire alarm goes). Done: cheering in
// confetti until you look. New agents come in the door; closed ones leave with a box.
// Sub-agents sit by their parent's desk as interns and graduate when they finish.
// Three finishes in five minutes and pizza arrives. A cat lives here. Lights go down after
// dark, the windows show the real weather, and the office decorates for the season.
// Hover anyone to see what they're working on; click them to go to their terminal.
import { View, div, svg } from "gpui-kit";
import { agents, terminals, spaces, panes, shared, run, setAgentOrder, exec, home, theme } from "herdr";
import * as A from "./art.js";
import * as D from "./decor.js";
import PiWork from "./piwork.js";

// Real weather in the windows. Off by default: it sends your IP address to ipapi.co for a
// rough location, then asks Open-Meteo for the current conditions there.
const WEATHER = false;

// Local patch: a descriptive name for an agent, the same one Loft's sidebar and headers show
// (its conversation title, shared as "loft.names"), else its own title, else its tab's name.
const cleanTitle = (x) => String(x ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();
function nameFor(a) {
  const said = (shared("loft.names") ?? {})[a.address];
  if (said && said !== a.address) return said;
  const live = cleanTitle(a.title);
  if (live && !/^[~/]/.test(live) && !live.includes("@") && live !== a.program?.name) return live;
  return (a.tab_name && a.tab_name !== a.program?.name && !/^\d+$/.test(a.tab_name) ? a.tab_name : null) || a.program?.name || a.space_name || a.address;
}
const WALK_SPEED = 0.16; // px per ms
const CAT_SPEED = 0.12;
const NAP_AFTER = 10 * 60 * 1000;
const ALARM_AFTER = 5 * 60 * 1000;
const SWEAT_AFTER = 30 * 60 * 1000;
const MUGS_AFTER = 60 * 60 * 1000;
const PARTY_FINISHES = 3, PARTY_WINDOW = 5 * 60 * 1000, PARTY_LENGTH = 8 * 60 * 1000;
const GRAD_BOW = 2500;
const COUCH_SEATS = 2;
const MIN_DESKS = 3;
const FRONT_ROW = 6;
const CHAT = ["…", "☕", "lgtm", "standup?", "🍩", "ship it", "nice", "brb", "tabs > spaces", "🎉", "coffee?", "hmm"];
const PIZZA_CHAT = ["🍕", "nom", "pizza!", "🍕", "best day", "nom nom"];
const CODE = ["#7fd1b9", "#f2b866", "#9aa8ff", "#e88fb0"];
const CONFETTI = ["#e05252", "#e0b43d", "#58b368", "#3d8be0", "#9b6bdc", "#e05c8c"];
// Pictures on the wall; some have something to say.
const PICTURES = [["pic-boat", "SHIP IT"], ["pic-cat"], ["pic-rocket", "LGTM"], ["pic-rainbow"], ["pic-heart", "BE KIND TO\nYOUR AGENTS"], ["pic-sun"], ["pic-duck", "push --force?\nno."], ["pic-pizza"]];
// What fills the wall either side of the room when the strip is wide, in this order.
const WALL_FURNITURE = ["bookshelf", "fishtank", "claw", "vending", "fridge", "arcade", "lemontree", "printer", "snackcart", "coatrack", "armchair", "globe", "bonsai", "teatable", "catbox", "palm"];
const HANGING = ["hang-ivy", "hang-pink"];
const COURIER = "courier";
// Boxes, in sprite px: how far above the floor a desk's box reaches, and an intern's box.
const DESK_TOP = 96;
const INTERN_W = 30, INTERN_H = 44;
const STATUS = { working: "#3d8be0", blocked: "#e05252", done: "#58c26b", idle: "#9aa0aa" };
// The sidebar's space colors (mods/my-spaces), by stored name.
const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };

function sky(hour) {
  if (hour < 5 || hour >= 21) return { top: "#141c38", bottom: "#2a3766", stars: true };
  if (hour < 7) return { top: "#9cc3e6", bottom: "#f4b98a" };
  if (hour < 17) return { top: "#7fc4f0", bottom: "#c4e6f8" };
  if (hour < 19) return { top: "#f7c98b", bottom: "#f29a6b" };
  return { top: "#3a3a6e", bottom: "#e07a5f" };
}
const lightsDown = (hour) => false; // local patch: night mode removed

// WMO weather codes (Open-Meteo) to what the windows show.
function weatherKind(code) {
  if (code >= 95) return "storm";
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "snow";
  if (code >= 51) return "rain";
  if (code === 45 || code === 48) return "fog";
  if (code >= 2) return "clouds";
  return "clear";
}

function season(d) {
  const m = d.getMonth(), day = d.getDate();
  if ((m === 11 && day === 31) || (m === 0 && day <= 2)) return "newyear";
  if (m === 11) return "winter";
  if (m === 9 || (m === 10 && day <= 7)) return "halloween";
  if (m === 1 && day === 14) return "valentine";
  return null;
}

const rotate = (list, n) => list.map((_, i) => list[(i + n) % list.length]);
const clock = (d) => `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
const remote = (address) => address.includes("/");

// Local patch: agents running outside Herdr (VS Code, a plain terminal), as loft-spaces finds them
// (shared "loft.outside"). They get a desk like anyone, but have no pane to jump to.
const OUT_PROG = { claude: { key: "claude", name: "Claude Code" }, codex: { key: "codex", name: "Codex" }, pi: { key: "pi", name: "pi" } };
function outsideAgents() {
  return (shared("loft.outside") ?? []).map((o) => ({
    address: `out:${o.id}`.replace(/\//g, "_"), pane: null, space: null, space_name: o.machine ?? "This Mac",
    tab: null, tab_index: 0, tab_name: null, status: o.status, app: o.agent,
    program: { ...(OUT_PROG[o.agent] ?? OUT_PROG.claude), icon: null, tint: false, tile: null, color: null, shell: false, agent: true },
    title: o.title, seq: 0, pinned: false, focused: false, outside: o.where || "outside",
  }));
}
// Local patch: OpenCode isn't one of Herdr's recognised agents, so a terminal running it never reached the office. Those
// terminals are added here, "working" while OpenCode's newest assistant message of the session is still unfinished
// (read from its database every 3 s), otherwise idle.
// Local patch (pi worker): pi sends no status to Herdr, so the pi worker (piwork.js) reads each pi
// terminal's session file and supplies the status here: pi terminals sit at desks and work like any
// other agent, and a spinning bar over their heads shows how long each turn has been running.
function piAgents(real) {
  const seen = new Set(real.map((a) => a.address));
  const out = [];
  for (const r of shared("office.piwork") ?? []) {
    if (seen.has(r.address)) continue;
    const p = panes().find((q) => q.terminal === r.address);
    if (!p) continue; // no pane: a sub-agent terminal, shown as an intern instead
    const sp = spaces().find((s) => s.tabs?.some((t) => t.id === p.tab)) ?? null;
    const tab = sp?.tabs?.find((t) => t.id === p.tab);
    out.push({
      address: r.address, pane: p.pane, space: sp?.id ?? null, space_name: sp?.name ?? "~",
      tab: p.tab, tab_index: 0, tab_name: tab?.name ?? null,
      status: r.status === "working" ? "working" : "idle", app: "pi",
      program: { key: "pi", name: "pi", icon: "icons/pi.svg", tint: true, tile: null, color: null, shell: false, agent: true },
      title: r.title || r.first || p.title || "pi", seq: 0, pinned: false, focused: Boolean(p.focused),
    });
  }
  return out;
}
const OC_SQL = `select s.title, s.directory, m.time_updated as upd, json_extract(m.data,'$.role') as role, json_extract(m.data,'$.time.completed') as comp
  from session s join message m on m.id=(select id from message where session_id=s.id order by time_created desc limit 1)
  where s.parent_id is null and s.time_updated > (strftime('%s','now')-172800)*1000 order by m.time_updated desc;`;
const OC_WORKING_MS = 120_000;
function opencodeAgents(real, rows) {
  const known = new Set(real.map((a) => a.address));
  const out = [];
  for (const k of terminals()) {
    if (known.has(k.address) || k.state !== "live") continue;
    if (!(k.program?.key === "opencode" || (k.argv ?? []).some((x) => /(^|\/)opencode$/.test(String(x))))) continue;
    const pane = panes().find((p) => p.terminal === k.address) ?? null;
    const sp = pane ? spaces().find((x) => x.id === pane.space) : null;
    const shown = String(k.labels?.["loft.shown"] ?? "").replace(/^OC \| /, "").replace(/\u2026$/, "").trim();
    const cwd = k.cwd ?? k.last_cwd ?? null;
    const row = (rows ?? []).find((r) => shown && r.title.startsWith(shown)) ?? (rows ?? []).find((r) => r.directory === cwd) ?? null;
    const working = Boolean(row) && row.role === "assistant" && !row.comp && Date.now() - Number(row.upd) < OC_WORKING_MS;
    out.push({
      address: k.address, pane: pane?.id ?? null, space: pane?.space ?? null, space_name: sp?.name ?? "This Mac",
      tab: pane?.tab ?? null, tab_index: 0, tab_name: null, status: working ? "working" : "idle", app: "opencode",
      program: { key: "opencode", name: "OpenCode", icon: null, tint: false, tile: null, color: null, shell: false, agent: true },
      title: row?.title ?? shown ?? "OpenCode", seq: 0, pinned: false, focused: false,
    });
  }
  return out;
}
// At a desk you sit and type unless there's news: done and blocked stand up.
const sits = (status) => status !== "done" && status !== "blocked";
const mugOf = (a) => {
  const names = `${a?.program?.key ?? ""} ${a?.app ?? ""}`;
  return Object.entries(A.MUGS).find(([k]) => names.includes(k))?.[1] ?? "t-mug";
};
// Live sub-agents under `addr`, however deep.
const descendants = (all, addr) =>
  all.filter((k) => k.parent === addr && k.state === "live").flatMap((k) => [k, ...descendants(all, k.address)]);

export default class Office extends View {
  init(_props, cx) {
    this.size = { width: 1400, height: 250 };
    this.desk = {}; // address -> desk index, kept while the agent lives
    this.ocRows = [];
    const probe = () => cx.spawn(async (cx) => {
      try {
        const r = await exec("sqlite3", ["-readonly", "-cmd", ".timeout 1500", "-json", `${home()}/.local/share/opencode/opencode.db`, OC_SQL], { timeout: 4000 });
        const rows = r.code === 0 && r.stdout.trim() ? JSON.parse(r.stdout) : [];
        if (JSON.stringify(rows) !== JSON.stringify(this.ocRows)) { this.ocRows = rows; cx.notify(); }
      } catch { /* no OpenCode here: keep the last look */ }
    });
    probe();
    cx.timer.every(3000, () => probe());
    // Local patch: pi reports no status to Herdr, so a worker reads its session files and puts
    // a spinning bar over each working one in the strip's top band.
    this.piwork = new PiWork(cx);
    cx.timer.every(2500, () => this.piwork.tick());
    this.who = {}; // address -> which coworker they are, kept while the agent lives
    this.at = {}; // walker -> { spot, x, y, fromX, until, dur, face }
    this.seen = {}; // address -> what we knew last render: { status, who }
    this.idleSince = {};
    this.blockedSince = {};
    this.finishes = []; // when agents finished, for the pizza
    this.party = null; // { start }
    this.leaving = {}; // address -> who: closed agents on their way out
    this.kids = {}; // intern address -> { x, y, name } where it sat last render
    this.grads = {}; // intern address -> { x, y, name, start }
    this.away = [];
    this.hovered = null;
    this.weather = null;
    this.started = false;
    this.cat = { goal: "sit", desk: null, since: Date.now() };
    this.now = new Date();
    cx.timer.every(30000, (cx) => { this.now = new Date(); cx.notify(); });
    cx.timer.every(9000, (cx) => { if (this.wanderCat()) cx.notify(); });
    if (WEATHER) {
      this.refreshWeather(cx);
      cx.timer.every(30 * 60 * 1000, (cx) => this.refreshWeather(cx));
    }
  }

  refreshWeather(cx) {
    cx.spawn(async (cx) => {
      try {
        if (!this.where) {
          const r = await fetch("https://ipapi.co/json/");
          const j = await r.json();
          if (typeof j.latitude === "number") this.where = { lat: j.latitude.toFixed(1), lon: j.longitude.toFixed(1) };
        }
        if (!this.where) return;
        const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${this.where.lat}&longitude=${this.where.lon}&current=weather_code`);
        const j = await r.json();
        this.weather = weatherKind(j.current?.weather_code ?? 0);
        cx.notify();
      } catch {}
    });
  }

  // Desks are handed out once, lowest free first, so nobody swaps seats. Agents that
  // closed head for the door with a box.
  seat(list, door, cx) {
    const live = new Set(list.map((a) => a.address));
    for (const k of Object.keys(this.desk)) {
      if (live.has(k)) continue;
      const at = this.at[k];
      if (this.started && at && this.seen[k]) {
        this.leaving[k] = this.seen[k].who;
        this.walk(`leave:${k}`, "door", door.x, door.y, WALK_SPEED, cx, at);
      }
      delete this.desk[k]; delete this.at[k]; delete this.idleSince[k]; delete this.blockedSince[k]; delete this.seen[k];
    }
    const taken = new Set(Object.values(this.desk));
    for (const a of list) {
      if (a.address in this.desk) continue;
      let i = 0;
      while (taken.has(i)) i++;
      this.desk[a.address] = i;
      taken.add(i);
    }
  }

  // Who each agent is: picked from the cast by their terminal address, moving on to the
  // next coworker when that one is already in today.
  cast(list) {
    const live = new Set(list.map((a) => a.address));
    for (const k of Object.keys(this.who)) if (!live.has(k)) delete this.who[k];
    const taken = new Set(Object.values(this.who));
    for (const a of list) {
      if (this.who[a.address]) continue;
      let i = A.hashOf(a.address) % A.CAST.length;
      for (let n = 0; n < A.CAST.length && taken.has(A.CAST[i]); n++) i = (i + 1) % A.CAST.length;
      this.who[a.address] = A.CAST[i];
      taken.add(A.CAST[i]);
    }
  }

  // Since-when for idle and blocked, and finishes for the pizza.
  track(list, now, cx) {
    const changed = {};
    for (const s of spaces()) for (const t of s.tabs ?? []) changed[t.id] = t.changed_at;
    for (const a of list) {
      const was = this.seen[a.address]?.status;
      if (a.status !== "idle") delete this.idleSince[a.address];
      else this.idleSince[a.address] ??= changed[a.tab] ?? now;
      if (a.status !== "blocked") delete this.blockedSince[a.address];
      else this.blockedSince[a.address] ??= was === "blocked" || !was ? (changed[a.tab] ?? now) : now;
      if (this.started && a.status === "done" && was && was !== "done") this.finishes.push(now);
      this.seen[a.address] = { status: a.status, who: this.who[a.address] };
    }
    this.finishes = this.finishes.filter((t) => now - t < PARTY_WINDOW);
    if (!this.party && this.finishes.length >= PARTY_FINISHES) {
      this.party = { start: now };
      this.finishes = [];
      cx.timer.after(PARTY_LENGTH + 50, (cx) => { this.party = null; cx.notify(); });
    }
  }

  // Starts a walk when a walker's spot changes; returns where it is (or is heading).
  // `start`: where a new walker appears (the door), instead of at its spot.
  walk(key, spot, x, y, speed, cx, start) {
    const now = Date.now();
    const fresh = !this.at[key] && Boolean(start);
    const at = this.at[key] ?? (start ? { ...start, spot: null } : null);
    if (!at) return (this.at[key] = { spot, x, y, fromX: x, until: 0, dur: 1 });
    if (at.spot === spot && at.x === x && at.y === y) return at;
    const dur = Math.max(400, Math.hypot(x - at.x, y - at.y) / speed);
    this.at[key] = { spot, x, y, fromX: at.x, until: now + dur, dur, face: at.face };
    if (spot === "door" || fresh) this.doorUntil = Math.max(this.doorUntil ?? 0, now + dur);
    cx.timer.after(dur + 30, (cx) => cx.notify());
    return this.at[key];
  }

  // Where everything stands. The room is laid out left to right and centered; when the
  // strip is too narrow for all of it, the extras by the door and the couch go first.
  geometry(W, H, deskCount, rows = 1) {
    // Local patch (open-plan floor, no wall, no door): two zones side by side. Work: the desks in 1-3 rows going
    // back into the room. Lounge, two deep: the chalkboard, counter and cooler at the back; the couch, lamp and cat
    // tree in front. People come and go from off the left edge.
    const P = A.P, S = A.S;
    const floorY = H - 26;
    const slot = A.SLOT * P;
    // Rows spread over the floor's depth: as far apart as fits (26-40 sprite px), the back row fully in the strip.
    // up to 60 sprite px apart, so the rows fill the strip up to the top edge
    const rowGap = rows > 1 ? Math.max(26 * S, Math.min(60 * S, (floorY - 74 * S) / (rows - 1))) : 0;
    const perRow = Math.ceil(deskCount / rows);
    const backFloor = floorY - (rows - 1) * rowGap;
    const wallBottom = Math.max(9 * P + 48, Math.round(H * 0.4)); // the back line
    // The lounge's back line sits as high as the chalkboard allows, so the lounge fills the top too.
    const loungeY = Math.min(floorY - 30 * S, Math.max(D.CHALK_H + 6, Math.round(H * 0.45)));
    const frontY = floorY - 2 * S;
    const w = (n) => A.w(n);
    const back = [["board", D.CHALK_W, 14], ["counter", w("counter"), 16], ["cooler", w("cooler"), 0]];
    let front = [["couch", w("couch-lavender"), 12], ["lamp", w("floorlamp"), 12], ["tree", w("cattree"), 0]];
    const lineW = (items) => items.reduce((n, [, iw, gap], k) => n + iw + (k < items.length - 1 ? gap * S : 0), 0);
    const loungeW = () => Math.max(lineW(back), lineW(front) + 24 * S);
    const across = perRow + (rows > 1 ? 0.5 : 0);
    const sides = w("fig") + 12 * S + 28 * S + 12 * S + w("monstera");
    // The desks take (columns - 1) gaps plus one desk; the half-slot offset of alternate rows adds half a gap.
    const steps = perRow - 1 + (rows > 1 ? 0.5 : 0);
    const total = (unit) => sides + steps * unit + slot + loungeW();
    // Too narrow: the lamp goes, then the cat tree.
    for (const drop of ["lamp", "tree"]) if (total(slot) > W - 24) front = front.filter(([k]) => k !== drop);
    // Spare width goes between the desks (up to 3/4 of a slot more each), the rest to furniture at the sides.
    const roomy = steps > 0 ? slot + Math.min(slot * 0.75, Math.max(0, W - 24 - total(slot)) / steps) : slot;
    const at = {};
    let x = Math.max(12, Math.round((W - total(roomy)) / 2));
    const start = x;
    at.plantL = x; x += w("fig") + 12 * S;
    at.desks = x; x += steps * roomy + slot + 28 * S;
    const lx = x;
    let bx = lx;
    for (const [k, iw, gap] of back) { at[k] = bx; bx += iw + gap * S; }
    let fx = lx + loungeW() - lineW(front); // the front line ends where the lounge ends
    for (const [k, iw, gap] of front) { at[k] = fx; fx += iw + gap * S; }
    x = lx + loungeW() + 12 * S;
    at.plantR = x; x += w("monstera");
    const x0 = at.desks;
    const deskPos = (i) => {
      const r = Math.min(rows - 1, Math.floor(i / perRow)), c = i - r * perRow;
      return { x: x0 + c * roomy + (r % 2 ? roomy / 2 : 0), y: floorY - r * rowGap, back: r > 0, row: r };
    };
    const wallBase = wallBottom + 2 * P;
    // The back row of desks may go further back than the lounge, as long as its monitors stay in the strip.
    const fits = x <= W - 12 && backFloor - 74 * S >= -2 * S;
    return {
      P, S, floorY, wallBottom, wallBase, loungeY, frontY, rows, slot, roomy, across, x0, deskPos, at, fits,
      // How much of the strip the room fills, to pick the arrangement that leaves the least empty floor.
      fill: Math.min((x - start) / W, (H - Math.min(backFloor - 74 * S, loungeY - 70 * S)) / H),
      rowGap, perRow, steps,
      zoneX: at.counter, coolerX: at.cooler, couchX: at.couch, doorX: 0, start, end: x,
      door: { x: -30 * S, y: loungeY }, // off the left edge: where people come in and leave
    };
  }



  // Picks the cat's next stop: a nap on an empty desk, or a sit somewhere on the floor.
  wanderCat() {
    const g = this.g;
    if (!g) return false;
    const c = this.cat;
    if (c.goal === "sleep" && this.away.includes(c.desk) && Date.now() - c.since < 60000) return false;
    if (this.away.length && Math.random() < 0.45) {
      this.cat = { goal: "sleep", desk: this.away[Math.floor(Math.random() * this.away.length)], since: Date.now() };
    } else {
      const span = g.couchX + A.w("couch-lavender") - g.x0;
      this.cat = { goal: "sit", desk: null, x: Math.round(g.x0 + Math.random() * span), since: Date.now() };
    }
    return true;
  }

  render(cx) {
    // Local patch (top bar redesign): the floating bars sit in a band at the top; the scene lives below it.
    const TOP = 46;
    // Local patch: while the strip slides, the room keeps its open height and is clipped (no art resizing), and fades with it.
    const open = Number(shared("office.full")) || 220;
    const shownH = this.size.height;
    const roomH = shownH < open && shownH > 70 ? open : shownH;
    const fade = shownH >= open ? 1 : Math.max(0, Math.min(1, (shownH - 70) / Math.max(1, open - 70)));
    const { width: W } = this.size, H = Math.max(120, roomH - TOP);
    const real = agents();
    const list = [...real, ...piAgents(real), ...opencodeAgents(real, this.ocRows), ...outsideAgents()];
    // Agents on other machines are working from home: they're on the video call, not in a chair.
    const here = list.filter((a) => !remote(a.address));
    const all = terminals();
    const now = Date.now();
    setAgentOrder(real.map((a) => a.address));
    // Local patch: folded down to the bar, the strip shows no office at all, only a plain bar for the floating buttons.
    if (this.size.height <= 70) {
      return div().id("office").size_full().bg(theme().chrome)
        .on_size_change((size, cx) => { this.size = size; cx.notify(); });
    }

    // Whole sprite pixels where the strip allows: 2px each by default, 3px when it's tall.
    const deskCount = Math.max(MIN_DESKS, here.length, ...Object.values(this.desk).map((i) => i + 1));
    // Local patch: the strip doesn't scroll, so the art shrinks a step at a time until the whole room fits the width.
    const tall = H < 210 ? 3 : H < 330 ? 4 : 6;
    let g;
    // Local patch: the biggest art that fits; at that size, the number of desk rows (1-3) that fills the strip best.
    let best = null;
    for (const p of [tall, 4, 3, 2].filter((p, i) => i === 0 || p < tall)) {
      A.setScale(p);
      for (let rows = 1; rows <= Math.min(3, deskCount); rows++) {
        const c = this.geometry(W, H, deskCount, rows);
        if (c.fits && (!best || c.fill > best.fill)) best = { p, rows, fill: c.fill };
      }
      if (best) break;
    }
    best ??= { p: 2, rows: 3 };
    A.setScale(best.p);
    g = this.geometry(W, H, deskCount, best.rows);
    this.g = g;
    this.seat(here, g.door, cx);
    this.cast(list);
    this.track(list, now, cx);
    const S = g.S;
    const byDesk = {};
    for (const a of here) byDesk[this.desk[a.address]] = a;
    const tabs = {};
    for (const s of spaces()) for (const t of s.tabs ?? []) tabs[t.id] = t;
    const branches = {};
    for (const p of panes()) branches[p.pane] = p.branch;

    // The pizza: the courier walks in, leaves it on the counter, and walks out.
    const party = this.party;
    const counter = { x: g.zoneX - 10 * S, y: g.loungeY + 6 * S };
    const courierTrip = party ? Math.max(400, Math.hypot(counter.x - g.door.x, counter.y - g.door.y) / WALK_SPEED) : 0;
    const pizzaHere = party && now >= party.start + courierTrip;

    // Where everyone goes. Long idlers take the couch while there's room; the rest
    // gather around the cooler (or the pizza), alternating sides, further out each pair.
    const idle = here.filter((a) => a.status === "idle").sort((a, b) => this.idleSince[a.address] - this.idleSince[b.address]);
    const nappers = pizzaHere ? [] : idle.filter((a) => now - this.idleSince[a.address] > NAP_AFTER).slice(0, COUCH_SEATS);
    const chatters = idle.filter((a) => !nappers.includes(a));
    const place = {};
    nappers.forEach((a, k) => { place[a.address] = { spot: "couch", x: g.couchX + (17 + k * 26) * S, y: g.frontY - 8 * S, face: 1 }; });
    const hub = pizzaHere ? { left: g.zoneX - 12 * S, right: g.zoneX + A.w("counter") + 12 * S }
      : { left: g.coolerX - 13 * S, right: g.coolerX + A.w("cooler") + 13 * S };
    chatters.forEach((a, k) => {
      const left = k % 2 === 0;
      const ring = Math.floor(k / 2) * 20 * S;
      place[a.address] = { spot: pizzaHere ? "pizza" : "cooler", x: left ? hub.left - ring : hub.right + ring, y: g.loungeY + 4 * S, face: left ? 1 : -1 };
    });
    // At a desk you're in the chair beside it.
    for (const a of here) {
      const d = g.deskPos(this.desk[a.address]);
      place[a.address] ??= { spot: "desk", x: d.x + A.CHAIR.seat * S, y: d.y, face: 1 };
    }
    this.away = here.filter((a) => place[a.address].spot !== "desk").map((a) => this.desk[a.address]);
    if (this.cat.goal === "sleep" && !this.away.includes(this.cat.desk)) this.wanderCat();

    const alarmed = here.filter((a) => a.status === "blocked" && now - (this.blockedSince[a.address] ?? now) > ALARM_AFTER);
    const people = here.map((a) => {
      const p = place[a.address];
      const start = this.started ? g.door : null;
      const at = this.walk(a.address, p.spot, p.x, p.y, WALK_SPEED, cx, start);
      const seated = at.spot === "desk" && now >= at.until;
      return {
        y: at.y, back: g.deskPos(this.desk[a.address]).back, row: g.deskPos(this.desk[a.address]).row, seated, desk: this.desk[a.address],
        sitting: seated && sits(a.status),
        el: this.person(a, at, g, p.face, tabs[a.tab], alarmed.includes(a)),
      };
    });
    const sitting = new Set(people.filter((p) => p.sitting).map((p) => p.desk));
    const desks = Array.from({ length: deskCount }, (_, i) => {
      const pos = g.deskPos(i);
      const a = byDesk[i];
      const plate = a ? this.plate(a).absolute().left(pos.x + A.DESK.x * S).top(pos.y + 6) : null;
      return { back: pos.back, row: pos.row, plate, chair: this.chair(i, pos, g), el: this.deskAt(i, pos, g, a, a && tabs[a.tab], a && branches[a.pane], sitting.has(i)) };
    });
    // A row of desks, back to front: chairs, whoever is at them, then the desks themselves.
    const row = (r) => [
      ...desks.filter((d) => d.row === r).map((d) => d.chair),
      ...people.filter((p) => p.seated && p.row === r).map((p) => p.el),
      ...desks.filter((d) => d.row === r).map((d) => d.el),
    ];
    const rowsBackToFront = Array.from({ length: g.rows }, (_, k) => g.rows - 1 - k);

    const hour = this.now.getHours();
    const dark = lightsDown(hour);
    const when = season(this.now);
    const hovered = here.find((a) => a.address === this.hovered);
    this.started = true;

    return div().id("office").size_full().relative().overflow_hidden().bg("#dcae7e").opacity(fade)
      .on_size_change((size, cx) => { this.size = size; cx.notify(); })
      // the band under the floating bars is floor too: planks, so it doesn't read as an empty strip
      .children(this.band(W, TOP + H))
      .child(div().absolute().left(0).top(TOP).w(W).h(H).children([
        ...this.room(W, H, g, sky(hour), list, all, now, when),
        ...this.decorations(g),
        ...rowsBackToFront.flatMap(row),
        // Name plates over everything, under each desk, so a row in front never hides one.
        ...desks.map((d) => d.plate).filter(Boolean),
        ...this.lounge(g, pizzaHere, when),
        ...here.flatMap((a) => this.interns(a, descendants(all, a.address), g)),
        ...this.graduates(g, now, cx),
        ...people.filter((p) => !p.seated).sort((a, b) => a.y - b.y).map((p) => p.el),
        ...this.leavers(g, now),
        ...(party ? [this.courier(party, counter, courierTrip, g, now, cx)] : []),
        this.kitty(g, cx),
        ...(dark ? this.night(W, H, g, byDesk, deskCount, when) : []),
        ...(alarmed.length ? D.alarm(W, H, g.deskPos(this.desk[alarmed[0].address]).x + (A.DESK.x + 30) * S) : []),
        ...(hovered && this.at[hovered.address] ? [this.thought(hovered, this.at[hovered.address], g)] : []),
        ...(list.length ? [] : [this.sign(W, g)]),
      ]));
  }

  // Local patch: one continuous plank floor under the whole strip (top band + room), so rows never jump at the seam.
  // Planks get taller toward you; whole pixels only, so every seam line is crisp and the same weight.
  band(W, total) {
    const els = [div().absolute().left(0).top(0).w(W).h(total).bg("#dcae7e")];
    for (let i = 0, y = 0; y < total; i++) {
      const step = Math.min(22, Math.round(4 + i * 1.2)), next = y + step;
      els.push(div().absolute().left(0).top(next - 1).w(W).h(1).bg("#cb9c6c"));
      const span = 60 + step * 4;
      for (let x = (i % 2) * (span / 2) + 20; x < W; x += span) els.push(div().absolute().left(Math.round(x)).top(y).w(1).h(step - 1).bg("#cb9c6c"));
      y = next;
    }
    return els;
  }

  // Local patch (no wall): the whole strip is floor, seen from above. What stood against the wall stands
  // freely along the back; the counts are chalked on a green board on an easel.
  room(W, H, g, s, list, all, now, when) {
    const { S, wallBottom } = g;
    const els = []; // the floor itself is drawn once, by band()
    // The work area on a soft rug, so the desks read as one place.
    {
      const top = g.floorY - (g.rows - 1) * g.rowGap - 30 * S, left = g.x0 - 10 * S;
      const right = g.x0 + g.steps * g.roomy + g.slot + 6 * S, bottom = g.floorY + 14 * S;
      els.push(div().absolute().left(left).top(Math.max(4, top)).w(right - left).h(Math.min(H - 4, bottom) - Math.max(4, top))
        .rounded(10 * S).bg("#e6c49a").border_2().border_color("#d2a77a"));
    }
    // Either side of the room, where the strip is wide: furniture along the back.
    const base = g.wallBase + 2 * S;
    const furniture = [...WALL_FURNITURE];
    for (let x = 16; furniture.length && x + A.w(furniture[0]) < g.start - 16;) {
      const name = furniture.shift();
      els.push(D.against(name, x, base));
      x += A.w(name) + 16;
    }
    for (let x = g.end + 12; furniture.length && x + A.w(furniture[0]) < W - 8;) {
      const name = furniture.shift();
      els.push(D.against(name, x, base));
      x += A.w(name) + 16;
    }
    const remotes = list.filter((a) => remote(a.address)).map((a) => ({
      address: a.address, pane: a.pane, who: this.who[a.address], machine: a.address.split("/")[0],
      name: a.space_name, status: a.status, title: a.title || a.tab_name || a.space_name,
    }));
    if (remotes.length) els.push(D.videoWall(8, 4, 60, remotes));
    const count = (st) => list.filter((a) => a.status === st).length;
    const napping = list.filter((a) => this.at[a.address]?.spot === "couch").length;
    const interns = list.reduce((n, a) => n + descendants(all, a.address).length, 0);
    els.push(D.chalkboard(g.at.board, g.loungeY, [
      ["#9fd0ff", `WORKING  ${count("working")}`],
      ["#a8e6a1", `DONE     ${count("done")}`],
      ["#ff9a9a", `BLOCKED  ${count("blocked")}`],
      ["#efe9d8", `ON BREAK ${count("idle") - napping}`],
      ["#c9b6ff", `NAPPING  ${napping}`, napping > 0],
      ["#ffc48a", `INTERNS  ${interns}`, interns > 0],
      ["#ffb0a0", "PIZZA!!", Boolean(this.party)],
    ], clock(this.now)));
    // A robot vacuum doing laps along the back.
    const lapA = g.x0, lapB = Math.max(g.x0 + 60, g.at.board - A.w("t-roomba") - 8);
    els.push(A.still("t-roomba", lapA, wallBottom + 8 * S).loop("left", { from: lapA, to: lapB, period: Math.max(20000, (lapB - lapA) * 90), easing: "linear" }));
    return els;
  }

  // The kitchen and the couch corner, the plants, and whatever the season brought.
  // Local patch: plants, wherever the layout leaves room. Drawn on the floor, under the desks.
  decorations(g) {
    const { S, at } = g;
    const els = [];
    const backFloor = g.floorY - (g.rows - 1) * g.rowGap;
    // Taller plants behind the corner ones.
    if (g.rows > 1) els.push(A.still("palm", at.plantL - 4 * S, backFloor - 8 * S));
    els.push(A.still("lemontree", at.plantR + 8 * S, g.loungeY));
    // Plants at the rug's corners: a bonsai at the back right, a tulip at the front right.
    const rugRight = g.x0 + g.steps * g.roomy + g.slot + 6 * S;
    if (g.rows > 1) els.push(A.still("bonsai", rugRight - A.w("bonsai") + 2 * S, backFloor - 6 * S));
    els.push(A.still("pot-tulip", rugRight - A.w("pot-tulip") / 2, g.floorY + 10 * S));
    // By the chalkboard, and on the counter.
    els.push(A.still("pot-sunflower", at.board + D.CHALK_W - 4 * S, g.loungeY + 2 * S));
    els.push(A.still("t-succulent", at.counter + A.w("counter") - 16 * S, g.loungeY - A.h("counter") + 6 * S));
    return els;
  }

  lounge(g, pizzaHere, when) {
    const { S, at } = g;
    const f = g.loungeY, fr = g.frontY;
    const els = [
      A.still("rug", g.coolerX + A.w("cooler") / 2 - A.w("rug") / 2, f + 10 * S),
      A.still("counter", at.counter, f),
      ...(pizzaHere ? [A.still("pizza-open", at.counter + 15 * S, f - 26 * S)] : []),
      A.still("cooler", at.cooler, f),
      A.still("couch-lavender", at.couch, fr),
      ...(at.lamp == null ? [] : [A.still("floorlamp", at.lamp, fr)]),
      ...(at.tree == null ? [] : [A.still("cattree", at.tree, fr), A.still("t-catbowl", at.tree - 6 * S, fr + 3 * S), A.still("t-yarn", at.tree + 30 * S, fr + 4 * S)]),
      A.still("monstera", at.plantR, g.floorY),
      when === "winter" ? A.still("xmastree", at.plantL - 5 * S, g.floorY) : A.still("fig", at.plantL, g.floorY),
    ];
    if (when === "halloween") els.push(
      A.still("pumpkin", at.plantL + 14 * S, g.floorY + 4 * S), A.still("pumpkin", at.plantR - 16 * S, g.floorY + 4 * S),
      A.still("pumpkin", at.couch - 22 * S, fr + 4 * S));
    return els;
  }


  sign(W, g) {
    return div().absolute().left(W / 2 - 140).top(g.wallBottom - 34).w(280).py(4).rounded(8).bg("#5b4a5e99")
      .text_size(11).text_color("#fffaf0").flex().justify_center().child("Nobody's in yet. Start an agent and they'll show up.");
  }

  // The chair at a desk.
  chair(i, pos) {
    return A.still(A.CHAIRS[i % A.CHAIRS.length], pos.x, pos.y);
  }

  // A desk with its monitor, the bell and a toy on top of it, a keyboard and a mug, the
  // branch on a sticky note, and the nameplate of whoever sits there. When they're sitting,
  // the chair's armrest is drawn again here, over them.
  deskAt(i, pos, g, a, tab, branch, sitting) {
    const S = g.S;
    const st = a?.status;
    const away = Boolean(a) && this.at[a.address]?.spot !== "desk";
    const done = st === "done" && !away;
    const overtime = st === "working" && tab?.working_since && Date.now() - tab.working_since > MUGS_AFTER;
    const plate = null; // local patch: drawn over the rows by render()
    const floor = DESK_TOP * S; // the floor line inside this box
    const dx = A.DESK.x * S;
    const surf = floor - A.surface(i);
    const mx = dx + A.DESK.monitor * S;
    const top = surf - A.h(A.MONITORS[0]) + S; // just into the monitor's top edge
    const bellX = mx + S;
    const mug = mugOf(a);
    return div().id(`desk-${i}`).absolute().left(pos.x).top(pos.y - floor).w(A.SLOT * g.P).h(floor + 28)
      .when(Boolean(a), (el) => el.cursor_pointer().on_click(() => { if (a.pane) run("pane.focus", { pane: a.pane }); }))
      .children([
        ...(sitting ? [A.still(`${A.CHAIRS[i % A.CHAIRS.length]}-front`, 0, floor)] : []),
        A.still(A.deskOf(i), dx, floor),
        A.still(A.MONITORS[i % A.MONITORS.length], mx, surf),
        this.screen(away ? "idle" : st, away, mx, surf),
        A.still(A.TOYS[(i * 5 + 2) % A.TOYS.length], mx + 15 * S, top),
        A.still("t-bell", bellX, top).when(done, (el) => el.loop("left", { from: bellX - 1.5, to: bellX + 1.5, period: 160 })),
        A.still("t-keyboard", dx + 2 * S, surf + S),
        A.still(mug, dx + 19 * S, surf + 2 * S),
        ...(overtime ? [A.still("t-mug", dx + 27 * S, surf + 3 * S), A.still(mug, dx + 23 * S, surf - 6 * S)] : []),
        ...(branch ? [this.sticky(branch, dx + 8 * S, surf + 13 * S)] : []),
        ...(done ? [this.ding(bellX - 6 * S, top - 24 * S), ...this.confetti(a.address, floor)] : []),
        ...(plate ? [plate.absolute().left(dx).top(pos.back ? top - 16 * S - 18 : floor + 6)] : []),
      ]);
  }

  // What's on the monitor at (mx, surf): its foot's left edge and the desk surface.
  screen(st, screensaver, mx, surf) {
    const S = A.S;
    const [sx, sy, sw, sh] = A.DESK.screen;
    const el = div().absolute().left(mx + sx * S).top(surf - sy * S).w(sw * S).h(sh * S).overflow_hidden();
    if (st === "working") return el.children(CODE.map((c, k) =>
      div().absolute().left(S * (k % 2 === 0 ? 2 : 4)).top(S * (1.5 + 3 * k)).h(S * 1.5).rounded(S).bg(c)
        .loop("width", { from: 2 * S, to: S * (17 - (k % 2) * 4), period: 700 + k * 260, easing: "linear" })));
    if (st === "blocked") return el.bg("#5a2233").flex().items_center().justify_center().text_size(7 * S).font_bold().text_color("#ff8a8a")
      .child("!").loop("opacity", { from: 0.4, to: 1, period: 700 });
    if (st === "done") return el.bg("#1f4a36").flex().items_center().justify_center().text_size(6.5 * S).font_bold().text_color("#8af0a8").child("✓");
    return el.when(screensaver, (e) => e.child(div().absolute().top(S * 6).size(S * 2).rounded_full().bg("#7fb8f0")
      .loop("left", { from: S * 2, to: S * 19, period: 5000 })));
  }

  sticky(branch, left, top) {
    const S = A.S;
    return div().absolute().left(left).top(top).w(24 * S).h(8 * S).px(2).bg("#fff3a8").rounded(2)
      .border_1().border_color("#ecd36a").flex().items_center().overflow_hidden()
      .text_size(7).text_color("#6b5a1e").child(div().truncate().child(branch));
  }

  ding(left, top) {
    return div().absolute().left(left).top(top).text_size(10).font_bold().text_color("#d99a1e")
      .child("ding!").loop("opacity", { from: 0, to: 1, period: 640 });
  }

  // Paper falling over the desk, for as long as the news is unread.
  confetti(seed, floor) {
    const S = A.S;
    let h = 0;
    for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return Array.from({ length: 16 }, (_, k) => {
      const r = ((h >>> (k % 24)) ^ Math.imul(k + 1, 2654435761)) >>> 0;
      const x = (10 + (r % 70)) * S;
      return div().absolute().left(x).w(2 * S).h(k % 3 === 0 ? 4 * S : 2 * S).rounded(S / 2).bg(CONFETTI[k % CONFETTI.length])
        .loop("top", { from: floor - 76 * S - (k % 5) * 8, to: floor - 2 * S, period: 1100 + ((r >>> 3) % 900), easing: "linear" })
        .loop("left", { from: x - 4, to: x + 4, period: 500 + ((r >>> 5) % 400) });
    });
  }

  spaceTile(id) {
    const icon = (shared("space.icons") ?? {})[id];
    const c = (shared("space.colors") ?? {})[id] ?? "ansi6";
    const fill = c.startsWith("#") ? c : MARK[c] ?? "#22a99a";
    return div().size(12).flex_none().rounded(3).bg(fill).flex().items_center().justify_center().text_size(8).text_color("#ffffff")
      .when(Boolean(icon?.svg), (el) => el.child(svg(icon.svg).size(8)))
      .when(Boolean(icon?.text), (el) => el.child(icon.text));
  }

  plate(a) {
    const focused = a.focused;
    return div().max_w((A.SLOT - 8) * A.P).h(16).px(5).gap(4).rounded(8).flex().items_center()
      .bg(focused ? "#fff6dd" : "#5b4a5e99").text_size(10).text_color(focused ? "#5b4a5e" : "#fffaf0")
      .child(div().size(6).flex_none().rounded_full().bg(STATUS[a.status] ?? STATUS.idle))
      .child(a.outside ? div().h(12).px(3).flex_none().rounded(3).bg(a.outside === "vscode" ? "#2f80c8" : "#7a6a8a").flex().items_center()
          .text_size(8).text_color("#ffffff").child(a.outside === "vscode" ? "VS" : "ext") : this.spaceTile(a.space))
      .when(remote(a.address), (el) => el.child(div().flex_none().text_size(9).text_color("#fffaf0").child("🎧")))
      .child(div().truncate().child(nameFor(a)));
  }

  // One intern in its box: an animal in a necktie, with whatever it's wearing or holding.
  intern(name, face, extra = []) {
    const S = A.S;
    const key = face < 0 ? `${name}-l` : name;
    return [A.still(key, (INTERN_W * S - A.w(name)) / 2, INTERN_H * S), ...extra];
  }

  // Sub-agents: small animals on stools in front of their parent's desk, laptops out.
  interns(a, kids, g) {
    if (!kids.length) return [];
    const S = g.S;
    const pos = g.deskPos(this.desk[a.address]);
    const x0 = pos.x + (A.DESK.x + 8) * S;
    const seat = (INTERN_H - 9) * S; // sitting on the stool
    const shown = kids.slice(0, 3);
    const els = shown.map((k, i) => {
      const name = A.internOf(k.address);
      const x = x0 + i * 13 * S;
      this.kids[k.address] = { x, y: pos.y, name };
      const busy = k.status === "working";
      const stuck = k.status === "blocked" || k.status === "error";
      const top = seat - A.h(name);
      return div().id(`intern-${k.address}`).absolute().left(x).top(pos.y + 3 * S - INTERN_H * S).w(INTERN_W * S).h(INTERN_H * S)
        .cursor_pointer().on_click(() => run("terminal.peek", { terminal: k.address }))
        .children([
          A.still("t-stool", (INTERN_W * S - A.w("t-stool")) / 2, INTERN_H * S),
          A.still(`${name}-l`, (INTERN_W * S - A.w(name)) / 2, seat)
            .when(busy, (el) => el.loop("top", { from: top, to: top - 1.5, period: 260 + i * 40 })),
          ...(busy ? [A.still("t-laptop", -2 * S, seat + S)] : []),
          ...(stuck ? [this.bubble(top - 18, "#e05252", INTERN_W).child("!").loop("opacity", { from: 0.5, to: 1, period: 700 })] : []),
        ]);
    });
    if (kids.length > shown.length)
      els.push(div().absolute().left(x0 + 3 * 13 * S + 6 * S).top(pos.y - 14 * g.P).px(4).rounded(6).bg("#5b4a5e99")
        .text_size(10).text_color("#fffaf0").child(`+${kids.length - shown.length}`));
    return els;
  }

  // Interns that finished: a bow in a graduation cap where they sat, then a hop out the door.
  graduates(g, now, cx) {
    const S = g.S;
    const live = new Set(terminals().filter((t) => t.state === "live").map((t) => t.address));
    for (const [k, info] of Object.entries(this.kids)) {
      if (live.has(k)) continue;
      delete this.kids[k];
      if (!this.started) continue;
      this.grads[k] = { ...info, start: now };
      cx.timer.after(GRAD_BOW + 20, (cx) => cx.notify());
    }
    return Object.entries(this.grads).flatMap(([k, gr]) => {
      const box = (x, y) => div().id(`grad-${k}`).absolute().left(x).top(y - INTERN_H * S).w(INTERN_W * S).h(INTERN_H * S);
      const cap = A.still("t-gradcap", (INTERN_W * S - A.w("t-gradcap")) / 2, INTERN_H * S - A.h(gr.name) + 5 * S);
      if (now < gr.start + GRAD_BOW) {
        return [box(gr.x, gr.y + 3 * S)
          .child(div().absolute().size_full().children(this.intern(gr.name, -1, [cap])).loop("top", { from: 0, to: 2 * S, period: 900 }))
          .child(this.bubble(INTERN_H * S - A.h(gr.name) - 26, "#5b4a5e", INTERN_W).child("🎓 thx!"))];
      }
      const at = this.walk(`grad:${k}`, "door", g.door.x - (INTERN_W / 2) * S, g.door.y, WALK_SPEED, cx, { x: gr.x, y: gr.y });
      if (now >= at.until && at.until > 0) { delete this.grads[k]; delete this.at[`grad:${k}`]; return []; }
      return [box(at.x, at.y)
        .transition("left", { duration: at.dur, easing: "ease-in-out" }).transition("top", { duration: at.dur, easing: "ease-in-out" })
        .child(div().absolute().size_full().children(this.intern(gr.name, Math.sign(at.x - at.fromX) || -1, [cap]))
          .loop("top", { from: 0, to: -3 * S, period: 240 }))];
    });
  }

  // A person-sized box with its feet at (x, y), for anyone who walks.
  walkerBox(id, at) {
    const S = A.S;
    return div().id(id).absolute().left(at.x - (A.BOX_W / 2) * S).top(at.y - A.BOX_H * S).w(A.BOX_W * S).h(A.BOX_H * S)
      .transition("left", { duration: at.dur, easing: "ease-in-out" })
      .transition("top", { duration: at.dur, easing: "ease-in-out" });
  }

  // Something carried in front of the chest, on the side they're facing.
  carried(name, face) {
    const S = A.S;
    const mid = (A.BOX_W / 2) * S;
    return A.still(name, face > 0 ? mid + 3 * S : mid - 3 * S - A.w(name), (A.BOX_H - 10) * S);
  }

  // Closed agents carrying their box out.
  leavers(g, now) {
    return Object.entries(this.leaving).flatMap(([k, who]) => {
      const at = this.at[`leave:${k}`];
      if (!at || now >= at.until) { delete this.leaving[k]; delete this.at[`leave:${k}`]; return []; }
      const face = Math.sign(at.x - at.fromX) || -1;
      return [this.walkerBox(`leave-${k}`, at).children([A.actor(who, face < 0 ? "walk-l" : "walk"), this.carried("t-plantbox", face)])];
    });
  }

  courier(party, counter, trip, g, now, cx) {
    const stay = 2500;
    const leaving = now >= party.start + trip + stay;
    if (now >= party.start + 2 * trip + stay + 100) return div();
    if (!leaving) cx.timer.after(party.start + trip + stay - now + 20, (cx) => cx.notify());
    const goal = leaving ? g.door : counter;
    const at = this.walk("courier", leaving ? "door" : "counter", goal.x, goal.y, WALK_SPEED, cx, g.door);
    const walking = now < at.until;
    const face = walking ? Math.sign(at.x - at.fromX) || 1 : 1;
    return this.walkerBox("courier", at)
      .child(A.actor(A.SIZE[`p-${COURIER}`] ? COURIER : A.CAST[0], walking ? (face < 0 ? "walk-l" : "walk") : "stand"))
      .when(!leaving, (el) => el.child(this.carried("t-pizzabox", face)))
      .when(!walking, (el) => el.child(this.bubble((A.BOX_H - A.HEAD) * A.S - 20, "#e8604f").child("pizza! 🍕")));
  }

  person(a, at, g, placeFace, tab, alarmed) {
    const S = g.S;
    const who = this.who[a.address];
    const napping = at.spot === "couch";
    const walking = Date.now() < at.until;
    const face = walking ? Math.sign(at.x - at.fromX) || 1 : placeFace;
    at.face = face;
    const st = a.status;
    const side = face < 0 ? "-l" : "";
    const chatting = at.spot === "cooler" || at.spot === "pizza";
    const doing = walking ? `walk${side}` : chatting ? `drink${side}` : napping ? "nap"
      : st === "done" ? "cheer" : st === "blocked" ? "help" : sits(st) ? "type" : "help";
    // Typing is a seated pose: up on the chair's seat, feet dangling.
    const lift = doing === "type" ? A.CHAIR.rise * S : 0;
    let body = A.actor(who, doing);
    if (lift) body = div().absolute().left(0).top(-lift).size_full().child(body);
    if (alarmed && !walking) body = div().absolute().size_full().child(body).loop("top", { from: 0, to: -2 * S, period: 300 });
    const sweaty = doing === "type" && tab?.working_since && Date.now() - tab.working_since > SWEAT_AFTER;
    const sweat = sweaty ? [0, 1].map((k) => div().absolute().left((A.BOX_W / 2 + (k ? 9 : -12)) * S).w(2 * S).h(3 * S).rounded(2 * S).bg("#8fd0f5")
      .loop("top", { from: (A.BOX_H - 46 + k * 2) * S - lift, to: (A.BOX_H - 36 + k * 2) * S - lift, period: 900 + k * 300, easing: "ease-in" })) : [];

    const pal = A.hashOf(a.address);
    const top = (A.BOX_H - A.HEAD) * S - 20 - lift;
    at.lift = lift;
    let bubble = null;
    if (walking) bubble = null;
    else if (at.spot === "pizza") bubble = this.bubble(top, "#e8604f").frames(rotate(PIZZA_CHAT, pal % PIZZA_CHAT.length), 1800 + (pal % 900));
    else if (at.spot === "cooler") bubble = this.bubble(top, "#5b4a5e").frames(rotate(CHAT, pal % CHAT.length), 2200 + (pal % 1500));
    else if (napping) bubble = this.bubble(top, "#8b78d6").frames(["z", "zZ", "zZz", "zZ"], 900);
    else if (alarmed) bubble = this.bubble(top, "#e05252").child("HELP!!").loop("opacity", { from: 0.5, to: 1, period: 400 });
    else if (st === "blocked") bubble = this.bubble(top, "#e05252").child("!").loop("opacity", { from: 0.5, to: 1, period: 700 });
    else if (st === "done") bubble = this.bubble(top - 4 * S, "#2f9a50").child("✓");

    // Local patch (pi worker): a spinning bar over a working agent's head, attached to the
    // worker, showing how long the current turn has been running. Other agents' turn start is
    // Herdr's (the tab's working_since); pi's is the pi worker's (pi reports no status, so
    // piwork.js reads the session file).
    const piRow = a.app === "pi" ? (shared("office.piwork") ?? []).find((r) => r.address === a.address) : null;
    const since = st === "working" ? (tab?.working_since ?? piRow?.since ?? null) : null;
    const bar = !walking && since ? this.turnBar(since, top - 13) : null;

    return this.walkerBox(`person-${a.address}`, at)
      .cursor_pointer().on_click(() => { if (a.pane) run("pane.focus", { pane: a.pane }); })
      .on_hover((h, cx) => {
        if (h) this.hovered = a.address;
        else if (this.hovered === a.address) this.hovered = null;
        cx.notify();
      })
      .children([body, ...sweat, ...(bubble ? [bubble] : []), ...(bar ? [bar] : [])]);
  }

  // The spinning bar: a breathing dot, a fill that sweeps, and the turn's age. On battery the
  // motion holds still, as the rest of the office does.
  turnBar(since, top) {
    const quiet = shared("loft.battery") === true;
    const secs = Math.max(0, Math.floor((Date.now() - since) / 1000));
    const when = secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
    const w = 58;
    return div().absolute().left((A.BOX_W * A.S) / 2 - w / 2).top(top).w(w).h(12).rounded(6)
      .bg("#5b4a5e99").border_1().border_color("#ffffff55")
      .child(div().absolute().left(3).top(3).w(6).h(6).rounded_full().bg("#3d8be0")
        .when(!quiet, (d) => d.loop("opacity", { from: 0.35, to: 1, period: 1200 })))
      .child(div().absolute().left(12).top(5).w(20).h(2).rounded(1).bg("#8b78d6").overflow_hidden()
        .child(div().absolute().top(0).w(10).h(2).rounded(1).bg("#b9aef0")
          .when(!quiet, (d) => d.loop("left", { from: -10, to: 20, period: 1400, easing: "linear" }))))
      .child(div().absolute().left(34).top(2).text_size(8).font_bold().text_color("#fffaf0").child(when));
  }

  // What they're working on, in a thought cloud over their head.
  thought(a, at, g) {
    const text = (nameFor(a) || "thinking…").replace(/\s+/g, " ").trim();
    const x = at.x;
    const y = at.y - A.HEAD * g.S - (at.lift ?? 0);
    return div().absolute().left(Math.max(4, x - 20)).top(Math.max(2, y - 46))
      .child(div().max_w(260).px(8).py(4).rounded(10).bg("#ffffff").border_1().border_color("#5b4a5e")
        .text_size(10).text_color("#5b4a5e").child(div().truncate().child(`💭 ${text}`)))
      .child(div().absolute().left(16).top(26).size(7).rounded_full().bg("#ffffff").border_1().border_color("#5b4a5e"))
      .child(div().absolute().left(22).top(35).size(4).rounded_full().bg("#ffffff").border_1().border_color("#5b4a5e"));
  }

  kitty(g, cx) {
    const S = g.S;
    const c = this.cat;
    const onDesk = c.goal === "sleep";
    const pos = onDesk ? g.deskPos(c.desk) : null;
    const x = onDesk ? pos.x + (A.DESK.x + 16) * S : (c.x ?? g.couchX - 20 * S);
    const y = onDesk ? pos.y - A.surface(c.desk) + 4 * S : g.floorY + 2 * S;
    const at = this.walk("cat", `${c.goal}-${c.desk}-${c.since}`, x, y, CAT_SPEED, cx);
    const walking = Date.now() < at.until;
    if (walking) at.face = Math.sign(at.x - at.fromX) || 1;
    const side = (at.face ?? 1) < 0 ? "-l" : "";
    return div().id("cat").absolute().left(at.x - (A.CAT_W / 2) * S).top(at.y - A.CAT_H * S).w(A.CAT_W * S).h(A.CAT_H * S)
      .transition("left", { duration: at.dur, easing: "ease-in-out" })
      .transition("top", { duration: at.dur, easing: "ease-in-out" })
      .child(A.kitty((walking ? "walk" : onDesk ? "sleep" : "sit") + side))
      .when(onDesk && !walking, (el) => el.child(div().absolute().left((A.CAT_W / 2 + 12) * S).top(0).text_size(9).font_bold()
        .text_color("#8b78d6").frames(["z", "zz", "zzz", ""], 800)));
  }

  // After dark: the room dims, the floor lamp is on, and busy screens glow.
  night(W, H, g, byDesk, deskCount, when) {
    const S = g.S;
    const [sx, sy, sw, sh] = A.DESK.screen;
    const els = [div().absolute().left(0).top(0).w(W).h(H).bg("#1c1440").opacity(0.42)];
    if (when === "winter" || when === "newyear") els.push(...D.stringLights(W, 2));
    if (g.at.lamp != null) {
      const lx = g.at.lamp + A.w("floorlamp") / 2, ly = g.frontY - A.h("floorlamp") + 8 * S;
      els.push(div().absolute().left(lx - 34 * S).top(ly - 26 * S).size(68 * S).rounded_full().bg("#ffd98a").opacity(0.16));
      els.push(div().absolute().left(lx - 18 * S).top(ly - 12 * S).size(36 * S).rounded_full().bg("#ffe2a0").opacity(0.2));
    }
    for (let i = 0; i < deskCount; i++) {
      const a = byDesk[i];
      if (!a || this.at[a.address]?.spot !== "desk" || a.status === "idle") continue;
      const pos = g.deskPos(i);
      const mx = pos.x + (A.DESK.x + A.DESK.monitor) * S;
      const surf = pos.y - A.surface(i);
      // Only a glow: anything solid here would sit on top of whoever walks past the desk.
      els.push(div().absolute().left(mx + (sx - 8) * S).top(surf - (sy + 8) * S).w((sw + 16) * S).h((sh + 16) * S).rounded(12 * S)
        .bg({ working: "#8fc0ff", blocked: "#ff8a8a", done: "#8af0a8" }[a.status] ?? "#8fc0ff").opacity(0.26));
    }
    return els;
  }

  // A speech bubble over the middle of a box `boxW` sprite px wide.
  bubble(top, color, boxW = A.BOX_W) {
    return div().absolute().left((boxW * A.S) / 2 - 4).top(top).px(5).h(16).flex().items_center().rounded(8)
      .bg("#fffdf7").border_1().border_color("#5b4a5e").text_size(10).font_bold().text_color(color).whitespace_nowrap();
  }
}
