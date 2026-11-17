#!/bin/bash
# Start a new Claude Code session with Remote Control, to open in claude.ai/code or the Claude app.
# Arguments: <name> <folder> [<conversation id to fork> | -] [<first prompt, base64>]
# Runs `claude --remote-control <name>` in tmux session cc-<name> as ubuntu. When Claude Code exits, the session ends.
exec sudo -u ubuntu -H python3 - "$@" <<'PY'
import base64, glob, json, os, re, shlex, subprocess, sys, uuid

HOME = "/home/ubuntu"
CLAUDE = f"{HOME}/.local/bin/claude"

def fail(msg, code=2):
    print(msg, file=sys.stderr)
    sys.exit(code)

argv = sys.argv[1:]
arg = lambda i, default: argv[i] if len(argv) > i and argv[i] else default
name, folder, fork, prompt_b64 = arg(0, ""), arg(1, HOME), arg(2, "-"), arg(3, "")

if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,39}", name):
    fail("invalid session name: letters, digits, - and _, up to 40 characters")
folder = os.path.realpath(folder)
if not (folder == HOME or folder.startswith(HOME + "/")) or not os.path.isdir(folder):
    fail(f"not a folder under {HOME}: {folder}")
if fork != "-":
    if not re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", fork) or not glob.glob(f"{HOME}/.claude/projects/*/{fork}.jsonl"):
        fail(f"no conversation {fork}")
try:
    prompt = base64.b64decode(prompt_b64, validate=True).decode("utf-8") if prompt_b64 else ""
except ValueError:
    fail("the prompt is not valid base64")

session = f"cc-{name}"
if subprocess.run(["tmux", "has-session", "-t", f"={session}"], capture_output=True).returncode == 0:
    fail(f"a session named {name} already exists", 3)

# The folder trust prompt would block a session nobody is looking at: choosing the folder here is the trust decision.
# Same as claude-trust-home (infra/ec2/user-data.sh) does for $HOME at boot.
cfg = f"{HOME}/.claude.json"
try:
    with open(cfg) as f:
        d = json.load(f)
    p = d.setdefault("projects", {}).setdefault(folder, {})
    if not p.get("hasTrustDialogAccepted"):
        p["hasTrustDialogAccepted"] = True
        tmp = cfg + ".spawn.tmp"
        with open(tmp, "w") as f:
            json.dump(d, f, indent=2)
        os.chmod(tmp, 0o600)
        os.replace(tmp, cfg)
except FileNotFoundError:
    fail("Claude Code has not been set up on this instance yet (no ~/.claude.json): attach once and /login", 4)

conversation = str(uuid.uuid4())
cmd = [CLAUDE, "--remote-control", name, "--session-id", conversation]
if fork != "-":
    cmd += ["--resume", fork, "--fork-session"]
if prompt:
    cmd.append(prompt)
r = subprocess.run(["tmux", "new-session", "-d", "-s", session, "-c", folder, "-x", "200", "-y", "50",
                    "bash -lc " + shlex.quote(shlex.join(cmd))], capture_output=True, text=True)
if r.returncode != 0:
    fail(f"tmux: {r.stderr.strip()}", 1)
subprocess.run(["tmux", "set-option", "-t", f"={session}", "@conversation", conversation], capture_output=True)
print(json.dumps({"name": name, "folder": folder, "conversation": conversation, "forkedFrom": None if fork == "-" else fork}))
PY
