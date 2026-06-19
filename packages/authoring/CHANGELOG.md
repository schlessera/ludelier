# @ludelier/authoring

## 0.1.0

### Minor Changes

- 519e4b0: P2 first slice — `@ludelier/authoring`. Introduces the `LLMProvider` seam (mirrors the asset `AssetProvider` shape) with OpenAI + OpenRouter implementations over a shared OpenAI-compatible core and a BYOK-per-provider registry. Adds `generateStory()`: a provider-agnostic self-correction loop that constrains output with `storyJsonSchema()`, validates with `validateStory()`, and feeds issues back to the model until the Story is valid or attempts are exhausted — returning a discriminated `{ ok, story | issues, attempts, transcript }` result. Hermetic mock-provider + fake-fetch tests; no network.

### Patch Changes

- Updated dependencies [00a221d]
- Updated dependencies [fd44662]
  - @ludelier/schema@0.1.0
