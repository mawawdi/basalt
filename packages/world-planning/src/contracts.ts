import { z } from "zod";
import { contentHash, stableJson } from "../../contracts/src/index.js";
import { worldEntityId as entityId, worldHash as hashSchema } from "./primitives.js";
import { COMPILER_RENDER_READABILITY_INTENT_SCHEMA } from "../../spatial-core/src/readability.js";

export const WORLD_PLAN_ABI = "basalt-world-plan@1" as const;
export const TERRAIN_PLAN_ABI = "basalt-terrain-plan@1" as const;
export const TERRAIN_FIELD_ABI = "basalt-terrain-field@1" as const;
export const TERRAIN_MATERIAL_BLEND_ABI = "basalt-terrain-material-blend@1" as const;
export const TERRAIN_STYLE_OVERLAY_BINDING_ABI = "basalt-terrain-style-overlay-binding@1" as const;
export const TERRAIN_FIELD_MAX_AXIS_SAMPLES = 256 as const;
export const TERRAIN_FIELD_MAX_SAMPLES =
  TERRAIN_FIELD_MAX_AXIS_SAMPLES * TERRAIN_FIELD_MAX_AXIS_SAMPLES;

/**
 * One domain-neutral vocabulary describes every surface that the shared
 * placement index can return. Asset compatibility must use this authority;
 * source routes may not invent parallel surface categories.
 */
export const PLACEMENT_SURFACE_KINDS = [
  "ceiling",
  "floor",
  "platform",
  "ramp",
  "roof",
  "terrain",
  "wall",
] as const;
export const PLACEMENT_SURFACE_KIND_SCHEMA = z.enum(PLACEMENT_SURFACE_KINDS);
export type PlacementSurfaceKind = (typeof PLACEMENT_SURFACE_KINDS)[number];
export const CONSTRUCTED_PLACEMENT_SURFACE_KINDS = PLACEMENT_SURFACE_KINDS.filter(
  (kind): kind is Exclude<PlacementSurfaceKind, "terrain"> => kind !== "terrain",
) as ["ceiling", "floor", "platform", "ramp", "roof", "wall"];

const finite = z.number().finite();
const coordinate = finite.min(-1_000_000).max(1_000_000);
const positive = finite.positive();
const nonnegative = finite.nonnegative();
const string160 = z.string().trim().min(1).max(160);
const string1024 = z.string().trim().min(1).max(1024);

export const WORLD_VECTOR3_SCHEMA = z
  .object({ x: coordinate, y: coordinate, z: coordinate })
  .strict();
export const WORLD_POINT2_SCHEMA = z.object({ x: coordinate, z: coordinate }).strict();
export const WORLD_POLYGON_SCHEMA = z
  .array(WORLD_POINT2_SCHEMA)
  .min(3)
  .max(256)
  .superRefine((value, context) => {
    const problem = polygonProblem(value);
    if (problem) context.addIssue({ code: "custom", message: problem });
  });

const triangleIndices = z.tuple([
  z.number().int().nonnegative(),
  z.number().int().nonnegative(),
  z.number().int().nonnegative(),
]);

const orientedAxes = z
  .object({
    x: WORLD_VECTOR3_SCHEMA,
    y: WORLD_VECTOR3_SCHEMA,
    z: WORLD_VECTOR3_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    const axes = [value.x, value.y, value.z];
    if (axes.some((axis) => Math.abs(vectorLength(axis) - 1) > 1e-5))
      context.addIssue({ code: "custom", message: "Volume axes must be unit vectors" });
    if (
      Math.abs(dot(value.x, value.y)) > 1e-5 ||
      Math.abs(dot(value.x, value.z)) > 1e-5 ||
      Math.abs(dot(value.y, value.z)) > 1e-5
    )
      context.addIssue({ code: "custom", message: "Volume axes must be orthogonal" });
    if (dot(cross(value.x, value.y), value.z) < 1 - 1e-5)
      context.addIssue({ code: "custom", message: "Volume axes must be right-handed" });
  });

const convexPolyhedronVolume = z
  .object({
    kind: z.literal("convex_polyhedron"),
    vertices: z.array(WORLD_VECTOR3_SCHEMA).min(4).max(4096),
    faces: z.array(triangleIndices).min(4).max(8192),
  })
  .strict()
  .superRefine((value, context) => {
    const problem = convexPolyhedronProblem(value.vertices, value.faces);
    if (problem) context.addIssue({ code: "custom", message: problem });
  });

/** Bounded region geometry. Variants describe shape rather than content domain. */
export const WORLD_REGION_VOLUME_SCHEMA = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("extruded_polygon"),
      footprint: WORLD_POLYGON_SCHEMA,
      verticalRange: z
        .object({ minimum: coordinate, maximum: coordinate })
        .strict()
        .refine((value) => value.minimum < value.maximum, "Interval must have positive extent"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("oriented_box"),
      center: WORLD_VECTOR3_SCHEMA,
      axes: orientedAxes,
      halfSize: z
        .object({
          x: positive.max(1_000_000),
          y: positive.max(1_000_000),
          z: positive.max(1_000_000),
        })
        .strict(),
    })
    .strict(),
  convexPolyhedronVolume,
]);

const interval = z
  .object({ minimum: coordinate, maximum: coordinate })
  .strict()
  .refine((value) => value.minimum < value.maximum, "Interval must have positive extent");
const weight = finite.min(0).max(1);

export const WORLD_COMPOSITION_POINT_SCHEMA = z.object({ u: coordinate, v: coordinate }).strict();

/**
 * An explicitly requested planar composition measurement. The frame is fully
 * three-dimensional so plans can measure a facade, ceiling, slope, section,
 * or any other authored plane without granting special authority to world XZ.
 */
export const WORLD_COMPOSITION_MEASURE_SCHEMA = z
  .object({
    id: entityId,
    purpose: string1024,
    origin: WORLD_VECTOR3_SCHEMA,
    uAxis: WORLD_VECTOR3_SCHEMA,
    vAxis: WORLD_VECTOR3_SCHEMA,
    boundary: z.array(WORLD_COMPOSITION_POINT_SCHEMA).min(3).max(256),
    densityTarget: weight,
    minimumNegativeSpace: weight,
    surfaceId: entityId.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      Math.abs(vectorLength(value.uAxis) - 1) > 1e-5 ||
      Math.abs(vectorLength(value.vAxis) - 1) > 1e-5
    )
      context.addIssue({ code: "custom", message: "Composition axes must be unit vectors" });
    if (Math.abs(dot(value.uAxis, value.vAxis)) > 1e-5)
      context.addIssue({ code: "custom", message: "Composition axes must be orthogonal" });
    const problem = polygonProblem(value.boundary.map((point) => ({ x: point.u, z: point.v })));
    if (problem) context.addIssue({ code: "custom", path: ["boundary"], message: problem });
    if (value.densityTarget + value.minimumNegativeSpace > 1 + 1e-9)
      context.addIssue({
        code: "custom",
        message: "Composition density and negative-space requirements are infeasible",
      });
  });

const terrainMaterialWeight = z
  .object({ materialId: entityId, weight: positive.max(1_000_000) })
  .strict();

const terrainNoiseLayer = z
  .object({
    id: entityId,
    kind: z.enum(["value", "ridged", "billow"]),
    frequency: positive.min(0.000001).max(10_000),
    amplitude: finite.min(-100_000).max(100_000),
    octaves: z.number().int().min(1).max(8),
    lacunarity: positive.min(1).max(8),
    gain: weight,
    seedOffset: z.number().int().min(-0x7fff_ffff).max(0x7fff_ffff),
  })
  .strict();

const terrainRegion = z
  .object({
    regionId: entityId,
    footprint: WORLD_POLYGON_SCHEMA,
    blendWidth: positive.max(100_000),
    baseElevation: coordinate,
    noiseLayers: z.array(terrainNoiseLayer).max(16),
    materialWeights: z.array(terrainMaterialWeight).min(1).max(32),
  })
  .strict()
  .superRefine((value, context) => {
    unique(
      value.noiseLayers.map((layer) => layer.id),
      "Terrain noise layer IDs",
      context,
    );
    unique(
      value.materialWeights.map((material) => material.materialId),
      "Terrain material weights",
      context,
    );
  });

const regionOperation = { regionId: entityId.optional() } as const;
export const LOCAL_TERRAIN_PATCH_OPERATION_SCHEMA = z
  .object({
    id: entityId,
    kind: z.literal("local_patch"),
    regionId: entityId,
    center: WORLD_POINT2_SCHEMA,
    radius: positive.max(100_000),
    falloff: positive.min(0.1).max(16),
    edit: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("raise"), amount: positive.max(10_000) }).strict(),
      z.object({ kind: z.literal("lower"), amount: positive.max(10_000) }).strict(),
      z
        .object({
          kind: z.literal("flatten"),
          elevation: coordinate,
          strength: positive.max(1),
        })
        .strict(),
      z
        .object({
          kind: z.literal("smooth"),
          iterations: z.number().int().min(1).max(8),
          strength: positive.max(1),
        })
        .strict(),
    ]),
  })
  .strict();

