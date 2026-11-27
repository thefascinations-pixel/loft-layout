import { localService, serviceOn } from "./platform-host.js";
import { paths } from "./platform-paths.js";
import { fileApi } from "./platform-files.js";
// Spend, by jlopezlira (https://github.com/jlopezlira/herdr-kanso). Apache-2.0.
// QuickJS runs every step under a time limit, so nothing heavy happens here.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Button, Popover, Input, InputState } from "gpui-base";
import { exec, appHome, home, theme, nextCommand, readTextFile, writeTextFile, layout, machines, shared, setShared, checking, openOverlay } from "herdr";
import { G, H, R, T, PULSE, breathe, tokens, toggleSwitch, controlInput, quietTabs, quietLink, iconButton, section, ghost } from "./ui.js";
import { PERIOD_KEY, SPEND_PERIODS, spendPeriod } from "./period.js";
import { Share } from "./share.js";
import { spendSpec, spendText } from "./spend-card.js";
import { clock, tryOr, tryOrAsync, afterMount } from "./pure.js";
import { powerOf } from "./sync-power.js";
import { Kdb } from "./kdb.js";
import { EXCHANGE_MS, SYNC_KICK, configFrom, exchangeAll, holdsOf, identityFrom, periodKeyOf, probeApi, rowFromCosts, rowsFrom, rowsText, statusFrom, statusText, syncDir, syncOn } from "./sync.js";

const MOD = "loft-spend";
const RUNTIME_FILE = `mods/${MOD}/runtime.json`;
const PRESENTER_FILE = `mods/${MOD}/presenter.mjs`;
const DATA_DIR = `data/${MOD}`;
const icon = (name) => `mods/${MOD}/icons/${name}.svg`;
const PAYLOAD_KIND = "loft-spend-costs";
const PAYLOAD_VERSION = 1;
const STEP_TIMEOUT_MS = 35_000;
const TICK_MS = 15_000;
const REFRESH_MS = 60_000;
const LIVE_REFRESH_MS = 30_000;
const LIST_ROWS = 6;
const TASK_ROWS = 8;
// Local change: the remote workspace's logs come from the au-sync mirror (~/.agent-usage). SSH keeps a Coder
// workspace awake, so it syncs only on open (at most every 5 min) and on refresh, never on the timer.
const WS_NAME = "remote"; // remote workspace mirrored by au-sync; set to yours
const AU_SYNC = ".agent-usage/bin/au-sync";
const AU_LAST = `.agent-usage/.last-sync-${WS_NAME}`;
const WS_GAP_MS = 5 * 60_000;
const WS_TIMEOUT_MS = 150_000;

function agoText(ms) {
  const m = Math.floor((Date.now() - ms) / 60_000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.floor(m / 60)} h ago` : `${Math.floor(m / 1440)} d ago`;
}

function sanitizeError(error) {
  const raw = error && typeof error === "object" ? (error.message ?? error.error ?? "") : String(error ?? "");
  const text = String(raw).replace(/\s+/g, " ").trim() || "Unknown error";
  return text.length > 300 ? `${text.slice(0, 297)}…` : text;
}

function resultError(result) {
  const text = String(result?.stderr ?? "").trim() || String(result?.stdout ?? "").trim();
  if (!text) return `The collector stopped with code ${result?.code ?? "?"}.`;
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const errorLine = lines.find((line) => /^(?:[A-Za-z][\w.]*Error|Error|error|token-spend|loft-spend):/.test(line));
  return sanitizeError(errorLine || lines.find((line) => !/^at\s/.test(line)) || text);
}

function parseRuntimeNode(raw) {
  const config = JSON.parse(raw);
  const node = typeof config?.node === "string" ? config.node.trim() : "";
  if (!node || /[\u0000-\u001f\u007f]/.test(node)) throw new Error("runtime.json needs a node path.");
  return node;
}

function projectName(value) {
  const text = String(value ?? "").replace(/[\\/]+$/, "");
  return text.split(/[\\/]/).at(-1) || text || "Unknown project";
}

/** True when this block is in the layout but off screen; Herdr keeps hidden copies (and their timers) alive. */
function hiddenInLayout() {
  try {
    const pathTo = (node) => {
      if (node?.content?.mod === MOD) return [node];
      const below = (node?.children ?? []).reduce((found, child) => found ?? pathTo(child), null);
      return below ? [node, ...below] : null;
    };
    const path = pathTo(layout());
    if (!path) return false; // a pane or overlay: shown whenever it runs
    return path.some((node, index) => node.hidden
      || (node.type === "stack" && node.active && path[index + 1] && node.active !== path[index + 1].id));
  } catch {
    return false;
  }
}

function formatTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

// ---- Local change (telemetry revamp, 2026-11-17): the console look. Backup: ~/.agent-usage/loft-patches. ----
const MONO = "Geist Mono";
const SANS = "Geist";
const CLEAR = "#00000000";
const caps = (s) => String(s ?? "").toUpperCase();
const pctOf = (r) => `${Math.max(0, Math.min(100, Math.round((Number(r) || 0) * 1000) / 10))}%`;
const rank = (i) => String(i + 1).padStart(2, "0");
const PERIOD_SHORT = { day: "TODAY", month: "MONTH", "30d": "30D", year: "YEAR", all: "ALL" };
const LEVEL_TIPS = ["No use", "Up to 15% of the busiest day", "15–35% of the busiest day", "35–60% of the busiest day", "60–85% of the busiest day", "Over 85% of the busiest day"];

function rgbOf(color) {
  const m = /^#?([0-9a-f]{6})/i.exec(String(color ?? ""));
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function mix(a, b, t) {
  const x = rgbOf(a);
  const y = rgbOf(b);
  if (!x || !y) return t < 0.5 ? a : b;
  return `#${x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, "0")).join("")}`;
}

function isDark(color) {
  const x = rgbOf(color);
  return !x || (0.2126 * x[0] + 0.7152 * x[1] + 0.0722 * x[2]) < 128;
}

/** The console palette, all from the theme: a teal-to-gold heat ramp on the canvas. */
function consoleColors(c, t) {
  const dark = isDark(c.canvas);
  const teal = t.ansi6 ?? c.accent;
  const gold = t.ansi11 ?? t.ansi3 ?? c.accent;
  const bright = t.ansi15 ?? c.text;
  const red = t.ansi9 ?? t.ansi1 ?? c.red;
  const ramp = dark
    ? [mix(c.canvas, c.text, 0.06), mix(c.canvas, teal, 0.22), mix(c.canvas, teal, 0.48), teal, gold, mix(gold, bright, 0.5)]
    : [mix(c.canvas, c.text, 0.07), mix(c.canvas, teal, 0.28), mix(c.canvas, teal, 0.58), mix(teal, c.text, 0.2), mix(teal, c.text, 0.45), mix(teal, c.text, 0.7)];
  const signal = dark ? gold : mix(t.ansi3 ?? gold, c.text, 0.35);
  return {
    dark, ramp, signal,
    ok: teal, warn: signal, over: dark ? mix(red, bright, 0.2) : red,
    card: t.surface ?? c.raised,
    meterOff: mix(c.canvas, c.text, 0.09),
    ink: (level) => (level >= 3 ? c.canvas : level > 0 ? c.text : c.dim),
  };
}

function levelFor(usd, peak) {
  if (!(usd > 0) || !(peak > 0)) return 0;
  const r = usd / peak;
  return r <= 0.15 ? 1 : r <= 0.35 ? 2 : r <= 0.6 ? 3 : r <= 0.85 ? 4 : 5;
}

function shareText(r) {
  const v = (Number(r) || 0) * 100;
  return v >= 10 ? `${Math.round(v)}%` : v >= 0.1 ? `${Math.round(v * 10) / 10}%` : v > 0 ? "<0.1%" : "0%";
}

function deltaText(note) {
  const text = String(note ?? "");
  const m = /^(\d+)% (more|less) than (.+)$/i.exec(text);
  if (m) return `${m[2].toLowerCase() === "more" ? "▲" : "▼"} ${m[1]}% VS ${caps(m[3].replace(/^the /i, ""))}`;
  const same = /^About the same as (.+)$/i.exec(text);
  if (same) return `≈ SAME AS ${caps(same[1].replace(/^the /i, ""))}`;
  return caps(text);
}

function statLabel(unit) {
  return ({ "per task": "PER TASK", "a month": "/ MONTH" })[unit] ?? caps(unit);
}

/** A numbered section rule: `02 ACTIVITY ──────── NOTE`. */
function head(c, p, index, title, note = "", { led = false, tone = null, pb = G.sm } = {}) {
  return h_flex().w_full().items_center().gap(10).pb(pb)
    .child(div().flex_none().text_size(10.5).text_color(c.muted).child(index))
    .when(led, (el) => el.child(breathe(div().size(6).flex_none().rounded_full().bg(p.signal), PULSE)))
    .child(div().flex_none().text_size(10.5).text_color(c.text).child(caps(title)))
    .child(div().flex_1().min_w(12).h(1).bg(c.border))
    .child(div().flex_none().max_w(240).truncate().text_size(10.5).text_color(tone ?? c.muted).child(caps(note)));
}

function boxIcon(id, path, tip, onClick, c, { spin = false, disabled = false, active = false } = {}) {
  const glyph = svg(path).size(14).text_color(spin || active ? c.text : disabled ? c.border : c.muted);
  return Button.new(id).size(28).flex_none().items_center().justify_center().rounded(4)
    .border_1().border_color(active ? c.input : c.border)
    .accessibility_label(tip).tooltip(tip)
    .when(!disabled, (el) => el.cursor_pointer().hover((s) => s.bg(c.subtle)).focus((s) => s.border_color(c.accent)).on_click((_e, cx) => onClick(cx)))
    .child(spin ? glyph.spin(900) : glyph);
}

