import { defineConfig, devices } from "@playwright/test";

const PORT = 5179;
// IPv4 explicitly (not "localhost") to avoid IPv6-first resolution surprises.
const HOST = "127.0.0.1";
const BASE_URL = `http://${HOST}:${PORT}`;

// When set, the dev server is started + health-checked externally (see the
// `e2e` recipe in the justfile) and Playwright must NOT manage/probe it.
// This avoids a WSL2 quirk where a Node TCP connect to a not-yet-bound
// loopback port hangs ~135s (curl/Chromium refuse instantly; Node/Python don't).
const EXTERNAL_SERVER = !!process.env.E2E_EXTERNAL_SERVER;

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
  // On Linux/CI Playwright manages the dev server itself (fast). On WSL2, use
  // `just e2e`, which sets E2E_EXTERNAL_SERVER and manages the server with a
  // curl health-check to dodge the Node connect-hang described above.
  webServer: EXTERNAL_SERVER
    ? undefined
    : {
        command: `pnpm --filter @ludelier/runtime-web dev --host ${HOST} --port ${PORT} --strictPort`,
        url: BASE_URL,
        reuseExistingServer: false,
        timeout: 120_000,
      },
});
