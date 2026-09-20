import { z } from "zod";
import type { VegetationClearing } from "@basalt/catalog-model";
import { contentHash, stableJson } from "@basalt/contracts";
import {
  horizontalMaskBounds,
  horizontalMaskContainsPoint,
  REGION_EDIT_CLEARING_OPERATION_SCHEMA,
  REGION_EDIT_DENSITY_OPERATION_SCHEMA,
  REGION_EDIT_PROPOSAL_DRAFT_SCHEMA,
  REGION_EDIT_TERRAIN_OPERATION_SCHEMA,
  sealPopulationPlacementConstraints,
  type PopulationPlacementConstraints,
  type RegionEditObjective,
  type RegionEditProposal,
  type RegionEditProposalDraft,
  type RegionEditRequest,
  type RegionEditSpatialTarget,
  type SpatialWorldPlan,
} from "@basalt/world-planning";
import type { WorldBuild } from "@basalt/world-compiler";
import type { RefinementPolicy, WorldChange } from "@basalt/world-refinement";

export interface LandscapeEvidencePolicy {
  readonly columns: number;
  readonly rows: number;
  readonly tileColumns: number;
  readonly tileRows: number;
}

/** Grouped semantic edit operations; each transport request exposes only relevant operation kinds. */
export function regionEditResponseSchema(): typeof REGION_EDIT_PROPOSAL_DRAFT_SCHEMA;
export function regionEditResponseSchema(
  objectives: readonly RegionEditObjective[],
): z.ZodType<RegionEditProposalDraft>;
export function regionEditResponseSchema(objectives?: readonly RegionEditObjective[]) {
  if (!objectives) return REGION_EDIT_PROPOSAL_DRAFT_SCHEMA;
  const kinds = new Set(objectives.map((objective) => objective.kind));
  const schemas = [
    ...(kinds.has("vegetation_density") ? [REGION_EDIT_DENSITY_OPERATION_SCHEMA] : []),
    ...(kinds.has("vegetation_clearing") ? [REGION_EDIT_CLEARING_OPERATION_SCHEMA] : []),
    ...(kinds.has("terrain_material") ? [REGION_EDIT_TERRAIN_OPERATION_SCHEMA] : []),
  ];
  if (!schemas.length) throw new Error("Edit proposal request has no objective kinds");
  const operationSchema =
    schemas.length === 1
      ? schemas[0]!
      : z.union(
          schemas as [
            (typeof schemas)[number],
            (typeof schemas)[number],
            ...(typeof schemas)[number][],
          ],
        );
  return z
    .object({
      operations: z.array(operationSchema).min(1),
      rationale: REGION_EDIT_PROPOSAL_DRAFT_SCHEMA.shape.rationale,
    })
    .strict() as z.ZodType<RegionEditProposalDraft>;
}

/** Counts describe actual output, not requested caps or model confidence. */
export function regionPopulationEvidence(plan: SpatialWorldPlan, world: WorldBuild) {
  return plan.realizationIntents.flatMap((i) => {
    if (i.kind !== "surface_scatter" || !i.vegetation) return [];
    return [
      {
        intentId: i.intentId,
        requirementId: i.requirementId,
        areaId: i.vegetation.areaId,
        habitatFieldId: i.vegetation.habitatFieldId,
        layer: i.vegetation.layer,
        placedCount: world.instances.filter((instance) => instance.intentId === i.intentId).length,
        minimumCount: i.minimumCount,
        maximumCount: i.targetCount,
        boundary: i.boundary,
        candidateDensityPerSquareMeter: i.vegetation.candidateDensityPerSquareMeter,
        spacingMeters: i.vegetation.spacingMeters,
        clearings: i.vegetation.clearings,
      },
    ];
  });
}

