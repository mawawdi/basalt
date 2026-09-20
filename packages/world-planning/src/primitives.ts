import { z } from "zod";

export const worldEntityId = z
  .string()
  .min(1)
  .regex(/^[A-Za-z][A-Za-z0-9_-]*$/u);
export const worldHash = z.string().regex(/^[a-f0-9]{64}$/u);
