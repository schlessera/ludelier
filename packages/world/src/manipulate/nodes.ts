import { z } from "zod";
import type { Task } from "../registry";
import { ok, fail } from "../result";
import { slugId } from "./ids";

export const createNodeTask: Task = {
  name: "create-node",
  kind: "manipulate",
  description: "Create a new empty node.",
  params: z.object({ id: slugId }),
  apply: (story, params) => {
    const { id } = params as { id: string };
    if (story.nodes.some((n) => n.id === id)) {
      return fail([{ path: "id", message: `node "${id}" already exists` }]);
    }
    return ok({ ...story, nodes: [...story.nodes, { id, body: [] }] });
  },
};

export const deleteNodeTask: Task = {
  name: "delete-node",
  kind: "manipulate",
  description: "Delete a node by id (rejected if it leaves a dangling reference).",
  params: z.object({ id: slugId }),
  apply: (story, params) => {
    const { id } = params as { id: string };
    if (!story.nodes.some((n) => n.id === id)) {
      return fail([{ path: "id", message: `unknown node "${id}"` }]);
    }
    return ok({ ...story, nodes: story.nodes.filter((n) => n.id !== id) });
  },
};