/** Coarse projected render-envelope evidence, not leaf area, habitat quality or collision. */
export function regionLandscapeEvidence(
  plan: SpatialWorldPlan,
  world: WorldBuild,
  policy: LandscapeEvidencePolicy,
) {
  const { columns, rows, tileColumns, tileRows } = policy;
  if (
    ![columns, rows, tileColumns, tileRows].every(
      (value) => Number.isSafeInteger(value) && value > 0,
    ) ||
    columns % tileColumns !== 0 ||
    rows % tileRows !== 0
  )
    throw new Error("Landscape evidence grid and tile policy must use positive divisible integers");
  const { min, max } = plan.boundsMeters;
  const cellWidth = (max.x - min.x) / columns;
  const cellDepth = (max.z - min.z) / rows;
  const layers = new Map(
    ["canopy", "understory", "ground_cover"].map((layer) => [
      layer,
      { layer, instances: 0, cells: new Uint8Array(columns * rows) },
    ]),
  );
  const intentLayers = new Map(
    plan.realizationIntents.flatMap((i) =>
      i.kind === "surface_scatter" && i.vegetation
        ? [[i.intentId, i.vegetation.layer] as const]
        : [],
    ),
  );
  for (const instance of world.instances) {
    const layer = layers.get(intentLayers.get(instance.intentId) ?? "");
    if (!layer) continue;
    layer.instances++;
    const b = instance.boundsMeters;
    const x0 = Math.max(0, Math.ceil((b.min.x - min.x) / cellWidth - 0.5));
    const x1 = Math.min(columns - 1, Math.floor((b.max.x - min.x) / cellWidth - 0.5));
    const z0 = Math.max(0, Math.ceil((b.min.z - min.z) / cellDepth - 0.5));
    const z1 = Math.min(rows - 1, Math.floor((b.max.z - min.z) / cellDepth - 0.5));
    for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) layer.cells[z * columns + x] = 1;
  }
  const occupied = new Uint8Array(columns * rows);
  for (const layer of layers.values())
    layer.cells.forEach((value, index) => {
      occupied[index] ||= value;
    });
  const fraction = (cells: Uint8Array) =>
    Number((cells.reduce((sum, value) => sum + value, 0) / cells.length).toFixed(4));
  return {
    scope: `${columns} by ${rows} ground samples inside projected vegetation render bounds. Mesh holes and leaf density are unresolved; terrain materials are excluded. Diagnostic evidence, not an aesthetic acceptance score.`,
    cellSizeMeters: { x: cellWidth, z: cellDepth },
    layers: [...layers.values()].map(({ layer, instances, cells }) => ({
      layer,
      instances,
      sampledBoundsCoverage: fraction(cells),
    })),
    fractionOutsideVegetationBounds: Number((1 - fraction(occupied)).toFixed(4)),
    tiles: Array.from({ length: tileColumns * tileRows }, (_, index) => {
      const column = index % tileColumns,
        row = Math.floor(index / tileColumns);
      const tileWidth = columns / tileColumns,
        tileDepth = rows / tileRows;
      const tileFraction = (cells: Uint8Array) => {
        let count = 0;
        for (let z = row * tileDepth; z < (row + 1) * tileDepth; z++)
          for (let x = column * tileWidth; x < (column + 1) * tileWidth; x++)
            count += cells[z * columns + x]!;
        return Number((count / (tileWidth * tileDepth)).toFixed(4));
      };
      return {
        boundsXZ: {
          min: {
            x: min.x + column * tileWidth * cellWidth,
            z: min.z + row * tileDepth * cellDepth,
          },
          max: {
            x: min.x + (column + 1) * tileWidth * cellWidth,
            z: min.z + (row + 1) * tileDepth * cellDepth,
          },
        },
        layers: [...layers.values()].map(({ layer, cells }) => ({
          layer,
          sampledBoundsCoverage: tileFraction(cells),
        })),
      };
    }),
  };
}

/** Initial composition evidence, separate from persistent compiler requirements. */
export function regionPlantingAssessment(plan: SpatialWorldPlan, world: WorldBuild) {
  const groups = new Map<string, { layer: string; intentIds: string[]; placedCount: number }>();
  for (const i of plan.realizationIntents) {
    if (i.kind !== "surface_scatter" || !i.vegetation) continue;
    const key = stableJson({
      regionId: i.regionId,
      surfaceId: i.surfaceId,
      boundary: i.boundary,
      field: i.densityField,
      layer: i.vegetation.layer,
    });
    const group = groups.get(key) ?? { layer: i.vegetation.layer, intentIds: [], placedCount: 0 };
    group.intentIds.push(i.intentId);
    group.placedCount += world.instances.filter((p) => p.intentId === i.intentId).length;
    groups.set(key, group);
  }
  const layers = [...groups.values()];
  const diagnostics = layers
    .filter((g) => g.placedCount === 0)
    .map(
      (g) =>
        `Requested ${g.layer} layer is empty: ${g.intentIds.join(", ")}. Repair the planting area, spacing or palette; caps do not guarantee plants.`,
    );
  return {
    status: diagnostics.length ? ("incomplete" as const) : ("eligible" as const),
    layers,
    diagnostics,
  };
}

export function regionEditContext(
  plan: SpatialWorldPlan,
  world: WorldBuild,
  policy: RefinementPolicy,
  landscapeEvidencePolicy: LandscapeEvidencePolicy,
) {
  const population = regionPopulationEvidence(plan, world);
  const areas = new Map<
    string,
    {
      areaId: string;
      habitatFieldIds: Set<string>;
      boundary: unknown;
      layers: Map<string, { intentIds: string[]; placedCount: number }>;
    }
  >();
  for (const target of population) {
    const area = areas.get(target.areaId) ?? {
      areaId: target.areaId,
      habitatFieldIds: new Set<string>(),
      boundary: target.boundary,
      layers: new Map<string, { intentIds: string[]; placedCount: number }>(),
    };
    area.habitatFieldIds.add(target.habitatFieldId);
    const grouped = area.layers.get(target.layer) ?? { intentIds: [], placedCount: 0 };
    grouped.intentIds.push(target.intentId);
    grouped.placedCount += target.placedCount;
    area.layers.set(target.layer, grouped);
    areas.set(target.areaId, area);
  }
  return {
    boundsMeters: plan.boundsMeters,
    landscape: regionLandscapeEvidence(plan, world, landscapeEvidencePolicy),
    vegetationAreas: [...areas.values()].map((area) => ({
      areaId: area.areaId,
      habitatFieldIds: [...area.habitatFieldIds].sort(),
      boundary: area.boundary,
      boundsXZ: {
        min: {
          x: Math.min(...(area.boundary as Array<{ u: number; v: number }>).map((p) => p.u)),
          z: Math.min(...(area.boundary as Array<{ u: number; v: number }>).map((p) => p.v)),
        },
        max: {
          x: Math.max(...(area.boundary as Array<{ u: number; v: number }>).map((p) => p.u)),
          z: Math.max(...(area.boundary as Array<{ u: number; v: number }>).map((p) => p.v)),
        },
      },
      layers: [...area.layers].map(([layer, evidence]) => ({ layer, ...evidence })),
    })),
    paintTargets: policy.terrainPaint.map((r) => ({
      ...r,
      operation: plan.terrainPlans.find((t) => t.terrainPlanId === r.terrainPlanId)!.operations[
        r.operationIndex
      ],
    })),
    protectedObjects: world.instances
      .filter((i) => policy.protectedIntentIds.includes(i.intentId))
      .map((i) => ({
        intentId: i.intentId,
        entryHandle: i.entryHandle,
        boundsMeters: i.boundsMeters,
      })),
    protectedRoutes: plan.routes.map((r) => ({
      routeId: r.routeId,
      alignmentMeters: r.alignmentMeters,
      widthMeters: r.widthMeters,
    })),
  };
}

