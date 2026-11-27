# Kanso "outside Herdr" probe: coding agents running on this machine that are not Herdr
# terminals (VS Code, a plain terminal or tmux, the SDK): Claude Code, Codex and pi.
# Read-only; prints JSON. Titles are cached in ~/.cache/kanso-outside.json.
import calendar, glob, json, os, re, subprocess, time

HOME = os.path.expanduser("~")
CACHE = os.path.join(HOME, ".cache", "kanso-outside.json")
NOW = int(time.time() * 1000)
PROC = os.path.isdir("/proc")
TAIL = 262144
UUID = re.compile(r"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$")


def sh(argv):
    try:
        return subprocess.run(argv, capture_output=True, timeout=10).stdout.decode("utf-8", "replace")
    except Exception:
        return ""


def typed(text):
    t = " ".join(str(text or "").split())
    if not t or re.match(r"^(<|/|# AGENTS\.md|Caveat:|\[Request interrupted|This session is being continued)", t):
        return None
    return t[:160]


def ms_of(stamp):
    """UTC ISO stamp (agents write ...Z) -> epoch ms."""
    try:
        frac = re.match(r"\.(\d{1,3})", stamp[19:])
        return calendar.timegm(time.strptime(stamp[:19], "%Y-%m-%dT%H:%M:%S")) * 1000 + (int(frac.group(1).ljust(3, "0")) if frac else 0)
    except Exception:
        return None


def lines(path, frm=0, limit=None):
    """JSON lines of path from byte `frm` (the first, partial line dropped when frm > 0)."""
    out = []
    try:
        with open(path, "rb") as f:
            if frm > 0:
                f.seek(frm)
                f.readline()
            data = f.read(limit) if limit else f.read()
    except OSError:
        return out
    for raw in data.split(b"\n"):
        if raw:
            try:
                out.append(json.loads(raw))
            except ValueError:
                pass
    return out


def tail(path, n=TAIL):
    try:
        return lines(path, max(0, os.path.getsize(path) - n))
    except OSError:
        return []


def stat(path):
    try:
        st = os.stat(path)
        return st.st_size, int(st.st_mtime * 1000)
    except OSError:
        return 0, None


# ---- processes ------------------------------------------------------------

if PROC:
    try:
        BOOT = next(int(l.split()[1]) for l in open("/proc/stat") if l.startswith("btime"))
    except Exception:
        BOOT = 0
    HZ = os.sysconf("SC_CLK_TCK")


def procs():
    """[{pid, argv, exe}] of every process, cheaply (no env/cwd yet)."""
    out = []
    if PROC:
        for d in os.listdir("/proc"):
            if not d.isdigit():
                continue
            try:
                argv = open("/proc/%s/cmdline" % d, "rb").read().split(b"\0")
            except OSError:
                continue
            argv = [a.decode("utf-8", "replace") for a in argv if a]
            if argv:
                out.append({"pid": int(d), "argv": argv, "exe": None})
        return out
    for l in sh(["ps", "-axww", "-o", "pid=,comm=,command="]).splitlines():
        m = re.match(r"\s*(\d+)\s+(\S+)\s+(.*)", l)
        if m:
            out.append({"pid": int(m.group(1)), "argv": m.group(3).split(), "exe": m.group(2)})
    return out


def exe_of(p):
    if p["exe"] is None and PROC:
        try:
            p["exe"] = os.readlink("/proc/%d/exe" % p["pid"])
        except OSError:
            p["exe"] = ""
    return p["exe"] or ""


def env_of(pid):
    if PROC:
        try:
            raw = open("/proc/%d/environ" % pid, "rb").read().decode("utf-8", "replace").split("\0")
        except OSError:
            return {}
        return dict(kv.split("=", 1) for kv in raw if "=" in kv)
    # macOS: ps -E appends the environment to the command line.
    return {k: v for k, v in re.findall(r"(?:^|\s)([A-Z][A-Z0-9_]*)=(\S*)", sh(["ps", "-Eww", "-o", "command=", "-p", str(pid)]))}


def cwd_of(pid):
    if PROC:
        try:
            return os.readlink("/proc/%d/cwd" % pid)
        except OSError:
            return None
    m = re.search(r"^n(.*)$", sh(["lsof", "-a", "-p", str(pid), "-d", "cwd", "-Fn"]), re.M)
    return m.group(1) if m else None


