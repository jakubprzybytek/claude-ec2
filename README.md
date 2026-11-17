# claude-ec2

Control the Claude Code EC2 instance (eu-west-1, launch template `claude-code-ubuntu-arm`) from a browser, a phone or a terminal: see its state, start and stop it, postpone its auto-stop, run commands, and start or close Claude Code sessions that you then open in claude.ai/code or the Claude app.

| | |
|---|---|
| Web app | https://claude-ec2.albedoonline.com (sign-in with the shared Cognito pool; group `claude-ec2`) |
| CLI | [cli/](cli/README.md): the same from a terminal, plus `attach`, `shell`, `forward` and `launch` |
| Instance-side scripts | [remote/](remote/README.md): shared by the web app and the CLI |
| Development and delivery | [docs/development.md](docs/development.md) |

## What the web app does

- **Instance:** state, type, zone; start, stop, resize (when stopped, Graviton types only).
- **Auto-stop and load:** when the instance will stop by itself and why (idle limit or uptime cap), snooze for 1-8 h, load, memory, disk.
- **Claude Code sessions:** the main session and the spawned ones, each with its claude.ai link. **New session** starts `claude --remote-control <name>` in a tmux session on the instance, in a folder you pick, either as a new conversation or as a fork of a recent one, optionally with a first prompt. It shows up in claude.ai/code and the Claude app in a few seconds. **Close** ends it; the conversation is kept and can be forked later.
- **Run a command** as `ubuntu`, like `claude-ec2 exec`.

Not in the web app (use the CLI): an interactive terminal (`attach`, `shell`), port forwarding, launching a new instance.

## How it works

```
browser ── CloudFront (claude-ec2.albedoonline.com) ──┬── S3: the site (React, packages/web)
                                                      └── /api → API Gateway (Cognito JWT) → Lambda (packages/api)
                                                                     │ EC2 API: describe, start, stop, resize
                                                                     └ SSM Run Command: remote/*.sh on the instance
```

- The stack is an SST app (`sst.config.ts`, `infra/`). It also holds the instance's launch template (`infra/ec2.ts`, imported from the hand-made one); the instance, its role and security group are still managed by hand (docs/development.md, "Deviations").
- Access: API Gateway checks the Cognito token; the function then requires the group `claude-ec2` (the pool is shared). The function's IAM role can only act on the instance tagged `Name=claude-code`.
- Running a command through SSM is root on the instance, so whoever is in the `claude-ec2` group effectively has a root shell there. Keep that group to yourself.

## Access

Your user in the shared pool (`AlbedoUserPool`, `eu-west-1_IVai0KEAA`) needs the group `claude-ec2`, once, with admin credentials:

```sh
aws cognito-idp create-group --user-pool-id eu-west-1_IVai0KEAA --group-name claude-ec2 \
  --description "claude-ec2: control the Claude Code instance (root on it)"
aws cognito-idp admin-add-user-to-group --user-pool-id eu-west-1_IVai0KEAA --username <your email> --group-name claude-ec2
```