type WorldBounds = SpatialWorldPlan["boundsMeters"];

/** Resolve semantic edit targets against authored area identity and verified base-world geometry. */
export function regionEditTargetEvidence(
  objectives: readonly RegionEditObjective[],
  plan: SpatialWorldPlan,
  world: WorldBuild,
) {
  return objectives.flatMap((objective) => {
    if (objective.kind === "terrain_material") return [];
    const anchorBounds = resolveSpatialTargetBounds(objective.spatialTarget, plan, world);
    const existingClearing =
      objective.spatialTarget.kind === "around_intents"
        ? resolveExistingClearingBounds(objective, anchorBounds, plan)
        : undefined;
    const boundsMeters =
      objective.kind === "vegetation_density" && objective.spatialTarget.kind === "around_intents"
        ? expandBoundsXZ(
            existingClearing ? vegetationClearingBounds(existingClearing) : anchorBounds,
            Math.max(
              existingClearing?.falloffMeters ?? 0,
              resolveTargetTransitionMeters(objective, plan),
            ),
            plan.boundsMeters,
          )
        : anchorBounds;
    const baselineClearingBounds =
      objective.kind === "vegetation_clearing" && objective.change === "expand"
        ? existingClearing
          ? vegetationClearingBounds(existingClearing)
          : anchorBounds
        : undefined;
    return [
      {
        objectiveId: objective.objectiveId,
        spatialTarget: objective.spatialTarget,
        boundsMeters,
        ...(baselineClearingBounds ? { baselineClearingBounds } : {}),
      },
    ];
  });
}

/** Add matched cameras from objective and route coverage needs; camera count follows the request. */
export function regionEditEvidenceCameras(
  request: RegionEditRequest,
  plan: SpatialWorldPlan,
  world: WorldBuild,
  fieldOfViewDegrees: number,
): SpatialWorldPlan["cameras"] {
  const cameras = [...plan.cameras];
  const regionIds = plan.regions.map((region) => region.regionId);
  const targetEvidence = new Map(
    regionEditTargetEvidence(request.objectives, plan, world).map((entry) => [
      entry.objectiveId,
      entry,
    ]),
  );
  const add = (identity: unknown, bounds: WorldBounds, rationale: string) => {
    const width = bounds.max.x - bounds.min.x;
    const depth = bounds.max.z - bounds.min.z;
    const span = Math.max(width, depth, 4);
    const center = {
      x: (bounds.min.x + bounds.max.x) / 2,
      z: (bounds.min.z + bounds.max.z) / 2,
    };
    cameras.push({
      cameraId: `EditEvidence_${contentHash(stableJson(identity)).slice(0, 16)}`,
      positionMeters: {
        x: center.x - span * 0.65,
        y: Math.max(8, span * 0.75),
        z: center.z - span * 0.65,
      },
      lookAtMeters: { x: center.x, y: 1.5, z: center.z },
      up: { x: 0, y: 1, z: 0 },
      fieldOfViewDegrees,
      regionIds,
      readabilityIntent: { kind: "art_directed", rationale },
    });
  };
  for (const objective of request.objectives) {
    if (objective.kind === "terrain_material") {
      const operation = plan.terrainPlans
        .find((terrain) => terrain.terrainPlanId === objective.terrainPlanId)
        ?.operations.at(objective.operationIndex);
      if (operation?.kind !== "paint") continue;
      const maskBounds = horizontalMaskBounds(operation.mask);
      add(
        { objectiveId: objective.objectiveId, mask: operation.mask },
        {
          min: {
            x: maskBounds.min.x,
            y: plan.boundsMeters.min.y,
            z: maskBounds.min.z,
          },
          max: {
            x: maskBounds.max.x,
            y: plan.boundsMeters.max.y,
            z: maskBounds.max.z,
          },
        },
        `Compare the complete affected terrain-material target for ${objective.objectiveId}.`,
      );
      continue;
    }
    const evidence = targetEvidence.get(objective.objectiveId);
    if (!evidence) continue;
    add(
      { objectiveId: objective.objectiveId, boundsMeters: evidence.boundsMeters },
      evidence.baselineClearingBounds ?? evidence.boundsMeters,
      `Compare the complete affected vegetation target for ${objective.objectiveId}.`,
    );
  }
  for (const routeId of request.preservation.exactRouteIds) {
    const route = plan.routes.find((candidate) => candidate.routeId === routeId);
    if (!route) continue;
    add(
      { routeId, alignmentMeters: route.alignmentMeters },
      {
        min: {
          x: Math.min(...route.alignmentMeters.map((point) => point.x)),
          y: plan.boundsMeters.min.y,
          z: Math.min(...route.alignmentMeters.map((point) => point.z)),
        },
        max: {
          x: Math.max(...route.alignmentMeters.map((point) => point.x)),
          y: plan.boundsMeters.max.y,
          z: Math.max(...route.alignmentMeters.map((point) => point.z)),
        },
      },
      `Compare the complete protected route ${routeId} and its visible clearance.`,
    );
  }
  return cameras;
}

