import { defineConfig } from "vitest/config";

export default defineConfig({
  // The instance-side scripts (remote/*.sh) are imported as text, as esbuild's text loader does in the Lambda bundle.
  plugins: [
    {
      name: "sh-as-text",
      transform(code, id) {
        if (id.endsWith(".sh")) return { code: `export default ${JSON.stringify(code)};`, map: null };
      },
    },
  ],
  test: {
    projects: [
      { extends: true, test: { name: "unit", include: ["packages/*/test/unit/**/*.test.ts"] } },
      // Against a deployed stage, inside `sst shell` (the test user): read-only calls only (docs/development.md).
      { extends: true, test: { name: "integration", include: ["packages/api/test/integration/**/*.test.ts"], testTimeout: 60_000, fileParallelism: false } },
    ],
  },
});
