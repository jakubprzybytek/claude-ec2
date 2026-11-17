// The web app's API (docs/api.md): one function behind API Gateway's Cognito JWT authorizer, routed here.

import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from "aws-lambda";
import closeSh from "../../../remote/close.sh";
import conversationsSh from "../../../remote/conversations.sh";
import execSh from "../../../remote/exec.sh";
import sessionsSh from "../../../remote/sessions.sh";
import snoozeSh from "../../../remote/snooze.sh";
import spawnSh from "../../../remote/spawn.sh";
import statusSh from "../../../remote/status.sh";
import { type Access, accessOf } from "./access.ts";
import { findInstance, HttpError, INSTANCE_TYPES, requireReachable, resize, ssmOnline, start, stop } from "./instance.ts";
import { type RemoteResult, result, run, send } from "./remote.ts";

type Event = APIGatewayProxyEventV2WithJWTAuthorizer;
type Params = Record<string, string | undefined>;
type Body = Record<string, unknown>;
interface Route {
  /** Who may call it: "read" routes also the read-only (test) group. */
  access: Exclude<Access, "none">;
  run: (params: Params, body: Body, query: Params) => Promise<unknown>;
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HOME = "/home/ubuntu";

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

/** Output of a script that prints JSON; its error text otherwise. */
function json(r: RemoteResult): unknown {
  if (!r.done) throw new HttpError(504, "The instance did not answer in time; try again");
  if (r.status !== "Success") throw new HttpError(r.exitCode >= 2 && r.exitCode <= 4 ? 400 : 502, r.stderr.trim() || `Command ${r.status.toLowerCase()} (exit ${r.exitCode})`);
  try {
    return JSON.parse(r.stdout);
  } catch {
    throw new HttpError(502, "Unexpected output from the instance");
  }
}

function text(r: RemoteResult): { output: string } {
  if (!r.done) throw new HttpError(504, "The instance did not answer in time; try again");
  if (r.status !== "Success") throw new HttpError(r.exitCode >= 2 && r.exitCode <= 4 ? 400 : 502, r.stderr.trim() || `Command ${r.status.toLowerCase()}`);
  return { output: r.stdout.trim() };
}

function str(body: Body, key: string, { required = false, max = 200 } = {}): string | undefined {
  const v = body[key];
  if (v === undefined || v === null || v === "") {
    if (required) throw new HttpError(400, `${key} is required`);
    return undefined;
  }
  if (typeof v !== "string" || v.length > max || /[\0]/.test(v)) throw new HttpError(400, `${key} must be text of at most ${max} characters`);
  return v;
}

export const routes: Record<string, Route> = {
  // Instance state from EC2 (fast); the details from the instance itself are a separate call.
  "GET /status": {
    access: "read",
    run: async () => {
      const instance = await findInstance();
      const online = instance.state === "running" ? await ssmOnline(instance.id) : false;
      return { instance, ssmOnline: online, instanceTypes: INSTANCE_TYPES };
    },
  },
  "GET /status/details": { access: "read", run: async () => json(await run((await requireReachable()).id, statusSh)) },
  "POST /instance/start": { access: "full", run: async () => ({ instance: await start() }) },
  "POST /instance/stop": { access: "full", run: async () => ({ instance: await stop() }) },
  "POST /instance/resize": { access: "full", run: async (_p, body) => ({ instance: await resize(str(body, "type", { required: true, max: 30 })!) }) },
  "POST /autostop/snooze": {
    access: "full",
    run: async (_p, body) => {
      const hours = body["hours"] ?? 2;
      if (!Number.isInteger(hours) || (hours as number) < 1 || (hours as number) > 24) throw new HttpError(400, "hours must be a whole number from 1 to 24");
      return text(await run((await requireReachable()).id, snoozeSh, [String(hours)]));
    },
  },
  // A command may take longer than API Gateway waits: it is started here and its result read with GET /commands/{id}.
  "POST /commands": {
    access: "full",
    run: async (_p, body) => {
      const command = str(body, "command", { required: true, max: 4000 })!;
      const { id } = await requireReachable();
      return { commandId: await send(id, execSh, [b64(command)]) };
    },
  },
  "GET /commands/{id}": {
    access: "full",
    run: async (p) => {
      if (!UUID.test(p["id"] ?? "")) throw new HttpError(400, "Invalid command id");
      const { id } = await findInstance();
      return result(id, p["id"]!);
    },
  },
  "GET /sessions": { access: "read", run: async () => json(await run((await requireReachable()).id, sessionsSh)) },
  "POST /sessions": {
    access: "full",
    run: async (_p, body) => {
      const name = str(body, "name", { required: true, max: 40 })!;
      if (!NAME.test(name)) throw new HttpError(400, "name: letters, digits, - and _, up to 40 characters");
      const folder = str(body, "folder", { max: 300 }) ?? HOME;
      if (folder !== HOME && !folder.startsWith(`${HOME}/`)) throw new HttpError(400, `folder must be under ${HOME}`);
      const fork = str(body, "fork", { max: 36 });
      if (fork && !UUID.test(fork)) throw new HttpError(400, "fork must be a conversation id");
      const prompt = str(body, "prompt", { max: 10_000 });
      return json(await run((await requireReachable()).id, spawnSh, [name, folder, fork ?? "-", prompt ? b64(prompt) : ""]));
    },
  },
  "DELETE /sessions/{name}": {
    access: "full",
    run: async (p) => {
      if (!NAME.test(p["name"] ?? "")) throw new HttpError(400, "Invalid session name");
      return text(await run((await requireReachable()).id, closeSh, [p["name"]!]));
    },
  },
  "GET /conversations": {
    access: "read",
    run: async (_p, _b, q) => {
      const days = Number(q["days"] ?? 14);
      if (!Number.isInteger(days) || days < 1 || days > 90) throw new HttpError(400, "days must be 1-90");
      return json(await run((await requireReachable()).id, conversationsSh, [String(days)]));
    },
  },
};

const respond = (statusCode: number, body: unknown): APIGatewayProxyResultV2 => ({
  statusCode,
  headers: { "content-type": "application/json", "cache-control": "no-store" },
  body: JSON.stringify(body),
});

export async function handler(event: Event): Promise<APIGatewayProxyResultV2> {
  const route = routes[event.routeKey];
  if (!route) return respond(404, { error: "Not found" });
  const access = accessOf(event.requestContext.authorizer?.jwt?.claims);
  if (access === "none") return respond(403, { error: "Your account has no access to this app" });
  if (route.access === "full" && access !== "full") return respond(403, { error: "Read-only access" });
  let body: Body = {};
  if (event.body) {
    try {
      const raw = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
      body = parsed as Body;
    } catch {
      return respond(400, { error: "The body must be a JSON object" });
    }
  }
  try {
    return respond(200, await route.run(event.pathParameters ?? {}, body, event.queryStringParameters ?? {}));
  } catch (e) {
    if (e instanceof HttpError) return respond(e.status, { error: e.message });
    console.error(event.routeKey, e);
    return respond(500, { error: "Internal error" });
  }
}
