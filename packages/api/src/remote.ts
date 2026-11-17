// Runs the instance-side scripts (remote/*.sh) through SSM Run Command, the same way the CLI does: the script goes
// base64-encoded, so no quoting problems through AWS-RunShellScript (which uses sh); arguments are single-quoted.

import { GetCommandInvocationCommand, SendCommandCommand } from "@aws-sdk/client-ssm";
import { ssm } from "./instance.ts";

export interface RemoteResult {
  commandId: string;
  /** Pending, InProgress, Delayed, Success, Failed, TimedOut, Cancelled, … */
  status: string;
  done: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export function commandLine(script: string, args: string[] = []): string {
  const b64 = Buffer.from(script, "utf8").toString("base64");
  return [`echo ${b64} | base64 -d | bash -s --`, ...args.map(shellQuote)].join(" ");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DONE = new Set(["Success", "Failed", "TimedOut", "Cancelled", "Cancelling"]);

export async function send(instanceId: string, script: string, args: string[] = [], executionTimeoutSeconds = 600): Promise<string> {
  const res = await ssm.send(
    new SendCommandCommand({
      InstanceIds: [instanceId],
      DocumentName: "AWS-RunShellScript",
      TimeoutSeconds: 60,
      Parameters: { commands: [commandLine(script, args)], executionTimeout: [String(executionTimeoutSeconds)] },
      Comment: "claude-ec2 web",
    }),
  );
  const id = res.Command?.CommandId;
  if (!id) throw new Error("SendCommand returned no CommandId");
  return id;
}

export async function result(instanceId: string, commandId: string): Promise<RemoteResult> {
  try {
    const v = await ssm.send(new GetCommandInvocationCommand({ CommandId: commandId, InstanceId: instanceId }));
    const status = v.Status ?? "";
    // SSM appends "failed to run commands: exit status N"; the exit code says the same.
    const stderr = (v.StandardErrorContent ?? "")
      .split("\n")
      .filter((l) => !l.startsWith("failed to run commands: exit status"))
      .join("\n");
    return { commandId, status, done: DONE.has(status), exitCode: v.ResponseCode ?? -1, stdout: v.StandardOutputContent ?? "", stderr };
  } catch (e) {
    // Right after SendCommand the invocation may not exist yet.
    if ((e as { name?: string }).name === "InvocationDoesNotExist") return { commandId, status: "Pending", done: false, exitCode: -1, stdout: "", stderr: "" };
    throw e;
  }
}

/** How long `run` waits (API Gateway gives up after 30 s) and how often it asks; the tests shorten them. */
export const timing = { waitMs: 20_000, pollMs: 1_000 };

/** Sends the script and waits for it, at most `timing.waitMs`; then returns it unfinished. */
export async function run(instanceId: string, script: string, args: string[] = []): Promise<RemoteResult> {
  const commandId = await send(instanceId, script, args);
  const deadline = Date.now() + timing.waitMs;
  for (;;) {
    await sleep(timing.pollMs);
    const r = await result(instanceId, commandId);
    if (r.done || Date.now() > deadline) return r;
  }
}
