import { z } from "zod";
import type { Task } from "../registry";
import { ok } from "../result";
import { slugId } from "./ids";

export const registerAssetTask: Task = {
  name: "register-asset",
  kind: "manipulate",
  description: "Register a media asset (id, src). Duplicate ids are rejected by validation.",
  params: z.object({ id: slugId, src: z.string().min(1) }),
  apply: (story, params) => {
    const p = params as { id: string; src: string };
    return ok({ ...story, assets: [...story.assets, { id: p.id, src: p.src }] });
  },
};
