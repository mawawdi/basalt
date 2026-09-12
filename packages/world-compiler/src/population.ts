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
import {
  calibrateGroundingSurface,
  groundPlacement,
  groundingKindFromSpan,
  groundingPolicyFor,
  indexGroundingEvidence,
  type GroundingArchetypeEvidence,
  type GroundingEvidenceFile,
  type GroundingKind,
  type SurfaceCalibration,
} from "./grounding.js";
import { validateInterlockClearance } from "./relations.js";
import { clearanceRadius, createCrossFamilySpacing, maximumClearanceRadius } from "./spacing.js";

export interface BasaltPopulationOptions {
  readonly chunkSize?: number;
  readonly maxAttemptsPerFamilySurface?: number;
  /** Measured per-family grounding evidence; population never places blind. */
  readonly groundingEvidence: GroundingEvidenceFile;
}

/**
 * True when the candidate's support stays over the surface. Flats and
 * compacts rest their full bottom, so every yaw-rotated bounds corner (about
 * the bounds center, which grounding carries onto the sample verbatim) must
 * map inside the surface domain; talls stand on their contact disk, so the disk
 * must sit inside while canopies may overhang the edge. Corners test the
 * yaw-only rotation; tilted flats on slopes can shift sideways by a fraction
 * of their height, which stays sub-visual against the slope that caused it.
 */
function footprintInsideSurface(
  foundation: BasaltWorldFoundation,
  surfaceId: string,
  bounds: { u: { minimum: number; maximum: number }; v: { minimum: number; maximum: number } },
  position: { x: number; y: number; z: number },
  yaw: number,
  scale: number,
  kind: GroundingKind,
  evidence: GroundingArchetypeEvidence,
): boolean {
  const inside = (x: number, z: number): boolean => {
    const coordinate = foundation.worldPlan.surfaces.coordinatesFromWorld(surfaceId, {
      x,
      y: position.y,
      z,
    });
    return (
      coordinate.u >= bounds.u.minimum &&
      coordinate.u <= bounds.u.maximum &&
      coordinate.v >= bounds.v.minimum &&
      coordinate.v <= bounds.v.maximum
    );
  };
  if (kind === "tall") {
    const radius = evidence.contactRadiusStuds * scale;
    return (
      inside(position.x - radius, position.z) &&
      inside(position.x + radius, position.z) &&
      inside(position.x, position.z - radius) &&
      inside(position.x, position.z + radius)
    );
  }
  const min = evidence.boundsMinimumStuds;
  const max = evidence.boundsMaximumStuds;
  const centerX = (min.x + max.x) / 2;
  const centerZ = (min.z + max.z) / 2;
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  for (const cornerX of [min.x, max.x])
    for (const cornerZ of [min.z, max.z]) {
      const localX = (cornerX - centerX) * scale;
      const localZ = (cornerZ - centerZ) * scale;
      if (!inside(position.x + localX * cos + localZ * sin, position.z - localX * sin + localZ * cos))
        return false;
    }
  return true;
}

/**
 * Resolve family intent into chunked transforms without asking a model for an
 * individual object. The only inputs are the immutable world surfaces and the
 * family-level plan; declaration order cannot affect the result.
 */
