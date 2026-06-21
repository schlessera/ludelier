import { z } from "zod";
import type { Character } from "@ludelier/schema";
import type { Task } from "../registry";
import { ok, fail } from "../result";
import { slugId } from "./ids";

export const addCharacterTask: Task = {
  name: "add-character",
  kind: "manipulate",
  description: "Add a character (id, name, optional color).",
  params: z.object({ id: slugId, name: z.string().min(1), color: z.string().optional() }),
  apply: (story, params) => {
    const p = params as { id: string; name: string; color?: string };
    if (story.characters.some((c) => c.id === p.id)) {
      return fail([{ path: "id", message: `character "${p.id}" already exists` }]);
    }
    const character: Character =
      p.color !== undefined ? { id: p.id, name: p.name, color: p.color } : { id: p.id, name: p.name };
    return ok({ ...story, characters: [...story.characters, character] });
  },
};