def started_of(pid):
    if PROC:
        try:
            ticks = int(open("/proc/%d/stat" % pid).read().rsplit(")", 1)[1].split()[19])
            return (BOOT + ticks // HZ) * 1000
        except Exception:
            return None
    m = re.match(r"\s*(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)", sh(["ps", "-o", "etime=", "-p", str(pid)]))
    if not m:
        return None
    d, h, mi, s = (int(x or 0) for x in m.groups())
    return NOW - ((d * 24 + h) * 3600 + mi * 60 + s) * 1000


def ppid_of(pid):
    if PROC:
        try:
            return int(open("/proc/%d/stat" % pid).read().rsplit(")", 1)[1].split()[1])
        except Exception:
            return None
    try:
        return int(sh(["ps", "-o", "ppid=", "-p", str(pid)]).strip())
    except ValueError:
        return None


def files_of(pid):
    if PROC:
        out = []
        try:
            for fd in os.listdir("/proc/%d/fd" % pid):
                try:
                    out.append(os.readlink("/proc/%d/fd/%s" % (pid, fd)))
                except OSError:
                    pass
        except OSError:
            pass
        return out
    return re.findall(r"^n(.*)$", sh(["lsof", "-a", "-p", str(pid), "-Fn"]), re.M)


def in_herdr(env):
    return "HC_TERMINAL_ID" in env


def where_of(env):
    if any(k.startswith("PI_VSCODE_") for k in env) or env.get("TERM_PROGRAM") == "vscode" or "VSCODE_PID" in env:
        return "vscode"
    return "terminal"


cache_changed = False
try:
    cache = json.load(open(CACHE))
except Exception:
    cache = {}


def cached(key, size, read):
    """read() -> dict, again only when the file grew and 5 min passed (or never read)."""
    global cache_changed
    c = cache.get(key) or {}
    if size and ("read" not in c or (c.get("size") != size and NOW - c.get("read", 0) > 300000)):
        try:
            c = dict(read(), size=size, read=NOW)
            cache[key] = c
            cache_changed = True
        except OSError:
            pass
    return c


out = []

# ---- Claude Code: ~/.claude/sessions/<pid>.json says it all ------------------


def claude_prompt(e):
    if e.get("type") != "user" or e.get("isMeta") or e.get("isSidechain"):
        return None
    c = (e.get("message") or {}).get("content")
    if isinstance(c, str):
        return typed(c)
    if isinstance(c, list) and not any(isinstance(p, dict) and p.get("type") == "tool_result" for p in c):
        return typed(" ".join(p.get("text", "") for p in c if isinstance(p, dict) and p.get("type") == "text"))
    return None


def claude_titles(path):
    title = first = last = None
    with open(path, "rb") as f:
        for raw in f:
            if b'"ai-title"' not in raw and b'"type":"user"' not in raw:
                continue
            try:
                e = json.loads(raw)
            except ValueError:
                continue
            if e.get("type") == "ai-title" and e.get("aiTitle"):
                title = e["aiTitle"]
            else:
                p = claude_prompt(e)
                if p:
                    first = first or p
                    last = p
    return {"title": title, "first": first, "last": last}


for f in glob.glob(os.path.join(HOME, ".claude", "sessions", "*.json")):
    try:
        s = json.load(open(f))
        pid = int(s.get("pid") or os.path.basename(f).split(".")[0])
    except Exception:
        continue
    if PROC:
        try:
            if s.get("procStart") and open("/proc/%d/stat" % pid).read().rsplit(")", 1)[1].split()[19] != str(s["procStart"]):
                continue  # the pid was reused
        except (OSError, IndexError):
            continue
    else:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            continue
        except PermissionError:
            pass
    env = env_of(pid)
    if in_herdr(env) or not s.get("sessionId"):
        continue
    entry = s.get("entrypoint") or ""
    if entry == "claude-desktop":
        continue  # the Claude app lists its own
    sid, cwd = s["sessionId"], s.get("cwd") or HOME
    path = os.path.join(HOME, ".claude", "projects", re.sub(r"[^A-Za-z0-9]", "-", cwd), sid + ".jsonl")
    size, at = stat(path)
    c = cached(sid, size, lambda: claude_titles(path))
    where = "vscode" if entry == "claude-vscode" else "sdk" if entry.startswith("sdk") else "terminal" if entry == "cli" else entry
    out.append({
        "agent": "claude", "where": where, "pid": pid, "session": sid, "cwd": cwd, "status": s.get("status"),
        "name": s.get("name") if s.get("nameSource") not in (None, "derived") else None,
        "title": c.get("title"), "first": c.get("first"), "last": c.get("last"), "version": s.get("version"),
        "started": s.get("startedAt"), "updated": s.get("statusUpdatedAt") or s.get("updatedAt"), "at": at,
    })

# ---- Codex and pi: found by process ------------------------------------------

ALL = procs()
base = lambda p: os.path.basename(p or "")


def is_codex(p):
    # The native binary only: its npm wrapper (node) and shell wrappers would count it twice.
    return "codex" in base(p["argv"][0]) and base(exe_of(p)) == "codex"


def is_pi(p):
    a0 = base(p["argv"][0])
    if a0 == "pi" and base(exe_of(p)).startswith(("node", "bun")):
        return True
    return a0.startswith(("node", "bun")) and any(a.endswith("/bin/pi") or "/pi-coding-agent/" in a for a in p["argv"][1:3])


index = None


def codex_names():
    global index
    if index is None:
        index = {}
        for e in tail(os.path.join(HOME, ".codex", "session_index.jsonl")):
            if e.get("id") and e.get("thread_name"):
                index[e["id"]] = e["thread_name"]
    return index


def codex_said(e):
    """What the person typed: an event_msg user_message (older Codex) or a user response_item (newer)."""
    p = e.get("payload") or {}
    if e.get("type") == "event_msg" and p.get("type") == "user_message":
        return typed(p.get("message"))
    if e.get("type") == "response_item" and p.get("type") == "message" and p.get("role") == "user":
        return typed(" ".join(x.get("text", "") for x in p.get("content") or [] if isinstance(x, dict)))
    return None


def codex_head(path):
    meta, first = {}, None
    with open(path, "rb") as f:
        try:
            meta = json.loads(f.readline()).get("payload") or {}
        except ValueError:
            pass
        data = f.read(1048576)
    for raw in data.split(b"\n"):
        if b'"user_message"' not in raw and b'"role":"user"' not in raw:
            continue
        try:
            first = codex_said(json.loads(raw))
        except ValueError:
            continue
        if first:
            break
    src = meta.get("source")
    sub = bool(meta.get("parent_thread_id")) or (isinstance(src, dict) and "subagent" in src) or meta.get("thread_source") not in (None, "user")
    return {"first": first, "cwd": meta.get("cwd"), "originator": meta.get("originator"), "version": meta.get("cli_version"),
            "began": ms_of(meta.get("timestamp") or ""), "sub": sub}


def codex_state(path, n=TAIL):
    status, updated, last, seen = "idle", None, None, False
    for e in tail(path, n):
        p = e.get("payload") or {}
        last = codex_said(e) or last
        t = p.get("type") if e.get("type") == "event_msg" else None
        if not t:
            continue
        seen = seen or t.startswith("task_") or t == "turn_aborted"
        if t == "task_started":
            status, updated = "busy", ms_of(e.get("timestamp") or "")
        elif t in ("task_complete", "turn_aborted"):
            status, updated = "idle", ms_of(e.get("timestamp") or "")
        elif "approval_request" in t or t == "request_user_input":
            status, updated = "waiting", ms_of(e.get("timestamp") or "")
        elif t in ("exec_command_begin", "agent_message", "agent_reasoning") and status == "waiting":
            status = "busy"
    if not seen and n < 4194304:
        return codex_state(path, 4194304)  # one long turn: its start is further back
    return status, updated, last


def pi_dir(cwd):
    return os.path.join(HOME, ".pi", "agent", "sessions", "--" + cwd.strip("/").replace("/", "-") + "--")


def pi_created(path):
    m = re.match(r"(\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d)", os.path.basename(path))
    return ms_of(m.group(1).replace("-", ":").replace(":", "-", 2)) if m else None


def pi_head(path):
    first = name = None
    for e in lines(path, 0, 1048576):
        if e.get("type") in ("session_info", "session_name") and e.get("name"):
            name = e["name"]
        m = e.get("message") or {}
        if e.get("type") == "message" and m.get("role") == "user" and not first:
            c = m.get("content")
            first = typed(c if isinstance(c, str) else " ".join(x.get("text", "") for x in c or [] if isinstance(x, dict)))
    return {"first": first, "name": name}


def pi_state(path):
    status, updated, last = "idle", None, None
    for e in tail(path):
        m = e.get("message") or {}
        if e.get("type") != "message":
            continue
        role, at = m.get("role"), ms_of(e.get("timestamp") or "")
        if role == "user":
            status, updated = "busy", at
            c = m.get("content")
            last = typed(c if isinstance(c, str) else " ".join(x.get("text", "") for x in c or [] if isinstance(x, dict))) or last
        elif role == "toolResult":
            status, updated = "busy", at
        elif role == "assistant":
            status, updated = ("busy" if m.get("stopReason") == "toolUse" else "idle"), at
    return status, updated, last


def codex_recent(cwd, since, taken):
    """Rollouts in this folder written since `since`, newest first (for a Codex that keeps none open)."""
    days = {time.strftime("%Y/%m/%d", time.localtime(t)) for t in (NOW / 1000, NOW / 1000 - 86400, since / 1000)}
    found = []
    for d in days:
        for f in glob.glob(os.path.join(HOME, ".codex", "sessions", d, "rollout-*.jsonl")):
            size, at = stat(f)
            if f in taken or (at or 0) < since - 2000:
                continue
            m = UUID.search(f)
            c = cached("codex:" + (m.group(1) if m else f), size, lambda: codex_head(f))
            if c.get("cwd") == cwd and not c.get("sub"):
                found.append((at, f))
    return [f for _, f in sorted(found, reverse=True)]


pis = []
codexes = [p for p in ALL if is_codex(p)]
codex_pids = {p["pid"] for p in codexes}
parents = {p["pid"]: ppid_of(p["pid"]) for p in codexes}
codex_taken = set()
for p in ALL:
    if p["pid"] in codex_pids:
        if parents.get(p["pid"]) in codex_pids:
            continue  # a Codex started by a Codex: counted with its parent
        env = env_of(p["pid"])
        if in_herdr(env):
            continue
        family = [p["pid"]] + [k for k, v in parents.items() if v == p["pid"]]
        rollouts = sorted({f for q in family for f in files_of(q) if "/rollout-" in f and f.endswith(".jsonl")})
        started, cwd = started_of(p["pid"]), cwd_of(p["pid"])
        if not rollouts and cwd and started:
            rollouts = codex_recent(cwd, started, codex_taken)[:1]
        codex_taken.update(rollouts)
        if not rollouts:
            out.append({"agent": "codex", "where": where_of(env), "pid": p["pid"], "session": "codex-%d" % p["pid"], "cwd": cwd,
                        "status": "idle", "name": None, "title": "New session", "first": None, "last": None,
                        "version": None, "started": started, "updated": started, "at": None})
        for f in rollouts:
            m = UUID.search(f)
            sid = m.group(1) if m else f
            size, at = stat(f)
            c = cached("codex:" + sid, size, lambda: codex_head(f))
            if c.get("sub"):
                continue  # a reviewer or sub-agent thread the session runs for itself
            status, updated, last = codex_state(f)
            orig = c.get("originator") or ""
            where = "vscode" if "vscode" in orig else "sdk" if "sdk" in orig else where_of(env)
            out.append({"agent": "codex", "where": where, "pid": p["pid"], "session": sid, "cwd": c.get("cwd") or cwd,
                        "status": status, "name": codex_names().get(sid), "title": None, "first": c.get("first"), "last": last,
                        "version": c.get("version"), "started": c.get("began") or started, "updated": updated or at, "at": at})
    elif is_pi(p):
        env = env_of(p["pid"])
        if not in_herdr(env):
            pis.append({"pid": p["pid"], "env": env, "cwd": cwd_of(p["pid"]) or HOME, "started": started_of(p["pid"]) or 0, "argv": p["argv"]})

# pi keeps no file open: a process gets the session in its folder written since it started.
# The newest process takes a file created after it started first; the rest take the newest written one.
taken = set()
for cwd in {x["cwd"] for x in pis}:
    files = sorted(glob.glob(os.path.join(pi_dir(cwd), "*.jsonl")), key=lambda f: stat(f)[1] or 0, reverse=True)
    mine = sorted([x for x in pis if x["cwd"] == cwd], key=lambda x: x["started"], reverse=True)
    for x in mine:
        explicit = next((a for a in x["argv"] if a.endswith(".jsonl")), None)
        if explicit:
            x["file"] = explicit
        else:
            new = [f for f in files if f not in taken and (pi_created(f) or 0) >= x["started"] - 2000]
            x["file"] = new[0] if new else None
        if x.get("file"):
            taken.add(x["file"])
    for x in mine:
        if not x.get("file"):
            old = [f for f in files if f not in taken and (stat(f)[1] or 0) >= x["started"] - 2000]
            x["file"] = old[0] if old else None
            if x["file"]:
                taken.add(x["file"])
for x in pis:
    f = x.get("file")
    common = {"agent": "pi", "where": where_of(x["env"]), "pid": x["pid"], "cwd": x["cwd"], "version": None, "started": x["started"]}
    if not f:
        out.append(dict(common, session="pi-%d" % x["pid"], status="idle", name=None, title="New session", first=None, last=None,
                        updated=x["started"], at=None))
        continue
    size, at = stat(f)
    m = UUID.search(f)
    sid = m.group(1) if m else os.path.basename(f)
    c = cached("pi:" + sid, size, lambda: pi_head(f))
    status, updated, last = pi_state(f)
    out.append(dict(common, session=sid, status=status, name=c.get("name"), title=None, first=c.get("first"), last=last,
                    updated=updated or at, at=at))

live = {("" if a["agent"] == "claude" else a["agent"] + ":") + a["session"] for a in out}
if cache_changed or any(k not in live for k in cache):
    cache = {k: v for k, v in cache.items() if k in live}
    try:
        os.makedirs(os.path.dirname(CACHE), exist_ok=True)
        tmp = CACHE + ".tmp"
        json.dump(cache, open(tmp, "w"))
        os.replace(tmp, CACHE)
    except OSError:
        pass
print(json.dumps({"now": NOW, "agents": out}))
