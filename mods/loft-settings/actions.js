// A family is one Keys-page row for nine actions that differ by a digit, shown and rebound as one chord with N in its place.
export const GROUPS = [
  // bar: drawn as the tab bar itself (main.js `barKeys`).
  { name: "Panels", section: "layout:loft", bar: true, actions: [
    { family: "loft-tabs.panel-", label: "Open or close a panel" },
    { action: "loft-tabs.sim", label: "Simulator" },
    { action: "loft-tabs.settings", label: "loft settings" },
  ] },
  { name: "Sidebar", section: "layout:loft", actions: [
    { action: "loft-spaces.view-spaces", label: "Projects" },
    { action: "loft-spaces.view-agents", label: "Status" },
    { action: "loft-spaces.view-threads", label: "Threads" },
  ] },
  { name: "Panes", section: "layout:loft", actions: [
    { action: "loft-strip.new-left", label: "New pane to the left" },
    { action: "loft-spaces.needs-you.next", label: "Next agent that needs you" },
    { action: "loft-strip.send", label: "Send the pane's work to an agent" },
    { action: "loft-strip.pin", label: "Pin the pane to its side" },
    { action: "loft-strip.arrange", label: "Arrangements" },
  ] },
  { name: "Vim keys", section: "layout:loft", actions: [
    { action: "loft-strip.vim-left", label: "Pane to the left, or the sidebar's list" },
    { action: "loft-strip.vim-down", label: "Pane below" },
    { action: "loft-strip.vim-up", label: "Pane above" },
    { action: "loft-strip.vim-right", label: "Pane to the right" },
    { action: "loft-strip.vim-move-left", label: "Move the pane left" },
    { action: "loft-strip.vim-move-down", label: "Move the pane down" },
    { action: "loft-strip.vim-move-up", label: "Move the pane up" },
    { action: "loft-strip.vim-move-right", label: "Move the pane right" },
  ] },
  { name: "Moving along the strip", section: "layout:loft", actions: [
    { family: "loft-strip.col-", label: "Go to a column" },
    { action: "loft-strip.first", label: "First column" },
    { action: "loft-strip.last", label: "Last column" },
    { action: "loft-strip.center", label: "Bring the pane into view" },
    { action: "loft-strip.scroll-left", label: "Slide left" },
    { action: "loft-strip.scroll-right", label: "Slide right" },
    { action: "loft-strip.fewer", label: "Fewer panes in view" },
    { action: "loft-strip.more", label: "More panes in view" },
    { action: "loft-strip.fit", label: "Even the columns out" },
  ] },
  { name: "Spend, while its panel has the keyboard", section: "mod:loft-spend", actions: [
    { action: "loft-spend.refresh", label: "Read again" },
    { action: "loft-spend.settings", label: "Spend's settings" },
    { action: "loft-spend.back", label: "Back" },
  ] },
  { name: "Memory, while its panel has the keyboard", section: "mod:loft-guard", actions: [
    { action: "loft-guard.refresh", label: "Check now" },
    { action: "loft-guard.back", label: "Show fewer" },
  ] },
];

// Herdr's own commands, on Herdr's keys; the Keys page leaves them out.
export const HERDRS = /^(loft-strip\.(new-right|new-down|close|go-(left|right|up|down)|move-(left|right|up|down)|width|find)|loft-spaces\.(space-\d|sidebar)|mod\.open:loft-help|terminal\.search)$/;

export const ofRow = (row, action) => (row.family ? new RegExp(`^${row.family.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[1-9]$`).test(action) : action === row.action);

export function familyChords(chord) {
  if (!/[1-9]$/.test(chord)) return null;
  return [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => chord.replace(/[1-9]$/, String(n)));
}

// The layout's own key wins over a global one, so a global clash is a note and a layout clash a change.
export function conflictsOf(all, chord, action) {
  return all.filter((k) => k.keys === chord && k.action !== action && k.action !== "terminal");
}

export function rebound(doc, section, { drop = [], set = {}, replaceAction = null }) {
  const out = JSON.parse(JSON.stringify(doc));
  const gone = new Set([...drop, ...Object.keys(set)]);
  const kept = Object.entries(out[section] ?? {}).filter(([k, v]) => !gone.has(k) && !(replaceAction && v === replaceAction));
  return { ...out, [section]: Object.fromEntries([...kept, ...Object.entries(set)]) };
}
