import { readFileSync } from "node:fs";
import { validateStory, type Story } from "@ludelier/schema";

/** Load and validate the example story for use across world tests. */
export function loadCafe(): Story {
  const raw = JSON.parse(readFileSync(new URL("../../../examples/cafe.story.json", import.meta.url), "utf8"));
  const res = validateStory(raw);
  if (!res.success) {
    throw new Error("cafe fixture invalid: " + JSON.stringify(res.issues));
  }
  return res.data;
}
