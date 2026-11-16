//! claude-ec2: manage the Claude Code EC2 instance through the AWS CLI and Session Manager.

use anyhow::{bail, Context, Result};
use base64::Engine;
use clap::{Parser, Subcommand};
use serde_json::{json, Value};
use std::io::Write;
use std::process::{Command, Stdio};
use std::thread::sleep;
use std::time::{Duration, Instant};

const NAME_TAG: &str = "claude-code";
const LAUNCH_TEMPLATE: &str = "claude-code-ubuntu-arm";
const TMUX_ATTACH: &str = "sudo -u ubuntu tmux attach -t claude";

#[derive(Parser)]
#[command(name = "claude-ec2", version, about = "Manage the Claude Code EC2 instance")]
struct Cli {
    /// Instance ID (default: the only non-terminated instance tagged Name=claude-code)
    #[arg(short, long, global = true, env = "CLAUDE_EC2_INSTANCE")]
    instance: Option<String>,

    /// AWS region
    #[arg(long, global = true, env = "CLAUDE_EC2_REGION", default_value = "eu-west-1")]
    region: String,

    /// AWS CLI profile (default: AWS_PROFILE / the CLI's default)
    #[arg(long, global = true, env = "CLAUDE_EC2_PROFILE")]
    profile: Option<String>,

    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Show instance state, Claude Code session and auto-stop status
    Status,
    /// Start the instance and wait until Session Manager can reach it
    Start,
    /// Stop the instance (disk, logins and conversations are kept)
    Stop {
        /// Wait until the instance is fully stopped
        #[arg(long)]
        wait: bool,
    },
    /// Attach to the Claude Code tmux session, starting the instance if needed
    Attach,
    /// Open a login shell as ubuntu
    Shell,
    /// Postpone the auto-stop limits (and cancel a pending auto-stop)
    Snooze {
        #[arg(default_value_t = 2)]
        hours: u32,
    },
    /// Run a command as ubuntu on the instance and print its output
    Exec {
        #[arg(required = true, trailing_var_arg = true, allow_hyphen_values = true)]
        command: Vec<String>,
    },
    /// Forward a port on the instance to localhost (e.g. a dev server)
    Forward {
        port: u16,
        /// Local port (default: same as remote)
        local_port: Option<u16>,
    },
    /// Change the instance type; the instance must be stopped
    Resize { instance_type: String },
    /// Launch a new instance from the launch template
    Launch {
        /// Override the template's instance type (e.g. t4g.large)
        #[arg(long = "type")]
        instance_type: Option<String>,
    },
}

struct Aws {
    region: String,
    profile: Option<String>,
}

impl Aws {
    fn command(&self, args: &[&str]) -> Command {
        let mut c = Command::new("aws");
        c.args(args).args(["--region", &self.region, "--output", "json"]);
        if let Some(p) = &self.profile {
            c.args(["--profile", p]);
        }
        // The CLI's bundled Python otherwise writes the Windows code page and chokes on emoji
        c.env("PYTHONUTF8", "1").env("PYTHONIOENCODING", "utf-8");
        c
    }

    fn json(&self, args: &[&str]) -> Result<Value> {
        let out = self
            .command(args)
            .output()
            .context("failed to run the AWS CLI; is `aws` installed and on PATH?")?;
        if !out.status.success() {
            bail!(
                "aws {} failed: {}",
                args.iter().take(2).copied().collect::<Vec<_>>().join(" "),
                String::from_utf8_lossy(&out.stderr).trim()
            );
        }
        let s = String::from_utf8_lossy(&out.stdout);
        if s.trim().is_empty() {
            return Ok(Value::Null);
        }
        serde_json::from_str(&s).context("unexpected AWS CLI output")
    }

    /// Runs an interactive Session Manager command with the console handed over to it.
    fn interactive(&self, args: &[&str]) -> Result<()> {
        let status = self
            .command(args)
            .stdin(Stdio::inherit())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .status()
            .context("failed to run the AWS CLI; is `aws` installed and on PATH?")?;
        if !status.success() {
            bail!("session ended with {status} (is the Session Manager plugin installed?)");
        }
        Ok(())
    }
}

struct Instance {
    id: String,
    state: String,
    instance_type: String,
    zone: String,
    public_ip: Option<String>,
    launch_time: String,
}