/** The bracketed readout card: four corner ticks in the signal color. */
function frame(c, p) {
  const tick = (vertical, horizontal) => {
    const el = div().absolute().size(10).border_color(p.signal);
    const v = vertical === "t" ? el.top(0).border_t(1) : el.bottom(0).border_b(1);
    return horizontal === "l" ? v.left(0).border_l(1) : v.right(0).border_r(1);
  };
  return v_flex().w_full().relative().px(14).pt(10).pb(10).gap(6).bg(p.card).border_1().border_color(c.border)
    .child(tick("t", "l")).child(tick("t", "r")).child(tick("b", "l")).child(tick("b", "r"));
}

/** A big dollar figure, its cents dimmed. */
function bigValue(c, exact, narrow, tip) {
  const text = String(exact ?? "");
  const dot = text.lastIndexOf(".");
  const whole = dot > 0 ? text.slice(0, dot) : text;
  const cents = dot > 0 ? text.slice(dot) : "";
  return h_flex().items_end().when(Boolean(tip), (el) => el.tooltip(tip))
    .child(div().text_size(narrow ? 34 : 44).font_weight(200).line_height(1).text_color(c.text).child(whole))
    .when(Boolean(cents), (el) => el.child(div().pb(narrow ? 3 : 4).text_size(narrow ? 16 : 20).font_weight(200).line_height(1).text_color(c.muted).child(cents)));
}

function statGrid(c, stats) {
  const many = stats.length > 3;
  return h_flex().w_full().border_t(1).border_color(c.border).pt(8)
    .children(stats.map((s, i) => v_flex().flex_1().min_w(0).gap(3).when(Boolean(s.tip), (el) => el.tooltip(s.tip))
      .when(i > 0, (el) => el.border_l(1).border_color(c.border).pl(many ? 10 : 12))
      .child(div().truncate().text_size(9.5).text_color(c.muted).child(s.label))
      .child(div().text_size(many ? 15 : 16).font_weight(300).line_height(1).text_color(c.text).child(s.value))
      .when(Boolean(s.sub), (el) => el.child(div().truncate().text_size(10).text_color(c.muted).child(s.sub)))));
}

export default class TokenSpend extends View {
  init(_props, cx) {
    this.closed = false;
    this.width = 960;
    this.nodeBinary = null;
    this.runtimeError = null;
    this.runtimeTask = null;
    this.scan = null;
    this.costs = null;
    this.share = new Share(MOD, paths.join(appHome(), DATA_DIR));
    this.error = null;
    this.running = null;
    this.queued = { snapshot: false, prepare: false };
    this.generation = 0;
    this.task = null;
    this.watchdog = null;
    this.continueTimer = null;
    this.lastSnapshotAt = 0;
    this.cost = { period: spendPeriod(shared(PERIOD_KEY)), offset: 0, project: "all", model: "all" };
    this.expanded = {};
    this.page = "home";
    this.stack = [];
    this.settings = null;
    this.planInputs = [];
    this.settingsNote = null;
    this.openMenu = null;
    this.menuOptions = null;
    this.syncHolds = [];
    this.syncStored = [];
    this.db = new Kdb();
    this.syncKick = shared(SYNC_KICK);
    this.ws = { syncing: false, at: 0, error: null, missing: false };
    this.quotaInput = null;
    this.quotaNote = null;

    this.ticker = null;
    this.awake = false;

    // Herdr starts hidden copies too, so wake only when this one is on screen.
    if (!hiddenInLayout()) afterMount(cx, (cx) => this.wake(cx));

    this.commandTask = cx.spawn(async (commandCx) => {
      for (;;) {
        const next = await tryOrAsync(async () => {
          const command = await nextCommand();
          commandCx.notify();
          return { command };
        });
        if (!next) break; // a replaced build (hot reload, update) stops here, before acting
        const { command } = next;
        const name = String(command).replace(new RegExp(`^${MOD}\\.`), "");
        if (name === "refresh") this.refreshAll(commandCx);
        else if (name === "open") this.wake(commandCx);
        else if (name === "settings") this.openSettings(commandCx);
        else if (name === "back") this.back(commandCx);
      }
    });
  }

  /** Refresh button and ⌘R: this Mac now, the remote workspace too (its sync re-reads when it lands). */
  refreshAll(cx) {
    this.run("snapshot", cx);
    this.syncWorkspace(cx, true);
  }

  /** Mirrors the remote workspace's logs with au-sync, then reads again. Unforced, it skips a sync under WS_GAP_MS old. */
  syncWorkspace(cx, force) {
    if (this.closed || this.ws.syncing || this.ws.missing || tryOr(() => checking(), false)) return;
    this.ws = { ...this.ws, syncing: true, error: null };
    cx.notify();
    cx.spawn(async (syncCx) => {
      const last = async () => {
        const text = await readTextFile(paths.join(home(), AU_LAST)).catch(() => null);
        const at = Number(String(text ?? "").trim().split(/\s+/)[0]) * 1000;
        return Number.isFinite(at) ? at : 0;
      };
      let at = await last();
      if (!force && at && Date.now() - at < WS_GAP_MS) {
        this.ws = { ...this.ws, syncing: false, at };
        syncCx.notify();
        return;
      }
      const result = await exec(paths.join(home(), AU_SYNC), [], { timeout: WS_TIMEOUT_MS })
        .catch((error) => ({ code: -1, stderr: String(error?.message ?? error) }));
      if (this.closed) return;
      const missing = result.code === -1 && /not found|no such file|ENOENT|cannot start|failed to start/i.test(String(result.stderr));
      at = await last();
      this.ws = {
        syncing: false, at, missing,
        error: result.code === 0 || missing ? null : resultError(result).replace(/^au-sync:\s*/, ""),
      };
      if (result.code === 0) this.run("snapshot", syncCx);
      syncCx.notify();
    });
  }

  /** A sync another copy (or `au`) ran lands here too: just the marker file, no SSH. */
  readWsAt(cx) {
    if (this.ws.syncing || this.ws.missing) return;
    cx.spawn(async (readCx) => {
      const text = await readTextFile(paths.join(home(), AU_LAST)).catch(() => null);
      const at = Number(String(text ?? "").trim().split(/\s+/)[0]) * 1000;
      if (Number.isFinite(at) && at > this.ws.at) {
        this.ws = { ...this.ws, at, error: null };
        this.run("snapshot", readCx);
        readCx.notify();
      }
    });
  }

  wsStatus() {
    if (this.ws.missing) return `${WS_NAME}: au-sync not found`;
    if (this.ws.syncing) return `Syncing ${WS_NAME}…`;
    if (this.ws.error) return `${WS_NAME} sync failed${this.ws.at ? `, showing data from ${agoText(this.ws.at)}` : ""}`;
    return this.ws.at ? `${WS_NAME} synced ${agoText(this.ws.at)}` : `${WS_NAME} not synced yet`;
  }

  wake(cx) {
    if (this.closed) return;
    this.awake = true;
    this.syncWorkspace(cx, false);
    if (!this.ticker) {
      this.ticker = cx.timer.every(TICK_MS, (tickCx) => {
        if (hiddenInLayout()) {
          this.sleep();
          return;
        }
        const every = this.costs?.live?.length ? LIVE_REFRESH_MS : REFRESH_MS;
        if (Date.now() - this.lastSnapshotAt >= every) this.run("snapshot", tickCx);
        this.readWsAt(tickCx);
        this.exchange(tickCx, false);
      });
    }
    if (!this.nodeBinary && !this.runtimeError) {
      if (this.runtimeTask) return;
      this.runtimeTask = cx.spawn(async (runtimeCx) => {
        try {
          // One-time migration of the old token-spend mod's data, so its history carries over.
          await localService(fileApi).migrate(paths.join(appHome(), "data", "token-spend"), paths.join(appHome(), DATA_DIR)).catch(() => null);
          this.nodeBinary = parseRuntimeNode(await readTextFile(paths.join(appHome(), RUNTIME_FILE)));
        } catch (error) {
          this.runtimeError = `Spend needs ${RUNTIME_FILE} with the path to Node 22: ${sanitizeError(error)}`;
        }
        this.runtimeTask = null;
        if (this.closed) return;
        if (this.nodeBinary) { this.run("snapshot", runtimeCx); this.exchange(runtimeCx, true); }
        runtimeCx.notify();
      });
      return;
    }
    if (Date.now() - this.lastSnapshotAt >= REFRESH_MS) this.run("snapshot", cx);
    else if (!this.costs) this.run("prepare", cx);
    this.exchange(cx, true);
    cx.notify();
  }

  sleep() {
    this.awake = false;
    for (const handle of [this.ticker, this.continueTimer]) {
      try { handle?.cancel(); } catch { /* already gone */ }
    }
    this.ticker = null;
    this.continueTimer = null;
    this.costs = null;
    this.menuOptions = null;
    this.openMenu = null;
  }

  close() {
    this.closed = true;
    this.generation += 1;
    for (const handle of [this.task, this.watchdog, this.continueTimer, this.ticker, this.commandTask, this.runtimeTask]) {
      try { handle?.cancel(); } catch { /* already gone */ }
    }
  }

  options() {
    const d = new Date();
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    return { today, cost: { ...this.cost } };
  }

