#!/bin/bash
# Recent Claude Code conversations (to fork one into a new session) and the folders a session can start in, as JSON.
# Argument: how many days back (default 14). Reads only the head and tail of each file: they can be tens of MB.
exec python3 - "$@" <<'PY'
import glob, json, os, re, sys, time

HOME = "/home/ubuntu"
days = int(sys.argv[1]) if len(sys.argv) > 1 and sys.argv[1].isdigit() else 14
since = time.time() - days * 86400

def records(data):
    for line in data.splitlines():
        if line.startswith(b"{"):
            try:
                yield json.loads(line)
            except ValueError:
                pass  # a line cut by the head/tail window

def text_of(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return " ".join(c.get("text", "") for c in content if isinstance(c, dict) and c.get("type") == "text")
    return ""

convs = []
for path in glob.glob(f"{HOME}/.claude/projects/*/*.jsonl"):
    st = os.stat(path)
    if st.st_mtime < since:
        continue
    with open(path, "rb") as f:
        head = f.read(256 << 10)
        f.seek(max(0, st.st_size - (2 << 20)))
        tail = f.read()
    c = {"id": os.path.basename(path)[:-6], "modified": int(st.st_mtime), "size": st.st_size,
         "folder": None, "title": None, "firstPrompt": None, "lastPrompt": None, "url": None}
    for r in records(head):
        c["folder"] = c["folder"] or r.get("cwd")
        if not c["firstPrompt"] and r.get("type") == "user" and not r.get("isMeta"):
            t = text_of((r.get("message") or {}).get("content")).strip()
            if t and not t.startswith("<"):
                c["firstPrompt"] = t[:150]
    for r in records(tail):
        t = r.get("type")
        if t == "custom-title":
            c["title"] = r.get("customTitle")
        elif t == "ai-title" and not c["title"]:
            c["title"] = r.get("aiTitle")
        elif t == "last-prompt" and r.get("lastPrompt"):
            c["lastPrompt"] = r["lastPrompt"][:150]
        if str(r.get("url", "")).startswith("https://claude.ai/code/session_"):
            c["url"] = r["url"]
        elif t == "bridge-session" and re.fullmatch(r"cse_[A-Za-z0-9]+", str(r.get("bridgeSessionId", ""))):
            c["url"] = "https://claude.ai/code/session_" + r["bridgeSessionId"][4:]
        c["folder"] = c["folder"] or r.get("cwd")
    if c["firstPrompt"] or c["lastPrompt"] or c["title"]:
        convs.append(c)
convs.sort(key=lambda c: -c["modified"])

# Folders: $HOME and the git repositories one or two levels below it (e.g. ~/repo, ~/repos/repo).
folders = [HOME]
for pattern in (f"{HOME}/*/.git", f"{HOME}/*/*/.git"):
    folders += sorted(os.path.dirname(g) for g in glob.glob(pattern))
# SSM keeps at most 24,000 characters of output: 30 conversations with short prompts stay well below.
print(json.dumps({"conversations": convs[:30], "folders": folders}))
PY
