import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Workspace root — lets the dev server read the shared examples/ + workspace packages.
const workspaceRoot = fileURLToPath(new URL("../../", import.meta.url));
// Reuse the runtime-web player's committed assets (/assets/<story>/…) for the play preview.
const sharedPublic = fileURLToPath(new URL("../runtime-web/public", import.meta.url));

export default defineConfig({
  publicDir: sharedPublic,
  server: { fs: { allow: [workspaceRoot] } },
  build: { target: "es2022" },
  plugins: [react()],
});
