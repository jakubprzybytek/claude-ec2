#!/usr/bin/env bash
# One-off setup that needs admin credentials. Bash (Git Bash on Windows), from the repo root, with gh logged in and
# the agent-playbook skills installed (~/.claude/skills/aws-github-deploy):
#   AWS_PROFILE=<admin profile> scripts/setup-access.sh <your Cognito username / email>
#
# 1. The GitHub deploy role GitHub-claude-ec2, its policy and the permissions boundary (aws-github-deploy), dry run
#    first, then after a yes.
# 2. The group claude-ec2 (full access) with you in it.
# 3. The read-only test user claude-ec2-test@albedoonline.com in group claude-ec2-test, without a usable password:
#    the password is set on the Claude Code instance, which stores it in the SST secret TestUserPassword of int, so
#    it never leaves AWS. Safe to re-run.
set -euo pipefail

ME=${1:?usage: scripts/setup-access.sh <your Cognito username or email>}
POOL=eu-west-1_IVai0KEAA
TEST_USER=claude-ec2-test@albedoonline.com
export AWS_REGION=eu-west-1 AWS_PAGER=""
SETUP_ROLE=~/.claude/skills/aws-github-deploy/scripts/setup-role.sh

[ -f sst.config.ts ] && [ -f infra/github/deploy-policy.json ] || { echo "Run from the claude-ec2 repo root" >&2; exit 1; }
[ -x "$SETUP_ROLE" ] || [ -f "$SETUP_ROLE" ] || { echo "Missing $SETUP_ROLE (agent-playbook's scripts/install.sh)" >&2; exit 1; }
who=$(aws sts get-caller-identity --query Arn --output text)
echo "AWS identity: $who"
case "$who" in *assumed-role/claude-code-ec2/*) echo "That is the instance role; sign in with admin credentials first (aws login)" >&2; exit 1 ;; esac

echo; echo "== 1. Deploy role (dry run)"
bash "$SETUP_ROLE" claude-ec2 --dry-run
read -r -p "Apply this? [y/N] " ok
[ "$ok" = y ] || { echo "Stopped before changing anything"; exit 1; }
bash "$SETUP_ROLE" claude-ec2

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
aws cognito-idp admin-add-user-to-group --user-pool-id $POOL --username $TEST_USER --group-name claude-ec2-test
echo "test user ok (its password is set on the instance)"

echo; echo "Done. Tell Claude to continue: set the test password, deploy int, run the tests, push."
