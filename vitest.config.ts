import { defineConfig } from "vitest/config";

export default defineConfig({
  // The editor-web component tests (.test.tsx) use React's automatic JSX runtime (no `React`
  // import), matching the editor-web source. esbuild otherwise defaults to the classic transform.
  esbuild: { jsx: "automatic" },
  test: {
    include: ["packages/**/test/**/*.test.{ts,tsx}"],
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