export function expandRegionEditProposal(input: {
  request: RegionEditRequest;
  proposal: RegionEditProposal;
  plan: SpatialWorldPlan;
  world: WorldBuild;
  catalogSnapshotHash: string;
}): { changes: WorldChange[]; constraints: PopulationPlacementConstraints } {
  if (
    input.proposal.requestHash !== input.request.hash ||
    input.proposal.basePlanHash !== input.plan.planHash ||
    input.proposal.baseWorldBuildHash !== input.world.worldBuildHash
  )
    throw new Error("Region edit proposal binds stale request or world evidence");
  if (input.request.unresolvedRequirements.length)
    throw new Error(
      `Region edit request is unresolved: ${input.request.unresolvedRequirements.join("; ")}`,
    );
  const changes: WorldChange[] = [];
  const masks: PopulationPlacementConstraints["regenerationMasks"] = [];
  const vegetation = input.plan.realizationIntents.flatMap((intent) =>
    intent.kind === "surface_scatter" && intent.vegetation ? [intent] : [],
  );
  const targetEvidence = new Map(
    regionEditTargetEvidence(input.request.objectives, input.plan, input.world).map((entry) => [
      entry.objectiveId,
      entry,
    ]),
  );
  for (const operation of input.proposal.operations) {
    if (operation.kind === "terrain_material") {
      changes.push({
        kind: "terrain_paint",
        terrainPlanId: operation.terrainPlanId,
        operationIndex: operation.operationIndex,
        materialId: operation.materialId,
        polygon: operation.polygon,
      });
      continue;
    }
    const targets = vegetation.filter(
      (intent) =>
        intent.vegetation!.areaId === operation.areaId &&
        operation.layers.includes(intent.vegetation!.layer),
    );
    if (!targets.length) {
      if (operation.kind === "vegetation_density") {
        const objectives = operation.objectiveIds.map((objectiveId) =>
          input.request.objectives.find((entry) => entry.objectiveId === objectiveId),
        );
        if (
          objectives.some(
            (objective) =>
              objective?.kind !== "vegetation_density" || objective.direction !== "decrease",
          )
        )
          throw new Error(
            `Density increase has no authored population layer: ${operation.areaId}/${operation.layers.join(",")}`,
          );
      }
      // A missing layer is deterministic evidence that a clearing or density decrease is already
      // satisfied. No compiler change or regeneration mask is needed; objective verification below
      // still checks the realized base and candidate worlds independently.
      continue;
    }
    if (operation.kind === "vegetation_density") {
      const resolvedTargets = operation.objectiveIds.flatMap((objectiveId) => {
        const objective = input.request.objectives.find(
          (entry) => entry.objectiveId === objectiveId,
        );
        const evidence = targetEvidence.get(objectiveId);
        return objective?.kind === "vegetation_density" &&
          evidence &&
          objective.spatialTarget.areaIds.includes(operation.areaId)
          ? [{ boundsMeters: evidence.boundsMeters }]
          : [];
      });
      if (operation.populationDensityMultiplier === 0) {
        const falloffMeters = Math.max(
          ...targets.map((target) => target.densityField!.edgeFadeMeters),
        );
        const clearings = [
          ...new Map(
            resolvedTargets.map(({ boundsMeters }) => [
              stableJson(boundsMeters),
              hardVegetationClearing(boundsMeters, falloffMeters),
            ]),
          ).values(),
        ];
        if (!clearings.length)
          throw new Error(`Zero-density edit for ${operation.areaId} has no resolved target`);
        for (const intent of targets)
          changes.push({ kind: "vegetation_clearings", intentId: intent.intentId, clearings });
      } else {
        const spacingMultiplier = 1 / Math.sqrt(operation.populationDensityMultiplier);
        for (const intent of targets) {
          const maximumCount = Math.max(
            1,
            intent.minimumCount,
            Math.round(intent.targetCount * operation.populationDensityMultiplier),
          );
          if (!Number.isSafeInteger(maximumCount))
            throw new Error(
              `Density edit for ${intent.intentId} exceeds exact count representation`,
            );
          changes.push({
            kind: "vegetation_density",
            intentId: intent.intentId,
            candidateDensityPerSquareMeter:
              intent.vegetation!.candidateDensityPerSquareMeter *
              operation.populationDensityMultiplier,
            spacingMeters: {
              minimum: intent.vegetation!.spacingMeters.minimum * spacingMultiplier,
              maximum: intent.vegetation!.spacingMeters.maximum * spacingMultiplier,
            },
            maximumCount,
          });
        }
      }
      for (const objectiveId of operation.objectiveIds) {
        const objective = input.request.objectives.find(
          (entry) => entry.objectiveId === objectiveId,
        );
        const evidence = targetEvidence.get(objectiveId);
        if (!objective || objective.kind !== "vegetation_density" || !evidence) continue;
        if (!objective.spatialTarget.areaIds.includes(operation.areaId)) continue;
        masks.push({
          objectiveId,
          areaId: operation.areaId,
          layers: operation.layers,
          boundsMeters: evidence.boundsMeters,
          transitionMeters: Math.max(
            ...targets.map((target) => target.densityField!.edgeFadeMeters),
          ),
        });
      }
    } else {
      const horizontalBounds = horizontalMaskBounds(operation.mask);
      const clearingBounds = {
        min: {
          x: horizontalBounds.min.x,
          y: operation.verticalRangeMeters.minimum,
          z: horizontalBounds.min.z,
        },
        max: {
          x: horizontalBounds.max.x,
          y: operation.verticalRangeMeters.maximum,
          z: horizontalBounds.max.z,
        },
      };
      if (!boundsContains(input.plan.boundsMeters, clearingBounds))
        throw new Error(`Clearing for ${operation.areaId} lies outside the authored world`);
      for (const objectiveId of operation.objectiveIds) {
        const objective = input.request.objectives.find(
          (entry) => entry.objectiveId === objectiveId,
        );
        const evidence = targetEvidence.get(objectiveId);
        if (!objective || objective.kind !== "vegetation_clearing" || !evidence) continue;
        validateClearingBounds(objective, evidence, clearingBounds);
      }
      for (const intent of targets)
        changes.push({
          kind: "vegetation_clearings",
          intentId: intent.intentId,
          clearings: [
            {
              mask: operation.mask,
              verticalRangeMeters: operation.verticalRangeMeters,
              falloffMeters: operation.falloffMeters,
            },
          ],
        });
      masks.push(
        ...operation.objectiveIds.map((objectiveId) => ({
          objectiveId,
          areaId: operation.areaId,
          layers: operation.layers,
          boundsMeters: clearingBounds,
          transitionMeters: operation.falloffMeters,
        })),
      );
    }
  }
  const uniqueMasks = [
    ...new Map(
      masks.map((mask) => [
        stableJson({
          objectiveId: mask.objectiveId,
          areaId: mask.areaId,
          layers: [...mask.layers].sort(),
          boundsMeters: mask.boundsMeters,
          transitionMeters: mask.transitionMeters,
        }),
        mask,
      ]),
    ).values(),
  ];
  const byIntent = new Map(vegetation.map((intent) => [intent.intentId, intent] as const));
  const retainedPlacements = input.world.instances.flatMap((instance) => {
    const intent = byIntent.get(instance.intentId);
    if (!intent) return [];
    const center = instance.transformMeters.position;
    const regenerated = uniqueMasks.some(
      (mask) =>
        mask.areaId === intent.vegetation!.areaId &&
        mask.layers.includes(intent.vegetation!.layer) &&
        pointInsideExpandedBounds(center.x, center.z, mask.boundsMeters, mask.transitionMeters),
    );
    return regenerated
      ? []
      : [
          {
            intentId: instance.intentId,
            requirementId: intent.requirementId,
            entryHandle: instance.entryHandle,
            memberId: instance.memberId,
            assetHash: instance.assetHash,
            transformMeters: {
              position: instance.transformMeters.position,
              rotation: instance.transformMeters.rotation,
              scale: 1 as const,
            },
          },
        ];
  });
  return {
    changes: canonicalizeWorldChanges(changes),
    constraints: sealPopulationPlacementConstraints({
      sourceWorldBuildHash: input.world.worldBuildHash,
      catalogSnapshotHash: input.catalogSnapshotHash,
      retainedPlacements,
      regenerationMasks: uniqueMasks,
    }),
  };
}

