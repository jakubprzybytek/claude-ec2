#!/bin/bash
set -euxo pipefail
exec > >(tee /var/log/user-data.log) 2>&1

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y unzip curl git ripgrep tmux

# 4 GB swap file so memory-heavy builds slow down instead of being OOM-killed
if [ ! -f /swapfile ]; then
  fallocate -l 4G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
swapon --show | grep -q /swapfile || swapon /swapfile
echo 'vm.swappiness=10' > /etc/sysctl.d/99-swappiness.conf
sysctl -p /etc/sysctl.d/99-swappiness.conf

# Install AWS CLI v2
curl -sSL "https://awscli.amazonaws.com/awscli-exe-linux-$(uname -m).zip" -o /tmp/awscliv2.zip
unzip -q /tmp/awscliv2.zip -d /tmp
/tmp/aws/install
rm -rf /tmp/aws /tmp/awscliv2.zip

# Install GitHub CLI
mkdir -p -m 755 /etc/apt/keyrings
curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg
chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list
apt-get update -y
apt-get install -y gh

# Install Node.js LTS (NodeSource) + Corepack for pnpm/yarn
curl -fsSL https://deb.nodesource.com/setup_lts.x | bash -
apt-get install -y nodejs
npm install -g corepack
corepack enable

# Install Claude Code (native installer) for the ubuntu user
sudo -u ubuntu -i bash -c 'curl -fsSL https://claude.ai/install.sh | bash'
grep -q '.local/bin' /home/ubuntu/.bashrc || echo 'export PATH="$HOME/.local/bin:$PATH"' >> /home/ubuntu/.bashrc

# GitHub auth for the ubuntu user, re-run on every boot to pick up a rotated token
cat > /var/lib/cloud/scripts/per-boot/github-auth.sh <<'SETUP'
#!/bin/bash
set -euo pipefail
TOKEN=$(aws ssm get-parameter --region eu-west-1 --name /claude-code/github-token --with-decryption --query Parameter.Value --output text)
printf '%s' "$TOKEN" | sudo -u ubuntu -H gh auth login --hostname github.com --git-protocol https --with-token
sudo -u ubuntu -H gh auth setup-git

# Commit identity from the token's GitHub account (noreply email if the public one is hidden)
login=$(sudo -u ubuntu -H gh api user --jq .login)
id=$(sudo -u ubuntu -H gh api user --jq .id)
name=$(sudo -u ubuntu -H gh api user --jq '.name // .login')
email=$(sudo -u ubuntu -H gh api user --jq '.email // ""')
[ -n "$email" ] || email="${id}+${login}@users.noreply.github.com"
sudo -u ubuntu -H git config --global user.name "$name"
sudo -u ubuntu -H git config --global user.email "$email"
echo "GitHub auth configured for $login"
SETUP
chmod 755 /var/lib/cloud/scripts/per-boot/github-auth.sh
/var/lib/cloud/scripts/per-boot/github-auth.sh || echo "WARNING: GitHub auth setup failed"

# Claude Code never persists folder trust for $HOME, so pre-accept it before each session start
cat > /usr/local/bin/claude-trust-home <<'PY'
#!/usr/bin/env python3
import json, os
p = os.path.expanduser('~/.claude.json')
try:
    d = json.load(open(p))
except FileNotFoundError:
    raise SystemExit(0)  # first run: onboarding/login not done yet
d.setdefault('projects', {}).setdefault(os.path.expanduser('~'), {})['hasTrustDialogAccepted'] = True
tmp = p + '.tmp'
json.dump(d, open(tmp, 'w'), indent=2)
os.chmod(tmp, 0o600)
os.replace(tmp, p)
PY
chmod 755 /usr/local/bin/claude-trust-home

# Persistent Claude Code session in tmux (attach: sudo -u ubuntu tmux attach -t claude)
cat > /etc/systemd/system/claude-tmux.service <<'UNIT'
[Unit]
Description=Claude Code in tmux session "claude"
After=network-online.target
Wants=network-online.target

[Service]
Type=forking
User=ubuntu
WorkingDirectory=/home/ubuntu
ExecStartPre=-/usr/local/bin/claude-trust-home
# Resume the most recent conversation; start a new one if there is none
ExecStart=/usr/bin/tmux new-session -d -s claude "bash -lc '/home/ubuntu/.local/bin/claude --continue || /home/ubuntu/.local/bin/claude; exec bash -l'"
ExecStop=/usr/bin/tmux kill-session -t claude
# An OOM kill of one process (e.g. claude) must not take down the whole session
OOMPolicy=continue
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable claude-tmux.service
systemctl start claude-tmux.service

