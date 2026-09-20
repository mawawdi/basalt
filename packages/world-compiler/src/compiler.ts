import {
  COMPILATION_STATUSES,
  compareCanonicalStrings,
  contentAddressedEntityId,
  contentHash,
  dequantizeQ32_32,
  stableJson,
  type CompilationStatus,
} from "@basalt/contracts";
import {
  ASSET_PLACEMENT_GEOMETRY_SCHEMA,
  resolveCatalogRequirements,
  type AssetPlacementGeometry,
  type CatalogAssetArtifact,
  type CatalogSnapshot,
  type RealizationIntent,
  type ResolvedCatalogBinding,
  type SealedRuntimeCatalogEntry,
} from "@basalt/catalog-model";
import {
  createSemanticDependencyClosure,
  validateAdmittedSemanticAssertions,
  type SemanticAssertionBundle,
  type SemanticModule,
} from "@basalt/semantic-kernel";
import {
  horizontalMaskMayIntersectBounds,
  OccupancyIndex,
  sealConstraintModel,
  sealOccupancyReservation,
  solveConstraintModel,
  type SpatialObb,
} from "@basalt/spatial-core";
import {
  compileWorldPlan,
  subdivideRegion,
  worldFoundationInputHash,
  worldRegionContainsPoint,
  worldRegionVolumeBounds,
  type ConstructionProgram,
  type PopulationPlacementConstraints,
  type SpatialWorldPlan,
  type WorldVector3,
} from "@basalt/world-planning";
import { realizeConstructionProgram, type ConstructionExecutionPolicy } from "./construction.js";
import {
  sealAssemblyArtifact,
  sealCompiledWorldFoundation,
  sealCompiledWorldFoundationArtifacts,
  sealConstructedSurface,
  sealMesoLayout,
  sealMicroRealization,
  sealPortalArtifact,
  sealProceduralStairArtifact,
  sealRealizedInstance,
  sealRoomArtifact,
  sealWorldBuild,
  type AssemblyArtifact,
  type CompiledWorldFoundation,
  type ConstructedSurface,
  type ConstructedStructureArtifact,
  type PortalArtifact,
  type ProceduralStairArtifact,
  type RealizedInstance,
  type RoomArtifact,
  type WorldBuild,
} from "./world-build.js";
import { compilationTaskId } from "./world-build.js";
import { resolveRouteConstruction, sealRouteJunctionArtifact } from "./route-construction.js";
import {
  sampleTerrainFieldElevation,
  sealBaseTerrainFieldArtifact,
  sealTerrainFieldArtifact,
  verifyTerrainConstruction,
} from "./terrain-foundation.js";
import { compilationTasks } from "./task-graph.js";
import { populationDensityAt } from "./population-density.js";
import {
  distributeVegetation,
  isVegetationIntent,
  vegetationGroundElevation,
  type VegetationExecutionPolicy,
  type VegetationIntent,
} from "./vegetation.js";

export const REALIZATION_INTENT_KINDS = [
  "single",
  "surface_scatter",
  "cluster",
  "along_route",
  "surface_grid",
  "socket_attachment",
  "wall_attachment",
  "route_network",
  "assembly",
  "environment_layer",
] as const;
type RealizationIntentKind = (typeof REALIZATION_INTENT_KINDS)[number];

export const REALIZATION_INTENT_VALIDATOR_BY_KIND = Object.freeze({
  single: "validateSingle",
  surface_scatter: "validateSurfaceScatter",
  cluster: "validateCluster",
  along_route: "validateAlongRoute",
  surface_grid: "validateSurfaceGrid",
  socket_attachment: "validateSocketAttachment",
  wall_attachment: "validateWallAttachment",
  route_network: "validateRouteNetwork",
  assembly: "validateAssembly",
  environment_layer: "validateEnvironmentLayer",
} satisfies Record<RealizationIntentKind, string>);

export const REALIZATION_INTENT_REALIZER_BY_KIND = Object.freeze({
  single: "realizePoint",
  surface_scatter: "realizeScatter",
  cluster: "realizeCluster",
  along_route: "realizeAlongRoute",
  surface_grid: "realizeGrid",
  socket_attachment: "realizeSocketAttachment",
  wall_attachment: "realizeWallAttachment",
  route_network: "realizeRouteNetwork",
  assembly: "realizeAssembly",
  environment_layer: "realizeEnvironment",
} satisfies Record<RealizationIntentKind, string>);

export interface PopulationExecutionPolicy {
  readonly policyId: string;
  readonly origin: string;
  readonly minimumCandidateAttempts: number;
  readonly candidateAttemptsPerTarget: number;
  readonly pointPlacementCandidateAttempts: number;
}

export interface AssemblyExecutionPolicy {
  readonly policyId: string;
  readonly origin: string;
  readonly maximumDecisions: number;
  readonly maximumBacktracks: number;
}

export interface CompileBasaltWorldInput {
  readonly semanticModule: SemanticModule;
  readonly catalogSnapshot: CatalogSnapshot;
  readonly catalogAssets: readonly CatalogAssetArtifact[];
  readonly spatialPlan: SpatialWorldPlan;
  readonly placementGeometry?: readonly AssetPlacementGeometry[];
  readonly executionPolicy?: {
    readonly construction?: ConstructionExecutionPolicy;
    readonly vegetation?: VegetationExecutionPolicy;
    readonly population?: PopulationExecutionPolicy;
    readonly assembly?: AssemblyExecutionPolicy;
  };
}

export function compileBasaltWorld(input: CompileBasaltWorldInput): WorldBuild {
  return compileBasaltWorldInternal(input).worldBuild;
}

export interface IncrementalWorldCompilation {
  readonly worldBuild: WorldBuild;
  readonly executedTaskIds: readonly string[];
  readonly reusedTasks: readonly { readonly taskId: string; readonly taskHash: string }[];
}

export function compileBasaltWorldIncremental(
  input: CompileBasaltWorldInput,
  options: {
    readonly previousWorldBuild: WorldBuild;
    readonly affectedTaskIds: readonly string[];
    readonly onTaskExecute?: (taskId: string) => void;
  },
): IncrementalWorldCompilation {
  return compileBasaltWorldInternal(input, options);
}