/** Every frozen creator objective and every preservation requirement is checked independently. */
export function regionEditEffect(input: {
  request: RegionEditRequest;
  proposal: RegionEditProposal;
  constraints: PopulationPlacementConstraints;
  beforePlan: SpatialWorldPlan;
  before: WorldBuild;
  afterPlan: SpatialWorldPlan;
  after: WorldBuild;
  changes: readonly WorldChange[];
}) {
  const beforeVegetation = vegetationInstances(input.beforePlan, input.before);
  const afterVegetation = vegetationInstances(input.afterPlan, input.after);
  const targetEvidence = new Map(
    regionEditTargetEvidence(input.request.objectives, input.beforePlan, input.before).map(
      (entry) => [entry.objectiveId, entry],
    ),
  );
  const checks = input.request.objectives.map((objective) => {
    if (objective.kind === "terrain_material") {
      const after = input.afterPlan.terrainPlans
        .find((entry) => entry.terrainPlanId === objective.terrainPlanId)
        ?.operations.at(objective.operationIndex);
      const status =
        after?.kind === "paint" && after.materialId === objective.requestedMaterialId
          ? ("eligible" as const)
          : ("incomplete" as const);
      return { objectiveId: objective.objectiveId, kind: objective.kind, status };
    }
    const targetBounds = targetEvidence.get(objective.objectiveId)?.boundsMeters;
    if (!targetBounds)
      throw new Error(`Edit effect has no resolved target for ${objective.objectiveId}`);
    const matching = (entries: ReturnType<typeof vegetationInstances>) =>
      entries.filter(
        (entry) =>
          objective.spatialTarget.areaIds.includes(entry.areaId) &&
          objective.layers.includes(entry.layer),
      );
    if (objective.kind === "vegetation_density") {
      const select = (entries: ReturnType<typeof vegetationInstances>) =>
        matching(entries).filter((entry) =>
          pointInsideExpandedBounds(entry.position.x, entry.position.z, targetBounds, 0),
        );
      const before = select(beforeVegetation);
      const after = select(afterVegetation);
      const delta = after.length - before.length;
      const satisfaction =
        (objective.direction === "increase" && delta > 0) ||
        (objective.direction === "decrease" && delta < 0)
          ? ("realized_change" as const)
          : objective.direction === "decrease" && before.length === 0 && after.length === 0
            ? ("already_satisfied" as const)
            : ("not_satisfied" as const);
      const status =
        satisfaction === "realized_change" || satisfaction === "already_satisfied"
          ? ("eligible" as const)
          : ("incomplete" as const);
      return {
        objectiveId: objective.objectiveId,
        kind: objective.kind,
        direction: objective.direction,
        before: before.length,
        after: after.length,
        satisfaction,
        status,
      };
    }
    const operationMasks = input.proposal.operations.flatMap((operation) =>
      operation.kind === "vegetation_clearing" &&
      operation.objectiveIds.includes(objective.objectiveId)
        ? [operation]
        : [],
    );
    const insideOperation = (entry: ReturnType<typeof vegetationInstances>[number]) =>
      operationMasks.some(
        (operation) =>
          entry.position.y >= operation.verticalRangeMeters.minimum &&
          entry.position.y <= operation.verticalRangeMeters.maximum &&
          horizontalMaskContainsPoint(operation.mask, entry.position),
      );
    const afterInside = matching(afterVegetation).filter(insideOperation);
    const beforeInside = matching(beforeVegetation).filter(insideOperation);
    const satisfaction =
      afterInside.length > 0
        ? ("not_satisfied" as const)
        : beforeInside.length > 0
          ? ("realized_change" as const)
          : ("already_satisfied" as const);
    return {
      objectiveId: objective.objectiveId,
      kind: objective.kind,
      beforeInside: beforeInside.length,
      afterInside: afterInside.length,
      satisfaction,
      status: satisfaction === "not_satisfied" ? ("incomplete" as const) : ("eligible" as const),
    };
  });
  const visible = (w: WorldBuild) => w.instances.map(physicalInstance).sort(comparePhysical);
  const instancesChanged = stableJson(visible(input.before)) !== stableJson(visible(input.after));
  const terrainChanged =
    stableJson(input.beforePlan.terrainPlans) !== stableJson(input.afterPlan.terrainPlans);
  const diagnostics = checks
    .filter((check) => check.status === "incomplete")
    .map((check) => `Creator objective ${check.objectiveId} has no verified realized effect`);
  const afterPhysical = new Set(
    input.after.instances.map((instance) => stableJson(physicalInstance(instance))),
  );
  const retainedPlacementChecks = input.constraints.retainedPlacements.map((lock) => {
    const expected = stableJson({
      intentId: lock.intentId,
      entryHandle: lock.entryHandle,
      memberId: lock.memberId,
      assetHash: lock.assetHash,
      transformMeters: lock.transformMeters,
    });
    const status = afterPhysical.has(expected) ? ("eligible" as const) : ("incomplete" as const);
    if (status === "incomplete")
      diagnostics.push(`Retained population placement changed: ${lock.lockId}`);
    return { lockId: lock.lockId, physicalHash: lock.physicalHash, status };
  });
  const exactIntentChecks = input.request.preservation.exactIntentIds.map((intentId) => {
    const before = input.before.instances
      .filter((entry) => entry.intentId === intentId)
      .map(physicalInstance);
    const after = input.after.instances
      .filter((entry) => entry.intentId === intentId)
      .map(physicalInstance);
    const status =
      stableJson(before.sort(comparePhysical)) === stableJson(after.sort(comparePhysical))
        ? ("eligible" as const)
        : ("incomplete" as const);
    if (status === "incomplete") diagnostics.push(`Protected intent changed: ${intentId}`);
    return { intentId, status };
  });
  const exactRouteChecks = input.request.preservation.exactRouteIds.map((routeId) => {
    const before = input.beforePlan.routes.find((entry) => entry.routeId === routeId);
    const after = input.afterPlan.routes.find((entry) => entry.routeId === routeId);
    const status =
      stableJson(before) === stableJson(after) ? ("eligible" as const) : ("incomplete" as const);
    if (status === "incomplete") diagnostics.push(`Protected route changed: ${routeId}`);
    return { routeId, status };
  });
  if (!instancesChanged && !terrainChanged && checks.some((check) => check.status === "incomplete"))
    diagnostics.push(
      "The edit changed no realized placements or terrain; parameter changes alone do not establish a visible edit",
    );
  return {
    status: diagnostics.length ? ("incomplete" as const) : ("eligible" as const),
    checks,
    preservation: {
      retainedPlacements: {
        requested: retainedPlacementChecks.length,
        verified: retainedPlacementChecks.filter((check) => check.status === "eligible").length,
        status: retainedPlacementChecks.every((check) => check.status === "eligible")
          ? ("eligible" as const)
          : ("incomplete" as const),
      },
      exactIntents: exactIntentChecks,
      exactRoutes: exactRouteChecks,
    },
    instancesChanged,
    terrainChanged,
    diagnostics,
  };
}

