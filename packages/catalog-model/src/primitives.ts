import { z } from "zod";
import {
  AABB_FIXED_SCHEMA,
  CANONICAL_HANDLE_SCHEMA,
  HASH_SCHEMA,
  Q32_32_SCHEMA,
  Q32_VECTOR3_SCHEMA,
  compareCanonicalStrings,
} from "@basalt/contracts";

export const ENTRY_HANDLE_SCHEMA = CANONICAL_HANDLE_SCHEMA;
export const STYLE_PROFILE_HANDLE_SCHEMA = CANONICAL_HANDLE_SCHEMA;
export const MEMBER_ID_SCHEMA = CANONICAL_HANDLE_SCHEMA;
export const INTERFACE_ID_SCHEMA = CANONICAL_HANDLE_SCHEMA;

export const CATALOG_RIGHTS_SCHEMA = z
  .object({
    licenseId: z.string().trim().min(1).max(160),
    commercialUsePermitted: z.boolean(),
    redistributionPermitted: z.boolean(),
    attribution: z.string().max(2048),
    evidenceHash: HASH_SCHEMA,
  })
  .strict();
export type CatalogRights = z.output<typeof CATALOG_RIGHTS_SCHEMA>;

export const CATALOG_ENTRY_KINDS = [
  "substitution_set",
  "assembly_kit",
  "attachment_set",
  "route_kit",
  "environment_realizer",
  "collection",
] as const;
export const CATALOG_ENTRY_KIND_SCHEMA = z.enum(CATALOG_ENTRY_KINDS);
export type CatalogEntryKind = z.output<typeof CATALOG_ENTRY_KIND_SCHEMA>;
export const RUNTIME_CATALOG_ENTRY_KINDS = CATALOG_ENTRY_KINDS.filter(
  (kind) => kind !== "collection",
) as Exclude<CatalogEntryKind, "collection">[];

export const SUPPORT_MODES = [
  "ground",
  "surface",
  "wall",
  "ceiling",
  "socket",
  "free",
  "environment",
] as const;
export const SUPPORT_MODE_SCHEMA = z.enum(SUPPORT_MODES);
export type SupportMode = z.output<typeof SUPPORT_MODE_SCHEMA>;
export const SOCKET_POLARITY_SCHEMA = z.enum(["plug", "socket", "neutral"]);
export const CONTACT_TYPE_SCHEMA = z.enum([
  "bottom",
  "lateral_wall",
  "top_ceiling",
  "socket_only",
  "none",
]);

export const PLACEMENT_SIGNATURE_SCHEMA = z
  .object({
    support: SUPPORT_MODE_SCHEMA,
    contact: CONTACT_TYPE_SCHEMA,
    interfaces: z
      .array(
        z.object({ interfaceId: INTERFACE_ID_SCHEMA, polarity: SOCKET_POLARITY_SCHEMA }).strict(),
      )
      .max(128),
  })
  .strict()
  .superRefine((value, context) => {
    const expectedContact = {
      ground: "bottom",
      surface: "bottom",
      wall: "lateral_wall",
      ceiling: "top_ceiling",
      socket: "socket_only",
      free: "none",
      environment: "none",
    } as const;
    if (value.contact !== expectedContact[value.support])
      context.addIssue({
        code: "custom",
        path: ["contact"],
        message: `Support ${value.support} requires ${expectedContact[value.support]} contact`,
      });
    assertCanonical(value.interfaces, (entry) => `${entry.interfaceId}:${entry.polarity}`, context);
    // Support describes how the asset itself is hosted. Interfaces describe
    // authored connection capabilities it exposes; a grounded wall panel may
    // therefore expose assembly sockets without being socket-hosted itself.
  });
export type PlacementSignature = z.output<typeof PLACEMENT_SIGNATURE_SCHEMA>;

export const CATALOG_VECTOR3_FIXED_SCHEMA = Q32_VECTOR3_SCHEMA;
export const CATALOG_AABB_FIXED_SCHEMA = AABB_FIXED_SCHEMA;
export const POSITIVE_Q32_SCHEMA = Q32_32_SCHEMA.refine((value) => BigInt(value) > 0n, {
  message: "Value must be positive",
});
export const NONNEGATIVE_Q32_SCHEMA = Q32_32_SCHEMA.refine((value) => BigInt(value) >= 0n, {
  message: "Value must be non-negative",
});

export function canonicalUniqueStrings(values: readonly string[], label: string): string[] {
  const canonical = [...values].sort(compareCanonicalStrings);
  if (new Set(canonical).size !== canonical.length) throw new Error(`${label} must be unique`);
  return canonical;
}

function assertCanonical<T>(
  values: readonly T[],
  key: (value: T) => string,
  context: z.RefinementCtx,
): void {
  const keys = values.map(key);
  if (new Set(keys).size !== keys.length)
    context.addIssue({ code: "custom", message: "Values must be unique" });
  if (keys.some((key, index) => index > 0 && compareCanonicalStrings(keys[index - 1]!, key) >= 0))
    context.addIssue({ code: "custom", message: "Values must use canonical code-unit order" });
}
