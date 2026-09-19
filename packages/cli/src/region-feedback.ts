import { z } from "zod";
import { stableJson } from "@basalt/contracts";
import type { SpatialWorldPlan } from "@basalt/world-planning";
import type { WorldBuild } from "@basalt/world-compiler";
import {
  WORLD_CHANGE_SCHEMA,
  type RefinementPolicy,
  type WorldChange,
} from "@basalt/world-refinement";

/** The provider sees exactly the operation kinds and target IDs authorized for this edit. */
export function regionEditResponseSchema(policy: RefinementPolicy) {
  const choices: z.ZodType<WorldChange>[] = [];
  if (policy.vegetation.length) {
    const intentId = z.enum(policy.vegetation.map((r) => r.intentId));
    choices.push(
      WORLD_CHANGE_SCHEMA.options[0].extend({
        intentId,
        candidateDensityPerSquareMeter: z
          .number()
          .finite()
          .min(Math.min(...policy.vegetation.map((r) => r.minimumDensity)))
          .max(Math.max(...policy.vegetation.map((r) => r.maximumDensity))),
        maximumCount: z
          .number()
          .int()
          .positive()
          .max(Math.max(...policy.vegetation.map((r) => r.maximumCount))),
      }),
      WORLD_CHANGE_SCHEMA.options[1].extend({ intentId }),
    );
  }
  for (const rule of policy.terrainPaint)
    choices.push(
      WORLD_CHANGE_SCHEMA.options[2].extend({
        terrainPlanId: z.literal(rule.terrainPlanId),
        operationIndex: z.literal(rule.operationIndex),
        materialId: z.enum(rule.allowedMaterialIds),
      }),
    );
  if (!choices.length)
    throw new Error("This world has no editable vegetation or existing ground-paint targets");
  return z
    .object({
      changes: z.array(z.union(choices)).min(1).max(32),
      rationale: z.string().min(1).max(2048),
    })
    .strict();
}

