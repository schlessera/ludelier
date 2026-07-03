import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/test/**/*.test.ts"],
    coverage: {
      // v8 provider, source-only: measure package src, not tests/configs/e2e.
      // No thresholds yet — the report is informational (`just coverage`).
      provider: "v8",
      include: ["packages/*/src/**"],
      reporter: ["text", "html"],
      reportsDirectory: "coverage",
    },
  },
});
