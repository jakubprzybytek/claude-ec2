#!/bin/bash
# Postpone the auto-stop limits by <hours> (and cancel a pending auto-stop). Runs as root.
set -euo pipefail
hours=${1:-2}
[[ "$hours" =~ ^[0-9]{1,2}$ ]] && [ "$hours" -ge 1 ] && [ "$hours" -le 24 ] || { echo "hours must be 1-24" >&2; exit 2; }
command -v claude-autostop >/dev/null || { echo "auto-stop is not installed on this instance" >&2; exit 1; }
claude-autostop snooze "$hours"