/** Counts describe actual output, not requested caps or model confidence. */
export function regionPopulationEvidence(plan: SpatialWorldPlan, world: WorldBuild) {
  return plan.realizationIntents.flatMap((i) => {
    if (i.kind !== "surface_scatter" || !i.vegetation) return [];
    return [
      {
        intentId: i.intentId,
        requirementId: i.requirementId,
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
export function regionLandscapeEvidence(plan: SpatialWorldPlan, world: WorldBuild) {
  const resolution = 128;
  const { min, max } = plan.boundsMeters;
  const cellWidth = (max.x - min.x) / resolution;
  const cellDepth = (max.z - min.z) / resolution;
  const layers = new Map(
    ["canopy", "understory", "ground_cover"].map((layer) => [
      layer,
      { layer, instances: 0, cells: new Uint8Array(resolution * resolution) },
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
    const x1 = Math.min(resolution - 1, Math.floor((b.max.x - min.x) / cellWidth - 0.5));
    const z0 = Math.max(0, Math.ceil((b.min.z - min.z) / cellDepth - 0.5));
    const z1 = Math.min(resolution - 1, Math.floor((b.max.z - min.z) / cellDepth - 0.5));
    for (let z = z0; z <= z1; z++)
      for (let x = x0; x <= x1; x++) layer.cells[z * resolution + x] = 1;
  }
  const occupied = new Uint8Array(resolution * resolution);
  for (const layer of layers.values())
    layer.cells.forEach((value, index) => {
      occupied[index] ||= value;
    });
  const fraction = (cells: Uint8Array) =>
    Number((cells.reduce((sum, value) => sum + value, 0) / cells.length).toFixed(4));
  return {
    scope:
      "128 by 128 ground samples inside projected vegetation render bounds. Mesh holes and leaf density are unresolved; terrain materials are excluded. Diagnostic evidence, not an aesthetic acceptance score.",
    cellSizeMeters: { x: cellWidth, z: cellDepth },
    layers: [...layers.values()].map(({ layer, instances, cells }) => ({
      layer,
      instances,
      sampledBoundsCoverage: fraction(cells),
    })),
    fractionOutsideVegetationBounds: Number((1 - fraction(occupied)).toFixed(4)),
    // Sixteen coarse tiles expose large empty domains without sending individual transforms.
    tiles: Array.from({ length: 16 }, (_, index) => {
      const column = index % 4,
        row = Math.floor(index / 4);
      const width = resolution / 4;
      const tileFraction = (cells: Uint8Array) => {
        let count = 0;
        for (let z = row * width; z < (row + 1) * width; z++)
          for (let x = column * width; x < (column + 1) * width; x++)
            count += cells[z * resolution + x]!;
        return Number((count / (width * width)).toFixed(4));
      };
      return {
        boundsXZ: {
          min: { x: min.x + column * width * cellWidth, z: min.z + row * width * cellDepth },
          max: {
            x: min.x + (column + 1) * width * cellWidth,
            z: min.z + (row + 1) * width * cellDepth,
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
) {
  return {
    boundsMeters: plan.boundsMeters,
    landscape: regionLandscapeEvidence(plan, world),
    vegetationTargets: regionPopulationEvidence(plan, world).map((i) => ({
      ...i,
      limits: policy.vegetation.find((r) => r.intentId === i.intentId),
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

/** A changed parameter is not evidence that the requested density changed in the world. */
export function regionEditEffect(input: {
  beforePlan: SpatialWorldPlan;
  before: WorldBuild;
  afterPlan: SpatialWorldPlan;
  after: WorldBuild;
  changes: readonly WorldChange[];
}) {
  const densityGroups = new Map<
    string,
    {
      intentIds: string[];
      before: number;
      after: number;
      directions: number[];
      hasClearing: boolean;
    }
  >();
  for (const change of input.changes) {
    if (change.kind !== "vegetation_density") continue;
    const previous = input.beforePlan.realizationIntents.find(
      (i) => i.intentId === change.intentId,
    )!;
    if (previous.kind !== "surface_scatter" || !previous.vegetation) continue;
    const before = input.before.instances.filter((i) => i.intentId === change.intentId).length;
    const after = input.after.instances.filter((i) => i.intentId === change.intentId).length;
    const direction = Math.sign(
      change.candidateDensityPerSquareMeter - previous.vegetation.candidateDensityPerSquareMeter,
    );
    const hasClearing = input.changes.some(
      (c) => c.kind === "vegetation_clearings" && c.intentId === change.intentId,
    );
    const key = stableJson({
      boundary: previous.boundary,
      layer: previous.vegetation.layer,
      regionId: previous.regionId,
      surfaceId: previous.surfaceId,
    });
    const group = densityGroups.get(key) ?? {
      intentIds: [],
      before: 0,
      after: 0,
      directions: [],
      hasClearing: false,
    };
    group.intentIds.push(change.intentId);
    group.before += before;
    group.after += after;
    if (direction !== 0) group.directions.push(direction);
    group.hasClearing ||= hasClearing;
    densityGroups.set(key, group);
  }
  // Joint species compete. Judge a requested layer increase across its changed species,
  // while mixed-direction edits and simultaneous clearings need spatial image review.
  const checks = [...densityGroups.values()].map((group) => {
    const directions = [...new Set(group.directions)];
    const direction = directions.length === 1 ? directions[0]! : 0;
    return {
      ...group,
      direction,
      status:
        direction === 0 || group.hasClearing || Math.sign(group.after - group.before) === direction
          ? ("eligible" as const)
          : ("incomplete" as const),
    };
  });
  const visible = (w: WorldBuild) =>
    w.instances.map((i) => ({
      instanceId: i.instanceId,
      assetHash: i.assetHash,
      transformMeters: i.transformMeters,
    }));
  const instancesChanged = stableJson(visible(input.before)) !== stableJson(visible(input.after));
  const terrainChanged =
    stableJson(input.beforePlan.terrainPlans) !== stableJson(input.afterPlan.terrainPlans);
  const diagnostics = checks
    .filter((c) => c.status === "incomplete")
    .map(
      (c) =>
        `${c.intentIds.join(", ")}: density requested ${c.direction > 0 ? "more" : "fewer"} plants, but realized count changed from ${c.before} to ${c.after}; inspect spacing, occupancy, clearings and caps`,
    );
  if (!instancesChanged && !terrainChanged)
    diagnostics.push(
      "The edit changed no realized placements or terrain; parameter changes alone do not establish a visible edit",
    );
  return {
    status: diagnostics.length ? ("incomplete" as const) : ("eligible" as const),
    checks,
    instancesChanged,
    terrainChanged,
    diagnostics,
  };
}
