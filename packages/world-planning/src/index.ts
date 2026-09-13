import { contentHash, stableJson } from "@basalt/contracts";
import { SPATIAL_WORLD_PLAN_SCHEMA, type SpatialWorldPlan } from "./contracts.js";
import { assemblePlanRoads, type RoadAssembly } from "./roads.js";
import { subdivideWorldPlanToLots, type LotSubdivision } from "./lots.js";

export * from "./contracts.js";
export * from "./roads.js";
export * from "./lots.js";

export interface CompiledWorldPlan {
  readonly plan: SpatialWorldPlan;
  readonly worldPlanHash: string;
  readonly roadAssemblies: readonly RoadAssembly[];
  readonly lotSubdivisions: readonly LotSubdivision[];
  readonly surfaceIndexHash: string;
}

/** Foundation compilation never depends on catalog availability. */
export function compileWorldPlan(input: unknown): CompiledWorldPlan {
  const plan = SPATIAL_WORLD_PLAN_SCHEMA.parse(input);
  const roadAssemblies = assemblePlanRoads(plan);
  const lotSubdivisions = subdivideWorldPlanToLots(plan);
  return Object.freeze({
    plan,
    worldPlanHash: plan.planHash,
    roadAssemblies,
    lotSubdivisions,
    surfaceIndexHash: contentHash(stableJson(plan.placementSurfaces)),
  });
}

export function canonicalWorldPlan(input: unknown): SpatialWorldPlan {
  return SPATIAL_WORLD_PLAN_SCHEMA.parse(input);
}
