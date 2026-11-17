// Against a deployed stage, as the test user (read-only group), inside `sst shell`:
//   npx sst shell --stage int -- npm run test:integration
// The stage controls the real instance, so these tests only read. The write calls below are probes that must be
// refused for the test group; each is also harmless if it ever got through (a resize of a running instance is
// refused by EC2's state check, an invalid session name by validation).

import { Resource } from "sst";
import { beforeAll, describe, expect, it } from "vitest";

let token = "";
const api = Resource.TestUser.apiUrl.replace(/\/$/, "");

async function call(method: string, path: string, body?: unknown, auth = true) {
  const res = await fetch(api + path, {
    method,
    headers: { ...(auth ? { authorization: `Bearer ${token}` } : {}), ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

beforeAll(async () => {
  if (Resource.App.stage === "prod") throw new Error("The integration tests never run against prod");
  const res = await fetch("https://cognito-idp.eu-west-1.amazonaws.com/", {
    method: "POST",
    headers: { "content-type": "application/x-amz-json-1.1", "x-amz-target": "AWSCognitoIdentityProviderService.InitiateAuth" },
    body: JSON.stringify({
      AuthFlow: "USER_PASSWORD_AUTH",
      ClientId: Resource.TestUser.clientId,
      AuthParameters: { USERNAME: Resource.TestUser.email, PASSWORD: Resource.TestUserPassword.value },
    }),
  });
  if (!res.ok) throw new Error(`Test user sign-in failed: ${res.status}`);
  token = ((await res.json()) as { AuthenticationResult: { AccessToken: string } }).AuthenticationResult.AccessToken;
});

describe("API", () => {
  it("refuses requests without a token", async () => {
    expect((await call("GET", "/status", undefined, false)).status).toBe(401);
  });

  it("shows the instance", async () => {
    const r = await call("GET", "/status");
    expect(r.status).toBe(200);
    expect(r.body["instance"]).toMatchObject({ id: expect.stringMatching(/^i-/), state: expect.any(String) });
    expect(r.body["instanceTypes"]).toContain("t4g.medium");
  });

  it.each([
    ["POST", "/instance/resize", { type: "t4g.medium" }],
    ["POST", "/sessions", { name: "not a valid name" }],
    ["DELETE", "/sessions/not%20valid", undefined],
    ["POST", "/autostop/snooze", { hours: 99 }],
    ["POST", "/commands", { command: "" }],
  ])("refuses %s %s to the read-only test group", async (method, path, body) => {
    const r = await call(method, path, body);
    expect(r.status).toBe(403);
    expect(r.body["error"]).toBe("Read-only access");
  });

  describe("on the instance (when it is running)", () => {
    let running = false;
    beforeAll(async () => {
      const s = (await call("GET", "/status")).body as { instance: { state: string }; ssmOnline: boolean };
      running = s.instance.state === "running" && s.ssmOnline;
    });

    it("lists the Claude Code sessions", async (ctx) => {
      if (!running) ctx.skip();
      const r = await call("GET", "/sessions");
      expect(r.status).toBe(200);
      expect(r.body["sessions"]).toEqual(expect.arrayContaining([expect.objectContaining({ main: true, name: "claude" })]));
    });

    it("shows the details", async (ctx) => {
      if (!running) ctx.skip();
      const r = await call("GET", "/status/details");
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ claude: { running: expect.any(Boolean) }, memory: { total: expect.any(Number) } });
    });

    it("lists conversations and folders", async (ctx) => {
      if (!running) ctx.skip();
      const r = await call("GET", "/conversations?days=7");
      expect(r.status).toBe(200);
      expect(r.body["folders"]).toContain("/home/ubuntu");
      expect(Array.isArray(r.body["conversations"])).toBe(true);
    });
  });
});
