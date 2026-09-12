import { contentHash, stableJson } from "../../contracts/src/index.js";
import { createMurmurHash3Random } from "../../spatial-core/src/primitives.js";
import { isPointInRouteCorridor } from "../../world-planning/src/roads.js";
import type { PlacementSurfaceSample } from "../../world-planning/src/surfaces.js";
import {
  sealWorldPopulationArtifact,
  type WorldCompilerPlan,
  type WorldPopulationArtifact,
  type WorldPopulationInstance,
} from "./contracts.js";
import type { BasaltWorldFoundation } from "./index.js";
import { compareWorldStrings } from "./primitives.js";

export interface BasaltPopulationOptions {
  readonly chunkSize?: number;
  readonly maxAttemptsPerFamilySurface?: number;
}

/**
 * Resolve family intent into chunked transforms without asking a model for an
 * individual object. The only inputs are the immutable world surfaces and the
 * family-level plan; declaration order cannot affect the result.
 */
export function populateBasaltWorld(
  foundation: BasaltWorldFoundation,
  plan: WorldCompilerPlan,
  options: BasaltPopulationOptions = {},
): WorldPopulationArtifact {
  const chunkSize = options.chunkSize ?? 128;
  if (!Number.isFinite(chunkSize) || chunkSize <= 0) throw new Error("Chunk size must be positive");
  const attemptsPerSurface = options.maxAttemptsPerFamilySurface ?? 20;
  if (!Number.isInteger(attemptsPerSurface) || attemptsPerSurface < 1)
    throw new Error("Population attempt budget must be a positive integer");

  const instances: WorldPopulationInstance[] = [];
  for (const family of [...plan.familyPlans].sort((a, b) =>
    compareWorldStrings(a.familyId, b.familyId),
  )) {
    const archetypeCount = family.archetypeCount ?? 1;
    const scaleRange = family.scaleRange ?? ([0.92, 1.08] as const);
    const excludedRegions = new Set(family.excludedRegionIds);
    const surfaces = foundation.worldPlan.surfaces
      .ids()
      .filter((surfaceId) =>
        family.surfaceKinds.includes(foundation.worldPlan.surfaces.kind(surfaceId)),
      )
      .filter((surfaceId) =>
        foundation.worldPlan.surfaces
          .regionIds(surfaceId)
          .some((id) => family.regionIds.includes(id)),
      )
      .filter((surfaceId) =>
        foundation.worldPlan.surfaces.regionIds(surfaceId).every((id) => !excludedRegions.has(id)),
      )
      .sort();
    const surfaceAreas = surfaces.map((surfaceId) => {
      const bounds = foundation.worldPlan.surfaces.coordinateBounds(surfaceId);
      return {
        surfaceId,
        bounds,
        area:
          Math.max(0, bounds.u.maximum - bounds.u.minimum) *
          Math.max(0, bounds.v.maximum - bounds.v.minimum),
      };
    });
    const totalArea = surfaceAreas.reduce((sum, surface) => sum + surface.area, 0);
    const estimatedTotal = Math.floor((totalArea / 256) * family.density.target);
    const totalCount = Math.min(family.maximumCount, Math.max(family.minimumCount, estimatedTotal));
    const allocations = allocateSurfaceCounts(surfaceAreas, totalCount);
    for (const { surfaceId, bounds, area } of surfaceAreas) {
      const count = allocations.get(surfaceId) ?? 0;
      if (count === 0 || area <= 0) continue;
      const rng = seededRandom(
        contentHash(stableJson([family.variationSeed, family.familyId, surfaceId])),
      );
      const accepted: Array<{ sample: PlacementSurfaceSample; yaw: number }> = [];
      const minDistance = Math.max(0.5, Math.sqrt(Math.max(area, 1) / Math.max(count, 1)) * 0.55);
      let attempts = 0;
      while (accepted.length < count && attempts < Math.max(count * attemptsPerSurface, 32)) {
        attempts += 1;
        const coordinate = {
          u: bounds.u.minimum + rng() * (bounds.u.maximum - bounds.u.minimum),
          v: bounds.v.minimum + rng() * (bounds.v.maximum - bounds.v.minimum),
        };
        const sample = foundation.worldPlan.surfaces.sample(surfaceId, coordinate);
        if (!family.regionIds.some((regionId) => (sample.regionWeights[regionId] ?? 0) >= 0.25))
          continue;
        if (isRouteExcluded(foundation, family.excludedRouteIds, surfaceId, sample.position))
          continue;
        if (
          accepted.some(
            (entry) =>
              distance2(entry.sample.position, sample.position) < minDistance * minDistance,
          )
        )
          continue;
        accepted.push({ sample, yaw: rng() * Math.PI * 2 });
      }
      for (const [ordinal, entry] of accepted.entries()) {
        const position = entry.sample.position;
        const chunkId = `chunk_${Math.floor(position.x / chunkSize)}_${Math.floor(position.z / chunkSize)}`;
        const variantSeed = contentHash(
          stableJson([family.variationSeed, family.familyId, surfaceId, ordinal, "variant"]),
        );
        const variant = parseInt(variantSeed.slice(0, 8), 16) % archetypeCount;
        const scaleSeed = parseInt(variantSeed.slice(8, 16), 16) / 0xffff_ffff;
        const scale = scaleRange[0] + (scaleRange[1] - scaleRange[0]) * scaleSeed;
        instances.push({
          id: `instance_${contentHash(stableJson([plan.hash, family.familyId, surfaceId, ordinal])).slice(0, 24)}`,
          familyId: family.familyId,
          archetypeId: `${family.familyId}_archetype_${variant}`,
          chunkId,
          position,
          rotation: surfaceRotation(entry.sample.normal, entry.yaw),
          scale,
        });
      }
    }
  }

  const chunks = new Map<
    string,
    { chunkId: string; familyIds: string[]; instances: WorldPopulationInstance[] }
  >();
  for (const instance of instances) {
    const chunk = chunks.get(instance.chunkId) ?? {
      chunkId: instance.chunkId,
      familyIds: [],
      instances: [],
    };
    if (!chunk.familyIds.includes(instance.familyId)) chunk.familyIds.push(instance.familyId);
    chunk.instances.push(instance);
    chunks.set(instance.chunkId, chunk);
  }
  return sealWorldPopulationArtifact({
    worldPlanHash: foundation.worldPlanHash,
    populationPlanHash: plan.hash,
    chunks: [...chunks.values()],
  });
}

