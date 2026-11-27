// Local patch (top bar redesign): the descriptive name of a pane, as loft-strip's header shows it.
import { shared, spaces } from "herdr";
import { paths } from "./platform-paths.js";

const cleanTitle = (x) => String(x ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();
export function describe(info, given) {
  if (!info) return "Nothing running";
  const mine = given?.get(info.terminal);
  if (mine) return mine;
  const said = shared("loft.names")?.[info.terminal];
  if (said && said !== info.terminal) return said;
  const tab = spaces().flatMap((s) => s.tabs).find((x) => x.id === info.tab);
  if (tab?.named && tab.name !== info.program?.name) return tab.name;
  const prog = info.program, raw = String(info.title ?? "").trim(), live = cleanTitle(raw);
  const pathy = (x) => /^[~/]|^[A-Za-z]:\\/.test(x);
  if (live && !pathy(raw) && !pathy(live) && !live.includes("@") && live.toLowerCase() !== prog?.key && live !== prog?.name) return live;
  if (prog?.shell && info.cwd) return paths.basename(info.cwd) || "~";
  return prog?.name || live || "Pane";
}
