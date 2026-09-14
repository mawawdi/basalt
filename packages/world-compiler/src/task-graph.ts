import {
  compareCanonicalStrings,
  contentAddressedEntityId,
  contentHash,
  stableJson,
  type CompilationStatus,
} from "@basalt/contracts";
import type { CatalogResolutionPlan } from "@basalt/catalog-model";
import type { SpatialWorldPlan } from "@basalt/world-planning";
import {
  compilationTaskId,
  sealCompilationTaskResult,
  type AssemblyArtifact,
  type CompiledWorldFoundation,
  type CompilationTaskResult,
  type ConstructedStructureArtifact,
  type MesoLayout,
  type MicroRealization,
  type RealizedInstance,
} from "./world-build.js";

/** Materialize a task DAG with stable logical IDs and exact result hashes. */
export function compilationTasks(
  plan: SpatialWorldPlan,
  foundation: CompiledWorldFoundation,
  resolution: CatalogResolutionPlan,
  meso: MesoLayout,
  micro: MicroRealization,
  assemblies: readonly AssemblyArtifact[],
  mesoInstances: readonly RealizedInstance[],
  constructedStructures: readonly ConstructedStructureArtifact[],
): CompilationTaskResult[] {
  const resourceUse = { wallMilliseconds: 0, decisions: 0, backtracks: 0 };
  const task = (
    scope: CompilationTaskResult["scope"],
    stage: CompilationTaskResult["stage"],
    subjectId: string,
    dependencyTaskIds: readonly string[],
    inputHashes: readonly string[],
    outputHashes: readonly string[],
    status: CompilationStatus,
    diagnostics: readonly string[] = [],
  ) =>
    sealCompilationTaskResult({
      subjectId,
      scope,
      stage,
      dependencyTaskIds: [...dependencyTaskIds],
      inputHashes: [...inputHashes],
      policyHash: contentHash(stableJson({ scope, stage, executor: "local_bounded" })),
      outputHashes: [...outputHashes],
      status,
      resourceUse,
      diagnostics: [...diagnostics],
    });

  const result: CompilationTaskResult[] = [];
  const baseTerrainTaskId = (terrainPlanId: string) =>
    compilationTaskId("terrain", "terrain_base", terrainPlanId);
  const finalTerrainTaskId = (terrainPlanId: string) =>
    compilationTaskId("terrain", "terrain_final", terrainPlanId);
  const junctionTaskId = (junctionId: string) =>
    compilationTaskId("junction", "route_construction", junctionId);
  const regionTaskId = (regionId: string) => compilationTaskId("region", "foundation", regionId);
  const routeTaskId = (routeId: string) =>
    compilationTaskId("route", "route_construction", routeId);
  const lotTaskId = (policyId: string) => compilationTaskId("lot", "foundation", policyId);
  const worldFoundationId = compilationTaskId("world", "foundation", plan.planId);
  const worldCatalogId = compilationTaskId("world", "catalog_resolution", plan.planId);
  const worldMesoId = compilationTaskId("world", "meso", plan.planId);
  const worldMicroId = compilationTaskId("world", "micro", plan.planId);
  const constructionTaskIds = plan.constructionPrograms.map((entry) =>
    compilationTaskId("structure", "meso", entry.programId),
  );

  for (const terrainPlan of plan.terrainPlans) {
    const base = foundation.baseTerrainFields.find(
      (candidate) => candidate.terrainPlanId === terrainPlan.terrainPlanId,
    )!;
    result.push(
      task(
        "terrain",
        "terrain_base",
        terrainPlan.terrainPlanId,
        [],
        [contentHash(stableJson(terrainPlan))],
        [base.hash],
        "eligible",
      ),
    );
  }

  for (const junction of plan.routeJunctions) {
    const artifact = foundation.routeJunctions.find(
      (candidate) => candidate.junctionId === junction.junctionId,
    )!;
    const terrainDependencies = [
      ...new Set(
        junction.participants.flatMap((participant) => {
          const route = plan.routes.find((candidate) => candidate.routeId === participant.routeId)!;
          return plan.terrainPlans
            .filter((terrain) => terrain.surfaceId === route.surfaceId)
            .map((terrain) => baseTerrainTaskId(terrain.terrainPlanId));
        }),
      ),
    ];
    const participantRouteHashes = junction.participants
      .map((participant) => {
        const route = plan.routes.find((candidate) => candidate.routeId === participant.routeId)!;
        const construction = route.construction;
        return contentHash(
          stableJson({
            routeId: route.routeId,
            surfaceId: route.surfaceId,
            thicknessMeters: route.thicknessMeters,
            terrainPriority: route.terrainPriority,
            construction:
              construction.kind === "elevated"
                ? { kind: construction.kind }
                : {
                    kind: construction.kind,
                    surfaceRevealMeters: construction.surfaceRevealMeters,
                    groundingToleranceMeters: construction.groundingToleranceMeters,
                  },
          }),
        );
      })
      .sort(compareCanonicalStrings);
    result.push(
      task(
        "junction",
        "route_construction",
        junction.junctionId,
        terrainDependencies,
        [
          contentHash(stableJson(junction)),
          artifact.surfaceEvidenceHash,
          ...participantRouteHashes,
        ],
        [artifact.hash],
        "eligible",
      ),
    );
  }

  for (const route of plan.routes) {
    const semanticEntity = plan.semanticEntities.find(
      (candidate) => candidate.entityId === route.semanticEntityId,
    )!;
    const construction = foundation.routeConstructions.find(
      (candidate) => candidate.routeId === route.routeId,
    )!;
    const terrainPlan = plan.terrainPlans.find(
      (candidate) => candidate.surfaceId === route.surfaceId,
    )!;
    const junctionDependencies = plan.routeJunctions
      .filter((junction) =>
        junction.participants.some((participant) => participant.routeId === route.routeId),
      )
      .map((junction) => junctionTaskId(junction.junctionId));
    result.push(
      task(
        "route",
        "route_construction",
        route.routeId,
        [baseTerrainTaskId(terrainPlan.terrainPlanId), ...junctionDependencies],
        [
          contentHash(stableJson(route)),
          semanticEntity.semanticDependencyClosureHash,
          construction.baseTerrainFieldHash,
          ...junctionDependencies.map(
            (id) => result.find((candidate) => candidate.taskId === id)!.taskHash,
          ),
        ],
        [construction.hash],
        construction.status,
        construction.diagnostics,
      ),
    );
  }

  for (const terrainPlan of plan.terrainPlans) {
    const field = foundation.terrainFields.find(
      (candidate) => candidate.terrainPlanId === terrainPlan.terrainPlanId,
    )!;
    const routeDependencies = plan.routes
      .filter((route) => route.surfaceId === terrainPlan.surfaceId)
      .map((route) => routeTaskId(route.routeId));
    result.push(
      task(
        "terrain",
        "terrain_final",
        terrainPlan.terrainPlanId,
        [baseTerrainTaskId(terrainPlan.terrainPlanId), ...routeDependencies],
        [
          field.baseTerrainFieldHash,
          ...field.routeConstructionHashes,
          ...field.routeJunctionHashes,
        ],
        [field.hash],
        "eligible",
      ),
    );
  }

  for (const region of plan.regions) {
    const semanticEntity = plan.semanticEntities.find(
      (candidate) => candidate.entityId === region.semanticEntityId,
    )!;
    const regionalTerrainPlans = plan.terrainPlans.filter((candidate) =>
      candidate.regionIds.includes(region.regionId),
    );
    const regionalFields = foundation.terrainFields.filter((field) =>
      regionalTerrainPlans.some((candidate) => candidate.terrainPlanId === field.terrainPlanId),
    );
    const regionalRoutes = foundation.routeConstructions.filter((route) =>
      plan.routes.some(
        (candidate) =>
          candidate.routeId === route.routeId && candidate.regionIds.includes(region.regionId),
      ),
    );
    result.push(
      task(
        "region",
        "foundation",
        region.regionId,
        regionalTerrainPlans.map((entry) => finalTerrainTaskId(entry.terrainPlanId)),
        [
          contentHash(stableJson(region)),
          semanticEntity.semanticDependencyClosureHash,
          ...regionalTerrainPlans.map((entry) => contentHash(stableJson(entry))),
        ],
        regionalFields.map((field) => field.hash),
        regionalRoutes.some((route) => route.status === "rejected")
          ? "rejected"
          : regionalRoutes.some((route) => route.status === "incomplete")
            ? "incomplete"
            : "eligible",
        regionalRoutes.flatMap((route) => route.diagnostics),
      ),
    );
  }

  for (const policy of plan.lotPolicies) {
    const region = plan.regions.find((candidate) => candidate.regionId === policy.regionId)!;
    const regionalRoutes = plan.routes.filter((candidate) =>
      candidate.regionIds.includes(policy.regionId),
    );
    result.push(
      task(
        "lot",
        "foundation",
        policy.policyId,
        [
          regionTaskId(policy.regionId),
          ...regionalRoutes.map((entry) => routeTaskId(entry.routeId)),
        ],
        [
          contentHash(stableJson(policy)),
          contentHash(stableJson(region)),
          ...regionalRoutes.map((entry) => contentHash(stableJson(entry))),
        ],
        foundation.lotSubdivisions
          .filter((lots) => lots.policy.policyId === policy.policyId)
          .map((lots) => lots.hash),
        "eligible",
      ),
    );
  }

  const mesoTaskIds: string[] = [];
  for (const assembly of assemblies) {
    const subjectId = contentAddressedEntityId("AssemblyTask", {
      kitEntryHash: assembly.kitEntryHash,
      lotHash: assembly.lotHash,
    });
    const structureTaskId = compilationTaskId("structure", "meso", subjectId);
    mesoTaskIds.push(structureTaskId);
    const owningLotPolicy = foundation.lotSubdivisions.find((subdivision) =>
      subdivision.lots.some((lot) => lot.hash === assembly.lotHash),
    )?.policy.policyId;
    result.push(
      task(
        "structure",
        "meso",
        subjectId,
        [
          worldFoundationId,
          worldCatalogId,
          ...constructionTaskIds,
          ...(owningLotPolicy ? [lotTaskId(owningLotPolicy)] : []),
        ],
        [assembly.kitEntryHash, assembly.lotHash, assembly.structuralProgramHash],
        [
          assembly.hash,
          ...assembly.componentInstanceIds.flatMap((id) => {
            const instance = mesoInstances.find((candidate) => candidate.instanceId === id);
            return instance ? [instance.hash] : [];
          }),
        ],
        "eligible",
      ),
    );
    const surfaces = meso.constructedSurfaces.filter(
      (surface) => surface.assemblyHash === assembly.hash,
    );
    const portals = meso.portals.filter((portal) => portal.assemblyHash === assembly.hash);
    const rooms = meso.rooms.filter((room) => room.assemblyHash === assembly.hash);
    const floorIndices = [
      ...new Set([
        ...surfaces.map((surface) => surface.floorIndex),
        ...portals.map((portal) => portal.floorIndex),
        ...rooms.map((room) => room.floorIndex),
      ]),
    ].sort((left, right) => left - right);
    for (const floorIndex of floorIndices) {
      const floorSubjectId = contentAddressedEntityId("FloorTask", { subjectId, floorIndex });
      const floorTaskId = compilationTaskId("floor", "meso", floorSubjectId);
      mesoTaskIds.push(floorTaskId);
      result.push(
        task(
          "floor",
          "meso",
          floorSubjectId,
          [structureTaskId],
          [assembly.hash, contentHash(stableJson({ floorIndex }))],
          [
            ...surfaces
              .filter((surface) => surface.floorIndex === floorIndex)
              .map((surface) => surface.hash),
            ...portals
              .filter((portal) => portal.floorIndex === floorIndex)
              .map((portal) => portal.hash),
            ...rooms.filter((room) => room.floorIndex === floorIndex).map((room) => room.hash),
          ],
          "eligible",
        ),
      );
    }
    for (const room of rooms) {
      const roomTaskId = compilationTaskId("room", "meso", room.roomId);
      mesoTaskIds.push(roomTaskId);
      result.push(
        task(
          "room",
          "meso",
          room.roomId,
          [structureTaskId],
          [
            assembly.hash,
            room.semanticDependencyClosureHash,
            ...room.surfaceIds.flatMap((id) => {
              const surface = surfaces.find((candidate) => candidate.surfaceId === id);
              return surface ? [surface.hash] : [];
            }),
            ...room.portalIds.flatMap((id) => {
              const portal = portals.find((candidate) => candidate.portalId === id);
              return portal ? [portal.hash] : [];
            }),
          ],
          [room.hash],
          "eligible",
        ),
      );
    }
  }

  for (const program of plan.constructionPrograms) {
    const structure = constructedStructures.find(
      (entry) => entry.constructionProgramHash === program.programHash,
    );
    const dependencyTaskIds = [
      regionTaskId(program.regionId),
      ...program.operations.flatMap((operation) =>
        operation.kind === "stair_run" ? [routeTaskId(operation.entryRouteId)] : [],
      ),
    ];
    const structureTaskId = compilationTaskId("structure", "meso", program.programId);
    mesoTaskIds.push(structureTaskId);
    result.push(
      task(
        "structure",
        "meso",
        program.programId,
        dependencyTaskIds,
        [
          program.programHash,
          program.semanticDependencyClosureHash,
          ...(structure ? [structure.placementEvidenceHash] : []),
        ],
        structure
          ? [
              structure.hash,
              ...structure.elements.map((entry) => entry.hash),
              ...structure.openings.map((entry) => entry.hash),
              ...structure.portals.map((entry) => entry.hash),
              ...structure.accessPaths.map((entry) => entry.hash),
            ]
          : [],
        structure ? "eligible" : "incomplete",
        structure
          ? []
          : meso.diagnostics.filter((entry) =>
              entry.startsWith(`construction:${program.programId}:`),
            ),
      ),
    );
  }

  const foundationDependencies = [
    ...plan.regions.map((entry) => regionTaskId(entry.regionId)),
    ...plan.routes.map((entry) => routeTaskId(entry.routeId)),
    ...plan.routeJunctions.map((entry) => junctionTaskId(entry.junctionId)),
    ...plan.lotPolicies.map((entry) => lotTaskId(entry.policyId)),
  ];
  result.push(
    task(
      "world",
      "foundation",
      plan.planId,
      foundationDependencies,
      [foundation.foundationInputHash],
      [foundation.foundationHash],
      foundation.status,
    ),
    task(
      "world",
      "catalog_resolution",
      plan.planId,
      [],
      [resolution.requirementsHash, resolution.catalogSnapshotHash],
      [resolution.hash],
      resolution.status,
      resolution.diagnostics,
    ),
    task(
      "world",
      "meso",
      plan.planId,
      [worldFoundationId, worldCatalogId, ...mesoTaskIds],
      [
        foundation.foundationHash,
        resolution.hash,
        ...mesoTaskIds.map((id) => result.find((entry) => entry.taskId === id)!.taskHash),
      ],
      [meso.hash],
      meso.status,
      meso.diagnostics,
    ),
    task(
      "world",
      "micro",
      plan.planId,
      [worldFoundationId, worldCatalogId, worldMesoId],
      [foundation.foundationHash, resolution.hash, meso.hash],
      [micro.hash],
      micro.status,
      micro.diagnostics,
    ),
    task(
      "world",
      "world_build",
      plan.planId,
      [worldFoundationId, worldCatalogId, worldMesoId, worldMicroId],
      [foundation.foundationHash, resolution.hash, meso.hash, micro.hash],
      [foundation.foundationHash, resolution.hash, meso.hash, micro.hash],
      taskStatus(resolution.status, [...meso.diagnostics, ...micro.diagnostics]),
    ),
  );
  return result.sort((left, right) => compareCanonicalStrings(left.taskId, right.taskId));
}

/** Reverse-edge closure: seed tasks plus every task whose inputs depend on them. */
export function affectedCompilationTaskClosure(
  tasks: readonly CompilationTaskResult[],
  seedTaskIds: readonly string[],
): readonly string[] {
  const known = new Set(tasks.map((entry) => entry.taskId));
  for (const seed of seedTaskIds)
    if (!known.has(seed)) throw new Error(`Unknown compilation task ${seed}`);
  const affected = new Set(seedTaskIds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const task of tasks)
      if (
        !affected.has(task.taskId) &&
        task.dependencyTaskIds.some((dependency) => affected.has(dependency))
      ) {
        affected.add(task.taskId);
        changed = true;
      }
  }
  return [...affected].sort(compareCanonicalStrings);
}

function taskStatus(
  resolution: CompilationStatus,
  diagnostics: readonly string[],
): CompilationStatus {
  if (resolution === "rejected") return "rejected";
  return resolution === "incomplete" || diagnostics.length > 0 ? "incomplete" : "eligible";
}
