# Kanso "office" pi worker probe: live pi terminals that Herdr cannot see (pi sends no OSC 7501
# status report) get their status read from the session file pi writes for them. Read-only; prints
# JSON. The list of terminals comes on argv[1] as a JSON array of {address, cwd, created_ms, title}.
# Turn starts learned across ticks are cached in ~/.cache/office-piwork.json, so a turn longer
# than the read window keeps its timer.
import glob, json, os, re, sys, calendar, time

HOME = os.path.expanduser("~")
CACHE = os.path.join(HOME, ".cache", "office-piwork.json")
TAIL = 524288        # bytes of a session file read per terminal
STALE = 3 * 60 * 1000  # a pi that stops writing this long mid-turn has stopped (long tools and
                       # model calls write nothing; a dead pi never writes again)

try:
    terms = json.loads(sys.argv[1])
except Exception:
    terms = []


def ms(t):
    """A message timestamp: epoch ms, or an ISO stamp (agents write ...Z) -> epoch ms."""
    if isinstance(t, (int, float)):
        return int(t)
    if not t:
        return None
    s = str(t)
    try:
        return int(float(s))
    except ValueError:
        pass
    try:
        m = re.match(r"(.{19})(?:\.(\d+))?", s)
        if not m:
            return None
        frac = int(m.group(2).ljust(3, "0")[:3]) if m.group(2) else 0
        return calendar.timegm(time.strptime(m.group(1), "%Y-%m-%dT%H:%M:%S")) * 1000 + frac
    except Exception:
        return None


def dir_of(cwd):
    return os.path.join(HOME, ".pi", "agent", "sessions", "--" + str(cwd).strip("/").replace("/", "-") + "--")


def tail_lines(path):
    out = []
    try:
        with open(path, "rb") as f:
            f.seek(max(0, os.path.getsize(path) - TAIL))
            f.readline()
            data = f.read()
    except OSError:
        return out
    for raw in data.split(b"\n"):
        if raw:
            try:
                out.append(json.loads(raw))
            except ValueError:
                pass
    return out


def state(path):
    """What the turn looks like at the file's tail: working or idle, and since when.
    The newest message decides: a user message, a tool result, or an assistant message that
    calls more tools means the turn is going; any other assistant message ends it. `since` is
    the turn's first user message, or the oldest message in the window when a long turn pushed
    it past the read window (then `saw_user` is False and the caller falls back to its cache).
    Staleness is judged by the file's last write, not the turn's age: a pi tool loop can run for
    an hour, but a stopped pi stops writing."""
    status, since, title, first, floor, saw_user = "idle", None, None, None, None, False
    for e in tail_lines(path):
        t = e.get("type")
        if t == "session_name" and e.get("name"):
            title = e["name"]
        if t != "message":
            continue
        m = e.get("message") or {}
        at = ms(m.get("timestamp")) or ms(e.get("timestamp"))
        if floor is None:
            floor = at
        role = m.get("role")
        if role == "user":
            status, since, saw_user = "working", at, True
            if not first:
                c = m.get("content")
                first = c if isinstance(c, str) else " ".join(x.get("text", "") for x in c or [] if isinstance(x, dict))
        elif role == "toolResult" or (role == "assistant" and m.get("stopReason") == "toolUse"):
            status = "working"
        elif role == "assistant":
            status, since = "idle", at
    if status == "working" and not saw_user:
        since = floor
    try:
        mtime = os.path.getmtime(path) * 1000
    except OSError:
        mtime = None
    if status == "working" and mtime and time.time() * 1000 - mtime > STALE:
        status, since = "idle", mtime  # stopped mid-turn: it has stopped
    return {"status": status, "since": since, "title": title, "first": first, "saw_user": saw_user}


def load_cache():
    try:
        with open(CACHE) as f:
            return json.load(f)
    except Exception:
        return {}


def save_cache(cache):
    try:
        os.makedirs(os.path.dirname(CACHE), exist_ok=True)
        with open(CACHE, "w") as f:
            json.dump(cache, f)
    except Exception:
        pass  # a lost tick's cache just resets the bar's timer


def file_created(f):
    """The time in a session file's name (pi writes it when the session starts)."""
    m = re.match(r"^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z_", os.path.basename(f))
    if not m:
        return None
    return calendar.timegm(time.strptime("%s %s:%s:%s" % (m.group(1), m.group(2), m.group(3), m.group(4)),
                                        "%Y-%m-%d %H:%M:%S")) * 1000 + int(m.group(5))


MATCH_MS = 30000  # a new session's file is created moments after its terminal

out, taken, assign = {}, set(), {}
cache = load_cache()
by_dir = {}
for t in terms:
    if not t.get("address"):
        continue
    d = dir_of(t.get("cwd") or "~")
    by_dir.setdefault(d, []).append(t)

# Pass A: a new session's file carries the terminal's start time, so pin each terminal to the
# file in its folder whose name-time is closest to it (near-simultaneous starts stay distinct).
for d, ts in by_dir.items():
    files = {f: file_created(f) for f in glob.glob(os.path.join(d, "*.jsonl")) if file_created(f)}
    pairs = []
    for t in ts:
        created = t.get("created_ms")
        if not created:
            continue
        for f, fc in files.items():
            pairs.append((abs(fc - created), created, t["address"], f))
    pairs.sort()
    for diff, created, addr, f in pairs:
        if diff > MATCH_MS or addr in assign or f in taken:
            continue
        assign[addr] = f
        taken.add(f)

# Pass B: the rest (resumed sessions reuse an older file, or no created_ms): the newest file in
# the folder written since the terminal started. Newest terminals first, so the one most recently
# active takes the most recently written file.
for d, ts in by_dir.items():
    files = sorted(glob.glob(os.path.join(d, "*.jsonl")),
                   key=lambda f: os.path.getmtime(f) if os.path.exists(f) else 0, reverse=True)
    ts.sort(key=lambda t: -(t.get("created_ms") or 0))
    for t in ts:
        addr, created = t["address"], t.get("created_ms")
        if addr in assign:
            continue
        for f in files:
            if f in taken:
                continue
            if created:
                try:
                    if os.path.getmtime(f) * 1000 < created - 5000:
                        continue  # last written before this terminal existed
                except OSError:
                    continue
            assign[addr] = f
            taken.add(f)
            break

for t in terms:
    addr = t.get("address")
    if not addr or addr not in assign:
        continue
    pick = assign[addr]
    try:
        s = state(pick)
    except Exception:
        s = {"status": "idle", "since": None, "title": None, "first": None, "saw_user": False}
    saw_user = s.pop("saw_user")
    c = cache.get(addr) or {}
    if s["status"] == "working":
        if not saw_user and c.get("file") == pick and c.get("since"):
            s["since"] = c["since"]  # the turn's start left the window; keep the learned one
        s["title"] = s["title"] or c.get("title")
        s["first"] = s["first"] or c.get("first")
        cache[addr] = {"file": pick, "since": s["since"], "title": s["title"], "first": s["first"]}
    else:
        cache.pop(addr, None)
    out[addr] = s

save_cache(cache)
print(json.dumps(out))