export function populateBasaltWorld(
  foundation: BasaltWorldFoundation,
  plan: WorldCompilerPlan,
  options: BasaltPopulationOptions,
): WorldPopulationArtifact {
  const chunkSize = options.chunkSize ?? 128;
  if (!Number.isFinite(chunkSize) || chunkSize <= 0) throw new Error("Chunk size must be positive");
  const attemptsPerSurface = options.maxAttemptsPerFamilySurface ?? 20;
  if (!Number.isInteger(attemptsPerSurface) || attemptsPerSurface < 1)
    throw new Error("Population attempt budget must be a positive integer");
  const evidenceIndex = indexGroundingEvidence(options.groundingEvidence);
  const calibrations = new Map<string, SurfaceCalibration>();
  const spacing = createCrossFamilySpacing(
    maximumClearanceRadius([...plan.familyPlans], evidenceIndex),
  );
  const claimed = new Map<string, Array<{ position: { x: number; z: number }; radius: number }>>();

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
      let calibration = calibrations.get(surfaceId);
      if (!calibration) {
        calibration = calibrateGroundingSurface(foundation.worldPlan.surfaces, surfaceId);
        calibrations.set(surfaceId, calibration);
      }
      const rng = seededRandom(
        contentHash(stableJson([family.variationSeed, family.familyId, surfaceId])),
      );
      const clustered = family.distribution === "cluster";
      const clusterCount = clustered ? Math.max(1, Math.ceil(Math.sqrt(count))) : 0;
      const clusterRadius =
        Math.sqrt(Math.max(area, 1) / Math.max(count, 1)) / Math.max(clusterCount, 1);
      const clusterCenters = Array.from({ length: clusterCount }, () => ({
        u: bounds.u.minimum + rng() * (bounds.u.maximum - bounds.u.minimum),
        v: bounds.v.minimum + rng() * (bounds.v.maximum - bounds.v.minimum),
      }));
      const accepted: Array<{
        sample: PlacementSurfaceSample;
        yaw: number;
        variant: number;
        scale: number;
        radius: number;
      }> = [];
      let attempts = 0;
      while (accepted.length < count && attempts < Math.max(count * attemptsPerSurface, 32)) {
        attempts += 1;
        const coordinate = clustered
          ? clusterCoordinate(clusterCenters, clusterRadius, calibration, bounds, rng)
          : {
              u: bounds.u.minimum + rng() * (bounds.u.maximum - bounds.u.minimum),
              v: bounds.v.minimum + rng() * (bounds.v.maximum - bounds.v.minimum),
            };
        const sample = foundation.worldPlan.surfaces.sample(surfaceId, coordinate);
        if (!family.regionIds.some((regionId) => (sample.regionWeights[regionId] ?? 0) >= 0.25))
          continue;
        if (isRouteExcluded(foundation, family.excludedRouteIds, surfaceId, sample.position))
          continue;
        const ordinal = accepted.length;
        const variantSeed = contentHash(
          stableJson([family.variationSeed, family.familyId, surfaceId, ordinal, "variant"]),
        );
        const variant = parseInt(variantSeed.slice(0, 8), 16) % archetypeCount;
        const scaleSeed = parseInt(variantSeed.slice(8, 16), 16) / 0xffff_ffff;
        const scale = scaleRange[0] + (scaleRange[1] - scaleRange[0]) * scaleSeed;
        const yawSeed = contentHash(
          stableJson([family.variationSeed, family.familyId, surfaceId, ordinal, "yaw"]),
        );
        const yaw = (parseInt(yawSeed.slice(0, 8), 16) / 0xffff_ffff) * Math.PI * 2;
        const archetypes = evidenceIndex.get(family.familyId);
        const variantEvidence = archetypes?.[variant];
        if (!variantEvidence)
          throw new Error(
            `Population has no grounding evidence for ${family.familyId} archetype ${variant}`,
          );
        const span = {
          x: variantEvidence.boundsMaximumStuds.x - variantEvidence.boundsMinimumStuds.x,
          y: variantEvidence.boundsMaximumStuds.y - variantEvidence.boundsMinimumStuds.y,
          z: variantEvidence.boundsMaximumStuds.z - variantEvidence.boundsMinimumStuds.z,
        };
        const kind = groundingKindFromSpan(span);
        if (sample.slopeDegrees > groundingPolicyFor(kind).maximumSlopeDegrees) continue;
        if (
          !footprintInsideSurface(
            foundation,
            surfaceId,
            bounds,
            sample.position,
            yaw,
            scale,
            kind,
            variantEvidence,
          )
        )
          continue;
        const radius = clearanceRadius(variantEvidence.contactRadiusStuds, scale);
        if (!spacing.tryClaim(surfaceId, sample.position.x, sample.position.z, radius)) continue;
        const surfaceClaims = claimed.get(surfaceId);
        const claim = { position: { x: sample.position.x, z: sample.position.z }, radius };
        if (surfaceClaims) surfaceClaims.push(claim);
        else claimed.set(surfaceId, [claim]);
        accepted.push({ sample, yaw, variant, scale, radius });
      }
      for (const [ordinal, entry] of accepted.entries()) {
        const id = `instance_${contentHash(stableJson([plan.hash, family.familyId, surfaceId, ordinal])).slice(0, 24)}`;
        const evidence = evidenceIndex.get(family.familyId)?.[entry.variant];
        if (!evidence)
          throw new Error(
            `Population has no grounding evidence for ${family.familyId} archetype ${entry.variant}`,
          );
        const grounded = groundPlacement({
          surfaceId,
          coordinate: entry.sample.coordinate,
          yaw: entry.yaw,
          scale: entry.scale,
          seed: id,
          evidence,
          sampler: foundation.worldPlan.surfaces,
          calibration,
        });
        const position = grounded.position;
        const chunkId = `chunk_${Math.floor(position.x / chunkSize)}_${Math.floor(position.z / chunkSize)}`;
        instances.push({
          id,
          familyId: family.familyId,
          archetypeId: `${family.familyId}_archetype_${entry.variant}`,
          chunkId,
          position,
          rotation: grounded.rotation,
          scale: entry.scale,
          footprint: {
            contactRadiusStuds: grounded.footprint.contactRadiusStuds,
            restYStuds: grounded.footprint.restYStuds,
            dropsStuds: [...grounded.footprint.dropsStuds] as [number, number, number, number],
          },
        });
      }
    }
  }

  for (const placements of claimed.values())
    validateInterlockClearance(
      placements.map((claim) => ({
        position: { x: claim.position.x, y: 0, z: claim.position.z },
        radius: claim.radius,
      })),
      0,
    );

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

function clusterCoordinate(
  centers: readonly { u: number; v: number }[],
  clusterRadius: number,
  calibration: SurfaceCalibration,
  bounds: {
    u: { minimum: number; maximum: number };
    v: { minimum: number; maximum: number };
  },
  rng: () => number,
): { u: number; v: number } {
  const center = centers[Math.floor(rng() * centers.length)]!;
  // Center-weighted scatter: the mean of three uniforms approximates a gaussian.
  const scatter = () => ((rng() + rng() + rng()) / 3) * 2 - 1;
  return {
    u: Math.min(
      bounds.u.maximum,
      Math.max(bounds.u.minimum, center.u + (scatter() * clusterRadius) / calibration.worldPerU),
    ),
    v: Math.min(
      bounds.v.maximum,
      Math.max(bounds.v.minimum, center.v + (scatter() * clusterRadius) / calibration.worldPerV),
    ),
  };
}

function seededRandom(seed: string): () => number {
  return createMurmurHash3Random(Number.parseInt(seed.slice(0, 8), 16) >>> 0);
}
