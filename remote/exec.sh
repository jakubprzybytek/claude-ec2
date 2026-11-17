#!/bin/bash
# Run a command as ubuntu (login shell, in $HOME) and print its output. Argument: the command, base64-encoded.
set -uo pipefail
cmd=$(printf '%s' "${1:?command}" | base64 -d) || { echo "the command is not valid base64" >&2; exit 2; }
cd /home/ubuntu && exec sudo -u ubuntu -H bash -lc "$cmd"