const terrainOperation = z.discriminatedUnion("kind", [
  z
    .object({
      id: entityId,
      kind: z.literal("ridge"),
      ...regionOperation,
      points: z.array(WORLD_POINT2_SCHEMA).min(2).max(128),
      width: positive.max(100_000),
      height: finite.min(-100_000).max(100_000),
    })
    .strict(),
  z
    .object({
      id: entityId,
      kind: z.literal("peak"),
      ...regionOperation,
      center: WORLD_POINT2_SCHEMA,
      radius: positive.max(100_000),
      height: positive.max(100_000),
      falloff: positive.min(0.1).max(16),
    })
    .strict(),
  z
    .object({
      id: entityId,
      kind: z.literal("basin"),
      ...regionOperation,
      center: WORLD_POINT2_SCHEMA,
      radius: positive.max(100_000),
      depth: positive.max(100_000),
      falloff: positive.min(0.1).max(16),
    })
    .strict(),
  z
    .object({
      id: entityId,
      kind: z.literal("terrace"),
      ...regionOperation,
      stepHeight: positive.max(10_000),
      strength: weight,
    })
    .strict(),
  z
    .object({
      id: entityId,
      kind: z.literal("dune"),
      ...regionOperation,
      directionDegrees: finite,
      wavelength: positive.max(100_000),
      height: finite.min(-100_000).max(100_000),
    })
    .strict(),
  z
    .object({
      id: entityId,
      kind: z.literal("channel"),
      ...regionOperation,
      points: z.array(WORLD_POINT2_SCHEMA).min(2).max(128),
      width: positive.max(100_000),
      depth: positive.max(100_000),
    })
    .strict(),
  z
    .object({
      id: entityId,
      kind: z.literal("slope"),
      ...regionOperation,
      directionDegrees: finite,
      risePerUnit: finite.min(-1000).max(1000),
      origin: WORLD_POINT2_SCHEMA,
    })
    .strict(),
  z
    .object({
      id: entityId,
      kind: z.literal("erosion"),
      ...regionOperation,
      iterations: z.number().int().min(1).max(16),
      talus: nonnegative.max(1000),
      strength: weight,
    })
    .strict(),
  LOCAL_TERRAIN_PATCH_OPERATION_SCHEMA,
]);

export const TERRAIN_PLAN_SCHEMA = z
  .object({
    kind: z.literal("TerrainPlan"),
    abi: z.literal(TERRAIN_PLAN_ABI),
    id: entityId,
    surfaceId: entityId,
    seed: z.number().int().min(0).max(0xffff_ffff),
    bounds: z.object({ x: interval, z: interval }).strict(),
    resolution: z
      .object({
        columns: z.number().int().min(2).max(TERRAIN_FIELD_MAX_AXIS_SAMPLES),
        rows: z.number().int().min(2).max(TERRAIN_FIELD_MAX_AXIS_SAMPLES),
      })
      .strict(),
    regions: z.array(terrainRegion).min(1).max(64),
    operations: z.array(terrainOperation).max(128),
    navigation: z.object({ maximumSlopeDegrees: finite.min(0).max(89) }).strict(),
  })
  .strict()
  .superRefine((value, context) => {
    unique(
      value.regions.map((region) => region.regionId),
      "Terrain region IDs",
      context,
    );
    unique(
      value.operations.map((operation) => operation.id),
      "Terrain operation IDs",
      context,
    );
    const regions = new Set(value.regions.map((region) => region.regionId));
    for (const [index, operation] of value.operations.entries())
      if (operation.regionId && !regions.has(operation.regionId))
        context.addIssue({
          code: "custom",
          path: ["operations", index, "regionId"],
          message: "Terrain operation references an unknown terrain region",
        });
  });

const constructedSurfaceGeometry = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("planar_patch"),
      origin: WORLD_VECTOR3_SCHEMA,
      uAxis: WORLD_VECTOR3_SCHEMA,
      vAxis: WORLD_VECTOR3_SCHEMA,
      uRange: interval,
      vRange: interval,
    })
    .strict()
    .superRefine((value, context) => {
      const uLength = vectorLength(value.uAxis);
      const vLength = vectorLength(value.vAxis);
      if (Math.abs(uLength - 1) > 1e-5 || Math.abs(vLength - 1) > 1e-5)
        context.addIssue({ code: "custom", message: "Planar patch axes must be unit vectors" });
      if (Math.abs(dot(value.uAxis, value.vAxis)) > 1e-5)
        context.addIssue({ code: "custom", message: "Planar patch axes must be orthogonal" });
    }),
  z
    .object({
      kind: z.literal("triangle_patch"),
      vertices: z
        .array(
          z
            .object({
              position: WORLD_VECTOR3_SCHEMA,
              normal: WORLD_VECTOR3_SCHEMA.refine(
                (value) => Math.abs(vectorLength(value) - 1) <= 1e-5,
                "Triangle-patch vertex normals must be normalized",
              ),
              coordinate: z.object({ u: coordinate, v: coordinate }).strict(),
            })
            .strict(),
        )
        .min(3)
        .max(4096),
      triangles: z.array(triangleIndices).min(1).max(8192),
    })
    .strict()
    .superRefine((value, context) => {
      const problem = trianglePatchProblem(value.vertices, value.triangles);
      if (problem) context.addIssue({ code: "custom", message: problem });
    }),
]);

export const CONSTRUCTED_SURFACE_SCHEMA = z
  .object({
    id: entityId,
    regionId: entityId,
    kind: z.enum(CONSTRUCTED_PLACEMENT_SURFACE_KINDS),
    geometry: constructedSurfaceGeometry,
    materialId: entityId,
    navigable: z.boolean(),
  })
  .strict();

const worldRegion = z
  .object({
    id: entityId,
    name: string160,
    purpose: string1024,
    parentId: entityId.optional(),
    volume: WORLD_REGION_VOLUME_SCHEMA,
    compositionMeasures: z.array(WORLD_COMPOSITION_MEASURE_SCHEMA).max(16),
    refinementPriority: z.number().int().min(0).max(100),
  })
  .strict();

const regionRelation = z.discriminatedUnion("kind", [
  z
    .object({
      id: entityId,
      kind: z.literal("adjacent"),
      firstRegionId: entityId,
      secondRegionId: entityId,
    })
    .strict(),
  z
    .object({
      id: entityId,
      kind: z.literal("relative_position"),
      subjectRegionId: entityId,
      referenceRegionId: entityId,
      direction: WORLD_VECTOR3_SCHEMA.refine(
        (value) => Math.abs(vectorLength(value) - 1) <= 1e-5,
        "Relative-position direction must be normalized",
      ),
      offset: coordinate,
      tolerance: nonnegative.max(1_000_000),
    })
    .strict(),
  z
    .object({
      id: entityId,
      kind: z.literal("overlap"),
      firstRegionId: entityId,
      secondRegionId: entityId,
    })
    .strict(),
  z
    .object({
      id: entityId,
      kind: z.literal("coverage"),
      regionId: entityId,
      minimum: weight,
      maximum: weight,
    })
    .strict()
    .refine((value) => value.minimum <= value.maximum, "Coverage range must be ordered"),
]);

const worldRoute = z
  .object({
    id: entityId,
    name: string160,
    surfaceId: entityId,
    regionIds: z.array(entityId).min(1).max(64),
    points: z.array(WORLD_VECTOR3_SCHEMA).min(2).max(512),
    width: positive.max(128),
    heightClearance: positive.max(256),
    agentRadius: positive.max(128),
    agentHeight: positive.max(256),
    maximumStepHeight: nonnegative.max(64),
    maximumSlopeDegrees: finite.min(0).max(89),
    closed: z.boolean(),
    reachableAnchorIds: z.array(entityId).max(256),
  })
  .strict()
  .refine(
    (value) => value.width >= value.agentRadius * 2 && value.heightClearance >= value.agentHeight,
    "Route dimensions must admit its traversal capability",
  );

const worldAnchor = z
  .object({
    id: entityId,
    regionId: entityId,
    // `socket` has one operational meaning during placement. Every other label
    // is an open gameplay interface authored by the creator/game build.
    type: string160,
    position: WORLD_VECTOR3_SCHEMA,
    extent: WORLD_VECTOR3_SCHEMA.optional(),
    bindingName: string160,
  })
  .strict();

const worldCollision = z
  .object({
    id: entityId,
    regionId: entityId,
    placementAuthority: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("blocker") }).strict(),
      z
        .object({
          kind: z.literal("surface_substrate"),
          surfaceId: entityId,
        })
        .strict(),
    ]),
    shape: z.enum(["box", "sphere", "cylinder", "wedge"]),
    position: WORLD_VECTOR3_SCHEMA,
    rotationDegrees: WORLD_VECTOR3_SCHEMA,
    size: WORLD_VECTOR3_SCHEMA.refine(
      (value) => value.x > 0 && value.y > 0 && value.z > 0,
      "Collision size must be positive",
    ),
    canCollide: z.boolean(),
  })
  .strict();

