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
    jointSockets: z.boolean().optional(),
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

export interface SupportEvidenceViolation {
  readonly assetId?: string;
  readonly variantName?: string;
  readonly reason: string;
}

export interface KindEvidenceMember {
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
 * Blocking admission gate: every member must carry measured support
 * evidence. Authorial grouping is never rejected here; kind coherence and
 * treatment coverage are measured by measureKindFamilyDiagnostics and
 * recorded, never used to split or refuse a declaration.
 */
export function findSupportEvidenceViolations(
  members: readonly KindEvidenceMember[],
): SupportEvidenceViolation[] {
  const violations: SupportEvidenceViolation[] = [];
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
  return violations;
}

export interface KindCoherenceDiagnostic {
  readonly threshold: number;
  readonly medoidAssetId: string | null;
  readonly outlierVariants: readonly string[];
}

export interface KindCoverageDiagnostic {
  readonly spatialRole: string;
  readonly maxPerHectare: number;
  readonly largestExtentStuds: number;
  readonly demandStuds2: number;
  readonly hectareStuds2: number;
  readonly exceedsHectare: boolean;
}

export interface KindFamilyDiagnostics {
  readonly coherence: KindCoherenceDiagnostic;
  readonly coverage: KindCoverageDiagnostic;
}

/**
 * Recorded kind evidence for one authorial family: medoid-star coherence
 * outliers against KIND_COHERENCE_THRESHOLD (miniature and landscape
 * variants of one shape cohere; outliers do not) and the declared role's
 * treatment coverage for the largest member. Informative only; the seal
 * admits the declaration regardless.
 */
export function measureKindFamilyDiagnostics(
  handle: string,
  members: readonly KindEvidenceMember[],
): KindFamilyDiagnostics {
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
  const parsed = parseFamilyHandle(handle);
  const density = ROLE_DENSITY_DEFAULTS[parsed.spatialRole];
  const clearance = ROLE_CLEARANCE_DEFAULTS[parsed.spatialRole];
  const extent =
    members.length > 0
      ? Math.max(...members.map((member) => Math.max(member.boundsStuds[0], member.boundsStuds[2])))
      : 0;
  const demand =
    density.max_per_hectare > 0 ? density.max_per_hectare * (extent + 2 * clearance) ** 2 : 0;
  return {
    coherence: {
      threshold: KIND_COHERENCE_THRESHOLD,
      medoidAssetId: coherence.medoidAssetId,
      outlierVariants: coherence.outliers.map((assetId) => byId.get(assetId)!.variantName),
    },
    coverage: {
      spatialRole: parsed.spatialRole,
      maxPerHectare: density.max_per_hectare,
      largestExtentStuds: extent,
      demandStuds2: demand,
      hectareStuds2: HECTARE_STUDS2,
      exceedsHectare: demand > HECTARE_STUDS2,
    },
  };
}