  /** One presenter call at a time; later requests queue, so filters never race a refresh. */
  run(command, cx, extra = null) {
    if (this.closed || !this.nodeBinary) return;
    if (this.running) {
      if (command === "configure") this.queuedSources = extra;
      this.queued = { ...this.queued, [command === "configure" ? "snapshot" : command]: true };
      return;
    }
    this.generation += 1;
    const generation = this.generation;
    const sent = this.options();
    this.running = command;
    if (command === "snapshot") this.lastSnapshotAt = Date.now();
    cx.notify();

    try { this.watchdog?.cancel(); } catch { /* already gone */ }
    this.watchdog = cx.timer.after(STEP_TIMEOUT_MS, (timerCx) => {
      if (generation !== this.generation) return;
      this.generation += 1;
      try { this.task?.cancel(); } catch { /* already gone */ }
      this.finish(timerCx, "Spend took too long to answer. It will try again shortly.");
    });

    this.task = cx.spawn(async (taskCx) => {
      const { payload, failure } = await this.ask(command, sent, extra).then(
        (answer) => ({
          payload: answer,
          failure: answer?.kind !== PAYLOAD_KIND || answer.version !== PAYLOAD_VERSION || !answer.costs
            ? "Spend got an answer it does not understand. Reload the panel."
            : null,
        }),
        (error) => ({ payload: null, failure: sanitizeError(error) }),
      );
      if (generation !== this.generation || this.closed) return;
      if (payload) {
        this.scan = payload.scan ?? this.scan;
        if (this.awake) this.costs = payload.costs;
        if (payload.settings) this.settings = payload.settings;
        // Filters changed while this ran: price again with the current ones.
        if (JSON.stringify(sent.cost) !== JSON.stringify(this.cost)) this.queued = { ...this.queued, prepare: true };
      }
      this.finish(taskCx, failure);
    });
  }

  /** Parsed presenter answer; Node 22's node:sqlite experimental notice is suppressed so stderr stays clean for errors. */
  async ask(command, sent, extra) {
    const result = await exec(this.nodeBinary, [
      "--disable-warning=ExperimentalWarning",
      paths.join(appHome(), PRESENTER_FILE), command,
      "--store", paths.join(appHome(), DATA_DIR, "store.json"),
      "--home", home(),
      "--options", JSON.stringify(sent),
      ...(command === "configure" ? ["--sources", JSON.stringify(extra ?? {})] : []),
    ]);
    if (result.code !== 0) throw new Error(resultError(result));
    return JSON.parse(String(result.stdout ?? ""));
  }

  finish(cx, failure) {
    try { this.watchdog?.cancel(); } catch { /* already gone */ }
    this.watchdog = null;
    this.task = null;
    this.running = null;
    this.error = failure;
    if (!this.closed) {
      if (this.queued.snapshot) {
        this.queued = { snapshot: false, prepare: false };
        const sources = this.queuedSources;
        this.queuedSources = null;
        if (sources) this.run("configure", cx, sources);
        else this.run("snapshot", cx);
      } else if (this.queued.prepare) {
        this.queued = { ...this.queued, prepare: false };
        this.run("prepare", cx);
      } else if (this.scan?.partial && !failure && this.awake) {
        // The first scan is time-boxed; keep going until it has read everything.
        try { this.continueTimer?.cancel(); } catch { /* already gone */ }
        this.continueTimer = cx.timer.after(1000, (timerCx) => {
          this.continueTimer = null;
          this.run("snapshot", timerCx);
        });
      }
    }
    if (this.awake && !this.closed) this.exchange(cx, true);
    cx.notify();
  }

  exchange(cx, force = false) {
    if (this.closed || !this.awake || !this.nodeBinary) return;
    if (this.syncing) { this.syncAgain = true; if (force) this.syncForce = true; return; }
    this.syncing = true;
    cx.spawn(async (syncCx) => {
      try { await this.exchangeOnce(syncCx, force); } catch { /* the next open tries again; saved figures stay */ }
      this.syncing = false;
      if (this.syncAgain && this.awake && !this.closed) { const again = this.syncForce; this.syncForce = false; this.syncAgain = false; this.exchange(syncCx, again); }
    });
  }

  async exchangeOnce(cx, force = false) {
    if (!this.awake || this.closed) return;
    const now = Date.now();
    if (!force && this.syncOffUntil > now) return;
    const dir = syncDir(appHome());
    const config = configFrom(await readTextFile(paths.join(dir, "config.json")).catch(() => null));
    if (!syncOn(config)) { this.syncOffUntil = now + EXCHANGE_MS; this.syncHolds = []; return; }
    this.syncOffUntil = 0;
    const periodKey = periodKeyOf(this.cost);
    const options = { today: this.options().today, cost: { period: this.cost.period, offset: Number(this.cost.offset) || 0, project: "all", model: "all" } };
    const self = this.costs?.syncSelf || identityFrom(await readTextFile(paths.join(dir, "identity.json")).catch(() => null), () => "", "").id;
    const power = await powerOf(this.db, this.syncStored);
    if (!this.awake || this.closed) return;
    this.syncStored = power.stored;
    const out = await exchangeAll((on, payload) => serviceOn(probeApi, on).then((probe) => probe.exchange(payload)), {
      config, peers: machines(), status: statusFrom(await readTextFile(paths.join(dir, "status.json")).catch(() => null)),
      rows: rowsFrom(await readTextFile(paths.join(dir, "rows.json")).catch(() => null)),
      self, own: self ? rowFromCosts(this.costs, self, new Date(now).toISOString(), options) : null,
      now, periodKey, options, stored: power.stored, live: power.live,
    });
    if (!this.awake || this.closed) return;
    this.syncHolds = holdsOf(out.status, power.stored, power.live);
    if (!out.ran) return;
    await localService(fileApi).mkdir(dir);
    const rowsFile = paths.join(dir, "rows.json");
    const statusFile = paths.join(dir, "status.json");
    await writeTextFile(rowsFile, rowsText(out.rows), await readTextFile(rowsFile).catch(() => null));
    await writeTextFile(statusFile, statusText(out.status), await readTextFile(statusFile).catch(() => null));
    this.run("prepare", cx);
  }

  setCost(patch, cx) {
    this.cost = { ...this.cost, ...patch };
    if (patch.period) setShared(PERIOD_KEY, patch.period);
    this.run("prepare", cx);
    this.exchange(cx, true);
    cx.notify();
  }

  openDetail(kind, item, cx) {
    this.openMenu = null;
    if (kind === "task") {
      this.stack = [...this.stack, { kind, label: item.title, task: item }];
      cx.notify();
      return;
    }
    const entry = { kind, label: kind === "project" ? projectName(item.value) : item.value, value: item.value, prevCost: { ...this.cost } };
    this.stack = [...this.stack, entry];
    this.setCost({ [kind]: item.value }, cx);
  }

  back(cx) {
    if (this.page === "settings") {
      this.page = "home";
      cx.notify();
      return;
    }
    const top = this.stack[this.stack.length - 1];
    if (!top) return;
    this.stack = this.stack.slice(0, -1);
    if (top.prevCost) this.setCost({ project: top.prevCost.project, model: top.prevCost.model }, cx);
    else cx.notify();
  }

  openSettings(cx) {
    this.page = "settings";
    this.settingsNote = null;
    // Inputs need a live host call: build them here, never in render.
    this.planInputs = (this.settings?.plans ?? []).map((plan) => ({
      name: InputState.new({ value: plan.name, placeholder: "Plan" }),
      amount: InputState.new({ value: String(plan.usdPerMonth), placeholder: "0" }),
    }));
    this.quotaNote = null;
    this.quotaInput = InputState.new({ value: this.settings?.quota ? String(this.settings.quota) : "", placeholder: "1000" });
    cx.notify();
  }

  /** Local change: the monthly quota lives in prices.json as "quota": {"usdPerMonth": n}; other keys are kept. */
  saveQuota(cx) {
    const file = this.settings?.pricesPath ?? paths.join(appHome(), DATA_DIR, "prices.json");
    const raw = String(this.quotaInput?.value() ?? "").replace(/[^0-9.]/g, "");
    const usd = raw ? Number(raw) : 0;
    if (!Number.isFinite(usd) || usd < 0) { this.quotaNote = "Enter a dollar amount."; cx.notify(); return; }
    this.quotaNote = "Saving…";
    cx.notify();
    cx.spawn(async (saveCx) => {
      try {
        const before = await readTextFile(file).catch(() => null);
        const kept = tryOr(() => (before ? JSON.parse(before) : {}), {});
        if (!kept || typeof kept !== "object" || Array.isArray(kept)) throw new TypeError("prices.json is not a JSON object.");
        const { quota: _old, ...rest } = kept;
        const data = usd > 0 ? { ...rest, quota: { usdPerMonth: usd } } : rest;
        await writeTextFile(file, `${JSON.stringify(data, null, 2)}\n`, before);
        this.settings = { ...(this.settings ?? {}), quota: usd };
        this.quotaNote = usd > 0 ? `Saved: $${usd.toLocaleString("en-US")} a month.` : "Saved. No quota.";
        this.run("prepare", saveCx);
      } catch (error) {
        this.quotaNote = `Could not save: ${sanitizeError(error)}`;
      }
      saveCx.notify();
    });
  }

  addPlan(cx) {
    this.planInputs = [...this.planInputs, {
      name: InputState.new({ placeholder: "ChatGPT Pro, Claude Max…" }),
      amount: InputState.new({ placeholder: "200" }),
    }];
    cx.notify();
  }