const worldCamera = z
  .object({
    id: entityId,
    name: string160,
    purpose: string1024,
    evidenceRole: z.enum(["global_overview", "region_detail"]),
    position: WORLD_VECTOR3_SCHEMA,
    lookAt: WORLD_VECTOR3_SCHEMA,
    up: WORLD_VECTOR3_SCHEMA,
    fieldOfViewDegrees: finite.min(1).max(120),
    nearClip: positive.max(100),
    farClip: positive.max(1_000_000),
    width: z.number().int().min(64).max(8192),
    height: z.number().int().min(64).max(8192),
    regionIds: z.array(entityId).min(1).max(256),
    framingAssetIds: z.array(entityId).max(64),
    readabilityIntent: COMPILER_RENDER_READABILITY_INTENT_SCHEMA,
    declaredState: string160,
  })
  .strict()
  .refine((value) => value.nearClip < value.farClip, "Camera clipping range must be ordered");

const worldAssetRequirement = z
  .object({
    id: entityId,
    declarationId: entityId,
    regionIds: z.array(entityId).min(1).max(64),
    semanticRole: string160,
    requirementHash: hashSchema,
    required: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    unique(value.regionIds, "World asset requirement region IDs", context);
  });

export const WORLD_REFERENCE_SCHEMA = z
  .object({
    id: entityId,
    artifactHash: hashSchema,
    mediaType: z.enum([
      "text/plain",
      "image/png",
      "image/jpeg",
      "application/pdf",
      "model/gltf-binary",
      "application/octet-stream",
    ]),
    origin: z.enum(["creator_supplied", "qualified_generated", "research_source"]),
    roles: z
      .array(
        z.enum([
          "creator_brief",
          "composition",
          "spatial_layout",
          "shape_language",
          "material_language",
          "lighting",
          "asset_form",
          "research_context",
        ]),
      )
      .min(1)
      .max(8),
    rightsEvidenceHashes: z.array(hashSchema).max(32),
    producerQualificationHashes: z.array(hashSchema).max(32),
  })
  .strict()
  .superRefine((value, context) => {
    for (const [field, hashes] of [
      ["rightsEvidenceHashes", value.rightsEvidenceHashes],
      ["producerQualificationHashes", value.producerQualificationHashes],
    ] as const)
      if (
        stableJson([...hashes].sort()) !== stableJson(hashes) ||
        new Set(hashes).size !== hashes.length
      )
        context.addIssue({
          code: "custom",
          path: [field],
          message: `${field} must be canonical and unique`,
        });
    if (
      stableJson([...value.roles].sort()) !== stableJson(value.roles) ||
      new Set(value.roles).size !== value.roles.length
    )
      context.addIssue({
        code: "custom",
        path: ["roles"],
        message: "Reference roles must be canonical and unique",
      });
    if (
      value.origin === "qualified_generated" &&
      (value.rightsEvidenceHashes.length === 0 || value.producerQualificationHashes.length === 0)
    )
      context.addIssue({
        code: "custom",
        message: "Generated references require rights evidence and producer qualifications",
      });
    if (
      (value.mediaType === "image/png" || value.mediaType === "image/jpeg") &&
      value.rightsEvidenceHashes.length === 0
    )
      context.addIssue({
        code: "custom",
        path: ["rightsEvidenceHashes"],
        message: "Image references require exact rights evidence",
      });
    if (value.origin !== "qualified_generated" && value.producerQualificationHashes.length !== 0)
      context.addIssue({
        code: "custom",
        path: ["producerQualificationHashes"],
        message: "Only generated references can claim producer qualifications",
      });
  });
export type WorldReference = z.infer<typeof WORLD_REFERENCE_SCHEMA>;

/**
 * A style overlay changes material, foliage, lighting, and atmosphere while
 * retaining the exact compiled terrain field. Seasonal labels are open text;
 * the field hash is the immutable join key.
 */
const WORLD_STYLE_OVERLAY_MATERIAL_SCHEMA = z
  .object({ materialId: entityId, paletteEntryId: entityId, weight })
  .strict();
