#!/usr/bin/env bash
# One-off setup that needs admin credentials. Self-contained: needs only bash (Git Bash on Windows), the AWS CLI and
# gh (logged in). From the repo root:
#   AWS_PROFILE=<admin profile> bash scripts/setup-access.sh <your Cognito username / email>
#
# 1. The GitHub deploy role per the aws-github-deploy standard (the same steps as agent-playbook's setup-role.sh):
#    immutable OIDC subject for the repo, policies claude-ec2-Boundary and claude-ec2-Deployment from infra/github/,
#    role GitHub-claude-ec2 trusting only this repo, SST-Deployment + claude-ec2-Deployment attached, GitHub secret
#    AWS_ACCOUNT_ID and variable AWS_REGION. Shows the plan first and changes nothing without a yes.
# 2. The group claude-ec2 (full access) with you in it.
# 3. The read-only test user claude-ec2-test@albedoonline.com in group claude-ec2-test, without a usable password:
#    the password is set on the Claude Code instance, which stores it in the SST secret TestUserPassword of int, so it
#    never leaves AWS.
# Safe to re-run: it updates what exists and never deletes anything (except the oldest non-default policy version
# when IAM's limit of 5 is reached).
set -euo pipefail
export MSYS_NO_PATHCONV=1 AWS_PAGER="" AWS_REGION=eu-west-1

ME=${1:?usage: bash scripts/setup-access.sh <your Cognito username or email>}
OWNER=jakubprzybytek
REPO=claude-ec2
ROLE=GitHub-$REPO
POLICY=$REPO-Deployment
BOUNDARY=$REPO-Boundary
POOL=eu-west-1_IVai0KEAA
TEST_USER=claude-ec2-test@albedoonline.com
DIR=infra/github
PRIVATE=$DIR/private
TAGS="[{\"Key\":\"repo\",\"Value\":\"$OWNER/$REPO\"},{\"Key\":\"managed-by\",\"Value\":\"agent-playbook/aws-github-deploy\"}]"

say() { printf '\n\033[1m==>\033[0m %s\n' "$*"; }

[ -f sst.config.ts ] && [ -f $DIR/deploy-policy.json ] && [ -f $DIR/boundary-policy.json ] ||
  { echo "Run from the claude-ec2 repo root (branch setup or main)" >&2; exit 1; }
command -v aws > /dev/null && command -v gh > /dev/null || { echo "Needs the AWS CLI and gh" >&2; exit 1; }
gh auth status > /dev/null 2>&1 || { echo "gh is not logged in (gh auth login)" >&2; exit 1; }

