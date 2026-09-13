import { createHash } from "node:crypto";
import { z } from "zod";

/** Shared immutable identity primitives for Basalt artifacts. */
export type ID = string;
export type Hash = string;
export type ISO8601 = string;
export type RelativePath = string;

export const HASH_SCHEMA = z.string().regex(/^[a-f0-9]{64}$/u);
export const ASCII_ID_SCHEMA = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u);
export const CANONICAL_HANDLE_SCHEMA = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9_]{0,127}$/u);

export const COMPILATION_STATUSES = ["eligible", "incomplete", "rejected"] as const;
export const COMPILATION_STATUS_SCHEMA = z.enum(COMPILATION_STATUSES);
export type CompilationStatus = z.infer<typeof COMPILATION_STATUS_SCHEMA>;

export const DIAGNOSTIC_SCHEMA = z
  .object({
    code: ASCII_ID_SCHEMA,
    message: z.string().trim().min(1).max(2048),
    path: z.array(z.union([z.string().max(256), z.number().int().nonnegative()])).max(64),
    evidenceHashes: z.array(HASH_SCHEMA).max(256),
  })
  .strict();
export type Diagnostic = z.output<typeof DIAGNOSTIC_SCHEMA>;

export const ARTIFACT_REF_SCHEMA = z.object({ kind: ASCII_ID_SCHEMA, hash: HASH_SCHEMA }).strict();
export type ArtifactRef = z.output<typeof ARTIFACT_REF_SCHEMA>;

export type GateResult<T> =
  | { readonly status: "eligible"; readonly value: T; readonly diagnostics: readonly Diagnostic[] }
  | { readonly status: "incomplete"; readonly diagnostics: readonly Diagnostic[] }
  | { readonly status: "rejected"; readonly diagnostics: readonly Diagnostic[] };

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

export function parseQ32_32(value: string): bigint {
  return BigInt(Q32_32_SCHEMA.parse(value));
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

export const Q32_VECTOR3_SCHEMA = z
  .object({ x: Q32_32_SCHEMA, y: Q32_32_SCHEMA, z: Q32_32_SCHEMA })
  .strict();
export type Vector3Fixed = z.output<typeof Q32_VECTOR3_SCHEMA>;

export const AABB_FIXED_SCHEMA = z
  .object({ min: Q32_VECTOR3_SCHEMA, max: Q32_VECTOR3_SCHEMA })
  .strict()
  .superRefine((value, context) => {
    for (const axis of ["x", "y", "z"] as const)
      if (parseQ32_32(value.min[axis]) > parseQ32_32(value.max[axis]))
        context.addIssue({ code: "custom", path: ["max", axis], message: "AABB axis is inverted" });
  });
export type AABBFixed = z.output<typeof AABB_FIXED_SCHEMA>;

/** Hashes the exact UTF-8 material supplied by an artifact producer. */
export function contentHash(value: string): Hash {
  return createHash("sha256").update(value).digest("hex");
}

/** Canonical JSON used by every content-addressed Basalt record. */
export function stableJson(value: unknown): string {
  return JSON.stringify(normalizeJson(value));
}

/** Stable content-derived IDs avoid truncation collisions and semantic data in identity. */
export function contentAddressedEntityId(prefix: string, material: unknown): string {
  const canonicalPrefix = ASCII_ID_SCHEMA.parse(prefix);
  const room = 64 - canonicalPrefix.length - 1;
  if (room < 16) throw new Error("Content-addressed ID prefix leaves too little hash material");
  return `${canonicalPrefix}_${contentHash(stableJson(material)).slice(0, room)}`;
}

/** Canonical comparisons never depend on process locale. */
export function compareCanonicalStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Freeze admitted JSON so hashing inputs cannot be changed after validation. */
export function deepFreezeJson<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreezeJson(child);
    Object.freeze(value);
  }
  return value;
}

function normalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeJson);
  if (isRecord(value))
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter((key) => value[key] !== undefined)
        .map((key) => [key, normalizeJson(value[key])]),
    );
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