function resolveSpatialTargetBounds(
  target: RegionEditSpatialTarget,
  plan: SpatialWorldPlan,
  world: WorldBuild,
): WorldBounds {
  const vegetation = plan.realizationIntents.flatMap((intent) =>
    intent.kind === "surface_scatter" &&
    intent.vegetation &&
    target.areaIds.includes(intent.vegetation.areaId)
      ? [intent]
      : [],
  );
  if (!vegetation.length)
    throw new Error(
      `Spatial target has no authored vegetation areas: ${target.areaIds.join(", ")}`,
    );
  const areaBounds = mergeBounds(
    vegetation.map((intent) => boundaryBounds(intent.boundary, plan.boundsMeters)),
  );
  if (target.kind === "whole_areas") return areaBounds;
  if (target.kind === "directional_areas") {
    const centerX = (areaBounds.min.x + areaBounds.max.x) / 2;
    const centerZ = (areaBounds.min.z + areaBounds.max.z) / 2;
    const north = target.direction.includes("north"),
      south = target.direction.includes("south"),
      east = target.direction.includes("east"),
      west = target.direction.includes("west");
    return {
      min: {
        x: east ? centerX : areaBounds.min.x,
        y: areaBounds.min.y,
        z: north ? centerZ : areaBounds.min.z,
      },
      max: {
        x: west ? centerX : areaBounds.max.x,
        y: areaBounds.max.y,
        z: south ? centerZ : areaBounds.max.z,
      },
    };
  }
  const anchors = world.instances.filter((instance) =>
    target.intentIds.includes(instance.intentId),
  );
  if (!anchors.length)
    throw new Error(
      `Spatial target has no verified anchor placements: ${target.intentIds.join(", ")}`,
    );
  const anchorBounds = mergeBounds(anchors.map((instance) => instance.boundsMeters));
  return anchorBounds;
}

