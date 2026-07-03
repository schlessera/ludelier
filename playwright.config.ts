import { defineConfig, devices } from "@playwright/test";

// IPv4 explicitly (not "localhost") to avoid IPv6-first resolution surprises.
const HOST = "127.0.0.1";
const RUNTIME_PORT = 5179;
const EDITOR_PORT = 5180;
const RUNTIME_URL = `http://${HOST}:${RUNTIME_PORT}`;
const EDITOR_URL = `http://${HOST}:${EDITOR_PORT}`;

// When set, the dev servers are started + health-checked externally (see the
// `e2e` recipe in the justfile) and Playwright must NOT manage/probe them.
// This avoids a WSL2 quirk where a Node TCP connect to a not-yet-bound
// loopback port hangs ~135s (curl/Chromium refuse instantly; Node/Python don't).
const EXTERNAL_SERVER = !!process.env.E2E_EXTERNAL_SERVER;

// Software GL (SwiftShader) so canvas/WebGL renders identically with no GPU (CI-safe).
// Shared by both projects.
const chromium = {
  ...devices["Desktop Chrome"],
  launchOptions: { args: ["--use-gl=swiftshader", "--disable-gpu-sandbox"] },
};

export default defineConfig({
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    trace: "on-first-retry",
  },
  // One project per app: the web player (visual baselines keep the "chromium" name
  // they were recorded under) and the React editor shell (functional-only).
  projects: [
    {
      name: "chromium",
      testDir: "packages/runtime-web/e2e",
      use: { ...chromium, baseURL: RUNTIME_URL },
    },
    {
      name: "editor",
      testDir: "packages/editor-web/e2e",
      use: { ...chromium, baseURL: EDITOR_URL },
    },
  ],
  // On Linux/CI Playwright manages the dev servers itself (fast). On WSL2, use
  // `just e2e`, which sets E2E_EXTERNAL_SERVER and manages the servers with a
  // curl health-check to dodge the Node connect-hang described above.
  webServer: EXTERNAL_SERVER
    ? undefined
    : [
        {
          command: `pnpm --filter @ludelier/runtime-web dev --host ${HOST} --port ${RUNTIME_PORT} --strictPort`,
          url: RUNTIME_URL,
          reuseExistingServer: false,
          timeout: 120_000,
        },
        {
          command: `pnpm --filter @ludelier/editor-web dev --host ${HOST} --port ${EDITOR_PORT} --strictPort`,
          url: EDITOR_URL,
          reuseExistingServer: false,
          timeout: 120_000,
        },
      ],
});
