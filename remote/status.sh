#!/bin/bash
# Status of the Claude Code instance, as JSON (runs as root). Mirrors claude-autostop's rules (infra/ec2/user-data.sh):
# it checks every 5 minutes, then waits GRACE_MINUTES before the shutdown.
exec python3 - "$@" <<'PY'
import calendar, glob, json, os, shutil, subprocess, time

def run(*cmd):
    r = subprocess.run(cmd, capture_output=True, text=True)
    return r.returncode, r.stdout

def tmux(*args):
    return run("sudo", "-u", "ubuntu", "tmux", *args)

now = int(time.time())
uptime = int(float(open("/proc/uptime").read().split()[0]))
boot = now - uptime
load = [float(x) for x in open("/proc/loadavg").read().split()[:3]]
mem = {}
for line in open("/proc/meminfo"):
    k, v = line.split(":")
    mem[k] = int(v.split()[0]) * 1024
disk = shutil.disk_usage("/")

code, _ = tmux("has-session", "-t", "claude")
_, clients = tmux("list-clients", "-t", "claude")
_, sessions = tmux("list-sessions", "-F", "#{session_name}")

out = {
    "now": now,
    "bootTime": boot,
    "load": load,
    "memory": {"total": mem.get("MemTotal", 0), "available": mem.get("MemAvailable", 0)},
    "disk": {"total": disk.total, "used": disk.used},
    "claude": {
        "running": code == 0,
        "clients": len(clients.splitlines()) if code == 0 else 0,
        "spawned": sum(1 for s in sessions.split() if s.startswith("cc-")),
    },
}

# Claude Code's login (claude.ai): without it no session starts. It lasts about a month (loginExpiresAt), then has
# to be renewed (remote/login.sh). A login in progress is the tmux session "login-claude".
def auth():
    r = subprocess.run(["sudo", "-u", "ubuntu", "-H", "/home/ubuntu/.local/bin/claude", "auth", "status"], capture_output=True, text=True, timeout=20)
    s = json.loads(r.stdout)
    expires = s.get("loginExpiresAt")
    if expires:
        expires = calendar.timegm(time.strptime(expires[:19], "%Y-%m-%dT%H:%M:%S"))
    return {"loggedIn": bool(s.get("loggedIn")), "method": s.get("authMethod"), "expiresAt": expires or None}

try:
    out["auth"] = auth()
except Exception as e:  # unknown: not shown as logged out
    out["auth"] = {"loggedIn": None, "error": str(e)[:200]}
out["auth"]["loginInProgress"] = tmux("has-session", "-t", "=login-claude")[0] == 0

conf = {"IDLE_MINUTES": 60, "MAX_UPTIME_HOURS": 8, "LOAD_THRESHOLD": 0.5, "GRACE_MINUTES": 5}
if not os.path.exists("/usr/local/bin/claude-autostop"):
    out["autostop"] = {"installed": False}
else:
    try:
        for line in open("/etc/default/claude-autostop"):
            line = line.split("#")[0].strip()
            if "=" in line:
                k, v = line.split("=", 1)
                if k in conf:
                    conf[k] = float(v) if "." in v else int(v)
    except FileNotFoundError:
        pass
    idle_s, grace_s, cap_h = conf["IDLE_MINUTES"] * 60, conf["GRACE_MINUTES"] * 60, conf["MAX_UPTIME_HOURS"]
    try:
        snooze = int(open("/run/claude-autostop.snooze").read().strip())
    except (FileNotFoundError, ValueError):
        snooze = 0
    mtimes = [os.path.getmtime(p) for p in glob.glob("/home/ubuntu/.claude/projects/**/*.jsonl", recursive=True)]
    last = int(max(mtimes)) if mtimes else 0
    a = {
        "installed": True,
        "idleMinutes": conf["IDLE_MINUTES"],
        "maxUptimeHours": cap_h,
        "graceMinutes": conf["GRACE_MINUTES"],
        "loadThreshold": conf["LOAD_THRESHOLD"],
        "lastActivity": last or None,
        "snoozedUntil": snooze if snooze > now else None,
        "shutdownScheduled": False,
    }
    scheduled = "/run/systemd/shutdown/scheduled"
    if os.path.exists(scheduled):
        usec = next((l.split("=", 1)[1] for l in open(scheduled) if l.startswith("USEC=")), "0")
        a.update(shutdownScheduled=True, stopsAt=int(usec) // 1_000_000, reason="shutdown already scheduled")
    else:
        at = max(last + idle_s, boot + idle_s, snooze, now)
        reason = "if Claude stays idle"
        if cap_h > 0:
            cap = max(boot + cap_h * 3600, snooze)
            if cap <= at:
                at, reason = cap, f"{cap_h}h uptime cap"
        a.update(stopsAt=at + grace_s, reason=reason, estimate=True)
    # Times as the instance shows them (UTC), for the CLI.
    a["stopsAtText"] = time.strftime("%H:%M %Z", time.localtime(a["stopsAt"]))
    if a["snoozedUntil"]:
        a["snoozedUntilText"] = time.strftime("%H:%M %Z", time.localtime(a["snoozedUntil"]))
    out["autostop"] = a

print(json.dumps(out))
PY