export const WORLD_STYLE_OVERLAY_SCHEMA = z
  .object({
    kind: z.literal("WorldStyleOverlay"),
    id: entityId,
    terrainFieldHash: hashSchema,
    season: string160,
    materialPalette: z.array(WORLD_STYLE_OVERLAY_MATERIAL_SCHEMA).min(1).max(128),
    foliageFamilyIds: z.array(entityId).max(256),
    atmosphericLighting: z
      .object({
        lightingIntent: string1024,
        atmosphereIntent: string1024,
        exposure: finite.min(-16).max(16),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      new Set(value.materialPalette.map((entry) => entry.materialId)).size !==
      value.materialPalette.length
    )
      context.addIssue({
        code: "custom",
        path: ["materialPalette"],
        message: "Style overlay material IDs must be unique",
      });
    if (
      stableJson([...value.foliageFamilyIds].sort()) !== stableJson(value.foliageFamilyIds) ||
      new Set(value.foliageFamilyIds).size !== value.foliageFamilyIds.length
    )
      context.addIssue({
        code: "custom",
        path: ["foliageFamilyIds"],
        message: "Style overlay foliage family IDs must be canonical",
      });
  });
export type WorldStyleOverlay = z.infer<typeof WORLD_STYLE_OVERLAY_SCHEMA>;

const semanticClaim = z
  .object({
    id: entityId,
    statement: z.string().trim().min(1).max(2048),
    referenceIds: z.array(entityId).max(64),
  })
  .strict();

export const WORLD_PLAN_SCHEMA = z
  .object({
    kind: z.literal("SpatialWorldPlan"),
    abi: z.literal(WORLD_PLAN_ABI),
    id: entityId,
    seed: z.number().int().min(0).max(0xffff_ffff),
    styleContractHash: hashSchema,
    bounds: z
      .object({ center: WORLD_VECTOR3_SCHEMA, size: WORLD_VECTOR3_SCHEMA })
      .strict()
      .refine(
        (value) => value.size.x > 0 && value.size.y > 0 && value.size.z > 0,
        "World bounds must have positive size",
      ),
    references: z.array(WORLD_REFERENCE_SCHEMA).max(512),
    creatorClaims: z.array(semanticClaim).max(512),
    agentHypotheses: z.array(semanticClaim).max(512),
    regions: z.array(worldRegion).min(1).max(256),
    regionRelations: z.array(regionRelation).max(1024),
    terrainPlans: z.array(TERRAIN_PLAN_SCHEMA).max(32),
    styleOverlays: z.array(WORLD_STYLE_OVERLAY_SCHEMA).max(64).default([]),
    constructedSurfaces: z.array(CONSTRUCTED_SURFACE_SCHEMA).max(1024),
    routes: z.array(worldRoute).max(256),
    anchors: z.array(worldAnchor).max(8192),
    collisionProxies: z.array(worldCollision).max(8192),
    cameras: z.array(worldCamera).min(1).max(256),
    assetRequirements: z.array(worldAssetRequirement).max(8192),
    tolerances: z
      .object({
        support: nonnegative.max(16),
        penetration: nonnegative.max(16),
        clearance: nonnegative.max(1024),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => validateWorldPlan(value, context));

const terrainSample = z
  .object({
    position: WORLD_VECTOR3_SCHEMA,
    normal: WORLD_VECTOR3_SCHEMA,
    slopeDegrees: finite.min(0).max(180),
    regionWeights: z.record(entityId, weight),
    materialWeights: z.record(entityId, weight),
    navigable: z.boolean(),
  })
  .strict();

export const TERRAIN_FIELD_ARTIFACT_SCHEMA = z
  .object({
    kind: z.literal("TerrainFieldArtifact"),
    abi: z.literal(TERRAIN_FIELD_ABI),
    id: entityId,
    planHash: hashSchema,
    surfaceId: entityId,
    bounds: z.object({ x: interval, z: interval }).strict(),
    resolution: z
      .object({
        columns: z.number().int().min(2).max(TERRAIN_FIELD_MAX_AXIS_SAMPLES),
        rows: z.number().int().min(2).max(TERRAIN_FIELD_MAX_AXIS_SAMPLES),
      })
      .strict(),
    samples: z.array(terrainSample).min(4).max(TERRAIN_FIELD_MAX_SAMPLES),
    hash: hashSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.samples.length !== value.resolution.columns * value.resolution.rows)
      context.addIssue({ code: "custom", message: "Terrain sample count must match its grid" });
    for (const [index, sample] of value.samples.entries()) {
      if (!approximatelyOne(Object.values(sample.regionWeights)))
        context.addIssue({
          code: "custom",
          path: ["samples", index, "regionWeights"],
          message: "Region weights must sum to one",
        });
      if (!approximatelyOne(Object.values(sample.materialWeights)))
        context.addIssue({
          code: "custom",
          path: ["samples", index, "materialWeights"],
          message: "Material weights must sum to one",
        });
      if (Math.abs(vectorLength(sample.normal) - 1) > 1e-4)
        context.addIssue({
          code: "custom",
          path: ["samples", index, "normal"],
          message: "Terrain normals must be unit length",
        });
    }
    const { hash: _hash, ...material } = value;
    if (contentHash(stableJson(material)) !== value.hash)
      context.addIssue({
        code: "custom",
        path: ["hash"],
        message: "Terrain artifact hash does not match its content",
      });
  });

const terrainGridRange = z
  .tuple([z.number().int().nonnegative(), z.number().int().nonnegative()])
  .refine(([minimum, maximum]) => minimum <= maximum, "Terrain grid range must be ordered");

/**
 * Exact normalized material weights retained for one texture-bake window.
 *
 * The sample window includes a one-cell halo around the exported partition whenever
 * the source field has one. That lets every partition evaluate the same bilinear
 * field and the same finite-difference normal at a shared boundary.
 */
export const TERRAIN_MATERIAL_BLEND_ARTIFACT_SCHEMA = z
  .object({
    kind: z.literal("TerrainMaterialBlendArtifact"),
    abi: z.literal(TERRAIN_MATERIAL_BLEND_ABI),
    surfaceId: entityId,
    fieldHash: hashSchema,
    partitionHash: hashSchema,
    fieldBounds: z.object({ x: interval, z: interval }).strict(),
    fieldResolution: z
      .object({
        columns: z.number().int().min(2).max(TERRAIN_FIELD_MAX_AXIS_SAMPLES),
        rows: z.number().int().min(2).max(TERRAIN_FIELD_MAX_AXIS_SAMPLES),
      })
      .strict(),
    partitionColumnRange: terrainGridRange,
    partitionRowRange: terrainGridRange,
    sampleColumnRange: terrainGridRange,
    sampleRowRange: terrainGridRange,
    materialIds: z.array(entityId).min(1).max(32),
    weightEncoding: z.literal("float32_le_base64"),
    weightCount: z
      .number()
      .int()
      .min(4)
      .max(TERRAIN_FIELD_MAX_SAMPLES * 32),
    weightsF32Base64: z
      .string()
      .min(24)
      .max(16 * 1024 * 1024),
    weightGridHash: hashSchema,
    hash: hashSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const [firstColumn, lastColumn] = value.sampleColumnRange;
    const [firstRow, lastRow] = value.sampleRowRange;
    const expectedSamples = (lastColumn - firstColumn + 1) * (lastRow - firstRow + 1);
    if (value.weightCount !== expectedSamples * value.materialIds.length)
      context.addIssue({
        code: "custom",
        path: ["weightCount"],
        message: "Terrain material blend weight count must match its retained grid window",
      });
    if (
      value.partitionColumnRange[0] < firstColumn ||
      value.partitionColumnRange[1] > lastColumn ||
      value.partitionRowRange[0] < firstRow ||
      value.partitionRowRange[1] > lastRow
    )
      context.addIssue({
        code: "custom",
        message: "Terrain material blend sample window must contain its exported partition",
      });
    if (
      lastColumn >= value.fieldResolution.columns ||
      lastRow >= value.fieldResolution.rows ||
      value.partitionColumnRange[1] >= value.fieldResolution.columns ||
      value.partitionRowRange[1] >= value.fieldResolution.rows
    )
      context.addIssue({
        code: "custom",
        message: "Terrain material blend ranges must remain inside the source field",
      });
    if (
      new Set(value.materialIds).size !== value.materialIds.length ||
      stableJson([...value.materialIds].sort()) !== stableJson(value.materialIds)
    )
      context.addIssue({
        code: "custom",
        path: ["materialIds"],
        message: "Terrain material blend IDs must be unique and canonical",
      });
    const decoded = decodeFloat32Weights(value.weightsF32Base64, value.weightCount);
    if (!decoded)
      context.addIssue({
        code: "custom",
        path: ["weightsF32Base64"],
        message: "Terrain material blend weights must be canonical little-endian float32 data",
      });
    else
      for (let index = 0; index < expectedSamples; index += 1) {
        const sample = decoded.slice(
          index * value.materialIds.length,
          (index + 1) * value.materialIds.length,
        );
        if (
          sample.some((entry) => !Number.isFinite(entry) || entry < 0 || entry > 1) ||
          !approximatelyOne(sample)
        )
          context.addIssue({
            code: "custom",
            path: ["weightsF32Base64"],
            message: `Terrain material blend vector ${index} is not normalized`,
          });
      }
    const weightMaterial = {
      materialIds: value.materialIds,
      sampleColumnRange: value.sampleColumnRange,
      sampleRowRange: value.sampleRowRange,
      weightEncoding: value.weightEncoding,
      weightCount: value.weightCount,
      weightsF32Base64: value.weightsF32Base64,
    };
    if (contentHash(stableJson(weightMaterial)) !== value.weightGridHash)
      context.addIssue({
        code: "custom",
        path: ["weightGridHash"],
        message: "Terrain material blend weight-grid hash mismatch",
      });
    const { hash: _hash, ...material } = value;
    if (contentHash(stableJson(material)) !== value.hash)
      context.addIssue({
        code: "custom",
        path: ["hash"],
        message: "Terrain material blend artifact hash mismatch",
      });
  });

function decodeFloat32Weights(encoded: string, count: number): number[] | undefined {
  try {
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.length !== count * 4 || bytes.toString("base64") !== encoded) return undefined;
    const result = new Array<number>(count);
    for (let index = 0; index < count; index += 1) result[index] = bytes.readFloatLE(index * 4);
    return result;
  } catch {
    return undefined;
  }
}

export type WorldVector3 = z.infer<typeof WORLD_VECTOR3_SCHEMA>;
export type WorldPoint2 = z.infer<typeof WORLD_POINT2_SCHEMA>;
export type WorldCompositionMeasure = z.infer<typeof WORLD_COMPOSITION_MEASURE_SCHEMA>;
export type TerrainPlan = z.infer<typeof TERRAIN_PLAN_SCHEMA>;
export type TerrainOperation = z.infer<typeof terrainOperation>;
export type ConstructedSurface = z.infer<typeof CONSTRUCTED_SURFACE_SCHEMA>;
/** Detailed terrain/route plan retained behind the engine-neutral WorldPlan boundary. */
export type SpatialWorldPlan = z.infer<typeof WORLD_PLAN_SCHEMA>;
export type WorldRegion = z.infer<typeof worldRegion>;
export type WorldRegionVolume = z.infer<typeof WORLD_REGION_VOLUME_SCHEMA>;
export type WorldRoute = z.infer<typeof worldRoute>;
export type WorldCamera = z.infer<typeof worldCamera>;
export type TerrainFieldArtifact = z.infer<typeof TERRAIN_FIELD_ARTIFACT_SCHEMA>;
export type TerrainFieldSample = z.infer<typeof terrainSample>;
export type TerrainMaterialBlendArtifact = z.infer<typeof TERRAIN_MATERIAL_BLEND_ARTIFACT_SCHEMA>;

function validateWorldPlan(
  value: z.infer<typeof WORLD_PLAN_SCHEMA>,
  context: z.RefinementCtx,
): void {
  unique(
    value.references.map((reference) => reference.id),
    "World reference IDs",
    context,
  );
  unique(
    value.creatorClaims.map((claim) => claim.id),
    "Creator claim IDs",
    context,
  );
  unique(
    value.agentHypotheses.map((claim) => claim.id),
    "Agent hypothesis IDs",
    context,
  );
  const claimIds = [...value.creatorClaims, ...value.agentHypotheses].map((claim) => claim.id);
  unique(claimIds, "Semantic claim IDs", context);
  unique(
    value.regions.map((region) => region.id),
    "World region IDs",
    context,
  );
  unique(
    value.regions.flatMap((region) => region.compositionMeasures.map((measure) => measure.id)),
    "World composition measure IDs",
    context,
  );
  unique(
    value.regionRelations.map((relation) => relation.id),
    "Region relation IDs",
    context,
  );
  unique(
    value.terrainPlans.map((plan) => plan.id),
    "Terrain plan IDs",
    context,
  );
  unique(
    value.styleOverlays.map((overlay) => overlay.id),
    "World style overlay IDs",
    context,
  );
  unique(
    [
      ...value.terrainPlans.map((plan) => plan.surfaceId),
      ...value.constructedSurfaces.map((surface) => surface.id),
    ],
    "World placement surface IDs",
    context,
  );
  unique(
    value.routes.map((route) => route.id),
    "World route IDs",
    context,
  );
  unique(
    value.anchors.map((anchor) => anchor.id),
    "World anchor IDs",
    context,
  );
  unique(
    value.collisionProxies.map((collision) => collision.id),
    "World collision IDs",
    context,
  );
  unique(
    value.cameras.map((camera) => camera.id),
    "World camera IDs",
    context,
  );
  unique(
    value.assetRequirements.map((requirement) => requirement.id),
    "Asset requirement IDs",
    context,
  );
  unique(
    value.assetRequirements.map((requirement) => requirement.declarationId),
    "Asset declaration IDs",
    context,
  );
  const regions = new Set(value.regions.map((region) => region.id));
  const references = new Set(value.references.map((reference) => reference.id));
  const regionById = new Map(value.regions.map((region) => [region.id, region] as const));
  const surfaces = new Set([
    ...value.terrainPlans.map((plan) => plan.surfaceId),
    ...value.constructedSurfaces.map((surface) => surface.id),
  ]);
  const surfaceRegionIds = new Map<string, Set<string>>();
  for (const plan of value.terrainPlans)
    surfaceRegionIds.set(plan.surfaceId, new Set(plan.regions.map((region) => region.regionId)));
  for (const surface of value.constructedSurfaces)
    surfaceRegionIds.set(surface.id, new Set([surface.regionId]));
  const anchors = new Set(value.anchors.map((anchor) => anchor.id));
  const assets = new Set(value.assetRequirements.map((asset) => asset.declarationId));
  const globalCameras = value.cameras.filter((camera) => camera.evidenceRole === "global_overview");
  for (const claim of [...value.creatorClaims, ...value.agentHypotheses]) {
    if (new Set(claim.referenceIds).size !== claim.referenceIds.length)
      context.addIssue({
        code: "custom",
        message: `Semantic claim references must be unique: ${claim.id}`,
      });
    for (const referenceId of claim.referenceIds)
      if (!references.has(referenceId))
        context.addIssue({
          code: "custom",
          message: `Semantic claim references an unknown world reference: ${claim.id}/${referenceId}`,
        });
  }
  for (const claim of value.creatorClaims)
    if (claim.referenceIds.length === 0)
      context.addIssue({
        code: "custom",
        message: `Creator claim lacks retained reference authority: ${claim.id}`,
      });
  if (globalCameras.length !== 1)
    context.addIssue({
      code: "custom",
      message: "World plan requires exactly one global-overview camera",
    });
  const rootRegionIds = value.regions
    .filter((region) => region.parentId === undefined)
    .map((region) => region.id);
  if (
    globalCameras[0] &&
    rootRegionIds.some((regionId) => !globalCameras[0]!.regionIds.includes(regionId))
  )
    context.addIssue({
      code: "custom",
      message: "Global-overview camera must declare every root world region",
    });
  for (const region of value.regions) {
    if (region.parentId && (!regions.has(region.parentId) || region.parentId === region.id))
      context.addIssue({ code: "custom", message: `World region parent is invalid: ${region.id}` });
    if (!regionInsideWorld(region, value.bounds))
      context.addIssue({
        code: "custom",
        message: `World region leaves the declared world bounds: ${region.id}`,
      });
    if (region.parentId) {
      const parent = regionById.get(region.parentId);
      if (parent && !regionInsideRegion(region, parent))
        context.addIssue({
          code: "custom",
          message: `Nested world region leaves its parent volume: ${region.id}`,
        });
    }
    for (const measure of region.compositionMeasures) {
      if (
        measure.boundary.some((point) => {
          const worldPoint = {
            x: measure.origin.x + measure.uAxis.x * point.u + measure.vAxis.x * point.v,
            y: measure.origin.y + measure.uAxis.y * point.u + measure.vAxis.y * point.v,
            z: measure.origin.z + measure.uAxis.z * point.u + measure.vAxis.z * point.v,
          };
          return !worldRegionVolumeContainsPoint(region.volume, worldPoint, 1e-6);
        })
      )
        context.addIssue({
          code: "custom",
          message: `Composition boundary leaves its region volume: ${region.id}/${measure.id}`,
        });
      if (measure.surfaceId) {
        if (!surfaces.has(measure.surfaceId))
          context.addIssue({
            code: "custom",
            message: `Composition measure references an unknown surface: ${region.id}/${measure.id}/${measure.surfaceId}`,
          });
        else if (!surfaceRegionIds.get(measure.surfaceId)?.has(region.id))
          context.addIssue({
            code: "custom",
            message: `Composition measure surface is incompatible with its region: ${region.id}/${measure.id}/${measure.surfaceId}`,
          });
      }
    }
  }
  for (const region of value.regions) assertAcyclicRegion(region.id, value.regions, context);
  for (const plan of value.terrainPlans)
    for (const region of plan.regions)
      if (!regions.has(region.regionId))
        context.addIssue({
          code: "custom",
          message: `Terrain plan references an unknown region: ${region.regionId}`,
        });
  for (const surface of value.constructedSurfaces) {
    const region = regionById.get(surface.regionId);
    if (!region)
      context.addIssue({
        code: "custom",
        message: `Constructed surface references an unknown region: ${surface.id}`,
      });
    else if (!constructedSurfaceInsideRegion(surface, region))
      context.addIssue({
        code: "custom",
        message: `Constructed surface leaves its region volume: ${surface.id}`,
      });
  }
  for (const route of value.routes) {
    if (!surfaces.has(route.surfaceId))
      context.addIssue({
        code: "custom",
        message: `Route references an unknown surface: ${route.id}`,
      });
    for (const regionId of route.regionIds)
      if (!regions.has(regionId))
        context.addIssue({
          code: "custom",
          message: `Route references an unknown region: ${route.id}`,
        });
    for (const anchorId of route.reachableAnchorIds)
      if (!anchors.has(anchorId))
        context.addIssue({
          code: "custom",
          message: `Route references an unknown anchor: ${anchorId}`,
        });
  }
  for (const anchor of value.anchors)
    if (!regions.has(anchor.regionId))
      context.addIssue({
        code: "custom",
        message: `Anchor references an unknown region: ${anchor.id}`,
      });
  for (const [collisionIndex, collision] of value.collisionProxies.entries()) {
    const regionExists = regions.has(collision.regionId);
    if (!regionExists)
      context.addIssue({
        code: "custom",
        path: ["collisionProxies", collisionIndex, "regionId"],
        message: `Collision references an unknown region: ${collision.id}`,
      });
    if (collision.placementAuthority.kind === "surface_substrate") {
      const surfaceId = collision.placementAuthority.surfaceId;
      if (!surfaces.has(surfaceId))
        context.addIssue({
          code: "custom",
          path: ["collisionProxies", collisionIndex, "placementAuthority", "surfaceId"],
          message: `Collision substrate references an unknown surface: ${collision.id}/${surfaceId}`,
        });
      else if (regionExists && !surfaceRegionIds.get(surfaceId)?.has(collision.regionId))
        context.addIssue({
          code: "custom",
          path: ["collisionProxies", collisionIndex, "regionId"],
          message: `Collision substrate surface is incompatible with its region: ${collision.id}/${surfaceId}/${collision.regionId}`,
        });
    }
  }
  for (const camera of value.cameras) {
    if (
      new Set(camera.regionIds).size !== camera.regionIds.length ||
      new Set(camera.framingAssetIds).size !== camera.framingAssetIds.length
    )
      context.addIssue({
        code: "custom",
        message: `Camera region and framing references must be unique: ${camera.id}`,
      });
    for (const regionId of camera.regionIds)
      if (!regions.has(regionId))
        context.addIssue({
          code: "custom",
          message: `Camera references an unknown region: ${camera.id}`,
        });
    for (const assetId of camera.framingAssetIds)
      if (!assets.has(assetId))
        context.addIssue({
          code: "custom",
          message: `Camera references an unknown asset: ${assetId}`,
        });
  }
  for (const asset of value.assetRequirements)
    for (const regionId of asset.regionIds)
      if (!regions.has(regionId))
        context.addIssue({
          code: "custom",
          message: `Asset requirement references an unknown region: ${asset.id}/${regionId}`,
        });
  for (const relation of value.regionRelations) {
    const ids =
      relation.kind === "adjacent" || relation.kind === "overlap"
        ? [relation.firstRegionId, relation.secondRegionId]
        : relation.kind === "relative_position"
          ? [relation.subjectRegionId, relation.referenceRegionId]
          : [relation.regionId];
    if (ids.some((id) => !regions.has(id)))
      context.addIssue({
        code: "custom",
        message: `Region relation references an unknown region: ${relation.id}`,
      });
    else {
      const problem = regionRelationProblem(relation, regionById, value.bounds);
      if (problem)
        context.addIssue({
          code: "custom",
          message: `Region relation is unsatisfied: ${relation.id}/${problem}`,
        });
    }
  }
}

function regionInsideWorld(
  region: z.infer<typeof worldRegion>,
  bounds: { center: WorldVector3; size: WorldVector3 },
): boolean {
  const minimumX = bounds.center.x - bounds.size.x / 2;
  const maximumX = bounds.center.x + bounds.size.x / 2;
  const minimumY = bounds.center.y - bounds.size.y / 2;
  const maximumY = bounds.center.y + bounds.size.y / 2;
  const minimumZ = bounds.center.z - bounds.size.z / 2;
  const maximumZ = bounds.center.z + bounds.size.z / 2;
  return worldRegionBoundaryVertices(region.volume).every(
    (point) =>
      point.x >= minimumX - 1e-6 &&
      point.x <= maximumX + 1e-6 &&
      point.y >= minimumY - 1e-6 &&
      point.y <= maximumY + 1e-6 &&
      point.z >= minimumZ - 1e-6 &&
      point.z <= maximumZ + 1e-6,
  );
}

function regionInsideRegion(
  child: z.infer<typeof worldRegion>,
  parent: z.infer<typeof worldRegion>,
): boolean {
  const childVolume = child.volume;
  const parentVolume = parent.volume;
  if (parentVolume.kind === "extruded_polygon") {
    const childRange = worldRegionVerticalRange(childVolume);
    const childFootprint = worldRegionGroundFootprint(childVolume);
    return (
      childRange.minimum >= parentVolume.verticalRange.minimum - 1e-6 &&
      childRange.maximum <= parentVolume.verticalRange.maximum + 1e-6 &&
      childFootprint.every((point) => pointInsideOrOnPolygon(point, parentVolume.footprint)) &&
      !polygonEdgesCross(childFootprint, parentVolume.footprint)
    );
  }
  return worldRegionBoundaryVertices(child.volume).every((point) =>
    worldRegionVolumeContainsPoint(parent.volume, point),
  );
}

function regionRelationProblem(
  relation: z.infer<typeof regionRelation>,
  regions: ReadonlyMap<string, z.infer<typeof worldRegion>>,
  worldBounds: { center: WorldVector3; size: WorldVector3 },
): string | undefined {
  if (relation.kind === "coverage") {
    const region = regions.get(relation.regionId)!;
    const coverage =
      polygonArea(worldRegionGroundFootprint(region.volume)) /
      (worldBounds.size.x * worldBounds.size.z);
    return coverage >= relation.minimum - 1e-6 && coverage <= relation.maximum + 1e-6
      ? undefined
      : "coverage";
  }
  const first = regions.get(
    relation.kind === "adjacent" || relation.kind === "overlap"
      ? relation.firstRegionId
      : relation.subjectRegionId,
  )!;
  const second = regions.get(
    relation.kind === "adjacent" || relation.kind === "overlap"
      ? relation.secondRegionId
      : relation.referenceRegionId,
  )!;
  if (first.id === second.id) return "self_reference";
  if (relation.kind === "adjacent") {
    const verticalOverlap = intervalsOverlap(
      worldRegionVerticalRange(first.volume),
      worldRegionVerticalRange(second.volume),
    );
    return verticalOverlap &&
      polygonBoundaryDistance(
        worldRegionGroundFootprint(first.volume),
        worldRegionGroundFootprint(second.volume),
      ) <= 1e-6
      ? undefined
      : "adjacency";
  }

  if (relation.kind === "overlap")
    return intervalsOverlap(
      worldRegionVerticalRange(first.volume),
      worldRegionVerticalRange(second.volume),
    ) &&
      polygonsOverlap(
        worldRegionGroundFootprint(first.volume),
        worldRegionGroundFootprint(second.volume),
      )
      ? undefined
      : "overlap";

  const firstCenter = regionCenter(first);
  const secondCenter = regionCenter(second);
  const separation = dot(subtract(firstCenter, secondCenter), relation.direction);
  return Math.abs(separation - relation.offset) <= relation.tolerance + 1e-6
    ? undefined
    : "directional_offset";
}

function regionCenter(region: z.infer<typeof worldRegion>): WorldVector3 {
  return worldRegionVolumeCenter(region.volume);
}

export interface WorldRegionVolumeBounds {
  readonly minimum: WorldVector3;
  readonly maximum: WorldVector3;
  readonly center: WorldVector3;
  readonly size: WorldVector3;
}

/** Exact point query for every current bounded region representation. */
export function worldRegionVolumeContainsPoint(
  volume: WorldRegionVolume,
  point: WorldVector3,
  clearance = 0,
): boolean {
  if (!Number.isFinite(clearance) || clearance < 0)
    throw new Error("Region containment clearance must be finite and nonnegative");
  if (volume.kind === "extruded_polygon") {
    const planar = { x: point.x, z: point.z };
    return (
      pointInsideOrOnPolygon(planar, volume.footprint) &&
      pointSegmentPolygonDistance(planar, volume.footprint) >= clearance - 1e-6 &&
      point.y >= volume.verticalRange.minimum + clearance - 1e-6 &&
      point.y <= volume.verticalRange.maximum - clearance + 1e-6
    );
  }
  if (volume.kind === "oriented_box") {
    const offset = subtract(point, volume.center);
    return (
      Math.abs(dot(offset, volume.axes.x)) <= volume.halfSize.x - clearance + 1e-6 &&
      Math.abs(dot(offset, volume.axes.y)) <= volume.halfSize.y - clearance + 1e-6 &&
      Math.abs(dot(offset, volume.axes.z)) <= volume.halfSize.z - clearance + 1e-6
    );
  }
  return volume.faces.every((face) => {
    const first = volume.vertices[face[0]]!;
    const normal = normalizeVector(
      cross(subtract(volume.vertices[face[1]]!, first), subtract(volume.vertices[face[2]]!, first)),
    );
    return dot(normal, subtract(point, first)) <= -clearance + 1e-6;
  });
}

export function worldRegionContainsPoint(
  region: WorldRegion,
  point: WorldVector3,
  clearance = 0,
): boolean {
  return worldRegionVolumeContainsPoint(region.volume, point, clearance);
}

/** Vertices are sufficient for exact bounds and containment in convex parent volumes. */
export function worldRegionBoundaryVertices(volume: WorldRegionVolume): WorldVector3[] {
  if (volume.kind === "extruded_polygon")
    return volume.footprint.flatMap((point) => [
      { x: point.x, y: volume.verticalRange.minimum, z: point.z },
      { x: point.x, y: volume.verticalRange.maximum, z: point.z },
    ]);
  if (volume.kind === "convex_polyhedron") return volume.vertices.map((point) => ({ ...point }));
  const result: WorldVector3[] = [];
  for (const x of [-1, 1])
    for (const y of [-1, 1])
      for (const z of [-1, 1])
        result.push(
          add(
            volume.center,
            add(
              multiply(volume.axes.x, x * volume.halfSize.x),
              add(
                multiply(volume.axes.y, y * volume.halfSize.y),
                multiply(volume.axes.z, z * volume.halfSize.z),
              ),
            ),
          ),
        );
  return result;
}

export function worldRegionVolumeBounds(volume: WorldRegionVolume): WorldRegionVolumeBounds {
  const vertices = worldRegionBoundaryVertices(volume);
  const minimum = {
    x: Math.min(...vertices.map((point) => point.x)),
    y: Math.min(...vertices.map((point) => point.y)),
    z: Math.min(...vertices.map((point) => point.z)),
  };
  const maximum = {
    x: Math.max(...vertices.map((point) => point.x)),
    y: Math.max(...vertices.map((point) => point.y)),
    z: Math.max(...vertices.map((point) => point.z)),
  };
  return {
    minimum,
    maximum,
    center: {
      x: (minimum.x + maximum.x) / 2,
      y: (minimum.y + maximum.y) / 2,
      z: (minimum.z + maximum.z) / 2,
    },
    size: {
      x: maximum.x - minimum.x,
      y: maximum.y - minimum.y,
      z: maximum.z - minimum.z,
    },
  };
}

export function worldRegionVolumeCenter(volume: WorldRegionVolume): WorldVector3 {
  if (volume.kind === "oriented_box") return { ...volume.center };
  if (volume.kind === "extruded_polygon") {
    const signedArea = polygonSignedArea(volume.footprint);
    let x = 0;
    let z = 0;
    for (let index = 0; index < volume.footprint.length; index += 1) {
      const current = volume.footprint[index]!;
      const next = volume.footprint[(index + 1) % volume.footprint.length]!;
      const factor = current.x * next.z - next.x * current.z;
      x += (current.x + next.x) * factor;
      z += (current.z + next.z) * factor;
    }
    return {
      x: x / (6 * signedArea),
      y: (volume.verticalRange.minimum + volume.verticalRange.maximum) / 2,
      z: z / (6 * signedArea),
    };
  }
  let signedVolume = 0;
  let weightedCenter = { x: 0, y: 0, z: 0 };
  for (const face of volume.faces) {
    const first = volume.vertices[face[0]]!;
    const second = volume.vertices[face[1]]!;
    const third = volume.vertices[face[2]]!;
    const tetrahedronVolume = dot(first, cross(second, third)) / 6;
    signedVolume += tetrahedronVolume;
    weightedCenter = add(
      weightedCenter,
      multiply(add(first, add(second, third)), tetrahedronVolume / 4),
    );
  }
  if (Math.abs(signedVolume) <= 1e-12) throw new Error("Convex polyhedron has zero volume");
  return multiply(weightedCenter, 1 / signedVolume);
}

export function worldRegionVerticalRange(volume: WorldRegionVolume): {
  minimum: number;
  maximum: number;
} {
  const bounds = worldRegionVolumeBounds(volume);
  return { minimum: bounds.minimum.y, maximum: bounds.maximum.y };
}

/** Horizontal projection used only for 2D evidence and coverage metrics. */
export function worldRegionGroundFootprint(volume: WorldRegionVolume): WorldPoint2[] {
  if (volume.kind === "extruded_polygon") return volume.footprint.map((point) => ({ ...point }));
  return convexHull(
    worldRegionBoundaryVertices(volume).map((point) => ({ x: point.x, z: point.z })),
  );
}

function intervalsOverlap(
  first: { minimum: number; maximum: number },
  second: { minimum: number; maximum: number },
): boolean {
  return Math.min(first.maximum, second.maximum) > Math.max(first.minimum, second.minimum) + 1e-6;
}

function polygonsOverlap(first: readonly WorldPoint2[], second: readonly WorldPoint2[]): boolean {
  return (
    first.some((point) => pointInsideOrOnPolygon(point, second)) ||
    second.some((point) => pointInsideOrOnPolygon(point, first)) ||
    polygonBoundaryDistance(first, second) <= 1e-6
  );
}

function polygonBoundaryDistance(
  first: readonly WorldPoint2[],
  second: readonly WorldPoint2[],
): number {
  let result = Number.POSITIVE_INFINITY;
  for (let firstIndex = 0; firstIndex < first.length; firstIndex += 1) {
    const firstStart = first[firstIndex]!;
    const firstEnd = first[(firstIndex + 1) % first.length]!;
    for (let secondIndex = 0; secondIndex < second.length; secondIndex += 1) {
      const secondStart = second[secondIndex]!;
      const secondEnd = second[(secondIndex + 1) % second.length]!;
      if (segmentsIntersect(firstStart, firstEnd, secondStart, secondEnd)) return 0;
      result = Math.min(
        result,
        pointSegmentDistance(firstStart, secondStart, secondEnd),
        pointSegmentDistance(firstEnd, secondStart, secondEnd),
        pointSegmentDistance(secondStart, firstStart, firstEnd),
        pointSegmentDistance(secondEnd, firstStart, firstEnd),
      );
    }
  }
  return result;
}

function pointSegmentDistance(point: WorldPoint2, start: WorldPoint2, end: WorldPoint2): number {
  const dx = end.x - start.x;
  const dz = end.z - start.z;
  const denominator = dx * dx + dz * dz;
  const amount =
    denominator <= 1e-12
      ? 0
      : Math.max(
          0,
          Math.min(1, ((point.x - start.x) * dx + (point.z - start.z) * dz) / denominator),
        );
  return Math.hypot(point.x - (start.x + amount * dx), point.z - (start.z + amount * dz));
}

function pointInsideOrOnPolygon(point: WorldPoint2, polygon: readonly WorldPoint2[]): boolean {
  for (let index = 0; index < polygon.length; index += 1)
    if (
      pointSegmentDistance(point, polygon[index]!, polygon[(index + 1) % polygon.length]!) <= 1e-6
    )
      return true;
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const current = polygon[index]!;
    const prior = polygon[previous]!;
    if (
      current.z > point.z !== prior.z > point.z &&
      point.x < ((prior.x - current.x) * (point.z - current.z)) / (prior.z - current.z) + current.x
    )
      inside = !inside;
  }
  return inside;
}

function polygonEdgesCross(first: readonly WorldPoint2[], second: readonly WorldPoint2[]): boolean {
  for (let firstIndex = 0; firstIndex < first.length; firstIndex += 1)
    for (let secondIndex = 0; secondIndex < second.length; secondIndex += 1)
      if (
        properSegmentsIntersect(
          first[firstIndex]!,
          first[(firstIndex + 1) % first.length]!,
          second[secondIndex]!,
          second[(secondIndex + 1) % second.length]!,
        )
      )
        return true;
  return false;
}

function properSegmentsIntersect(
  firstStart: WorldPoint2,
  firstEnd: WorldPoint2,
  secondStart: WorldPoint2,
  secondEnd: WorldPoint2,
): boolean {
  const orientation = (start: WorldPoint2, end: WorldPoint2, point: WorldPoint2) =>
    (end.x - start.x) * (point.z - start.z) - (end.z - start.z) * (point.x - start.x);
  const firstSide = orientation(firstStart, firstEnd, secondStart);
  const secondSide = orientation(firstStart, firstEnd, secondEnd);
  const thirdSide = orientation(secondStart, secondEnd, firstStart);
  const fourthSide = orientation(secondStart, secondEnd, firstEnd);
  return firstSide * secondSide < -1e-12 && thirdSide * fourthSide < -1e-12;
}

function polygonArea(points: readonly WorldPoint2[]): number {
  return Math.abs(polygonSignedArea(points));
}

function polygonSignedArea(points: readonly WorldPoint2[]): number {
  let twiceArea = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]!;
    const next = points[(index + 1) % points.length]!;
    twiceArea += current.x * next.z - next.x * current.z;
  }
  return twiceArea / 2;
}

