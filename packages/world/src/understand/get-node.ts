import { z } from "zod";
import type { Task } from "../registry";
import { ok, fail } from "../result";

export const getNodeTask: Task = {
  name: "get-node",
  kind: "understand",
  description: "Fetch a single node by id.",
  params: z.object({ id: z.string() }),
  run: (story, params) => {
    const { id } = params as { id: string };
    const node = story.nodes.find((n) => n.id === id);
    if (!node) return fail([{ path: "id", message: `unknown node "${id}"` }]);
    return ok(node);
  },
};
