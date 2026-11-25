import {
  DescribeInstancesCommand,
  EC2Client,
  ModifyInstanceAttributeCommand,
  StartInstancesCommand,
  StopInstancesCommand,
  type _InstanceType,
  type InstanceStateName,
} from "@aws-sdk/client-ec2";
import { type CommandInvocationStatus, DescribeInstanceInformationCommand, GetCommandInvocationCommand, SendCommandCommand, SSMClient } from "@aws-sdk/client-ssm";
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { CostExplorerClient, GetCostAndUsageCommand } from "@aws-sdk/client-cost-explorer";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { clearCostsCache, NO_ACCESS } from "../../src/costs.ts";
import { handler } from "../../src/handler.ts";
import { timing } from "../../src/remote.ts";

const ec2 = mockClient(EC2Client);
const ssm = mockClient(SSMClient);
timing.pollMs = 1;

process.env["FULL_ACCESS_GROUPS"] = "claude-ec2";
process.env["READ_ONLY_GROUPS"] = "claude-ec2-test";

const FULL = "[claude-ec2]";
const READ = "[claude-ec2-test]";
const COMMAND_ID = "11111111-2222-3333-4444-555555555555";

async function call(routeKey: string, { groups = FULL, body, path = {}, query }: { groups?: string; body?: unknown; path?: Record<string, string>; query?: Record<string, string> } = {}) {
  const event = {
    routeKey,
    body: body === undefined ? undefined : JSON.stringify(body),
    isBase64Encoded: false,
    pathParameters: path,
    queryStringParameters: query,
    requestContext: { authorizer: { jwt: { claims: { "cognito:groups": groups }, scopes: [] } } },
  } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
  const res = (await handler(event)) as APIGatewayProxyStructuredResultV2;
  return { status: res.statusCode, body: JSON.parse(String(res.body)) as Record<string, unknown> };
}

function instance(state: InstanceStateName, type: _InstanceType = "t4g.medium") {
  ec2.on(DescribeInstancesCommand).resolves({
    Reservations: [{ Instances: [{ InstanceId: "i-123", State: { Name: state }, InstanceType: type, Placement: { AvailabilityZone: "eu-west-1a" } }] }],
  });
}

function remoteAnswers(stdout: string, { status = "Success" as CommandInvocationStatus, code = 0, stderr = "" } = {}) {
  ssm.on(DescribeInstanceInformationCommand).resolves({ InstanceInformationList: [{ PingStatus: "Online" }] });
  ssm.on(SendCommandCommand).resolves({ Command: { CommandId: COMMAND_ID } });
  ssm
    .on(GetCommandInvocationCommand)
    .rejectsOnce(Object.assign(new Error("not yet"), { name: "InvocationDoesNotExist" }))
    .resolvesOnce({ Status: "InProgress" })
    .resolves({ Status: status, ResponseCode: code, StandardOutputContent: stdout, StandardErrorContent: stderr });
}

