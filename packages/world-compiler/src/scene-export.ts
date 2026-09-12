import { z } from "zod";
import { contentHash, stableJson } from "../../contracts/src/index.js";
import { splitGlbMeshParts } from "../../asset-inspection/src/glb.js";
import { STUD_METERS, dequantizeQ32_32 } from "../../basalt-types/src/index.js";
import type { AssetFamilyRevision } from "../../basalt-types/src/index.js";
import type { CatalogAssetEnvelope } from "../../catalog-intelligence/src/contracts.js";
import {
  exportVoxelField,
  sha256Bytes,
  type RoadAssembly,
} from "../../world-planning/src/index.js";
import { worldEntityId, worldHash, compareWorldStrings } from "./primitives.js";
import type { BasaltHierarchicalWorld } from "./tiers.js";
import type { WorldPopulationInstance } from "./contracts.js";
import { groundingKindFromSpan } from "./grounding.js";
import type { ChunkedRoomContent } from "./rooms.js";

export const BASALT_SCENE_EXPORT_ABI = "basalt-scene-export@1" as const;

const finite = z.number().finite();
const vector3Finite = z.object({ x: finite, y: finite, z: finite }).strict();
const quaternion = z
  .tuple([finite, finite, finite, finite])
  .refine((value) => Math.abs(Math.hypot(...value) - 1) <= 1e-5, "Rotation must be normalized");

const placementConventionSchema = z
  .object({
    lengthUnit: z.literal("meter"),
    upAxis: z.literal("+Y"),
    handedness: z.literal("right-handed"),
    instanceComposition: z.literal(
      "T(positionMeters).R(rotationQuaternion).S(uniformScale).T(-pivotOffsetMeters).S(unitsToMeters)",
    ),
  })
  .strict();

const scenePartSchema = z
  .object({
    contentHash: worldHash,
    byteLength: z.number().int().positive(),
    mediaType: z.literal("model/gltf-binary"),
    assetId: z.string().min(1).max(128),
    nodeName: z.string().min(1).max(256),
    triangleCount: z.number().int().nonnegative(),
    boundsSourceUnits: z.object({ minimum: vector3Finite, maximum: vector3Finite }).strict(),
    // Node origin in source units: the pivot the engine importer must
    // preserve (Roblox "Use Imported Pivot" default). Lowering adapters
    // verify the imported pivot against this point and fail closed on drift.
    pivotSourceUnits: vector3Finite,
  })
  .strict();

const sceneAssetSchema = z
  .object({
    assetId: z.string().min(1).max(128),
    unitsToMeters: finite.positive(),
    pivotOffsetMeters: vector3Finite,
    partHashes: z.array(worldHash).min(1),
  })
  .strict();

const sceneInstanceSchema = z
  .object({
    id: worldEntityId,
    chunkId: worldEntityId,
    familyId: worldEntityId,
    archetypeId: worldEntityId,
    assetId: z.string().min(1).max(128),
    positionMeters: vector3Finite,
    rotation: quaternion,
    scale: finite.positive(),
  })
  .strict();

const sceneSkirtFaceSchema = z
  .object({
    topLeft: vector3Finite,
    topRight: vector3Finite,
    bottomLeft: vector3Finite,
    bottomRight: vector3Finite,
  })
  .strict();

const sceneSkirtSchema = z
  .object({
    instanceId: worldEntityId,
    materialId: z.string().min(1),
    faces: z.array(sceneSkirtFaceSchema).min(4).max(4),
  })
  .strict();
export type SceneSkirt = z.infer<typeof sceneSkirtSchema>;

const sceneTerrainSchema = z
  .object({
    surfaceId: worldEntityId,
    voxelHash: worldHash,
    dimensions: z.tuple([
      z.number().int().positive(),
      z.number().int().positive(),
      z.number().int().positive(),
    ]),
    originMeters: vector3Finite,
    cellSizeMeters: finite.positive(),
    materials: z.array(z.string().min(1)).max(65_535),
  })
  .strict();

const sceneRgbSchema = z
  .object({
    r: finite.min(0).max(1),
    g: finite.min(0).max(1),
    b: finite.min(0).max(1),
  })
  .strict();

