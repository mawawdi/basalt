import { z } from "zod";

/** Signed Q32.32 values are serialized as canonical base-10 integer strings. */
export type Q32_32 = string;

export const Q32_32_SCALE = 4_294_967_296n;
export const Q32_32_MIN = -(1n << 63n);
export const Q32_32_MAX = (1n << 63n) - 1n;
export const Q32_32_SCHEMA = z
  .string()
  .regex(/^(?:0|-?[1-9][0-9]*)$/u)
  .refine((value) => {
    const parsed = BigInt(value);
    return parsed >= Q32_32_MIN && parsed <= Q32_32_MAX;
  }, "Q32.32 value is outside the signed 64-bit range");

/** Parse only the canonical integer representation used at artifact boundaries. */
export function parseQ32_32(value: string): bigint {
  const canonical = Q32_32_SCHEMA.parse(value);
  return BigInt(canonical);
}

export function serializeQ32_32(value: bigint): Q32_32 {
  if (value < Q32_32_MIN || value > Q32_32_MAX)
    throw new Error("Q32.32 value is outside the signed 64-bit range");
  return value.toString();
}

/** Round to nearest, with exact half values rounded away from zero. */
export function quantizeQ32_32(value: number): Q32_32 {
  if (!Number.isFinite(value) || Object.is(value, -0))
    throw new Error("Q32.32 values must be finite and cannot be negative zero");
  const scaled = value * Number(Q32_32_SCALE);
  const rounded = scaled < 0 ? Math.ceil(scaled - 0.5) : Math.floor(scaled + 0.5);
  return serializeQ32_32(BigInt(rounded));
}

export function dequantizeQ32_32(value: Q32_32): number {
  return Number(parseQ32_32(value)) / Number(Q32_32_SCALE);
}

export const q32Vector3Schema = z
  .object({ x: Q32_32_SCHEMA, y: Q32_32_SCHEMA, z: Q32_32_SCHEMA })
  .strict();

export type Vector3Fixed = z.infer<typeof q32Vector3Schema>;

/** Canonical engine stud pitch in meters. All stud-space quantities derive from this. */
export const STUD_METERS = 0.28;

/** Square studs per hectare at the single stud constant. */
export const HECTARE_STUDS2 = 10_000 / STUD_METERS ** 2;

export const aabbFixedSchema = z
  .object({ min: q32Vector3Schema, max: q32Vector3Schema })
  .strict()
  .superRefine((value, context) => {
    for (const axis of ["x", "y", "z"] as const)
      if (parseQ32_32(value.min[axis]) > parseQ32_32(value.max[axis]))
        context.addIssue({ code: "custom", path: ["max", axis], message: "AABB axis is inverted" });
  });

export type AABBFixed = z.infer<typeof aabbFixedSchema>;