# Auto-stop fuse: stop the instance when Claude Code is idle, or after a max uptime
cat > /etc/default/claude-autostop <<'CONF'
IDLE_MINUTES=60       # no Claude Code conversation writes and low load for this long
MAX_UPTIME_HOURS=8    # hard cap regardless of activity (0 = off)
LOAD_THRESHOLD=0.5    # 15-min load average above this counts as busy (e.g. builds)
GRACE_MINUTES=5       # warning before the shutdown
CONF
cat > /usr/local/bin/claude-autostop <<'STOP'
#!/bin/bash
# Usage: claude-autostop [check | snooze <hours> | status]
set -u
IDLE_MINUTES=60; MAX_UPTIME_HOURS=8; LOAD_THRESHOLD=0.5; GRACE_MINUTES=5
[ -f /etc/default/claude-autostop ] && . /etc/default/claude-autostop
SNOOZE=/run/claude-autostop.snooze
now=$(date +%s)
up_min=$(( $(cut -d. -f1 /proc/uptime) / 60 ))

case "${1:-check}" in
  snooze)
    h=${2:-2}; echo $(( now + h * 3600 )) > $SNOOZE
    shutdown -c 2>/dev/null || true
    echo "Auto-stop snoozed for ${h}h (until $(date -d @$(cat $SNOOZE) '+%H:%M %Z'))"; exit 0 ;;
  status)
    last=$(find /home/ubuntu/.claude/projects -name '*.jsonl' -printf '%T@\n' 2>/dev/null | sort -n | tail -1 || true)
    echo "uptime: ${up_min} min (cap: ${MAX_UPTIME_HOURS}h) | load15: $(cut -d' ' -f3 /proc/loadavg)"
    [ -n "$last" ] && echo "last Claude activity: $(( (now - ${last%.*}) / 60 )) min ago (idle limit: ${IDLE_MINUTES} min)"
    [ -f $SNOOZE ] && [ "$(cat $SNOOZE)" -gt "$now" ] && echo "snoozed until $(date -d @$(cat $SNOOZE) '+%H:%M %Z')"
    [ -f /run/systemd/shutdown/scheduled ] && echo "shutdown scheduled"
    exit 0 ;;
esac

[ -f /run/systemd/shutdown/scheduled ] && exit 0
[ -f $SNOOZE ] && [ "$(cat $SNOOZE)" -gt "$now" ] && exit 0

reason=""
if [ "$MAX_UPTIME_HOURS" -gt 0 ] && [ $up_min -ge $(( MAX_UPTIME_HOURS * 60 )) ]; then
  reason="up for more than ${MAX_UPTIME_HOURS}h"
elif [ $up_min -ge "$IDLE_MINUTES" ]; then
  recent=$(find /home/ubuntu/.claude/projects -name '*.jsonl' -mmin -"$IDLE_MINUTES" 2>/dev/null | head -1 || true)
  busy=$(awk -v l="$(cut -d' ' -f3 /proc/loadavg)" -v t="$LOAD_THRESHOLD" 'BEGIN{print (l>t)}')
  [ -z "$recent" ] && [ "$busy" = 0 ] && reason="Claude Code idle for ${IDLE_MINUTES} min"
fi
[ -n "$reason" ] || exit 0

logger -t claude-autostop "Stopping instance in ${GRACE_MINUTES} min: $reason"
shutdown -h +"$GRACE_MINUTES" "claude-autostop: stopping in ${GRACE_MINUTES} min ($reason). Postpone: sudo claude-autostop snooze 2"
STOP
chmod 755 /usr/local/bin/claude-autostop
cat > /etc/systemd/system/claude-autostop.service <<'UNIT'
[Unit]
Description=Stop the instance when Claude Code is idle or uptime cap is reached

[Service]
Type=oneshot
ExecStart=/usr/local/bin/claude-autostop check
UNIT
cat > /etc/systemd/system/claude-autostop.timer <<'UNIT'
[Unit]
Description=Check for Claude Code inactivity every 5 minutes

[Timer]
OnBootSec=10min
OnUnitActiveSec=5min

[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now claude-autostop.timer

touch /var/log/user-data.done
