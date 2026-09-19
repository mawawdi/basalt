import { z } from "zod";
import {
  COMPILATION_STATUS_SCHEMA,
  HASH_SCHEMA,
  compareCanonicalStrings,
  contentAddressedEntityId,
  contentHash,
  deepFreezeJson,
  stableJson,
} from "@basalt/contracts";
import {
  CATALOG_RESOLUTION_PLAN_SCHEMA,
  ENTRY_HANDLE_SCHEMA,
  MEMBER_ID_SCHEMA,
} from "@basalt/catalog-model";
import { ROLE_ID_SCHEMA, ROLE_SCHEME_ID_SCHEMA } from "@basalt/semantic-kernel";
import {
  OCCUPANCY_RESERVATION_SCHEMA,
  SPATIAL_AABB_SCHEMA,
  SPATIAL_VECTOR3_SCHEMA,
} from "@basalt/spatial-core";
import {
  LOT_SUBDIVISION_SCHEMA,
  PLACEMENT_SURFACE_SCHEMA,
  WORLD_VISUAL_ENVIRONMENT_SCHEMA,
  WORLD_ENTITY_ID_SCHEMA,
  type CompiledWorldPlan,
} from "@basalt/world-planning";
import {
  ROUTE_CONSTRUCTION_ARTIFACT_SCHEMA,
  ROUTE_JUNCTION_ARTIFACT_SCHEMA,
  resolveRouteConstructions,
} from "./route-construction.js";
import {
  BASE_TERRAIN_FIELD_ARTIFACT_SCHEMA,
  TERRAIN_FIELD_ARTIFACT_SCHEMA,
  sealBaseTerrainFieldArtifact,
  sealTerrainFieldArtifact,
  verifyTerrainConstruction,
} from "./terrain-foundation.js";

export { WORLD_VISUAL_ENVIRONMENT_SCHEMA } from "@basalt/world-planning";

const quaternion = z
  .tuple([z.number().finite(), z.number().finite(), z.number().finite(), z.number().finite()])
  .refine((value) => Math.abs(Math.hypot(...value) - 1) <= 1e-6, "Rotation must be normalized");
const endpoint = z
  .object({ instanceId: WORLD_ENTITY_ID_SCHEMA, socketId: z.string().min(1).max(128) })
  .strict();
const assemblyConnection = z
  .object({
    connectionId: WORLD_ENTITY_ID_SCHEMA,
    host: endpoint,
    child: endpoint,
    hostInterfaceId: ENTRY_HANDLE_SCHEMA,
    childInterfaceId: ENTRY_HANDLE_SCHEMA,
    evidenceHashes: z.array(HASH_SCHEMA).min(1).max(128),
  })
  .strict();

export const REALIZED_INSTANCE_SCHEMA = z
  .object({
    kind: z.literal("RealizedInstance"),
    instanceId: WORLD_ENTITY_ID_SCHEMA,
    sourceKind: z.enum([
      "substitution_member",
      "assembly_component",
      "attachment",
      "route_component",
      "environment",
    ]),
    entryHandle: ENTRY_HANDLE_SCHEMA,
    entryHash: HASH_SCHEMA,
    memberId: MEMBER_ID_SCHEMA,
    assetHash: HASH_SCHEMA,
    assertionBundleHash: HASH_SCHEMA,
    intentId: WORLD_ENTITY_ID_SCHEMA,
    intentHash: HASH_SCHEMA,
    regionId: WORLD_ENTITY_ID_SCHEMA.optional(),
    surfaceId: WORLD_ENTITY_ID_SCHEMA.optional(),
    roleSchemeId: ROLE_SCHEME_ID_SCHEMA.optional(),
    roleId: ROLE_ID_SCHEMA.optional(),
    transformMeters: z
      .object({
        position: SPATIAL_VECTOR3_SCHEMA,
        rotation: quaternion,
        scale: z.number().finite().positive(),
      })
      .strict(),
    sourceBoundsMeters: SPATIAL_AABB_SCHEMA,
    boundsMeters: SPATIAL_AABB_SCHEMA,
    connection: z
      .object({ host: endpoint, child: endpoint, interfaceId: ENTRY_HANDLE_SCHEMA })
      .strict()
      .optional(),
    evidenceHashes: z.array(HASH_SCHEMA).max(8192),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyHash(value, "hash", context);
    if (value.connection && value.connection.child.instanceId !== value.instanceId)
      context.addIssue({
        code: "custom",
        path: ["connection", "child", "instanceId"],
        message: "Connection child endpoint must name the realized instance",
      });
  });
export type RealizedInstance = z.output<typeof REALIZED_INSTANCE_SCHEMA>;

export function sealRealizedInstance(
  input: Omit<RealizedInstance, "kind" | "instanceId" | "hash" | "connection"> & {
    readonly connection?: {
      readonly host: { readonly instanceId: string; readonly socketId: string };
      readonly childSocketId: string;
      readonly interfaceId: string;
    };
  },
): RealizedInstance {
  const identityMaterial = {
    ...input,
    evidenceHashes: [...new Set(input.evidenceHashes)].sort(compareCanonicalStrings),
  };
  const instanceId = contentAddressedEntityId("Instance", identityMaterial);
  const canonical = {
    ...input,
    ...(input.connection
      ? {
          connection: {
            host: input.connection.host,
            child: { instanceId, socketId: input.connection.childSocketId },
            interfaceId: input.connection.interfaceId,
          },
        }
      : {}),
    evidenceHashes: identityMaterial.evidenceHashes,
  };
  const material = { kind: "RealizedInstance" as const, instanceId, ...canonical };
  return deepFreezeJson(
    REALIZED_INSTANCE_SCHEMA.parse({ ...material, hash: contentHash(stableJson(material)) }),
  );
}

