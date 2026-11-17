#!/bin/bash
# The tmux sessions running Claude Code, as JSON (runs as root): the main session "claude" and the spawned "cc-<name>".
# Each running Claude Code process describes itself in ~/.claude/sessions/<pid>.json (conversation, tmux pane,
# busy/idle, Remote Control session); the conversation file is the fallback for the claude.ai link.
exec python3 - "$@" <<'PY'
import glob, json, os, re, subprocess

HOME = "/home/ubuntu"
URL = re.compile(rb"https://claude\.ai/code/session_[A-Za-z0-9]+")

def tmux(*args):
    r = subprocess.run(["sudo", "-u", "ubuntu", "-H", "tmux", *args], capture_output=True)
    return r.stdout.decode("utf-8", "replace") if r.returncode == 0 else ""

def last_url(cid):
    if not re.fullmatch(r"[0-9a-f-]{36}", cid or ""):
        return None
    for path in glob.glob(f"{HOME}/.claude/projects/*/{cid}.jsonl"):
        with open(path, "rb") as f:
            size = f.seek(0, 2)
            f.seek(max(0, size - (4 << 20)))
            hits = URL.findall(f.read())
            if hits:
                return hits[-1].decode()
    return None

# Live Claude Code processes by tmux session name.
procs = {}
for path in glob.glob(f"{HOME}/.claude/sessions/[0-9]*.json"):
    try:
        with open(path) as f:
            p = json.load(f)
    except (OSError, ValueError):
        continue
    if not isinstance(p.get("pid"), int) or not os.path.exists(f"/proc/{p['pid']}") or not p.get("tmux"):
        continue
    procs[p["tmux"].split(":", 1)[0]] = p

fmt = "\t".join(["#{session_name}", "#{session_created}", "#{session_attached}", "#{pane_current_path}",
                 "#{@conversation}", "#{session_activity}"])
out = []
for line in tmux("list-sessions", "-F", fmt).splitlines():
    name, created, attached, folder, cid, activity = (line.split("\t") + [""] * 6)[:6]
    if name != "claude" and not name.startswith("cc-"):
        continue
    p = procs.get(name)
    if p:
        cid = p.get("sessionId") or cid
        folder = p.get("cwd") or folder
        bridge = p.get("bridgeSessionId") or ""
        url = f"https://claude.ai/code/{bridge}" if re.fullmatch(r"session_[A-Za-z0-9]+", bridge) else last_url(cid)
        state = p.get("status") or "running"  # busy / idle
    else:
        url = last_url(cid)
        pane = tmux("capture-pane", "-p", "-J", "-t", f"={name}")
        state = "waiting for folder trust" if "trust this folder" in pane else "not running"
    out.append({
        "name": name if name == "claude" else name[3:],
        "main": name == "claude",
        "created": int(created or 0),
        "lastActivity": int(activity or 0),
        "attached": int(attached or 0),
        "folder": folder,
        "state": state,
        "conversation": cid or None,
        "url": url,
    })
print(json.dumps({"sessions": out}))
PY
