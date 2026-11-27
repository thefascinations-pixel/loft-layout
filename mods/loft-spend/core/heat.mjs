// Local change (telemetry revamp): the activity heatmap that replaced the bar chart.
// A calendar (7 × 5–6) for Today, Month and 30 days; GitHub-style bands of 27 weeks for Year and All time.
// Everything arrives pre-formatted, so the QuickJS view only lays it out.

const MON = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const DOW = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
const BAND_WEEKS = 27;
const MAX_BANDS = 6;

const parseDay = (day) => {
  const [y, m, d] = String(day).split("-").map(Number);
  return new Date(y, m - 1, d);
};
const keyOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const mondayOf = (d) => addDays(d, -((d.getDay() + 6) % 7));
const daysBetween = (a, b) => Math.round((b - a) / 86_400_000);

/** 0 = nothing; 1–5 = share of the span's busiest day (≤15%, ≤35%, ≤60%, ≤85%, more). */
export function levelOf(usd, peak) {
  if (!(usd > 0) || !(peak > 0)) return 0;
  const r = usd / peak;
  return r <= 0.15 ? 1 : r <= 0.35 ? 2 : r <= 0.6 ? 3 : r <= 0.85 ? 4 : 5;
}

function spanOf(range, today, firstDay) {
  const now = parseDay(today);
  if (range.period === "year") {
    const jan1 = parseDay(range.start);
    const start = mondayOf(jan1);
    return { kind: "weeks", start, bands: 2, first: jan1, last: parseDay(range.end) };
  }
  if (range.period === "all") {
    const first = parseDay(firstDay ?? range.start);
    const weeks = Math.floor(daysBetween(mondayOf(first), mondayOf(now)) / 7) + 1;
    const bands = Math.min(MAX_BANDS, Math.max(1, Math.ceil(weeks / BAND_WEEKS)));
    const start = weeks > bands * BAND_WEEKS ? addDays(mondayOf(now), -(bands * BAND_WEEKS - 1) * 7) : mondayOf(first);
    return { kind: "weeks", start, bands, first: parseDay(range.start), last: addDays(start, bands * BAND_WEEKS * 7 - 1) };
  }
  // Today shows its whole month, the day picked out.
  const first = range.period === "day" ? new Date(parseDay(range.start).getFullYear(), parseDay(range.start).getMonth(), 1) : parseDay(range.start);
  const last = range.period === "day" ? new Date(first.getFullYear(), first.getMonth() + 1, 0) : parseDay(range.end);
  const start = mondayOf(first);
  const weeks = Math.floor(daysBetween(start, mondayOf(last)) / 7) + 1;
  return { kind: "calendar", start, weeks, first, last };
}

/**
 * dailyIn(startKey, endKey) → Map(day → {usd, tokens}) with the view's filters applied.
 * fmt: { usdText, compactText }.
 */
export function heatOf({ range, today, firstDay, dailyIn, fmt }) {
  const span = spanOf(range, today, firstDay);
  const totalDays = span.kind === "weeks" ? span.bands * BAND_WEEKS * 7 : span.weeks * 7;
  const end = addDays(span.start, totalDays - 1);
  const values = dailyIn(keyOf(span.start), keyOf(end));
  const firstKey = keyOf(span.first);
  const lastKey = keyOf(span.last);
  const inSpan = (key) => key >= firstKey && key <= lastKey;

  const days = Array.from({ length: totalDays }, (_, i) => addDays(span.start, i));
  const shown = days.map(keyOf).filter((key) => inSpan(key) && key <= today);
  const peak = shown.reduce((max, key) => Math.max(max, values.get(key)?.usd ?? 0), 0);
  const peakKey = shown.find((key) => peak > 0 && (values.get(key)?.usd ?? 0) === peak) ?? null;

  const cellOf = (d) => {
    const key = keyOf(d);
    if (!inSpan(key)) return { blank: true };
    const v = values.get(key) ?? { usd: 0, tokens: 0 };
    const future = key > today;
    const level = future ? 0 : levelOf(v.usd, peak);
    const whole = Math.round(v.usd);
    const top = (map) => [...(map ?? [])].filter(([, u]) => u > 0).sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([name, u]) => ({ name, usd: fmt.usdText(u), share: v.usd > 0 ? u / v.usd : 0 }));
    return {
      models: future ? [] : top(v.models),
      projects: future ? [] : top(v.projects),
      key,
      n: String(d.getDate()).padStart(2, "0"),
      level,
      future,
      today: key === today,
      label: v.usd > 0 ? (v.usd < 1 ? "<$1" : `$${whole.toLocaleString("en-US")}`) : "",
      date: `${MON[d.getMonth()]} ${String(d.getDate()).padStart(2, "0")} · ${DOW[d.getDay()]}${key === today ? " · TODAY" : ""}`,
      usd: future ? "AHEAD" : v.usd > 0 ? fmt.usdText(v.usd) : "IDLE",
      tokens: future || !v.tokens ? "" : `${fmt.compactText(v.tokens)} TOK`,
    };
  };

  // Active days and runs only count days that have happened.
  const flags = shown.map((key) => (values.get(key)?.usd ?? 0) > 0);
  const activeDays = flags.filter(Boolean).length;
  const best = flags.reduce((acc, on) => {
    const run = on ? acc.run + 1 : 0;
    return { run, best: Math.max(acc.best, run) };
  }, { run: 0, best: 0 }).best;

  const peakText = peakKey ? `PEAK ${fmt.usdText(peak)} · ${MON[parseDay(peakKey).getMonth()]} ${parseDay(peakKey).getDate()}` : "NO USE YET";
  const selected = range.period === "day" ? range.start : peakKey ?? (inSpan(today) ? today : null);
  const base = { kind: span.kind, peakText, activeDays, bestRun: best, selected };

  if (span.kind === "calendar") {
    const weeks = Array.from({ length: span.weeks }, (_, w) => days.slice(w * 7, w * 7 + 7).map(cellOf));
    return { ...base, weeks };
  }
  const bands = Array.from({ length: span.bands }, (_, b) => {
    const cols = Array.from({ length: BAND_WEEKS }, (_, w) => days.slice((b * BAND_WEEKS + w) * 7, (b * BAND_WEEKS + w) * 7 + 7));
    return {
      months: cols.map((week) => {
        const firstOfMonth = week.find((d) => d.getDate() === 1 && inSpan(keyOf(d)));
        return firstOfMonth ? MON[firstOfMonth.getMonth()] : "";
      }),
      cols: cols.map((week) => week.map(cellOf)),
    };
  });
  return { ...base, bands };
}
