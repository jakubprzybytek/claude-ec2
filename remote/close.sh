#!/bin/bash
# Close a spawned Claude Code session (tmux session cc-<name>). The conversation stays on disk and can be resumed
# or forked later. The main session ("claude", run by claude-tmux.service) is never closed here.
set -euo pipefail
name=${1:?name}
[[ "$name" =~ ^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$ ]] || { echo "invalid session name" >&2; exit 2; }
t() { sudo -u ubuntu -H tmux "$@"; }
t has-session -t "=cc-$name" 2>/dev/null || { echo "no session named $name" >&2; exit 3; }
# Ask Claude Code to exit first (it saves the conversation), then end the tmux session whatever happened.
t send-keys -t "=cc-$name" C-c 2>/dev/null || true
sleep 1
t send-keys -t "=cc-$name" C-c 2>/dev/null || true
sleep 2
t kill-session -t "=cc-$name" 2>/dev/null || true
echo "Closed $name"
