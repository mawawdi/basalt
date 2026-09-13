import { contentHash, stableJson, type CompilationStatus } from "@basalt/contracts";
import type { CatalogResolutionPlan } from "@basalt/catalog-model";
import type { SpatialWorldPlan } from "@basalt/world-planning";
import {
  sealCompilationTaskResult,
  type AssemblyArtifact,
  type CompiledWorldFoundation,
  type CompilationTaskResult,
  type MesoLayout,
  type MicroRealization,
  type RealizedInstance,
} from "./world-build.js";

export function compilationTasks(
  plan: SpatialWorldPlan,
  foundation: CompiledWorldFoundation,
  resolution: CatalogResolutionPlan,
  meso: MesoLayout,
  micro: MicroRealization,
  assemblies: readonly AssemblyArtifact[],
  mesoInstances: readonly RealizedInstance[],
): CompilationTaskResult[] {
  const resourceUse = { wallMilliseconds: 0, decisions: 0, backtracks: 0 };
  const task = (
    scope: CompilationTaskResult["scope"],
    stage: CompilationTaskResult["stage"],
    inputHashes: readonly string[],
    outputHashes: readonly string[],
    status: CompilationStatus,
    diagnostics: readonly string[] = [],
  ) =>
    sealCompilationTaskResult({
      scope,
      stage,
      inputHashes: [...inputHashes],
      policyHash: contentHash(stableJson({ scope, stage, executor: "local_bounded" })),
      outputHashes: [...outputHashes],
      status,
      resourceUse,
      diagnostics: [...diagnostics],
    });
  const result: CompilationTaskResult[] = [];
  for (const region of plan.regions) {
    const semanticEntity = plan.semanticEntities.find(
      (candidate) => candidate.entityId === region.semanticEntityId,
    )!;
    const regionalTerrainPlans = plan.terrainPlans.filter((candidate) =>
      candidate.regionIds.includes(region.regionId),
    );
    const regionalRoutes = plan.routes.filter((candidate) =>
      candidate.regionIds.includes(region.regionId),
    );
    const regionalLotPolicies = plan.lotPolicies.filter(
      (candidate) => candidate.regionId === region.regionId,
    );
    const terrainHashes = foundation.terrainFields
      .filter((field) =>
        regionalTerrainPlans.some((candidate) => candidate.terrainPlanId === field.terrainPlanId),
      )
      .map((field) => field.hash);
    const roadHashes = foundation.roadAssemblies
      .filter((road) => regionalRoutes.some((candidate) => candidate.routeId === road.routeId))
      .map((road) => road.hash);
    const lotHashes = foundation.lotSubdivisions
      .filter((lots) => lots.policy.regionId === region.regionId)
      .map((lots) => lots.hash);
    result.push(
      task(
        "region",
        "foundation",
        [
          contentHash(stableJson(region)),
          semanticEntity.semanticDependencyClosureHash,
          ...regionalTerrainPlans.map((entry) => contentHash(stableJson(entry))),
          ...regionalRoutes.map((entry) => contentHash(stableJson(entry))),
          ...regionalLotPolicies.map((entry) => contentHash(stableJson(entry))),
        ],
        [...terrainHashes, ...roadHashes, ...lotHashes],
        "eligible",
      ),
    );
  }
  for (const route of plan.routes) {
    const semanticEntity = plan.semanticEntities.find(
      (candidate) => candidate.entityId === route.semanticEntityId,
    )!;
    result.push(
      task(
        "route",
        "foundation",
        [contentHash(stableJson(route)), semanticEntity.semanticDependencyClosureHash],
        foundation.roadAssemblies
          .filter((road) => road.routeId === route.routeId)
          .map((road) => road.hash),
        "eligible",
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
  for (const assembly of assemblies) {
    result.push(
      task(
        "structure",
        "meso",
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
    for (const floorIndex of floorIndices)
      result.push(
        task(
          "floor",
          "meso",
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
    for (const room of rooms)
      result.push(
        task(
          "room",
          "meso",
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
  result.push(
    task("world", "foundation", [plan.planHash], [foundation.foundationHash], foundation.status),
    task(
      "world",
      "catalog_resolution",
      [resolution.requirementsHash, resolution.catalogSnapshotHash],
      [resolution.hash],
      resolution.status,
      resolution.diagnostics,
    ),
    task(
      "world",
      "meso",
      [foundation.foundationHash, resolution.hash],
      [meso.hash],
      meso.status,
      meso.diagnostics,
    ),
    task(
      "world",
      "micro",
      [foundation.foundationHash, resolution.hash, meso.hash],
      [micro.hash],
      micro.status,
      micro.diagnostics,
    ),
    task(
      "world",
      "world_build",
      [foundation.foundationHash, resolution.hash, meso.hash, micro.hash],
      [foundation.foundationHash, resolution.hash, meso.hash, micro.hash],
      taskStatus(resolution.status, [...meso.diagnostics, ...micro.diagnostics]),
    ),
  );
  return result;
}

function taskStatus(
  resolution: CompilationStatus,
  diagnostics: readonly string[],
): CompilationStatus {
  if (resolution === "rejected") return "rejected";
  return resolution === "incomplete" || diagnostics.length > 0 ? "incomplete" : "eligible";
}
