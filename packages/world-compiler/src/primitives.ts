import { z } from "zod";

/**
 * Spatial identifiers are deliberately independent from gameplay schemas. The
 * cap fits content-addressed sealed world IDs without encoding hierarchy in
 * their spelling.
 */
export const worldEntityId = z
  .string()
  .min(1)
  .max(512)
  .regex(
    /^[A-Za-z][A-Za-z0-9_-]{0,511}$/u,
    "World identifiers must start with a letter and contain only ASCII letters, digits, underscores or hyphens",
  );

export const worldHash = z.string().regex(/^[a-f0-9]{64}$/u);

export function compareWorldStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