function resolveExistingClearingBounds(
  objective: Exclude<RegionEditObjective, { kind: "terrain_material" }>,
  targetBounds: WorldBounds,
  plan: SpatialWorldPlan,
) {
  const candidates = plan.realizationIntents
    .flatMap((intent) =>
      intent.kind === "surface_scatter" &&
      intent.vegetation &&
      objective.spatialTarget.areaIds.includes(intent.vegetation.areaId) &&
      objective.layers.includes(intent.vegetation.layer)
        ? intent.vegetation.clearings
        : [],
    )
    .filter((clearing) => boundsContainsXZ(vegetationClearingBounds(clearing), targetBounds));
  return [...new Map(candidates.map((clearing) => [stableJson(clearing), clearing])).values()].sort(
    (left, right) =>
      boundsAreaXZ(vegetationClearingBounds(left)) - boundsAreaXZ(vegetationClearingBounds(right)),
  )[0];
}

function vegetationClearingBounds(clearing: VegetationClearing): WorldBounds {
  const horizontal = horizontalMaskBounds(clearing.mask);
  return {
    min: {
      x: horizontal.min.x,
      y: clearing.verticalRangeMeters.minimum,
      z: horizontal.min.z,
    },
    max: {
      x: horizontal.max.x,
      y: clearing.verticalRangeMeters.maximum,
      z: horizontal.max.z,
    },
  };
}

function hardVegetationClearing(bounds: WorldBounds, falloffMeters: number): VegetationClearing {
  return {
    mask: {
      polygon: [
        { x: bounds.min.x, z: bounds.min.z },
        { x: bounds.max.x, z: bounds.min.z },
        { x: bounds.max.x, z: bounds.max.z },
        { x: bounds.min.x, z: bounds.max.z },
      ],
      edgeProfile: { kind: "hard" },
    },
    verticalRangeMeters: { minimum: bounds.min.y, maximum: bounds.max.y },
    falloffMeters,
  };
}

function resolveTargetTransitionMeters(
  objective: Exclude<RegionEditObjective, { kind: "terrain_material" }>,
  plan: SpatialWorldPlan,
) {
  const areaIntents = plan.realizationIntents.flatMap((intent) =>
    intent.kind === "surface_scatter" &&
    intent.vegetation &&
    objective.spatialTarget.areaIds.includes(intent.vegetation.areaId)
      ? [intent]
      : [],
  );
  const layerTransitions = areaIntents.flatMap((intent) =>
    objective.layers.includes(intent.vegetation!.layer)
      ? [intent.densityField!.edgeFadeMeters]
      : [],
  );
  const transitions = layerTransitions.length
    ? layerTransitions
    : areaIntents.map((intent) => intent.densityField!.edgeFadeMeters);
  if (!transitions.length)
    throw new Error(`Edit objective ${objective.objectiveId} has no authored transition evidence`);
  return Math.max(...transitions);
}

