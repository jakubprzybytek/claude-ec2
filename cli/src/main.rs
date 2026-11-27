//! claude-ec2: manage the Claude Code EC2 instance through the AWS CLI and Session Manager.
//!
//! The scripts it runs on the instance (remote/*.sh) are shared with the web app's API, so both behave the same.

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

const STATUS_SH: &str = include_str!("../../remote/status.sh");
const SNOOZE_SH: &str = include_str!("../../remote/snooze.sh");
const EXEC_SH: &str = include_str!("../../remote/exec.sh");
const SESSIONS_SH: &str = include_str!("../../remote/sessions.sh");
const CONVERSATIONS_SH: &str = include_str!("../../remote/conversations.sh");
const SPAWN_SH: &str = include_str!("../../remote/spawn.sh");
const CLOSE_SH: &str = include_str!("../../remote/close.sh");

#[derive(Parser)]
#[command(
    name = "claude-ec2",
    version,
    about = "Manage the Claude Code EC2 instance"
)]
struct Cli {
    /// Instance ID (default: the only non-terminated instance tagged Name=claude-code)
    #[arg(short, long, global = true, env = "CLAUDE_EC2_INSTANCE")]
    instance: Option<String>,

    /// AWS region
    #[arg(
        long,
        global = true,
        env = "CLAUDE_EC2_REGION",
        default_value = "eu-west-1"
    )]
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
    /// List the Claude Code sessions (main and spawned) with their claude.ai links
    Sessions,
    /// Start a new Claude Code session with Remote Control, to open in claude.ai or the Claude app
    Spawn {
        /// Session name (letters, digits, - and _)
        name: String,
        /// Folder to start in (default: /home/ubuntu)
        #[arg(long)]
        folder: Option<String>,
        /// Fork this conversation (an id from `claude-ec2 conversations`) instead of starting a new one
        #[arg(long)]
        fork: Option<String>,
        /// First prompt
        #[arg(trailing_var_arg = true)]
        prompt: Vec<String>,
    },
    /// Close a spawned session (the conversation is kept)
    Close { name: String },
    /// List recent conversations (to fork) and the folders a session can start in
    Conversations {
        #[arg(long, default_value_t = 14)]
        days: u32,
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
        c.args(args)
            .args(["--region", &self.region, "--output", "json"]);
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
        let s = |p: &str| {
            v.pointer(p)
                .and_then(Value::as_str)
                .unwrap_or("-")
                .to_string()
        };
        Instance {
            id: s("/InstanceId"),
            state: s("/State/Name"),
            instance_type: s("/InstanceType"),
            zone: s("/Placement/AvailabilityZone"),
            public_ip: v
                .pointer("/PublicIpAddress")
                .and_then(Value::as_str)
                .map(String::from),
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
    Ok(v.pointer("/InstanceInformationList/0/PingStatus")
        .and_then(Value::as_str)
        == Some("Online"))
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
    wait_until("Session Manager", Duration::from_secs(300), || {
        ssm_online(aws, id)
    })
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

fn b64(s: &str) -> String {
    base64::engine::general_purpose::STANDARD.encode(s)
}

/// The command line that runs `script` with `args` (as packages/api/src/remote.ts builds it).
fn command_line(script: &str, args: &[&str]) -> String {
    // Base64 sidesteps quoting through the CLI and the AWS-RunShellScript document (which uses sh)
    let mut line = format!("echo {} | base64 -d | bash -s --", b64(script));
    for a in args {
        line.push(' ');
        line.push_str(&shell_quote(a));
    }
    line
}

/// Runs a bash script as root through SSM Run Command and waits for the result.
fn run_remote(aws: &Aws, id: &str, script: &str, args: &[&str]) -> Result<RemoteResult> {
    let params = json!({ "commands": [command_line(script, args)] }).to_string();
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
            stdout: v["StandardOutputContent"]
                .as_str()
                .unwrap_or("")
                .to_string(),
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

/// Prints a script's output and fails with its error, as the CLI's other commands do.
fn finish(r: &RemoteResult) -> Result<()> {
    print!("{}", r.stdout);
    eprint!("{}", r.stderr);
    if r.status != "Success" {
        std::process::exit(if r.code > 0 { r.code as i32 } else { 1 });
    }
    Ok(())
}

/// The JSON a script printed.
fn remote_json(r: &RemoteResult) -> Result<Value> {
    if r.status != "Success" {
        bail!("{}", r.stderr.trim());
    }
    serde_json::from_str(&r.stdout).context("unexpected output from the instance")
}

fn hm(seconds: i64) -> String {
    let s = seconds.max(0);
    format!("{}h {:02}m", s / 3600, s % 3600 / 60)
}

/// Claude Code's login on the instance (status.sh's "auth"): without it no session starts; it lasts about a month.
fn login_line(auth: &Value, now: i64) -> String {
    const FIX: &str = "log in from the web app, or `claude-ec2 attach` and /login";
    match auth["loggedIn"].as_bool() {
        None if auth.is_null() => "unknown (the instance's status script predates it)".to_string(),
        None => format!(
            "unknown ({})",
            auth["error"]
                .as_str()
                .unwrap_or("claude auth status failed")
        ),
        Some(false) => format!("NOT LOGGED IN: no Claude Code session can start; {FIX}"),
        Some(true) => match auth["expiresAt"].as_i64() {
            Some(at) if at - now < 7 * 86_400 => {
                format!("expires in {}: renew it soon; {FIX}", hm(at - now))
            }
            Some(at) => format!("logged in, expires in {} days", (at - now) / 86_400),
            None => "logged in".to_string(),
        },
    }
}

fn cmd_status(aws: &Aws, id: &str) -> Result<()> {
    let inst = describe(aws, id)?;
    println!(
        "Instance   {} ({}, {})",
        inst.id, inst.instance_type, inst.zone
    );
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
    let v = remote_json(&run_remote(aws, id, STATUS_SH, &[])?)?;
    let now = v["now"].as_i64().unwrap_or(0);
    let c = &v["claude"];
    println!(
        "Claude     tmux session {}, {} attached, {} spawned",
        if c["running"].as_bool() == Some(true) {
            "running"
        } else {
            "missing"
        },
        c["clients"].as_i64().unwrap_or(0),
        c["spawned"].as_i64().unwrap_or(0)
    );
    println!("Login      {}", login_line(&v["auth"], now));
    let a = &v["autostop"];
    if a["installed"].as_bool() != Some(true) {
        println!("Auto-stop  not installed");
        return Ok(());
    }
    let mut line = format!(
        "Auto-stop  uptime {} (cap {}h) | load15 {:.2}",
        hm(now - v["bootTime"].as_i64().unwrap_or(now)),
        a["maxUptimeHours"],
        v["load"][2].as_f64().unwrap_or(0.0)
    );
    if let Some(last) = a["lastActivity"].as_i64() {
        line += &format!(
            " | last Claude activity {} min ago (idle limit {} min)",
            (now - last) / 60,
            a["idleMinutes"]
        );
    }
    if let Some(until) = a["snoozedUntilText"].as_str() {
        line += &format!(" | snoozed until {until}");
    }
    println!("{line}");
    let stops = a["stopsAt"].as_i64().unwrap_or(now);
    let approx = if a["estimate"].as_bool() == Some(true) {
        "~"
    } else {
        ""
    };
    println!(
        "Stops in   {approx}{} (at {}), {}",
        hm(stops - now),
        a["stopsAtText"].as_str().unwrap_or("?"),
        a["reason"].as_str().unwrap_or("")
    );
    Ok(())
}

fn cmd_sessions(aws: &Aws, id: &str) -> Result<()> {
    let v = remote_json(&run_remote(aws, id, SESSIONS_SH, &[])?)?;
    let sessions = v["sessions"].as_array().cloned().unwrap_or_default();
    if sessions.is_empty() {
        println!("No Claude Code sessions");
    }
    for s in sessions {
        let name = if s["main"].as_bool() == Some(true) {
            "main (claude)"
        } else {
            s["name"].as_str().unwrap_or("?")
        };
        println!(
            "{name:<24} {:<10} {}",
            s["state"].as_str().unwrap_or(""),
            s["folder"]
                .as_str()
                .unwrap_or("")
                .replacen("/home/ubuntu", "~", 1)
        );
        println!(
            "{:<24} {}",
            "",
            s["url"].as_str().unwrap_or("(no claude.ai link yet)")
        );
    }
    Ok(())
}

fn cmd_conversations(aws: &Aws, id: &str, days: u32) -> Result<()> {
    let v = remote_json(&run_remote(
        aws,
        id,
        CONVERSATIONS_SH,
        &[&days.to_string()],
    )?)?;
    for c in v["conversations"].as_array().cloned().unwrap_or_default() {
        let title = c["title"]
            .as_str()
            .or(c["firstPrompt"].as_str())
            .unwrap_or("");
        let title: String = title.chars().take(60).collect();
        println!(
            "{}  {:<60}  {}",
            c["id"].as_str().unwrap_or(""),
            title.replace('\n', " "),
            c["folder"]
                .as_str()
                .unwrap_or("")
                .replacen("/home/ubuntu", "~", 1)
        );
    }
    println!(
        "\nFolders: {}",
        v["folders"]
            .as_array()
            .map(|f| f
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join("  "))
            .unwrap_or_default()
    );
    Ok(())
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    let aws = Aws {
        region: cli.region,
        profile: cli.profile,
    };

    if let Cmd::Launch { instance_type } = &cli.cmd {
        let template = format!("LaunchTemplateName={LAUNCH_TEMPLATE}");
        let mut args = vec!["ec2", "run-instances", "--launch-template", &template];
        if let Some(t) = instance_type {
            args.extend(["--instance-type", t]);
        }
        let v = aws.json(&args)?;
        let id = v
            .pointer("/Instances/0/InstanceId")
            .and_then(Value::as_str)
            .unwrap_or("?");
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
            start_session(
                &aws,
                &id,
                "AWS-StartInteractiveCommand",
                json!({ "command": [TMUX_ATTACH] }),
            )?;
        }
        Cmd::Shell => {
            ensure_running(&aws, &id)?;
            start_session(
                &aws,
                &id,
                "AWS-StartInteractiveCommand",
                json!({ "command": ["sudo -iu ubuntu"] }),
            )?;
        }
        Cmd::Snooze { hours } => {
            require_running(&aws, &id)?;
            finish(&run_remote(&aws, &id, SNOOZE_SH, &[&hours.to_string()])?)?;
        }
        Cmd::Exec { command } => {
            require_running(&aws, &id)?;
            finish(&run_remote(
                &aws,
                &id,
                EXEC_SH,
                &[&b64(&command.join(" "))],
            )?)?;
        }
        Cmd::Sessions => {
            require_running(&aws, &id)?;
            cmd_sessions(&aws, &id)?;
        }
        Cmd::Spawn {
            name,
            folder,
            fork,
            prompt,
        } => {
            ensure_running(&aws, &id)?;
            let prompt = prompt.join(" ");
            let prompt = if prompt.is_empty() {
                String::new()
            } else {
                b64(&prompt)
            };
            let folder = folder.unwrap_or_else(|| "/home/ubuntu".into());
            let fork = fork.unwrap_or_else(|| "-".into());
            remote_json(&run_remote(
                &aws,
                &id,
                SPAWN_SH,
                &[&name, &folder, &fork, &prompt],
            )?)?;
            println!("Started {name}; it shows up in claude.ai/code and the Claude app in a few seconds.");
            sleep(Duration::from_secs(8));
            cmd_sessions(&aws, &id)?;
        }
        Cmd::Close { name } => {
            require_running(&aws, &id)?;
            finish(&run_remote(&aws, &id, CLOSE_SH, &[&name])?)?;
        }
        Cmd::Conversations { days } => {
            require_running(&aws, &id)?;
            cmd_conversations(&aws, &id, days)?;
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
                bail!(
                    "{id} is {}; stop it first (`claude-ec2 stop --wait`)",
                    inst.state
                );
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn login_line_warns_when_logged_out_or_expiring() {
        let now = 1_800_000_000;
        assert!(login_line(&json!({"loggedIn": false}), now).starts_with("NOT LOGGED IN"));
        assert_eq!(
            login_line(
                &json!({"loggedIn": true, "expiresAt": now + 20 * 86_400 + 60}),
                now
            ),
            "logged in, expires in 20 days"
        );
        assert!(
            login_line(&json!({"loggedIn": true, "expiresAt": now + 3 * 3600}), now)
                .starts_with("expires in 3h 00m: renew it soon")
        );
        assert!(
            login_line(&json!({"loggedIn": null, "error": "timeout"}), now).contains("timeout")
        );
        assert!(login_line(&Value::Null, now).starts_with("unknown"));
    }

    #[test]
    fn command_line_passes_script_and_arguments_through_sh() {
        let script = "printf '%s|' \"$@\"";
        let args = ["plain", "it's", "$HOME `id`; x", "", "new\nline"];
        // AWS-RunShellScript runs the command with sh
        let out = Command::new("sh")
            .args(["-c", &command_line(script, &args)])
            .output()
            .unwrap();
        assert_eq!(
            String::from_utf8_lossy(&out.stdout),
            format!("{}|", args.join("|"))
        );
    }

    #[test]
    fn hm_formats_hours_and_minutes() {
        assert_eq!(hm(3 * 3600 + 5 * 60 + 9), "3h 05m");
        assert_eq!(hm(-5), "0h 00m");
    }
}