/** Allocate one family budget across surfaces by area using largest remainders. */
function allocateSurfaceCounts(
  surfaces: readonly { surfaceId: string; area: number }[],
  totalCount: number,
): ReadonlyMap<string, number> {
  if (totalCount <= 0 || surfaces.length === 0) return new Map();
  const areaTotal = surfaces.reduce((sum, surface) => sum + surface.area, 0);
  if (areaTotal <= 0) return new Map();
  const floors = surfaces.map((surface) => {
    const exact = (totalCount * surface.area) / areaTotal;
    return {
      surfaceId: surface.surfaceId,
      floor: Math.floor(exact),
      remainder: exact - Math.floor(exact),
    };
  });
  let remaining = totalCount - floors.reduce((sum, value) => sum + value.floor, 0);
  for (const value of [...floors].sort(
    (left, right) =>
      right.remainder - left.remainder || compareWorldStrings(left.surfaceId, right.surfaceId),
  )) {
    if (remaining <= 0) break;
    value.floor += 1;
    remaining -= 1;
  }
  return new Map(floors.map((value) => [value.surfaceId, value.floor]));
}

function isRouteExcluded(
  foundation: BasaltWorldFoundation,
  routeIds: readonly string[],
  surfaceId: string,
  point: { x: number; y: number; z: number },
): boolean {
  if (routeIds.length === 0) return false;
  return foundation.worldPlan.plan.routes.some(
    (route) =>
      routeIds.includes(route.id) &&
      route.surfaceId === surfaceId &&
      isPointInRouteCorridor(route.points, route.width, point),
  );
}

function distance2(
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number },
): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}

function surfaceRotation(
  normal: { x: number; y: number; z: number },
  yaw: number,
): [number, number, number, number] {
  const length = Math.hypot(normal.x, normal.y, normal.z) || 1;
  const nx = normal.x / length;
  const ny = normal.y / length;
  const nz = normal.z / length;
  const dot = Math.max(-1, Math.min(1, ny));
  let align: [number, number, number, number];
  if (dot > 1 - 1e-8) align = [0, 0, 0, 1];
  else if (dot < -1 + 1e-8) align = [1, 0, 0, 0];
  else {
    const scale = Math.sqrt((1 + dot) * 2);
    align = [nz / scale, 0, -nx / scale, scale / 2];
  }
  const half = yaw / 2;
  const spin: [number, number, number, number] = [
    nx * Math.sin(half),
    ny * Math.sin(half),
    nz * Math.sin(half),
    Math.cos(half),
  ];
  return multiplyQuaternion(spin, align);
}

function multiplyQuaternion(
  a: readonly [number, number, number, number],
  b: readonly [number, number, number, number],
): [number, number, number, number] {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  const result: [number, number, number, number] = [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
  const length = Math.hypot(...result) || 1;
  return result.map((value) => value / length) as [number, number, number, number];
}

function seededRandom(seed: string): () => number {
  return createMurmurHash3Random(Number.parseInt(seed.slice(0, 8), 16) >>> 0);
}