/** The script and arguments of the last SendCommand: `echo <b64> | base64 -d | bash -s -- 'a' 'b'`. */
function sent() {
  const calls = ssm.commandCalls(SendCommandCommand);
  const line = calls.at(-1)!.args[0].input.Parameters!["commands"]![0]!;
  const [, b64, rest] = line.match(/^echo (\S+) \| base64 -d \| bash -s --(.*)$/)!;
  return { script: Buffer.from(b64!, "base64").toString(), args: [...rest!.matchAll(/'([^']*)'/g)].map((m) => m[1]) };
}

beforeEach(() => {
  ec2.reset();
  ssm.reset();
});

describe("access", () => {
  it("refuses users without the app's group", async () => {
    instance("running");
    expect((await call("GET /status", { groups: "[portfolio-tracker]" })).status).toBe(403);
  });

  it("lets the read-only group read", async () => {
    instance("stopped");
    const r = await call("GET /status", { groups: READ });
    expect(r.status).toBe(200);
    expect(r.body["instance"]).toMatchObject({ id: "i-123", state: "stopped" });
  });

  it.each(["POST /instance/start", "POST /instance/stop", "POST /instance/resize", "POST /autostop/snooze", "POST /commands", "POST /sessions", "DELETE /sessions/{name}", "GET /commands/{id}"])(
    "refuses %s to the read-only group, without touching AWS",
    async (route) => {
      instance("running");
      expect((await call(route, { groups: READ, body: {} })).status).toBe(403);
      expect(ec2.commandCalls(StartInstancesCommand)).toHaveLength(0);
      expect(ec2.commandCalls(StopInstancesCommand)).toHaveLength(0);
      expect(ssm.commandCalls(SendCommandCommand)).toHaveLength(0);
    },
  );

  it("refuses the costs to users without the app's group", async () => {
    expect((await call("GET /costs", { groups: "[portfolio-tracker]" })).status).toBe(403);
  });

  it("says why there are no costs while Cost Explorer is denied", async () => {
    const ce = mockClient(CostExplorerClient);
    ce.on(GetCostAndUsageCommand).rejects(Object.assign(new Error("denied"), { name: "AccessDeniedException" }));
    clearCostsCache();
    try {
      expect(await call("GET /costs", { groups: READ })).toEqual({ status: 200, body: { unavailable: NO_ACCESS } });
    } finally {
      ce.restore();
      clearCostsCache();
    }
  });

  it("answers 404 for unknown routes", async () => expect((await call("GET /nope")).status).toBe(404));
});

describe("instance", () => {
  it("starts a stopped instance", async () => {
    instance("stopped");
    ec2.on(StartInstancesCommand).resolves({});
    const r = await call("POST /instance/start");
    expect(r.body["instance"]).toMatchObject({ state: "pending" });
    expect(ec2.commandCalls(StartInstancesCommand)[0]!.args[0].input.InstanceIds).toEqual(["i-123"]);
  });

  it("does not start a running instance again", async () => {
    instance("running");
    await call("POST /instance/start");
    expect(ec2.commandCalls(StartInstancesCommand)).toHaveLength(0);
  });

  it("refuses to start while stopping", async () => {
    instance("stopping");
    expect((await call("POST /instance/start")).status).toBe(409);
  });

  it("stops a running instance", async () => {
    instance("running");
    ec2.on(StopInstancesCommand).resolves({});
    expect((await call("POST /instance/stop")).body["instance"]).toMatchObject({ state: "stopping" });
    expect(ec2.commandCalls(StopInstancesCommand)).toHaveLength(1);
  });

  it("resizes only a stopped instance, only to arm64 types", async () => {
    instance("running");
    expect((await call("POST /instance/resize", { body: { type: "t4g.large" } })).status).toBe(409);
    instance("stopped");
    expect((await call("POST /instance/resize", { body: { type: "t3.large" } })).status).toBe(400);
    ec2.on(ModifyInstanceAttributeCommand).resolves({});
    expect((await call("POST /instance/resize", { body: { type: "t4g.large" } })).status).toBe(200);
    expect(ec2.commandCalls(ModifyInstanceAttributeCommand)[0]!.args[0].input).toMatchObject({ InstanceId: "i-123", InstanceType: { Value: "t4g.large" } });
  });

  it("explains when there are several tagged instances", async () => {
    ec2.on(DescribeInstancesCommand).resolves({ Reservations: [{ Instances: [{ InstanceId: "i-1" }, { InstanceId: "i-2" }] }] });
    const r = await call("GET /status");
    expect(r.status).toBe(409);
    expect(r.body["error"]).toContain("i-1, i-2");
  });
});

describe("on the instance", () => {
  it("needs a running instance", async () => {
    instance("stopped");
    expect((await call("GET /sessions")).status).toBe(409);
    expect(ssm.commandCalls(SendCommandCommand)).toHaveLength(0);
  });

  it("returns the details script's JSON", async () => {
    instance("running");
    remoteAnswers('{"claude":{"running":true}}');
    const r = await call("GET /status/details", { groups: READ });
    expect(r.body).toEqual({ claude: { running: true } });
    expect(sent().script).toContain("claude-autostop");
  });

  it("spawns a session with validated arguments", async () => {
    instance("running");
    remoteAnswers('{"name":"fix-bug"}');
    const fork = "0fbc350c-8c99-42e4-ade4-9623fff497f9";
    const r = await call("POST /sessions", { body: { name: "fix-bug", folder: "/home/ubuntu/repos/x", fork, prompt: "it's a 'test'" } });
    expect(r.status).toBe(200);
    const { script, args } = sent();
    expect(script).toContain("--remote-control");
    expect(args.slice(0, 3)).toEqual(["fix-bug", "/home/ubuntu/repos/x", fork]);
    expect(Buffer.from(args[3]!, "base64").toString()).toBe("it's a 'test'");
  });

  it.each([
    [{ name: "bad name" }],
    [{ name: "x;id" }],
    [{ name: "ok", folder: "/etc" }],
    [{ name: "ok", folder: "/home/ubuntuX" }],
    [{ name: "ok", fork: "../../x" }],
    [{ name: 5 }],
  ])("refuses spawn arguments %j", async (body) => {
    instance("running");
    remoteAnswers("{}");
    expect((await call("POST /sessions", { body })).status).toBe(400);
    expect(ssm.commandCalls(SendCommandCommand)).toHaveLength(0);
  });

  it("passes the script's refusal on as 400", async () => {
    instance("running");
    remoteAnswers("", { status: "Failed", code: 3, stderr: "a session named x already exists\nfailed to run commands: exit status 3" });
    const r = await call("POST /sessions", { body: { name: "x" } });
    expect(r).toEqual({ status: 400, body: { error: "a session named x already exists" } });
  });

  it("closes a session", async () => {
    instance("running");
    remoteAnswers("Closed x\n");
    expect((await call("DELETE /sessions/{name}", { path: { name: "x" } })).body).toEqual({ output: "Closed x" });
    expect(sent().args).toEqual(["x"]);
  });

  it("starts a command and reads its result later", async () => {
    instance("running");
    remoteAnswers("hello\n");
    const started = await call("POST /commands", { body: { command: "echo hello" } });
    expect(started.body).toEqual({ commandId: COMMAND_ID });
    expect(Buffer.from(sent().args[0]!, "base64").toString()).toBe("echo hello");
    ssm.on(GetCommandInvocationCommand).resolves({ Status: "Success", ResponseCode: 0, StandardOutputContent: "hello\n" });
    const done = await call("GET /commands/{id}", { path: { id: COMMAND_ID } });
    expect(done.body).toMatchObject({ done: true, exitCode: 0, stdout: "hello\n" });
  });

  it("validates snooze hours", async () => {
    instance("running");
    remoteAnswers("Auto-stop snoozed for 3h\n");
    expect((await call("POST /autostop/snooze", { body: { hours: 25 } })).status).toBe(400);
    expect((await call("POST /autostop/snooze", { body: { hours: "3" } })).status).toBe(400);
    expect((await call("POST /autostop/snooze", { body: { hours: 3 } })).body).toEqual({ output: "Auto-stop snoozed for 3h" });
    expect(sent().args).toEqual(["3"]);
  });

  it("reports a timeout when the instance does not answer", async () => {
    timing.waitMs = 5;
    try {
      instance("running");
      ssm.on(DescribeInstanceInformationCommand).resolves({ InstanceInformationList: [{ PingStatus: "Online" }] });
      ssm.on(SendCommandCommand).resolves({ Command: { CommandId: COMMAND_ID } });
      ssm.on(GetCommandInvocationCommand).resolves({ Status: "InProgress" });
      expect((await call("GET /sessions")).status).toBe(504);
    } finally {
      timing.waitMs = 20_000;
    }
  });
});
