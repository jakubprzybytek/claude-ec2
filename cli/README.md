# claude-ec2 CLI

Manage the Claude Code EC2 instance (launch template `claude-code-ubuntu-arm`, eu-west-1) from a terminal, e.g. on Windows. The web app at https://claude-ec2.albedoonline.com does the same from a browser or phone ([README](../README.md)); both run the same scripts on the instance ([remote/](../remote/README.md)).

It drives the AWS CLI and the Session Manager plugin, so it uses your normal AWS credentials (`AWS_PROFILE`).

## Install

```powershell
cargo install --path cli
```

From the repo root. Run it again after pulling changes: the scripts it sends to the instance are built into the binary.

## Usage

```text
claude-ec2 status              instance state, Claude Code tmux session, auto-stop status and time left
claude-ec2 start               start and wait until Session Manager is online
claude-ec2 attach              attach to the Claude Code tmux session (starts the instance if needed)
claude-ec2 stop [--wait]       stop (disk, logins and conversations are kept)
claude-ec2 snooze [hours]      postpone the auto-stop limits (default 2h), cancels a pending auto-stop
claude-ec2 sessions            the Claude Code sessions (main and spawned) with their claude.ai links
claude-ec2 spawn <name> [--folder <dir>] [--fork <conversation id>] [prompt...]
                               start a new session with Remote Control, to open in claude.ai or the Claude app
claude-ec2 close <name>        close a spawned session (the conversation is kept)
claude-ec2 conversations [--days n]   recent conversations (ids to fork) and the folders a session can start in
claude-ec2 shell               login shell as ubuntu
claude-ec2 exec <command...>   run a command as ubuntu and print the output
claude-ec2 forward <port> [local-port]   forward a port, e.g. a dev server
claude-ec2 resize <type>       change instance type (instance must be stopped)
claude-ec2 launch [--type t]   launch a new instance from the template
```

In `attach`, detach with `Ctrl-b d`. Ctrl-C goes to the remote session.

The instance is the only non-terminated one tagged `Name=claude-code`. If there are several, pass `--instance i-…` or set `CLAUDE_EC2_INSTANCE`. The region defaults to `eu-west-1`; override it with `--region` or `CLAUDE_EC2_REGION`.

To always use a dedicated AWS profile without touching `AWS_PROFILE` (which other tools share), set `CLAUDE_EC2_PROFILE` once, e.g. `setx CLAUDE_EC2_PROFILE my-profile`, and open a new terminal. `--profile` still overrides it.

## Development

```sh
cd cli
cargo fmt && cargo clippy --all-targets -- -D warnings && cargo test
```

The pipeline runs the same checks and builds the Windows binary on every push (`.github/workflows/checks.yaml`). A change to the instance-side scripts in `remote/` affects the CLI and the web app alike: keep both working.