  removePlan(index, cx) {
    this.planInputs = this.planInputs.filter((_, i) => i !== index);
    cx.notify();
  }

  /** Plans live in prices.json next to the store; other keys there are kept. */
  savePlans(cx) {
    const file = this.settings?.pricesPath ?? paths.join(appHome(), DATA_DIR, "prices.json");
    const plans = this.planInputs
      .map((input) => ({ name: input.name.value().trim(), usdPerMonth: Number(String(input.amount.value()).replace(/[^0-9.]/g, "")) }))
      .filter((plan) => plan.name && Number.isFinite(plan.usdPerMonth) && plan.usdPerMonth > 0);
    this.settingsNote = "Saving…";
    cx.notify();
    cx.spawn(async (saveCx) => {
      try {
        const before = await readTextFile(file);
        // Unreadable JSON starts over; an array is written back unchanged (a key on an array never reaches its JSON).
        const kept = tryOr(() => (before ? JSON.parse(before) : {}), {});
        if (!kept || typeof kept !== "object") throw new TypeError("prices.json is not a JSON object.");
        const data = Array.isArray(kept) ? kept : { ...kept, plans };
        await writeTextFile(file, `${JSON.stringify(data, null, 2)}\n`, before);
        this.settingsNote = plans.length ? `Saved ${plans.length} ${plans.length === 1 ? "plan" : "plans"}.` : "Saved. No plans.";
        this.run("prepare", saveCx);
      } catch (error) {
        this.settingsNote = `Could not save: ${sanitizeError(error)}`;
      }
      saveCx.notify();
    });
  }

  toggleSource(id, enabled, cx) {
    if (this.settings) {
      this.settings = { ...this.settings, sources: this.settings.sources.map((s) => (s.id === id ? { ...s, enabled } : s)) };
    }
    this.run("configure", cx, { [id]: enabled });
    cx.notify();
  }

  // A machine just turned on or off in the sidebar: exchange now, outside the render pass.
  kicked(cx) {
    const kick = shared(SYNC_KICK);
    if (kick === this.syncKick) return;
    this.syncKick = kick;
    cx.timer.after(0, (kickCx) => this.exchange(kickCx, true));
  }

  render(cx) {
    // A space switch can restore the panel without a command: wake on the next tick, outside the render pass.
    if (!this.awake && !this.closed && !this.waking && !hiddenInLayout()) {
      this.waking = true;
      cx.timer.after(0, (wakeCx) => {
        this.waking = false;
        if (!hiddenInLayout()) this.wake(wakeCx);
      });
    }
    this.kicked(cx);
    const t = theme();
    const c = tokens(t);
    const p = consoleColors(c, t);
    const narrow = (this.width || 960) < 560;
    const top = this.stack[this.stack.length - 1];
    const body = this.page === "settings" ? this.settingsView(c, p)
      : top?.kind === "task" ? this.taskView(c, p, top.task, narrow)
      : this.costs?.hero ? this.costsView(c, p, narrow, top) : this.waitingView(c, p, narrow);
    return v_flex().id("spend-root").size_full().min_h(0).bg(c.canvas).text_color(c.text).font_family(MONO)
      .overflow_y_scrollbar()
      .on_size_change((size, sizeCx) => {
        const changed = Math.abs((this.width || 0) - size.width) >= 1;
        this.width = size.width;
        if (changed) sizeCx.notify();
      })
      .child(h_flex().flex_none().w_full().justify_center().px(narrow ? G.lg : 32).py(narrow ? 20 : 28)
        .child(v_flex().w_full().max_w(1080).gap(narrow ? 28 : 36)
          .child(this.header(c, p, narrow))
          .when(this.share.open && this.canShare(), (el) => el.child(this.share.row(c, () => this.shareCard(),
            "Only the totals and the days: no project, task or session names. The post opens with the image in it.", G.sm)))
          .child(body)));
  }

  // Only the unfiltered totals are shared, so a filter or a detail view hides it.
  canShare() {
    return this.page === "home" && !this.stack.length && Boolean(this.costs?.hero?.value)
      && this.cost.project === "all" && this.cost.model === "all" && !(this.costs.machines?.length > 1);
  }

  shareCard() {
    return { spec: spendSpec(this.costs), text: spendText(this.costs), name: `spend-${this.costs.range?.label ?? "now"}`, title: "Spend" };
  }

  header(c, p, narrow) {
    const busy = Boolean(this.running);
    const updated = this.scan?.lastScanAt ? `Updated ${formatTime(this.scan.lastScanAt)}` : "";
    const tip = busy ? "Updating…" : updated ? `Refresh · ${updated}` : "Refresh";
    const top = this.stack[this.stack.length - 1];
    const inner = this.page === "settings" || Boolean(top);
    const title = this.page === "settings" ? "Settings" : top ? top.label : "";
    const crumb = this.page === "settings" ? "Settings" : top ? ({ project: "Project", model: "Model", task: "Task" })[top.kind] : "Agent telemetry";
    return v_flex().w_full().gap(14)
      .child(h_flex().w_full().items_end().justify_between().gap(G.md)
        .child(h_flex().flex_1().min_w(0).items_end().gap(G.sm)
          .when(inner, (el) => el.child(boxIcon("spend-back", icon("back"), "Back", (cx) => this.back(cx), c)))
          .child(v_flex().flex_1().min_w(0).gap(6)
            .child(h_flex().items_center().gap(12)
              .child(div().flex_none().text_size(10).text_color(c.muted).child(`◢ ${caps(crumb)}`))
              .when(this.page !== "settings" && !top, (el) => el.child(this.statusChip(c, p))))
            .when(inner, (el) => el.child(div().truncate().font_family(SANS).line_height(1.1).text_size(narrow ? 16 : 18)
              .text_color(c.text).tooltip(title).child(title)))))
        .child(h_flex().gap(6).items_center().flex_none()
          .when(this.canShare(), (el) => el.child(boxIcon("spend-share", icon("share"), "Share", (cx) => this.share.toggle(cx), c, { active: this.share.open })))
          .child(boxIcon("spend-refresh", icon("refresh"), tip, (cx) => this.refreshAll(cx), c, { spin: busy || this.ws.syncing, disabled: busy }))
          .when(this.page !== "settings", (el) => el.child(boxIcon("spend-settings", icon("settings"), "Settings", (cx) => this.openSettings(cx), c)))))
      ;
  }

  /** LIVE count in the title row; sync and update times sit in its tooltip and only show when something needs attention. */
  statusChip(c, p) {
    const live = this.costs?.live?.length ?? 0;
    const reading = this.running && this.running !== "prepare" && this.scan?.partial ? `READING ${this.scan.processed}/${this.scan.total}` : "";
    const updated = this.running ? "UPDATING…" : this.scan?.lastScanAt ? `UPD ${formatTime(this.scan.lastScanAt)}` : "";
    const attention = this.ws.missing || this.ws.error || this.ws.syncing || !this.ws.at;
    const dot = div().size(6).flex_none().rounded_full().bg(live ? p.signal : c.dim);
    const tip = `${this.wsStatus()}${this.ws.error ? `: ${this.ws.error}` : ""} · ${updated}`;
    return h_flex().id("spend-status").flex_1().min_w(0).items_center().gap(6).text_size(10).text_color(c.muted).tooltip(tip)
      .child(live ? breathe(dot, PULSE) : dot)
      .child(div().flex_none().text_color(live ? c.text : c.muted).child(live ? `LIVE ${live}` : "IDLE"))
      .when(Boolean(reading) || attention, (el) => el.child(div().min_w(0).truncate().text_color(this.ws.error ? c.red : c.muted).child(reading || this.wsShort())));
  }

  /** (unused) LIVE · the workspace sync · last update, in one bordered strip. */
  statusStrip(c, p) {
    const live = this.costs?.live?.length ?? 0;
    const reading = this.running && this.running !== "prepare" && this.scan?.partial ? `READING ${this.scan.processed}/${this.scan.total}` : "";
    const updated = this.running ? "UPDATING…" : this.scan?.lastScanAt ? `UPD ${formatTime(this.scan.lastScanAt)}` : "";
    const dot = div().size(6).flex_none().rounded_full().bg(live ? p.signal : c.dim);
    const wsTip = `${this.wsStatus()}${this.ws.error ? `: ${this.ws.error}` : ""}`;
    return h_flex().id("spend-status").w_full().items_center().gap(12).px(10).py(7).rounded(4)
      .border_1().border_color(c.border).bg(p.card).text_size(10).text_color(c.muted)
      .child(h_flex().flex_none().items_center().gap(6)
        .child(live ? breathe(dot, PULSE) : dot)
        .child(div().text_color(live ? c.text : c.muted).child(live ? `LIVE ${live}` : "IDLE")))
      .child(div().w(1).h(10).flex_none().bg(c.input))
      .child(div().id("spend-ws").flex_1().min_w(0).truncate().text_color(this.ws.error ? c.red : c.muted).tooltip(wsTip).child(this.wsShort()))
      .child(div().flex_none().child(reading || updated));
  }

  wsShort() {
    const name = caps(WS_NAME);
    if (this.ws.missing) return "AU-SYNC NOT FOUND";
    if (this.ws.syncing) return `SYNCING ${name}…`;
    if (this.ws.error) return `${name} SYNC FAILED`;
    if (!this.ws.at) return `${name} NOT SYNCED`;
    const m = Math.floor((Date.now() - this.ws.at) / 60_000);
    const ago = m < 1 ? "JUST NOW" : m < 60 ? `${m}M AGO` : m < 1440 ? `${Math.floor(m / 60)}H AGO` : `${Math.floor(m / 1440)}D AGO`;
    return `${name} SYNCED ${ago}`;
  }