const sceneTerrainAppearanceSchema = z
  .object({
    water: z
      .object({
        colorRgb: sceneRgbSchema,
        transparency: finite.min(0).max(1),
        reflectance: finite.min(0).max(1),
        waveSizeMeters: finite.nonnegative(),
        waveSpeedMeters: finite.nonnegative(),
      })
      .strict()
      .optional(),
    grass: z
      // 0.1–1 studs in meters; decimal literals stay float-exact where products would not.
      .object({ enabled: z.boolean(), lengthMeters: finite.min(0.028).max(0.28) })
      .strict()
      .optional(),
    materialTints: z
      .array(z.object({ materialId: z.string().min(1), colorRgb: sceneRgbSchema }).strict())
      .max(256),
  })
  .strict();

const sceneTerrainRepaintSchema = z
  .object({
    surfaceId: worldEntityId,
    sourceMaterialId: z.string().min(1),
    targetMaterialId: z.string().min(1),
  })
  .strict()
  .refine((value) => value.sourceMaterialId !== value.targetMaterialId, {
    message: "Terrain repaint source and target materials must differ",
  });

const sceneRoadVertexSchema = z.object({ position: vector3Finite, normal: vector3Finite }).strict();

const sceneRoadSegmentSchema = z
  .object({
    id: worldEntityId,
    chunkId: worldEntityId,
    materialId: worldEntityId,
    dominantRegionId: worldEntityId,
    startStationMeters: finite.nonnegative(),
    endStationMeters: finite.nonnegative(),
    vertices: z.array(sceneRoadVertexSchema).min(4),
    boundsMeters: z.object({ minimum: vector3Finite, maximum: vector3Finite }).strict(),
  })
  .strict();

const sceneRoadSchema = z
  .object({
    routeId: worldEntityId,
    surfaceId: worldEntityId,
    widthMeters: finite.positive(),
    segments: z.array(sceneRoadSegmentSchema).min(1),
  })
  .strict();

const scenePayloadSchema = z
  .object({
    contentHash: worldHash,
    byteLength: z.number().int().positive(),
    mediaType: z.enum(["model/gltf-binary", "application/x-basalt-voxels"]),
  })
  .strict();

const sceneStairSchema = z
  .object({
    id: worldEntityId,
    chunkId: worldEntityId,
    graphId: worldEntityId,
    materialId: worldEntityId,
    baseMeters: vector3Finite,
    yawStepsY90: z.number().int().min(0).max(3),
    steps: z.number().int().positive(),
    riserMeters: finite.positive(),
    treadMeters: finite.positive(),
    widthMeters: finite.positive(),
  })
  .strict();

const scenePortalSchema = z.discriminatedUnion("kind", [
  z
    .object({
      id: worldEntityId,
      chunkId: worldEntityId,
      graphId: worldEntityId,
      kind: z.literal("interior"),
      roomA: worldEntityId,
      roomB: worldEntityId,
      positionMeters: vector3Finite,
      yawStepsY90: z.number().int().min(0).max(3),
      widthMeters: finite.positive(),
    })
    .strict(),
  z
    .object({
      id: worldEntityId,
      chunkId: worldEntityId,
      graphId: worldEntityId,
      kind: z.literal("entrance"),
      roomA: worldEntityId,
      positionMeters: vector3Finite,
      yawStepsY90: z.number().int().min(0).max(3),
      widthMeters: finite.positive(),
      boundComponentId: worldEntityId.optional(),
    })
    .strict(),
]);

const sceneExportMaterialSchema = z
  .object({
    kind: z.literal("BasaltSceneExport"),
    abi: z.literal(BASALT_SCENE_EXPORT_ABI),
    worldPlanHash: worldHash,
    populationHash: worldHash,
    studMeters: z.literal(STUD_METERS),
    placementConvention: placementConventionSchema,
    instances: z.array(sceneInstanceSchema),
    assets: z.array(sceneAssetSchema),
    parts: z.array(scenePartSchema),
    terrain: z.array(sceneTerrainSchema),
    terrainAppearance: sceneTerrainAppearanceSchema.optional(),
    terrainRepaints: z.array(sceneTerrainRepaintSchema).max(256).optional(),
    roads: z.array(sceneRoadSchema),
    skirts: z.array(sceneSkirtSchema),
    stairs: z.array(sceneStairSchema),
    portals: z.array(scenePortalSchema),
    materialIds: z.array(z.string().min(1)),
    payloads: z.array(scenePayloadSchema),
  })
  .strict();