impl Instance {
    fn from_json(v: &Value) -> Instance {
        let s = |p: &str| v.pointer(p).and_then(Value::as_str).unwrap_or("-").to_string();
        Instance {
            id: s("/InstanceId"),
            state: s("/State/Name"),
            instance_type: s("/InstanceType"),
            zone: s("/Placement/AvailabilityZone"),
            public_ip: v.pointer("/PublicIpAddress").and_then(Value::as_str).map(String::from),
            launch_time: s("/LaunchTime"),
        }
    }
}

fn describe(aws: &Aws, id: &str) -> Result<Instance> {
    let v = aws.json(&["ec2", "describe-instances", "--instance-ids", id])?;
    let inst = v
        .pointer("/Reservations/0/Instances/0")
        .with_context(|| format!("instance {id} not found"))?;
    Ok(Instance::from_json(inst))
}

fn resolve_instance(aws: &Aws, explicit: Option<String>) -> Result<String> {
    if let Some(id) = explicit {
        return Ok(id);
    }
    let v = aws.json(&[
        "ec2",
        "describe-instances",
        "--filters",
        &format!("Name=tag:Name,Values={NAME_TAG}"),
        "Name=instance-state-name,Values=pending,running,stopping,stopped",
    ])?;
    let found: Vec<Instance> = v["Reservations"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|r| r["Instances"].as_array().into_iter().flatten())
        .map(Instance::from_json)
        .collect();
    match found.as_slice() {
        [] => bail!("no instance tagged Name={NAME_TAG}; create one with `claude-ec2 launch`"),
        [one] => Ok(one.id.clone()),
        many => {
            let list: Vec<String> = many
                .iter()
                .map(|i| format!("  {}  {}  {}", i.id, i.instance_type, i.state))
                .collect();
            bail!(
                "several {NAME_TAG} instances, pick one with --instance (or CLAUDE_EC2_INSTANCE):\n{}",
                list.join("\n")
            )
        }
    }
}

fn ssm_online(aws: &Aws, id: &str) -> Result<bool> {
    let v = aws.json(&[
        "ssm",
        "describe-instance-information",
        "--filters",
        &format!("Key=InstanceIds,Values={id}"),
    ])?;
    Ok(v.pointer("/InstanceInformationList/0/PingStatus").and_then(Value::as_str) == Some("Online"))
}

fn wait_until(what: &str, timeout: Duration, mut done: impl FnMut() -> Result<bool>) -> Result<()> {
    print!("Waiting for {what}");
    let started = Instant::now();
    loop {
        if done()? {
            println!(" ok");
            return Ok(());
        }
        if started.elapsed() > timeout {
            println!();
            bail!("timed out waiting for {what}");
        }
        print!(".");
        std::io::stdout().flush().ok();
        sleep(Duration::from_secs(5));
    }
}

/// Makes sure the instance is running and reachable over Session Manager.
fn ensure_running(aws: &Aws, id: &str) -> Result<()> {
    let inst = describe(aws, id)?;
    match inst.state.as_str() {
        "running" => {}
        "stopped" => {
            println!("Starting {id} ({})", inst.instance_type);
            aws.json(&["ec2", "start-instances", "--instance-ids", id])?;
        }
        "pending" => {}
        "stopping" => bail!("{id} is still stopping; try again once it has stopped"),
        other => bail!("{id} is {other}"),
    }
    wait_until("the instance to run", Duration::from_secs(300), || {
        Ok(describe(aws, id)?.state == "running")
    })?;
    wait_until("Session Manager", Duration::from_secs(300), || ssm_online(aws, id))
}

/// For commands that shouldn't start the instance on their own.
fn require_running(aws: &Aws, id: &str) -> Result<()> {
    let state = describe(aws, id)?.state;
    if state != "running" {
        bail!("{id} is {state}; start it with `claude-ec2 start`");
    }
    if !ssm_online(aws, id)? {
        bail!("{id} is running but Session Manager isn't online yet; try again in a minute");
    }
    Ok(())
}

struct RemoteResult {
    status: String,
    code: i64,
    stdout: String,
    stderr: String,
}

