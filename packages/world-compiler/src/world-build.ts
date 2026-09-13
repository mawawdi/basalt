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
import { SPATIAL_AABB_SCHEMA, SPATIAL_VECTOR3_SCHEMA } from "@basalt/spatial-core";
import {
  LOT_SUBDIVISION_SCHEMA,
  PLACEMENT_SURFACE_SCHEMA,
  ROAD_ASSEMBLY_SCHEMA,
  SPATIAL_WORLD_PLAN_SCHEMA,
  WORLD_ENTITY_ID_SCHEMA,
  type CompiledWorldPlan,
} from "@basalt/world-planning";

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

const terrainSample = z
  .object({
    xMeters: z.number().finite(),
    zMeters: z.number().finite(),
    elevationMeters: z.number().finite(),
    materialId: WORLD_ENTITY_ID_SCHEMA,
  })
  .strict();
export const TERRAIN_FIELD_ARTIFACT_SCHEMA = z
  .object({
    kind: z.literal("TerrainFieldArtifact"),
    terrainPlanId: WORLD_ENTITY_ID_SCHEMA,
    worldPlanHash: HASH_SCHEMA,
    surfaceId: WORLD_ENTITY_ID_SCHEMA,
    samples: z.array(terrainSample).min(4).max(4_000_000),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => verifyHash(value, "hash", context));
export type TerrainFieldArtifact = z.output<typeof TERRAIN_FIELD_ARTIFACT_SCHEMA>;

export const COMPILED_WORLD_FOUNDATION_SCHEMA = z
  .object({
    kind: z.literal("CompiledWorldFoundation"),
    status: z.literal("eligible"),
    worldPlanHash: HASH_SCHEMA,
    plan: SPATIAL_WORLD_PLAN_SCHEMA,
    terrainFields: z.array(TERRAIN_FIELD_ARTIFACT_SCHEMA).max(4096),
    roadAssemblies: z.array(ROAD_ASSEMBLY_SCHEMA).max(65_536),
    lotSubdivisions: z.array(LOT_SUBDIVISION_SCHEMA).max(4096),
    placementSurfaces: z.array(PLACEMENT_SURFACE_SCHEMA).max(65_536),
    foundationHash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyHash(value, "foundationHash", context);
    if (value.plan.planHash !== value.worldPlanHash)
      context.addIssue({
        code: "custom",
        path: ["worldPlanHash"],
        message: "Foundation must bind the untouched spatial plan hash",
      });
    const routeHashes = new Map(
      value.plan.routes.map((route) => [route.routeId, contentHash(stableJson(route))]),
    );
    for (const terrain of value.terrainFields)
      if (terrain.worldPlanHash !== value.worldPlanHash)
        context.addIssue({
          code: "custom",
          message: `Terrain ${terrain.terrainPlanId} binds a different world plan`,
        });
    for (const road of value.roadAssemblies)
      if (routeHashes.get(road.routeId) !== road.routeHash)
        context.addIssue({
          code: "custom",
          message: `Road assembly ${road.routeId} does not bind its exact route`,
        });
    for (const subdivision of value.lotSubdivisions)
      if (subdivision.planHash !== value.worldPlanHash)
        context.addIssue({
          code: "custom",
          message: `Lot subdivision ${subdivision.policy.policyId} binds a different world plan`,
        });
  });
export type CompiledWorldFoundation = z.output<typeof COMPILED_WORLD_FOUNDATION_SCHEMA>;

export function sealCompiledWorldFoundation(compiled: CompiledWorldPlan): CompiledWorldFoundation {
  const terrainFields = compiled.plan.terrainPlans.map((plan) =>
    sealTerrainField(compiled.worldPlanHash, plan),
  );
  const material = {
    kind: "CompiledWorldFoundation" as const,
    status: "eligible" as const,
    worldPlanHash: compiled.worldPlanHash,
    plan: compiled.plan,
    terrainFields,
    roadAssemblies: [...compiled.roadAssemblies],
    lotSubdivisions: [...compiled.lotSubdivisions],
    placementSurfaces: [...compiled.plan.placementSurfaces],
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

export const MESO_LAYOUT_SCHEMA = z
  .object({
    kind: z.literal("MesoLayout"),
    status: COMPILATION_STATUS_SCHEMA,
    foundationHash: HASH_SCHEMA,
    catalogResolutionHash: HASH_SCHEMA,
    instances: z.array(REALIZED_INSTANCE_SCHEMA).max(1_000_000),
    assemblies: z.array(ASSEMBLY_ARTIFACT_SCHEMA).max(65_536),
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
    diagnostics: z.array(z.string().min(1).max(1024)).max(65_536),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => verifyHash(value, "hash", context));
export type MicroRealization = z.output<typeof MICRO_REALIZATION_SCHEMA>;

export const COMPILATION_TASK_RESULT_SCHEMA = z
  .object({
    kind: z.literal("CompilationTaskResult"),
    taskId: WORLD_ENTITY_ID_SCHEMA,
    scope: z.enum(["world", "region", "route", "lot", "structure", "floor", "room"]),
    stage: z.enum(["foundation", "catalog_resolution", "meso", "micro", "world_build"]),
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
  .superRefine((value, context) => verifyHash(value, "taskHash", context));
export type CompilationTaskResult = z.output<typeof COMPILATION_TASK_RESULT_SCHEMA>;

export function sealCompilationTaskResult(
  input: Omit<CompilationTaskResult, "kind" | "taskId" | "taskHash">,
): CompilationTaskResult {
  const canonical = {
    ...input,
    inputHashes: [...new Set(input.inputHashes)].sort(compareCanonicalStrings),
    outputHashes: [...new Set(input.outputHashes)].sort(compareCanonicalStrings),
    diagnostics: [...input.diagnostics].sort(compareCanonicalStrings),
  };
  const taskId = contentAddressedEntityId("Task", {
    scope: canonical.scope,
    stage: canonical.stage,
    inputHashes: canonical.inputHashes,
    policyHash: canonical.policyHash,
  });
  const material = { kind: "CompilationTaskResult" as const, taskId, ...canonical };
  return deepFreezeJson(
    COMPILATION_TASK_RESULT_SCHEMA.parse({
      ...material,
      taskHash: contentHash(stableJson(material)),
    }),
  );
}

export const WORLD_BUILD_SCHEMA = z
  .object({
    kind: z.literal("WorldBuild"),
    coordinateSystem: z.literal("right_handed_y_up_meters"),
    status: COMPILATION_STATUS_SCHEMA,
    semanticKernelHash: HASH_SCHEMA,
    semanticClosureHashes: z.array(HASH_SCHEMA).max(100_000),
    catalogSnapshotHash: HASH_SCHEMA,
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

export function sealMesoLayout(input: Omit<MesoLayout, "kind" | "hash">): MesoLayout {
  const material = {
    kind: "MesoLayout" as const,
    ...input,
    instances: canonicalInstances(input.instances),
    assemblies: [...input.assemblies].sort((a, b) =>
      compareCanonicalStrings(a.assemblyId, b.assemblyId),
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

function sealTerrainField(
  worldPlanHash: string,
  plan: CompiledWorldPlan["plan"]["terrainPlans"][number],
): TerrainFieldArtifact {
  const samples = [];
  for (let row = 0; row < plan.resolution.rows; row += 1)
    for (let column = 0; column < plan.resolution.columns; column += 1) {
      const xMeters =
        plan.boundsMeters.x.minimum +
        (column / (plan.resolution.columns - 1)) *
          (plan.boundsMeters.x.maximum - plan.boundsMeters.x.minimum);
      const zMeters =
        plan.boundsMeters.z.minimum +
        (row / (plan.resolution.rows - 1)) *
          (plan.boundsMeters.z.maximum - plan.boundsMeters.z.minimum);
      let elevationMeters = plan.baseElevationMeters;
      for (const operation of plan.operations) {
        if (operation.kind === "raise") {
          const distance = Math.hypot(xMeters - operation.center.x, zMeters - operation.center.z);
          if (distance < operation.radiusMeters)
            elevationMeters += operation.deltaMeters * (1 - distance / operation.radiusMeters);
        } else if (operation.kind === "carve") {
          const distance = Math.hypot(xMeters - operation.center.x, zMeters - operation.center.z);
          if (distance < operation.radiusMeters)
            elevationMeters -= operation.depthMeters * (1 - distance / operation.radiusMeters);
        } else if (pointInPolygon(xMeters, zMeters, operation.polygon))
          elevationMeters = operation.elevationMeters;
      }
      samples.push({ xMeters, zMeters, elevationMeters, materialId: plan.materialId });
    }
  const material = {
    kind: "TerrainFieldArtifact" as const,
    terrainPlanId: plan.terrainPlanId,
    worldPlanHash,
    surfaceId: plan.surfaceId,
    samples,
  };
  return deepFreezeJson(
    TERRAIN_FIELD_ARTIFACT_SCHEMA.parse({ ...material, hash: contentHash(stableJson(material)) }),
  );
}
function pointInPolygon(
  x: number,
  zCoordinate: number,
  polygon: readonly { x: number; z: number }[],
): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!;
    const b = polygon[j]!;
    if (
      a.z > zCoordinate !== b.z > zCoordinate &&
      x < ((b.x - a.x) * (zCoordinate - a.z)) / (b.z - a.z) + a.x
    )
      inside = !inside;
  }
  return inside;
}
function canonicalInstances(instances: readonly RealizedInstance[]): RealizedInstance[] {
  return [...instances].sort((a, b) => compareCanonicalStrings(a.instanceId, b.instanceId));
}
function validateMesoGraph(value: MesoLayout, context: z.RefinementCtx): void {
  const instanceIds = new Set(value.instances.map((entry) => entry.instanceId));
  const assemblyByHash = new Map(value.assemblies.map((entry) => [entry.hash, entry]));
  const assemblyById = new Map(value.assemblies.map((entry) => [entry.assemblyId, entry]));
  const surfaces = new Map(value.constructedSurfaces.map((entry) => [entry.surfaceId, entry]));
  const portals = new Map(value.portals.map((entry) => [entry.portalId, entry]));
  const rooms = new Map(value.rooms.map((entry) => [entry.roomId, entry]));
  const stairs = new Map(value.proceduralStairs.map((entry) => [entry.stairId, entry]));
  const sizes = [
    ["instance", instanceIds.size, value.instances.length],
    ["assembly hash", assemblyByHash.size, value.assemblies.length],
    ["assembly ID", assemblyById.size, value.assemblies.length],
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
  const statuses = [value.catalogResolution.status, value.meso.status, value.micro.status];
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
}

function verifyHash(value: Record<string, unknown>, field: string, context: z.RefinementCtx): void {
  const material = { ...value };
  delete material[field];
  if (contentHash(stableJson(material)) !== value[field])
    context.addIssue({ code: "custom", path: [field], message: "Artifact hash mismatch" });
}