function assertAcyclicRegion(
  start: string,
  regions: readonly z.infer<typeof worldRegion>[],
  context: z.RefinementCtx,
): void {
  const byId = new Map(regions.map((region) => [region.id, region]));
  const seen = new Set<string>();
  let current = byId.get(start);
  while (current?.parentId) {
    if (seen.has(current.id)) {
      context.addIssue({
        code: "custom",
        message: `World region hierarchy contains a cycle: ${start}`,
      });
      return;
    }
    seen.add(current.id);
    current = byId.get(current.parentId);
  }
}

function approximatelyOne(values: readonly number[]): boolean {
  return values.length > 0 && Math.abs(values.reduce((sum, value) => sum + value, 0) - 1) <= 1e-5;
}

function vectorLength(value: { x: number; y: number; z: number }): number {
  return Math.hypot(value.x, value.y, value.z);
}

function dot(left: WorldVector3, right: WorldVector3): number {
  return left.x * right.x + left.y * right.y + left.z * right.z;
}

function cross(left: WorldVector3, right: WorldVector3): WorldVector3 {
  return {
    x: left.y * right.z - left.z * right.y,
    y: left.z * right.x - left.x * right.z,
    z: left.x * right.y - left.y * right.x,
  };
}

function add(left: WorldVector3, right: WorldVector3): WorldVector3 {
  return { x: left.x + right.x, y: left.y + right.y, z: left.z + right.z };
}

