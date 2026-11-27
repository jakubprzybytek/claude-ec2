import { expect, test } from "@playwright/test";

// Read-only: the page shows the real instance; nothing here starts, stops or spawns anything.

test("shows the instance and, when it runs, its sessions and details", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

  await page.goto("/");
  const state = page.getByTestId("instance-state");
  await expect(state).toHaveText(/running|stopped|pending|stopping/);
  await expect(page.getByTestId("instance-type")).toHaveText(/^[a-z0-9]+\.[a-z0-9]+$/);

  if ((await state.textContent())?.trim() === "running") {
    await expect(page.getByTestId("session").first()).toBeVisible();
    await expect(page.getByTestId("session").filter({ hasText: "main" })).toBeVisible();
    await expect(page.getByTestId("main-session")).toHaveText(/running|missing/);
    await expect(page.getByTestId("autostop")).toContainText("Stops in");
    await expect(page.getByTestId("claude-login")).toHaveText(/expires in|logged in|not logged in|unknown/);

    // The new-session form loads the conversations and folders; it is not submitted.
    await page.getByTestId("new-session").click();
    await expect(page.getByTestId("folder").locator("option").first()).toHaveText("~");
    await expect(page.getByTestId("fork").locator("option")).not.toHaveCount(0);
  }

  // No horizontal scrolling, also at phone width.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  expect(errors).toEqual([]);
});

test("a read-only user gets a clear message for actions", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("instance-state")).toBeVisible();
  // The command card only appears when the instance runs; running a command is refused for the test group.
  test.skip((await page.getByTestId("instance-state").textContent())?.trim() !== "running", "instance not running");
  await page.getByTestId("command").fill("true");
  await page.getByRole("button", { name: "Run" }).click();
  await expect(page.getByTestId("command-card").getByRole("alert")).toHaveText("Read-only access");
});

test("keeps the costs in the browser instead of asking again on the next visit", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("costs-total").or(page.getByTestId("costs-unavailable"))).toBeVisible({ timeout: 30_000 });
  test.skip(await page.getByTestId("costs-unavailable").isVisible(), "Cost Explorer not available");

  const asked: string[] = [];
  page.on("request", (r) => new URL(r.url()).pathname.endsWith("/costs") && asked.push(r.url()));
  await page.reload();
  await expect(page.getByTestId("costs-parts")).toBeVisible();
  await expect(page.getByTestId("instance-state")).toBeVisible();
  expect(asked).toEqual([]);

  // The card's refresh button still asks.
  await page.getByTestId("costs-card").getByRole("button", { name: /refresh/i }).click();
  await expect.poll(() => asked.length).toBe(1);
});

test("warns when Claude Code is logged out and offers to log in", async ({ page }) => {
  // The instance's answer is changed in the browser only: logged out. The read-only test user's login is refused.
  await page.route("**/status/details", async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    await route.fulfill({ response: res, json: { ...body, auth: { loggedIn: false, method: "none", expiresAt: null, loginInProgress: false } } });
  });
  await page.goto("/");
  if ((await page.getByTestId("instance-state").textContent())?.trim() !== "running") test.skip(true, "the instance is not running");
  const card = page.getByTestId("login-card");
  await expect(card).toContainText("Claude Code is not logged in");
  await expect(page.getByTestId("claude-login")).toHaveText("not logged in");
  await page.getByTestId("login-start").click();
  await expect(card.getByRole("alert").last()).toContainText("Read-only");
  await expect(page.getByTestId("login-start")).toHaveText("Start again");
});
