import { contentHash, stableJson } from "../../contracts/src/index.js";
import {
  compileWorldPlan,
  type CompiledWorldPlan,
  type WorldPlan,
} from "../../world-planning/src/index.js";
import {
  assertWorldCompilerPlanIdentity,
  sealWorldCompilerPlan,
  type WorldCompilerPlan,
  type WorldFamilyPopulationPlan,
} from "./contracts.js";

export * from "./contracts.js";
export * from "./primitives.js";
export * from "./population.js";
export * from "./family-resolver.js";
export * from "./emission.js";
export * from "./tiers.js";
export * from "./relations.js";

export interface BasaltWorldFoundation {
  readonly kind: "BasaltWorldFoundation";
  readonly worldPlan: CompiledWorldPlan;
  readonly worldPlanHash: string;
  readonly surfaceIndexHash: string;
  readonly regionIds: readonly string[];
  readonly terrainSurfaceIds: readonly string[];
  readonly constructedSurfaceIds: readonly string[];
  readonly routeIds: readonly string[];
}

/** Compile macro world authority before assets, neural jobs, or population. */
export function compileBasaltWorldFoundation(input: unknown): BasaltWorldFoundation {
  const worldPlan = compileWorldPlan(input);
  return {
    kind: "BasaltWorldFoundation",
    worldPlan,
    worldPlanHash: worldPlan.worldPlanHash,
    surfaceIndexHash: worldPlan.surfaceIndexHash,
    regionIds: worldPlan.plan.regions.map((region) => region.id).sort(),
    terrainSurfaceIds: worldPlan.terrainFields.map((field) => field.surfaceId).sort(),
    constructedSurfaceIds: worldPlan.plan.constructedSurfaces.map((surface) => surface.id).sort(),
    routeIds: worldPlan.plan.routes.map((route) => route.id).sort(),
  };
}

/** Build the family-level intent artifact that feeds deterministic population. */
export function createBasaltWorldCompilerPlan(input: {
  readonly foundation: BasaltWorldFoundation;
  readonly styleContractHash: string;
  readonly stage?: "macro" | "meso" | "micro" | "partition";
  readonly familyPlans: readonly WorldFamilyPopulationPlan[];
  readonly createdAt?: string;
}): WorldCompilerPlan {
  const regionIds = new Set(input.foundation.regionIds);
  for (const family of input.familyPlans)
    for (const regionId of family.regionIds)
      if (!regionIds.has(regionId))
        throw new Error(`Family plan references unknown region: ${regionId}`);
  return sealWorldCompilerPlan({
    worldPlanHash: input.foundation.worldPlanHash,
    styleContractHash: input.styleContractHash,
    stage: input.stage ?? "meso",
    familyPlans: [...input.familyPlans],
    createdAt: input.createdAt ?? new Date().toISOString(),
  });
}

/** Stable summary used by the creator director; it contains no raw mesh inventory. */
export function summarizeBasaltWorld(input: {
  readonly foundation: BasaltWorldFoundation;
  readonly compilerPlan?: WorldCompilerPlan;
}): { readonly hash: string; readonly summary: Record<string, unknown> } {
  if (input.compilerPlan) assertWorldCompilerPlanIdentity(input.compilerPlan);
  const summary = {
    kind: "BasaltWorldSummary",
    worldPlanHash: input.foundation.worldPlanHash,
    surfaceIndexHash: input.foundation.surfaceIndexHash,
    regionIds: [...input.foundation.regionIds].sort(),
    terrainSurfaceIds: [...input.foundation.terrainSurfaceIds].sort(),
    constructedSurfaceIds: [...input.foundation.constructedSurfaceIds].sort(),
    routeIds: [...input.foundation.routeIds].sort(),
    ...(input.compilerPlan
      ? {
          compilerPlanHash: input.compilerPlan.hash,
          familyIds: input.compilerPlan.familyPlans.map((family) => family.familyId),
        }
      : {}),
  };
  return { hash: contentHash(stableJson(summary)), summary };
}

export type { WorldPlan };