function subtract(left: WorldVector3, right: WorldVector3): WorldVector3 {
  return { x: left.x - right.x, y: left.y - right.y, z: left.z - right.z };
}

function multiply(value: WorldVector3, factor: number): WorldVector3 {
  return { x: value.x * factor, y: value.y * factor, z: value.z * factor };
}

function normalizeVector(value: WorldVector3): WorldVector3 {
  const length = vectorLength(value);
  if (!(length > 1e-12)) throw new Error("Cannot normalize a degenerate vector");
  return multiply(value, 1 / length);
}

function convexPolyhedronProblem(
  vertices: readonly WorldVector3[],
  faces: readonly (readonly [number, number, number])[],
): string | undefined {
  const identities = vertices.map((vertex) => `${vertex.x},${vertex.y},${vertex.z}`);
  if (new Set(identities).size !== identities.length)
    return "Convex polyhedron vertices must be unique";
  const faceIdentities = new Set<string>();
  const referenced = new Set<number>();
  const directedEdges = new Map<string, string[]>();
  const centroid = multiply(
    vertices.reduce((sum, vertex) => add(sum, vertex), { x: 0, y: 0, z: 0 }),
    1 / vertices.length,
  );
  for (const face of faces) {
    if (face.some((index) => index >= vertices.length))
      return "Convex polyhedron face index is out of bounds";
    if (new Set(face).size !== 3) return "Convex polyhedron faces must use three vertices";
    const identity = [...face].sort((left, right) => left - right).join(",");
    if (faceIdentities.has(identity)) return "Convex polyhedron faces must be unique";
    faceIdentities.add(identity);
    face.forEach((index) => referenced.add(index));
    const first = vertices[face[0]]!;
    const normalRaw = cross(
      subtract(vertices[face[1]]!, first),
      subtract(vertices[face[2]]!, first),
    );
    if (vectorLength(normalRaw) <= 1e-9) return "Convex polyhedron face is degenerate";
    const normal = normalizeVector(normalRaw);
    if (dot(normal, subtract(centroid, first)) >= -1e-7)
      return "Convex polyhedron faces must use outward winding";
    if (vertices.some((vertex) => dot(normal, subtract(vertex, first)) > 1e-6))
      return "Convex polyhedron contains a non-convex face plane";
    for (let index = 0; index < 3; index += 1) {
      const start = face[index]!;
      const end = face[(index + 1) % 3]!;
      const key = [Math.min(start, end), Math.max(start, end)].join(":");
      const directions = directedEdges.get(key) ?? [];
      directions.push(`${start}:${end}`);
      directedEdges.set(key, directions);
    }
  }
  if (referenced.size !== vertices.length)
    return "Every convex polyhedron vertex must be referenced by a face";
  for (const [edge, directions] of directedEdges) {
    if (directions.length !== 2) return `Convex polyhedron edge must have two faces: ${edge}`;
    const [start, end] = edge.split(":");
    if (!directions.includes(`${start}:${end}`) || !directions.includes(`${end}:${start}`))
      return `Convex polyhedron shared-edge winding is inconsistent: ${edge}`;
  }
  return undefined;
}