/// Runs a bash script as root through SSM Run Command and waits for the result.
fn run_remote(aws: &Aws, id: &str, script: &str) -> Result<RemoteResult> {
    // Base64 sidesteps quoting through the CLI and the AWS-RunShellScript document (which uses sh)
    let b64 = base64::engine::general_purpose::STANDARD.encode(script);
    let params = json!({ "commands": [format!("echo {b64} | base64 -d | bash")] }).to_string();
    let sent = aws.json(&[
        "ssm",
        "send-command",
        "--instance-ids",
        id,
        "--document-name",
        "AWS-RunShellScript",
        "--timeout-seconds",
        "900",
        "--parameters",
        &params,
    ])?;
    let cmd_id = sent
        .pointer("/Command/CommandId")
        .and_then(Value::as_str)
        .context("send-command returned no CommandId")?
        .to_string();
    loop {
        sleep(Duration::from_secs(2));
        // Right after send-command the invocation may not exist yet
        let Ok(v) = aws.json(&[
            "ssm",
            "get-command-invocation",
            "--command-id",
            &cmd_id,
            "--instance-id",
            id,
        ]) else {
            continue;
        };
        let status = v["Status"].as_str().unwrap_or("").to_string();
        if matches!(status.as_str(), "Pending" | "InProgress" | "Delayed" | "") {
            continue;
        }
        // SSM appends "failed to run commands: exit status N" (no newline); the exit code says the same
        let stderr: String = v["StandardErrorContent"]
            .as_str()
            .unwrap_or("")
            .lines()
            .filter(|l| !l.starts_with("failed to run commands: exit status"))
            .map(|l| format!("{l}\n"))
            .collect();
        return Ok(RemoteResult {
            code: v["ResponseCode"].as_i64().unwrap_or(-1),
            stdout: v["StandardOutputContent"].as_str().unwrap_or("").to_string(),
            stderr,
            status,
        });
    }
}

fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

fn start_session(aws: &Aws, id: &str, document: &str, parameters: Value) -> Result<()> {
    // Ctrl-C belongs to the remote session (e.g. interrupting Claude), not to this wrapper
    ctrlc::set_handler(|| {}).ok();
    aws.interactive(&[
        "ssm",
        "start-session",
        "--target",
        id,
        "--document-name",
        document,
        "--parameters",
        &parameters.to_string(),
    ])
}

