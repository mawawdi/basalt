import { contentHash, stableJson } from "../../contracts/src/index.js";
import { WORLD_PLAN_SCHEMA, type WorldPlan } from "./contracts.js";
import { PlacementSurfaceIndex } from "./surfaces.js";
import {
  analyzeRouteGrades,
  canonicalTerrainPlan,
  compileTerrainPlan,
  type RouteGradeReport,
} from "./terrain.js";

export * from "./contracts.js";
export * from "./primitives.js";
export * from "./surfaces.js";
export * from "./terrain.js";

export interface CompiledWorldPlan {
  readonly plan: WorldPlan;
  readonly worldPlanHash: string;
  readonly surfaceIndexHash: string;
  readonly terrainFields: ReturnType<typeof compileTerrainPlan>[];
  readonly routeProfiles: readonly RouteGradeReport[];
  readonly surfaces: PlacementSurfaceIndex;
}

/** Parse and compile one immutable plan before assets or render work begin. */
export function compileWorldPlan(input: unknown): CompiledWorldPlan {
  const plan = canonicalWorldPlan(input);
  const worldPlanHash = contentHash(stableJson(plan));
  const terrainFields = plan.terrainPlans.map(compileTerrainPlan);
  const surfaces = new PlacementSurfaceIndex(terrainFields, plan.constructedSurfaces);
  const routeProfiles = analyzeRouteGrades(plan, surfaces);
  return {
    plan,
    worldPlanHash,
    surfaceIndexHash: surfaces.hash,
    terrainFields,
    routeProfiles,
    surfaces,
  };
}

/** Canonicalize semantically unordered declarations without reordering paths or operators. */
export function canonicalWorldPlan(input: unknown): WorldPlan {
  const plan = structuredClone(WORLD_PLAN_SCHEMA.parse(input));
  plan.references.sort((left, right) => left.id.localeCompare(right.id));
  for (const reference of plan.references) {
    reference.roles.sort((left, right) => left.localeCompare(right));
    reference.rightsEvidenceHashes.sort((left, right) => left.localeCompare(right));
  }
  plan.creatorClaims.sort((left, right) => left.id.localeCompare(right.id));
  plan.agentHypotheses.sort((left, right) => left.id.localeCompare(right.id));
  for (const claim of [...plan.creatorClaims, ...plan.agentHypotheses])
    claim.referenceIds.sort((left, right) => left.localeCompare(right));
  plan.regions.sort((left, right) => left.id.localeCompare(right.id));
  for (const region of plan.regions)
    region.compositionMeasures.sort((left, right) => left.id.localeCompare(right.id));
  plan.regionRelations.sort((left, right) => left.id.localeCompare(right.id));
  plan.terrainPlans = plan.terrainPlans
    .map(canonicalTerrainPlan)
    .sort((left, right) => left.id.localeCompare(right.id));
  plan.styleOverlays.sort((left, right) => left.id.localeCompare(right.id));
  for (const overlay of plan.styleOverlays) {
    overlay.materialPalette.sort((left, right) => left.materialId.localeCompare(right.materialId));
    overlay.foliageFamilyIds.sort((left, right) => left.localeCompare(right));
  }
  plan.constructedSurfaces.sort((left, right) => left.id.localeCompare(right.id));
  plan.routes.sort((left, right) => left.id.localeCompare(right.id));
  for (const route of plan.routes) {
    route.regionIds.sort((left, right) => left.localeCompare(right));
    route.reachableAnchorIds.sort((left, right) => left.localeCompare(right));
  }
  plan.anchors.sort((left, right) => left.id.localeCompare(right.id));
  plan.collisionProxies.sort((left, right) => left.id.localeCompare(right.id));
  plan.cameras.sort((left, right) => left.id.localeCompare(right.id));
  for (const camera of plan.cameras) {
    camera.regionIds.sort((left, right) => left.localeCompare(right));
    camera.framingAssetIds.sort((left, right) => left.localeCompare(right));
  }
  plan.assetRequirements.sort((left, right) => left.id.localeCompare(right.id));
  for (const requirement of plan.assetRequirements)
    requirement.regionIds.sort((left, right) => left.localeCompare(right));
  return WORLD_PLAN_SCHEMA.parse(plan);
}