function trianglePatchProblem(
  vertices: readonly {
    readonly position: WorldVector3;
    readonly normal: WorldVector3;
    readonly coordinate: { readonly u: number; readonly v: number };
  }[],
  triangles: readonly (readonly [number, number, number])[],
): string | undefined {
  const triangleIdentities = new Set<string>();
  const edgeDirections = new Map<string, string[]>();
  for (const triangle of triangles) {
    if (triangle.some((index) => index >= vertices.length))
      return "Triangle-patch index is out of bounds";
    if (new Set(triangle).size !== 3) return "Triangle-patch faces must use three vertices";
    const identity = [...triangle].sort((left, right) => left - right).join(",");
    if (triangleIdentities.has(identity)) return "Triangle-patch faces must be unique";
    triangleIdentities.add(identity);
    const [first, second, third] = triangle.map((index) => vertices[index]!);
    const geometryNormal = cross(
      subtract(second!.position, first!.position),
      subtract(third!.position, first!.position),
    );
    if (vectorLength(geometryNormal) <= 1e-9) return "Triangle-patch face is degenerate";
    const coordinateArea =
      (second!.coordinate.u - first!.coordinate.u) * (third!.coordinate.v - first!.coordinate.v) -
      (second!.coordinate.v - first!.coordinate.v) * (third!.coordinate.u - first!.coordinate.u);
    if (Math.abs(coordinateArea) <= 1e-12) return "Triangle-patch coordinate face is degenerate";
    const averageNormal = add(first!.normal, add(second!.normal, third!.normal));
    if (vectorLength(averageNormal) <= 1e-9 || dot(geometryNormal, averageNormal) <= 1e-9)
      return "Triangle-patch winding must agree with its vertex normals";
    for (let index = 0; index < 3; index += 1) {
      const start = triangle[index]!;
      const end = triangle[(index + 1) % 3]!;
      const key = [Math.min(start, end), Math.max(start, end)].join(":");
      const directions = edgeDirections.get(key) ?? [];
      directions.push(`${start}:${end}`);
      edgeDirections.set(key, directions);
    }
  }
  for (const [edge, directions] of edgeDirections) {
    if (directions.length > 2) return `Triangle patch has a non-manifold edge: ${edge}`;
    if (directions.length === 2) {
      const [start, end] = edge.split(":");
      if (!directions.includes(`${start}:${end}`) || !directions.includes(`${end}:${start}`))
        return `Triangle-patch shared-edge winding is inconsistent: ${edge}`;
    }
  }
  return undefined;
}

