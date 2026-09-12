import { z } from "zod";
import {
  aabbFixedSchema,
  Q32_32_SCHEMA,
  q32Vector3Schema,
  type AABBFixed,
  type Q32_32,
  type Vector3Fixed,
} from "./fixed.js";
import { computeFamilyMerkleId, computeFamilyMerkleRoot } from "./merkle.js";
import { familyHandleSchema } from "./taxonomy.js";

const idSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,127}$/u);
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/u);

export const TRIM_BAND_SCHEMA = z
  .object({
    bandId: idSchema,
    semanticRoles: z.array(z.string().trim().min(1).max(80)).min(1).max(16),
    uMin: z.number().finite().min(0).max(1),
    vMin: z.number().finite().min(0).max(1),
    uMax: z.number().finite().min(0).max(1),
    vMax: z.number().finite().min(0).max(1),
    tilingAxis: z.enum(["u", "v", "none"]),
    metricWidth: z.number().finite().positive(),
    metricHeight: z.number().finite().positive(),
  })
  .strict()
  .superRefine((band, context) => {
    if (band.uMin >= band.uMax) {
      context.addIssue({
        code: "custom",
        path: ["uMax"],
        message: "Trim band uMax must be strictly greater than uMin",
      });
    }
    if (band.vMin >= band.vMax) {
      context.addIssue({
        code: "custom",
        path: ["vMax"],
        message: "Trim band vMax must be strictly greater than vMin",
      });
    }
  });

export type TrimBand = z.infer<typeof TRIM_BAND_SCHEMA>;

export const socketContractSchema = z
  .object({
    socketId: idSchema,
    role: z.string().trim().min(1).max(128),
    polarity: z.enum(["Male", "Female", "Neutral"]),
    localOrigin: q32Vector3Schema,
    normal: q32Vector3Schema,
    upVector: q32Vector3Schema,
    boundaryRadius: Q32_32_SCHEMA,
    angularStepDegrees: z.number().int().nonnegative().max(360),
  })
  .strict();
export type SocketContract = z.infer<typeof socketContractSchema>;

export const trimSheetMappingSchema = z
  .object({
    assetId: idSchema,
    bandId: idSchema,
    materialClass: z.enum(["stone", "wood", "metal_trim", "foliage_card"]),
    uMin: Q32_32_SCHEMA,
    uMax: Q32_32_SCHEMA,
    vMin: Q32_32_SCHEMA,
    vMax: Q32_32_SCHEMA,
    targetTexelDensityPxPerMeter: Q32_32_SCHEMA,
    maxDistortionEnergy: Q32_32_SCHEMA,
  })
  .strict();
export type TrimSheetMapping = z.infer<typeof trimSheetMappingSchema>;

export const familyArchetypeMemberSchema = z
  .object({
    assetId: idSchema,
    variantName: z.string().trim().min(1).max(160),
    selectionWeight: Q32_32_SCHEMA,
    metricScaleVarianceMin: Q32_32_SCHEMA,
    metricScaleVarianceMax: Q32_32_SCHEMA,
    registeredSockets: z.array(socketContractSchema).max(128),
  })
  .strict();
export type FamilyArchetypeMember = z.infer<typeof familyArchetypeMemberSchema>;

export const assetFamilyRevisionSchema = z
  .object({
    familyId: z.string().regex(/^family_[a-z0-9_]+_[a-f0-9]{12,64}$/u),
    familyHandle: familyHandleSchema,
    semanticRole: z.string().trim().min(1).max(160),
    sharedTrimSheetAssetId: idSchema,
    trimMappings: z.array(trimSheetMappingSchema).max(512),
    archetypes: z.array(familyArchetypeMemberSchema).min(1),
    compositeBoundingEnvelope: aabbFixedSchema,
    globalStyleContractHash: hashSchema,
    materialTrimSheetHash: hashSchema,
    geometryHashes: z.array(hashSchema).min(1).max(4096),
    physicsCompanionHash: hashSchema,
    socketGrammarHash: hashSchema.optional(),
    contentMerkleRoot: hashSchema,
  })
  .strict();
export type AssetFamilyRevision = z.infer<typeof assetFamilyRevisionSchema>;

export function sealAssetFamilyRevision(
  input: Omit<AssetFamilyRevision, "contentMerkleRoot">,
): AssetFamilyRevision {
  const material = assetFamilyRevisionSchema.omit({ contentMerkleRoot: true }).parse(input);
  const merkleInput = {
    handle: material.familyHandle,
    geometryHashes: material.geometryHashes,
    materialTrimHash: material.materialTrimSheetHash,
    physicsCompanionHash: material.physicsCompanionHash,
    ...(material.socketGrammarHash ? { socketGrammarHash: material.socketGrammarHash } : {}),
  };
  const contentMerkleRoot = computeFamilyMerkleRoot(merkleInput);
  const familyId = computeFamilyMerkleId(merkleInput);
  if (material.familyId !== familyId)
    throw new Error(
      `Family ID does not match its taxonomy and Merkle evidence: ${material.familyId}`,
    );
  return assetFamilyRevisionSchema.parse({ ...material, contentMerkleRoot });
}

export type { AABBFixed, Q32_32, Vector3Fixed };
