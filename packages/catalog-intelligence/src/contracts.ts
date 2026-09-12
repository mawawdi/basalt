import { z } from "zod";
import { contentHash, stableJson } from "../../contracts/src/index.js";
import {
  assetFamilyRevisionSchema,
  catalogAssetRecordSchema,
  familyCardSchema,
  type AssetFamilyRevision,
  type CatalogAssetRecord,
  type FamilyCard,
  familyHandleSchema,
  TRIM_BAND_SCHEMA,
} from "../../basalt-types/src/index.js";
import { compareSpatialStrings } from "../../spatial-core/src/primitives.js";

export const CATALOG_INTELLIGENCE_ABI = "basalt-catalog-intelligence@2" as const;

export const CATALOG_SOURCE_KIND_SCHEMA = z.enum([
  "quaternius_trusted",
  "kenney_cc0",
  "creator_owned",
  "commercial_pack",
]);
export type CatalogSourceKind = z.infer<typeof CATALOG_SOURCE_KIND_SCHEMA>;

export const CATALOG_SURFACE_KIND_SCHEMA = z.enum([
  "terrain",
  "floor",
  "ramp",
  "roof",
  "platform",
  "wall",
  "ceiling",
]);
export type CatalogSurfaceKind = z.infer<typeof CATALOG_SURFACE_KIND_SCHEMA>;

export const CATALOG_TEXTURE_EVIDENCE_SCHEMA = z.enum(["embedded", "external", "none"]);
export type CatalogTextureEvidence = z.infer<typeof CATALOG_TEXTURE_EVIDENCE_SCHEMA>;

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const q32Key = z.string().regex(/^(?:0|-?[1-9][0-9]*)$/u);
const q32Vector3 = z.object({ x: q32Key, y: q32Key, z: q32Key }).strict();
const finite = z.number().finite();

const sourceSchema = z
  .object({
    kind: CATALOG_SOURCE_KIND_SCHEMA,
    packageId: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,127}$/u),
    relativePath: z.string().trim().min(1).max(4096),
    externalId: z.string().trim().min(1).max(256).optional(),
    contentHash: hashSchema,
    licenseId: z.string().trim().min(1).max(160),
    commercialUsePermitted: z.boolean(),
    redistributionPermitted: z.boolean(),
    attribution: z.string().trim().min(1).max(512),
  })
  .strict();
export type CatalogSourceEnvelope = z.infer<typeof sourceSchema>;

const collisionEvidenceSchema = z
  .object({
    status: z.enum(["none", "authored_proxy", "measured_mesh"]),
    proxyAssetId: z
      .string()
      .regex(/^[A-Za-z][A-Za-z0-9_-]{0,127}$/u)
      .optional(),
    volumetricInclusionQ32_32: q32Key.optional(),
    triangleRatioQ32_32: q32Key.optional(),
    syntacticGate: z.boolean(),
    volumetricGate: z.boolean(),
    complexityGate: z.boolean(),
    watertight: z.boolean(),
    convex: z.boolean(),
    convexComponentCount: z.number().int().nonnegative().max(8),
  })
  .strict();

