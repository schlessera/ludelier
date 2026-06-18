import { defineConfig, devices } from "@playwright/test";

const PORT = 5179;

export default defineConfig({
  testDir: "packages/runtime-web/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "on-first-retry",
  },
  // Software GL (SwiftShader) so canvas/WebGL renders identically with no GPU (CI-safe).
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: { args: ["--use-gl=swiftshader", "--disable-gpu-sandbox"] },
      },
    },
  ],
  webServer: {
    command: `pnpm --filter @ludelier/runtime-web dev --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