export const COMPILED_WORLD_FOUNDATION_SCHEMA = z
  .object({
    kind: z.literal("CompiledWorldFoundation"),
    status: COMPILATION_STATUS_SCHEMA,
    foundationInputHash: HASH_SCHEMA,
    boundsMeters: SPATIAL_AABB_SCHEMA,
    baseTerrainFields: z.array(BASE_TERRAIN_FIELD_ARTIFACT_SCHEMA).max(4096),
    terrainFields: z.array(TERRAIN_FIELD_ARTIFACT_SCHEMA).max(4096),
    routeConstructions: z.array(ROUTE_CONSTRUCTION_ARTIFACT_SCHEMA).max(65_536),
    routeJunctions: z.array(ROUTE_JUNCTION_ARTIFACT_SCHEMA).max(65_536),
    lotSubdivisions: z.array(LOT_SUBDIVISION_SCHEMA).max(4096),
    placementSurfaces: z.array(PLACEMENT_SURFACE_SCHEMA).max(65_536),
    diagnostics: z.array(z.string().trim().min(1).max(1024)).max(65_536),
    foundationHash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyHash(value, "foundationHash", context);
    if (
      new Set(value.terrainFields.map((entry) => entry.terrainPlanId)).size !==
      value.terrainFields.length
    )
      context.addIssue({ code: "custom", message: "Foundation repeats terrain artifacts" });
    if (
      new Set(value.baseTerrainFields.map((entry) => entry.terrainPlanId)).size !==
      value.baseTerrainFields.length
    )
      context.addIssue({ code: "custom", message: "Foundation repeats base-terrain artifacts" });
    if (
      new Set(value.routeConstructions.map((entry) => entry.routeId)).size !==
      value.routeConstructions.length
    )
      context.addIssue({ code: "custom", message: "Foundation repeats route artifacts" });
    if (
      new Set(value.routeJunctions.map((entry) => entry.junctionId)).size !==
      value.routeJunctions.length
    )
      context.addIssue({ code: "custom", message: "Foundation repeats route junctions" });
    if (
      new Set(value.lotSubdivisions.map((entry) => entry.policy.policyId)).size !==
      value.lotSubdivisions.length
    )
      context.addIssue({ code: "custom", message: "Foundation repeats lot artifacts" });
  });
export type CompiledWorldFoundation = z.output<typeof COMPILED_WORLD_FOUNDATION_SCHEMA>;

export function sealCompiledWorldFoundation(compiled: CompiledWorldPlan): CompiledWorldFoundation {
  const baseTerrainFields = compiled.plan.terrainPlans.map(sealBaseTerrainFieldArtifact);
  const routeResult = resolveRouteConstructions(compiled.plan, baseTerrainFields);
  const terrainFields = baseTerrainFields.map((field) =>
    sealTerrainFieldArtifact(field, routeResult.routes, routeResult.junctions),
  );
  const diagnostics = [
    ...routeResult.routes.flatMap((route) => route.diagnostics),
    ...verifyTerrainConstruction(
      terrainFields,
      baseTerrainFields,
      routeResult.routes,
      routeResult.junctions,
    ),
  ];
  const status = routeResult.routes.some((route) => route.status === "rejected")
    ? "rejected"
    : routeResult.routes.some((route) => route.status === "incomplete") || diagnostics.length > 0
      ? "incomplete"
      : "eligible";
  return sealCompiledWorldFoundationArtifacts({
    status,
    foundationInputHash: compiled.foundationInputHash,
    boundsMeters: compiled.plan.boundsMeters,
    baseTerrainFields,
    terrainFields,
    routeConstructions: [...routeResult.routes],
    routeJunctions: [...routeResult.junctions],
    lotSubdivisions: [...compiled.lotSubdivisions],
    placementSurfaces: [...compiled.plan.placementSurfaces],
    diagnostics,
  });
}

export function sealCompiledWorldFoundationArtifacts(
  input: Omit<CompiledWorldFoundation, "kind" | "foundationHash">,
): CompiledWorldFoundation {
  const material = {
    kind: "CompiledWorldFoundation" as const,
    ...input,
    baseTerrainFields: [...input.baseTerrainFields].sort((left, right) =>
      compareCanonicalStrings(left.terrainPlanId, right.terrainPlanId),
    ),
    terrainFields: [...input.terrainFields].sort((left, right) =>
      compareCanonicalStrings(left.terrainPlanId, right.terrainPlanId),
    ),
    routeConstructions: [...input.routeConstructions].sort((left, right) =>
      compareCanonicalStrings(left.routeId, right.routeId),
    ),
    routeJunctions: [...input.routeJunctions].sort((left, right) =>
      compareCanonicalStrings(left.junctionId, right.junctionId),
    ),
    lotSubdivisions: [...input.lotSubdivisions].sort((left, right) =>
      compareCanonicalStrings(left.policy.policyId, right.policy.policyId),
    ),
    placementSurfaces: [...input.placementSurfaces].sort((left, right) =>
      compareCanonicalStrings(left.surfaceId, right.surfaceId),
    ),
    diagnostics: [...new Set(input.diagnostics)].sort(compareCanonicalStrings),
  };
  return deepFreezeJson(
    COMPILED_WORLD_FOUNDATION_SCHEMA.parse({
      ...material,
      foundationHash: contentHash(stableJson(material)),
    }),
  );
}

export const CONSTRUCTED_SURFACE_SCHEMA = PLACEMENT_SURFACE_SCHEMA.extend({
  floorIndex: z.number().int().nonnegative().max(255),
  assemblyHash: HASH_SCHEMA,
  sourceComponentInstanceId: WORLD_ENTITY_ID_SCHEMA,
  hash: HASH_SCHEMA,
})
  .strict()
  .superRefine((value, context) => verifyHash(value, "hash", context));
