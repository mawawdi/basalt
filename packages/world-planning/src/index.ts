import { contentHash, stableJson } from "@basalt/contracts";
import { SPATIAL_WORLD_PLAN_SCHEMA, type SpatialWorldPlan } from "./contracts.js";
import { subdivideWorldPlanToLots, type LotSubdivision } from "./lots.js";

export * from "./contracts.js";
export * from "./construction.js";
export * from "./terrain.js";
export * from "./routes.js";
export * from "./route-horizontal.js";
export * from "./lots.js";

export interface CompiledWorldPlan {
  readonly plan: SpatialWorldPlan;
  readonly foundationInputHash: string;
  readonly lotSubdivisions: readonly LotSubdivision[];
  readonly surfaceIndexHash: string;
}

/** Foundation compilation never depends on catalog availability. */
export function compileWorldPlan(input: unknown): CompiledWorldPlan {
  const plan = SPATIAL_WORLD_PLAN_SCHEMA.parse(input);
  const lotSubdivisions = subdivideWorldPlanToLots(plan);
  return Object.freeze({
    plan,
    foundationInputHash: worldFoundationInputHash(plan),
    lotSubdivisions,
    surfaceIndexHash: contentHash(stableJson(plan.placementSurfaces)),
  });
}

export function worldFoundationInputHash(planInput: SpatialWorldPlan): string {
  const plan = SPATIAL_WORLD_PLAN_SCHEMA.parse(planInput);
  return contentHash(
    stableJson({
      boundsMeters: plan.boundsMeters,
      regions: plan.regions,
      placementSurfaces: plan.placementSurfaces,
      terrainPlans: plan.terrainPlans,
      routes: plan.routes,
      routeJunctions: plan.routeJunctions,
      lotPolicies: plan.lotPolicies,
    }),
  );
}

export function canonicalWorldPlan(input: unknown): SpatialWorldPlan {
  return SPATIAL_WORLD_PLAN_SCHEMA.parse(input);
}
