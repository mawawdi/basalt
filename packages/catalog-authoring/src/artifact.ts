import { z } from "zod";
import {
  compareCanonicalStrings,
  contentHash,
  deepFreezeJson,
  stableJson,
} from "@basalt/contracts";

export function canonicalValues<T>(
  values: readonly T[],
  key: (value: T) => string,
  label: string,
): T[] {
  const result = [...values].sort((left, right) => compareCanonicalStrings(key(left), key(right)));
  if (new Set(result.map(key)).size !== result.length) throw new Error(`${label} must be unique`);
  return result;
}

export function sealArtifact<T extends z.ZodTypeAny>(schema: T, material: object): z.output<T> {
  return deepFreezeJson(
    schema.parse({ ...material, hash: contentHash(stableJson(material)) }),
  ) as z.output<T>;
}

export function verifyArtifactHash(value: Record<string, unknown>, context: z.RefinementCtx): void {
  const material = { ...value };
  delete material.hash;
  if (contentHash(stableJson(material)) !== value.hash)
    context.addIssue({ code: "custom", path: ["hash"], message: "Artifact hash mismatch" });
}

export function requireCanonicalValues<T>(
  values: readonly T[],
  key: (value: T) => string,
  label: string,
  context: z.RefinementCtx,
): void {
  const keys = values.map(key);
  if (
    new Set(keys).size !== keys.length ||
    stableJson([...keys].sort(compareCanonicalStrings)) !== stableJson(keys)
  )
    context.addIssue({ code: "custom", message: `${label} must be unique and canonical` });
}
