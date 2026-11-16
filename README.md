# claude-ec2

Manage the Claude Code EC2 instance (launch template `claude-code-ubuntu-arm`, eu-west-1) from Windows.

It drives the AWS CLI and the Session Manager plugin, so it uses your normal AWS credentials (`AWS_PROFILE`).

## Install

```powershell
cargo install --path .
```

## Usage

```text
claude-ec2 status              instance state, Claude Code tmux session, auto-stop status and time left
claude-ec2 start               start and wait until Session Manager is online
claude-ec2 attach              attach to the Claude Code tmux session (starts the instance if needed)
claude-ec2 stop [--wait]       stop (disk, logins and conversations are kept)
claude-ec2 snooze [hours]      postpone the auto-stop limits (default 2h), cancels a pending auto-stop
claude-ec2 shell               login shell as ubuntu
claude-ec2 exec <command...>   run a command as ubuntu and print the output
claude-ec2 forward <port> [local-port]   forward a port, e.g. a dev server
claude-ec2 resize <type>       change instance type (instance must be stopped)
claude-ec2 launch [--type t]   launch a new instance from the template
```

In `attach`, detach with `Ctrl-b d`. Ctrl-C goes to the remote session.

The instance is the only non-terminated one tagged `Name=claude-code`. If there are several, pass `--instance i-…` or set `CLAUDE_EC2_INSTANCE`. The region defaults to `eu-west-1`; override it with `--region` or `CLAUDE_EC2_REGION`.

To always use a dedicated AWS profile without touching `AWS_PROFILE` (which other tools share), set `CLAUDE_EC2_PROFILE` once, e.g. `setx CLAUDE_EC2_PROFILE my-profile`, and open a new terminal. `--profile` still overrides it.