export const PORTAL_ARTIFACT_SCHEMA = z
  .object({
    portalId: WORLD_ENTITY_ID_SCHEMA,
    floorIndex: z.number().int().nonnegative().max(255),
    regionId: WORLD_ENTITY_ID_SCHEMA,
    assemblyHash: HASH_SCHEMA,
    opening: endpoint,
    openingPoseMeters: z
      .object({
        position: SPATIAL_VECTOR3_SCHEMA,
        normal: SPATIAL_VECTOR3_SCHEMA,
        up: SPATIAL_VECTOR3_SCHEMA,
      })
      .strict(),
    adjacentRoomIds: z.array(WORLD_ENTITY_ID_SCHEMA).min(1).max(2),
    widthMeters: z.number().finite().positive(),
    heightMeters: z.number().finite().positive(),
    clearanceMeters: z.number().finite().nonnegative(),
    evidenceHashes: z.array(HASH_SCHEMA).min(1).max(128),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => verifyHash(value, "hash", context));
export const PROCEDURAL_STAIR_ARTIFACT_SCHEMA = z
  .object({
    kind: z.literal("ProceduralStairArtifact"),
    stairId: WORLD_ENTITY_ID_SCHEMA,
    generatorId: WORLD_ENTITY_ID_SCHEMA,
    regionId: WORLD_ENTITY_ID_SCHEMA,
    assemblyHash: HASH_SCHEMA,
    structuralProgramHash: HASH_SCHEMA,
    fromFloor: z.number().int().nonnegative(),
    toFloor: z.number().int().positive(),
    widthMeters: z.number().finite().positive(),
    treadDepthMeters: z.number().finite().positive(),
    maximumRiserHeightMeters: z.number().finite().positive(),
    stepBoundsMeters: z.array(SPATIAL_AABB_SCHEMA).min(1).max(65_536),
    generatorEvidenceHash: HASH_SCHEMA,
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => verifyHash(value, "hash", context));
export const ASSEMBLY_ARTIFACT_SCHEMA = z
  .object({
    assemblyId: WORLD_ENTITY_ID_SCHEMA,
    regionId: WORLD_ENTITY_ID_SCHEMA,
    kitEntryHash: HASH_SCHEMA,
    lotHash: HASH_SCHEMA,
    structuralProgramHash: HASH_SCHEMA,
    constraintModelHash: HASH_SCHEMA,
    constraintSolutionHash: HASH_SCHEMA,
    componentInstanceIds: z.array(WORLD_ENTITY_ID_SCHEMA).min(1),
    connections: z.array(assemblyConnection).max(262_144),
    constructedSurfaceIds: z.array(WORLD_ENTITY_ID_SCHEMA),
    portalIds: z.array(WORLD_ENTITY_ID_SCHEMA),
    proceduralStairIds: z.array(WORLD_ENTITY_ID_SCHEMA),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => verifyHash(value, "hash", context));
export const ROOM_ARTIFACT_SCHEMA = z
  .object({
    roomId: WORLD_ENTITY_ID_SCHEMA,
    floorIndex: z.number().int().nonnegative().max(255),
    regionId: WORLD_ENTITY_ID_SCHEMA,
    semanticDependencyClosureHash: HASH_SCHEMA,
    assemblyHash: HASH_SCHEMA,
    surfaceIds: z.array(WORLD_ENTITY_ID_SCHEMA).min(1),
    portalIds: z.array(WORLD_ENTITY_ID_SCHEMA),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => verifyHash(value, "hash", context));
export type ConstructedSurface = z.output<typeof CONSTRUCTED_SURFACE_SCHEMA>;
export type PortalArtifact = z.output<typeof PORTAL_ARTIFACT_SCHEMA>;
export type ProceduralStairArtifact = z.output<typeof PROCEDURAL_STAIR_ARTIFACT_SCHEMA>;
export type AssemblyArtifact = z.output<typeof ASSEMBLY_ARTIFACT_SCHEMA>;
export type RoomArtifact = z.output<typeof ROOM_ARTIFACT_SCHEMA>;

const constructedGeometry = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("box"),
      centerMeters: SPATIAL_VECTOR3_SCHEMA,
      sizeMeters: SPATIAL_VECTOR3_SCHEMA.refine(
        (value) => value.x > 0 && value.y > 0 && value.z > 0,
        "Constructed boxes require positive dimensions",
      ),
    })
    .strict(),
  z
    .object({
      kind: z.literal("cylinder"),
      centerMeters: SPATIAL_VECTOR3_SCHEMA,
      radiusMeters: z.number().finite().positive(),
      heightMeters: z.number().finite().positive(),
      sides: z.number().int().min(8).max(128),
    })
    .strict(),
]);

