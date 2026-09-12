import { z } from "zod";

export const TAXONOMY_DOMAINS = [
  "nature",
  "geology",
  "architecture",
  "infrastructure",
  "props",
  "foliage",
  "industrial",
] as const;
export type TaxonomyDomain = (typeof TAXONOMY_DOMAINS)[number];

export const SPATIAL_ROLES = [
  "foundation",
  "barrier",
  "canopy",
  "groundcover",
  "focal_insert",
  "portal",
  "connector",
  "clutter",
] as const;
export type SpatialRole = (typeof SPATIAL_ROLES)[number];

export const VARIANT_ROLE_TOKENS = [
  "tall",
  "medium",
  "short",
  "curved",
  "corner_in",
  "corner_out",
  "straight",
  "cluster",
  "stump",
  "pillar",
  "wall_straight",
  "wall_corner",
  "wall_tee",
  "archway",
  "cap",
] as const;
export type VariantRoleToken = (typeof VARIANT_ROLE_TOKENS)[number];

const identifier = String.raw`[a-z0-9]+(?:_[a-z0-9]+)*`;
const vendor = String.raw`[a-z0-9_-]+`;
const domains = TAXONOMY_DOMAINS.join("|");
const roles = SPATIAL_ROLES.join("|");
const variants = VARIANT_ROLE_TOKENS.join("|");

export const FAMILY_HANDLE_REGEX = new RegExp(
  String.raw`^(?:@(?<vendor>${vendor})/)?(?<domain>${domains})/(?<spatialRole>${roles})/(?<styleMotif>${identifier})/(?<morphologyNoun>${identifier})(?:@(?<forkTag>(?:season|reskin|weathering|damage)_${identifier}))?(?:\+(?<extensionTag>ext_${identifier}))?(?:#(?<variantToken>${variants}))?$`,
  "u",
);

export const familyHandleSchema = z.string().regex(FAMILY_HANDLE_REGEX);
export type FamilyHandle = z.infer<typeof familyHandleSchema>;

export interface ParsedFamilyHandle {
  readonly rawHandle: FamilyHandle;
  readonly vendor?: string;
  readonly domain: TaxonomyDomain;
  readonly spatialRole: SpatialRole;
  readonly styleMotif: string;
  readonly morphologyNoun: string;
  readonly forkTag?: string;
  readonly extensionTag?: string;
  readonly variantToken?: VariantRoleToken;
}

export function parseFamilyHandle(value: string): ParsedFamilyHandle {
  const match = FAMILY_HANDLE_REGEX.exec(value);
  if (!match?.groups) throw new Error(`Invalid family handle: ${value}`);
  return {
    rawHandle: value as FamilyHandle,
    domain: match.groups.domain as TaxonomyDomain,
    spatialRole: match.groups.spatialRole as SpatialRole,
    styleMotif: match.groups.styleMotif!,
    morphologyNoun: match.groups.morphologyNoun!,
    ...(match.groups.vendor !== undefined ? { vendor: match.groups.vendor } : {}),
    ...(match.groups.forkTag !== undefined ? { forkTag: match.groups.forkTag } : {}),
    ...(match.groups.extensionTag !== undefined ? { extensionTag: match.groups.extensionTag } : {}),
    ...(match.groups.variantToken !== undefined
      ? { variantToken: match.groups.variantToken as VariantRoleToken }
      : {}),
  };
}

export function handleCore(value: string): string {
  const parsed = parseFamilyHandle(value);
  return [parsed.domain, parsed.spatialRole, parsed.styleMotif, parsed.morphologyNoun].join("/");
}

export function sanitizeFamilyHandle(value: string): string {
  return value.replace(/[@/+#]/gu, "_");
}

/**
 * Per-role exclusion radius in studs around each placed instance, consumed
 * by the population pass and the treatment coverage formula. Roles carry
 * treatment defaults only; nothing gates family membership on size.
 */
export const ROLE_CLEARANCE_DEFAULTS: Readonly<Record<SpatialRole, number>> = {
  foundation: 0,
  barrier: 0.5,
  canopy: 4,
  groundcover: 0,
  focal_insert: 2,
  portal: 6,
  connector: 1,
  clutter: 0.2,
};
