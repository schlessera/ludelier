import { z } from "zod";

/** A slug-like identifier (node ids, character ids). */
const Id = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9_.-]+$/, "id must be slug-like ([A-Za-z0-9_.-]+)");

/** Variable values are primitives only — keeps state JSON-serialisable and hashable. */
export const VarValue = z.union([z.string(), z.number(), z.boolean()]);
export type VarValue = z.infer<typeof VarValue>;

export const Cmp = z.enum(["eq", "ne", "gt", "lt", "gte", "lte"]);
export type Cmp = z.infer<typeof Cmp>;

/** A declarative condition over a single variable. No expressions, no eval. */
export const Condition = z.object({
  var: z.string().min(1),
  cmp: Cmp,
  value: VarValue,
});
export type Condition = z.infer<typeof Condition>;

export const SayStatement = z.object({
  op: z.literal("say"),
  who: Id,
  text: z.string(),
});
export const SetStatement = z.object({
  op: z.literal("set"),
  var: z.string().min(1),
  value: VarValue,
});
export const AddStatement = z.object({
  op: z.literal("add"),
  var: z.string().min(1),
  amount: z.number(),
});
export const RollStatement = z.object({
  op: z.literal("roll"),
  var: z.string().min(1),
  min: z.number().int(),
  max: z.number().int(),
});
export const ChoiceOption = z.object({
  label: z.string().min(1),
  goto: Id,
  if: Condition.optional(),
});
export const ChoiceStatement = z.object({
  op: z.literal("choice"),
  prompt: z.string().optional(),
  options: z.array(ChoiceOption).min(1),
});
export const JumpStatement = z.object({
  op: z.literal("jump"),
  goto: Id,
});
export const EndStatement = z.object({
  op: z.literal("end"),
});

/** Where a character sprite sits on the stage. The renderer maps these to x positions. */
export const SpritePosition = z.enum(["left", "center", "right"]);
export type SpritePosition = z.infer<typeof SpritePosition>;

/** Set the background and clear all sprites. Omitting `bg` clears to an empty stage. */
export const SceneStatement = z.object({
  op: z.literal("scene"),
  bg: Id.optional(),
});
/** Display a sprite in a named slot. Showing the same `sprite` slot again replaces it. */
export const ShowStatement = z.object({
  op: z.literal("show"),
  sprite: Id,
  asset: Id,
  at: SpritePosition.default("center"),
});
/** Remove a sprite slot from the stage. Hiding an absent slot is a no-op. */
export const HideStatement = z.object({
  op: z.literal("hide"),
  sprite: Id,
});

/** The full statement set. Discriminated on `op` for precise validation + narrowing. */
export const Statement = z.discriminatedUnion("op", [
  SayStatement,
  SetStatement,
  AddStatement,
  RollStatement,
  ChoiceStatement,
  JumpStatement,
  EndStatement,
  SceneStatement,
  ShowStatement,
  HideStatement,
]);
export type Statement = z.infer<typeof Statement>;

export const Character = z.object({
  id: Id,
  name: z.string().min(1),
  color: z.string().optional(),
});
export type Character = z.infer<typeof Character>;

/**
 * A media asset (image now; audio later) referenced by id from statements.
 * `src` is a path/URL the runtime resolves and loads — declaring assets centrally
 * lets the renderer preload them and gives P3 a home for provenance sidecars.
 */
export const Asset = z.object({
  id: Id,
  src: z.string().min(1),
});
export type Asset = z.infer<typeof Asset>;

export const StoryNode = z.object({
  id: Id,
  body: z.array(Statement),
});
export type StoryNode = z.infer<typeof StoryNode>;

/**
 * Pure shape (no cross-reference checks). Use `validateStory()` from `./validate`
 * to additionally verify ids are unique and all gotos resolve.
 */
export const StoryObject = z.object({
  meta: z.object({
    id: Id,
    title: z.string(),
    start: Id,
    seed: z.number().int().optional(),
  }),
  characters: z.array(Character).default([]),
  assets: z.array(Asset).default([]),
  nodes: z.array(StoryNode).min(1),
});
export type Story = z.infer<typeof StoryObject>;
