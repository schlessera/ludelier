---
name: image-generation
description: Generate committed image assets (visual-novel backgrounds, character sprites) for Ludelier stories using the OpenAI Images API. Use when a story needs new art that must land on local disk and be checked into the repo. Covers model selection (transparency vs flexible sizes), the API call, post-processing with ImageMagick, and the repo's asset conventions.
---

# Image generation for Ludelier

Produce **committed** image assets — visual-novel backgrounds and character sprites — that the
PixiJS renderer preloads and a story references by id. Output must be real files on local disk
under version control, sized and formatted for the engine's deterministic pipeline.

## ⚠️ Do NOT use the claude.ai "ChatGPT Images 2.0" MCP for committed assets

That MCP (`mcp__claude_ai_ChatGPT_Images_2_0__generate_image`) runs **server-side**. It generates
the image in its own sandbox (default `/data/output` *there*) and returns a `file_path` that does
**not exist on our machine** — verified by pre-creating the target dir and finding nothing written
locally. The only thing it hands back is an inline preview the harness does not persist to a
readable file. It is fine for "show me an image" but **cannot deliver files into the repo**.

Use the **OpenAI Images API directly** (below): it returns the bytes as base64 inline, so we decode
straight to disk.

## API key

Read from `OPENAI_API_KEY`, else from `~/.ludelier-openai-key` (a file in `$HOME`, outside the repo).
**Never print the key, never commit it.** The helper script handles this.

## Model selection (as of 2026-06; verify if stale)

| Model | Sizes | Transparency | Use for |
|---|---|---|---|
| `gpt-image-2` (snapshot `gpt-image-2-2026-04-21`) | **flexible**: both edges ×16, max edge ≤3840, aspect ≤3:1, total px 655,360–8,294,400 | ❌ not supported | **backgrounds** at exact stage size (e.g. `1280x720`) |
| `gpt-image-1.5` | fixed: `1024x1024`, `1024x1536`, `1536x1024` | ✅ `background:"transparent"` | **character sprites** (need alpha) |
| `gpt-image-1` | fixed (as 1.5) | ✅ | fallback only — **deprecating 2026-10-23** |

- All GPT-Image models may require **API Organization Verification** on the developer console; an
  unverified org gets a verification error. The first successful call confirms verification.
- Rule of thumb: **bg → `gpt-image-2`** (perfect 16:9 with no crop), **sprite → `gpt-image-1.5`**
  (native transparency, no green-screen keying needed). gpt-image-2 can't do transparent, so don't
  try to cut out a gpt-image-2 sprite unless you key it manually.

## The API call

`POST https://api.openai.com/v1/images/generations`, `Authorization: Bearer <key>`, JSON body:

```json
{ "model": "gpt-image-2", "prompt": "…", "size": "1280x720",
  "quality": "high", "background": "opaque", "output_format": "png", "n": 1 }
```

- `quality`: `low` | `medium` | `high` | `auto`.
- `background`: `opaque` | `transparent` | `auto` (transparent needs png/webp + a 1.5/1 model).
- `output_format`: `png` | `jpeg` | `webp` (+ `output_compression` 0–100 for jpeg/webp).
- Response: base64 in `data[0].b64_json` (**no URL is returned**). Decode it to a file.

### Helper script

`./generate.sh OUTPUT.png "PROMPT" [model] [size] [background] [quality]` (this folder). It reads the
key, builds the payload (python stdlib — no pip/venv), POSTs via curl, and decodes the base64 to
`OUTPUT.png`. Examples:

```bash
# Background (gpt-image-2, exact 1280x720, opaque)
./generate.sh bg_raw.png "Cozy empty café interior, anime VN background, warm light…" \
  gpt-image-2 1280x720 opaque high

# Character sprite (gpt-image-1.5, transparent)
./generate.sh her_raw.png "Full-body anime VN character on a FULLY TRANSPARENT background…" \
  gpt-image-1.5 1024x1536 transparent high
```

## Prompting tips

- **Backgrounds:** name the setting, lighting, mood, palette; say **EMPTY — no people/characters**;
  ask for a **16:9** composition with foreground space for sprites; "no text, no watermark, no UI".
- **Sprites:** "full-body … character sprite", "isolated on a **FULLY TRANSPARENT background**, no
  backdrop, no shadow on the ground, no floor, no props", "entire body head to feet, centered".
  Describe hair/eyes/outfit/pose explicitly for consistency across a character's variants.

## Post-processing (ImageMagick `convert`)

```bash
# Background → ensure exact stage size (cover-fit crop) and compress to webp
convert bg_raw.png -resize 1280x720^ -gravity center -extent 1280x720 -strip -quality 90 bg.webp

# Sprite → trim transparent margins to a tight bounding box, keep alpha, webp
convert her_raw.png -trim +repage -strip -quality 92 her.webp

# Verify
identify -format "%f %wx%h %m alpha=%A %b\n" bg.webp her.webp
```

- gpt-image-2 backgrounds requested at the exact stage size need no resize. The renderer cover-fits
  anyway, but committing exact size keeps screenshots crisp and byte-stable.
- Sprites are anchored **bottom-center** and scaled by height, so **trim** the transparent border —
  the trimmed bottom edge becomes the character's feet.
- Prefer **webp** (small, alpha-capable). Workbox precaches webp; PixiJS loads it natively.

## Repo conventions

- Commit assets under `packages/runtime-web/public/assets/<story-id>/`. Vite serves `public/` at
  root, so reference them root-relative.
- Declare every asset in the story's `assets` array; statements reference it **by id**:
  ```json
  "assets": [
    { "id": "bg_cafe", "src": "/assets/cafe/bg.webp" },
    { "id": "her",     "src": "/assets/cafe/her.webp" }
  ]
  ```
  Then `{ "op": "scene", "bg": "bg_cafe" }` and `{ "op": "show", "sprite": "her", "asset": "her", "at": "center" }`.
- `validateStory()` cross-checks that `scene.bg` / `show.asset` reference declared assets; the
  renderer preloads all of `story.assets` up front so drawing stays synchronous.
- **Determinism:** committed assets are fixed inputs, so visual baselines (`*-chromium-linux.png`)
  are byte-stable. Regenerating art changes the bytes → you must refresh baselines (`just e2e-update`).
  Don't regenerate casually.

## OpenRouter (P3) — transparency caveat

This skill uses OpenAI's **direct** API. P3 locks assets to **OpenRouter BYOK**, and the transparency
path does **not** carry over 1:1 (verified 2026-06; OpenRouter's catalog evolves — re-check):

- OpenRouter exposes OpenAI image gen only as the **GPT-5 Image series** (`openai/gpt-5-image`,
  `…-mini`, `gpt-5.4-image-2`); **`gpt-image-1.5` is not addressable by name.**
- OpenRouter routes image gen through `/api/v1/chat/completions` + `modalities: ["image"]`, not
  OpenAI's `/images/generations` — so there is **no `background:"transparent"`**. Transparency is a
  separate `background_mode` (`original`/`transparent`/`solid`) param, currently **only on Sourceful
  V2.5** (`sourceful/riverflow-v2.5-fast` / `-pro`). No GPT-5/OpenAI image model documents it.
- So for transparent sprites via OpenRouter: use a **Sourceful riverflow-v2.5** model, OR generate
  opaque on a flat background and **key locally** (ImageMagick chroma + `-trim`), OR keep a
  direct-OpenAI sprite path. The locked `AssetProvider` interface is the seam — expose a transparency
  capability the OpenRouter provider maps to `background_mode` or to a keying fallback.