export const BASALT_SCENE_EXPORT_SCHEMA = sceneExportMaterialSchema
  .extend({ hash: worldHash })
  .strict()
  .refine(
    (value) => value.hash === contentHash(stableJson({ ...value, hash: undefined })),
    "Scene export hash does not match its sealed material",
  );

export type BasaltSceneExport = z.infer<typeof BASALT_SCENE_EXPORT_SCHEMA>;
export type SceneExportPayload = { readonly contentHash: string; readonly bytes: Uint8Array };

export interface EmitSceneExportInput {
  readonly world: Pick<
    BasaltHierarchicalWorld,
    "foundation" | "microPopulation" | "roadAssemblies"
  >;
  readonly revisions: readonly AssetFamilyRevision[];
  readonly assets: readonly CatalogAssetEnvelope[];
  /** Source-manifest meters-per-source-unit by registry-relative path. */
  readonly unitsByPath: Readonly<Record<string, number>>;
  readonly readSourceBytes: (relativePath: string) => Uint8Array;
  /**
   * Material-only repaint directives: live voxels keep their sealed payload
   * while the adapter repaints one material id to another per surface. The
   * builder sorts them into canonical order and fails closed on unknown
   * surfaces.
   */
  readonly terrainRepaints?: ReadonlyArray<{
    readonly surfaceId: string;
    readonly sourceMaterialId: string;
    readonly targetMaterialId: string;
  }>;
  /**
   * Chunked room stairs and portals from chunkRoomGraphContent. The same
   * value feeds emission deltas so transactions and the export agree on
   * chunk ownership.
   */
  readonly rooms?: ChunkedRoomContent;
}

export interface EmittedSceneExport {
  readonly manifest: BasaltSceneExport;
  /** Payload bytes keyed by content hash; the manifest binds hashes, not bytes. */
  readonly payloads: ReadonlyMap<string, Uint8Array>;
}

/** Deepest relief gap that still reads as contact; deeper gaps get a skirt. */
export const SKIRT_MIN_DROP_STUDS = 0.05;
/** Skirt curtain bite below the deepest footprint sample, in studs. */
export const SKIRT_EMBED_STUDS = 0.05;
/** Minimum curtain lip so buried corners never emit degenerate faces. */
export const SKIRT_MIN_LIP_STUDS = 0.02;

export interface SkirtPartBounds {
  readonly assetId: string;
  readonly boundsSourceUnits: { readonly minimum: Vector3Like; readonly maximum: Vector3Like };
}

export interface SkirtAssetEntry {
  readonly assetId: string;
  readonly unitsToMeters: number;
  readonly pivotOffsetMeters: Vector3Like;
}

export interface SkirtEmissionInput {
  readonly resolved: readonly {
    readonly population: WorldPopulationInstance;
    readonly assetId: string;
  }[];
  readonly parts: readonly SkirtPartBounds[];
  readonly assets: ReadonlyMap<string, SkirtAssetEntry>;
  /** First terrain surface material, when terrain exists. */
  readonly terrainMaterialId: string | undefined;
}