function compileBasaltWorldInternal(
  input: CompileBasaltWorldInput,
  options?: {
    readonly previousWorldBuild: WorldBuild;
    readonly affectedTaskIds: readonly string[];
    readonly onTaskExecute?: (taskId: string) => void;
  },
): IncrementalWorldCompilation {
  validateSemanticAuthority(input);
  validateCatalogAssets(input);
  const affected = new Set(options?.affectedTaskIds ?? []);
  const previous = options?.previousWorldBuild;
  if (previous) {
    const known = new Set(previous.tasks.map((entry) => entry.taskId));
    for (const taskId of affected)
      if (!known.has(taskId))
        throw new Error(`Incremental compilation received unknown task ${taskId}`);
  }
  const executed = new Set<string>();
  const markExecuted = (taskId: string) => {
    if (executed.has(taskId)) return;
    executed.add(taskId);
    options?.onTaskExecute?.(taskId);
  };
  const execute = (
    scope: Parameters<typeof compilationTaskId>[0],
    stage: Parameters<typeof compilationTaskId>[1],
    subjectId: string,
  ) => {
    const taskId = compilationTaskId(scope, stage, subjectId);
    if (!previous || affected.has(taskId)) markExecuted(taskId);
    return taskId;
  };

  const worldFoundationTaskId = compilationTaskId("world", "foundation", input.spatialPlan.planId);
  const foundation =
    previous && !affected.has(worldFoundationTaskId)
      ? reuseFoundation(input.spatialPlan, previous.foundation)
      : previous
        ? compileFoundationIncrementally(
            input.spatialPlan,
            previous.foundation,
            affected,
            markExecuted,
          )
        : sealCompiledWorldFoundation(compileWorldPlan(input.spatialPlan));
  if (!previous) execute("world", "foundation", input.spatialPlan.planId);
  else if (affected.has(worldFoundationTaskId)) markExecuted(worldFoundationTaskId);

  const worldCatalogTaskId = compilationTaskId(
    "world",
    "catalog_resolution",
    input.spatialPlan.planId,
  );
  const requirementHash = contentHash(stableJson(input.spatialPlan.catalogRequirements));
  const resolution =
    previous && !affected.has(worldCatalogTaskId)
      ? previous.catalogResolution
      : resolveCatalogRequirements({
          semanticModule: input.semanticModule,
          snapshot: input.catalogSnapshot,
          requirements: input.spatialPlan.catalogRequirements,
        });
  if (
    resolution.requirementsHash !== requirementHash ||
    resolution.catalogSnapshotHash !== input.catalogSnapshot.hash ||
    resolution.semanticKernelHash !== input.semanticModule.kernel.hash
  )
    throw new Error("Catalog resolution cannot be reused across changed authority inputs");
  if (!previous || affected.has(worldCatalogTaskId)) markExecuted(worldCatalogTaskId);
  const state = createState(input, resolution.bindings, foundation);
  for (const program of [...input.spatialPlan.constructionPrograms].sort((left, right) =>
    compareCanonicalStrings(left.programId, right.programId),
  )) {
    const taskId = compilationTaskId("structure", "meso", program.programId);
    try {
      const placement = resolveConstructionPlacement(input.spatialPlan, foundation, program);
      const constructionExecutionPolicy = input.executionPolicy?.construction;
      if (!constructionExecutionPolicy)
        throw new Error(
          `Construction program ${program.programId} requires an explicit construction execution policy`,
        );
      const structure =
        previous && !affected.has(taskId)
          ? reuseConstructedStructure(previous, program.programHash, placement)
          : realizeConstructionProgram(program, placement, constructionExecutionPolicy);
      if (!previous || affected.has(taskId)) markExecuted(taskId);
      assertConstructedStructureInsideRegion(input.spatialPlan, structure);
      state.occupancy.reserve(
        sealOccupancyReservation({
          sourceInstanceId: structure.structureId,
          surfaceId: structure.regionId,
          stratum: "constructed_structure",
          bounds: structure.boundsMeters,
        }),
      );
      state.constructedStructures.push(structure);
    } catch (error) {
      if (!previous || affected.has(taskId)) markExecuted(taskId);
      state.mesoDiagnostics.push(
        `construction:${program.programId}:${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const mesoIntents = orderedIntents(input.spatialPlan.realizationIntents).filter(
    (intent) => intent.kind === "assembly" || intent.kind === "route_network",
  );
  for (const intent of mesoIntents) realizeIntent(state, intent, "meso");
  const mesoStatus = stageStatus(
    combineCompilationStatuses(foundation.status, resolution.status),
    state.mesoDiagnostics,
  );
  const meso = sealMesoLayout({
    status: mesoStatus,
    foundationHash: foundation.foundationHash,
    catalogResolutionHash: resolution.hash,
    instances: state.mesoInstances,
    assemblies: state.assemblies,
    constructedStructures: state.constructedStructures,
    constructedSurfaces: state.constructedSurfaces,
    portals: state.portals,
    rooms: state.rooms,
    proceduralStairs: state.proceduralStairs,
    diagnostics: state.mesoDiagnostics,
  });
  const microIntents = orderedIntents(input.spatialPlan.realizationIntents).filter(
    (intent) => intent.kind !== "assembly" && intent.kind !== "route_network",
  );
  for (const intent of microIntents)
    if (!isVegetationIntent(intent)) realizeIntent(state, intent, "micro");
  realizeVegetation(state, microIntents.filter(isVegetationIntent));
  const microStatus = stageStatus(
    combineCompilationStatuses(foundation.status, resolution.status),
    state.microDiagnostics,
  );
  const micro = sealMicroRealization({
    status: microStatus,
    foundationHash: foundation.foundationHash,
    catalogResolutionHash: resolution.hash,
    mesoLayoutHash: meso.hash,
    instances: state.microInstances,
    ...(state.placementGeometry.size > 0
      ? {
          measuredOccupancy: state.occupancy
            .reservations()
            .filter(
              (reservation) =>
                reservation.collisionEvidenceHash &&
                state.microInstances.some(
                  (instance) =>
                    instance.instanceId === reservation.sourceInstanceId &&
                    instance.evidenceHashes.includes(reservation.collisionEvidenceHash!),
                ),
            ),
        }
      : {}),
    diagnostics: state.microDiagnostics,
  });
  const statuses = [foundation.status, resolution.status, meso.status, micro.status];
  const status = statuses.includes("rejected")
    ? "rejected"
    : statuses.includes("incomplete")
      ? "incomplete"
      : "eligible";
  const tasks = compilationTasks(
    input.spatialPlan,
    foundation,
    resolution,
    meso,
    micro,
    state.assemblies,
    state.mesoInstances,
    state.constructedStructures,
  );
  const worldMesoTaskId = compilationTaskId("world", "meso", input.spatialPlan.planId);
  const worldMicroTaskId = compilationTaskId("world", "micro", input.spatialPlan.planId);
  const worldBuildTaskId = compilationTaskId("world", "world_build", input.spatialPlan.planId);
  for (const task of tasks)
    if (
      !previous ||
      (affected.has(task.taskId) &&
        !executed.has(task.taskId) &&
        (task.stage === "meso" ||
          [worldMesoTaskId, worldMicroTaskId, worldBuildTaskId].includes(task.taskId)))
    )
      markExecuted(task.taskId);
  const worldBuild = sealWorldBuild({
    status,
    semanticKernelHash: input.semanticModule.kernel.hash,
    semanticClosureHashes: input.spatialPlan.semanticEntities.map(
      (entry) => entry.semanticDependencyClosureHash,
    ),
    catalogSnapshotHash: input.catalogSnapshot.hash,
    visualEnvironment: input.spatialPlan.visualEnvironment,
    foundation,
    catalogResolution: resolution,
    meso,
    micro,
    tasks,
    diagnostics: [...resolution.diagnostics, ...meso.diagnostics, ...micro.diagnostics],
  });
  if (!previous) {
    for (const task of worldBuild.tasks) markExecuted(task.taskId);
  } else {
    const missingExecutions = [...affected].filter((taskId) => !executed.has(taskId));
    if (missingExecutions.length > 0)
      throw new Error(
        `Incremental compiler did not execute affected tasks: ${missingExecutions.join(", ")}`,
      );
  }
  const previousById = new Map(
    previous?.tasks.map((entry) => [entry.taskId, entry] as const) ?? [],
  );
  const reusedTasks = worldBuild.tasks
    .filter((entry) => previous && !affected.has(entry.taskId))
    .map((entry) => {
      const old = previousById.get(entry.taskId);
      if (!old || old.taskHash !== entry.taskHash)
        throw new Error(`Unexecuted task ${entry.taskId} changed during incremental compilation`);
      return { taskId: entry.taskId, taskHash: entry.taskHash };
    });
  return {
    worldBuild,
    executedTaskIds: [...executed].sort(compareCanonicalStrings),
    reusedTasks,
  };
}

function reuseFoundation(
  plan: SpatialWorldPlan,
  previous: CompiledWorldFoundation,
): CompiledWorldFoundation {
  if (previous.foundationInputHash !== worldFoundationInputHash(plan))
    throw new Error("Foundation inputs changed outside the affected task closure");
  return previous;
}

function compileFoundationIncrementally(
  plan: SpatialWorldPlan,
  previous: CompiledWorldFoundation,
  affected: ReadonlySet<string>,
  markExecuted: (taskId: string) => void,
): CompiledWorldFoundation {
  const previousBaseTerrain = new Map(
    previous.baseTerrainFields.map((entry) => [entry.terrainPlanId, entry] as const),
  );
  const baseTerrainFields = plan.terrainPlans.map((terrainPlan) => {
    const taskId = compilationTaskId("terrain", "terrain_base", terrainPlan.terrainPlanId);
    const prior = previousBaseTerrain.get(terrainPlan.terrainPlanId);
    const terrainPlanHash = contentHash(stableJson(terrainPlan));
    if (!affected.has(taskId)) {
      if (!prior || prior.terrainPlanHash !== terrainPlanHash)
        throw new Error(`Base terrain ${terrainPlan.terrainPlanId} changed outside its task`);
      return prior;
    }
    markExecuted(taskId);
    return sealBaseTerrainFieldArtifact(terrainPlan);
  });

  const previousJunctions = new Map(
    previous.routeJunctions.map((entry) => [entry.junctionId, entry] as const),
  );
  const routeJunctions = plan.routeJunctions.map((junction) => {
    const taskId = compilationTaskId("junction", "route_construction", junction.junctionId);
    if (affected.has(taskId)) {
      markExecuted(taskId);
      return sealRouteJunctionArtifact(junction, plan, baseTerrainFields);
    }
    const prior = previousJunctions.get(junction.junctionId);
    const expected = sealRouteJunctionArtifact(junction, plan, baseTerrainFields);
    if (!prior || prior.hash !== expected.hash)
      throw new Error(`Route junction ${junction.junctionId} changed outside its task closure`);
    return prior;
  });

  const previousRoutes = new Map(
    previous.routeConstructions.map((entry) => [entry.routeId, entry] as const),
  );
  const routeConstructions = plan.routes.map((route) => {
    const taskId = compilationTaskId("route", "route_construction", route.routeId);
    const base = baseTerrainFields.find((field) => field.surfaceId === route.surfaceId);
    if (!base) throw new Error(`Route ${route.routeId} has no base terrain`);
    const relevantJunctions = routeJunctions.filter((junction) =>
      junction.participants.some((participant) => participant.routeId === route.routeId),
    );
    if (affected.has(taskId)) {
      markExecuted(taskId);
      return resolveRouteConstruction(route, base, relevantJunctions);
    }
    const prior = previousRoutes.get(route.routeId);
    const expectedJunctions = relevantJunctions
      .map((junction) => ({ junctionId: junction.junctionId, junctionHash: junction.hash }))
      .sort((left, right) => compareCanonicalStrings(left.junctionId, right.junctionId));
    if (
      !prior ||
      prior.routeHash !== contentHash(stableJson(route)) ||
      prior.baseTerrainFieldHash !== base.hash ||
      stableJson(prior.junctions) !== stableJson(expectedJunctions)
    )
      throw new Error(`Route ${route.routeId} changed outside its task closure`);
    return prior;
  });

  const previousTerrain = new Map(
    previous.terrainFields.map((entry) => [entry.terrainPlanId, entry] as const),
  );
  const terrainFields = plan.terrainPlans.map((terrainPlan) => {
    const taskId = compilationTaskId("terrain", "terrain_final", terrainPlan.terrainPlanId);
    const base = baseTerrainFields.find(
      (candidate) => candidate.terrainPlanId === terrainPlan.terrainPlanId,
    )!;
    const contributors = routeConstructions.filter(
      (route) => route.surfaceId === terrainPlan.surfaceId,
    );
    const junctionContributors = routeJunctions.filter(
      (junction) => junction.surfaceId === terrainPlan.surfaceId,
    );
    if (affected.has(taskId)) {
      markExecuted(taskId);
      return sealTerrainFieldArtifact(base, contributors, junctionContributors);
    }
    const prior = previousTerrain.get(terrainPlan.terrainPlanId);
    const expected = sealTerrainFieldArtifact(base, contributors, junctionContributors);
    if (!prior || prior.hash !== expected.hash)
      throw new Error(
        `Final terrain ${terrainPlan.terrainPlanId} changed outside its task closure`,
      );
    return prior;
  });

  for (const region of plan.regions) {
    const taskId = compilationTaskId("region", "foundation", region.regionId);
    if (affected.has(taskId)) markExecuted(taskId);
  }

  const previousLots = new Map(
    previous.lotSubdivisions.map((entry) => [entry.policy.policyId, entry] as const),
  );
  const lotSubdivisions = plan.lotPolicies.map((policy) => {
    const taskId = compilationTaskId("lot", "foundation", policy.policyId);
    if (affected.has(taskId)) {
      markExecuted(taskId);
      return subdivideRegion(plan, policy);
    }
    const prior = previousLots.get(policy.policyId);
    const region = plan.regions.find((entry) => entry.regionId === policy.regionId);
    const routes = plan.routes.filter((route) => route.regionIds.includes(policy.regionId));
    if (!region) throw new Error(`Lot policy ${policy.policyId} has no region`);
    const inputHash = contentHash(stableJson({ policy, region, routes }));
    if (!prior || prior.inputHash !== inputHash)
      throw new Error(`Lot policy ${policy.policyId} changed outside its task closure`);
    return prior;
  });
  const diagnostics = [
    ...routeConstructions.flatMap((route) => route.diagnostics),
    ...verifyTerrainConstruction(
      terrainFields,
      baseTerrainFields,
      routeConstructions,
      routeJunctions,
    ),
  ];
  return sealCompiledWorldFoundationArtifacts({
    status: routeConstructions.some((route) => route.status === "rejected")
      ? "rejected"
      : routeConstructions.some((route) => route.status === "incomplete") || diagnostics.length > 0
        ? "incomplete"
        : "eligible",
    foundationInputHash: worldFoundationInputHash(plan),
    boundsMeters: plan.boundsMeters,
    baseTerrainFields,
    terrainFields,
    routeConstructions,
    routeJunctions,
    lotSubdivisions,
    placementSurfaces: plan.placementSurfaces,
    diagnostics,
  });
}

function reuseConstructedStructure(
  previous: WorldBuild,
  constructionProgramHash: string,
  placement: ReturnType<typeof resolveConstructionPlacement>,
): ConstructedStructureArtifact {
  const structure = previous.meso.constructedStructures.find(
    (entry) => entry.constructionProgramHash === constructionProgramHash,
  );
  if (!structure) throw new Error("Unchanged construction task has no reusable structure artifact");
  if (
    structure.placementEvidenceHash !== placement.evidenceHash ||
    stableJson(structure.resolvedAnchorMeters) !== stableJson(placement.anchorPositionMeters) ||
    structure.placementSurfaceId !== placement.surfaceId
  )
    throw new Error("Construction placement changed outside its affected task closure");
  return structure;
}

function resolveConstructionPlacement(
  plan: SpatialWorldPlan,
  foundation: CompiledWorldFoundation,
  program: ConstructionProgram,
) {
  const anchor = program.anchor;
  if (anchor.kind === "region_point")
    return {
      anchorPositionMeters: anchor.positionMeters,
      evidenceHash: contentHash(
        stableJson({
          kind: "region_point",
          region: plan.regions.find((entry) => entry.regionId === program.regionId),
          positionMeters: anchor.positionMeters,
        }),
      ),
    };
  const surface = foundation.placementSurfaces.find(
    (candidate) => candidate.surfaceId === anchor.surfaceId,
  );
  if (!surface) throw new Error(`unknown construction surface ${anchor.surfaceId}`);
  const fields = foundation.terrainFields.filter(
    (candidate) => candidate.surfaceId === anchor.surfaceId,
  );
  if (fields.length > 1)
    throw new Error(`construction surface ${anchor.surfaceId} has ambiguous terrain`);
  const horizontal = anchor.horizontalPositionMeters;
  const field = fields[0];
  const baseField = field
    ? foundation.baseTerrainFields.find(
        (candidate) => candidate.hash === field.baseTerrainFieldHash,
      )
    : undefined;
  if (field && !baseField)
    throw new Error(`construction surface ${anchor.surfaceId} has no base terrain`);
  const surfaceElevationMeters = field
    ? sampleTerrainFieldElevation(
        field,
        baseField!,
        foundation.routeConstructions,
        foundation.routeJunctions,
        horizontal.x,
        horizontal.z,
      )
    : surface.bounds.max.y;
  return {
    anchorPositionMeters: {
      x: horizontal.x,
      y: surfaceElevationMeters + anchor.elevationOffsetMeters,
      z: horizontal.z,
    },
    evidenceHash: field?.hash ?? surface.sourceHash,
    surfaceId: surface.surfaceId,
  };
}

interface CompilerState {
  readonly input: CompileBasaltWorldInput;
  readonly foundation: CompiledWorldFoundation;
  readonly entries: ReadonlyMap<string, SealedRuntimeCatalogEntry>;
  readonly assets: ReadonlyMap<string, CatalogAssetArtifact>;
  readonly placementGeometry: ReadonlyMap<string, AssetPlacementGeometry>;
  readonly bindings: ReadonlyMap<string, ResolvedCatalogBinding>;
  readonly occupancy: OccupancyIndex;
  readonly mesoInstances: RealizedInstance[];
  readonly microInstances: RealizedInstance[];
  readonly assemblies: AssemblyArtifact[];
  readonly constructedStructures: ConstructedStructureArtifact[];
  readonly constructedSurfaces: ConstructedSurface[];
  readonly portals: PortalArtifact[];
  readonly rooms: RoomArtifact[];
  readonly proceduralStairs: ProceduralStairArtifact[];
  readonly mesoDiagnostics: string[];
  readonly microDiagnostics: string[];
}

function createState(
  input: CompileBasaltWorldInput,
  bindings: readonly ResolvedCatalogBinding[],
  foundation: CompiledWorldFoundation,
): CompilerState {
  const runtimeEntries = input.catalogSnapshot.entries.filter(
    (entry): entry is SealedRuntimeCatalogEntry => entry.kind !== "collection",
  );
  return {
    input,
    foundation,
    entries: uniqueMap(runtimeEntries, (entry) => entry.handle, "catalog entry"),
    assets: uniqueMap(input.catalogAssets, (entry) => entry.hash, "catalog asset"),
    placementGeometry: uniqueMap(
      input.placementGeometry ?? [],
      (entry) => entry.assetHash,
      "placement geometry",
    ),
    bindings: uniqueMap(bindings, (entry) => entry.requirementId, "catalog binding"),
    occupancy: new OccupancyIndex(),
    mesoInstances: [],
    microInstances: [],
    assemblies: [],
    constructedStructures: [],
    constructedSurfaces: [],
    portals: [],
    rooms: [],
    proceduralStairs: [],
    mesoDiagnostics: [],
    microDiagnostics: [],
  };
}

function realizeIntent(
  state: CompilerState,
  intent: RealizationIntent,
  stage: "meso" | "micro",
): void {
  const diagnostics = stage === "meso" ? state.mesoDiagnostics : state.microDiagnostics;
  const binding = state.bindings.get(intent.requirementId);
  if (!binding) {
    diagnostics.push(`intent:${intent.intentId}:requirement is unresolved`);
    return;
  }
  const entry = state.entries.get(binding.entryHandle);
  if (!entry || entry.entryHash !== binding.entryHash) {
    diagnostics.push(`intent:${intent.intentId}:resolved entry is unavailable`);
    return;
  }
  try {
    const expectedEntryKind = entryKindForIntent(intent.kind);
    if (entry.kind !== expectedEntryKind)
      throw new Error(
        `${intent.kind} intent requires ${expectedEntryKind}, resolved ${entry.kind}`,
      );
    if (intent.kind === "assembly") {
      realizeAssembly(state, intent, entry);
      return;
    }
    if (intent.kind === "route_network") {
      realizeRouteNetwork(state, intent, entry);
      return;
    }
    if (intent.kind === "socket_attachment") {
      const source = resolveMember(state, entry, binding, intent.intentId);
      if (!source) throw new Error("attachment set has no realizable asset member");
      const attached = realizeSocketAttachment(state, intent, entry, source);
      const reservation = reservationFor(attached.instance, source.asset);
      state.occupancy.reserve(reservation, 0, [attached.hostInstanceId]);
      state.microInstances.push(attached.instance);
      return;
    }
    if (
      intent.kind === "environment_layer" &&
      entry.kind === "environment_realizer" &&
      !entry.declaration.modes.includes(intent.mode)
    )
      throw new Error(`environment realizer does not support ${intent.mode}`);
    const targets = targetsForIntent(state, intent);
    const targetCount = desiredCount(intent);
    let placed = 0;
    let candidateCount = 0;
    let outsideRegionCount = 0;
    let occupancyConflictCount = 0;
    let routeClearanceConflictCount = 0;
    for (const target of targets) {
      if (placed >= targetCount) break;
      const candidateIndex = candidateCount;
      candidateCount += 1;
      const source = resolveMember(state, entry, binding, `${intent.intentId}:${candidateIndex}`);
      if (!source) {
        diagnostics.push(`intent:${intent.intentId}:entry has no realizable asset member`);
        break;
      }
      const surfacePlaced =
        intent.kind === "single" ||
        intent.kind === "surface_scatter" ||
        intent.kind === "cluster" ||
        intent.kind === "surface_grid" ||
        intent.kind === "along_route";
      const position =
        surfacePlaced &&
        entry.placement.support === "ground" &&
        entry.placement.contact === "bottom" &&
        source.asset.support.primaryContact === "bottom"
          ? {
              ...target.position,
              y:
                target.position.y -
                transformedBounds(
                  source.asset,
                  { x: 0, y: 0, z: 0 },
                  target.rotation ?? yawQuaternion(contentHash(stableJson(intent))),
                ).min.y,
            }
          : target.position;
      const instance = buildInstance(
        intent,
        entry,
        source,
        position,
        target.regionId,
        target.surfaceId,
        undefined,
        target.rotation,
      );
      try {
        assertInstanceInsideRegion(state.input.spatialPlan, instance);
      } catch {
        outsideRegionCount += 1;
        continue;
      }
      if (
        (intent.kind === "surface_scatter" ||
          intent.kind === "cluster" ||
          intent.kind === "surface_grid" ||
          (intent.kind === "single" && intent.positionToleranceMeters !== undefined)) &&
        violatesGroundRouteClearance(
          state.foundation,
          instance,
          intent.kind === "surface_scatter" && intent.vegetation !== undefined,
        )
      ) {
        routeClearanceConflictCount += 1;
        continue;
      }
      const reservation = reservationFor(
        instance,
        source.asset,
        separationForIntent(intent) / 2,
        source.placementGeometry,
      );
      if (state.occupancy.conflicts(reservation).length > 0) {
        occupancyConflictCount += 1;
        continue;
      }
      state.occupancy.reserve(reservation);
      (stage === "meso" ? state.mesoInstances : state.microInstances).push(instance);
      placed += 1;
    }
    const minimum = requiredCount(intent);
    if (candidateCount === 0 && minimum > 0) {
      diagnostics.push(`intent:${intent.intentId}:has no valid spatial targets`);
    } else if (placed < minimum) {
      diagnostics.push(
        `intent:${intent.intentId}:placed ${placed} of required ${minimum} after ${candidateCount} candidates (${outsideRegionCount} outside region, ${occupancyConflictCount} occupancy conflicts, ${routeClearanceConflictCount} route clearance conflicts)`,
      );
      if (
        intent.kind === "single" &&
        (intent.positionToleranceMeters ?? 0) > 0 &&
        candidateCount === populationExecutionPolicy(state).pointPlacementCandidateAttempts
      ) {
        const policy = populationExecutionPolicy(state);
        diagnostics.push(
          `intent:${intent.intentId}:population execution policy ${policy.policyId} exhausted ${policy.pointPlacementCandidateAttempts} point-placement candidate evaluations (${policy.origin})`,
        );
      }
    }
  } catch (error) {
    diagnostics.push(
      `intent:${intent.intentId}:${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function realizeVegetation(state: CompilerState, intents: readonly VegetationIntent[]): void {
  if (intents.length === 0) return;
  const ready: VegetationIntent[] = [];
  const blockers = new Map<string, OccupancyIndex>();
  for (const intent of intents) {
    const binding = state.bindings.get(intent.requirementId);
    const entry = binding && state.entries.get(binding.entryHandle);
    if (
      !entry ||
      entry.kind !== "substitution_set" ||
      entry.placement.support !== "ground" ||
      entry.placement.contact !== "bottom" ||
      entry.memberAssets.some(
        (member) =>
          !state.placementGeometry.has(member.assetHash) ||
          state.assets.get(member.assetHash)?.support.primaryContact !== "bottom",
      )
    ) {
      state.microDiagnostics.push(
        `intent:${intent.intentId}:vegetation requires a resolved ground entry and source-measured placement geometry for every member`,
      );
      continue;
    }
    ready.push(intent);
    const index = new OccupancyIndex();
    const boxes = [];
    for (const route of state.foundation.routeConstructions) {
      if (route.surfaceId !== intent.surfaceId || route.treatmentKind === "elevated") continue;
      const margin = Math.max(0, route.vegetationMask.halfWidthMeters - route.widthMeters / 2);
      for (const segment of route.travelSegments)
        boxes.push({
          min: {
            x: segment.boundsMeters.min.x - margin,
            y: segment.boundsMeters.min.y,
            z: segment.boundsMeters.min.z - margin,
          },
          max: {
            x: segment.boundsMeters.max.x + margin,
            y: segment.boundsMeters.max.y + intent.vegetation.routeClearanceHeightMeters,
            z: segment.boundsMeters.max.z + margin,
          },
        });
    }
    // Overlapping exclusion volumes are a union; checkpoints do not require mutually disjoint reservations.
    index.restore(
      boxes.map((bounds, i) =>
        sealOccupancyReservation({
          sourceInstanceId: contentAddressedEntityId("VegetationExclusion", {
            intentId: intent.intentId,
            i,
          }),
          surfaceId: intent.surfaceId,
          stratum: "vegetation_exclusion",
          bounds,
        }),
      ),
    );
    blockers.set(intent.intentId, index);
  }
  const constraints = state.input.spatialPlan.populationPlacementConstraints;
  if (constraints) {
    if (constraints.catalogSnapshotHash !== state.input.catalogSnapshot.hash) {
      state.microDiagnostics.push(
        "population_constraints:catalog snapshot changed; retained placement evidence is stale",
      );
      return;
    }
    restorePopulationPlacements(state, ready, blockers, constraints);
  }
  const active = constraints
    ? ready.filter((intent) =>
        constraints.regenerationMasks.some(
          (mask) =>
            mask.areaId === intent.vegetation.areaId &&
            mask.layers.includes(intent.vegetation.layer),
        ),
      )
    : ready;
  if (active.length > 0 && !state.input.executionPolicy?.vegetation) {
    state.microDiagnostics.push(
      "vegetation:Vegetation realization requires an explicit execution policy with a candidate batch size",
    );
    return;
  }
  try {
    const summaries = distributeVegetation(active, {
      seed: state.input.spatialPlan.seed,
      initialCanopy: state.microInstances,
      executionPolicy: state.input.executionPolicy!.vegetation!,
      ...(constraints
        ? {
            candidateAllowed: (intent: VegetationIntent, candidate: { x: number; z: number }) =>
              constraints.regenerationMasks.some(
                (mask) =>
                  mask.areaId === intent.vegetation.areaId &&
                  mask.layers.includes(intent.vegetation.layer) &&
                  candidate.x >= mask.boundsMeters.min.x - mask.transitionMeters &&
                  candidate.x <= mask.boundsMeters.max.x + mask.transitionMeters &&
                  candidate.z >= mask.boundsMeters.min.z - mask.transitionMeters &&
                  candidate.z <= mask.boundsMeters.max.z + mask.transitionMeters,
              ),
          }
        : {}),
      heightAt: (surfaceId, x, z) => surfaceHeight(state, surfaceId, x, z),
      place: (intent, candidate) => {
        const binding = state.bindings.get(intent.requirementId)!;
        const entry = state.entries.get(binding.entryHandle)!;
        const source = resolveMember(state, entry, binding, candidate.hash)!;
        const rotation = yawQuaternion(candidate.hash);
        const surface = state.foundation.placementSurfaces.find(
          (surface) => surface.surfaceId === intent.surfaceId,
        )!;
        const groundElevation = vegetationGroundElevation({
          geometry: source.placementGeometry!,
          x: candidate.x,
          z: candidate.z,
          yawRadians: 2 * Math.atan2(rotation[1], rotation[3]),
          maximumReliefMeters: intent.vegetation.maximumSupportReliefMeters,
          embedMeters: intent.vegetation.groundEmbedMeters,
          heightAt: (x, z) =>
            x < surface.bounds.min.x ||
            x > surface.bounds.max.x ||
            z < surface.bounds.min.z ||
            z > surface.bounds.max.z
              ? NaN
              : surfaceHeight(state, intent.surfaceId, x, z),
        });
        if (groundElevation === undefined) return undefined;
        const position = {
          x: candidate.x,
          z: candidate.z,
          y:
            groundElevation - transformedBounds(source.asset, { x: 0, y: 0, z: 0 }, rotation).min.y,
        };
        const instance = buildInstance(
          intent,
          entry,
          source,
          position,
          intent.regionId,
          intent.surfaceId,
          undefined,
          rotation,
        );
        if (
          intent.vegetation.clearings.some(
            (clearing) =>
              instance.boundsMeters.max.y >= clearing.verticalRangeMeters.minimum &&
              instance.boundsMeters.min.y <= clearing.verticalRangeMeters.maximum &&
              horizontalMaskMayIntersectBounds(clearing.mask, instance.boundsMeters),
          )
        )
          return undefined;
        try {
          assertInstanceInsideRegion(state.input.spatialPlan, instance);
        } catch {
          return undefined;
        }
        const reservation = reservationFor(
          instance,
          source.asset,
          intent.minimumSeparationMeters / 2,
          source.placementGeometry,
        );
        if (
          blockers.get(intent.intentId)!.conflicts(reservation).length > 0 ||
          state.occupancy.conflicts(reservation).length > 0
        )
          return undefined;
        state.occupancy.reserve(reservation);
        state.microInstances.push(instance);
        return instance;
      },
    });
    for (const summary of summaries) {
      const intent = active.find((candidate) => candidate.intentId === summary.intentId)!;
      if (summary.executionStatus === "resource_exhausted") {
        state.microDiagnostics.push(
          `intent:${intent.intentId}:vegetation execution policy ${summary.execution.policyId} ` +
            `(${summary.execution.origin}) exhausted its ${summary.execution.allocated ?? "unbounded"} ` +
            `${summary.execution.unit} allocation after checkpointing ${summary.execution.completed} of ` +
            `${summary.execution.required}; ${summary.execution.exhaustionReason ?? "intent remains valid and compilation is incomplete"}`,
        );
        continue;
      }
      if (summary.placed < intent.minimumCount)
        state.microDiagnostics.push(
          `intent:${intent.intentId}:placed ${summary.placed} of required ${intent.minimumCount} from ${summary.trials} vegetation trials; rejected ${summary.rejectedDensity} by density/clearing, ${summary.rejectedRegenerationMask} outside the regeneration mask, ${summary.rejectedSpacing} by spacing, ${summary.rejectedSlope} by slope, ${summary.rejectedPlacement} by grounding/occupancy/region; density is not replenished`,
        );
    }
  } catch (error) {
    state.microDiagnostics.push(
      `vegetation:${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function restorePopulationPlacements(
  state: CompilerState,
  intents: readonly VegetationIntent[],
  blockers: ReadonlyMap<string, OccupancyIndex>,
  constraints: PopulationPlacementConstraints,
): void {
  const byIntent = new Map(intents.map((intent) => [intent.intentId, intent] as const));
  for (const lock of constraints.retainedPlacements) {
    const intent = byIntent.get(lock.intentId);
    const binding = intent && state.bindings.get(intent.requirementId);
    const entry = binding && state.entries.get(lock.entryHandle);
    const member = entry?.memberAssets.find(
      (candidate) => candidate.memberId === lock.memberId && candidate.assetHash === lock.assetHash,
    );
    const asset = member && state.assets.get(member.assetHash);
    const placementGeometry = asset && state.placementGeometry.get(asset.hash);
    if (
      !intent ||
      intent.requirementId !== lock.requirementId ||
      !binding ||
      binding.entryHandle !== lock.entryHandle ||
      !entry ||
      entry.kind !== "substitution_set" ||
      !member ||
      !asset ||
      !placementGeometry
    ) {
      state.microDiagnostics.push(
        `population_lock:${lock.lockId}:catalog, intent, or measured geometry evidence is stale`,
      );
      continue;
    }
    const position = lock.transformMeters.position;
    const rotation = lock.transformMeters.rotation;
    const surface = state.foundation.placementSurfaces.find(
      (candidate) => candidate.surfaceId === intent.surfaceId,
    );
    const groundElevation =
      surface &&
      vegetationGroundElevation({
        geometry: placementGeometry,
        x: position.x,
        z: position.z,
        yawRadians: 2 * Math.atan2(rotation[1], rotation[3]),
        maximumReliefMeters: intent.vegetation.maximumSupportReliefMeters,
        embedMeters: intent.vegetation.groundEmbedMeters,
        heightAt: (x, z) =>
          x < surface.bounds.min.x ||
          x > surface.bounds.max.x ||
          z < surface.bounds.min.z ||
          z > surface.bounds.max.z
            ? NaN
            : surfaceHeight(state, intent.surfaceId, x, z),
      });
    const expectedY =
      groundElevation === undefined
        ? undefined
        : groundElevation - transformedBounds(asset, { x: 0, y: 0, z: 0 }, rotation).min.y;
    if (expectedY === undefined || Math.abs(expectedY - position.y) > 1e-6) {
      state.microDiagnostics.push(
        `population_lock:${lock.lockId}:terrain support changed from the retained placement`,
      );
      continue;
    }
    const instance = buildInstance(
      intent,
      entry,
      { member, asset, placementGeometry },
      position,
      intent.regionId,
      intent.surfaceId,
      undefined,
      rotation,
    );
    try {
      assertInstanceInsideRegion(state.input.spatialPlan, instance);
    } catch {
      state.microDiagnostics.push(`population_lock:${lock.lockId}:placement left its region`);
      continue;
    }
    const reservation = reservationFor(
      instance,
      asset,
      intent.minimumSeparationMeters / 2,
      placementGeometry,
    );
    if (
      blockers.get(intent.intentId)!.conflicts(reservation).length > 0 ||
      state.occupancy.conflicts(reservation).length > 0
    ) {
      state.microDiagnostics.push(
        `population_lock:${lock.lockId}:retained placement conflicts with current protected geometry`,
      );
      continue;
    }
    state.occupancy.reserve(reservation);
    state.microInstances.push(instance);
  }
}

/**
 * Ground population respects the physical route surface with its complete rotated footprint.
 * Biological planting additionally respects the authored vegetation buffer. The vegetation
 * buffer is an ecological/art-direction choice and must not push route-adjacent landmarks or
 * props away from an otherwise valid approach.
 */
function violatesGroundRouteClearance(
  foundation: CompiledWorldFoundation,
  instance: RealizedInstance,
  includeVegetationBuffer: boolean,
): boolean {
  const bounds = instance.boundsMeters;
  return foundation.routeConstructions.some((route) => {
    if (route.surfaceId !== instance.surfaceId || route.treatmentKind === "elevated") return false;
    const margin = includeVegetationBuffer
      ? Math.max(0, route.vegetationMask.halfWidthMeters - route.widthMeters / 2)
      : 0;
    return route.travelSegments.some(
      ({ boundsMeters: travel }) =>
        bounds.max.x > travel.min.x - margin &&
        bounds.min.x < travel.max.x + margin &&
        bounds.max.z > travel.min.z - margin &&
        bounds.min.z < travel.max.z + margin,
    );
  });
}

function realizeRouteNetwork(
  state: CompilerState,
  intent: Extract<RealizationIntent, { kind: "route_network" }>,
  entry: SealedRuntimeCatalogEntry,
): void {
  if (entry.kind !== "route_kit") throw new Error(`route network resolved to ${entry.kind}`);
  const segmentLengthMeters = dequantizeQ32_32(entry.declaration.segmentLengthMeters);
  const drafts = intent.routeIds.flatMap((routeId) => {
    const route = state.input.spatialPlan.routes.find((candidate) => candidate.routeId === routeId);
    if (!route) throw new Error(`unknown route ${routeId}`);
    const stations = routeStations(
      routeProfilePoints(state, routeId),
      segmentLengthMeters,
      route.closed,
    );
    return stations.map((station, index) => {
      const topology =
        !route.closed && (index === 0 || index === stations.length - 1)
          ? ("terminal" as const)
          : station.turnRadians > 1e-3
            ? ("curve" as const)
            : ("straight" as const);
      const component = entry.declaration.components.find(
        (candidate) => candidate.topology === topology,
      );
      if (!component) throw new Error(`route kit has no ${topology} component`);
      const providerHandle = component.providerHandles.find((handle) => {
        const provider = state.entries.get(handle);
        return provider?.kind === "substitution_set" && provider.memberAssets.length > 0;
      });
      if (!providerHandle)
        throw new Error(`route role ${component.roleId} has no eligible provider`);
      const provider = state.entries.get(providerHandle)! as SubstitutionEntry;
      const source = resolveMember(
        state,
        provider,
        undefined,
        `${intent.intentId}:${routeId}:${index}`,
      );
      if (!source) throw new Error(`route provider ${providerHandle} has no realizable member`);
      const rotation = yawFromDirection(station.tangent);
      const instance = buildInstance(
        intent,
        provider,
        source,
        station.position,
        route.regionIds[0],
        route.surfaceId,
        { roleSchemeId: entry.declaration.roleSchemeId, roleId: component.roleId },
        rotation,
      );
      assertInstanceInsideRegion(state.input.spatialPlan, instance);
      return { routeId, component, source, instance };
    });
  });
  for (let index = 1; index < drafts.length; index += 1) {
    const previous = drafts[index - 1]!;
    const current = drafts[index]!;
    if (
      previous.routeId === current.routeId &&
      !entry.declaration.allowedTransitions.some(
        (transition) =>
          transition.fromRoleId === previous.component.roleId &&
          transition.toRoleId === current.component.roleId,
      )
    )
      throw new Error(
        `route kit forbids transition ${previous.component.roleId} -> ${current.component.roleId}`,
      );
  }
  for (const routeId of intent.routeIds) {
    const route = state.input.spatialPlan.routes.find(
      (candidate) => candidate.routeId === routeId,
    )!;
    if (!route.closed) continue;
    const routeDrafts = drafts.filter((draft) => draft.routeId === routeId);
    const first = routeDrafts[0];
    const last = routeDrafts.at(-1);
    if (
      first &&
      last &&
      !entry.declaration.allowedTransitions.some(
        (transition) =>
          transition.fromRoleId === last.component.roleId &&
          transition.toRoleId === first.component.roleId,
      )
    )
      throw new Error(
        `route kit forbids closed transition ${last.component.roleId} -> ${first.component.roleId}`,
      );
  }
  state.occupancy.reserveBatch(
    drafts.map((draft) => reservationFor(draft.instance, draft.source.asset)),
  );
  state.mesoInstances.push(...drafts.map((draft) => draft.instance));
}

interface RouteStation {
  readonly position: WorldVector3;
  readonly tangent: WorldVector3;
  readonly turnRadians: number;
}

function routeStations(
  points: readonly WorldVector3[],
  spacingMeters: number,
  closed: boolean,
): RouteStation[] {
  const segmentLengths = points.slice(1).map((point, index) => distance(point, points[index]!));
  const totalLength = segmentLengths.reduce((sum, length) => sum + length, 0);
  const count = Math.max(2, Math.ceil(totalLength / spacingMeters) + (closed ? 0 : 1));
  return Array.from({ length: count }, (_, index) => {
    const t = closed ? index / count : index / (count - 1);
    const frame = sampleRouteFrame(points, t);
    const before = sampleRouteFrame(points, Math.max(0, t - 1 / Math.max(64, count * 8))).tangent;
    const after = sampleRouteFrame(points, Math.min(1, t + 1 / Math.max(64, count * 8))).tangent;
    const horizontalBefore = normalized({ x: before.x, y: 0, z: before.z });
    const horizontalAfter = normalized({ x: after.x, y: 0, z: after.z });
    return {
      ...frame,
      turnRadians: Math.acos(Math.max(-1, Math.min(1, dot(horizontalBefore, horizontalAfter)))),
    };
  });
}

function yawFromDirection(direction: WorldVector3): [number, number, number, number] {
  const length = Math.hypot(direction.x, direction.z);
  if (length <= 1e-9) throw new Error("route component direction is vertical");
  const angle = Math.atan2(direction.x / length, direction.z / length);
  return [0, Math.sin(angle / 2), 0, Math.cos(angle / 2)];
}

function validateSemanticAuthority(input: CompileBasaltWorldInput): void {
  const bundles = new Map(input.spatialPlan.admittedAssertions.map((entry) => [entry.hash, entry]));
  const concepts = new Map(input.semanticModule.concepts.map((entry) => [entry.conceptId, entry]));
  const plannedSorts = new Map(
    input.spatialPlan.semanticEntities.map((entity) => [
      `planned_entity:${entity.entityId}`,
      entity.upperSort,
    ]),
  );
  for (const bundle of bundles.values())
    validateAdmittedSemanticAssertions({
      module: input.semanticModule,
      bundle,
      resolveExternalSubjectSort: (subject) => plannedSorts.get(`${subject.kind}:${subject.id}`),
    });
  for (const entity of input.spatialPlan.semanticEntities) {
    const bundle = bundles.get(entity.admittedAssertionBundleHash);
    if (!bundle || bundle.authority !== "admitted")
      throw new Error(`Semantic entity ${entity.entityId} lacks admitted authority`);
    const relationBundle = entity.relationAssertionBundleHash
      ? bundles.get(entity.relationAssertionBundleHash)
      : undefined;
    if (entity.relationAssertionBundleHash && !relationBundle)
      throw new Error(`Semantic entity ${entity.entityId} lacks admitted relation authority`);
    const authorityBundles =
      relationBundle && relationBundle.hash !== bundle.hash ? [bundle, relationBundle] : [bundle];
    const assertions = authorityBundles.flatMap((authorityBundle) =>
      authorityBundle.assertions.filter(
        (entry) => entry.subject.kind === "planned_entity" && entry.subject.id === entity.entityId,
      ),
    );
    const denotations = assertions.filter(
      (entry): entry is Extract<(typeof assertions)[number], { assertionKind: "denotation" }> =>
        entry.assertionKind === "denotation",
    );
    if (denotations.length !== 1)
      throw new Error(`Semantic entity ${entity.entityId} requires exactly one denotation`);
    const denotation = denotations[0]!;
    const commitment = concepts.get(denotation.concept.conceptId);
    if (!commitment || commitment.commitmentHash !== denotation.concept.commitmentHash)
      throw new Error(`Semantic entity ${entity.entityId} references an unknown commitment`);
    if (commitment.upperSort !== entity.upperSort)
      throw new Error(`Semantic entity ${entity.entityId} upper sort contradicts its commitment`);
    const closure = createSemanticDependencyClosure({
      module: input.semanticModule,
      conceptIds: [commitment.conceptId],
      definitionIds: semanticDefinitionIds(assertions),
    });
    if (closure.hash !== entity.semanticDependencyClosureHash)
      throw new Error(
        `Semantic entity ${entity.entityId} dependency closure is not minimal and exact`,
      );
  }
}

function semanticDefinitionIds(
  assertions: Extract<SemanticAssertionBundle, { authority: "admitted" }>["assertions"],
): string[] {
  const result = assertions.flatMap((entry) => {
    if (entry.assertionKind === "affordance") return [entry.affordanceId];
    if (entry.assertionKind === "state") return [entry.stateDimensionId, entry.stateValueId];
    if (entry.assertionKind === "surface_treatment") return [entry.surfaceTreatmentId];
    if (entry.assertionKind === "role") return [entry.roleSchemeId, entry.roleId];
    if (entry.assertionKind === "relation") return [entry.relationId];
    if (entry.assertionKind === "realization_form") return [entry.realizationForm];
    return [];
  });
  return [...new Set(result)].sort(compareCanonicalStrings);
}

function validateCatalogAssets(input: CompileBasaltWorldInput): void {
  const supplied = new Set(input.catalogAssets.map((entry) => entry.hash));
  for (const hash of input.catalogSnapshot.eligibleAssetArtifactHashes)
    if (!supplied.has(hash)) throw new Error(`Catalog asset artifact is unavailable: ${hash}`);
  for (const suppliedGeometry of input.placementGeometry ?? []) {
    const geometry = ASSET_PLACEMENT_GEOMETRY_SCHEMA.parse(suppliedGeometry);
    const asset = input.catalogAssets.find((candidate) => candidate.hash === geometry.assetHash);
    if (
      !asset ||
      asset.source.contentHash !== geometry.sourceContentHash ||
      asset.geometryHash !== geometry.geometryHash ||
      asset.deformation.mode !== "static"
    )
      throw new Error("Placement geometry is not bound to the supplied static asset measurement");
    for (const band of geometry.bands)
      for (const axis of ["x", "y", "z"] as const)
        if (
          band.min[axis] < dequantizeQ32_32(asset.bounds.min[axis]) - 2e-6 ||
          band.max[axis] > dequantizeQ32_32(asset.bounds.max[axis]) + 2e-6
        )
          throw new Error("Placement geometry exceeds measured asset bounds");
  }
}

function entryKindForIntent(kind: RealizationIntentKind): SealedRuntimeCatalogEntry["kind"] {
  if (kind === "assembly") return "assembly_kit";
  if (kind === "route_network") return "route_kit";
  if (kind === "socket_attachment" || kind === "wall_attachment") return "attachment_set";
  if (kind === "environment_layer") return "environment_realizer";
  return "substitution_set";
}

function realizeAssembly(
  state: CompilerState,
  intent: Extract<RealizationIntent, { kind: "assembly" }>,
  entry: SealedRuntimeCatalogEntry,
): void {
  if (entry.kind !== "assembly_kit") throw new Error(`assembly intent resolved to ${entry.kind}`);
  const subdivision = state.input.spatialPlan.lotPolicies.find(
    (policy) => policy.policyId === intent.lotPolicyId,
  );
  const compiledLots = subdivision
    ? state.input.spatialPlan.regions.find((region) => region.regionId === subdivision.regionId)
    : undefined;
  const program = state.input.spatialPlan.structuralPrograms.find(
    (candidate) => candidate.programId === intent.programId,
  );
  if (!subdivision || !compiledLots || !program)
    throw new Error("assembly policy or program is missing");
  const foundationLots = state.foundation.lotSubdivisions.find(
    (candidate) => candidate.policy.policyId === subdivision.policyId,
  );
  const lot = foundationLots?.lots[0];
  if (!lot) throw new Error("assembly region has no eligible lot");
  const programHash = contentHash(stableJson(program));
  validateAssemblyTopology(program, entry);
  const cells = program.placements.map((placement) => {
    const slot = program.slots.find((candidate) => candidate.slotId === placement.cell.slotId);
    if (!slot) throw new Error(`unknown structural slot ${placement.cell.slotId}`);
    if (slot.roleSchemeId !== entry.declaration.roleSchemeId)
      throw new Error(`structural slot ${slot.slotId} uses the wrong role scheme`);
    const providerDeclaration = exactlyOne(
      entry.declaration.providers.filter((provider) => provider.roleId === slot.roleId),
      `provider declaration for role ${slot.roleId}`,
    );
    const requiredInterfaces = interfacesForCell(program, placement.cell);
    const candidates = providerDeclaration.providerHandles.flatMap((handle) => {
      const provider = state.entries.get(handle);
      if (!provider || provider.kind !== "substitution_set") return [];
      const eligibleMembers = assemblyMembers(state, provider, requiredInterfaces);
      const weight = eligibleMembers.reduce((sum, member) => sum + member.selectionWeight, 0);
      return weight > 0 ? [{ candidateId: handle, weight }] : [];
    });
    if (candidates.length === 0)
      throw new Error(
        `assembly cell ${structuralCellKey(placement.cell)} has no eligible provider`,
      );
    return {
      cellId: structuralCellId(intent.intentId, placement.cell),
      cell: placement.cell,
      placement,
      slot,
      requiredInterfaces,
      candidates,
    };
  });
  const byCellId = uniqueMap(cells, (cell) => cell.cellId, "structural cell");
  const relations = program.connections.map((connection) => {
    const host = required(
      byCellId,
      structuralCellId(intent.intentId, connection.host),
      "host cell",
    );
    const child = required(
      byCellId,
      structuralCellId(intent.intentId, connection.child),
      "child cell",
    );
    const transition = entry.declaration.transitions.find(
      (candidate) =>
        candidate.fromRoleId === host.slot.roleId &&
        candidate.toRoleId === child.slot.roleId &&
        candidate.hostInterfaceId === connection.host.interfaceId &&
        candidate.childInterfaceId === connection.child.interfaceId,
    );
    if (!transition)
      throw new Error(`connection ${connection.connectionId} is not admitted by the kit grammar`);
    if (
      !entry.declaration.allowedMates.some(
        (mate) =>
          mate.firstInterfaceId === transition.hostInterfaceId &&
          mate.secondInterfaceId === transition.childInterfaceId,
      )
    )
      throw new Error(`connection ${connection.connectionId} uses interfaces that cannot mate`);
    const relationId = `relation_${contentHash(stableJson(connection)).slice(0, 24)}`;
    const allowed = host.candidates.flatMap((hostCandidate) =>
      child.candidates.flatMap((childCandidate) =>
        candidatePairSupports(
          state,
          hostCandidate.candidateId,
          connection.host.interfaceId,
          childCandidate.candidateId,
          connection.child.interfaceId,
        )
          ? [[hostCandidate.candidateId, childCandidate.candidateId] as [string, string]]
          : [],
      ),
    );
    if (allowed.length === 0)
      throw new Error(
        `connection ${connection.connectionId} has no geometrically evidenced provider pair`,
      );
    return { connection, host, child, relationId, allowed };
  });
  const assemblyPolicy = assemblyExecutionPolicy(state);
  const model = sealConstraintModel({
    seed: Number.parseInt(contentHash(stableJson(intent)).slice(0, 8), 16),
    cells: cells.map(({ cellId, candidates }) => ({ cellId, candidates })),
    edges: relations.map(({ connection, host, child, relationId }) => ({
      edgeId: contentAddressedEntityId("Edge", {
        intentId: intent.intentId,
        connectionId: connection.connectionId,
      }),
      fromCellId: host.cellId,
      toCellId: child.cellId,
      relationId,
      policy: "directed" as const,
    })),
    relations: relations.map(({ relationId, allowed }) => ({ relationId, allowed })),
    policy: {
      maximumDecisions: assemblyPolicy.maximumDecisions,
      maximumBacktracks: assemblyPolicy.maximumBacktracks,
    },
  });
  const solution = solveConstraintModel(model);
  if (solution.status !== "eligible")
    throw new Error(
      `${solution.diagnostics.join("; ")}; assembly execution policy ${assemblyPolicy.policyId} ` +
        `allocated ${assemblyPolicy.maximumDecisions} decisions and ${assemblyPolicy.maximumBacktracks} backtracks ` +
        `(${assemblyPolicy.origin})`,
    );
  const pitchMeters = dequantizeQ32_32(entry.declaration.lattice.pitchMeters);
  const components = solution.assignments.map((assignment) => {
    const provider = state.entries.get(assignment.candidateId);
    if (!provider || provider.kind !== "substitution_set")
      throw new Error(`assembly provider ${assignment.candidateId} is unavailable or non-leaf`);
    const cell = required(byCellId, assignment.cellId, "solved structural cell");
    const members = assemblyMembers(state, provider, cell.requiredInterfaces);
    const member = weightedMember(
      members,
      contentHash(`${intent.intentId}:${cell.cellId}:${provider.entryHash}`),
    );
    const asset = required(state.assets, member.assetHash, "assembly member asset");
    const source = { member, asset };
    const position = latticePosition(lot.boundsMeters.min, cell.placement.lattice, pitchMeters);
    const expectedFloorY =
      lot.boundsMeters.min.y + cell.slot.floorIndex * program.floorHeightMeters;
    if (Math.abs(position.y - expectedFloorY) > Math.max(1e-6, pitchMeters * 1e-6))
      throw new Error(
        `component ${cell.cellId} lattice height does not match floor ${cell.slot.floorIndex}`,
      );
    const rotation = quarterTurnQuaternion(cell.placement.lattice.yawQuarterTurns);
    const instance = buildInstance(
      intent,
      provider,
      source,
      position,
      intent.regionId,
      undefined,
      {
        roleSchemeId: cell.slot.roleSchemeId,
        roleId: cell.slot.roleId,
      },
      rotation,
    );
    assertBoundsInside(
      instance.boundsMeters,
      lot.boundsMeters,
      `component ${instance.instanceId} leaves its lot`,
    );
    assertInstanceInsideRegion(state.input.spatialPlan, instance);
    return { cell, provider, source, instance };
  });
  const componentByCellId = uniqueMap(
    components,
    (component) => component.cell.cellId,
    "assembly component",
  );
  const connections = relations.map(({ connection, host, child }) =>
    realizeAssemblyConnection(
      required(componentByCellId, host.cellId, "host assembly component"),
      required(componentByCellId, child.cellId, "child assembly component"),
      connection,
      pitchMeters,
    ),
  );
  const stairDrafts = createProceduralStairDrafts(
    intent,
    program,
    programHash,
    lot.boundsMeters,
    pitchMeters,
  );
  const assembly = sealAssemblyArtifact({
    regionId: intent.regionId,
    kitEntryHash: entry.entryHash,
    lotHash: lot.hash,
    structuralProgramHash: programHash,
    constraintModelHash: model.hash,
    constraintSolutionHash: solution.hash,
    componentInstanceIds: components.map((component) => component.instance.instanceId),
    connections,
    constructedSurfaceIds: program.constructedSurfaces.map((surface) => surface.surfaceId),
    portalIds: program.portals.map((portal) => portal.portalId),
    proceduralStairIds: stairDrafts.map((stair) => stair.stairId),
  });
  const constructedSurfaces = program.constructedSurfaces.map((declaration) => {
    const source = required(
      componentByCellId,
      structuralCellId(intent.intentId, declaration.source),
      "constructed surface component",
    );
    return sealConstructedSurface({
      surfaceId: declaration.surfaceId,
      floorIndex: source.cell.slot.floorIndex,
      regionId: intent.regionId,
      kind: declaration.kind,
      bounds: source.instance.boundsMeters,
      normal: normalized(rotate(declaration.localNormal, source.instance.transformMeters.rotation)),
      sourceHash: contentHash(stableJson({ assemblyHash: assembly.hash, declaration })),
      assemblyHash: assembly.hash,
      sourceComponentInstanceId: source.instance.instanceId,
    });
  });
  const portals = program.portals.map((declaration) =>
    realizePortal(
      intent,
      assembly,
      declaration,
      required(
        componentByCellId,
        structuralCellId(intent.intentId, declaration.source),
        "portal source component",
      ),
    ),
  );
  const rooms = program.rooms.map((declaration) => {
    const entity = state.input.spatialPlan.semanticEntities.find(
      (candidate) => candidate.entityId === declaration.semanticEntityId,
    );
    if (!entity || entity.upperSort !== "space")
      throw new Error(`room ${declaration.roomId} lacks an admitted space entity`);
    return sealRoomArtifact({
      roomId: declaration.roomId,
      floorIndex: declaration.floorIndex,
      regionId: intent.regionId,
      semanticDependencyClosureHash: entity.semanticDependencyClosureHash,
      assemblyHash: assembly.hash,
      surfaceIds: declaration.surfaceIds,
      portalIds: declaration.portalIds,
    });
  });
  const stairs = stairDrafts.map((draft) =>
    sealProceduralStairArtifact({ ...draft, assemblyHash: assembly.hash }),
  );
  const checkpoint = state.occupancy.checkpoint();
  try {
    state.occupancy.reserveBatch([
      ...components.map((component) => reservationFor(component.instance, component.source.asset)),
      ...stairs.map((stair) => stairReservation(stair)),
    ]);
    for (const portal of portals)
      verifyPortalClearance(
        state,
        portal,
        components.map((component) => component.instance),
      );
  } catch (error) {
    state.occupancy.restore(checkpoint);
    throw error;
  }
  state.mesoInstances.push(...components.map((component) => component.instance));
  state.assemblies.push(assembly);
  state.constructedSurfaces.push(...constructedSurfaces);
  state.portals.push(...portals);
  state.rooms.push(...rooms);
  state.proceduralStairs.push(...stairs);
}

type AssemblyKitEntry = Extract<SealedRuntimeCatalogEntry, { kind: "assembly_kit" }>;
type SubstitutionEntry = Extract<SealedRuntimeCatalogEntry, { kind: "substitution_set" }>;
type StructuralProgram = SpatialWorldPlan["structuralPrograms"][number];
type StructuralCellReference = StructuralProgram["placements"][number]["cell"];
type ProgramConnection = StructuralProgram["connections"][number];
type AssemblyMember = SubstitutionEntry["memberAssets"][number];
type AssemblyComponent = {
  readonly cell: {
    readonly cellId: string;
    readonly cell: StructuralCellReference;
    readonly placement: StructuralProgram["placements"][number];
    readonly slot: StructuralProgram["slots"][number];
    readonly requiredInterfaces: readonly string[];
  };
  readonly provider: SubstitutionEntry;
  readonly source: { readonly member: AssemblyMember; readonly asset: CatalogAssetArtifact };
  readonly instance: RealizedInstance;
};

function validateAssemblyTopology(program: StructuralProgram, entry: AssemblyKitEntry): void {
  const roleCounts = new Map<string, number>();
  for (const slot of program.slots)
    roleCounts.set(slot.roleId, (roleCounts.get(slot.roleId) ?? 0) + slot.minimumCount);
  for (const provider of entry.declaration.providers) {
    const count = roleCounts.get(provider.roleId) ?? 0;
    if (count < provider.minimumCount || count > provider.maximumCount)
      throw new Error(`role ${provider.roleId} violates kit coverage bounds`);
  }
  for (const roleId of entry.declaration.requiredCoverageRoleIds)
    if ((roleCounts.get(roleId) ?? 0) === 0)
      throw new Error(`assembly omits required role ${roleId}`);
  if (program.connections.length < entry.declaration.topology.minimumConnections)
    throw new Error("assembly does not meet the kit minimum connection count");
  const cells = program.placements.map((placement) => structuralCellKey(placement.cell));
  if (cells.length <= 1) return;
  const adjacency = new Map(cells.map((cell) => [cell, new Set<string>()]));
  for (const connection of program.connections) {
    const host = structuralCellKey(connection.host);
    const child = structuralCellKey(connection.child);
    required(adjacency, host, "connection host").add(child);
    required(adjacency, child, "connection child").add(host);
  }
  const visited = new Set<string>();
  const pending = [cells[0]!];
  while (pending.length > 0) {
    const cell = pending.pop()!;
    if (visited.has(cell)) continue;
    visited.add(cell);
    pending.push(...required(adjacency, cell, "topology cell"));
  }
  if (entry.declaration.topology.connectivity === "connected" && visited.size !== cells.length)
    throw new Error("assembly topology is disconnected");
  if (
    entry.declaration.topology.cyclePolicy === "forbidden" &&
    program.connections.length >= cells.length
  )
    throw new Error("assembly topology contains a forbidden cycle");
  const terminalRoles = new Set(entry.declaration.terminalRoleIds);
  if (terminalRoles.size > 0)
    for (const placement of program.placements) {
      const slot = program.slots.find((candidate) => candidate.slotId === placement.cell.slotId)!;
      if (
        required(adjacency, structuralCellKey(placement.cell), "topology cell").size <= 1 &&
        !terminalRoles.has(slot.roleId)
      )
        throw new Error(
          `terminal cell ${structuralCellKey(placement.cell)} uses non-terminal role ${slot.roleId}`,
        );
    }
}

function interfacesForCell(program: StructuralProgram, cell: StructuralCellReference): string[] {
  return [
    ...new Set(
      program.connections.flatMap((connection) => {
        if (sameStructuralCell(connection.host, cell)) return [connection.host.interfaceId];
        if (sameStructuralCell(connection.child, cell)) return [connection.child.interfaceId];
        return [];
      }),
    ),
  ].sort(compareCanonicalStrings);
}

function assemblyMembers(
  state: CompilerState,
  provider: SubstitutionEntry,
  interfaceIds: readonly string[],
): AssemblyMember[] {
  return provider.memberAssets.filter((member) => {
    const asset = state.assets.get(member.assetHash);
    return (
      asset !== undefined &&
      interfaceIds.every((interfaceId) => {
        const binding = member.socketBindings.find(
          (candidate) => candidate.interfaceId === interfaceId,
        );
        return (
          binding !== undefined &&
          asset.sockets.some((socket) => socket.socketId === binding.socketId)
        );
      })
    );
  });
}

function candidatePairSupports(
  state: CompilerState,
  hostHandle: string,
  hostInterfaceId: string,
  childHandle: string,
  childInterfaceId: string,
): boolean {
  const host = state.entries.get(hostHandle);
  const child = state.entries.get(childHandle);
  if (!host || host.kind !== "substitution_set" || !child || child.kind !== "substitution_set")
    return false;
  return assemblyMembers(state, host, [hostInterfaceId]).some((hostMember) =>
    assemblyMembers(state, child, [childInterfaceId]).some((childMember) => {
      const hostBinding = hostMember.socketBindings.find(
        (binding) => binding.interfaceId === hostInterfaceId,
      )!;
      const childBinding = childMember.socketBindings.find(
        (binding) => binding.interfaceId === childInterfaceId,
      )!;
      return socketPolaritiesMate(hostBinding.polarity, childBinding.polarity);
    }),
  );
}

function realizeAssemblyConnection(
  host: AssemblyComponent,
  child: AssemblyComponent,
  connection: ProgramConnection,
  pitchMeters: number,
): AssemblyArtifact["connections"][number] {
  const hostSocket = exactAssemblySocket(host, connection.host.interfaceId);
  const childSocket = exactAssemblySocket(child, connection.child.interfaceId);
  if (!socketPolaritiesMate(hostSocket.binding.polarity, childSocket.binding.polarity))
    throw new Error(`connection ${connection.connectionId} has incompatible socket polarities`);
  const hostPose = worldSocketPose(host.instance, hostSocket.socket);
  const childPose = worldSocketPose(child.instance, childSocket.socket);
  const tolerance = Math.max(1e-4, pitchMeters * 1e-3);
  if (distance(hostPose.position, childPose.position) > tolerance)
    throw new Error(`connection ${connection.connectionId} endpoints do not coincide`);
  if (dot(hostPose.normal, childPose.normal) > -0.999)
    throw new Error(`connection ${connection.connectionId} socket normals do not oppose`);
  return {
    connectionId: connection.connectionId,
    host: { instanceId: host.instance.instanceId, socketId: hostSocket.socket.socketId },
    child: { instanceId: child.instance.instanceId, socketId: childSocket.socket.socketId },
    hostInterfaceId: connection.host.interfaceId,
    childInterfaceId: connection.child.interfaceId,
    evidenceHashes: [hostSocket.socket.evidenceHash, childSocket.socket.evidenceHash].sort(
      compareCanonicalStrings,
    ),
  };
}

function exactAssemblySocket(component: AssemblyComponent, interfaceId: string) {
  const bindings = component.source.member.socketBindings.filter(
    (binding) => binding.interfaceId === interfaceId,
  );
  const binding = exactlyOne(bindings, `member interface ${interfaceId}`);
  const socket = component.source.asset.sockets.find(
    (candidate) => candidate.socketId === binding.socketId,
  );
  if (!socket) throw new Error(`measured socket ${binding.socketId} is unavailable`);
  return { binding, socket };
}

function worldSocketPose(
  instance: RealizedInstance,
  socket: CatalogAssetArtifact["sockets"][number],
) {
  return {
    position: add(
      instance.transformMeters.position,
      rotate(fixedVector(socket.localOriginMeters), instance.transformMeters.rotation),
    ),
    normal: normalized(rotate(fixedVector(socket.normal), instance.transformMeters.rotation)),
    up: normalized(rotate(fixedVector(socket.up), instance.transformMeters.rotation)),
  };
}

function realizePortal(
  intent: Extract<RealizationIntent, { kind: "assembly" }>,
  assembly: AssemblyArtifact,
  declaration: StructuralProgram["portals"][number],
  source: AssemblyComponent,
): PortalArtifact {
  const binding = source.source.member.socketBindings.find(
    (candidate) => candidate.socketId === declaration.socketId,
  );
  const socket = source.source.asset.sockets.find(
    (candidate) => candidate.socketId === declaration.socketId,
  );
  if (!binding || !socket)
    throw new Error(`portal ${declaration.portalId} lacks an authored measured opening`);
  const radius = dequantizeQ32_32(socket.boundaryRadiusMeters);
  if (Math.hypot(declaration.widthMeters / 2, declaration.heightMeters / 2) > radius + 1e-9)
    throw new Error(`portal ${declaration.portalId} exceeds its measured opening boundary`);
  return sealPortalArtifact({
    portalId: declaration.portalId,
    floorIndex: source.cell.slot.floorIndex,
    regionId: intent.regionId,
    assemblyHash: assembly.hash,
    opening: { instanceId: source.instance.instanceId, socketId: socket.socketId },
    openingPoseMeters: worldSocketPose(source.instance, socket),
    adjacentRoomIds: declaration.adjacentRoomIds,
    widthMeters: declaration.widthMeters,
    heightMeters: declaration.heightMeters,
    clearanceMeters: declaration.clearanceMeters,
    evidenceHashes: [socket.evidenceHash, source.source.member.assertionBundleHash],
  });
}

function createProceduralStairDrafts(
  intent: Extract<RealizationIntent, { kind: "assembly" }>,
  program: StructuralProgram,
  programHash: string,
  lotBounds: RealizedInstance["boundsMeters"],
  pitchMeters: number,
): Array<Omit<ProceduralStairArtifact, "kind" | "hash" | "assemblyHash">> {
  return program.proceduralStairs.map((declaration) => {
    const rise = (declaration.toFloor - declaration.fromFloor) * program.floorHeightMeters;
    const stepCount = Math.ceil(rise / declaration.maximumRiserHeightMeters);
    const riserHeight = rise / stepCount;
    const rotation = quarterTurnQuaternion(declaration.originLattice.yawQuarterTurns);
    const origin = latticePosition(lotBounds.min, declaration.originLattice, pitchMeters);
    const stepBoundsMeters = Array.from({ length: stepCount }, (_, index) => {
      const height = (index + 1) * riserHeight;
      const center = add(
        origin,
        rotate(
          {
            x: 0,
            y: height / 2 + declaration.fromFloor * program.floorHeightMeters,
            z: (index + 0.5) * declaration.treadDepthMeters,
          },
          rotation,
        ),
      );
      const half = {
        x: declaration.widthMeters / 2,
        y: height / 2,
        z: declaration.treadDepthMeters / 2,
      };
      return rotatedBoxBounds(center, half, rotation);
    });
    for (const bounds of stepBoundsMeters)
      assertBoundsInside(
        bounds,
        lotBounds,
        `procedural stair ${declaration.generatorId} leaves its lot`,
      );
    const generatorEvidenceHash = contentHash(
      stableJson({
        algorithm: "bounded_rectilinear_stair",
        declaration,
        floorHeightMeters: program.floorHeightMeters,
        pitchMeters,
        stepCount,
      }),
    );
    return {
      stairId: contentAddressedEntityId("Stair", {
        intentId: intent.intentId,
        programHash,
        generatorId: declaration.generatorId,
      }),
      generatorId: declaration.generatorId,
      regionId: intent.regionId,
      structuralProgramHash: programHash,
      fromFloor: declaration.fromFloor,
      toFloor: declaration.toFloor,
      widthMeters: declaration.widthMeters,
      treadDepthMeters: declaration.treadDepthMeters,
      maximumRiserHeightMeters: declaration.maximumRiserHeightMeters,
      stepBoundsMeters,
      generatorEvidenceHash,
    };
  });
}

function stairReservation(stair: ProceduralStairArtifact) {
  const bounds = unionBounds(stair.stepBoundsMeters);
  return sealOccupancyReservation({
    sourceInstanceId: stair.stairId,
    surfaceId: "ProceduralStructure",
    stratum: "procedural_stair",
    bounds,
    narrowPhaseObbs: [],
  });
}

function verifyPortalClearance(
  state: CompilerState,
  portal: PortalArtifact,
  components: readonly RealizedInstance[],
): void {
  if (portal.clearanceMeters === 0) return;
  const center = add(
    portal.openingPoseMeters.position,
    scale(portal.openingPoseMeters.normal, portal.clearanceMeters / 2),
  );
  const rotation = alignFrames(
    { x: 0, y: 0, z: 1 },
    { x: 0, y: 1, z: 0 },
    portal.openingPoseMeters.normal,
    portal.openingPoseMeters.up,
  );
  const bounds = rotatedBoxBounds(
    center,
    { x: portal.widthMeters / 2, y: portal.heightMeters / 2, z: portal.clearanceMeters / 2 },
    rotation,
  );
  const probe = sealOccupancyReservation({
    sourceInstanceId: contentAddressedEntityId("PortalClearance", { portalHash: portal.hash }),
    surfaceId: "PortalClearance",
    stratum: "portal_clearance",
    bounds,
    narrowPhaseObbs: [],
  });
  const ignored = components
    .filter((component) => component.instanceId === portal.opening.instanceId)
    .map((component) => component.instanceId);
  const conflicts = state.occupancy.conflicts(probe, 0, ignored);
  if (conflicts.length > 0) throw new Error(`portal ${portal.portalId} clearance is obstructed`);
}

function rotatedBoxBounds(
  center: WorldVector3,
  half: WorldVector3,
  rotation: readonly [number, number, number, number],
) {
  const corners = [-1, 1].flatMap((x) =>
    [-1, 1].flatMap((y) =>
      [-1, 1].map((z) =>
        add(center, rotate({ x: x * half.x, y: y * half.y, z: z * half.z }, rotation)),
      ),
    ),
  );
  return {
    min: {
      x: Math.min(...corners.map((point) => point.x)),
      y: Math.min(...corners.map((point) => point.y)),
      z: Math.min(...corners.map((point) => point.z)),
    },
    max: {
      x: Math.max(...corners.map((point) => point.x)),
      y: Math.max(...corners.map((point) => point.y)),
      z: Math.max(...corners.map((point) => point.z)),
    },
  };
}

function unionBounds(bounds: readonly RealizedInstance["boundsMeters"][]) {
  if (bounds.length === 0) throw new Error("cannot union empty bounds");
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

function assertBoundsInside(
  inner: RealizedInstance["boundsMeters"],
  outer: RealizedInstance["boundsMeters"],
  message: string,
): void {
  if (
    inner.min.x < outer.min.x - 1e-9 ||
    inner.min.y < outer.min.y - 1e-9 ||
    inner.min.z < outer.min.z - 1e-9 ||
    inner.max.x > outer.max.x + 1e-9 ||
    inner.max.y > outer.max.y + 1e-9 ||
    inner.max.z > outer.max.z + 1e-9
  )
    throw new Error(message);
}

function latticePosition(
  origin: WorldVector3,
  lattice: { readonly x: number; readonly y: number; readonly z: number },
  pitchMeters: number,
): WorldVector3 {
  return {
    x: origin.x + lattice.x * pitchMeters,
    y: origin.y + lattice.y * pitchMeters,
    z: origin.z + lattice.z * pitchMeters,
  };
}

function quarterTurnQuaternion(turns: number): [number, number, number, number] {
  const angle = (turns * Math.PI) / 2;
  return [0, Math.sin(angle / 2), 0, Math.cos(angle / 2)];
}

function structuralCellKey(cell: StructuralCellReference): string {
  return `${cell.slotId}:${cell.ordinal}`;
}

function structuralCellId(intentId: string, cell: StructuralCellReference): string {
  return contentAddressedEntityId("StructuralCell", {
    intentId,
    slotId: cell.slotId,
    ordinal: cell.ordinal,
  });
}

function sameStructuralCell(
  left: StructuralCellReference,
  right: StructuralCellReference,
): boolean {
  return left.slotId === right.slotId && left.ordinal === right.ordinal;
}

function exactlyOne<T>(values: readonly T[], label: string): T {
  if (values.length !== 1) throw new Error(`${label} must resolve exactly once`);
  return values[0]!;
}

function required<T>(values: ReadonlyMap<string, T>, key: string, label: string): T {
  const value = values.get(key);
  if (!value) throw new Error(`unknown ${label}: ${key}`);
  return value;
}

interface Target {
  readonly position: WorldVector3;
  readonly regionId?: string | undefined;
  readonly surfaceId?: string | undefined;
  readonly rotation?: [number, number, number, number] | undefined;
}
function targetsForIntent(
  state: CompilerState,
  intent: Exclude<RealizationIntent, { kind: "assembly" }>,
): Iterable<Target> {
  const plan = state.input.spatialPlan;
  if (intent.kind === "single") {
    const radius = intent.positionToleranceMeters ?? 0;
    const centers = [{ x: intent.at.u, z: intent.at.v }];
    // This prefix-stable disk sequence makes candidate allocation operational. Increasing
    // the allocation extends the same search instead of moving candidates already tried.
    if (radius > 0) {
      const policy = populationExecutionPolicy(state);
      for (let attempt = 1; attempt < policy.pointPlacementCandidateAttempts; attempt++) {
        const radial = Math.sqrt(radicalInverse(attempt, 2));
        const angle = 2 * Math.PI * radicalInverse(attempt, 3);
        centers.push({
          x: intent.at.u + radius * radial * Math.cos(angle),
          z: intent.at.v + radius * radial * Math.sin(angle),
        });
      }
    }
    const surface = state.foundation.placementSurfaces.find(
      (s) => s.surfaceId === intent.surfaceId,
    );
    return centers
      .filter(
        (p) =>
          surface &&
          p.x >= surface.bounds.min.x &&
          p.x <= surface.bounds.max.x &&
          p.z >= surface.bounds.min.z &&
          p.z <= surface.bounds.max.z,
      )
      .map((point) => ({
        position: {
          x: point.x,
          y: surfaceHeight(state, intent.surfaceId, point.x, point.z),
          z: point.z,
        },
        regionId: intent.regionId,
        surfaceId: intent.surfaceId,
        ...(intent.yawDegrees === undefined
          ? {}
          : {
              rotation: [
                0,
                Math.sin((intent.yawDegrees * Math.PI) / 360),
                0,
                Math.cos((intent.yawDegrees * Math.PI) / 360),
              ] as [number, number, number, number],
            }),
      }));
  }
  if (intent.kind === "wall_attachment") return [wallAttachmentTarget(state, intent)];
  if (intent.kind === "surface_scatter")
    return scatterTargets(
      state,
      intent,
      populationCandidateAttemptLimit(state, intent.targetCount),
      contentHash(stableJson(intent)),
    );
  if (intent.kind === "cluster")
    return clusterTargets(
      state,
      intent,
      populationCandidateAttemptLimit(state, intent.targetCount),
      contentHash(stableJson(intent)),
    );
  if (intent.kind === "surface_grid")
    return Array.from({ length: intent.rows * intent.columns }, (_, index) => {
      const x = intent.origin.u + (index % intent.columns) * intent.spacingUMeters;
      const z = intent.origin.v + Math.floor(index / intent.columns) * intent.spacingVMeters;
      return {
        position: { x, y: surfaceHeight(state, intent.surfaceId, x, z), z },
        regionId: intent.regionId,
        surfaceId: intent.surfaceId,
      };
    });
  if (intent.kind === "along_route") {
    const route = plan.routes.find((candidate) => candidate.routeId === intent.routeId);
    if (!route) throw new Error(`unknown route ${intent.routeId}`);
    return Array.from({ length: intent.count }, (_, index) => ({
      position: offsetRoute(
        sampleRouteFrame(routeProfilePoints(state, route.routeId), (index + 0.5) / intent.count),
        intent.lateralOffsetMeters,
      ),
      regionId: intent.regionId,
      surfaceId: route.surfaceId,
    }));
  }
  if (intent.kind === "route_network")
    return intent.routeIds.map((routeId) => {
      const route = plan.routes.find((candidate) => candidate.routeId === routeId);
      if (!route) throw new Error(`unknown route ${routeId}`);
      return {
        position: sampleRoute(routeProfilePoints(state, route.routeId), 0.5),
        regionId: route.regionIds[0],
        surfaceId: route.surfaceId,
      };
    });
  if (intent.kind === "environment_layer")
    return intent.regionIds.map((regionId) => {
      const region = plan.regions.find((candidate) => candidate.regionId === regionId);
      if (!region) throw new Error(`unknown region ${regionId}`);
      const bounds = worldRegionVolumeBounds(region.volume);
      return {
        position: {
          x: (bounds.min.x + bounds.max.x) / 2,
          y: bounds.max.y,
          z: (bounds.min.z + bounds.max.z) / 2,
        },
        regionId,
      };
    });
  throw new Error("socket attachments require exact interface realization");
}

function realizeSocketAttachment(
  state: CompilerState,
  intent: Extract<RealizationIntent, { kind: "socket_attachment" }>,
  entry: SealedRuntimeCatalogEntry,
  source: {
    member: SealedRuntimeCatalogEntry["memberAssets"][number];
    asset: CatalogAssetArtifact;
    placementGeometry?: AssetPlacementGeometry;
  },
): { instance: RealizedInstance; hostInstanceId: string } {
  if (entry.kind !== "attachment_set")
    throw new Error(`socket attachment resolved to ${entry.kind}`);
  const host = [...state.mesoInstances, ...state.microInstances].find(
    (instance) => instance.instanceId === intent.host.instanceId,
  );
  if (!host) throw new Error(`unknown socket host ${intent.host.instanceId}`);
  const hostEntry = state.entries.get(host.entryHandle);
  const hostAsset = state.assets.get(host.assetHash);
  const hostMember = hostEntry?.memberAssets.find(
    (member) => member.memberId === host.memberId && member.assetHash === host.assetHash,
  );
  if (!hostEntry || !hostAsset || !hostMember)
    throw new Error(`socket host ${host.instanceId} lacks exact catalog provenance`);
  const hostBinding = hostMember.socketBindings.find(
    (binding) => binding.socketId === intent.host.socketId,
  );
  const hostSocket = hostAsset.sockets.find((socket) => socket.socketId === intent.host.socketId);
  if (!hostBinding || !hostSocket)
    throw new Error(`host socket ${intent.host.socketId} lacks authored and measured evidence`);
  if (!entry.declaration.acceptedHostInterfaceIds.includes(hostBinding.interfaceId))
    throw new Error(`attachment set rejects host interface ${hostBinding.interfaceId}`);
  const childBinding = source.member.socketBindings.find(
    (binding) =>
      binding.interfaceId === hostBinding.interfaceId &&
      socketPolaritiesMate(hostBinding.polarity, binding.polarity),
  );
  if (!childBinding)
    throw new Error(`attachment member has no mating interface ${hostBinding.interfaceId}`);
  const childSocket = source.asset.sockets.find(
    (socket) => socket.socketId === childBinding.socketId,
  );
  if (!childSocket)
    throw new Error(`child socket ${childBinding.socketId} lacks measured evidence`);

  const hostOrigin = add(
    host.transformMeters.position,
    rotate(fixedVector(hostSocket.localOriginMeters), host.transformMeters.rotation),
  );
  const hostNormal = rotate(fixedVector(hostSocket.normal), host.transformMeters.rotation);
  const hostUp = rotate(fixedVector(hostSocket.up), host.transformMeters.rotation);
  const rotation = alignFrames(
    fixedVector(childSocket.normal),
    fixedVector(childSocket.up),
    scale(hostNormal, -1),
    hostUp,
  );
  const position = subtract(
    hostOrigin,
    rotate(fixedVector(childSocket.localOriginMeters), rotation),
  );
  const instance = buildInstance(
    intent,
    entry,
    source,
    position,
    host.regionId,
    host.surfaceId,
    undefined,
    rotation,
    {
      host: intent.host,
      childSocketId: childSocket.socketId,
      interfaceId: hostBinding.interfaceId,
    },
  );
  assertInstanceInsideRegion(state.input.spatialPlan, instance);
  return { instance, hostInstanceId: host.instanceId };
}

function wallAttachmentTarget(
  state: CompilerState,
  intent: Extract<RealizationIntent, { kind: "wall_attachment" }>,
): Target {
  const surface = [...state.input.spatialPlan.placementSurfaces, ...state.constructedSurfaces].find(
    (candidate) => candidate.surfaceId === intent.surfaceId,
  );
  if (!surface) throw new Error(`unknown surface ${intent.surfaceId}`);
  if (surface.kind !== "constructed_wall")
    throw new Error(`wall attachment requires a constructed wall surface`);
  const normal = normalized(surface.normal);
  if (Math.abs(normal.y) > 1e-6)
    throw new Error(`wall surface ${surface.surfaceId} normal is not horizontal`);
  const dominantX = Math.abs(normal.x) >= Math.abs(normal.z);
  const position = dominantX
    ? {
        x:
          (normal.x >= 0 ? surface.bounds.max.x : surface.bounds.min.x) +
          normal.x * intent.normalOffsetMeters,
        y: intent.at.v,
        z: intent.at.u,
      }
    : {
        x: intent.at.u,
        y: intent.at.v,
        z:
          (normal.z >= 0 ? surface.bounds.max.z : surface.bounds.min.z) +
          normal.z * intent.normalOffsetMeters,
      };
  return {
    position,
    regionId: intent.regionId,
    surfaceId: intent.surfaceId,
    rotation: alignFrames({ x: 0, y: 0, z: 1 }, { x: 0, y: 1, z: 0 }, normal, {
      x: 0,
      y: 1,
      z: 0,
    }),
  };
}

function buildInstance(
  intent: RealizationIntent,
  entry: SealedRuntimeCatalogEntry,
  source: {
    member: SealedRuntimeCatalogEntry["memberAssets"][number];
    asset: CatalogAssetArtifact;
    placementGeometry?: AssetPlacementGeometry;
  },
  position: WorldVector3,
  regionId?: string,
  surfaceId?: string,
  role?: { roleSchemeId: string; roleId: string },
  rotation = yawQuaternion(contentHash(stableJson(intent))),
  connection?: {
    host: { instanceId: string; socketId: string };
    childSocketId: string;
    interfaceId: string;
  },
): RealizedInstance {
  const intentHash = contentHash(stableJson(intent));
  const bounds = transformedBounds(source.asset, position, rotation);
  const sourceKind =
    intent.kind === "assembly"
      ? "assembly_component"
      : intent.kind === "route_network"
        ? "route_component"
        : intent.kind === "socket_attachment" || intent.kind === "wall_attachment"
          ? "attachment"
          : intent.kind === "environment_layer"
            ? "environment"
            : "substitution_member";
  return sealRealizedInstance({
    sourceKind,
    entryHandle: entry.handle,
    entryHash: entry.entryHash,
    memberId: source.member.memberId,
    assetHash: source.asset.hash,
    assertionBundleHash: source.member.assertionBundleHash,
    intentId: intent.intentId,
    intentHash,
    ...(regionId ? { regionId } : {}),
    ...(surfaceId ? { surfaceId } : {}),
    ...(role ?? {}),
    transformMeters: { position, rotation, scale: 1 },
    sourceBoundsMeters: {
      min: fixedVector(source.asset.bounds.min),
      max: fixedVector(source.asset.bounds.max),
    },
    boundsMeters: bounds,
    ...(connection ? { connection } : {}),
    evidenceHashes: [
      ...entry.evidenceHashes,
      ...source.asset.measurementEvidenceHashes,
      ...(source.placementGeometry ? [source.placementGeometry.hash] : []),
    ],
  });
}

function resolveMember(
  state: CompilerState,
  entry: SealedRuntimeCatalogEntry,
  binding: ResolvedCatalogBinding | undefined,
  seed: string,
):
  | {
      member: SealedRuntimeCatalogEntry["memberAssets"][number];
      asset: CatalogAssetArtifact;
      placementGeometry?: AssetPlacementGeometry;
    }
  | undefined {
  const candidates = entry.memberAssets;
  if (candidates.length === 0) {
    for (const child of entry.childEntries) {
      const provider = state.entries.get(child.handle);
      if (provider) {
        const found = resolveMember(state, provider, undefined, seed);
        if (found) return found;
      }
    }
    return undefined;
  }
  const exact = binding?.memberId
    ? candidates.find(
        (candidate) =>
          candidate.memberId === binding.memberId && candidate.assetHash === binding.assetHash,
      )
    : undefined;
  const member = exact ?? weightedMember(candidates, contentHash(`${seed}:${entry.entryHash}`));
  const asset = state.assets.get(member.assetHash);
  const placementGeometry = asset && state.placementGeometry.get(asset.hash);
  return asset ? { member, asset, ...(placementGeometry ? { placementGeometry } : {}) } : undefined;
}

function weightedMember(members: SealedRuntimeCatalogEntry["memberAssets"], hash: string) {
  const total = members.reduce((sum, member) => sum + member.selectionWeight, 0);
  let cursor = Number(BigInt(`0x${hash.slice(0, 12)}`) % BigInt(total));
  for (const member of members) {
    if (cursor < member.selectionWeight) return member;
    cursor -= member.selectionWeight;
  }
  return members.at(-1)!;
}
function transformedBounds(
  asset: CatalogAssetArtifact,
  position: WorldVector3,
  rotation: readonly [number, number, number, number],
) {
  // Part bounds are measured in the canonical asset frame. Rotate each box
  // before taking their union: rotating the aggregate AABB invents corners
  // between separate parts and disagrees with engine bounds at oblique angles.
  // Unpartitioned assets have only the aggregate measured box.
  const boxes = asset.parts.length > 0 ? asset.parts.map((part) => part.bounds) : [asset.bounds];
  const corners = boxes.flatMap((box) => {
    const minimum = fixedVector(box.min);
    const maximum = fixedVector(box.max);
    return [minimum.x, maximum.x].flatMap((x) =>
      [minimum.y, maximum.y].flatMap((y) =>
        [minimum.z, maximum.z].map((z) => add(position, rotate({ x, y, z }, rotation))),
      ),
    );
  });
  return {
    min: {
      x: Math.min(...corners.map((point) => point.x)),
      y: Math.min(...corners.map((point) => point.y)),
      z: Math.min(...corners.map((point) => point.z)),
    },
    max: {
      x: Math.max(...corners.map((point) => point.x)),
      y: Math.max(...corners.map((point) => point.y)),
      z: Math.max(...corners.map((point) => point.z)),
    },
  };
}
function reservationFor(
  instance: RealizedInstance,
  asset: CatalogAssetArtifact,
  clearance = 0,
  geometry?: AssetPlacementGeometry,
) {
  const useGeometry = geometry && asset.collision.mode === "none";
  const obbs: SpatialObb[] = useGeometry
    ? geometry.bands.map((box) => ({
        center: add(
          instance.transformMeters.position,
          rotate(
            {
              x: (box.min.x + box.max.x) / 2,
              y: (box.min.y + box.max.y) / 2,
              z: (box.min.z + box.max.z) / 2,
            },
            instance.transformMeters.rotation,
          ),
        ),
        halfSize: {
          x: (box.max.x - box.min.x) / 2 + clearance,
          y: (box.max.y - box.min.y) / 2,
          z: (box.max.z - box.min.z) / 2 + clearance,
        },
        rotation: instance.transformMeters.rotation,
      }))
    : asset.collision.orientedBounds.map((box) => ({
        center: add(
          instance.transformMeters.position,
          rotate(fixedVector(box.center), instance.transformMeters.rotation),
        ),
        halfSize: {
          x: dequantizeQ32_32(box.halfSize.x) + clearance,
          y: dequantizeQ32_32(box.halfSize.y),
          z: dequantizeQ32_32(box.halfSize.z) + clearance,
        },
        rotation: multiplyQuaternion(instance.transformMeters.rotation, box.rotation),
      }));
  const padding = useGeometry ? 2e-6 : 0;
  const bounds = {
    min: {
      x: instance.boundsMeters.min.x - clearance - padding,
      y: instance.boundsMeters.min.y - padding,
      z: instance.boundsMeters.min.z - clearance - padding,
    },
    max: {
      x: instance.boundsMeters.max.x + clearance + padding,
      y: instance.boundsMeters.max.y + padding,
      z: instance.boundsMeters.max.z + clearance + padding,
    },
  };
  // A local X/Z clearance rotates with each band. Its world-axis extent can exceed
  // the nominal margin; broad phase must enclose every expanded narrow-phase corner.
  if (useGeometry)
    for (const box of obbs)
      for (const x of [-box.halfSize.x, box.halfSize.x])
        for (const y of [-box.halfSize.y, box.halfSize.y])
          for (const z of [-box.halfSize.z, box.halfSize.z]) {
            const point = add(box.center, rotate({ x, y, z }, box.rotation));
            for (const axis of ["x", "y", "z"] as const) {
              bounds.min[axis] = Math.min(bounds.min[axis], point[axis]);
              bounds.max[axis] = Math.max(bounds.max[axis], point[axis]);
            }
          }
  return sealOccupancyReservation({
    sourceInstanceId: instance.instanceId,
    surfaceId: instance.surfaceId ?? "Environment",
    stratum: instance.sourceKind,
    bounds,
    ...(useGeometry || asset.collision.evidenceHash
      ? { collisionEvidenceHash: useGeometry ? geometry.hash : asset.collision.evidenceHash! }
      : {}),
    narrowPhaseObbs: obbs,
  });
}
function surfaceHeight(
  state: CompilerState,
  surfaceId: string,
  xMeters: number,
  zMeters: number,
): number {
  const surface = [...state.input.spatialPlan.placementSurfaces, ...state.constructedSurfaces].find(
    (candidate) => candidate.surfaceId === surfaceId,
  );
  if (!surface) throw new Error(`unknown surface ${surfaceId}`);
  const terrainFields = state.foundation.terrainFields.filter(
    (candidate) => candidate.surfaceId === surfaceId,
  );
  if (terrainFields.length > 1) throw new Error(`surface ${surfaceId} has ambiguous terrain`);
  if (terrainFields[0]) {
    const base = state.foundation.baseTerrainFields.find(
      (candidate) => candidate.hash === terrainFields[0]!.baseTerrainFieldHash,
    );
    if (!base) throw new Error(`surface ${surfaceId} has no base terrain`);
    return sampleTerrainFieldElevation(
      terrainFields[0],
      base,
      state.foundation.routeConstructions,
      state.foundation.routeJunctions,
      xMeters,
      zMeters,
    );
  }
  return surface.bounds.max.y;
}
function routeProfilePoints(state: CompilerState, routeId: string): WorldVector3[] {
  const route = state.foundation.routeConstructions.find((entry) => entry.routeId === routeId);
  if (!route) throw new Error(`unknown resolved route ${routeId}`);
  if (route.status !== "eligible")
    throw new Error(`route ${routeId} is ${route.status}: ${route.diagnostics.join("; ")}`);
  return route.profile.map((station) => ({ ...station.centerTopMeters }));
}
function orderedIntents(intents: readonly RealizationIntent[]): RealizationIntent[] {
  return [...intents].sort(
    (a, b) => b.priority - a.priority || compareCanonicalStrings(a.intentId, b.intentId),
  );
}
function requiredCount(intent: RealizationIntent): number {
  if (intent.kind === "surface_scatter" || intent.kind === "cluster") return intent.minimumCount;
  if (intent.kind === "surface_grid") return intent.columns * intent.rows;
  if (intent.kind === "along_route") return intent.count;
  if (intent.kind === "route_network") return intent.routeIds.length;
  if (intent.kind === "environment_layer") return intent.regionIds.length;
  return 1;
}
function desiredCount(intent: RealizationIntent): number {
  if (intent.kind === "surface_scatter" || intent.kind === "cluster") return intent.targetCount;
  return requiredCount(intent);
}
function stageStatus(
  resolution: CompilationStatus,
  diagnostics: readonly string[],
): CompilationStatus {
  if (resolution === "rejected") return "rejected";
  return resolution === "incomplete" || diagnostics.length > 0 ? "incomplete" : "eligible";
}
function combineCompilationStatuses(
  left: CompilationStatus,
  right: CompilationStatus,
): CompilationStatus {
  if (left === "rejected" || right === "rejected") return "rejected";
  return left === "incomplete" || right === "incomplete" ? "incomplete" : "eligible";
}
function yawQuaternion(hash: string): [number, number, number, number] {
  const angle = (Number.parseInt(hash.slice(0, 8), 16) / 0xffff_ffff) * Math.PI * 2;
  return [0, Math.sin(angle / 2), 0, Math.cos(angle / 2)];
}
function populationCandidateAttemptLimit(state: CompilerState, targetCount: number): number {
  const policy = populationExecutionPolicy(state);
  const scaled = targetCount * policy.candidateAttemptsPerTarget;
  if (!Number.isSafeInteger(scaled))
    throw new Error("Population candidate allocation exceeds exact integer representation");
  return Math.max(policy.minimumCandidateAttempts, scaled);
}

function populationExecutionPolicy(state: CompilerState): PopulationExecutionPolicy {
  const policy = state.input.executionPolicy?.population;
  if (!policy) throw new Error("Population realization requires an explicit execution policy");
  if (
    !policy.policyId.trim() ||
    !policy.origin.trim() ||
    !Number.isSafeInteger(policy.minimumCandidateAttempts) ||
    policy.minimumCandidateAttempts <= 0 ||
    !Number.isSafeInteger(policy.candidateAttemptsPerTarget) ||
    policy.candidateAttemptsPerTarget <= 0 ||
    !Number.isSafeInteger(policy.pointPlacementCandidateAttempts) ||
    policy.pointPlacementCandidateAttempts <= 0
  )
    throw new Error("Population execution policy identity and allocations are invalid");
  return policy;
}

function assemblyExecutionPolicy(state: CompilerState): AssemblyExecutionPolicy {
  const policy = state.input.executionPolicy?.assembly;
  if (!policy) throw new Error("Assembly realization requires an explicit execution policy");
  if (
    !policy.policyId.trim() ||
    !policy.origin.trim() ||
    !Number.isSafeInteger(policy.maximumDecisions) ||
    policy.maximumDecisions <= 0 ||
    !Number.isSafeInteger(policy.maximumBacktracks) ||
    policy.maximumBacktracks < 0
  )
    throw new Error("Assembly execution policy identity and allocations are invalid");
  return policy;
}

function radicalInverse(index: number, base: number): number {
  let value = 0;
  let fraction = 1 / base;
  for (let current = index; current > 0; current = Math.floor(current / base)) {
    value += (current % base) * fraction;
    fraction /= base;
  }
  return value;
}

function* scatterTargets(
  state: CompilerState,
  intent: Extract<RealizationIntent, { kind: "surface_scatter" }>,
  maximumAttempts: number,
  hash: string,
): Generator<Target> {
  for (const point of candidatePointsInPolygon(intent.boundary, maximumAttempts, hash)) {
    if (intent.densityField) {
      const distance = Math.min(
        ...intent.boundary.map((p, i) => {
          const next = intent.boundary[(i + 1) % intent.boundary.length]!;
          return pointSegmentDistance2d(point.x, point.z, p.u, p.v, next.u, next.v);
        }),
      );
      if (
        point.densitySample >= populationDensityAt(intent.densityField, point.x, point.z, distance)
      )
        continue;
    }
    yield {
      position: {
        x: point.x,
        y: surfaceHeight(state, intent.surfaceId, point.x, point.z),
        z: point.z,
      },
      regionId: intent.regionId,
      surfaceId: intent.surfaceId,
      rotation: point.rotation,
    };
  }
}

function* clusterTargets(
  state: CompilerState,
  intent: Extract<RealizationIntent, { kind: "cluster" }>,
  maximumAttempts: number,
  hash: string,
): Generator<Target> {
  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    const sample = populationSample(hash, attempt);
    const radial = Math.sqrt(sample.u);
    const angle = 2 * Math.PI * sample.v;
    const x = intent.center.u + Math.cos(angle) * intent.radiusMeters * radial;
    const z = intent.center.v + Math.sin(angle) * intent.radiusMeters * radial;
    if (
      intent.densityField &&
      sample.densitySample >=
        populationDensityAt(intent.densityField, x, z, intent.radiusMeters * (1 - radial))
    )
      continue;
    yield {
      position: {
        x,
        y: surfaceHeight(state, intent.surfaceId, x, z),
        z,
      },
      regionId: intent.regionId,
      surfaceId: intent.surfaceId,
      rotation: sample.rotation,
    };
  }
}

function* candidatePointsInPolygon(
  boundary: readonly { u: number; v: number }[],
  maximumAttempts: number,
  hash: string,
): Generator<{
  x: number;
  z: number;
  rotation: [number, number, number, number];
  densitySample: number;
}> {
  const minX = Math.min(...boundary.map((point) => point.u));
  const maxX = Math.max(...boundary.map((point) => point.u));
  const minZ = Math.min(...boundary.map((point) => point.v));
  const maxZ = Math.max(...boundary.map((point) => point.v));
  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    const { u, v, rotation, densitySample } = populationSample(hash, attempt);
    const candidate = {
      x: minX + u * (maxX - minX),
      z: minZ + v * (maxZ - minZ),
      rotation,
      densitySample,
    };
    if (pointInIntentPolygon(candidate, boundary)) yield candidate;
  }
}

// Independent, reproducible coordinates avoid visible low-discrepancy bands. Rotation
// belongs to each candidate, so occupancy is checked against the orientation we emit.
function populationSample(seed: string, attempt: number) {
  const hash = contentHash(`${seed}:${attempt}`);
  return {
    u: Number.parseInt(hash.slice(0, 8), 16) / 0x1_0000_0000,
    v: Number.parseInt(hash.slice(8, 16), 16) / 0x1_0000_0000,
    rotation: yawQuaternion(hash.slice(16)),
    densitySample: Number.parseInt(hash.slice(24, 32), 16) / 0x1_0000_0000,
  };
}

interface RouteFrame {
  readonly position: WorldVector3;
  readonly tangent: WorldVector3;
}

function sampleRouteFrame(points: readonly WorldVector3[], t: number): RouteFrame {
  const lengths = points
    .slice(1)
    .map((point, index) =>
      Math.hypot(
        point.x - points[index]!.x,
        point.y - points[index]!.y,
        point.z - points[index]!.z,
      ),
    );
  const target = lengths.reduce((sum, value) => sum + value, 0) * t;
  let station = 0;
  for (let index = 0; index < lengths.length; index += 1) {
    const length = lengths[index]!;
    const a = points[index]!;
    const b = points[index + 1]!;
    if (target <= station + length || index === lengths.length - 1) {
      const local = Math.min(1, Math.max(0, (target - station) / length));
      return {
        position: {
          x: a.x + (b.x - a.x) * local,
          y: a.y + (b.y - a.y) * local,
          z: a.z + (b.z - a.z) * local,
        },
        tangent: { x: (b.x - a.x) / length, y: (b.y - a.y) / length, z: (b.z - a.z) / length },
      };
    }
    station += length;
  }
  throw new Error("route has no measurable segment");
}

function sampleRoute(points: readonly WorldVector3[], t: number): WorldVector3 {
  return sampleRouteFrame(points, t).position;
}

function offsetRoute(frame: RouteFrame, offset: number): WorldVector3 {
  if (offset === 0) return frame.position;
  const length = Math.hypot(frame.tangent.x, frame.tangent.z);
  if (length <= 1e-9) throw new Error("route segment has no horizontal lateral axis");
  return {
    x: frame.position.x - (frame.tangent.z / length) * offset,
    y: frame.position.y,
    z: frame.position.z + (frame.tangent.x / length) * offset,
  };
}

function pointInIntentPolygon(
  point: { readonly x: number; readonly z: number },
  polygon: readonly { readonly u: number; readonly v: number }[],
): boolean {
  let inside = false;
  for (
    let index = 0, previous = polygon.length - 1;
    index < polygon.length;
    previous = index, index += 1
  ) {
    const first = polygon[index]!;
    const second = polygon[previous]!;
    if (pointSegmentDistance2d(point.x, point.z, first.u, first.v, second.u, second.v) <= 1e-9)
      return true;
    if (
      first.v > point.z !== second.v > point.z &&
      point.x < ((second.u - first.u) * (point.z - first.v)) / (second.v - first.v) + first.u
    )
      inside = !inside;
  }
  return inside;
}

function pointSegmentDistance2d(
  px: number,
  pz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
): number {
  const dx = bx - ax;
  const dz = bz - az;
  const denominator = dx * dx + dz * dz;
  const t =
    denominator === 0
      ? 0
      : Math.min(1, Math.max(0, ((px - ax) * dx + (pz - az) * dz) / denominator));
  return Math.hypot(px - (ax + t * dx), pz - (az + t * dz));
}
function uniqueMap<T>(
  entries: readonly T[],
  key: (entry: T) => string,
  label: string,
): Map<string, T> {
  const result = new Map<string, T>();
  for (const entry of entries) {
    const id = key(entry);
    if (result.has(id)) throw new Error(`Duplicate ${label}: ${id}`);
    result.set(id, entry);
  }
  return result;
}
export const compilationStatusOrder = COMPILATION_STATUSES;

function separationForIntent(intent: RealizationIntent): number {
  if (
    intent.kind === "surface_scatter" ||
    intent.kind === "cluster" ||
    intent.kind === "along_route"
  )
    return intent.minimumSeparationMeters;
  return 0;
}

function assertInstanceInsideRegion(plan: SpatialWorldPlan, instance: RealizedInstance): void {
  if (!instance.regionId || instance.sourceKind === "environment") return;
  const region = plan.regions.find((candidate) => candidate.regionId === instance.regionId);
  if (!region) throw new Error(`instance references unknown region ${instance.regionId}`);
  const corners = [instance.boundsMeters.min.x, instance.boundsMeters.max.x].flatMap((x) =>
    [instance.boundsMeters.min.y, instance.boundsMeters.max.y].flatMap((y) =>
      [instance.boundsMeters.min.z, instance.boundsMeters.max.z].map((z) => ({ x, y, z })),
    ),
  );
  if (corners.some((corner) => !worldRegionContainsPoint(region, corner)))
    throw new Error(`realized footprint leaves region ${region.regionId}`);
}

function assertConstructedStructureInsideRegion(
  plan: SpatialWorldPlan,
  structure: ConstructedStructureArtifact,
): void {
  const region = plan.regions.find((candidate) => candidate.regionId === structure.regionId);
  if (!region)
    throw new Error(`constructed structure references unknown region ${structure.regionId}`);
  const corners = [structure.boundsMeters.min.x, structure.boundsMeters.max.x].flatMap((x) =>
    [structure.boundsMeters.min.y, structure.boundsMeters.max.y].flatMap((y) =>
      [structure.boundsMeters.min.z, structure.boundsMeters.max.z].map((z) => ({ x, y, z })),
    ),
  );
  if (corners.some((corner) => !worldRegionContainsPoint(region, corner)))
    throw new Error(`constructed footprint leaves region ${region.regionId}`);
}

function socketPolaritiesMate(first: string, second: string): boolean {
  return (
    first === "neutral" ||
    second === "neutral" ||
    (first === "plug" && second === "socket") ||
    (first === "socket" && second === "plug")
  );
}

function fixedVector(value: {
  readonly x: string;
  readonly y: string;
  readonly z: string;
}): WorldVector3 {
  return {
    x: dequantizeQ32_32(value.x),
    y: dequantizeQ32_32(value.y),
    z: dequantizeQ32_32(value.z),
  };
}

function add(left: WorldVector3, right: WorldVector3): WorldVector3 {
  return { x: left.x + right.x, y: left.y + right.y, z: left.z + right.z };
}

function subtract(left: WorldVector3, right: WorldVector3): WorldVector3 {
  return { x: left.x - right.x, y: left.y - right.y, z: left.z - right.z };
}

function scale(value: WorldVector3, amount: number): WorldVector3 {
  return { x: value.x * amount, y: value.y * amount, z: value.z * amount };
}

function dot(left: WorldVector3, right: WorldVector3): number {
  return left.x * right.x + left.y * right.y + left.z * right.z;
}

function distance(left: WorldVector3, right: WorldVector3): number {
  return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
}

function normalized(value: WorldVector3): WorldVector3 {
  const length = Math.hypot(value.x, value.y, value.z);
  if (!Number.isFinite(length) || length <= 1e-9) throw new Error("vector cannot be zero");
  return scale(value, 1 / length);
}

function cross(left: WorldVector3, right: WorldVector3): WorldVector3 {
  return {
    x: left.y * right.z - left.z * right.y,
    y: left.z * right.x - left.x * right.z,
    z: left.x * right.y - left.y * right.x,
  };
}

function rotate(
  value: WorldVector3,
  rotation: readonly [number, number, number, number],
): WorldVector3 {
  const [x, y, z, w] = rotation;
  const tx = 2 * (y * value.z - z * value.y);
  const ty = 2 * (z * value.x - x * value.z);
  const tz = 2 * (x * value.y - y * value.x);
  return {
    x: value.x + w * tx + (y * tz - z * ty),
    y: value.y + w * ty + (z * tx - x * tz),
    z: value.z + w * tz + (x * ty - y * tx),
  };
}

function multiplyQuaternion(
  first: readonly [number, number, number, number],
  second: readonly [number, number, number, number],
): [number, number, number, number] {
  const [ax, ay, az, aw] = first;
  const [bx, by, bz, bw] = second;
  return normalizeQuaternion([
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ]);
}

function alignFrames(
  sourceNormalInput: WorldVector3,
  sourceUpInput: WorldVector3,
  targetNormalInput: WorldVector3,
  targetUpInput: WorldVector3,
): [number, number, number, number] {
  const sourceNormal = normalized(sourceNormalInput);
  const sourceRight = normalized(cross(sourceUpInput, sourceNormal));
  const sourceUp = normalized(cross(sourceNormal, sourceRight));
  const targetNormal = normalized(targetNormalInput);
  const targetRight = normalized(cross(targetUpInput, targetNormal));
  const targetUp = normalized(cross(targetNormal, targetRight));
  const source = [sourceRight, sourceUp, sourceNormal] as const;
  const target = [targetRight, targetUp, targetNormal] as const;
  const axes = ["x", "y", "z"] as const;
  const matrix = axes.map((row) =>
    axes.map((column) =>
      target.reduce((sum, targetAxis, index) => sum + targetAxis[row] * source[index]![column], 0),
    ),
  );
  return quaternionFromMatrix(matrix);
}

function quaternionFromMatrix(
  matrix: readonly (readonly number[])[],
): [number, number, number, number] {
  const m00 = matrix[0]![0]!;
  const m01 = matrix[0]![1]!;
  const m02 = matrix[0]![2]!;
  const m10 = matrix[1]![0]!;
  const m11 = matrix[1]![1]!;
  const m12 = matrix[1]![2]!;
  const m20 = matrix[2]![0]!;
  const m21 = matrix[2]![1]!;
  const m22 = matrix[2]![2]!;
  const trace = m00 + m11 + m22;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    return normalizeQuaternion([(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, s / 4]);
  }
  if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    return normalizeQuaternion([s / 4, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s]);
  }
  if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    return normalizeQuaternion([(m01 + m10) / s, s / 4, (m12 + m21) / s, (m02 - m20) / s]);
  }
  const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
  return normalizeQuaternion([(m02 + m20) / s, (m12 + m21) / s, s / 4, (m10 - m01) / s]);
}

function normalizeQuaternion(
  value: readonly [number, number, number, number],
): [number, number, number, number] {
  const length = Math.hypot(...value);
  if (!Number.isFinite(length) || length <= 1e-9) throw new Error("quaternion cannot be zero");
  return value.map((entry) => entry / length) as [number, number, number, number];
}
