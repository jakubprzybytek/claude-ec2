// Signs the test user in once through the app's login form and saves the session for all tests. Run inside
// `sst shell` so the test user is available: npx sst shell --stage int -- npm run test:e2e

import { chromium, type FullConfig } from "@playwright/test";
import { Resource } from "sst";

export const STORAGE_STATE = "packages/web/e2e/.auth/user.json";

export default async function globalSetup(config: FullConfig) {
  if (Resource.App.stage === "prod") throw new Error("The E2E tests never run against prod");
  const baseURL = config.projects[0]!.use.baseURL!;
  if (/^https:\/\/claude-ec2\.albedoonline\.com/.test(baseURL)) throw new Error("The E2E tests must not run against the prod site");
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(baseURL);
  await page.getByTestId("login-email").fill(Resource.TestUser.email);
  await page.getByTestId("login-password").fill(Resource.TestUserPassword.value);
  await page.getByTestId("login-submit").click();
  await page.getByTestId("user-email").waitFor({ timeout: 30_000 });
  await page.context().storageState({ path: STORAGE_STATE });
  await browser.close();
}