  sourcesBones(c) {
    const { line } = ghost(c);
    return breathe(v_flex().id("loft-skeleton").w_full())
      .children([0, 1, 2].map((i) => v_flex().w_full().py(G.sm).gap(2).child(line([100, 80, 120][i], 13)).child(line([180, 160, 140][i], 11))));
  }

  skeleton(c, p, narrow) {
    const { block, line, row } = ghost(c);
    return breathe(v_flex().id("loft-skeleton").w_full().gap(narrow ? 28 : 36))
      .child(block(1000, 32, 4).w_full())
      .child(v_flex().w_full().gap(G.md).p(16).border_1().border_color(c.border)
        .child(line(90, 10))
        .child(block(narrow ? 170 : 230, narrow ? 44 : 54, 4))
        .child(h_flex().gap(G.xl).pt(G.md).children([46, 64, 58].map((w) => block(w, 20, 3)))))
      .child(v_flex().w_full().gap(4)
        .child(line(120, 10))
        .children([0, 1, 2, 3, 4].map((r) => h_flex().w_full().gap(4)
          .children([0, 1, 2, 3, 4, 5, 6].map((d) => div().flex_1().h(narrow ? 40 : 46).rounded(3).bg(p.ramp[(r * 3 + d) % 3 === 0 ? 1 : 0]))))))
      .child(v_flex().w_full()
        .child(h_flex().pb(G.sm).child(line(70, 10)))
        .children([0, 1, 2, 3, 4].map(row)));
  }

  waitingView(c, p, narrow) {
    const failed = this.runtimeError || (this.error && !this.running);
    if (!failed) return this.skeleton(c, p, narrow);
    return v_flex().w_full().gap(G.sm)
      .child(div().text_size(12).text_color(c.red).child("SPEND COULD NOT READ YOUR SESSIONS"))
      .child(div().text_size(11).line_height(1.5).text_color(c.muted).child(this.runtimeError || this.error))
      .when(!this.runtimeError, (el) => el.child(h_flex().pt(G.xs)
        .child(quietLink("spend-retry", "TRY AGAIN", (cx) => this.run("snapshot", cx), c, { size: 10.5, color: c.text }))));
  }