export const CONSTRUCTED_ELEMENT_SCHEMA = z
  .object({
    kind: z.literal("ConstructedElement"),
    elementId: WORLD_ENTITY_ID_SCHEMA,
    constructionProgramHash: HASH_SCHEMA,
    operationId: WORLD_ENTITY_ID_SCHEMA,
    repetitionIndex: z.number().int().nonnegative().max(65_535).optional(),
    elementRole: z.enum(["opening_panel", "solid", "stair_step"]),
    geometry: constructedGeometry,
    boundsMeters: SPATIAL_AABB_SCHEMA,
    appearance: z
      .object({
        materialId: WORLD_ENTITY_ID_SCHEMA,
        baseColorSrgb: z
          .object({
            red: z.number().int().min(0).max(255),
            green: z.number().int().min(0).max(255),
            blue: z.number().int().min(0).max(255),
          })
          .strict(),
      })
      .strict(),
    styleProfileHash: HASH_SCHEMA,
    evidenceHashes: z.array(HASH_SCHEMA).min(1).max(64),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => verifyHash(value, "hash", context));

export const DECLARATIVE_CONSTRUCTED_SURFACE_SCHEMA = z
  .object({
    surfaceId: WORLD_ENTITY_ID_SCHEMA,
    constructionProgramHash: HASH_SCHEMA,
    sourceElementId: WORLD_ENTITY_ID_SCHEMA,
    face: z.enum([
      "negative_x",
      "negative_y",
      "negative_z",
      "positive_x",
      "positive_y",
      "positive_z",
    ]),
    boundsMeters: SPATIAL_AABB_SCHEMA,
    normal: SPATIAL_VECTOR3_SCHEMA,
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => verifyHash(value, "hash", context));

export const CONSTRUCTED_OPENING_ARTIFACT_SCHEMA = z
  .object({
    openingId: WORLD_ENTITY_ID_SCHEMA,
    constructionProgramHash: HASH_SCHEMA,
    operationId: WORLD_ENTITY_ID_SCHEMA,
    hostOperationId: WORLD_ENTITY_ID_SCHEMA,
    panelElementIds: z.array(WORLD_ENTITY_ID_SCHEMA).min(2).max(4),
    boundsMeters: SPATIAL_AABB_SCHEMA,
    clearanceBoundsMeters: SPATIAL_AABB_SCHEMA,
    portalId: WORLD_ENTITY_ID_SCHEMA.optional(),
    clearanceMeters: z.number().finite().nonnegative(),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => verifyHash(value, "hash", context));

export const CONSTRUCTED_PORTAL_ARTIFACT_SCHEMA = z
  .object({
    portalId: WORLD_ENTITY_ID_SCHEMA,
    constructionProgramHash: HASH_SCHEMA,
    openingHash: HASH_SCHEMA,
    boundsMeters: SPATIAL_AABB_SCHEMA,
    clearanceMeters: z.number().finite().nonnegative(),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => verifyHash(value, "hash", context));

export const CONSTRUCTED_ATTACHMENT_ARTIFACT_SCHEMA = z
  .object({
    attachmentId: WORLD_ENTITY_ID_SCHEMA,
    constructionProgramHash: HASH_SCHEMA,
    operationId: WORLD_ENTITY_ID_SCHEMA,
    hostElementId: WORLD_ENTITY_ID_SCHEMA,
    childElementId: WORLD_ENTITY_ID_SCHEMA,
    hostFace: z.enum([
      "negative_x",
      "negative_y",
      "negative_z",
      "positive_x",
      "positive_y",
      "positive_z",
    ]),
    childFace: z.enum([
      "negative_x",
      "negative_y",
      "negative_z",
      "positive_x",
      "positive_y",
      "positive_z",
    ]),
    measuredGapMeters: z.number().finite().nonnegative(),
    maximumGapMeters: z.number().finite().nonnegative(),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => verifyHash(value, "hash", context));

export const CONSTRUCTED_ACCESS_PATH_SCHEMA = z
  .object({
    accessPathId: WORLD_ENTITY_ID_SCHEMA,
    constructionProgramHash: HASH_SCHEMA,
    stairOperationId: WORLD_ENTITY_ID_SCHEMA,
    entryRouteId: WORLD_ENTITY_ID_SCHEMA,
    landingElementId: WORLD_ENTITY_ID_SCHEMA,
    stepElementIds: z.array(WORLD_ENTITY_ID_SCHEMA).min(1).max(65_536),
    entryMeters: SPATIAL_VECTOR3_SCHEMA,
    exitMeters: SPATIAL_VECTOR3_SCHEMA,
    widthMeters: z.number().finite().positive(),
    riserHeightMeters: z.number().finite().positive(),
    treadDepthMeters: z.number().finite().positive(),
    minimumHeadroomMeters: z.number().finite().positive(),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyHash(value, "hash", context);
    if (new Set(value.stepElementIds).size !== value.stepElementIds.length)
      context.addIssue({ code: "custom", message: "Access path steps must be unique" });
  });

export const CONSTRUCTED_STRUCTURE_ARTIFACT_SCHEMA = z
  .object({
    kind: z.literal("ConstructedStructureArtifact"),
    structureId: WORLD_ENTITY_ID_SCHEMA,
    regionId: WORLD_ENTITY_ID_SCHEMA,
    constructionProgramHash: HASH_SCHEMA,
    semanticDependencyClosureHash: HASH_SCHEMA,
    resolvedAnchorMeters: SPATIAL_VECTOR3_SCHEMA,
    placementEvidenceHash: HASH_SCHEMA,
    placementSurfaceId: WORLD_ENTITY_ID_SCHEMA.optional(),
    elements: z.array(CONSTRUCTED_ELEMENT_SCHEMA).min(1).max(65_536),
    surfaces: z.array(DECLARATIVE_CONSTRUCTED_SURFACE_SCHEMA).max(393_216),
    openings: z.array(CONSTRUCTED_OPENING_ARTIFACT_SCHEMA).max(8_192),
    portals: z.array(CONSTRUCTED_PORTAL_ARTIFACT_SCHEMA).max(8_192),
    attachments: z.array(CONSTRUCTED_ATTACHMENT_ARTIFACT_SCHEMA).max(8_192),
    accessPaths: z.array(CONSTRUCTED_ACCESS_PATH_SCHEMA).max(8_192),
    occupancyReservations: z.array(OCCUPANCY_RESERVATION_SCHEMA).min(1).max(65_536),
    boundsMeters: SPATIAL_AABB_SCHEMA,
    evidenceHashes: z.array(HASH_SCHEMA).min(1).max(65_536),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyHash(value, "hash", context);
    validateConstructedStructure(value, context);
  });
export type ConstructedElement = z.output<typeof CONSTRUCTED_ELEMENT_SCHEMA>;
export type DeclarativeConstructedSurface = z.output<typeof DECLARATIVE_CONSTRUCTED_SURFACE_SCHEMA>;
export type ConstructedOpeningArtifact = z.output<typeof CONSTRUCTED_OPENING_ARTIFACT_SCHEMA>;
export type ConstructedPortalArtifact = z.output<typeof CONSTRUCTED_PORTAL_ARTIFACT_SCHEMA>;
export type ConstructedAttachmentArtifact = z.output<typeof CONSTRUCTED_ATTACHMENT_ARTIFACT_SCHEMA>;
export type ConstructedAccessPath = z.output<typeof CONSTRUCTED_ACCESS_PATH_SCHEMA>;
export type ConstructedStructureArtifact = z.output<typeof CONSTRUCTED_STRUCTURE_ARTIFACT_SCHEMA>;

export const MESO_LAYOUT_SCHEMA = z
  .object({
    kind: z.literal("MesoLayout"),
    status: COMPILATION_STATUS_SCHEMA,
    foundationHash: HASH_SCHEMA,
    catalogResolutionHash: HASH_SCHEMA,
    instances: z.array(REALIZED_INSTANCE_SCHEMA).max(1_000_000),
    assemblies: z.array(ASSEMBLY_ARTIFACT_SCHEMA).max(65_536),
    constructedStructures: z.array(CONSTRUCTED_STRUCTURE_ARTIFACT_SCHEMA).max(65_536),
    constructedSurfaces: z.array(CONSTRUCTED_SURFACE_SCHEMA).max(65_536),
    portals: z.array(PORTAL_ARTIFACT_SCHEMA).max(65_536),
    rooms: z.array(ROOM_ARTIFACT_SCHEMA).max(65_536),
    proceduralStairs: z.array(PROCEDURAL_STAIR_ARTIFACT_SCHEMA).max(65_536),
    diagnostics: z.array(z.string().min(1).max(1024)).max(65_536),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyHash(value, "hash", context);
    validateMesoGraph(value, context);
  });
export type MesoLayout = z.output<typeof MESO_LAYOUT_SCHEMA>;
export const MICRO_REALIZATION_SCHEMA = z
  .object({
    kind: z.literal("MicroRealization"),
    status: COMPILATION_STATUS_SCHEMA,
    foundationHash: HASH_SCHEMA,
    catalogResolutionHash: HASH_SCHEMA,
    mesoLayoutHash: HASH_SCHEMA,
    instances: z.array(REALIZED_INSTANCE_SCHEMA).max(1_000_000),
    measuredOccupancy: z.array(OCCUPANCY_RESERVATION_SCHEMA).max(1_000_000).optional(),
    diagnostics: z.array(z.string().min(1).max(1024)).max(65_536),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyHash(value, "hash", context);
    const instances = new Map(value.instances.map((instance) => [instance.instanceId, instance]));
    const seen = new Set<string>();
    for (const reservation of value.measuredOccupancy ?? []) {
      const instance = instances.get(reservation.sourceInstanceId);
      if (
        !instance ||
        seen.has(reservation.sourceInstanceId) ||
        !reservation.collisionEvidenceHash ||
        !instance.evidenceHashes.includes(reservation.collisionEvidenceHash)
      )
        context.addIssue({
          code: "custom",
          path: ["measuredOccupancy"],
          message:
            "Measured occupancy must bind unique realized instances and their exact evidence",
        });
      seen.add(reservation.sourceInstanceId);
    }
  });
export type MicroRealization = z.output<typeof MICRO_REALIZATION_SCHEMA>;

export const COMPILATION_TASK_RESULT_SCHEMA = z
  .object({
    kind: z.literal("CompilationTaskResult"),
    taskId: WORLD_ENTITY_ID_SCHEMA,
    subjectId: WORLD_ENTITY_ID_SCHEMA,
    scope: z.enum([
      "world",
      "region",
      "terrain",
      "route",
      "junction",
      "lot",
      "structure",
      "floor",
      "room",
    ]),
    stage: z.enum([
      "terrain_base",
      "route_construction",
      "terrain_final",
      "foundation",
      "catalog_resolution",
      "meso",
      "micro",
      "world_build",
    ]),
    dependencyTaskIds: z.array(WORLD_ENTITY_ID_SCHEMA).max(65_536),
    inputHashes: z.array(HASH_SCHEMA).min(1),
    policyHash: HASH_SCHEMA,
    outputHashes: z.array(HASH_SCHEMA),
    status: COMPILATION_STATUS_SCHEMA,
    resourceUse: z
      .object({
        wallMilliseconds: z.number().int().nonnegative(),
        decisions: z.number().int().nonnegative(),
        backtracks: z.number().int().nonnegative(),
      })
      .strict(),
    diagnostics: z.array(z.string().min(1).max(1024)),
    taskHash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyHash(value, "taskHash", context);
    const expectedId = compilationTaskId(value.scope, value.stage, value.subjectId);
    if (value.taskId !== expectedId)
      context.addIssue({
        code: "custom",
        path: ["taskId"],
        message: "Compilation task ID mismatch",
      });
    if (
      new Set(value.dependencyTaskIds).size !== value.dependencyTaskIds.length ||
      stableJson([...value.dependencyTaskIds].sort(compareCanonicalStrings)) !==
        stableJson(value.dependencyTaskIds)
    )
      context.addIssue({
        code: "custom",
        path: ["dependencyTaskIds"],
        message: "Task dependencies must be unique and canonical",
      });
    if (value.dependencyTaskIds.includes(value.taskId))
      context.addIssue({
        code: "custom",
        path: ["dependencyTaskIds"],
        message: "A task cannot depend on itself",
      });
  });
export type CompilationTaskResult = z.output<typeof COMPILATION_TASK_RESULT_SCHEMA>;

export function sealCompilationTaskResult(
  input: Omit<CompilationTaskResult, "kind" | "taskId" | "taskHash">,
): CompilationTaskResult {
  const canonical = {
    ...input,
    dependencyTaskIds: [...new Set(input.dependencyTaskIds)].sort(compareCanonicalStrings),
    inputHashes: [...new Set(input.inputHashes)].sort(compareCanonicalStrings),
    outputHashes: [...new Set(input.outputHashes)].sort(compareCanonicalStrings),
    diagnostics: [...input.diagnostics].sort(compareCanonicalStrings),
  };
  const taskId = compilationTaskId(canonical.scope, canonical.stage, canonical.subjectId);
  const material = { kind: "CompilationTaskResult" as const, taskId, ...canonical };
  return deepFreezeJson(
    COMPILATION_TASK_RESULT_SCHEMA.parse({
      ...material,
      taskHash: contentHash(stableJson(material)),
    }),
  );
}

/** Stable logical identity; taskHash records the exact execution result. */
export function compilationTaskId(
  scope: CompilationTaskResult["scope"],
  stage: CompilationTaskResult["stage"],
  subjectId: string,
): string {
  return contentAddressedEntityId("Task", { scope, stage, subjectId });
}

export const WORLD_BUILD_SCHEMA = z
  .object({
    kind: z.literal("WorldBuild"),
    coordinateSystem: z.literal("right_handed_y_up_meters"),
    status: COMPILATION_STATUS_SCHEMA,
    semanticKernelHash: HASH_SCHEMA,
    semanticClosureHashes: z.array(HASH_SCHEMA).max(100_000),
    catalogSnapshotHash: HASH_SCHEMA,
    visualEnvironment: WORLD_VISUAL_ENVIRONMENT_SCHEMA,
    foundation: COMPILED_WORLD_FOUNDATION_SCHEMA,
    catalogResolution: CATALOG_RESOLUTION_PLAN_SCHEMA,
    meso: MESO_LAYOUT_SCHEMA,
    micro: MICRO_REALIZATION_SCHEMA,
    tasks: z.array(COMPILATION_TASK_RESULT_SCHEMA).max(1_000_000),
    instances: z.array(REALIZED_INSTANCE_SCHEMA).max(1_000_000),
    diagnostics: z.array(z.string().min(1).max(1024)).max(100_000),
    worldBuildHash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyHash(value, "worldBuildHash", context);
    validateWorldBuildGraph(value, context);
  });
export type WorldBuild = z.output<typeof WORLD_BUILD_SCHEMA>;

/** Include foundation failures even when no realization-level diagnostic exists. */
export function worldBuildDiagnostics(world: WorldBuild): string[] {
  return [
    ...new Set([
      ...world.diagnostics,
      ...world.foundation.diagnostics,
      ...world.catalogResolution.diagnostics,
      ...world.meso.diagnostics,
      ...world.micro.diagnostics,
      ...world.tasks.flatMap((task) => task.diagnostics),
    ]),
  ].sort(compareCanonicalStrings);
}

export function sealMesoLayout(input: Omit<MesoLayout, "kind" | "hash">): MesoLayout {
  const material = {
    kind: "MesoLayout" as const,
    ...input,
    instances: canonicalInstances(input.instances),
    assemblies: [...input.assemblies].sort((a, b) =>
      compareCanonicalStrings(a.assemblyId, b.assemblyId),
    ),
    constructedStructures: [...input.constructedStructures].sort((a, b) =>
      compareCanonicalStrings(a.structureId, b.structureId),
    ),
    constructedSurfaces: [...input.constructedSurfaces].sort((a, b) =>
      compareCanonicalStrings(a.surfaceId, b.surfaceId),
    ),
    portals: [...input.portals].sort((a, b) => compareCanonicalStrings(a.portalId, b.portalId)),
    rooms: [...input.rooms].sort((a, b) => compareCanonicalStrings(a.roomId, b.roomId)),
    proceduralStairs: [...input.proceduralStairs].sort((a, b) =>
      compareCanonicalStrings(a.stairId, b.stairId),
    ),
    diagnostics: [...input.diagnostics].sort(compareCanonicalStrings),
  };
  return deepFreezeJson(
    MESO_LAYOUT_SCHEMA.parse({ ...material, hash: contentHash(stableJson(material)) }),
  );
}
export function sealMicroRealization(
  input: Omit<MicroRealization, "kind" | "hash">,
): MicroRealization {
  const material = {
    kind: "MicroRealization" as const,
    ...input,
    instances: canonicalInstances(input.instances),
    ...(input.measuredOccupancy
      ? {
          measuredOccupancy: [...input.measuredOccupancy].sort((a, b) =>
            compareCanonicalStrings(a.id, b.id),
          ),
        }
      : {}),
    diagnostics: [...input.diagnostics].sort(compareCanonicalStrings),
  };
  return deepFreezeJson(
    MICRO_REALIZATION_SCHEMA.parse({ ...material, hash: contentHash(stableJson(material)) }),
  );
}
export function sealAssemblyArtifact(
  input: Omit<AssemblyArtifact, "assemblyId" | "hash">,
): AssemblyArtifact {
  const canonical = {
    ...input,
    componentInstanceIds: [...input.componentInstanceIds].sort(compareCanonicalStrings),
    connections: [...input.connections].sort((a, b) =>
      compareCanonicalStrings(a.connectionId, b.connectionId),
    ),
    constructedSurfaceIds: [...input.constructedSurfaceIds].sort(compareCanonicalStrings),
    portalIds: [...input.portalIds].sort(compareCanonicalStrings),
    proceduralStairIds: [...input.proceduralStairIds].sort(compareCanonicalStrings),
  };
  const assemblyId = contentAddressedEntityId("Assembly", canonical);
  const material = { assemblyId, ...canonical };
  return deepFreezeJson(
    ASSEMBLY_ARTIFACT_SCHEMA.parse({ ...material, hash: contentHash(stableJson(material)) }),
  );
}
export function sealConstructedSurface(
  input: Omit<ConstructedSurface, "hash">,
): ConstructedSurface {
  return deepFreezeJson(
    CONSTRUCTED_SURFACE_SCHEMA.parse({ ...input, hash: contentHash(stableJson(input)) }),
  );
}
export function sealPortalArtifact(input: Omit<PortalArtifact, "hash">): PortalArtifact {
  const canonical = {
    ...input,
    adjacentRoomIds: [...input.adjacentRoomIds].sort(compareCanonicalStrings),
    evidenceHashes: [...new Set(input.evidenceHashes)].sort(compareCanonicalStrings),
  };
  return deepFreezeJson(
    PORTAL_ARTIFACT_SCHEMA.parse({ ...canonical, hash: contentHash(stableJson(canonical)) }),
  );
}
export function sealRoomArtifact(input: Omit<RoomArtifact, "hash">): RoomArtifact {
  const canonical = {
    ...input,
    surfaceIds: [...input.surfaceIds].sort(compareCanonicalStrings),
    portalIds: [...input.portalIds].sort(compareCanonicalStrings),
  };
  return deepFreezeJson(
    ROOM_ARTIFACT_SCHEMA.parse({ ...canonical, hash: contentHash(stableJson(canonical)) }),
  );
}
export function sealProceduralStairArtifact(
  input: Omit<ProceduralStairArtifact, "kind" | "hash">,
): ProceduralStairArtifact {
  const material = { kind: "ProceduralStairArtifact" as const, ...input };
  return deepFreezeJson(
    PROCEDURAL_STAIR_ARTIFACT_SCHEMA.parse({
      ...material,
      hash: contentHash(stableJson(material)),
    }),
  );
}

export function sealConstructedElement(
  input: Omit<ConstructedElement, "kind" | "elementId" | "hash">,
): ConstructedElement {
  const canonical = {
    ...input,
    evidenceHashes: [...new Set(input.evidenceHashes)].sort(compareCanonicalStrings),
  };
  const elementId = contentAddressedEntityId("ConstructedElement", canonical);
  const material = { kind: "ConstructedElement" as const, elementId, ...canonical };
  return deepFreezeJson(
    CONSTRUCTED_ELEMENT_SCHEMA.parse({ ...material, hash: contentHash(stableJson(material)) }),
  );
}

export function sealDeclarativeConstructedSurface(
  input: Omit<DeclarativeConstructedSurface, "surfaceId" | "hash">,
): DeclarativeConstructedSurface {
  const surfaceId = contentAddressedEntityId("ConstructedSurface", input);
  const material = { surfaceId, ...input };
  return deepFreezeJson(
    DECLARATIVE_CONSTRUCTED_SURFACE_SCHEMA.parse({
      ...material,
      hash: contentHash(stableJson(material)),
    }),
  );
}

export function sealConstructedOpeningArtifact(
  input: Omit<ConstructedOpeningArtifact, "openingId" | "hash">,
): ConstructedOpeningArtifact {
  const canonical = {
    ...input,
    panelElementIds: [...input.panelElementIds].sort(compareCanonicalStrings),
  };
  const openingId = contentAddressedEntityId("ConstructedOpening", canonical);
  const material = { openingId, ...canonical };
  return deepFreezeJson(
    CONSTRUCTED_OPENING_ARTIFACT_SCHEMA.parse({
      ...material,
      hash: contentHash(stableJson(material)),
    }),
  );
}

export function sealConstructedPortalArtifact(
  input: Omit<ConstructedPortalArtifact, "hash">,
): ConstructedPortalArtifact {
  return deepFreezeJson(
    CONSTRUCTED_PORTAL_ARTIFACT_SCHEMA.parse({
      ...input,
      hash: contentHash(stableJson(input)),
    }),
  );
}

export function sealConstructedAttachmentArtifact(
  input: Omit<ConstructedAttachmentArtifact, "attachmentId" | "hash">,
): ConstructedAttachmentArtifact {
  const attachmentId = contentAddressedEntityId("ConstructedAttachment", input);
  const material = { attachmentId, ...input };
  return deepFreezeJson(
    CONSTRUCTED_ATTACHMENT_ARTIFACT_SCHEMA.parse({
      ...material,
      hash: contentHash(stableJson(material)),
    }),
  );
}

export function sealConstructedAccessPath(
  input: Omit<ConstructedAccessPath, "accessPathId" | "hash">,
): ConstructedAccessPath {
  const canonical = { ...input, stepElementIds: [...input.stepElementIds] };
  const accessPathId = contentAddressedEntityId("AccessPath", canonical);
  const material = { accessPathId, ...canonical };
  return deepFreezeJson(
    CONSTRUCTED_ACCESS_PATH_SCHEMA.parse({
      ...material,
      hash: contentHash(stableJson(material)),
    }),
  );
}

export function sealConstructedStructureArtifact(
  input: Omit<ConstructedStructureArtifact, "kind" | "structureId" | "hash">,
): ConstructedStructureArtifact {
  const canonical = {
    ...input,
    elements: [...input.elements].sort((left, right) =>
      compareCanonicalStrings(left.elementId, right.elementId),
    ),
    surfaces: [...input.surfaces].sort((left, right) =>
      compareCanonicalStrings(left.surfaceId, right.surfaceId),
    ),
    openings: [...input.openings].sort((left, right) =>
      compareCanonicalStrings(left.openingId, right.openingId),
    ),
    portals: [...input.portals].sort((left, right) =>
      compareCanonicalStrings(left.portalId, right.portalId),
    ),
    attachments: [...input.attachments].sort((left, right) =>
      compareCanonicalStrings(left.attachmentId, right.attachmentId),
    ),
    accessPaths: [...input.accessPaths].sort((left, right) =>
      compareCanonicalStrings(left.accessPathId, right.accessPathId),
    ),
    occupancyReservations: [...input.occupancyReservations].sort((left, right) =>
      compareCanonicalStrings(left.id, right.id),
    ),
    evidenceHashes: [...new Set(input.evidenceHashes)].sort(compareCanonicalStrings),
  };
  const structureId = contentAddressedEntityId("ConstructedStructure", canonical);
  const material = { kind: "ConstructedStructureArtifact" as const, structureId, ...canonical };
  return deepFreezeJson(
    CONSTRUCTED_STRUCTURE_ARTIFACT_SCHEMA.parse({
      ...material,
      hash: contentHash(stableJson(material)),
    }),
  );
}
export function sealWorldBuild(
  input: Omit<WorldBuild, "kind" | "coordinateSystem" | "instances" | "worldBuildHash">,
): WorldBuild {
  const instances = canonicalInstances([...input.meso.instances, ...input.micro.instances]);
  const material = {
    kind: "WorldBuild" as const,
    coordinateSystem: "right_handed_y_up_meters" as const,
    ...input,
    semanticClosureHashes: [...new Set(input.semanticClosureHashes)].sort(compareCanonicalStrings),
    tasks: [...input.tasks].sort((a, b) => compareCanonicalStrings(a.taskId, b.taskId)),
    instances,
    diagnostics: [...input.diagnostics].sort(compareCanonicalStrings),
  };
  return deepFreezeJson(
    WORLD_BUILD_SCHEMA.parse({ ...material, worldBuildHash: contentHash(stableJson(material)) }),
  );
}

function canonicalInstances(instances: readonly RealizedInstance[]): RealizedInstance[] {
  return [...instances].sort((a, b) => compareCanonicalStrings(a.instanceId, b.instanceId));
}
function validateMesoGraph(value: MesoLayout, context: z.RefinementCtx): void {
  const instanceIds = new Set(value.instances.map((entry) => entry.instanceId));
  const assemblyByHash = new Map(value.assemblies.map((entry) => [entry.hash, entry]));
  const assemblyById = new Map(value.assemblies.map((entry) => [entry.assemblyId, entry]));
  const structureById = new Map(
    value.constructedStructures.map((entry) => [entry.structureId, entry]),
  );
  const surfaces = new Map(value.constructedSurfaces.map((entry) => [entry.surfaceId, entry]));
  const portals = new Map(value.portals.map((entry) => [entry.portalId, entry]));
  const rooms = new Map(value.rooms.map((entry) => [entry.roomId, entry]));
  const stairs = new Map(value.proceduralStairs.map((entry) => [entry.stairId, entry]));
  const sizes = [
    ["instance", instanceIds.size, value.instances.length],
    ["assembly hash", assemblyByHash.size, value.assemblies.length],
    ["assembly ID", assemblyById.size, value.assemblies.length],
    ["constructed structure", structureById.size, value.constructedStructures.length],
    ["surface", surfaces.size, value.constructedSurfaces.length],
    ["portal", portals.size, value.portals.length],
    ["room", rooms.size, value.rooms.length],
    ["stair", stairs.size, value.proceduralStairs.length],
  ] as const;
  for (const [label, actual, expected] of sizes)
    if (actual !== expected)
      context.addIssue({ code: "custom", message: `Meso layout repeats ${label} identities` });
  for (const assembly of value.assemblies) {
    if (assembly.componentInstanceIds.some((id) => !instanceIds.has(id)))
      context.addIssue({
        code: "custom",
        message: `Assembly ${assembly.assemblyId} references an unknown component`,
      });
    if (
      assembly.constructedSurfaceIds.some((id) => surfaces.get(id)?.assemblyHash !== assembly.hash)
    )
      context.addIssue({
        code: "custom",
        message: `Assembly ${assembly.assemblyId} has an invalid constructed surface`,
      });
    if (assembly.portalIds.some((id) => portals.get(id)?.assemblyHash !== assembly.hash))
      context.addIssue({
        code: "custom",
        message: `Assembly ${assembly.assemblyId} has an invalid portal`,
      });
    if (assembly.proceduralStairIds.some((id) => stairs.get(id)?.assemblyHash !== assembly.hash))
      context.addIssue({
        code: "custom",
        message: `Assembly ${assembly.assemblyId} has an invalid procedural stair`,
      });
    if (
      assembly.connections.some(
        (connection) =>
          !instanceIds.has(connection.host.instanceId) ||
          !instanceIds.has(connection.child.instanceId),
      )
    )
      context.addIssue({
        code: "custom",
        message: `Assembly ${assembly.assemblyId} has an invalid connection endpoint`,
      });
  }
  for (const surface of value.constructedSurfaces)
    if (
      !assemblyByHash.has(surface.assemblyHash) ||
      !instanceIds.has(surface.sourceComponentInstanceId)
    )
      context.addIssue({
        code: "custom",
        message: `Constructed surface ${surface.surfaceId} has invalid provenance`,
      });
  for (const portal of value.portals)
    if (
      !assemblyByHash.has(portal.assemblyHash) ||
      !instanceIds.has(portal.opening.instanceId) ||
      portal.adjacentRoomIds.some((id) => !rooms.has(id))
    )
      context.addIssue({
        code: "custom",
        message: `Portal ${portal.portalId} has invalid provenance or adjacency`,
      });
    else if (portal.adjacentRoomIds.some((id) => rooms.get(id)?.floorIndex !== portal.floorIndex))
      context.addIssue({
        code: "custom",
        message: `Portal ${portal.portalId} crosses an undeclared floor boundary`,
      });
  for (const room of value.rooms)
    if (
      !assemblyByHash.has(room.assemblyHash) ||
      room.surfaceIds.some((id) => !surfaces.has(id)) ||
      room.portalIds.some((id) => !portals.has(id))
    )
      context.addIssue({
        code: "custom",
        message: `Room ${room.roomId} has invalid assembly boundaries`,
      });
    else if (
      room.surfaceIds.some((id) => surfaces.get(id)?.floorIndex !== room.floorIndex) ||
      room.portalIds.some((id) => portals.get(id)?.floorIndex !== room.floorIndex)
    )
      context.addIssue({
        code: "custom",
        message: `Room ${room.roomId} references boundaries span multiple floors`,
      });
}

function validateConstructedStructure(
  value: ConstructedStructureArtifact,
  context: z.RefinementCtx,
): void {
  const elements = new Map(value.elements.map((entry) => [entry.elementId, entry] as const));
  const surfaces = new Map(value.surfaces.map((entry) => [entry.surfaceId, entry] as const));
  const openings = new Map(value.openings.map((entry) => [entry.openingId, entry] as const));
  const reservations = new Map(
    value.occupancyReservations.map((entry) => [entry.sourceInstanceId, entry] as const),
  );
  const accessPaths = new Map(
    value.accessPaths.map((entry) => [entry.accessPathId, entry] as const),
  );
  for (const [label, actual, expected] of [
    ["element", elements.size, value.elements.length],
    ["surface", surfaces.size, value.surfaces.length],
    ["opening", openings.size, value.openings.length],
    ["access path", accessPaths.size, value.accessPaths.length],
    ["occupancy reservation", reservations.size, value.occupancyReservations.length],
  ] as const)
    if (actual !== expected)
      context.addIssue({
        code: "custom",
        message: `Constructed structure repeats ${label} identity`,
      });
  if (
    value.elements.some((entry) => entry.constructionProgramHash !== value.constructionProgramHash)
  )
    context.addIssue({ code: "custom", message: "Constructed element binds another program" });
  if (
    value.surfaces.some(
      (entry) =>
        entry.constructionProgramHash !== value.constructionProgramHash ||
        !elements.has(entry.sourceElementId),
    )
  )
    context.addIssue({ code: "custom", message: "Constructed surface has invalid provenance" });
  if (
    value.openings.some(
      (entry) =>
        entry.constructionProgramHash !== value.constructionProgramHash ||
        entry.panelElementIds.some((id) => !elements.has(id)),
    )
  )
    context.addIssue({ code: "custom", message: "Constructed opening has invalid panels" });
  if (
    value.portals.some(
      (entry) =>
        entry.constructionProgramHash !== value.constructionProgramHash ||
        ![...openings.values()].some((opening) => opening.hash === entry.openingHash),
    )
  )
    context.addIssue({
      code: "custom",
      message: "Constructed portal has invalid opening provenance",
    });
  if (
    value.attachments.some(
      (entry) =>
        entry.constructionProgramHash !== value.constructionProgramHash ||
        !elements.has(entry.hostElementId) ||
        !elements.has(entry.childElementId),
    )
  )
    context.addIssue({ code: "custom", message: "Constructed attachment has invalid endpoints" });
  if (
    value.accessPaths.some(
      (entry) =>
        entry.constructionProgramHash !== value.constructionProgramHash ||
        !elements.has(entry.landingElementId) ||
        entry.stepElementIds.some((id) => !elements.has(id)),
    )
  )
    context.addIssue({ code: "custom", message: "Constructed access path has invalid geometry" });
  if (
    value.elements.some((entry) => {
      const reservation = reservations.get(entry.elementId);
      return !reservation || stableJson(reservation.bounds) !== stableJson(entry.boundsMeters);
    })
  )
    context.addIssue({
      code: "custom",
      message: "Constructed occupancy does not cover each element",
    });
  const actualBounds = mergeBounds(value.elements.map((entry) => entry.boundsMeters));
  if (stableJson(actualBounds) !== stableJson(value.boundsMeters))
    context.addIssue({
      code: "custom",
      path: ["boundsMeters"],
      message: "Constructed structure bounds mismatch",
    });
}

function mergeBounds(bounds: readonly z.output<typeof SPATIAL_AABB_SCHEMA>[]) {
  if (bounds.length === 0) throw new Error("Cannot merge an empty bounds set");
  return {
    min: {
      x: Math.min(...bounds.map((entry) => entry.min.x)),
      y: Math.min(...bounds.map((entry) => entry.min.y)),
      z: Math.min(...bounds.map((entry) => entry.min.z)),
    },
    max: {
      x: Math.max(...bounds.map((entry) => entry.max.x)),
      y: Math.max(...bounds.map((entry) => entry.max.y)),
      z: Math.max(...bounds.map((entry) => entry.max.z)),
    },
  };
}

function validateWorldBuildGraph(value: WorldBuild, context: z.RefinementCtx): void {
  if (value.catalogResolution.semanticKernelHash !== value.semanticKernelHash)
    context.addIssue({
      code: "custom",
      path: ["semanticKernelHash"],
      message: "World build semantic kernel does not match catalog resolution",
    });
  if (
    value.catalogResolution.catalogSnapshotHash !== value.catalogSnapshotHash ||
    value.meso.catalogResolutionHash !== value.catalogResolution.hash ||
    value.micro.catalogResolutionHash !== value.catalogResolution.hash
  )
    context.addIssue({
      code: "custom",
      path: ["catalogSnapshotHash"],
      message: "World build catalog lineage is inconsistent",
    });
  if (
    value.meso.foundationHash !== value.foundation.foundationHash ||
    value.micro.foundationHash !== value.foundation.foundationHash
  )
    context.addIssue({
      code: "custom",
      path: ["foundation"],
      message: "World build foundation lineage is inconsistent",
    });
  if (value.micro.mesoLayoutHash !== value.meso.hash)
    context.addIssue({
      code: "custom",
      path: ["micro", "mesoLayoutHash"],
      message: "Micro realization does not bind the exact meso layout",
    });
  const exactInstances = canonicalInstances([...value.meso.instances, ...value.micro.instances]);
  if (stableJson(exactInstances) !== stableJson(value.instances))
    context.addIssue({
      code: "custom",
      path: ["instances"],
      message: "World build instances must be the exact meso and micro union",
    });
  const statuses = [
    value.foundation.status,
    value.catalogResolution.status,
    value.meso.status,
    value.micro.status,
  ];
  const expectedStatus = statuses.includes("rejected")
    ? "rejected"
    : statuses.includes("incomplete")
      ? "incomplete"
      : "eligible";
  if (value.status !== expectedStatus)
    context.addIssue({
      code: "custom",
      path: ["status"],
      message: "World build status does not reflect its compilation gates",
    });
  const taskById = new Map(value.tasks.map((entry) => [entry.taskId, entry] as const));
  if (taskById.size !== value.tasks.length)
    context.addIssue({
      code: "custom",
      path: ["tasks"],
      message: "World build repeats task identities",
    });
  for (const task of value.tasks)
    for (const dependencyId of task.dependencyTaskIds)
      if (!taskById.has(dependencyId))
        context.addIssue({
          code: "custom",
          path: ["tasks"],
          message: `Task ${task.taskId} has an unknown dependency`,
        });
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (taskId: string): void => {
    if (visited.has(taskId)) return;
    if (visiting.has(taskId)) {
      context.addIssue({
        code: "custom",
        path: ["tasks"],
        message: "Compilation task dependencies contain a cycle",
      });
      return;
    }
    visiting.add(taskId);
    for (const dependency of taskById.get(taskId)?.dependencyTaskIds ?? []) visit(dependency);
    visiting.delete(taskId);
    visited.add(taskId);
  };
  for (const taskId of taskById.keys()) visit(taskId);
}

function verifyHash(value: Record<string, unknown>, field: string, context: z.RefinementCtx): void {
  const material = { ...value };
  delete material[field];
  if (contentHash(stableJson(material)) !== value[field])
    context.addIssue({ code: "custom", path: [field], message: "Artifact hash mismatch" });
}
