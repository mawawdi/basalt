import { z } from "zod";
import { contentHash, stableJson } from "../../contracts/src/index.js";
import { compareSpatialStrings, entityId, hashSchema } from "../../spatial-core/src/primitives.js";

export const CATALOG_INTELLIGENCE_ABI = "basalt-catalog-intelligence@1" as const;

export const CATALOG_SOURCE_KIND_SCHEMA = z.enum([
  "quaternius_trusted",
  "kenney_cc0",
  "creator_owned",
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

const finite = z.number().finite();
const positive = finite.positive();
const positiveInteger = z.number().int().positive();
const vector3 = z.tuple([positive, positive, positive]);

const sourceSchema = z
  .object({
    kind: CATALOG_SOURCE_KIND_SCHEMA,
    packageId: entityId,
    relativePath: z.string().trim().min(1).max(4096),
    externalId: z.string().trim().min(1).max(256).optional(),
    contentHash: hashSchema,
    licenseId: z.string().trim().min(1).max(160),
    commercialUsePermitted: z.boolean(),
    redistributionPermitted: z.boolean(),
    attribution: z.string().trim().min(1).max(512),
  })
  .strict();

const pendingMeasurementSchema = z
  .object({
    status: z.literal("pending"),
    reason: z.string().trim().min(1).max(512),
  })
  .strict();

const partialMeasurementFields = z
  .object({
    boundsStuds: vector3,
    triangleCount: positiveInteger.max(2_000_000),
    meshCount: positiveInteger.max(8192),
    materialSlotCount: positiveInteger.max(512),
    texturePixelCount: z
      .number()
      .int()
      .nonnegative()
      .max(4096 * 4096 * 64),
    hasFiniteGeometry: z.literal(true),
    previewHashes: z.array(hashSchema).max(8),
    coverage: z
      .array(z.enum(["gltf_structure", "materials", "textures"]))
      .min(1)
      .max(3),
  })
  .strict();

const partialMeasurementSchema = partialMeasurementFields
  .extend({ status: z.literal("partial") })
  .strict();

const measuredMeasurementSchema = partialMeasurementFields
  .extend({
    status: z.literal("measured"),
    supportedSurfaceKinds: z.array(CATALOG_SURFACE_KIND_SCHEMA).max(7),
    primaryContact: z.enum(["bottom", "lateral_wall", "top_ceiling", "socket_only", "unknown"]),
    bottomContactAreaStuds2: finite.nonnegative(),
    texelDensityPixelsPerStud: finite.nonnegative(),
    hasManifoldTopology: z.boolean(),
    visualEmbeddingHash: hashSchema.optional(),
    semanticEmbeddingHash: hashSchema.optional(),
  })
  .strict();

export const CATALOG_ASSET_RECORD_SCHEMA = z
  .object({
    kind: z.literal("CatalogAssetRecord"),
    abi: z.literal(CATALOG_INTELLIGENCE_ABI),
    assetId: entityId,
    source: sourceSchema,
    tags: z.array(z.string().trim().min(1).max(80)).max(64),
    familyHint: z
      .object({
        kitId: entityId,
        familyKey: z.string().trim().min(1).max(160),
        confidence: z.enum(["source_declared", "derived_hint"]),
      })
      .strict(),
    measurement: z.discriminatedUnion("status", [
      pendingMeasurementSchema,
      partialMeasurementSchema,
      measuredMeasurementSchema,
    ]),
  })
  .strict();
export type CatalogAssetRecord = z.infer<typeof CATALOG_ASSET_RECORD_SCHEMA>;

export const CATALOG_ASSET_FAMILY_SCHEMA = z
  .object({
    kind: z.literal("CatalogAssetFamily"),
    abi: z.literal(CATALOG_INTELLIGENCE_ABI),
    familyId: entityId,
    kitId: entityId,
    familyKey: z.string().trim().min(1).max(160),
    memberAssetIds: z.array(entityId).min(1).max(4096),
    roleTags: z.array(z.string().trim().min(1).max(80)).max(64),
    confidence: z.enum(["source_declared", "derived_hint", "validated"]),
  })
  .strict();
export type CatalogAssetFamily = z.infer<typeof CATALOG_ASSET_FAMILY_SCHEMA>;

export const CATALOG_INVENTORY_MANIFEST_SCHEMA = z
  .object({
    kind: z.literal("CatalogInventoryManifest"),
    abi: z.literal(CATALOG_INTELLIGENCE_ABI),
    sourceManifestHashes: z.array(hashSchema).max(32),
    assets: z.array(CATALOG_ASSET_RECORD_SCHEMA).max(100_000),
    families: z.array(CATALOG_ASSET_FAMILY_SCHEMA).max(20_000),
    hash: hashSchema,
  })
  .strict();
export type CatalogInventoryManifest = z.infer<typeof CATALOG_INVENTORY_MANIFEST_SCHEMA>;

export const CATALOG_QUERY_SCHEMA = z
  .object({
    requiredTags: z.array(z.string().trim().min(1).max(80)).max(32).default([]),
    familyKey: z.string().trim().min(1).max(160).optional(),
    surfaceKind: CATALOG_SURFACE_KIND_SCHEMA.optional(),
    minimumBoundsStuds: vector3.optional(),
    maximumBoundsStuds: vector3.optional(),
    maximumTriangles: positiveInteger.max(2_000_000).optional(),
    requireMeasured: z.boolean().default(true),
    limit: positiveInteger.max(64).default(16),
  })
  .strict();
export type CatalogQuery = z.infer<typeof CATALOG_QUERY_SCHEMA>;

export interface CatalogRetrievalCandidate {
  readonly asset: CatalogAssetRecord;
  readonly score: number;
  readonly matchedTags: readonly string[];
}

export function sealCatalogInventory(input: {
  sourceManifestHashes: readonly string[];
  assets: readonly CatalogAssetRecord[];
  families: readonly CatalogAssetFamily[];
}): CatalogInventoryManifest {
  const sourceManifestHashes = [...new Set(input.sourceManifestHashes)].sort(compareSpatialStrings);
  const assets = input.assets
    .map((asset) => canonicalAsset(asset))
    .sort((left, right) => compareSpatialStrings(left.assetId, right.assetId));
  const families = input.families
    .map((family) => canonicalFamily(family))
    .sort((left, right) => compareSpatialStrings(left.familyId, right.familyId));
  if (new Set(assets.map(({ assetId }) => assetId)).size !== assets.length)
    throw new Error("Catalog asset IDs must be unique");
  if (new Set(families.map(({ familyId }) => familyId)).size !== families.length)
    throw new Error("Catalog family IDs must be unique");
  const assetIds = new Set(assets.map(({ assetId }) => assetId));
  for (const family of families)
    for (const assetId of family.memberAssetIds)
      if (!assetIds.has(assetId))
        throw new Error(`Catalog family references unknown asset: ${assetId}`);
  const material = {
    kind: "CatalogInventoryManifest" as const,
    abi: CATALOG_INTELLIGENCE_ABI,
    sourceManifestHashes,
    assets,
    families,
  };
  return CATALOG_INVENTORY_MANIFEST_SCHEMA.parse({
    ...material,
    hash: contentHash(stableJson(material)),
  });
}

export function assertCatalogInventoryIdentity(
  value: unknown,
): asserts value is CatalogInventoryManifest {
  const inventory = CATALOG_INVENTORY_MANIFEST_SCHEMA.parse(value);
  const canonical = sealCatalogInventory(inventory);
  if (canonical.hash !== inventory.hash) throw new Error("Catalog inventory identity is invalid");
}

export function queryCatalogInventory(
  inventoryInput: CatalogInventoryManifest,
  queryInput: unknown,
): readonly CatalogRetrievalCandidate[] {
  assertCatalogInventoryIdentity(inventoryInput);
  const query = CATALOG_QUERY_SCHEMA.parse(queryInput);
  const requiredTags = new Set(query.requiredTags.map(normalizeTag));
  const candidates: CatalogRetrievalCandidate[] = [];
  for (const asset of inventoryInput.assets) {
    if (query.requireMeasured && asset.measurement.status !== "measured") continue;
    if (query.familyKey && asset.familyHint.familyKey !== query.familyKey) continue;
    if (asset.measurement.status === "partial" || asset.measurement.status === "measured") {
      if (
        query.maximumTriangles !== undefined &&
        asset.measurement.triangleCount > query.maximumTriangles
      )
        continue;
      if (
        query.surfaceKind &&
        (asset.measurement.status !== "measured" ||
          !asset.measurement.supportedSurfaceKinds.includes(query.surfaceKind))
      )
        continue;
      if (
        query.minimumBoundsStuds &&
        query.minimumBoundsStuds.some(
          (minimum, index) =>
            asset.measurement.status === "measured" &&
            asset.measurement.boundsStuds[index]! < minimum,
        )
      )
        continue;
      if (
        query.maximumBoundsStuds &&
        query.maximumBoundsStuds.some(
          (maximum, index) =>
            asset.measurement.status === "measured" &&
            asset.measurement.boundsStuds[index]! > maximum,
        )
      )
        continue;
    }
    const tags = new Set(asset.tags.map(normalizeTag));
    const matchedTags = [...requiredTags]
      .filter((tag) => tags.has(tag))
      .sort(compareSpatialStrings);
    if (requiredTags.size > 0 && matchedTags.length === 0) continue;
    const tagScore = requiredTags.size === 0 ? 0 : matchedTags.length / requiredTags.size;
    const familyScore = query.familyKey ? 1 : 0;
    candidates.push({ asset, score: tagScore * 0.85 + familyScore * 0.15, matchedTags });
  }
  return candidates
    .sort(
      (left, right) =>
        right.score - left.score || compareSpatialStrings(left.asset.assetId, right.asset.assetId),
    )
    .slice(0, query.limit);
}

function canonicalAsset(input: CatalogAssetRecord): CatalogAssetRecord {
  const asset = CATALOG_ASSET_RECORD_SCHEMA.parse(input);
  return {
    ...asset,
    tags: [...new Set(asset.tags.map(normalizeTag))].sort(compareSpatialStrings),
  };
}

function canonicalFamily(input: CatalogAssetFamily): CatalogAssetFamily {
  const family = CATALOG_ASSET_FAMILY_SCHEMA.parse(input);
  return {
    ...family,
    memberAssetIds: [...new Set(family.memberAssetIds)].sort(compareSpatialStrings),
    roleTags: [...new Set(family.roleTags.map(normalizeTag))].sort(compareSpatialStrings),
  };
}

function normalizeTag(value: string): string {
  return value.normalize("NFC").trim().toLocaleLowerCase("en-US");
}
