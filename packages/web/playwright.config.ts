import { defineConfig } from "@playwright/test";

// Inside `sst shell` (the login uses the stage's test user): npx sst shell --stage int -- npm run test:e2e
// Against the deployed int site; WEB_URL overrides it (e.g. http://localhost:5173 with `npm run dev`).
// The tests only read: the test user's group is read-only (docs/development.md).
const testUser = process.env["SST_RESOURCE_TestUser"]; // set by `sst shell`
const baseURL: string | undefined = process.env["WEB_URL"] ?? (testUser ? (JSON.parse(testUser) as { siteUrl: string }).siteUrl : undefined);

export default defineConfig({
  testDir: "./e2e",
  timeout: 90_000,
  expect: { timeout: 30_000 },
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  globalSetup: "./e2e/global-setup.ts",
  use: { baseURL, viewport: { width: 1280, height: 900 }, trace: "retain-on-failure", storageState: "packages/web/e2e/.auth/user.json" },
  projects: [
    { name: "desktop", use: { browserName: "chromium" } },
    { name: "phone", use: { browserName: "chromium", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ],
});
