#!/bin/bash
# Log Claude Code in on the instance without a terminal (runs as root): `claude auth login` as ubuntu in the tmux
# session "login-claude", which prints a sign-in URL and waits for the code claude.ai shows after sign-in.
# Arguments: start | code <code, base64> | cancel
#   start   (re)starts the login and prints JSON {"url": …}
#   code    types the code in, waits for the answer and prints JSON {"loggedIn", "loginExpiresAt", "mainRestarted"};
#           when Claude Code is then logged in and the main session is not running, restarts it (claude-tmux.service)
#   cancel  ends a login in progress
# The session name must not start with "claude" (tmux would match `-t claude` to it) nor "cc-" (spawned sessions).
exec python3 - "$@" <<'PY'
import base64, glob, json, os, re, shlex, subprocess, sys, time

HOME = "/home/ubuntu"
CLAUDE = f"{HOME}/.local/bin/claude"
SESSION = "login-claude"
URL = re.compile(r"https://claude\.(?:ai|com)/\S+")
DONE = re.compile(r"\[login exit (\d+)\]")

def fail(msg, code=2):
    print(msg, file=sys.stderr)
    sys.exit(code)

def as_ubuntu(*cmd):
    return subprocess.run(["sudo", "-u", "ubuntu", "-H", *cmd], capture_output=True, text=True)

def tmux(*args):
    return as_ubuntu("tmux", *args)

def pane():
    r = tmux("capture-pane", "-p", "-J", "-S", "-200", "-t", f"={SESSION}:")
    return r.stdout if r.returncode == 0 else None

def auth_status():
    r = as_ubuntu(CLAUDE, "auth", "status")
    try:
        return json.loads(r.stdout)
    except ValueError:
        return {}

def main_running():
    """Whether Claude Code runs in the main tmux session "claude" (each process describes itself in ~/.claude/sessions)."""
    for path in glob.glob(f"{HOME}/.claude/sessions/[0-9]*.json"):
        try:
            with open(path) as f:
                p = json.load(f)
        except (OSError, ValueError):
            continue
        if isinstance(p.get("pid"), int) and os.path.exists(f"/proc/{p['pid']}") and str(p.get("tmux", "")).startswith("claude:"):
            return True
    return False

argv = sys.argv[1:]
action = argv[0] if argv else ""

if action == "cancel":
    tmux("kill-session", "-t", f"={SESSION}")
    print(json.dumps({"cancelled": True}))

elif action == "start":
    tmux("kill-session", "-t", f"={SESSION}")
    # Wide, so the URL is not wrapped; the pane stays a while after the login ends, to read its answer.
    cmd = f"{CLAUDE} auth login --claudeai; rc=$?; echo; echo \"[login exit $rc]\"; sleep 900"
    r = tmux("new-session", "-d", "-s", SESSION, "-c", HOME, "-x", "500", "-y", "50", "bash -lc " + shlex.quote(cmd))
    if r.returncode != 0:
        fail(f"tmux: {r.stderr.strip()}", 1)
    deadline = time.time() + 15
    while time.time() < deadline:
        time.sleep(0.5)
        text = pane() or ""
        m = URL.search(text)
        if m and "Paste code" in text:
            print(json.dumps({"url": m.group(0)}))
            sys.exit(0)
        if DONE.search(text):
            break
    tmux("kill-session", "-t", f"={SESSION}")
    fail("claude auth login did not show a sign-in URL: " + " ".join((pane() or text or "").split())[-300:], 1)

elif action == "code":
    try:
        code = base64.b64decode(argv[1] if len(argv) > 1 else "", validate=True).decode("utf-8").strip()
    except ValueError:
        fail("the code is not valid base64")
    if not re.fullmatch(r"[A-Za-z0-9_#.~-]{8,1000}", code):
        fail("that does not look like a sign-in code: paste the whole code claude.ai shows")
    text = pane()
    if text is None or "Paste code" not in text or DONE.search(text):
        fail("no login in progress: start it again", 3)
    tmux("send-keys", "-t", f"={SESSION}:", "-l", code)
    tmux("send-keys", "-t", f"={SESSION}:", "Enter")
    deadline = time.time() + 15
    m = None
    while time.time() < deadline and not m:
        time.sleep(0.5)
        text = pane() or ""
        m = DONE.search(text)
    if not m:
        fail("claude auth login did not answer in time; check the status, or start again", 1)
    tmux("kill-session", "-t", f"={SESSION}")
    if m.group(1) != "0":
        after = text.split(code, 1)[-1]
        why = next((l.strip() for l in after.splitlines() if "log in" in l.lower() or "error" in l.lower()), "")
        fail(why or "the login failed: start it again", 3)
    s = auth_status()
    restarted = False
    if s.get("loggedIn") and not main_running():
        restarted = subprocess.run(["systemctl", "restart", "claude-tmux.service"], capture_output=True).returncode == 0
    print(json.dumps({"loggedIn": bool(s.get("loggedIn")), "loginExpiresAt": s.get("loginExpiresAt"), "mainRestarted": restarted}))

else:
    fail("usage: login.sh start | code <base64 code> | cancel")
PY
