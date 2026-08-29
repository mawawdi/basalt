import { z } from "zod";

export const worldEntityId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u);
export const worldHash = z.string().regex(/^[a-f0-9]{64}$/u);
