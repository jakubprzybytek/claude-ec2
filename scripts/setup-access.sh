#!/usr/bin/env bash
# One-off setup that needs admin credentials (bash; run from the repo root on a machine with this repo, `npm ci` done,
# gh logged in, and the agent-playbook skills installed, e.g. the Claude Code instance):
#   aws login --profile admin        (or any admin credentials)
#   AWS_PROFILE=admin scripts/setup-access.sh <your Cognito username / email>
#
# 1. The GitHub deploy role GitHub-claude-ec2, its policy and the permissions boundary (aws-github-deploy), dry run
#    first, then after a yes.
# 2. The group claude-ec2 (full access) with you in it.
# 3. The read-only test user claude-ec2-test@albedoonline.com in group claude-ec2-test; its new random password goes
#    only into the SST secret TestUserPassword of int (never printed). Safe to re-run: it rotates the password.
set -euo pipefail

ME=${1:?usage: scripts/setup-access.sh <your Cognito username or email>}
POOL=eu-west-1_IVai0KEAA
TEST_USER=claude-ec2-test@albedoonline.com
export AWS_REGION=eu-west-1 AWS_PAGER=""
SETUP_ROLE=~/.claude/skills/aws-github-deploy/scripts/setup-role.sh

[ -f sst.config.ts ] && [ -x node_modules/.bin/sst ] || { echo "Run from the claude-ec2 repo root after npm ci" >&2; exit 1; }
who=$(aws sts get-caller-identity --query Arn --output text)
echo "AWS identity: $who"
case "$who" in *assumed-role/claude-code-ec2/*) echo "That is the instance role; sign in with admin credentials first (aws login)" >&2; exit 1 ;; esac

echo; echo "== 1. Deploy role (dry run)"
"$SETUP_ROLE" claude-ec2 --dry-run
read -r -p "Apply this? [y/N] " ok
[ "$ok" = y ] || { echo "Stopped before changing anything"; exit 1; }
"$SETUP_ROLE" claude-ec2

group() { # <name> <description>
  aws cognito-idp get-group --user-pool-id $POOL --group-name "$1" > /dev/null 2>&1 ||
    aws cognito-idp create-group --user-pool-id $POOL --group-name "$1" --description "$2" > /dev/null
  echo "group $1 ok"
}

echo; echo "== 2. Your access"
group claude-ec2 "claude-ec2: control the Claude Code instance (root on it)"
aws cognito-idp admin-add-user-to-group --user-pool-id $POOL --username "$ME" --group-name claude-ec2
echo "$ME is in claude-ec2"

echo; echo "== 3. Read-only test user (int only)"
group claude-ec2-test "claude-ec2 test user: read-only, int only"
aws cognito-idp admin-get-user --user-pool-id $POOL --username $TEST_USER > /dev/null 2>&1 ||
  aws cognito-idp admin-create-user --user-pool-id $POOL --username $TEST_USER --message-action SUPPRESS \
    --user-attributes Name=email,Value=$TEST_USER Name=email_verified,Value=true > /dev/null
PW="$(openssl rand -hex 24)Aa1"
aws cognito-idp admin-set-user-password --user-pool-id $POOL --username $TEST_USER --password "$PW" --permanent
aws cognito-idp admin-add-user-to-group --user-pool-id $POOL --username $TEST_USER --group-name claude-ec2-test
# Through stdin, never as an argument: npm (npx, npm run) can print the command lines it runs.
printf %s "$PW" | ./node_modules/.bin/sst secret set TestUserPassword --stage int > /dev/null
unset PW
echo "test user ok, password stored in the int stage's secret"

echo; echo "Done. Tell Claude to continue: deploy int, run the tests, push."