function expandBoundsXZ(bounds: WorldBounds, distance: number, limit: WorldBounds): WorldBounds {
  return {
    min: {
      x: Math.max(limit.min.x, bounds.min.x - distance),
      y: bounds.min.y,
      z: Math.max(limit.min.z, bounds.min.z - distance),
    },
    max: {
      x: Math.min(limit.max.x, bounds.max.x + distance),
      y: bounds.max.y,
      z: Math.min(limit.max.z, bounds.max.z + distance),
    },
  };
}

function canonicalizeWorldChanges(changes: readonly WorldChange[]): WorldChange[] {
  const identity = (change: WorldChange) => {
    switch (change.kind) {
      case "vegetation_density":
        return `density:${change.intentId}`;
      case "vegetation_clearings":
        return `clearings:${change.intentId}`;
      case "terrain_paint":
        return `paint:${change.terrainPlanId}:${change.operationIndex}`;
      case "construction_parameter":
        return `construction:${change.programId}:${change.parameterId}`;
      case "route_alternative":
        return `route:${change.routeId}`;
    }
  };
  const merged = new Map<string, WorldChange>();
  for (const change of changes) {
    const key = identity(change);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, change);
      continue;
    }
    if (existing.kind === "vegetation_clearings" && change.kind === "vegetation_clearings") {
      const clearings = [
        ...new Map(
          [...existing.clearings, ...change.clearings].map((clearing) => [
            stableJson(clearing),
            clearing,
          ]),
        ).values(),
      ].sort((left, right) => stableJson(left).localeCompare(stableJson(right)));
      merged.set(key, { ...existing, clearings });
      continue;
    }
    if (stableJson(existing) !== stableJson(change))
      throw new Error(`Edit objectives proposed conflicting compiler changes for ${key}`);
  }
  return [...merged.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, change]) => change);
}

function validateClearingBounds(
  objective: Extract<RegionEditObjective, { kind: "vegetation_clearing" }>,
  evidence: ReturnType<typeof regionEditTargetEvidence>[number],
  proposed: WorldBounds,
) {
  if (objective.spatialTarget.kind === "around_intents") {
    const required = evidence.baselineClearingBounds ?? evidence.boundsMeters;
    if (!boundsContainsXZ(proposed, required))
      throw new Error(`Clearing ${objective.objectiveId} does not contain its verified target`);
    if (
      objective.change === "expand" &&
      boundsAreaXZ(proposed) <= boundsAreaXZ(required) + Number.EPSILON
    )
      throw new Error(`Clearing ${objective.objectiveId} did not expand its existing footprint`);
    return;
  }
  if (!boundsContainsXZ(evidence.boundsMeters, proposed))
    throw new Error(`Clearing ${objective.objectiveId} lies outside its requested spatial target`);
}

function mergeBounds(bounds: readonly WorldBounds[]): WorldBounds {
  if (!bounds.length) throw new Error("Cannot merge an empty bounds collection");
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

function boundsAreaXZ(bounds: WorldBounds) {
  return (bounds.max.x - bounds.min.x) * (bounds.max.z - bounds.min.z);
}

function boundsContains(outer: WorldBounds, inner: WorldBounds) {
  return (["x", "y", "z"] as const).every(
    (axis) => outer.min[axis] <= inner.min[axis] && outer.max[axis] >= inner.max[axis],
  );
}

function boundsContainsXZ(outer: WorldBounds, inner: WorldBounds) {
  return (["x", "z"] as const).every(
    (axis) => outer.min[axis] <= inner.min[axis] && outer.max[axis] >= inner.max[axis],
  );
}

function boundaryBounds(
  boundary: readonly { u: number; v: number }[],
  worldBounds: SpatialWorldPlan["boundsMeters"],
) {
  return {
    min: {
      x: Math.min(...boundary.map((point) => point.u)),
      y: worldBounds.min.y,
      z: Math.min(...boundary.map((point) => point.v)),
    },
    max: {
      x: Math.max(...boundary.map((point) => point.u)),
      y: worldBounds.max.y,
      z: Math.max(...boundary.map((point) => point.v)),
    },
  };
}

function pointInsideExpandedBounds(
  x: number,
  z: number,
  bounds: SpatialWorldPlan["boundsMeters"],
  expansion: number,
) {
  return (
    x >= bounds.min.x - expansion &&
    x <= bounds.max.x + expansion &&
    z >= bounds.min.z - expansion &&
    z <= bounds.max.z + expansion
  );
}

function physicalInstance(instance: WorldBuild["instances"][number]) {
  return {
    intentId: instance.intentId,
    entryHandle: instance.entryHandle,
    memberId: instance.memberId,
    assetHash: instance.assetHash,
    transformMeters: instance.transformMeters,
  };
}

function comparePhysical(
  left: ReturnType<typeof physicalInstance>,
  right: ReturnType<typeof physicalInstance>,
) {
  return stableJson(left).localeCompare(stableJson(right));
}

function vegetationInstances(plan: SpatialWorldPlan, world: WorldBuild) {
  const intent = new Map(
    plan.realizationIntents.flatMap((entry) =>
      entry.kind === "surface_scatter" && entry.vegetation
        ? [[entry.intentId, entry.vegetation] as const]
        : [],
    ),
  );
  return world.instances.flatMap((instance) => {
    const vegetation = intent.get(instance.intentId);
    return vegetation
      ? [
          {
            areaId: vegetation.areaId,
            layer: vegetation.layer,
            position: instance.transformMeters.position,
          },
        ]
      : [];
  });
}