function constructedSurfaceBoundaryPoints(surface: ConstructedSurface): WorldVector3[] {
  if (surface.geometry.kind === "triangle_patch")
    return surface.geometry.vertices.map((vertex) => vertex.position);
  const geometry = surface.geometry;
  return [geometry.uRange.minimum, geometry.uRange.maximum].flatMap((u) =>
    [geometry.vRange.minimum, geometry.vRange.maximum].map((v) =>
      add(geometry.origin, add(multiply(geometry.uAxis, u), multiply(geometry.vAxis, v))),
    ),
  );
}

function constructedSurfaceInsideRegion(surface: ConstructedSurface, region: WorldRegion): boolean {
  if (
    constructedSurfaceBoundaryPoints(surface).some(
      (point) => !worldRegionContainsPoint(region, point),
    )
  )
    return false;
  if (region.volume.kind !== "extruded_polygon") return true;
  const footprint = region.volume.footprint;
  return constructedSurfaceSegments(surface).every(([start, end]) => {
    const first = { x: start.x, z: start.z };
    const second = { x: end.x, z: end.z };
    for (let index = 0; index < footprint.length; index += 1)
      if (
        properSegmentsIntersect(
          first,
          second,
          footprint[index]!,
          footprint[(index + 1) % footprint.length]!,
        )
      )
        return false;
    return true;
  });
}

function constructedSurfaceSegments(
  surface: ConstructedSurface,
): Array<readonly [WorldVector3, WorldVector3]> {
  if (surface.geometry.kind === "triangle_patch") {
    const geometry = surface.geometry;
    return geometry.triangles.flatMap((triangle) => [
      [geometry.vertices[triangle[0]]!.position, geometry.vertices[triangle[1]]!.position],
      [geometry.vertices[triangle[1]]!.position, geometry.vertices[triangle[2]]!.position],
      [geometry.vertices[triangle[2]]!.position, geometry.vertices[triangle[0]]!.position],
    ]);
  }
  const geometry = surface.geometry;
  const corners = [
    add(
      geometry.origin,
      add(
        multiply(geometry.uAxis, geometry.uRange.minimum),
        multiply(geometry.vAxis, geometry.vRange.minimum),
      ),
    ),
    add(
      geometry.origin,
      add(
        multiply(geometry.uAxis, geometry.uRange.maximum),
        multiply(geometry.vAxis, geometry.vRange.minimum),
      ),
    ),
    add(
      geometry.origin,
      add(
        multiply(geometry.uAxis, geometry.uRange.maximum),
        multiply(geometry.vAxis, geometry.vRange.maximum),
      ),
    ),
    add(
      geometry.origin,
      add(
        multiply(geometry.uAxis, geometry.uRange.minimum),
        multiply(geometry.vAxis, geometry.vRange.maximum),
      ),
    ),
  ];
  return corners.map((corner, index) => [corner, corners[(index + 1) % corners.length]!]);
}

function convexHull(points: readonly WorldPoint2[]): WorldPoint2[] {
  const sorted = [
    ...new Map(points.map((point) => [`${point.x},${point.z}`, point])).values(),
  ].sort((left, right) => left.x - right.x || left.z - right.z);
  if (sorted.length < 3) throw new Error("Region volume has a degenerate ground projection");
  const turn = (origin: WorldPoint2, first: WorldPoint2, second: WorldPoint2) =>
    (first.x - origin.x) * (second.z - origin.z) - (first.z - origin.z) * (second.x - origin.x);
  const half = (sequence: readonly WorldPoint2[]) => {
    const result: WorldPoint2[] = [];
    for (const point of sequence) {
      while (result.length >= 2 && turn(result.at(-2)!, result.at(-1)!, point) <= 1e-12)
        result.pop();
      result.push(point);
    }
    return result;
  };
  const result = [...half(sorted).slice(0, -1), ...half([...sorted].reverse()).slice(0, -1)];
  if (result.length < 3) throw new Error("Region volume has a degenerate ground projection");
  return result.map((point) => ({ ...point }));
}

function pointSegmentPolygonDistance(point: WorldPoint2, polygon: readonly WorldPoint2[]): number {
  return Math.min(
    ...polygon.map((start, index) =>
      pointSegmentDistance(point, start, polygon[(index + 1) % polygon.length]!),
    ),
  );
}

function unique(values: readonly string[], label: string, context: z.RefinementCtx): void {
  if (new Set(values).size !== values.length)
    context.addIssue({ code: "custom", message: `${label} must be unique` });
}

function polygonProblem(polygon: readonly WorldPoint2[]): string | undefined {
  const identities = polygon.map((point) => `${point.x},${point.z}`);
  if (new Set(identities).size !== identities.length) return "Polygon vertices must be unique";
  let twiceArea = 0;
  for (let index = 0; index < polygon.length; index += 1) {
    const left = polygon[index]!;
    const right = polygon[(index + 1) % polygon.length]!;
    twiceArea += left.x * right.z - right.x * left.z;
  }
  if (Math.abs(twiceArea) <= 1e-9) return "Polygon must enclose nonzero area";
  for (let left = 0; left < polygon.length; left += 1) {
    const leftNext = (left + 1) % polygon.length;
    for (let right = left + 1; right < polygon.length; right += 1) {
      const rightNext = (right + 1) % polygon.length;
      if (left === right || leftNext === right || rightNext === left) continue;
      if (
        segmentsIntersect(polygon[left]!, polygon[leftNext]!, polygon[right]!, polygon[rightNext]!)
      )
        return "Polygon must be simple";
    }
  }
  return undefined;
}

function segmentsIntersect(
  a: WorldPoint2,
  b: WorldPoint2,
  c: WorldPoint2,
  d: WorldPoint2,
): boolean {
  const orientation = (p: WorldPoint2, q: WorldPoint2, r: WorldPoint2) =>
    Math.sign((q.z - p.z) * (r.x - q.x) - (q.x - p.x) * (r.z - q.z));
  return (
    orientation(a, b, c) !== orientation(a, b, d) && orientation(c, d, a) !== orientation(c, d, b)
  );
}
