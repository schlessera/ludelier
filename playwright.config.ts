import { defineConfig, devices } from "@playwright/test";

const PORT = 5179;
// Use IPv4 explicitly, not "localhost": on some hosts (e.g. WSL2) localhost
// resolves to IPv6 ::1 first, and a connect to a closed ::1 port can take
// ~135s to return ECONNREFUSED — which Playwright's webServer reuse-probe
// would otherwise wait through before every run.
const HOST = "127.0.0.1";
const BASE_URL = `http://${HOST}:${PORT}`;

export default defineConfig({
  testDir: "packages/runtime-web/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: BASE_URL,
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
    command: `pnpm --filter @ludelier/runtime-web dev --host ${HOST} --port ${PORT} --strictPort`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
