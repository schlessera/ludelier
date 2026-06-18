import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

// Workspace root — lets the dev server read the shared examples/ + workspace packages.
const workspaceRoot = fileURLToPath(new URL("../../", import.meta.url));

export default defineConfig({
  server: { fs: { allow: [workspaceRoot] } },
  build: { target: "es2022" },
  plugins: [
    VitePWA({
      registerType: "autoUpdate",
      manifest: {
        name: "Ludelier — Café Encounter",
        short_name: "Ludelier",
        description: "An AI-augmented visual novel built with Ludelier.",
        theme_color: "#0e1117",
        background_color: "#0e1117",
        display: "standalone",
        start_url: "/",
        // TODO(P1): add icons (192/512 + maskable) for full installability.
        icons: [],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,json,svg,png,webp,woff2,wasm}"],
        // Game asset bundles exceed Workbox's 2 MiB default precache cap.
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
      },
      devOptions: { enabled: false },
    }),
  ],
});
