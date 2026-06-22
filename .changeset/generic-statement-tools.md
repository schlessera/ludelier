---
"@ludelier/world": minor
"@ludelier/authoring": patch
"@ludelier/editor-web": patch
---

Replace the flattened append-*/insert-* statement spine with generic statement tools.

The per-kind × per-position command design (append-say, append-show, …, insert-say, …) grew the toolset toward 50+ as statement kinds multiply — and the long tail (set/add/roll/scene/hide) was never even built. It was a hedge against LLMs mis-filling a discriminated union; that no longer holds (Zod 4 emits a clean `oneOf`, and a prototype confirmed gpt-5-mini fills the union reliably across kinds).

- `add-statement {nodeId, statement, before?}` — one tool for every statement kind (and every future kind): `statement` is the schema's `Statement` union; appends at the end, or inserts before `before` (a statement id).
- `update-statement {nodeId, statementId, statement}` — replace a statement in place (keeps its id).
- `move-statement {nodeId, statementId, before?}` — reorder.
- `remove-statement` / `rewire-goto` unchanged (target by id).

Manipulate tools drop from 15 to 10 and stay flat as the DSL grows. All guardrails are unchanged (terminal-position rule, say.who, cross-refs); the EditLog now bakes the stable id into `params.statement.id` for `add-statement`. The agent prompt and the editor's edit feed are updated for the new tools.
