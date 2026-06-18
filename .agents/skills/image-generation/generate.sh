#!/usr/bin/env bash
# Generate one image via the OpenAI Images API and write it to a local file.
#
# Usage: generate.sh OUTPUT.png "PROMPT" [model] [size] [background] [quality]
#   model      gpt-image-2 (default) | gpt-image-1.5 | gpt-image-1
#   size       1280x720 (default; gpt-image-2 allows any ×16 edges within limits)
#   background opaque (default) | transparent | auto   (transparent needs gpt-image-1.5/1)
#   quality    high (default) | medium | low | auto
#
# Key: $OPENAI_API_KEY, else ~/.ludelier-openai-key. The key is never printed.
# Why the API and not the ChatGPT Images MCP: the MCP writes to a remote sandbox we
# can't read; the API returns base64 inline, which we decode straight to disk.
set -euo pipefail

out="${1:?usage: generate.sh OUTPUT.png \"PROMPT\" [model] [size] [background] [quality]}"
prompt="${2:?missing PROMPT}"
model="${3:-gpt-image-2}"
size="${4:-1280x720}"
background="${5:-opaque}"
quality="${6:-high}"

key="${OPENAI_API_KEY:-$(cat "$HOME/.ludelier-openai-key" 2>/dev/null | tr -d '[:space:]')}"
[ -n "$key" ] || { echo "error: set OPENAI_API_KEY or create ~/.ludelier-openai-key" >&2; exit 1; }

req="$(mktemp)"; resp="$(mktemp)"
trap 'rm -f "$req" "$resp"' EXIT

python3 - "$req" "$model" "$prompt" "$size" "$background" "$quality" <<'PY'
import json, sys
req, model, prompt, size, background, quality = sys.argv[1:7]
json.dump({
    "model": model, "prompt": prompt, "size": size, "quality": quality,
    "background": background, "output_format": "png", "n": 1,
}, open(req, "w"))
PY

code="$(curl -sS -X POST https://api.openai.com/v1/images/generations \
  -H "Authorization: Bearer $key" -H "Content-Type: application/json" \
  --data @"$req" -o "$resp" -w '%{http_code}')"

python3 - "$resp" "$out" "$code" <<'PY'
import json, base64, sys
resp, out, code = sys.argv[1:4]
d = json.load(open(resp))
if "error" in d:
    print(f"API error (http {code}): " + json.dumps(d['error'])[:600], file=sys.stderr)
    sys.exit(2)
open(out, "wb").write(base64.b64decode(d["data"][0]["b64_json"]))
print(f"wrote {out}")
PY
