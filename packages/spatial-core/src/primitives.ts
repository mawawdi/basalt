import { types } from "node:util";
import { z } from "zod";
import {
  Q32_32_MAX,
  Q32_32_MIN,
  Q32_32_SCALE,
  quantizeQ32_32,
  serializeQ32_32,
  type Q32_32,
} from "@basalt/contracts";

/** Opaque, case-sensitive keys used by Basalt's spatial graph. */
export const entityId = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^[A-Za-z][A-Za-z0-9_-]{0,63}$/,
    "Identifiers must start with a letter and contain only ASCII letters, digits, underscores or hyphens; spelling is case-sensitive",
  );
export const hashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
export function compareSpatialStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
export type SpatialJsonValue =
  null | boolean | number | string | SpatialJsonValue[] | { [key: string]: SpatialJsonValue };

export { Q32_32_MAX, Q32_32_MIN, Q32_32_SCALE, quantizeQ32_32, serializeQ32_32 };
export type { Q32_32 };

/** MurmurHash3 fmix32 finalizer, used by the seeded population PRNG. */
export function murmurHash3Uint32(value: number): number {
  let state = value >>> 0;
  state ^= state >>> 16;
  state = Math.imul(state, 0x85ebca6b) >>> 0;
  state ^= state >>> 13;
  state = Math.imul(state, 0xc2b2ae35) >>> 0;
  state ^= state >>> 16;
  return state >>> 0;
}

export function createMurmurHash3Random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    return murmurHash3Uint32(state) / 0x1_0000_0000;
  };
}

/** Resource limits for model-authored spatial declarations. */
export const SPATIAL_ADMISSION_POLICY_SCHEMA = z
  .object({
    maximumJsonBytes: z.number().int().safe().positive(),
    maximumJsonDepth: z.number().int().positive().max(64),
    maximumJsonNodes: z.number().int().safe().positive(),
    maximumStringUtf8Bytes: z.number().int().safe().positive(),
    maximumComponents: z.number().int().safe().positive(),
    maximumFiles: z.number().int().safe().positive(),
    maximumDeclaredSourceBytes: z.number().int().safe().positive(),
    maximumFileSourceBytes: z.number().int().safe().positive(),
    maximumConnections: z.number().int().safe().positive(),
    maximumArtifactDependencies: z.number().int().safe().positive(),
    maximumDefinitions: z.number().int().safe().positive(),
  })
  .strict();
export type SpatialAdmissionPolicy = z.infer<typeof SPATIAL_ADMISSION_POLICY_SCHEMA>;
export const DEFAULT_SPATIAL_ADMISSION_POLICY: Readonly<SpatialAdmissionPolicy> = Object.freeze({
  maximumJsonBytes: 1024 * 1024,
  maximumJsonDepth: 32,
  maximumJsonNodes: 50_000,
  maximumStringUtf8Bytes: 64 * 1024,
  maximumComponents: 8192,
  maximumFiles: 8192,
  maximumDeclaredSourceBytes: 64 * 1024 * 1024,
  maximumFileSourceBytes: 20 * 1024 * 1024,
  maximumConnections: 65_536,
  maximumArtifactDependencies: 65_536,
  maximumDefinitions: 1,
});

export class SpatialAdmissionError extends Error {
  constructor(
    readonly code: string,
    readonly subject: string,
    detail: string,
  ) {
    super(detail);
  }
}

/** Validate bounded, plain JSON before schemas or content hashes inspect it. */
export function assertBoundedSpatialJson(
  value: unknown,
  policy: SpatialAdmissionPolicy = DEFAULT_SPATIAL_ADMISSION_POLICY,
): asserts value is SpatialJsonValue {
  const active = new Set<object>();
  const stack: Array<{ value: unknown; depth: number; exit?: boolean }> = [{ value, depth: 0 }];
  let nodes = 0;
  let bytes = 0;
  const invalid = (detail: string): never => {
    throw new SpatialAdmissionError("invalid_json", "$", detail);
  };
  const addBytes = (count: number): void => {
    bytes += count;
    if (bytes > policy.maximumJsonBytes)
      throw new SpatialAdmissionError("resource_limit", "$", "Canonical JSON byte budget exceeded");
  };
  const stringBytes = (text: string): void => {
    if (Buffer.byteLength(text, "utf8") > policy.maximumStringUtf8Bytes)
      throw new SpatialAdmissionError("resource_limit", "$", "JSON string byte budget exceeded");
    for (let index = 0; index < text.length; index += 1) {
      const unit = text.charCodeAt(index);
      if (unit >= 0xd800 && unit <= 0xdbff) {
        const next = text.charCodeAt(++index);
        if (!(next >= 0xdc00 && next <= 0xdfff)) invalid("JSON strings must contain valid Unicode");
      } else if (unit >= 0xdc00 && unit <= 0xdfff)
        invalid("JSON strings must contain valid Unicode");
    }
    addBytes(Buffer.byteLength(JSON.stringify(text), "utf8"));
  };
  while (stack.length > 0) {
    const item = stack.pop()!;
    if (item.exit) {
      active.delete(item.value as object);
      continue;
    }
    if (++nodes > policy.maximumJsonNodes || item.depth > policy.maximumJsonDepth)
      throw new SpatialAdmissionError("resource_limit", "$", "JSON node or depth budget exceeded");
    const current = item.value;
    if (current === null) {
      addBytes(4);
      continue;
    }
    if (typeof current === "string") {
      stringBytes(current);
      continue;
    }
    if (typeof current === "boolean") {
      addBytes(current ? 4 : 5);
      continue;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current) || Object.is(current, -0))
        invalid("JSON numbers must be finite and canonical");
      addBytes(JSON.stringify(current).length);
      continue;
    }
    if (typeof current !== "object") invalid("Only plain JSON data is admissible");
    const object = current as object;
    if (types.isProxy(object)) invalid("Proxies are not plain JSON data");
    if (active.has(object)) invalid("JSON cycles are forbidden");
    const array = Array.isArray(object);
    const prototype = Object.getPrototypeOf(object) as unknown;
    if (
      array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null
    )
      invalid("Only regular JSON objects and arrays are admissible");
    const descriptors = Object.getOwnPropertyDescriptors(object);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some((key) => typeof key !== "string")) invalid("Symbol properties are forbidden");
    const entries = Object.entries(descriptors).filter(([key]) => !array || key !== "length");
    if (
      entries.length > policy.maximumJsonNodes - nodes ||
      stack.length + entries.length > policy.maximumJsonNodes
    )
      throw new SpatialAdmissionError("resource_limit", "$", "JSON node budget exceeded");
    if (array) {
      const length = descriptors.length?.value as unknown;
      if (
        typeof length !== "number" ||
        length !== entries.length ||
        entries.some(([key], index) => key !== String(index))
      )
        invalid("Arrays must be dense and have no extra properties");
    }
    active.add(object);
    stack.push({ value: object, depth: item.depth, exit: true });
    addBytes(2 + Math.max(0, entries.length - 1));
    for (const [key, descriptor] of entries) {
      if (!descriptor.enumerable || !("value" in descriptor))
        invalid("Accessors and non-enumerable properties are forbidden");
      if (key === "__proto__") invalid("The __proto__ key cannot be preserved by schema admission");
      if (!array) {
        stringBytes(key);
        addBytes(1);
      }
      stack.push({ value: descriptor.value, depth: item.depth + 1 });
    }
  }
}
