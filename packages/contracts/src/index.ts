import { createHash } from "node:crypto";

/** Shared immutable identity primitives for Basalt artifacts. */
export type ID = string;
export type Hash = string;
export type ISO8601 = string;
export type RelativePath = string;

/** Hashes the exact UTF-8 material supplied by an artifact producer. */
export function contentHash(value: string): Hash {
  return createHash("sha256").update(value).digest("hex");
}

/** Canonical JSON used by every content-addressed Basalt record. */
export function stableJson(value: unknown): string {
  return JSON.stringify(normalizeJson(value));
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