const measuredEvidenceSchema = z
  .object({
    status: z.literal("measured"),
    boundsStuds: z.tuple([finite.nonnegative(), finite.nonnegative(), finite.nonnegative()]),
    boundsMinimumQ32_32: q32Vector3,
    boundsMaximumQ32_32: q32Vector3,
    pivotOffsetQ32_32: q32Vector3,
    triangleCount: z.number().int().nonnegative().max(2_000_000),
    vertexCount: z.number().int().nonnegative().max(4_000_000),
    submeshCount: z.number().int().nonnegative().max(8192),
    materialSlotCount: z.number().int().nonnegative().max(512),
    texturePixelCount: z
      .number()
      .int()
      .nonnegative()
      .max(4096 * 4096 * 64),
    supportedSurfaceKinds: z.array(CATALOG_SURFACE_KIND_SCHEMA).max(7),
    primaryContact: z.enum(["bottom", "lateral_wall", "top_ceiling", "socket_only", "unknown"]),
    bottomContactAreaStuds2: finite.nonnegative(),
    supportPlaneFits: z
      .array(
        z
          .object({
            normalQ32_32: q32Vector3,
            originQ32_32: q32Vector3,
            boundaryRadiusStuds: finite.nonnegative(),
            inlierCount: z.number().int().nonnegative(),
            pointCount: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .max(1024),
    supportPlaneRefusal: z
      .enum(["no_patches", "sparse_points", "no_plane", "degenerate_footprint"])
      .nullable(),
    // Whole-building members legitimately expose thousands of planar
    // faces; the family seal still carries only the mating subset.
    jointPlaneFits: z
      .array(
        z
          .object({
            normalQ32_32: q32Vector3,
            originQ32_32: q32Vector3,
            boundaryRadiusStuds: finite.nonnegative(),
            axisAlignmentDegrees: finite.nonnegative(),
            faceAreaStuds2: finite.nonnegative(),
            inlierCount: z.number().int().nonnegative(),
            pointCount: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .max(8192),
    jointPlaneRefusal: z.enum(["no_triangles", "no_planar_faces", "degenerate_faces"]).nullable(),
    surfaceAreaStuds2: finite.nonnegative(),
    texelDensityPixelsPerStud: finite.nonnegative(),
    topologicalGenus: z.number().int(),
    hasManifoldTopology: z.boolean(),
    geometryEvidenceStatus: z.enum(["validated", "invalid_topology"]),
    materialAppearanceHashes: z.array(hashSchema).max(512),
    pbrChannels: z.array(z.string().trim().min(1).max(64)).max(16),
    renderable: z.boolean(),
    collision: collisionEvidenceSchema,
    normalizedPivot: z.enum(["bottom_center_obb", "volumetric_center"]),
    textureEvidence: CATALOG_TEXTURE_EVIDENCE_SCHEMA,
    textureFacts: z
      .array(
        z
          .object({
            width: z.number().int().positive(),
            height: z.number().int().positive(),
            format: z.enum(["BC7", "ASTC_4x4", "PNG_PBR"]),
            texelDensityPxPerMeter: q32Key,
            channelHash: hashSchema,
          })
          .strict(),
      )
      .max(512),
  })
  .strict();

const pendingEvidenceSchema = z
  .object({
    status: z.enum(["pending", "quarantined", "incomplete"]),
    reason: z.string().trim().min(1).max(1024),
  })
  .strict();

export const catalogAssetEnvelopeSchema = z
  .object({
    kind: z.literal("CatalogAssetEnvelope"),
    abi: z.literal(CATALOG_INTELLIGENCE_ABI),
    record: catalogAssetRecordSchema,
    source: sourceSchema,
    measurement: z.union([pendingEvidenceSchema, measuredEvidenceSchema]),
  })
  .strict();
export type CatalogAssetEnvelope = z.infer<typeof catalogAssetEnvelopeSchema>;

export const catalogFamilyDeclarationSchema = z
  .object({
    familyName: z.string().regex(/^[a-z][a-z0-9_]{1,127}$/u),
    handle: familyHandleSchema,
    displayName: z.string().trim().min(1).max(160),
    semanticRole: z.string().trim().min(1).max(160),
    styleTokens: z.array(z.string().trim().min(1).max(80)).max(64),
    sharedTrimSheetAssetId: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,127}$/u),
    members: z
      .array(
        z
          .object({
            assetId: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,127}$/u),
            sourcePath: z.string().trim().min(1).max(4096),
            variantName: z.string().trim().min(1).max(160),
          })
          .strict(),
      )
      .min(1)
      .max(4096),
    status: z.enum(["declared", "sealed", "incomplete"]),
    familyId: z
      .string()
      .regex(/^[A-Za-z][A-Za-z0-9_-]{0,127}$/u)
      .optional(),
    reason: z.string().trim().min(1).max(1024).optional(),
    trimBands: z.array(TRIM_BAND_SCHEMA).max(128).optional(),
    mountSockets: z.boolean().optional(),
    jointSockets: z.boolean().optional(),
    modularKit: z
      .object({
        status: z.enum(["modular", "pending", "quarantined"]),
        reason: z.string().trim().min(1).max(1024),
      })
      .strict()
      .optional(),
  })
  .strict();
export type CatalogFamilyDeclaration = z.infer<typeof catalogFamilyDeclarationSchema>;

export const catalogInventoryManifestSchema = z
  .object({
    kind: z.literal("CatalogInventoryManifest"),
    abi: z.literal(CATALOG_INTELLIGENCE_ABI),
    sourceManifestHashes: z.array(hashSchema).max(32),
    assets: z.array(catalogAssetEnvelopeSchema).max(100_000),
    familyDeclarations: z.array(catalogFamilyDeclarationSchema).max(20_000),
    families: z.array(assetFamilyRevisionSchema).max(20_000),
    familyCards: z.array(familyCardSchema).max(20_000),
    diagnostics: z
      .object({
        unmatchedCollisionCompanions: z.number().int().nonnegative(),
        ambiguousCollisionCompanions: z.number().int().nonnegative(),
        renderablesWithValidCollisionBindings: z.number().int().nonnegative(),
        trimMappingsRejectedByEnergy: z.number().int().nonnegative(),
        incompleteCandidates: z.number().int().nonnegative(),
        modularKitDiagnostics: z
          .object({
            modularFamilies: z.number().int().nonnegative(),
            pendingFamilies: z.number().int().nonnegative(),
            quarantinedFamilies: z.number().int().nonnegative(),
            quarantined: z
              .array(
                z
                  .object({
                    familyName: z.string().min(1).max(128),
                    reason: z.string().min(1).max(1024),
                  })
                  .strict(),
              )
              .max(20_000),
          })
          .strict(),
        kindFamilyDiagnostics: z
          .array(
            z
              .object({
                familyName: z.string().min(1).max(128),
                coherenceOutlierVariants: z.array(z.string().min(1).max(160)).max(4096),
                coverageExceedsHectare: z.boolean(),
              })
              .strict(),
          )
          .max(20_000),
      })
      .strict(),
    hash: hashSchema,
  })
  .strict();
export type CatalogInventoryManifest = z.infer<typeof catalogInventoryManifestSchema>;

/**
 * Local admission rule: a measured asset qualifies iff its geometry is
 * manifold and it carries texture evidence. Unmeasured assets stay pending;
 * measured assets that fail the rule are incomplete until repaired.
 */
export function resolveAdmissionStatus(input: {
  readonly isManifold: boolean;
  readonly textureEvidence: CatalogTextureEvidence;
}): CatalogAssetRecord["admissionStatus"] {
  return input.isManifold && input.textureEvidence !== "none" ? "locally_qualified" : "incomplete";
}

/**
 * Decal-patch quarantine signature. A declared member is a color patch
 * masquerading as volumetric content when its whole mesh samples ~one atlas
 * texel, its spans are flat, and it dwarfs its measured family cohort. All
 * three must hold: solid-color props are volumetric, ground tiles match
 * their flat cohort, and textured flats sample wide UV. Spans are
 * axis-invariant (min/max), so authoring frames cannot hide a patch.
 */
export const PATCH_UV_BBOX_AREA_MAX = 1e-6 as const;
export const PATCH_FLAT_RATIO_MAX = 0.05 as const;
export const PATCH_FAMILY_SPAN_RATIO_MIN = 4 as const;

export function matchesPatchQuarantineSignature(input: {
  /** Union TEXCOORD_0 bbox area over all primitives, in UV units squared. */
  readonly uvBboxArea: number;
  /** Minimum/maximum measured span in studs (any axis order). */
  readonly minSpanStuds: number;
  readonly maxSpanStuds: number;
  /** Median max-span of the declared family cohort, in studs. */
  readonly familyMedianMaxSpanStuds: number;
}): boolean {
  if (
    !Number.isFinite(input.uvBboxArea) ||
    !Number.isFinite(input.minSpanStuds) ||
    !Number.isFinite(input.maxSpanStuds) ||
    !Number.isFinite(input.familyMedianMaxSpanStuds)
  )
    return false;
  if (input.maxSpanStuds <= 0 || input.familyMedianMaxSpanStuds <= 0) return false;
  return (
    input.uvBboxArea < PATCH_UV_BBOX_AREA_MAX &&
    input.minSpanStuds / input.maxSpanStuds < PATCH_FLAT_RATIO_MAX &&
    input.maxSpanStuds / input.familyMedianMaxSpanStuds > PATCH_FAMILY_SPAN_RATIO_MIN
  );
}

export function sealCatalogInventory(input: {
  sourceManifestHashes: readonly string[];
  assets: readonly CatalogAssetEnvelope[];
  familyDeclarations: readonly CatalogFamilyDeclaration[];
  families: readonly AssetFamilyRevision[];
  familyCards: readonly FamilyCard[];
  diagnostics: CatalogInventoryManifest["diagnostics"];
}): CatalogInventoryManifest {
  const sourceManifestHashes = [...new Set(input.sourceManifestHashes)].sort(compareSpatialStrings);
  const assets = input.assets
    .map((asset) => catalogAssetEnvelopeSchema.parse(asset))
    .sort((left, right) => compareSpatialStrings(left.record.assetId, right.record.assetId));
  const familyDeclarations = input.familyDeclarations
    .map((declaration) => catalogFamilyDeclarationSchema.parse(declaration))
    .sort((left, right) => compareSpatialStrings(left.familyName, right.familyName));
  const families = input.families
    .map((family) => assetFamilyRevisionSchema.parse(family))
    .sort((left, right) => compareSpatialStrings(left.familyId, right.familyId));
  const familyCards = input.familyCards
    .map((card) => familyCardSchema.parse(card))
    .sort((left, right) => compareSpatialStrings(left.fid, right.fid));
  if (new Set(assets.map(({ record }) => record.assetId)).size !== assets.length)
    throw new Error("Catalog asset IDs must be unique");
  if (new Set(families.map(({ familyId }) => familyId)).size !== families.length)
    throw new Error("Catalog family IDs must be unique");
  if (new Set(familyCards.map(({ fid }) => fid)).size !== familyCards.length)
    throw new Error("Catalog family card IDs must be unique");
  const familyIds = new Set(families.map(({ familyId }) => familyId));
  if (familyCards.some(({ fid }) => !familyIds.has(fid)))
    throw new Error("Catalog family card has no family revision");
  const assetIds = new Set(assets.map(({ record }) => record.assetId));
  if (
    new Set(familyDeclarations.map((declaration) => declaration.familyName)).size !==
    familyDeclarations.length
  )
    throw new Error("Catalog family declaration names must be unique");
  for (const declaration of familyDeclarations) {
    if (
      new Set(declaration.members.map((member) => member.assetId)).size !==
      declaration.members.length
    )
      throw new Error(`Family declaration ${declaration.familyName} contains duplicate members`);
    for (const member of declaration.members)
      if (!assetIds.has(member.assetId))
        throw new Error(`Family declaration references unknown asset: ${member.assetId}`);
  }
  for (const family of families) {
    for (const member of family.archetypes)
      if (!assetIds.has(member.assetId))
        throw new Error(`Family references unknown asset: ${member.assetId}`);
  }
  const material = {
    kind: "CatalogInventoryManifest" as const,
    abi: CATALOG_INTELLIGENCE_ABI,
    sourceManifestHashes,
    assets,
    familyDeclarations,
    families,
    familyCards,
    diagnostics: input.diagnostics,
  };
  return catalogInventoryManifestSchema.parse({
    ...material,
    hash: contentHash(stableJson(material)),
  });
}

export function assertCatalogInventoryIdentity(
  value: unknown,
): asserts value is CatalogInventoryManifest {
  const inventory = catalogInventoryManifestSchema.parse(value);
  const canonical = sealCatalogInventory(inventory);
  if (canonical.hash !== inventory.hash) throw new Error("Catalog inventory identity is invalid");
}

export type { AssetFamilyRevision, CatalogAssetRecord };
