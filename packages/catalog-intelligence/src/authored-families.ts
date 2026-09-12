import { z } from "zod";
import {
  familyHandleSchema,
  HECTARE_STUDS2,
  parseFamilyHandle,
  ROLE_CLEARANCE_DEFAULTS,
  ROLE_DENSITY_DEFAULTS,
  TRIM_BAND_SCHEMA,
} from "../../basalt-types/src/index.js";
import {
  checkSiblingCoherence,
  KIND_COHERENCE_THRESHOLD,
  type ProposalAssetEvidence,
} from "./family-proposals.js";

export const AUTHORED_FAMILY_MANIFEST_KIND = "BasaltAuthoredFamilyManifest" as const;
export const AUTHORED_FAMILY_MANIFEST_ABI = "basalt-authored-families@2" as const;

const familyNameSchema = z.string().regex(/^[a-z][a-z0-9_]{1,127}$/u);
const memberSchema = z
  .object({
    sourcePath: z.string().trim().min(1).max(4096),
    variantName: z.string().trim().min(1).max(160),
  })
  .strict();

export const authoredFamilyDeclarationSchema = z
  .object({
    familyName: familyNameSchema,
    handle: familyHandleSchema,
    displayName: z.string().trim().min(1).max(160),
    semanticRole: z.string().trim().min(1).max(160),
    styleTokens: z.array(z.string().trim().min(1).max(80)).max(64),
    sharedTrimSheetAssetId: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,127}$/u),
    members: z.array(memberSchema).min(1).max(4096),
    trimBands: z.array(TRIM_BAND_SCHEMA).max(128).optional(),
    mountSockets: z.boolean().optional(),
  })
  .strict();
export type AuthoredFamilyDeclaration = z.infer<typeof authoredFamilyDeclarationSchema>;

export const authoredFamilyManifestSchema = z
  .object({
    kind: z.literal(AUTHORED_FAMILY_MANIFEST_KIND),
    abi: z.literal(AUTHORED_FAMILY_MANIFEST_ABI),
    families: z.array(authoredFamilyDeclarationSchema).max(20_000),
  })
  .strict();
export type AuthoredFamilyManifest = z.infer<typeof authoredFamilyManifestSchema>;

export function parseAuthoredFamilyManifest(value: unknown): AuthoredFamilyManifest {
  const manifest = authoredFamilyManifestSchema.parse(value);
  const names = new Set<string>();
  const handles = new Set<string>();
  const members = new Set<string>();
  for (const family of manifest.families) {
    if (names.has(family.familyName))
      throw new Error(`Duplicate authored family: ${family.familyName}`);
    names.add(family.familyName);
    if (handles.has(family.handle))
      throw new Error(
        `Source asset belongs to multiple authored families through handle: ${family.handle}`,
      );
    handles.add(family.handle);
    for (const member of family.members) {
      if (members.has(member.sourcePath))
        throw new Error(`Source asset belongs to multiple authored families: ${member.sourcePath}`);
      members.add(member.sourcePath);
    }
  }
  return manifest;
}

export interface KindAdmissionViolation {
  readonly assetId?: string;
  readonly variantName?: string;
  readonly reason: string;
}

export interface KindAdmissionMember {
  readonly assetId: string;
  readonly variantName: string;
  readonly boundsStuds: readonly [number, number, number];
  readonly triangleCount: number;
  readonly submeshCount: number;
  readonly primaryContact: string;
  readonly hasManifoldTopology: boolean;
  readonly topologicalGenus: number;
  readonly materialAppearanceHashes: readonly string[];
  readonly sourceFileHash: string;
}

/**
 * Admission gate: kind, not size. Every member must carry measured support
 * evidence; the members must cohere as one scale-free kind (miniature and
 * landscape variants of one shape cohere); and the declared role's default
 * treatment must be physically realizable for the largest member (coverage
 * formula). Absolute size never admits or rejects on its own.
 */
export function findKindAdmissionViolations(
  handle: string,
  members: readonly KindAdmissionMember[],
): KindAdmissionViolation[] {
  const violations: KindAdmissionViolation[] = [];
  for (const member of members) {
    if (member.primaryContact === "bottom") continue;
    violations.push({
      assetId: member.assetId,
      variantName: member.variantName,
      reason:
        `${member.variantName} has no measured support evidence ` +
        `(primaryContact ${member.primaryContact}); placeable families require bottom support`,
    });
  }
  const evidence: ProposalAssetEvidence[] = members.map((member) => ({
    assetId: member.assetId,
    boundsStuds: member.boundsStuds,
    triangleCount: member.triangleCount,
    submeshCount: member.submeshCount,
    primaryContact: member.primaryContact,
    hasManifoldTopology: member.hasManifoldTopology,
    topologicalGenus: member.topologicalGenus,
    materialAppearanceHashes: member.materialAppearanceHashes,
    sourceFileHash: member.sourceFileHash,
  }));
  const coherence = checkSiblingCoherence(evidence);
  const byId = new Map(members.map((member) => [member.assetId, member]));
  for (const assetId of coherence.outliers) {
    const member = byId.get(assetId)!;
    violations.push({
      assetId,
      variantName: member.variantName,
      reason:
        `${member.variantName} sits outside the declaration kind coherence radius ` +
        `(${KIND_COHERENCE_THRESHOLD}) from the medoid; it is not the declared kind`,
    });
  }
  const parsed = parseFamilyHandle(handle);
  const density = ROLE_DENSITY_DEFAULTS[parsed.spatialRole];
  const clearance = ROLE_CLEARANCE_DEFAULTS[parsed.spatialRole];
  if (density.max_per_hectare > 0 && members.length > 0) {
    const extent = Math.max(
      ...members.map((member) => Math.max(member.boundsStuds[0], member.boundsStuds[2])),
    );
    const cell = (extent + 2 * clearance) ** 2;
    const demand = density.max_per_hectare * cell;
    if (demand > HECTARE_STUDS2)
      violations.push({
        reason:
          `declared ${parsed.spatialRole} treatment scatters ${density.max_per_hectare}/ha ` +
          `but the largest member spans ${extent.toFixed(2)} studs: coverage demand ` +
          `${demand.toFixed(0)} exceeds one hectare (${HECTARE_STUDS2.toFixed(0)} square studs)`,
      });
  }
  return violations;
}
