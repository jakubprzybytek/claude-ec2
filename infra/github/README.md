# GitHub Actions deploy role

This repo deploys to AWS following the [aws-github-deploy standard](https://github.com/jakubprzybytek/agent-playbook/blob/main/skills/aws-github-deploy/STANDARD.md).

| | |
|---|---|
| Role | `GitHub-claude-ec2` |
| Policies | `SST-Deployment` (shared), `claude-ec2-Deployment` (this repo, [deploy-policy.json](deploy-policy.json)) |
| Permissions boundary of the app's roles | `claude-ec2-Boundary` ([boundary-policy.json](boundary-policy.json)), set on every role by the `$transform` in `sst.config.ts` |
| SST app name / resource prefix | `claude-ec2` |
| Region | `eu-west-1` |
| Workflows that deploy | `.github/workflows/continuous-delivery.yaml` |
| GitHub | secret `AWS_ACCOUNT_ID`, variable `AWS_REGION` |

`deploy-policy.json` and `boundary-policy.json` have `ACCOUNT_ID` in place of the account number. The rendered policies and the trust policy are in `private/` (gitignored).

## What the project policy covers

- `Identity`, `SstState`: SST's account lookup and state parameters.
- `Buckets`: the site's bucket (`claude-ec2-*`) and SST's asset buckets.
- `Functions`, `Logs`: the API function (`claude-ec2-*`) and its log groups.
- `ApiGateway`: the HTTP API.
- `Edge`: CloudFront (Router, security headers), its key-value store, the certificate and the DNS records.
- `Auth`: the stage's app client in the shared pool `eu-west-1_IVai0KEAA` (no user or group management).
- `Ec2Read`: reading EC2 resources (describe actions take no resource scope), for the launch template.
- `LaunchTemplate`: new versions and tags of the Claude Code launch template `lt-09036c7e82f2ca477` only; it can't launch instances.
- `LaunchTemplateImage`: Canonical's public image parameter the template resolves (`resolve:ssm:…`).
- `Roles`, `RolesWithBoundary`, `PassFunctionRoles`: the function's role, only with the boundary.

## What the boundary allows

The most any of the app's roles may do: logs, and

- `InstanceRead`: describe instances, SSM instance information and command results.
- `InstanceControl`: start, stop and change the type of instances tagged `Name=claude-code` only.
- `InstanceCommands`, `ShellScriptDocument`: SSM Run Command with `AWS-RunShellScript`, on instances tagged `Name=claude-code` only.
- `EncryptedVolumes`: KMS use through EC2 only (`kms:ViaService`), to start an instance with an encrypted volume.
- `SstDev`: AppSync Events for `sst dev`.

No tables, buckets, queues or topics: the app has none.

## Deviations from the standard

- None.

## Changing the role or policy

From the repo root, with admin credentials (`aws login`):

```sh
~/.claude/skills/aws-github-deploy/scripts/setup-role.sh claude-ec2
```

The script is safe to re-run: it renders the documents, publishes new versions of the policy and the boundary, updates the trust policy and tags, and sets the GitHub secret and variable.