WHO=$(aws sts get-caller-identity --query Arn --output text)
case "$WHO" in *assumed-role/claude-code-ec2/*) echo "That is the instance role; use admin credentials" >&2; exit 1 ;; esac
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
OWNER_ID=$(gh api "users/$OWNER" --jq .id)
REPO_ID=$(gh api "repos/$OWNER/$REPO" --jq .id)
SUBJECT_PREFIX=$(gh api "repos/$OWNER/$REPO/actions/oidc/customization/sub" --jq .sub_claim_prefix)
EXPECTED="repo:$OWNER@$OWNER_ID/$REPO@$REPO_ID"

exists() { "$@" > /dev/null 2>&1; }
state() { if exists "$@"; then echo "update"; else echo "create"; fi; }

# --- plan ------------------------------------------------------------------------------
cat <<EOF

AWS identity:  $WHO
GitHub repo:   $OWNER/$REPO (OIDC subject prefix: $SUBJECT_PREFIX$([ "$SUBJECT_PREFIX" = "$EXPECTED" ] || echo " -> switch to $EXPECTED"))

Plan:
  IAM policy  $BOUNDARY      $(state aws iam get-policy --policy-arn "arn:aws:iam::$ACCOUNT_ID:policy/$BOUNDARY")  (from $DIR/boundary-policy.json)
  IAM policy  $POLICY    $(state aws iam get-policy --policy-arn "arn:aws:iam::$ACCOUNT_ID:policy/$POLICY")  (from $DIR/deploy-policy.json)
  IAM role    $ROLE        $(state aws iam get-role --role-name "$ROLE")  (trusts only $EXPECTED:*; attached SST-Deployment, $POLICY)
  GitHub      secret AWS_ACCOUNT_ID, variable AWS_REGION=$AWS_REGION
  Cognito     group claude-ec2 $(state aws cognito-idp get-group --user-pool-id $POOL --group-name claude-ec2), add $ME to it
  Cognito     group claude-ec2-test $(state aws cognito-idp get-group --user-pool-id $POOL --group-name claude-ec2-test), user $TEST_USER $(state aws cognito-idp admin-get-user --user-pool-id $POOL --username $TEST_USER) (no password yet)
EOF
exists aws iam get-policy --policy-arn "arn:aws:iam::$ACCOUNT_ID:policy/SST-Deployment" ||
  { echo "The shared policy SST-Deployment is missing in this account" >&2; exit 1; }
exists aws iam get-open-id-connect-provider --open-id-connect-provider-arn "arn:aws:iam::$ACCOUNT_ID:oidc-provider/token.actions.githubusercontent.com" ||
  { echo "The GitHub OIDC provider is missing in this account" >&2; exit 1; }
echo
read -r -p "Apply? [y/N] " ok
[ "$ok" = y ] || { echo "Nothing changed."; exit 1; }

# --- 1. immutable subject -------------------------------------------------------------------
if [ "$SUBJECT_PREFIX" != "$EXPECTED" ]; then
  say "Switching the repo to GitHub's immutable OIDC subject"
  gh api -X PUT "repos/$OWNER/$REPO/actions/oidc/customization/sub" --input - <<<'{"use_default":true,"use_immutable_subject":true}' > /dev/null
  SUBJECT_PREFIX=$(gh api "repos/$OWNER/$REPO/actions/oidc/customization/sub" --jq .sub_claim_prefix)
  [ "$SUBJECT_PREFIX" = "$EXPECTED" ] || { echo "Unexpected subject prefix '$SUBJECT_PREFIX'; stopping before IAM changes" >&2; exit 1; }
fi

# --- 2. render (account number only in the gitignored private/) ------------------------------
mkdir -p $PRIVATE
sed "s/ACCOUNT_ID/$ACCOUNT_ID/g" $DIR/deploy-policy.json > $PRIVATE/deploy-policy.json
sed "s/ACCOUNT_ID/$ACCOUNT_ID/g" $DIR/boundary-policy.json > $PRIVATE/boundary-policy.json
cat > $PRIVATE/trust-policy.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "Federated": "arn:aws:iam::$ACCOUNT_ID:oidc-provider/token.actions.githubusercontent.com" },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" },
        "StringLike": { "token.actions.githubusercontent.com:sub": "$EXPECTED:*" }
      }
    }
  ]
}
EOF

# --- 3. validate --------------------------------------------------------------------------
say "Validating the policies (IAM Access Analyzer)"
for f in $PRIVATE/deploy-policy.json $PRIVATE/boundary-policy.json; do
  findings=$(aws accessanalyzer validate-policy --policy-type IDENTITY_POLICY --policy-document "file://$f" \
    --query 'findings[?findingType==`ERROR` || findingType==`SECURITY_WARNING`].[findingType,issueCode]' --output text)
  [ -z "$findings" ] || { echo "Findings in $f:" >&2; echo "$findings" >&2; exit 1; }
done
echo "ok"

# --- 4. policies (the boundary first: the roles a deploy creates must be able to carry it) -------
publish() { # <name> <file> <description>
  local arn="arn:aws:iam::$ACCOUNT_ID:policy/$1" oldest
  if exists aws iam get-policy --policy-arn "$arn"; then
    if [ "$(aws iam list-policy-versions --policy-arn "$arn" --query 'length(Versions)' --output text)" -ge 5 ]; then
      oldest=$(aws iam list-policy-versions --policy-arn "$arn" --query 'sort_by(Versions[?IsDefaultVersion==`false`], &CreateDate)[0].VersionId' --output text)
      aws iam delete-policy-version --policy-arn "$arn" --version-id "$oldest"
    fi
    say "Publishing a new default version of $1"
    aws iam create-policy-version --policy-arn "$arn" --policy-document "file://$2" --set-as-default --query PolicyVersion.VersionId --output text
    aws iam tag-policy --policy-arn "$arn" --tags "$TAGS"
  else
    say "Creating policy $1"
    aws iam create-policy --policy-name "$1" --policy-document "file://$2" --description "$3" --tags "$TAGS" --query Policy.Arn --output text
  fi
}
publish "$BOUNDARY" $PRIVATE/boundary-policy.json "Permissions boundary of the $OWNER/$REPO app's IAM roles (aws-github-deploy, rule 8)"
publish "$POLICY" $PRIVATE/deploy-policy.json "SST deployment permissions for the $OWNER/$REPO GitHub Actions role"

# --- 5. role and attachments ---------------------------------------------------------------
if exists aws iam get-role --role-name "$ROLE"; then
  say "Updating the trust policy of $ROLE"
  aws iam update-assume-role-policy --role-name "$ROLE" --policy-document "file://$PRIVATE/trust-policy.json"
  aws iam tag-role --role-name "$ROLE" --tags "$TAGS"
else
  say "Creating role $ROLE"
  aws iam create-role --role-name "$ROLE" --assume-role-policy-document "file://$PRIVATE/trust-policy.json" \
    --description "GitHub Actions ($OWNER/$REPO) deploys via SST" --max-session-duration 3600 --tags "$TAGS" --query Role.Arn --output text
fi
for p in SST-Deployment "$POLICY"; do aws iam attach-role-policy --role-name "$ROLE" --policy-arn "arn:aws:iam::$ACCOUNT_ID:policy/$p"; done
extra=$(aws iam list-attached-role-policies --role-name "$ROLE" --query "AttachedPolicies[?PolicyName!='SST-Deployment' && PolicyName!='$POLICY'].PolicyArn" --output text)
[ -z "$extra" ] || echo "WARNING: $ROLE has other attached policies: $extra"

# --- 6. GitHub secret and variable ---------------------------------------------------------
say "Setting GitHub secret AWS_ACCOUNT_ID and variable AWS_REGION"
gh secret set AWS_ACCOUNT_ID -R "$OWNER/$REPO" --body "$ACCOUNT_ID"
gh variable set AWS_REGION -R "$OWNER/$REPO" --body "$AWS_REGION"

# --- 7. Cognito ---------------------------------------------------------------------------
group() { # <name> <description>
  exists aws cognito-idp get-group --user-pool-id $POOL --group-name "$1" ||
    aws cognito-idp create-group --user-pool-id $POOL --group-name "$1" --description "$2" > /dev/null
}
say "Cognito: your access"
group claude-ec2 "claude-ec2: control the Claude Code instance (root on it)"
aws cognito-idp admin-add-user-to-group --user-pool-id $POOL --username "$ME" --group-name claude-ec2
echo "$ME is in claude-ec2"

say "Cognito: read-only test user (int only)"
group claude-ec2-test "claude-ec2 test user: read-only, int only"
exists aws cognito-idp admin-get-user --user-pool-id $POOL --username $TEST_USER ||
  aws cognito-idp admin-create-user --user-pool-id $POOL --username $TEST_USER --message-action SUPPRESS \
    --user-attributes Name=email,Value=$TEST_USER Name=email_verified,Value=true > /dev/null
aws cognito-idp admin-add-user-to-group --user-pool-id $POOL --username $TEST_USER --group-name claude-ec2-test
echo "$TEST_USER is in claude-ec2-test (its password is set on the instance)"

say "Done. Role: arn:aws:iam::$ACCOUNT_ID:role/$ROLE. Tell Claude to continue: set the test password, deploy int, run the tests, push."
