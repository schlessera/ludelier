import { z } from "zod";

/** Slug-like id param, matching the schema's internal `Id` rule. */
export const slugId = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9_.-]+$/, "id must be slug-like ([A-Za-z0-9_.-]+)");