  costsView(c, p, narrow, top = null) {
    const data = this.costs;
    let index = 0;
    const n = () => String(++index).padStart(2, "0");
    const wide = (this.width || 960) >= 860;
    const blocks = [];
    if (this.error && !this.running) {
      blocks.push(h_flex().w_full().gap(G.md).items_center()
        .child(div().id("spend-error").flex_1().min_w(0).text_size(11).text_color(c.red).truncate().tooltip(this.error)
          .child(`LAST UPDATE FAILED: ${this.error}`))
        .child(quietLink("spend-retry-inline", "TRY AGAIN", (cx) => this.run("snapshot", cx), c, { size: 10.5 })));
    }
    blocks.push(this.controls(c, p, Boolean(top)));
    blocks.push(this.hero(c, p, data.hero, narrow));
    if (!data.hero.empty && data.heat) blocks.push(this.heatView(c, p, data.heat, narrow, n()));
    if (!top && data.quota) blocks.push(this.quotaView(c, p, data.quota, narrow, n()));
    else if (!top && !data.quotaSet && this.cost.period === "month") {
      blocks.push(h_flex().w_full().gap(G.md).items_center()
        .child(div().text_size(11).text_color(c.muted).child("No monthly quota set."))
        .child(quietLink("ins-quota-set", "SET ONE", (cx) => this.openSettings(cx), c, { size: 10.5, color: c.text })));
    }
    if (!top && Array.isArray(data.live) && data.live.length > 0) blocks.push(this.live(c, p, data.live, n()));
    if (!top && Array.isArray(data.sources) && data.sources.length > 0) blocks.push(this.sourcesView(c, p, data.sources, n()));
    if (!top && (data.machines?.length ?? 0) > 1) blocks.push(this.machineSplit(c, p, data.machines, n()));
    if (!top && (this.syncHolds?.length ?? 0) > 0) {
      blocks.push(v_flex().w_full().gap(G.xs)
        .children(this.syncHolds.map((hold) => h_flex().w_full().items_center().gap(G.md)
          .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(c.text).child(hold.id))
          .child(div().text_size(10.5).text_color(c.muted).child(hold.text)))));
    }
    if (!data.hero.empty) {
      const lists = [
        top?.kind === "project" ? null : this.list(c, p, "Projects", data.projectCount, data.projects, "project", n()),
        top?.kind === "model" ? null : this.list(c, p, "Models", data.modelCount, data.models, "model", n()),
      ].filter(Boolean);
      if (wide) blocks.push(h_flex().w_full().gap(48).items_start().children(lists.map((list) => div().flex_1().min_w(0).max_w(lists.length === 1 ? 560 : 10_000).child(list))));
      else blocks.push(...lists);
      blocks.push(this.tasks(c, p, data, n()));
    }
    blocks.push(this.footnotes(c, data.footnote ?? []));
    return v_flex().w_full().gap(narrow ? 18 : 24)
      .opacity(this.running === "prepare" ? 0.55 : 1)
      .children(blocks);
  }

  controls(c, p, inDetail = false) {
    const filtered = !inDetail && (this.cost.project !== "all" || this.cost.model !== "all");
    const label = [
      this.cost.project !== "all" ? projectName(this.cost.project) : null,
      this.cost.model !== "all" ? this.cost.model : null,
    ].filter(Boolean).join(" and ");
    const seg = (item, index) => {
      const on = this.cost.period === item.key;
      return Button.new(`ins-period-${item.key}`).flex_1().min_w(0).h(26).items_center().justify_center().rounded(2).cursor_pointer()
        .selected(on)
        .set_position(index + 1, SPEND_PERIODS.length)
        .accessibility_label(item.label)
        .when(on, (el) => el.bg(c.raised).border_b(1).border_color(p.signal))
        .when(!on, (el) => el.hover((s) => s.bg(c.subtle)))
        .focus((s) => s.bg(c.subtle))
        .on_click((_e, cx) => { if (!on) this.setCost({ period: item.key, offset: 0 }, cx); })
        .child(div().text_size(10.5).text_color(on ? c.text : c.muted).child(PERIOD_SHORT[item.key] ?? caps(item.label)));
    };
    return v_flex().w_full().gap(8)
      .child(v_flex().w_full().rounded(4).border_1().border_color(c.border)
        .child(h_flex().id("ins-period").w_full().p(2).gap(2).children(SPEND_PERIODS.map(seg)))
        .when(!inDetail, (el) => el.child(h_flex().w_full().items_center().justify_between().gap(16).px(10).h(28).border_t(1).border_color(c.border)
          .child(this.menu("project", c))
          .child(this.menu("model", c)))))
      .when(filtered, (el) => el.child(h_flex().gap(G.md).items_center()
        .child(div().min_w(0).truncate().text_size(10.5).text_color(c.muted).child(`SHOWING ${caps(label)}`))
        .child(quietLink("ins-clear", "SHOW EVERYTHING", (cx) => this.setCost({ project: "all", model: "all" }, cx), c, { size: 10.5, color: c.text }))));
  }

  menu(field, c) {
    const value = this.cost[field];
    const facet = this.costs.facets?.[field] ?? [];
    const allLabel = field === "project" ? "All projects" : "All models";
    const shown = value === "all" ? allLabel : (facet.find((entry) => entry.value === value)?.label ?? projectName(value));
    const id = `ins-menu-${field}`;
    const trigger = Button.new(`${id}-trigger`).h(H.compact).gap(6).items_center().cursor_pointer()
      .accessibility_label(`${field === "project" ? "Project" : "Model"}: ${shown}`)
      .hover((style) => style.opacity(0.75))
      .focus((style) => style.opacity(0.75))
      .child(div().text_size(10.5).text_color(c.muted).child(field === "project" ? "PROJECT" : "MODEL"))
      .child(div().max_w(170).truncate().text_size(10.5).text_color(c.text).child(value === "all" ? "ALL" : shown))
      .child(div().text_size(9).text_color(c.muted).child("▾"));
    const popover = Popover.new(id).trigger(trigger)
      .open(this.openMenu === id)
      .on_open_change((open, cx) => {
        this.openMenu = open ? id : null;
        // Options are built in this event, never in the render pass.
        this.menuOptions = open ? [
          { value: "all", label: allLabel, detail: "", meta: "" },
          ...facet.map((entry) => ({
            value: entry.value,
            label: entry.label,
            detail: entry.detail ?? (field === "project" ? entry.value : ""),
            meta: entry.meta,
          })),
        ] : null;
        cx.notify();
      });
    if (this.openMenu === id && this.menuOptions) {
      popover.content(v_flex().id(`${id}-options`).w(260).max_h(340).overflow_y_scrollbar().p(G.xs).gap(1).rounded(R.control)
        .font_family(MONO).bg(c.popover).border_1().border_color(c.border)
        .children(this.menuOptions.map((option, index) => {
          const selected = option.value === value;
          return Button.new(`${id}-option-${index}`).flex_none().w_full().px(8).py(5).gap(G.sm).items_center().rounded(3)
            .cursor_pointer()
            .selected(selected)
            .set_position(index + 1, this.menuOptions.length)
            .when(selected, (el) => el.bg(c.selected))
            .when(!selected, (el) => el.hover((style) => style.bg(c.subtle)))
            .focus((style) => style.bg(c.selected))
            .accessibility_label(option.label)
            .on_click((_event, cx) => {
              this.openMenu = null;
              this.menuOptions = null;
              this.setCost({ [field]: option.value }, cx);
            })
            .child(v_flex().flex_1().min_w(0).gap(1)
              .child(div().text_size(11.5).text_color(c.text).truncate().child(option.label))
              .when(Boolean(option.detail), (el) => el.child(div().text_size(9.5).text_color(c.dim).truncate().child(option.detail))))
            .child(div().text_size(10.5).text_color(c.dim).child(option.meta ?? ""));
        })));
    }
    return popover;
  }

  hero(c, p, hero, narrow) {
    const offset = this.cost.offset || 0;
    const stepper = this.cost.period !== "all";
    const stats = (hero.stats ?? []).map((s) => ({ label: statLabel(s.unit), value: s.value, sub: s.sub, tip: s.tip }));
    return frame(c, p)
      .child(h_flex().w_full().items_center().justify_between().gap(G.md)
        .child(div().text_size(10).text_color(c.muted).child("API VALUE"))
        .child(h_flex().items_center().gap(10)
          .when(offset < 0, (row) => row.child(quietLink("ins-now", "NOW", (cx) => this.setCost({ offset: 0 }, cx), c, { size: 10, label: "Back to now" })))
          .when(stepper, (row) => row.child(quietLink("ins-older", "‹", (cx) => this.setCost({ offset: offset - 1 }, cx), c, { size: 15, label: "Previous period" })))
          .child(div().text_size(10).text_color(c.text).child(caps(hero.title)))
          .when(stepper, (row) => row.child(quietLink("ins-newer", "›", (cx) => this.setCost({ offset: Math.min(0, offset + 1) }, cx), c, {
            size: 15, label: "Next period", disabled: offset >= 0,
          })))))
      .child(h_flex().w_full().flex_wrap().items_end().gap_x(G.md).gap_y(G.xs)
        .child(bigValue(c, hero.exact ?? hero.value, narrow, hero.tip))
        .child(div().flex_1())
        .when(Boolean(hero.note), (el) => el.child(div().pb(narrow ? 6 : 8).text_size(10.5).text_color(p.signal).child(deltaText(hero.note)))))
      .when(Boolean(hero.empty), (el) => el.child(div().text_size(11.5).text_color(c.muted).child(hero.empty)))
      .when(!hero.empty && stats.length > 0, (el) => el.child(statGrid(c, stats)))
      .when(Boolean(hero.plan), (el) => el.child(div().text_size(11).line_height(1.5).text_color(c.muted).child(hero.plan)))
      .when(Boolean(this.scan?.partial), (el) => el.child(div().text_size(10.5).text_color(c.muted)
        .child(`Still reading your history: ${this.scan.processed} of ${this.scan.total} files so far.`)));
  }

  /** Local change: the month against the quota, across every source, as a 40-segment meter. */
  quotaView(c, p, q, narrow, index) {
    const tone = q.level === "over" ? p.over : q.level === "warn" ? p.warn : p.ok;
    const state = q.level === "over" ? "OVER" : q.level === "warn" ? "▲ PACE WARN" : "NOMINAL";
    const usedR = q.usedRatio || 0;
    const paceR = Math.min(1, usedR + (q.paceRatio || 0));
    const segs = Array.from({ length: 40 }, (_, i) => {
      const f = (i + 0.5) / 40;
      const seg = div().flex_1().min_w(0).h(14).rounded(1);
      return f <= usedR ? seg.bg(tone) : f <= paceR ? seg.bg(tone).opacity(0.28) : seg.bg(p.meterOff);
    });
    const pos = Math.max(0, Math.min(1, q.dayRatio ?? 0));
    const markText = q.dayLabel ?? "";
    const marker = pos > 0.85
      ? h_flex().w_full().h(11).justify_end().child(div().text_size(8.5).text_color(c.muted).child(`${markText} ▼`)).child(div().flex_none().w(pctOf(1 - pos)))
      : h_flex().w_full().h(11).child(div().flex_none().w(pctOf(pos))).child(div().text_size(8.5).text_color(c.muted).child(`▼ ${markText}`));
    const cell = (label, value, color) => v_flex().flex_1().min_w(0).gap(4)
      .child(div().text_size(10).text_color(c.muted).child(label))
      .child(div().text_size(13).text_color(color).child(value ?? "—"));
    return v_flex().w_full().gap(12)
      .child(head(c, p, index, "Quota", state, { tone, pb: 0 }))
      .child(h_flex().id("quota-figure").w_full().items_end().gap(8).tooltip(q.tip)
        .child(div().text_size(narrow ? 28 : 32).font_weight(200).line_height(1).text_color(c.text).child(q.used))
        .child(div().pb(2).text_size(13).text_color(c.muted).child(`/ ${q.of}`))
        .child(div().flex_1())
        .child(div().pb(2).text_size(13).text_color(tone).child(q.pctText ?? "")))
      .child(v_flex().id("quota-bar").w_full().gap(3).child(marker).child(h_flex().w_full().gap(2).children(segs)))
      .child(h_flex().w_full().gap(8)
        .child(cell("LEFT", q.leftText, c.text))
        .child(cell("PACE · EOM", q.projectedText, tone))
        .child(cell("BURN / DAY", q.perDayText, c.text)))
      .child(v_flex().w_full().gap(3)
        .child(div().text_size(11).line_height(1.5).text_color(q.level === "ok" ? c.muted : tone).child(q.pace))
        .child(div().text_size(10.5).text_color(c.muted).child(q.line))
        .when(Boolean(q.places), (el) => el.child(div().text_size(10.5).text_color(c.muted).child(q.places))));
  }

  /** Local change: the activity heatmap (calendar, or GitHub-style weeks), with a hover readout. */
  heatView(c, p, h, narrow, index) {
    const cells = h.kind === "calendar" ? h.weeks.flat() : h.bands.flatMap((band) => band.cols.flat());
    if (this.heatFor !== h) {
      this.heatFor = h;
      this.heatDefault = cells.find((x) => x.key === h.selected) ?? null;
      this.hoverCell = null;
    }
    const sel = this.hoverCell ?? this.heatDefault;
    const enter = (cell) => (hovered, cx) => {
      if (hovered && this.hoverCell !== cell) { this.hoverCell = cell; cx.notify(); }
    };
    // Clicking a day covers the grid with that day's detail, in the day's own colour.
    const toggle = (x) => (_e, cx) => {
      if (x.future || (!x.models.length && !x.projects.length)) return;
      this.openDay = this.openDay === x.key ? null : x.key;
      if (this.openDay) this.lastDay = x;
      cx.notify();
    };
    const dayCard = (_x, trigger) => trigger;
    const edge = (el, x) => {
      const picked = (sel && x.key === sel.key) || x.key === this.openDay;
      if (picked) return el.border_1().border_color(c.text);
      if (x.today) return el.border_1().border_color(p.signal);
      if (x.future) return el.border_1().border_dashed().border_color(c.input);
      return el;
    };
    let grid;
    if (h.kind === "calendar") {
      const cellH = narrow ? 34 : 44;
      const dayCell = (x) => (x.blank ? div().flex_1().min_w(0).h(cellH).px(6)
        : div().flex_1().min_w(0).child(dayCard(x, edge(h_flex().id(`hm-${x.key}`).w_full().h(cellH).px(4).gap(2).items_center().justify_between().rounded(3)
          .bg(x.future ? CLEAR : p.ramp[x.level]), x)
          .on_hover(enter(x)).cursor_pointer().on_click(toggle(x))
          .child(div().flex_none().text_size(9).line_height(1.2).text_color(p.ink(x.level)).opacity(0.7).child(x.n))
          .child(div().flex_none().whitespace_nowrap().text_size(10).line_height(1.2).font_weight(500).text_color(p.ink(x.level)).child(x.label)))));
      grid = v_flex().w_full().max_w(640).gap(4)
        .child(h_flex().w_full().gap(4).children(["MO", "TU", "WE", "TH", "FR", "SA", "SU"].map((d) => div().flex_1().min_w(0).text_size(9).text_color(c.muted).child(d))))
        .children(h.weeks.map((week) => h_flex().w_full().gap(4).children(week.map(dayCell))));
    } else {
      const sq = 11;
      const band = (b) => h_flex().w_full().gap(6)
        .child(v_flex().w(22).flex_none().gap(3)
          .child(div().h(14))
          .children(["MO", "", "WE", "", "FR", "", ""].map((d) => div().h(sq).text_size(8.5).line_height(1).text_color(c.muted).child(d))))
        .child(v_flex().flex_1().min_w(0).gap(3)
          .child(h_flex().w_full().h(14).gap(3).children(b.months.map((m) => div().flex_1().min_w(0).whitespace_nowrap().text_size(8.5).text_color(c.muted).child(m))))
          .child(h_flex().w_full().gap(3).children(b.cols.map((col) => v_flex().flex_1().min_w(0).gap(3)
            .children(col.map((x) => (x.blank ? div().h(sq)
              : div().w_full().child(dayCard(x, edge(div().id(`hm-${x.key}`).w_full().h(sq).rounded(2).bg(x.future ? CLEAR : p.ramp[x.level]), x).on_hover(enter(x)).cursor_pointer().on_click(toggle(x)))))))))));
      grid = v_flex().w_full().max_w(760).gap(10).children(h.bands.map(band));
    }
    const swatch = div().size(10).flex_none().rounded(2).bg(sel && !sel.future ? p.ramp[sel.level] : CLEAR)
      .when(Boolean(sel?.future), (el) => el.border_1().border_dashed().border_color(c.input));
    return v_flex().w_full().gap(10)
      .child(head(c, p, index, "Activity", h.peakText, { pb: 0 }))
      .child(div().id("hm-grid").w_full().relative()
        .on_hover((on, cx) => { if (!on && this.hoverCell) { this.hoverCell = null; cx.notify(); } })
        .child(grid)
        .child(this.dayPanel(c, p, h, narrow)))
      .child(h_flex().w_full().max_w(h.kind === "calendar" ? 640 : 760).items_center().gap(10).px(10).py(8).rounded(4)
        .border_1().border_color(c.border).text_size(10.5).text_color(c.muted)
        .child(swatch)
        .child(div().flex_none().text_color(c.text).child(sel?.date ?? "HOVER A DAY"))
        .child(div().flex_1())
        .child(div().flex_none().child(sel?.tokens ?? ""))
        .child(div().flex_none().min_w(56).text_right().text_color(c.text).child(sel?.usd ?? "")))
      .child(h_flex().w_full().max_w(h.kind === "calendar" ? 640 : 760).items_center().gap(4).text_size(9).text_color(c.muted)
        .child(div().mr(4).child("LESS"))
        .children(p.ramp.map((col, i) => div().id(`hm-legend-${i}`).size(11).flex_none().rounded(2).bg(col).tooltip(LEVEL_TIPS[i])))
        .child(div().ml(4).child("MORE"))
        .child(div().flex_1())
        .child(div().flex_none().child(`${h.activeDays} ${h.activeDays === 1 ? "DAY" : "DAYS"} · BEST RUN ${h.bestRun}D`)));
  }

  /** Local change: the day's detail, laid over the activity grid; slides open on click, closes with its button. */
  dayPanel(c, p, h, narrow) {
    const x = this.lastDay;
    const open = Boolean(this.openDay && x);
    const cellH = narrow ? 34 : 44;
    const full = h.kind === "calendar" ? 20 + h.weeks.length * (cellH + 4) : h.bands.length * 115;
    const H = Math.max(190, full);
    const ink = x ? p.ink(x.level) : c.text;
    const rows = (title, list) => v_flex().flex_1().min_w(0).gap(6)
      .child(div().text_size(9).text_color(ink).opacity(0.65).child(title))
      .children(list.length ? list.map((r) => v_flex().w_full().gap(3)
        .child(h_flex().w_full().gap(8).items_end()
          .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(ink).child(r.name))
          .child(div().flex_none().text_size(11).text_color(ink).opacity(0.8).child(r.usd)))
        .child(div().w_full().h(2).bg("#00000033").child(div().h(2).w(pctOf(Math.max(r.share, 0.02))).bg(ink))))
        : [div().text_size(11).text_color(ink).opacity(0.7).child("Nothing recorded.")]);
    return div().id("hm-day").absolute().top(0).left(0).w_full().h(open ? H : 0).opacity(open ? 1 : 0).overflow_hidden()
      .transition("height", { duration: 260, easing: "ease-out" })
      .transition("opacity", { duration: 200, easing: "ease-out" })
      .child(v_flex().w_full().h(H).rounded(4).bg(x ? p.ramp[x.level] : CLEAR)
        .child(h_flex().w_full().h(34).flex_none().px(10).gap(8).items_center().bg("#00000026")
          .child(div().id("hm-day-close").size(20).flex_none().rounded(4).flex().items_center().justify_center()
            .text_size(11).text_color(ink).cursor_pointer().tooltip("Close")
            .hover((st) => st.bg("#00000033"))
            .on_click((_e, cx) => { this.openDay = null; cx.notify(); })
            .child("✕"))
          .child(div().flex_none().text_size(12).font_weight(500).text_color(ink).child(x?.date ?? ""))
          .child(div().flex_1())
          .child(div().flex_none().text_size(10.5).text_color(ink).opacity(0.7).child(x?.tokens ?? ""))
          .child(div().flex_none().text_size(15).font_weight(300).text_color(ink).child(x?.usd ?? "")))
        .child(h_flex().w_full().gap(20).items_start().p(16)
          .child(rows("MODELS", x?.models ?? []))
          .child(rows("PROJECTS", x?.projects ?? []))));
  }

  /** Local change: every agent and computer in the period, with its share. */
  sourcesView(c, p, rows, index) {
    return v_flex().w_full().gap(2)
      .child(head(c, p, index, "Where it ran", `${rows.length} ${rows.length === 1 ? "source" : "sources"}`))
      .children(rows.map((row, i) => v_flex().id(`src-${i}`).w_full().gap(6).py(7).tooltip(row.detail)
        .child(h_flex().w_full().items_end().gap(10)
          .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(c.text).child(row.name))
          .child(div().flex_none().text_size(10).text_color(c.muted).child(row.tokensText))
          .child(div().flex_none().min_w(58).text_right().text_size(13).font_weight(300).text_color(c.text).child(row.usdText)))
        .child(h_flex().w_full().items_center().gap(8)
          .child(div().flex_1().h(2).bg(c.border).child(div().h(2).w(pctOf(Math.max(row.share || 0, 0.006))).bg(i === 0 ? p.signal : p.ramp[3])))
          .child(div().flex_none().min_w(40).text_right().text_size(9.5).text_color(c.muted).child(shareText(row.share))))));
  }

  machineSplit(c, p, rows, index) {
    return v_flex().w_full().gap(2)
      .child(head(c, p, index, "Computers", rows.length === 1 ? "1 computer" : `${rows.length} computers`))
      .children(rows.map((row, i) => h_flex().id(`machine-${i}`).w_full().items_end().gap(10).py(7).tooltip(clock(row.updated_at))
        .child(div().w(18).flex_none().text_size(9.5).text_color(c.muted).child(rank(i)))
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(c.text).child(row.name))
        .child(div().flex_none().text_size(10).text_color(c.muted).child(row.tokensText))
        .child(div().flex_none().min_w(58).text_right().text_size(13).font_weight(300).text_color(c.text).child(row.value))));
  }

  list(c, p, title, count, items, field, index) {
    const selected = this.cost[field];
    const open = Boolean(this.expanded[field]);
    const shown = open ? items : items.slice(0, LIST_ROWS);
    const topUsd = items[0]?.usd || 0;
    return v_flex().w_full()
      .child(head(c, p, index, title, count))
      .when(items.length === 0, (el) => el.child(div().text_size(11).text_color(c.muted).child("Nothing here in this period.")))
      .children(shown.map((item, i) => {
        const active = selected === item.value;
        const ratio = topUsd > 0 ? (item.usd || 0) / topUsd : 0;
        return Button.new(`ins-${field}-${i}`).w_full().px(4).py(8).gap(10).items_center().rounded(2).cursor_pointer()
          .hover((style) => style.bg(p.card))
          .focus((style) => style.bg(p.card))
          .accessibility_label(`${item.name}, ${item.usdText}`)
          .when(Boolean(item.detail), (el) => el.tooltip(item.detail))
          .on_click((_event, cx) => this.openDetail(field, item, cx))
          .child(div().w(18).flex_none().text_size(9.5).text_color(c.muted).child(rank(i)))
          .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(active || selected === "all" ? c.text : c.muted).when(active, (el) => el.font_medium()).child(item.name))
          .child(div().w(44).h(4).flex_none().rounded(1).bg(c.border)
            .child(div().h(4).rounded(1).w(pctOf(Math.max(ratio, 0.04))).bg(p.ramp[Math.max(1, levelFor(item.usd, topUsd))])))
          .child(div().w(44).flex_none().text_right().text_size(10).text_color(c.muted).child(item.tokensText))
          .child(div().w(62).flex_none().text_right().text_size(13).font_weight(300).text_color(c.text).child(item.usdText));
      }))
      .when(items.length > LIST_ROWS, (el) => el.child(h_flex().pt(6)
        .child(quietLink(`ins-${field}-more`, open ? "SHOW FEWER" : `+ ${items.length - LIST_ROWS} MORE`, (cx) => {
          this.expanded = { ...this.expanded, [field]: !open };
          cx.notify();
        }, c, { size: 10 }))));
  }

  taskView(c, p, d, narrow) {
    const row = (name, sub, usd, tokensText, i) => h_flex().w_full().items_center().gap(G.md).py(8).px(4)
      .when(i > 0, (el) => el.border_t(1).border_color(c.border))
      .child(div().w(18).flex_none().text_size(9.5).text_color(c.muted).child(rank(i)))
      .child(v_flex().flex_1().min_w(0).gap(3)
        .child(div().truncate().text_size(12).text_color(c.text).child(name))
        .when(Boolean(sub), (el) => el.child(div().text_size(9.5).text_color(c.muted).child(caps(sub)))))
      .child(div().flex_none().text_size(10).text_color(c.muted).child(tokensText))
      .child(div().flex_none().min_w(62).text_right().text_size(13).font_weight(300).text_color(c.text).child(usd));
    const parts = (d.parts ?? []).map((part) => ({ label: caps(part.label), value: part.value }));
    return v_flex().w_full().gap(narrow ? 28 : 36)
      .child(v_flex().w_full().gap(G.sm)
        .when(Boolean(d.ticket), (el) => el.child(div().text_size(11).font_medium().text_color(p.signal).child(d.ticket)))
        .child(div().w_full().font_family(SANS).text_size(15).line_height(1.45).text_color(c.text).child(d.title))
        .child(div().text_size(10).line_height(1.5).text_color(c.muted).child([d.project, d.tools, d.when].filter(Boolean).map(caps).join(" · "))))
      .child(frame(c, p)
        .child(div().text_size(10).text_color(c.muted).child("API VALUE"))
        .child(bigValue(c, d.usdExact ?? d.usdText, narrow, `${d.usdExact} at API list price`))
        .when(parts.length > 0, (el) => el.child(statGrid(c, parts))))
      .child(v_flex().w_full()
        .child(head(c, p, "01", "Models", `${d.models.length}`))
        .children(d.models.map((m, i) => row(m.name, "", m.usdText, m.tokensText, i))))
      .child(v_flex().w_full()
        .child(head(c, p, "02", "Sessions", d.sessionCount > d.sessions.length ? `top ${d.sessions.length} of ${d.sessionCount}` : `${d.sessionCount}`))
        .children(d.sessions.map((s, i) => row(s.name, s.when, s.usdText, s.tokensText, i))))
      .child(h_flex().gap(G.lg)
        .child(quietLink("ins-task-project", `OPEN ${caps(d.project)}`, (cx) => this.openDetail("project", { value: d.projectPath }, cx), c, { size: 10.5, color: c.text })));
  }

  settingsView(c, p) {
    const s = this.settings;
    let index = 0;
    const heading = (title, note) => v_flex().w_full().gap(6).pb(G.md)
      .child(head(c, p, String(++index).padStart(2, "0"), title, "", { pb: 0 }))
      .when(Boolean(note), (el) => el.child(div().text_size(11).line_height(1.5).text_color(c.muted).child(note)));
    const busy = this.running === "configure" || (this.running === "snapshot" && this.queuedSources);
    const link = (id, label, onClick) => quietLink(id, label, onClick, c, { size: 10.5, color: c.text });
    return v_flex().w_full().gap(40)
      .child(v_flex().w_full()
        .child(heading("Monthly quota", "Your monthly allowance in dollars at API list price. The Month view shows what's used, what's left and your pace. Empty: no quota."))
        .when(Boolean(this.quotaInput), (el) => el.child(h_flex().w_full().items_center().gap(G.sm).py(4)
          .child(div().text_size(12).text_color(c.muted).child("$"))
          .child(div().w(120).flex_none().child(controlInput(Input.new(this.quotaInput).w_full(), c)))
          .child(div().text_size(10.5).text_color(c.muted).child("/ MONTH"))
          .child(div().pl(G.md).child(link("ins-quota-save", "SAVE QUOTA", (cx) => this.saveQuota(cx))))
          .when(Boolean(this.quotaNote), (row) => row.child(div().text_size(10.5).text_color(c.muted).child(this.quotaNote))))))
      .child(v_flex().w_full()
        .child(heading("Sources", `Where Spend reads your sessions. Turning one off removes it from every number. ${WS_NAME}'s logs are mirrored by au-sync when this panel opens (at most every 5 minutes) and when you refresh.`))
        .when(!s, (el) => el.child(this.sourcesBones(c)))
        .children((s?.sources ?? []).map((source, i) => h_flex().w_full().items_center().gap(G.md).py(G.sm)
          .when(i > 0, (el) => el.border_t(1).border_color(c.border))
          .child(v_flex().flex_1().min_w(0).gap(2)
            .child(div().text_size(12).text_color(source.enabled ? c.text : c.muted).child(source.label))
            .child(div().id(`ins-source-roots-${i}`).truncate().text_size(9.5).text_color(c.muted).tooltip(source.roots).child(source.roots)))
          .child(toggleSwitch(`ins-source-${source.id}`, source.enabled, (next, cx) => this.toggleSource(source.id, next, cx), c, {
            label: `${source.label}: ${source.enabled ? "on" : "off"}`,
          }))))
        .when(Boolean(busy), (el) => el.child(div().pt(G.sm).text_size(10.5).text_color(c.muted).child("UPDATING SOURCES…"))))
      .child(v_flex().w_full()
        .child(heading("Plans", "What you pay each month. Spend subtracts it from the API value to show what your plans save you."))
        .children(this.planInputs.map((input, i) => h_flex().w_full().items_center().gap(G.sm).py(4)
          .child(div().flex_1().min_w(0).child(controlInput(Input.new(input.name).w_full(), c)))
          .child(div().text_size(12).text_color(c.muted).child("$"))
          .child(div().w(84).flex_none().child(controlInput(Input.new(input.amount).w_full(), c)))
          .child(div().text_size(10.5).text_color(c.muted).child("/ MO"))
          .child(iconButton(`ins-plan-remove-${i}`, icon("close"), "Remove plan", (cx) => this.removePlan(i, cx), c))))
        .child(h_flex().w_full().gap(G.lg).items_center().pt(G.sm)
          .child(link("ins-plan-add", "+ ADD PLAN", (cx) => this.addPlan(cx)))
          .child(link("ins-plan-save", "SAVE PLANS", (cx) => this.savePlans(cx)))
          .when(Boolean(this.settingsNote), (el) => el.child(div().text_size(10.5).text_color(c.muted).child(this.settingsNote)))))
      .child(v_flex().w_full()
        .child(heading("Prices", "Claude models use Anthropic's list prices, Claude Code with its 1-hour cache writes. Other models use the OpenRouter catalog, refreshed once a day; tokens without a list price are left out, not guessed."))
        .child(div().text_size(10).text_color(c.muted).child(`// Your own per-model prices: "models" in ${s?.pricesPath ?? `${DATA_DIR}/prices.json`}`)))
      .child(v_flex().w_full()
        .child(heading("Updates", "While this panel is open: every minute, or every 30 seconds while a session is active. Closed, Spend does nothing.")));
  }

  live(c, p, sessions, index) {
    return v_flex().w_full()
      .child(head(c, p, index, "Active now", String(sessions.length), { led: true }))
      .children(sessions.map((s, i) => Button.new(`ins-live-${i}`).w_full().px(6).py(9).gap(12).items_center().cursor_pointer()
        .border_t(1).border_color(c.border)
        .hover((style) => style.bg(p.card))
        .focus((style) => style.bg(p.card))
        .accessibility_label(`${s.title}, ${s.usdText}`)
        .on_click((_event, cx) => this.openDetail("task", s.detail, cx))
        .child(div().w(2).h(28).flex_none().bg(p.signal))
        .child(v_flex().flex_1().min_w(0).gap(4)
          .child(h_flex().w_full().gap(G.sm).items_end()
            .when(Boolean(s.ticket), (el) => el.child(div().flex_none().text_size(11).font_medium().text_color(p.signal).child(s.ticket)))
            .child(div().flex_1().min_w(0).truncate().font_family(SANS).text_size(12.5).text_color(c.text).tooltip(s.tip).child(s.title)))
          .child(div().truncate().text_size(9.5).text_color(c.muted).child(s.meta.map(caps).join(" · "))))
        .child(v_flex().flex_none().items_end().gap(3)
          .child(div().text_size(14).font_weight(300).text_color(c.text).child(s.usdText))
          .child(div().text_size(9.5).text_color(c.muted).child(caps(s.tokensText))))));
  }

  tasks(c, p, data, index) {
    const open = Boolean(this.expanded.tasks);
    const shown = open ? data.tasks : data.tasks.slice(0, TASK_ROWS);
    return v_flex().w_full()
      .child(head(c, p, index, "Tasks", data.tasksNote))
      .children(shown.map((task, i) => Button.new(`ins-task-${i}`).w_full().px(4).py(10).gap(12).items_center().cursor_pointer()
        .border_t(1).border_color(c.border)
        .hover((style) => style.bg(p.card))
        .focus((style) => style.bg(p.card))
        .accessibility_label(`${task.title}, ${task.usdText}`)
        .on_click((_event, cx) => this.openDetail("task", task.detail, cx))
        .child(div().w(18).flex_none().text_size(9.5).text_color(c.muted).child(rank(i)))
        .child(v_flex().flex_1().min_w(0).gap(5)
          .child(h_flex().w_full().gap(G.sm).items_end()
            .when(Boolean(task.ticket), (el) => el.child(div().flex_none().text_size(11).font_medium().text_color(p.signal).child(task.ticket)))
            .child(div().flex_1().min_w(0).truncate().font_family(SANS).text_size(12.5).text_color(c.text).tooltip(task.tip).child(task.title)))
          .child(div().truncate().text_size(9.5).text_color(c.muted).child(task.meta.map(caps).join(" · "))))
        .child(v_flex().flex_none().items_end().gap(3)
          .child(div().text_size(14).font_weight(300).text_color(c.text).child(task.usdText))
          .child(div().text_size(9.5).text_color(c.muted).child(caps(task.tokensText))))))
      .when(data.tasks.length > TASK_ROWS, (el) => el.child(h_flex().pt(10).border_t(1).border_color(c.border)
        .child(quietLink("ins-tasks-more", open ? "SHOW FEWER" : `+ ${data.tasks.length - TASK_ROWS} MORE`, (cx) => {
          this.expanded = { ...this.expanded, tasks: !open };
          cx.notify();
        }, c, { size: 10 }))));
  }

  footnotes(c, lines) {
    return v_flex().w_full().gap(6).pt(12).border_t(1).border_dashed().border_color(c.input)
      .children(lines.map((line) => div().text_size(9.5).line_height(1.55).text_color(c.muted).child(`// ${line}`)))
      .child(div().pt(6).w_full().text_center().text_size(9.5).text_color(c.dim).child("— EOT —"));
  }
}