fn cmd_status(aws: &Aws, id: &str) -> Result<()> {
    let inst = describe(aws, id)?;
    println!("Instance   {} ({}, {})", inst.id, inst.instance_type, inst.zone);
    println!("State      {}", inst.state);
    if inst.state != "running" {
        return Ok(());
    }
    println!("Started    {}", inst.launch_time);
    println!("Public IP  {}", inst.public_ip.as_deref().unwrap_or("-"));
    if !ssm_online(aws, id)? {
        println!("Session Manager: not online yet");
        return Ok(());
    }
    let r = run_remote(
        aws,
        id,
        r#"echo "Claude     tmux session $(sudo -u ubuntu tmux has-session -t claude 2>/dev/null && echo running || echo missing), $(sudo -u ubuntu tmux list-clients -t claude 2>/dev/null | wc -l) attached"
if command -v claude-autostop >/dev/null; then claude-autostop status | sed 's/^/Auto-stop  /'; else echo "Auto-stop  not installed"; exit 0; fi
# Time left, mirroring claude-autostop's rules (it runs every 5 min, then waits GRACE_MINUTES)
IDLE_MINUTES=60; MAX_UPTIME_HOURS=8; GRACE_MINUTES=5
[ -f /etc/default/claude-autostop ] && . /etc/default/claude-autostop
now=$(date +%s); boot=$(( now - $(cut -d. -f1 /proc/uptime) ))
left() { local s=$(( $1 - now )); [ $s -lt 0 ] && s=0; printf '%dh %02dm (at %s)' $((s/3600)) $((s%3600/60)) "$(date -d @$1 '+%H:%M %Z')"; }
max() { [ "$1" -gt "$2" ] && echo "$1" || echo "$2"; }
if [ -f /run/systemd/shutdown/scheduled ]; then
  at=$(( $(sed -n 's/^USEC=//p' /run/systemd/shutdown/scheduled) / 1000000 ))
  echo "Stops in   $(left $at), shutdown already scheduled"
  exit 0
fi
snooze=$(cat /run/claude-autostop.snooze 2>/dev/null || echo 0)
last=$(find /home/ubuntu/.claude/projects -name '*.jsonl' -printf '%T@\n' 2>/dev/null | sort -n | tail -1)
last=${last%.*}; last=${last:-0}
idle=$(max $(max $(( last + IDLE_MINUTES * 60 )) $(( boot + IDLE_MINUTES * 60 ))) "$snooze")
idle=$(max "$idle" "$now")
at=$idle; why="if Claude stays idle"
if [ "$MAX_UPTIME_HOURS" -gt 0 ]; then
  cap=$(max $(( boot + MAX_UPTIME_HOURS * 3600 )) "$snooze")
  [ "$cap" -le "$at" ] && { at=$cap; why="${MAX_UPTIME_HOURS}h uptime cap"; }
fi
echo "Stops in   ~$(left $(( at + GRACE_MINUTES * 60 ))), $why""#,
    )?;
    print!("{}", r.stdout);
    Ok(())
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    let aws = Aws { region: cli.region, profile: cli.profile };

    if let Cmd::Launch { instance_type } = &cli.cmd {
        let template = format!("LaunchTemplateName={LAUNCH_TEMPLATE}");
        let mut args = vec!["ec2", "run-instances", "--launch-template", &template];
        if let Some(t) = instance_type {
            args.extend(["--instance-type", t]);
        }
        let v = aws.json(&args)?;
        let id = v.pointer("/Instances/0/InstanceId").and_then(Value::as_str).unwrap_or("?");
        println!("Launched {id}. Setup takes about 3 minutes; then run:");
        println!("  claude-ec2 --instance {id} attach");
        println!("and complete the theme choice and /login once.");
        return Ok(());
    }

    let id = resolve_instance(&aws, cli.instance)?;

    match cli.cmd {
        Cmd::Status => cmd_status(&aws, &id)?,
        Cmd::Start => {
            ensure_running(&aws, &id)?;
            cmd_status(&aws, &id)?;
        }
        Cmd::Stop { wait } => {
            aws.json(&["ec2", "stop-instances", "--instance-ids", &id])?;
            println!("Stopping {id}");
            if wait {
                wait_until("the instance to stop", Duration::from_secs(300), || {
                    Ok(describe(&aws, &id)?.state == "stopped")
                })?;
            }
        }
        Cmd::Attach => {
            ensure_running(&aws, &id)?;
            println!("Attaching to Claude Code (detach with Ctrl-b d)");
            start_session(&aws, &id, "AWS-StartInteractiveCommand", json!({ "command": [TMUX_ATTACH] }))?;
        }
        Cmd::Shell => {
            ensure_running(&aws, &id)?;
            start_session(&aws, &id, "AWS-StartInteractiveCommand", json!({ "command": ["sudo -iu ubuntu"] }))?;
        }
        Cmd::Snooze { hours } => {
            require_running(&aws, &id)?;
            let r = run_remote(
                &aws,
                &id,
                &format!("command -v claude-autostop >/dev/null || {{ echo 'auto-stop is not installed on this instance' >&2; exit 1; }}\nclaude-autostop snooze {hours}"),
            )?;
            print!("{}", r.stdout);
            eprint!("{}", r.stderr);
            if r.status != "Success" {
                std::process::exit(1);
            }
        }
        Cmd::Exec { command } => {
            require_running(&aws, &id)?;
            let script = format!(
                "cd /home/ubuntu && sudo -u ubuntu -H bash -lc {}",
                shell_quote(&command.join(" "))
            );
            let r = run_remote(&aws, &id, &script)?;
            print!("{}", r.stdout);
            eprint!("{}", r.stderr);
            if r.status != "Success" {
                std::process::exit(if r.code > 0 { r.code as i32 } else { 1 });
            }
        }
        Cmd::Forward { port, local_port } => {
            ensure_running(&aws, &id)?;
            let local = local_port.unwrap_or(port);
            println!("Forwarding localhost:{local} -> {id}:{port} (Ctrl-C to stop)");
            // Here Ctrl-C should end the forward, so no handler override
            aws.interactive(&[
                "ssm",
                "start-session",
                "--target",
                &id,
                "--document-name",
                "AWS-StartPortForwardingSession",
                "--parameters",
                &json!({ "portNumber": [port.to_string()], "localPortNumber": [local.to_string()] }).to_string(),
            ])?;
        }
        Cmd::Resize { instance_type } => {
            let inst = describe(&aws, &id)?;
            if inst.state != "stopped" {
                bail!("{id} is {}; stop it first (`claude-ec2 stop --wait`)", inst.state);
            }
            aws.json(&[
                "ec2",
                "modify-instance-attribute",
                "--instance-id",
                &id,
                "--instance-type",
                &format!("Value={instance_type}"),
            ])?;
            println!("{id}: {} -> {instance_type}", inst.instance_type);
        }
        Cmd::Launch { .. } => unreachable!(),
    }
    Ok(())
}
