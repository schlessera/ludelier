import { z } from "zod";
import { AssetKind } from "@ludelier/schema";
import type { Task } from "../registry";
import { ok } from "../result";
import { slugId } from "./ids";

export const registerAssetTask: Task = {
  name: "register-asset",
  kind: "manipulate",
  description:
    "Register a media asset (id, src, kind, generated). `kind` defaults to image and `generated` defaults to false. Duplicate ids are rejected by validation.",
  params: z.object({
    id: slugId,
    src: z.string().min(1),
    kind: AssetKind.default("image"),
    generated: z.boolean().default(false),
  }),
  apply: (story, params) => {
    const p = params as { id: string; src: string; kind: "image" | "audio"; generated: boolean };
    return ok({
      ...story,
      assets: [...story.assets, { id: p.id, src: p.src, kind: p.kind, generated: p.generated }],
    });
  },
};
