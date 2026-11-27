# Instance-side scripts

Scripts that run on the Claude Code instance through SSM Run Command (`AWS-RunShellScript`, as root). The CLI
(`cli/`, `include_str!`) and the web app's API (`packages/api`, bundled as text) send the same files, so both
behave the same.

How they are sent: `echo <base64 of the script> | base64 -d | bash -s -- <args>`, each argument shell-quoted.
Callers validate the arguments too; the scripts check them again, since they run as root.

| Script | Arguments | Prints |
|---|---|---|
| `status.sh` | — | JSON: tmux session, Claude Code's login (and when it expires), auto-stop settings and when it will stop, load, memory, disk |
| `snooze.sh` | `<hours>` | a line of text |
| `exec.sh` | `<base64 command>` | the command's output (runs as `ubuntu`, login shell, in `$HOME`) |
| `sessions.sh` | — | JSON: the tmux sessions with Claude Code (main `claude` and spawned `cc-*`), with their claude.ai links |
| `conversations.sh` | `[days]` | JSON: recent conversations (to fork) and the folders a session can start in |
| `spawn.sh` | `<name> <folder> [<conversation id to fork> \| -] [<base64 first prompt>]` | JSON: the new session |
| `close.sh` | `<name>` | a line of text |
| `login.sh` | `start` \| `code <base64 code>` \| `cancel` | JSON: the claude.ai sign-in URL; then whether Claude Code is logged in and if the main session was restarted |

Spawned sessions run `claude --remote-control <name>` in a tmux session `cc-<name>` as `ubuntu`, so they show up
in claude.ai/code and the Claude app. Each gets a preset conversation id (`--session-id`), kept in the tmux option
`@conversation`; its claude.ai link is read from that conversation's file.

Claude Code's login (claude.ai) lasts about a month; then no session starts until it is renewed. `login.sh` renews it
without a terminal: `start` runs `claude auth login` as `ubuntu` in the tmux session `login-claude` and prints its
sign-in URL; after signing in there, claude.ai shows a code, which `code` types in. When the login succeeds and the
main session is not running (it exits at boot when logged out), `code` restarts `claude-tmux.service`. Spawned
sessions that exited are not restarted: close them and start new ones.
