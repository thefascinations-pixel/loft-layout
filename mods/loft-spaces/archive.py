# Loft "Archive" probe: every Claude Code, Codex, pi and OpenCode session stored on this machine, newest first.
# Read-only; prints {"sessions": [...]}. Parsed heads/tails are cached in ~/.cache/loft-archive.json by file and mtime.
import glob, json, os, re, sqlite3, time

HOME = os.path.expanduser("~")
CACHE = os.path.join(HOME, ".cache", "loft-archive.json")
LIMIT = 300
HEAD = 262144
TAIL = 131072
UUID = re.compile(r"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$")


def typed(text):
    t = " ".join(str(text or "").split())
    if not t or re.match(r"^(<|/|# AGENTS\.md|Caveat:|\[Request interrupted|This session is being continued)", t):
        return None
    return t[:140]


def read(path, frm=0, size=HEAD):
    try:
        with open(path, "rb") as f:
            f.seek(frm)
            data = f.read(size).decode("utf-8", "replace")
    except Exception:
        return []
    ls = data.split("\n")
    if frm > 0:
        ls = ls[1:]
    out = []
    for l in ls:
        try:
            out.append(json.loads(l))
        except Exception:
            pass
    return out


def claude_prompt(e):
    if e.get("type") != "user" or e.get("isMeta") or e.get("isSidechain"):
        return None
    c = (e.get("message") or {}).get("content")
    if isinstance(c, str):
        return typed(c)
    if isinstance(c, list) and not any(isinstance(p, dict) and p.get("type") == "tool_result" for p in c):
        return typed(" ".join(p.get("text", "") for p in c if isinstance(p, dict) and p.get("type") == "text"))
    return None


def claude(path, mtime):
    m = UUID.search(path)
    if not m:
        return None
    head = read(path)
    prompt = next((p for p in map(claude_prompt, head) if p), None)
    cwd = next((e.get("cwd") for e in head if e.get("cwd")), None)
    if not prompt or not cwd:
        return None
    size = os.path.getsize(path)
    tail = read(path, max(0, size - TAIL), TAIL) if size > HEAD else head
    title = next((e.get("aiTitle") for e in reversed(tail) if e.get("type") == "ai-title" and e.get("aiTitle")), None)
    return {"agent": "claude", "session": m.group(1), "cwd": cwd, "title": title or prompt, "at": mtime}


def codex_names():
    names = {}
    for e in read(os.path.join(HOME, ".codex", "session_index.jsonl"), 0, 4 * 1024 * 1024):
        if e.get("id") and e.get("thread_name"):
            names[e["id"]] = e["thread_name"]
    return names


def codex(path, mtime, names):
    m = UUID.search(path)
    if not m:
        return None
    head = read(path, 0, 65536)
    meta = next((e.get("payload") or {} for e in head if e.get("type") == "session_meta"), {})
    cwd = meta.get("cwd")
    prompt = next((typed((e.get("payload") or {}).get("message")) for e in head
                   if e.get("type") == "event_msg" and (e.get("payload") or {}).get("type") == "user_message"
                   and typed((e.get("payload") or {}).get("message"))), None)
    sid = meta.get("id") or m.group(1)
    if not cwd or not (names.get(sid) or prompt):
        return None
    return {"agent": "codex", "session": sid, "cwd": cwd, "title": names.get(sid) or prompt, "at": mtime}


def pi(path, mtime):
    head = read(path, 0, 65536)
    meta = next((e for e in head if e.get("type") == "session"), None)
    if not meta or not meta.get("id") or not meta.get("cwd"):
        return None
    prompt = None
    for e in head:
        m = e.get("message") or {}
        if e.get("type") == "message" and m.get("role") == "user":
            c = m.get("content")
            prompt = typed(c if isinstance(c, str) else " ".join(p.get("text", "") for p in c or [] if isinstance(p, dict) and p.get("type") == "text"))
            if prompt:
                break
    name = next((e.get("name") for e in head if e.get("type") == "session_info" and e.get("name")), None)
    if not (name or prompt):
        return None
    return {"agent": "pi", "session": meta["id"], "cwd": meta["cwd"], "title": name or prompt, "at": mtime}


def opencode():
    db = os.path.join(HOME, ".local", "share", "opencode", "opencode.db")
    if not os.path.exists(db):
        return []
    try:
        con = sqlite3.connect("file:" + db + "?mode=ro", uri=True, timeout=2)
        rows = con.execute("SELECT id, title, directory, time_updated FROM session WHERE parent_id IS NULL AND time_archived IS NULL ORDER BY time_updated DESC LIMIT ?", (LIMIT,)).fetchall()
        con.close()
    except Exception:
        return []
    return [{"agent": "opencode", "session": r[0], "cwd": r[2], "title": (r[1] or "OpenCode session")[:140], "at": int(r[3])} for r in rows if r[0] and r[2]]


def main():
    try:
        cache = json.load(open(CACHE))
    except Exception:
        cache = {}
    files = []
    for p in glob.glob(os.path.join(HOME, ".claude", "projects", "*", "*.jsonl")):
        files.append(("claude", p))
    for p in glob.glob(os.path.join(HOME, ".codex", "sessions", "*", "*", "*", "rollout-*.jsonl")):
        files.append(("codex", p))
    for p in glob.glob(os.path.join(HOME, ".pi", "agent", "sessions", "*", "*.jsonl")):
        files.append(("pi", p))
    stamped = []
    for kind, p in files:
        try:
            stamped.append((int(os.path.getmtime(p) * 1000), kind, p))
        except Exception:
            pass
    stamped.sort(reverse=True)
    names = None
    out, seen, fresh = [], set(), {}
    for mtime, kind, p in stamped:
        if len(out) >= LIMIT:
            break
        hit = cache.get(p)
        if hit and hit.get("m") == mtime:
            rec = hit.get("r")
        else:
            if kind == "codex" and names is None:
                names = codex_names()
            rec = claude(p, mtime) if kind == "claude" else pi(p, mtime) if kind == "pi" else codex(p, mtime, names or {})
        fresh[p] = {"m": mtime, "r": rec}
        if rec and (rec["agent"], rec["session"]) not in seen:
            seen.add((rec["agent"], rec["session"]))
            out.append(rec)
    for rec in opencode():
        if (rec["agent"], rec["session"]) not in seen:
            seen.add((rec["agent"], rec["session"]))
            out.append(rec)
    out.sort(key=lambda r: r["at"], reverse=True)
    try:
        os.makedirs(os.path.dirname(CACHE), exist_ok=True)
        json.dump(fresh, open(CACHE, "w"))
    except Exception:
        pass
    print(json.dumps({"sessions": out}))


main()