interface Vector3Like {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

function applyQuaternionToVector(
  rotation: readonly [number, number, number, number],
  value: Vector3Like,
): Vector3Like {
  const [x, y, z, w] = rotation;
  return {
    x:
      value.x * (1 - 2 * (y * y + z * z)) +
      value.y * 2 * (x * y - z * w) +
      value.z * 2 * (x * z + y * w),
    y:
      value.x * 2 * (x * y + z * w) +
      value.y * (1 - 2 * (x * x + z * z)) +
      value.z * 2 * (y * z - x * w),
    z:
      value.x * 2 * (x * z - y * w) +
      value.y * 2 * (y * z + x * w) +
      value.z * (1 - 2 * (x * x + y * y)),
  };
}

/**
 * Emit blend skirts for flat-kind instances whose footprint relief leaves a
 * visible gap. Each skirt is a four-face vertical curtain in the terrain
 * material hanging from the slab bottom edge past the deepest sample.
 */
export function emitSkirts(input: SkirtEmissionInput): SceneSkirt[] {
  const boundsByAsset = new Map<string, { minimum: Vector3Like; maximum: Vector3Like }>();
  for (const part of input.parts) {
    const union = boundsByAsset.get(part.assetId);
    if (!union) {
      boundsByAsset.set(part.assetId, {
        minimum: { ...part.boundsSourceUnits.minimum },
        maximum: { ...part.boundsSourceUnits.maximum },
      });
    } else {
      union.minimum = {
        x: Math.min(union.minimum.x, part.boundsSourceUnits.minimum.x),
        y: Math.min(union.minimum.y, part.boundsSourceUnits.minimum.y),
        z: Math.min(union.minimum.z, part.boundsSourceUnits.minimum.z),
      };
      union.maximum = {
        x: Math.max(union.maximum.x, part.boundsSourceUnits.maximum.x),
        y: Math.max(union.maximum.y, part.boundsSourceUnits.maximum.y),
        z: Math.max(union.maximum.z, part.boundsSourceUnits.maximum.z),
      };
    }
  }
  const skirts: SceneSkirt[] = [];
  for (const { population, assetId } of input.resolved) {
    const deepest = Math.min(...population.footprint.dropsStuds);
    if (!(deepest < -SKIRT_MIN_DROP_STUDS)) continue;
    const bounds = boundsByAsset.get(assetId);
    const asset = input.assets.get(assetId);
    if (!bounds || !asset) throw new Error(`Skirt references unknown asset: ${assetId}`);
    const spanStuds = {
      x: ((bounds.maximum.x - bounds.minimum.x) * asset.unitsToMeters) / STUD_METERS,
      y: ((bounds.maximum.y - bounds.minimum.y) * asset.unitsToMeters) / STUD_METERS,
      z: ((bounds.maximum.z - bounds.minimum.z) * asset.unitsToMeters) / STUD_METERS,
    };
    if (groundingKindFromSpan(spanStuds) !== "flat") continue;
    if (!input.terrainMaterialId)
      throw new Error(`Skirt for ${population.id} has no terrain material to blend into`);
    const sourceToStuds = asset.unitsToMeters / STUD_METERS;
    const pivotStuds = {
      x: asset.pivotOffsetMeters.x / STUD_METERS,
      y: asset.pivotOffsetMeters.y / STUD_METERS,
      z: asset.pivotOffsetMeters.z / STUD_METERS,
    };
    const corners = [
      { x: bounds.minimum.x, y: bounds.minimum.y, z: bounds.minimum.z },
      { x: bounds.maximum.x, y: bounds.minimum.y, z: bounds.minimum.z },
      { x: bounds.maximum.x, y: bounds.minimum.y, z: bounds.maximum.z },
      { x: bounds.minimum.x, y: bounds.minimum.y, z: bounds.maximum.z },
    ].map((corner) => {
      const scaled = {
        x: (corner.x * sourceToStuds - pivotStuds.x) * population.scale,
        y: (corner.y * sourceToStuds - pivotStuds.y) * population.scale,
        z: (corner.z * sourceToStuds - pivotStuds.z) * population.scale,
      };
      const rotated = applyQuaternionToVector(population.rotation, scaled);
      return {
        x: population.position.x + rotated.x,
        y: population.position.y + rotated.y,
        z: population.position.z + rotated.z,
      };
    });
    const bottomY = population.footprint.restYStuds + deepest - SKIRT_EMBED_STUDS;
    const toMeters = (point: Vector3Like) => ({
      x: point.x * STUD_METERS,
      y: point.y * STUD_METERS,
      z: point.z * STUD_METERS,
    });
    const drop = (top: Vector3Like) => ({
      x: top.x,
      y: Math.min(top.y - SKIRT_MIN_LIP_STUDS, bottomY),
      z: top.z,
    });
    const faces = [0, 1, 2, 3].map((side) => {
      const topLeft = corners[side]!;
      const topRight = corners[(side + 1) % 4]!;
      return {
        topLeft: toMeters(topLeft),
        topRight: toMeters(topRight),
        bottomLeft: toMeters(drop(topLeft)),
        bottomRight: toMeters(drop(topRight)),
      };
    });
    skirts.push({ instanceId: population.id, materialId: input.terrainMaterialId, faces });
  }
  return skirts.sort((left, right) => compareWorldStrings(left.instanceId, right.instanceId));
}

/**
 * Lower a compiled partition world to the engine-neutral scene export.
 * Every instance resolves to content-hashed GLB part bytes; placements are
 * meters/Y-up/right-handed with the composition sealed in the manifest.
 * Carries no engine handles by construction.
 */
export function emitSceneExport(input: EmitSceneExportInput): EmittedSceneExport {
  const population = input.world.microPopulation;
  if (!population) throw new Error("Scene export requires a populated partition world");
  const roads = input.world.roadAssemblies;
  if (!roads) throw new Error("Scene export requires assembled roads");
  const revisionsById = new Map(input.revisions.map((revision) => [revision.familyId, revision]));
  const assetsById = new Map(input.assets.map((asset) => [asset.record.assetId, asset]));
  const payloads = new Map<string, Uint8Array>();
  const parts: Array<z.infer<typeof scenePartSchema>> = [];
  const assetEntries = new Map<string, z.infer<typeof sceneAssetSchema>>();

  const resolved: Array<{ population: WorldPopulationInstance; assetId: string }> = [];
  const instances = population.chunks
    .flatMap((chunk) => chunk.instances)
    .map((instance) => {
      const entry = resolveInstance(
        input,
        instance,
        revisionsById,
        assetsById,
        payloads,
        parts,
        assetEntries,
      );
      resolved.push({ population: instance, assetId: entry.assetId });
      return entry;
    })
    .sort((left, right) => compareWorldStrings(left.id, right.id));

  const plan = input.world.foundation.worldPlan.plan;
  const terrain = input.world.foundation.worldPlan.terrainFields.map((field) => {
    const exported = exportVoxelField(
      field,
      plan.seaLevelStuds === undefined ? {} : { seaLevelStuds: plan.seaLevelStuds },
    );
    payloads.set(exported.contentHash, exported.bytes);
    return {
      surfaceId: field.surfaceId,
      voxelHash: exported.contentHash,
      dimensions: [exported.dimensions[0], exported.dimensions[1], exported.dimensions[2]] as [
        number,
        number,
        number,
      ],
      originMeters: scaleVector(exported.originStuds),
      cellSizeMeters: exported.cellSizeStuds * STUD_METERS,
      materials: [...exported.materials],
    };
  });

  const roadEntries = roads.map((road) => exportRoad(road));
  const skirts = emitSkirts({
    resolved,
    parts,
    assets: assetEntries,
    terrainMaterialId: terrain[0]?.materials[0],
  });
  const stairs = [...(input.rooms?.stairs ?? [])]
    .map((entry) => ({
      id: entry.id,
      chunkId: entry.chunkId,
      graphId: entry.graphId,
      materialId: entry.stair.materialId,
      baseMeters: scaleVector3(entry.stair.basePosition),
      yawStepsY90: entry.stair.yawStepsY90,
      steps: entry.stair.steps,
      riserMeters: entry.stair.riserStuds * STUD_METERS,
      treadMeters: entry.stair.treadStuds * STUD_METERS,
      widthMeters: entry.stair.widthStuds * STUD_METERS,
    }))
    .sort((left, right) => compareWorldStrings(left.id, right.id));
  const portals = [...(input.rooms?.portals ?? [])]
    .map((entry) =>
      entry.portal.kind === "interior"
        ? {
            id: entry.id,
            chunkId: entry.chunkId,
            graphId: entry.graphId,
            kind: "interior" as const,
            roomA: entry.portal.roomA,
            roomB: entry.portal.roomB,
            positionMeters: scaleVector3(entry.portal.position),
            yawStepsY90: entry.portal.yawStepsY90,
            widthMeters: entry.portal.widthStuds * STUD_METERS,
          }
        : {
            id: entry.id,
            chunkId: entry.chunkId,
            graphId: entry.graphId,
            kind: "entrance" as const,
            roomA: entry.portal.roomA,
            positionMeters: scaleVector3(entry.portal.position),
            yawStepsY90: entry.portal.yawStepsY90,
            widthMeters: entry.portal.widthStuds * STUD_METERS,
            ...(entry.portal.boundComponentId
              ? { boundComponentId: entry.portal.boundComponentId }
              : {}),
          },
    )
    .sort((left, right) => compareWorldStrings(left.id, right.id));
  const materialIds = [
    ...new Set([
      ...terrain.flatMap((entry) => entry.materials),
      ...roadEntries.flatMap((road) => road.segments.map((segment) => segment.materialId)),
      ...skirts.map((skirt) => skirt.materialId),
      ...stairs.map((stair) => stair.materialId),
    ]),
  ].sort(compareWorldStrings);

  const surfaceIds = new Set(terrain.map((entry) => entry.surfaceId));
  const repaints = [...(input.terrainRepaints ?? [])]
    .map((repaint) => ({
      surfaceId: repaint.surfaceId,
      sourceMaterialId: repaint.sourceMaterialId,
      targetMaterialId: repaint.targetMaterialId,
    }))
    .sort(
      (left, right) =>
        compareWorldStrings(left.surfaceId, right.surfaceId) ||
        compareWorldStrings(left.sourceMaterialId, right.sourceMaterialId) ||
        compareWorldStrings(left.targetMaterialId, right.targetMaterialId),
    );
  for (const repaint of repaints)
    if (!surfaceIds.has(repaint.surfaceId))
      throw new Error(`Terrain repaint names an unknown surface ${repaint.surfaceId}`);

  const manifest = sealSceneExport({
    kind: "BasaltSceneExport" as const,
    abi: BASALT_SCENE_EXPORT_ABI,
    worldPlanHash: input.world.foundation.worldPlanHash,
    populationHash: population.hash,
    studMeters: STUD_METERS,
    placementConvention: {
      lengthUnit: "meter" as const,
      upAxis: "+Y" as const,
      handedness: "right-handed" as const,
      instanceComposition:
        "T(positionMeters).R(rotationQuaternion).S(uniformScale).T(-pivotOffsetMeters).S(unitsToMeters)" as const,
    },
    instances,
    assets: [...assetEntries.values()].sort((left, right) =>
      left.assetId < right.assetId ? -1 : left.assetId > right.assetId ? 1 : 0,
    ),
    parts: parts.sort((left, right) => compareWorldStrings(left.contentHash, right.contentHash)),
    terrain,
    ...(repaints.length > 0 ? { terrainRepaints: repaints } : {}),
    ...(plan.terrainAppearance
      ? {
          terrainAppearance: {
            ...(plan.terrainAppearance.water
              ? {
                  water: {
                    colorRgb: { ...plan.terrainAppearance.water.colorRgb },
                    transparency: plan.terrainAppearance.water.transparency,
                    reflectance: plan.terrainAppearance.water.reflectance,
                    waveSizeMeters: plan.terrainAppearance.water.waveSizeStuds * STUD_METERS,
                    waveSpeedMeters: plan.terrainAppearance.water.waveSpeedStuds * STUD_METERS,
                  },
                }
              : {}),
            ...(plan.terrainAppearance.grass
              ? {
                  grass: {
                    enabled: plan.terrainAppearance.grass.enabled,
                    lengthMeters: plan.terrainAppearance.grass.lengthStuds * STUD_METERS,
                  },
                }
              : {}),
            materialTints: plan.terrainAppearance.materialTints.map((tint) => ({
              materialId: tint.materialId,
              colorRgb: { ...tint.colorRgb },
            })),
          },
        }
      : {}),
    roads: roadEntries.sort((left, right) => compareWorldStrings(left.routeId, right.routeId)),
    skirts,
    stairs,
    portals,
    materialIds,
    payloads: [...payloads.entries()]
      .map(([contentHashValue, bytes]) => ({
        contentHash: contentHashValue,
        byteLength: bytes.byteLength,
        mediaType: (isVoxelPayload(contentHashValue, terrain)
          ? "application/x-basalt-voxels"
          : "model/gltf-binary") as "model/gltf-binary" | "application/x-basalt-voxels",
      }))
      .sort((left, right) => compareWorldStrings(left.contentHash, right.contentHash)),
  });
  return { manifest, payloads };
}

export function sealSceneExport(
  input: z.input<typeof sceneExportMaterialSchema>,
): BasaltSceneExport {
  const material = sceneExportMaterialSchema.parse(input);
  return BASALT_SCENE_EXPORT_SCHEMA.parse({
    ...material,
    hash: contentHash(stableJson(material)),
  });
}

export function assertSceneExport(value: unknown): asserts value is BasaltSceneExport {
  BASALT_SCENE_EXPORT_SCHEMA.parse(value);
}

/** Inspected Roblox mesh limits gating part uploads. */
export const MAX_UPLOAD_MESH_TRIANGLES = 20_000 as const;
export const MAX_UPLOAD_ASSET_BYTES = 20_971_520 as const;

export interface MeshPartBudgetInput {
  readonly triangleCount: number;
  readonly byteLength: number;
  readonly boundaryEdgeCount: number;
  readonly nonManifoldEdgeCount: number;
}

export type MeshPartBudgetVerdict =
  | { readonly status: "eligible" }
  | { readonly status: "rejected"; readonly reason: string }
  | { readonly status: "incomplete"; readonly reason: string };

/**
 * Judge one mesh part against the inspected upload budgets. Hard API limits
 * reject; open or non-manifold topology marks incomplete for creator review
 * (planes and decals are real geometry that may still import, so they are
 * never silently counted as eligible).
 */
export function assessMeshPartBudget(input: MeshPartBudgetInput): MeshPartBudgetVerdict {
  if (!Number.isInteger(input.triangleCount) || input.triangleCount < 0)
    return { status: "rejected", reason: `unmeasured triangle count: ${input.triangleCount}` };
  if (!Number.isInteger(input.byteLength) || input.byteLength < 0)
    return { status: "rejected", reason: `unmeasured byte length: ${input.byteLength}` };
  if (input.triangleCount === 0) return { status: "rejected", reason: "part carries no triangles" };
  if (input.triangleCount > MAX_UPLOAD_MESH_TRIANGLES)
    return {
      status: "rejected",
      reason: `part exceeds ${MAX_UPLOAD_MESH_TRIANGLES} triangles: ${input.triangleCount}`,
    };
  if (input.byteLength > MAX_UPLOAD_ASSET_BYTES)
    return {
      status: "rejected",
      reason: `part exceeds ${MAX_UPLOAD_ASSET_BYTES} bytes: ${input.byteLength}`,
    };
  if (input.boundaryEdgeCount > 0 || input.nonManifoldEdgeCount > 0)
    return {
      status: "incomplete",
      reason:
        `part is not watertight: ${input.boundaryEdgeCount} boundary edges, ` +
        `${input.nonManifoldEdgeCount} non-manifold edges`,
    };
  return { status: "eligible" };
}

function resolveInstance(
  input: EmitSceneExportInput,
  instance: WorldPopulationInstance,
  revisionsById: ReadonlyMap<string, AssetFamilyRevision>,
  assetsById: ReadonlyMap<string, CatalogAssetEnvelope>,
  payloads: Map<string, Uint8Array>,
  parts: Array<z.infer<typeof scenePartSchema>>,
  assetEntries: Map<string, z.infer<typeof sceneAssetSchema>>,
): z.infer<typeof sceneInstanceSchema> {
  const revision = revisionsById.get(instance.familyId);
  if (!revision) throw new Error(`Scene export references unknown family: ${instance.familyId}`);
  const prefix = `${instance.familyId}_archetype_`;
  if (!instance.archetypeId.startsWith(prefix))
    throw new Error(`Instance ${instance.id} archetype does not belong to ${instance.familyId}`);
  const variantText = instance.archetypeId.slice(prefix.length);
  if (!/^\d+$/.test(variantText))
    throw new Error(`Instance ${instance.id} carries a malformed archetype index`);
  const variant = Number.parseInt(variantText, 10);
  const member = revision.archetypes[variant];
  if (!member)
    throw new Error(
      `Instance ${instance.id} variant ${variant} exceeds family ${instance.familyId}`,
    );
  const envelope = assetsById.get(member.assetId);
  if (!envelope) throw new Error(`Scene export references unknown asset: ${member.assetId}`);
  if (envelope.measurement.status !== "measured")
    throw new Error(`Scene export references unmeasured asset: ${member.assetId}`);
  let entry = assetEntries.get(member.assetId);
  if (!entry) {
    entry = exportAsset(input, envelope, payloads, parts);
    assetEntries.set(member.assetId, entry);
  }
  return {
    id: instance.id,
    chunkId: instance.chunkId,
    familyId: instance.familyId,
    archetypeId: instance.archetypeId,
    assetId: member.assetId,
    positionMeters: scaleVector3(instance.position),
    rotation: [...instance.rotation] as [number, number, number, number],
    scale: instance.scale,
  };
}

function exportAsset(
  input: EmitSceneExportInput,
  envelope: CatalogAssetEnvelope,
  payloads: Map<string, Uint8Array>,
  parts: Array<z.infer<typeof scenePartSchema>>,
): z.infer<typeof sceneAssetSchema> {
  const relativePath = envelope.source.relativePath;
  const unitsRaw = input.unitsByPath[relativePath];
  if (typeof unitsRaw !== "number" || !Number.isFinite(unitsRaw) || unitsRaw <= 0)
    throw new Error(`Scene export lacks registered source units: ${relativePath}`);
  const unitsToMeters = unitsRaw;
  const bytes = input.readSourceBytes(relativePath);
  if (sha256Bytes(bytes) !== envelope.source.contentHash)
    throw new Error(`Source bytes disagree with sealed content hash: ${relativePath}`);
  const split = splitGlbMeshParts(bytes);
  if (split.length === 0) throw new Error(`Scene export found no mesh parts: ${relativePath}`);
  const partHashes: string[] = [];
  for (const part of split) {
    if (determinant3x3(part.node.worldMatrix) <= 1e-12)
      throw new Error(
        `Scene export refuses mirrored node transform in ${relativePath}/${part.node.name}`,
      );
    const contentHashValue = sha256Bytes(part.bytes);
    partHashes.push(contentHashValue);
    if (!payloads.has(contentHashValue)) {
      payloads.set(contentHashValue, new Uint8Array(part.bytes));
      const bounds = part.node.bounds;
      if (!bounds)
        throw new Error(
          `Scene export found unbounded geometry in ${relativePath}/${part.node.name}`,
        );
      parts.push({
        contentHash: contentHashValue,
        byteLength: part.bytes.byteLength,
        mediaType: "model/gltf-binary",
        assetId: envelope.record.assetId,
        nodeName: part.node.name,
        triangleCount: part.node.triangleCount,
        boundsSourceUnits: {
          minimum: { x: bounds.minimum[0], y: bounds.minimum[1], z: bounds.minimum[2] },
          maximum: { x: bounds.maximum[0], y: bounds.maximum[1], z: bounds.maximum[2] },
        },
        pivotSourceUnits: {
          x: part.node.worldMatrix[12],
          y: part.node.worldMatrix[13],
          z: part.node.worldMatrix[14],
        },
      });
    }
  }
  const pivot = envelope.record.pivotOffsetFromBottomCenter;
  return {
    assetId: envelope.record.assetId,
    unitsToMeters,
    pivotOffsetMeters: {
      x: dequantizeQ32_32(pivot.x) * STUD_METERS,
      y: dequantizeQ32_32(pivot.y) * STUD_METERS,
      z: dequantizeQ32_32(pivot.z) * STUD_METERS,
    },
    partHashes,
  };
}

function exportRoad(road: RoadAssembly): z.infer<typeof sceneRoadSchema> {
  return {
    routeId: road.routeId,
    surfaceId: road.surfaceId,
    widthMeters: road.widthStuds * STUD_METERS,
    segments: road.segments.map((segment) => ({
      id: segment.id,
      chunkId: segment.chunkId,
      materialId: segment.materialId,
      dominantRegionId: segment.dominantRegionId,
      startStationMeters: segment.startStationStuds * STUD_METERS,
      endStationMeters: segment.endStationStuds * STUD_METERS,
      vertices: segment.vertices.map((vertex) => ({
        position: scaleVector3(vertex.position),
        normal: { ...vertex.normal },
      })),
      boundsMeters: {
        minimum: scaleVector3(segment.bounds.minimum),
        maximum: scaleVector3(segment.bounds.maximum),
      },
    })),
  };
}

function isVoxelPayload(
  contentHashValue: string,
  terrain: ReadonlyArray<{ readonly voxelHash: string }>,
): boolean {
  return terrain.some((entry) => entry.voxelHash === contentHashValue);
}

function scaleVector3(value: { readonly x: number; readonly y: number; readonly z: number }): {
  x: number;
  y: number;
  z: number;
} {
  return { x: value.x * STUD_METERS, y: value.y * STUD_METERS, z: value.z * STUD_METERS };
}

function scaleVector(value: readonly [number, number, number]): {
  x: number;
  y: number;
  z: number;
} {
  return { x: value[0] * STUD_METERS, y: value[1] * STUD_METERS, z: value[2] * STUD_METERS };
}

function determinant3x3(matrix: readonly number[]): number {
  const [a, b, c, d, e, f, g, h, i] = [
    matrix[0]!,
    matrix[4]!,
    matrix[8]!,
    matrix[1]!,
    matrix[5]!,
    matrix[9]!,
    matrix[2]!,
    matrix[6]!,
    matrix[10]!,
  ];
  return a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
}
