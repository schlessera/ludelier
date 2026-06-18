---
"@ludelier/renderer-pixi": minor
"@ludelier/runtime-web": minor
---

P1 web player: PixiJS v8 display-only renderer (`@ludelier/renderer-pixi`) plus a Vite + `vite-plugin-pwa` runtime (`@ludelier/runtime-web`) that plays a Story in the browser with Dexie local autosave/resume. Includes a Playwright play-through + visual-regression test driven through an agent-native `window.__ludelier` handle, with a `data-ready` first-paint flag and SwiftShader software GL for GPU-free CI.
