import { z } from "zod";
import {
  HASH_SCHEMA,
  compareCanonicalStrings,
  contentHash,
  deepFreezeJson,
  stableJson,
} from "@basalt/contracts";
import {
  WORLD_ENTITY_ID_SCHEMA,
  evaluateTerrainElevation,
  evaluateTerrainMaterial,
  type TerrainPlan,
} from "@basalt/world-planning";
import type {
  RouteConstructionArtifact,
  RouteJunctionArtifact,
  RouteProfileStation,
} from "./route-construction.js";

const finite = z.number().finite();

interface BaseTerrainGridIndex {
  readonly xs: readonly number[];
  readonly zs: readonly number[];
  readonly elevations: ReadonlyMap<string, number>;
  readonly materials: ReadonlyMap<string, string>;
}

const baseTerrainGridCache = new WeakMap<BaseTerrainFieldArtifact, BaseTerrainGridIndex>();

export const TERRAIN_FIELD_SAMPLE_SCHEMA = z
  .object({
    xMeters: finite,
    zMeters: finite,
    elevationMeters: finite,
    materialId: WORLD_ENTITY_ID_SCHEMA,
  })
  .strict();
export type TerrainFieldSample = z.output<typeof TERRAIN_FIELD_SAMPLE_SCHEMA>;

export const BASE_TERRAIN_FIELD_ARTIFACT_SCHEMA = z
  .object({
    kind: z.literal("BaseTerrainFieldArtifact"),
    terrainPlanId: WORLD_ENTITY_ID_SCHEMA,
    terrainPlanHash: HASH_SCHEMA,
    surfaceId: WORLD_ENTITY_ID_SCHEMA,
    samples: z.array(TERRAIN_FIELD_SAMPLE_SCHEMA).min(4).max(4_000_000),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => verifyHash(value, "hash", context));
export type BaseTerrainFieldArtifact = z.output<typeof BASE_TERRAIN_FIELD_ARTIFACT_SCHEMA>;

export const TERRAIN_FIELD_ARTIFACT_SCHEMA = z
  .object({
    kind: z.literal("TerrainFieldArtifact"),
    terrainPlanId: WORLD_ENTITY_ID_SCHEMA,
    terrainPlanHash: HASH_SCHEMA,
    surfaceId: WORLD_ENTITY_ID_SCHEMA,
    baseTerrainFieldHash: HASH_SCHEMA,
    routeConstructionHashes: z.array(HASH_SCHEMA).max(65_536),
    routeJunctionHashes: z.array(HASH_SCHEMA).max(65_536),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyHash(value, "hash", context);
    if (new Set(value.routeConstructionHashes).size !== value.routeConstructionHashes.length)
      context.addIssue({
        code: "custom",
        path: ["routeConstructionHashes"],
        message: "Terrain route-construction hashes must be unique",
      });
    if (new Set(value.routeJunctionHashes).size !== value.routeJunctionHashes.length)
      context.addIssue({
        code: "custom",
        path: ["routeJunctionHashes"],
        message: "Terrain route-junction hashes must be unique",
      });
  });
export type TerrainFieldArtifact = z.output<typeof TERRAIN_FIELD_ARTIFACT_SCHEMA>;

/** Seal the immutable authored terrain before any route corridor modifies it. */
export function sealBaseTerrainFieldArtifact(plan: TerrainPlan): BaseTerrainFieldArtifact {
  const samples: TerrainFieldSample[] = [];
  for (let row = 0; row < plan.resolution.rows; row += 1)
    for (let column = 0; column < plan.resolution.columns; column += 1) {
      const xMeters =
        plan.boundsMeters.x.minimum +
        (column / (plan.resolution.columns - 1)) *
          (plan.boundsMeters.x.maximum - plan.boundsMeters.x.minimum);
      const zMeters =
        plan.boundsMeters.z.minimum +
        (row / (plan.resolution.rows - 1)) *
          (plan.boundsMeters.z.maximum - plan.boundsMeters.z.minimum);
      samples.push({
        xMeters,
        zMeters,
        elevationMeters: evaluateTerrainElevation(plan, xMeters, zMeters),
        materialId: evaluateTerrainMaterial(plan, xMeters, zMeters),
      });
    }
  const material = {
    kind: "BaseTerrainFieldArtifact" as const,
    terrainPlanId: plan.terrainPlanId,
    terrainPlanHash: contentHash(stableJson(plan)),
    surfaceId: plan.surfaceId,
    samples,
  };
  return deepFreezeJson(
    BASE_TERRAIN_FIELD_ARTIFACT_SCHEMA.parse({
      ...material,
      hash: contentHash(stableJson(material)),
    }),
  );
}

/**
 * Apply resolved corridor treatment once, in deterministic priority order.
 * Route profiles were resolved against the base field, so this stage cannot
 * feed a route-edited surface back into its own profile.
 */
export function sealTerrainFieldArtifact(
  base: BaseTerrainFieldArtifact,
  routes: readonly RouteConstructionArtifact[],
  junctions: readonly RouteJunctionArtifact[],
): TerrainFieldArtifact {
  const contributors = routes
    .filter(
      (route) =>
        route.status === "eligible" &&
        route.surfaceId === base.surfaceId &&
        route.terrainTreatment.kind === "grade",
    )
    .sort((left, right) => {
      const priority =
        (left.terrainTreatment.kind === "grade" ? left.terrainTreatment.priority : 0) -
        (right.terrainTreatment.kind === "grade" ? right.terrainTreatment.priority : 0);
      return priority || compareCanonicalStrings(left.routeId, right.routeId);
    });
  const routeConstructionHashes = contributors.map((entry) => entry.hash);
  const routeJunctionHashes = junctions
    .filter(
      (junction) =>
        junction.surfaceId === base.surfaceId && junction.terrainTreatment.kind === "grade",
    )
    .sort((left, right) => {
      const priority =
        (left.terrainTreatment.kind === "grade" ? left.terrainTreatment.priority : 0) -
        (right.terrainTreatment.kind === "grade" ? right.terrainTreatment.priority : 0);
      return priority || compareCanonicalStrings(left.junctionId, right.junctionId);
    })
    .map((entry) => entry.hash);
  const material = {
    kind: "TerrainFieldArtifact" as const,
    terrainPlanId: base.terrainPlanId,
    terrainPlanHash: base.terrainPlanHash,
    surfaceId: base.surfaceId,
    baseTerrainFieldHash: base.hash,
    routeConstructionHashes,
    routeJunctionHashes,
  };
  return deepFreezeJson(
    TERRAIN_FIELD_ARTIFACT_SCHEMA.parse({
      ...material,
      hash: contentHash(stableJson(material)),
    }),
  );
}

export function sampleBaseTerrainFieldElevation(
  field: BaseTerrainFieldArtifact,
  xMeters: number,
  zMeters: number,
): number {
  return sampleTerrainElevation(field, xMeters, zMeters);
}

/** Bilinear lookup against the exact sealed grid consumed downstream. */
export function sampleTerrainFieldElevation(
  field: TerrainFieldArtifact,
  base: BaseTerrainFieldArtifact,
  routes: readonly RouteConstructionArtifact[],
  junctions: readonly RouteJunctionArtifact[],
  xMeters: number,
  zMeters: number,
): number {
  return sampleTerrainFieldSurface(field, base, routes, junctions, xMeters, zMeters)
    .elevationMeters;
}

export function sampleTerrainFieldSurface(
  field: TerrainFieldArtifact,
  base: BaseTerrainFieldArtifact,
  routes: readonly RouteConstructionArtifact[],
  junctions: readonly RouteJunctionArtifact[],
  xMeters: number,
  zMeters: number,
): { readonly elevationMeters: number; readonly materialId: string } {
  if (base.hash !== field.baseTerrainFieldHash)
    throw new Error(`Terrain field ${field.terrainPlanId} has the wrong base terrain artifact`);
  let elevationMeters = sampleTerrainElevation(base, xMeters, zMeters);
  let materialId = nearestTerrainMaterial(base, xMeters, zMeters);
  const routeByHash = new Map(routes.map((route) => [route.hash, route] as const));
  const travelSurfaceBeds: number[] = [];
  let travelSurfaceMaterialId: string | undefined;
  for (const routeHash of field.routeConstructionHashes) {
    const route = routeByHash.get(routeHash);
    if (!route || route.status !== "eligible" || route.terrainTreatment.kind !== "grade")
      throw new Error(`Terrain field ${field.terrainPlanId} has an unavailable route treatment`);
    const tops = routeSurfaceTopsAtPoint(route, xMeters, zMeters);
    if (tops.length === 0) continue;
    travelSurfaceBeds.push(Math.min(...tops) - route.terrainTreatment.surfaceRevealMeters);
    travelSurfaceMaterialId = route.terrainTreatment.terrainMaterialId;
  }
  const coordinatedTravelBedMeters =
    travelSurfaceBeds.length === 0 ? undefined : Math.min(...travelSurfaceBeds);
  for (const routeHash of field.routeConstructionHashes) {
    const route = routeByHash.get(routeHash);
    if (!route || route.status !== "eligible" || route.terrainTreatment.kind !== "grade")
      throw new Error(`Terrain field ${field.terrainPlanId} has an unavailable route treatment`);
    const treatment = route.terrainTreatment;
    const nearest = nearestProfilePoint(route.profile, xMeters, zMeters);
    const surfaceTops = routeSurfaceTopsAtPoint(route, xMeters, zMeters);
    const fullInfluenceRadius = treatment.coreHalfWidthMeters + treatment.shoulderWidthMeters;
    const maximumRadius = fullInfluenceRadius + treatment.blendWidthMeters;
    if (surfaceTops.length === 0 && nearest.absoluteLateralMeters > maximumRadius + 1e-9) continue;
    // Adjacent spans overlap slightly while a curved centerline is lowered to
    // fixed rectangular primitives. Grade beneath the lowest actual top in
    // that overlap: terrain cannot intrude into either primitive, while the
    // route's grounding tolerance bounds the resulting gap above it.
    const travelSurfaceTopMeters = surfaceTops.length === 0 ? undefined : Math.min(...surfaceTops);
    const targetBedMeters =
      (travelSurfaceTopMeters ??
        nearest.centerTopMeters.y + nearest.signedLateralMeters * treatment.crossfallRatio) -
      treatment.surfaceRevealMeters;
    const influence =
      travelSurfaceTopMeters !== undefined ||
      nearest.absoluteLateralMeters <= fullInfluenceRadius ||
      treatment.blendWidthMeters === 0
        ? 1
        : smoothstep(
            1 - (nearest.absoluteLateralMeters - fullInfluenceRadius) / treatment.blendWidthMeters,
          );
    elevationMeters += (targetBedMeters - elevationMeters) * influence;
    if (route.materialMask && nearest.absoluteLateralMeters <= route.materialMask.halfWidthMeters)
      materialId = route.materialMask.terrainMaterialId;
  }
  if (coordinatedTravelBedMeters !== undefined) {
    elevationMeters = coordinatedTravelBedMeters;
    materialId = travelSurfaceMaterialId!;
  }
  const junctionByHash = new Map(junctions.map((junction) => [junction.hash, junction] as const));
  for (const junctionHash of field.routeJunctionHashes) {
    const junction = junctionByHash.get(junctionHash);
    if (!junction || junction.terrainTreatment.kind !== "grade")
      throw new Error(`Terrain field ${field.terrainPlanId} has an unavailable junction treatment`);
    const treatment = junction.terrainTreatment;
    const distanceMeters = Math.hypot(
      xMeters - junction.centerTopMeters.x,
      zMeters - junction.centerTopMeters.z,
    );
    if (distanceMeters > junction.radiusMeters + 1e-9) continue;
    const participantIds = new Set(junction.participants.map((entry) => entry.routeId));
    const participantSurfaceTops = routes
      .filter((route) => participantIds.has(route.routeId))
      .flatMap((route) => routeSurfaceTopsAtPoint(route, xMeters, zMeters));
    const targetTopMeters = Math.min(junction.centerTopMeters.y, ...participantSurfaceTops);
    const targetBedMeters = Math.min(
      targetTopMeters - treatment.surfaceRevealMeters,
      coordinatedTravelBedMeters ?? Number.POSITIVE_INFINITY,
    );
    elevationMeters = targetBedMeters;
    materialId = treatment.terrainMaterialId;
  }
  return { elevationMeters, materialId };
}

/** Exact top planes of every travel primitive covering one horizontal point. */
export function routeSurfaceTopsAtPoint(
  route: RouteConstructionArtifact,
  xMeters: number,
  zMeters: number,
): readonly number[] {
  const result: number[] = [];
  for (const segment of route.travelSegments) {
    if (
      xMeters < segment.boundsMeters.min.x - 1e-9 ||
      xMeters > segment.boundsMeters.max.x + 1e-9 ||
      zMeters < segment.boundsMeters.min.z - 1e-9 ||
      zMeters > segment.boundsMeters.max.z + 1e-9
    )
      continue;
    const vertices = segment.vertices.map((entry) => entry.positionMeters);
    for (const [first, second, third] of [
      [vertices[0]!, vertices[1]!, vertices[2]!],
      [vertices[2]!, vertices[1]!, vertices[3]!],
    ] as const) {
      const elevation = triangleElevationAtXZ(first, second, third, xMeters, zMeters);
      if (elevation !== undefined) result.push(elevation);
    }
  }
  return result;
}

export function terrainFieldMinimumSpacing(field: BaseTerrainFieldArtifact): number {
  const { xs, zs } = terrainCoordinates(field);
  const spacings = [xs, zs].flatMap((coordinates) =>
    coordinates.slice(1).map((value, index) => value - coordinates[index]!),
  );
  const result = Math.min(...spacings);
  if (!Number.isFinite(result) || result <= 0)
    throw new Error(`Terrain field ${field.terrainPlanId} has invalid sample spacing`);
  return result;
}

/**
 * Verify the sealed surface/terrain composition over the complete realized
 * footprint. This is a compilation gate, not a test helper: clearance and
 * grounding claims are unavailable when the bounded probe budget is exceeded.
 */
export function verifyTerrainConstruction(
  fields: readonly TerrainFieldArtifact[],
  bases: readonly BaseTerrainFieldArtifact[],
  routes: readonly RouteConstructionArtifact[],
  junctions: readonly RouteJunctionArtifact[],
): readonly string[] {
  const diagnostics: string[] = [];
  const requiredProbes =
    routes.reduce(
      (count, route) =>
        count +
        (route.status === "eligible" && route.terrainTreatment.kind === "grade"
          ? route.travelSegments.length * 25
          : 0),
      0,
    ) +
    junctions.filter((entry) => entry.terrainTreatment.kind === "grade").length * 17;
  if (requiredProbes > 2_000_000)
    return [`terrain_construction:probe_budget:${requiredProbes.toString()} exceeds 2000000`];
  for (const route of routes) {
    if (route.status !== "eligible" || route.terrainTreatment.kind !== "grade") continue;
    const field = fields.find((entry) => entry.surfaceId === route.surfaceId);
    const base = field
      ? bases.find((entry) => entry.hash === field.baseTerrainFieldHash)
      : undefined;
    if (!field || !base) {
      diagnostics.push(`route:${route.routeId}:terrain_composition is unavailable`);
      continue;
    }
    const minimum = route.terrainTreatment.surfaceRevealMeters;
    const maximumBodyGap = route.terrainTreatment.groundingToleranceMeters;
    routeProbe: for (const segment of route.travelSegments)
      for (let longitudinal = 0; longitudinal <= 4; longitudinal += 1)
        for (let lateral = 0; lateral <= 4; lateral += 1) {
          const start = interpolateRouteVertex(
            segment.vertices[0]!.positionMeters,
            segment.vertices[1]!.positionMeters,
            lateral / 4,
          );
          const end = interpolateRouteVertex(
            segment.vertices[2]!.positionMeters,
            segment.vertices[3]!.positionMeters,
            lateral / 4,
          );
          const surface = interpolateRouteVertex(start, end, longitudinal / 4);
          const terrain = sampleTerrainFieldSurface(
            field,
            base,
            routes,
            junctions,
            surface.x,
            surface.z,
          );
          const clearance = surface.y - terrain.elevationMeters;
          const bodyGap = Math.max(0, clearance - route.thicknessMeters);
          if (clearance < minimum - 1e-8 || bodyGap > maximumBodyGap + 1e-8) {
            diagnostics.push(
              `route:${route.routeId}:terrain_contact:top ${clearance.toFixed(6)}m, body gap ${bodyGap.toFixed(6)}m outside reveal >= ${minimum.toFixed(6)}m and body gap <= ${maximumBodyGap.toFixed(6)}m at ${surface.x.toFixed(6)},${surface.z.toFixed(6)}`,
            );
            break routeProbe;
          }
        }
  }
  for (const junction of junctions) {
    if (junction.terrainTreatment.kind !== "grade") continue;
    const field = fields.find((entry) => entry.surfaceId === junction.surfaceId);
    const base = field
      ? bases.find((entry) => entry.hash === field.baseTerrainFieldHash)
      : undefined;
    if (!field || !base) {
      diagnostics.push(`junction:${junction.junctionId}:terrain_composition is unavailable`);
      continue;
    }
    const minimum = junction.terrainTreatment.surfaceRevealMeters;
    const maximumBodyGap = junction.terrainTreatment.groundingToleranceMeters;
    for (let index = 0; index <= 16; index += 1) {
      const radius = index === 16 ? 0 : junction.radiusMeters;
      const angle = (Math.PI * 2 * index) / 16;
      const x = junction.centerTopMeters.x + Math.cos(angle) * radius;
      const z = junction.centerTopMeters.z + Math.sin(angle) * radius;
      const terrain = sampleTerrainFieldSurface(field, base, routes, junctions, x, z);
      const clearance = junction.centerTopMeters.y - terrain.elevationMeters;
      const bodyGap = Math.max(0, clearance - junction.thicknessMeters);
      if (clearance < minimum - 1e-8 || bodyGap > maximumBodyGap + 1e-8) {
        diagnostics.push(
          `junction:${junction.junctionId}:terrain_contact:top ${clearance.toFixed(6)}m, body gap ${bodyGap.toFixed(6)}m outside reveal >= ${minimum.toFixed(6)}m and body gap <= ${maximumBodyGap.toFixed(6)}m at ${x.toFixed(6)},${z.toFixed(6)}`,
        );
        break;
      }
    }
  }
  return [...new Set(diagnostics)].sort(compareCanonicalStrings);
}

function sampleTerrainElevation(
  field: BaseTerrainFieldArtifact,
  xMeters: number,
  zMeters: number,
): number {
  if (!Number.isFinite(xMeters) || !Number.isFinite(zMeters))
    throw new Error("Terrain sample coordinates must be finite");
  const { xs, zs, elevations } = terrainGridIndex(field);
  const [x0, x1] = enclosingCoordinates(xs, xMeters);
  const [z0, z1] = enclosingCoordinates(zs, zMeters);
  const q00 = requiredElevation(elevations, x0, z0, field.terrainPlanId);
  const q10 = requiredElevation(elevations, x1, z0, field.terrainPlanId);
  const q01 = requiredElevation(elevations, x0, z1, field.terrainPlanId);
  const q11 = requiredElevation(elevations, x1, z1, field.terrainPlanId);
  const tx = x1 === x0 ? 0 : (Math.max(x0, Math.min(x1, xMeters)) - x0) / (x1 - x0);
  const tz = z1 === z0 ? 0 : (Math.max(z0, Math.min(z1, zMeters)) - z0) / (z1 - z0);
  return lerp(lerp(q00, q10, tx), lerp(q01, q11, tx), tz);
}

function terrainCoordinates(field: BaseTerrainFieldArtifact) {
  const { xs, zs } = terrainGridIndex(field);
  return { xs, zs };
}

function terrainGridIndex(field: BaseTerrainFieldArtifact): BaseTerrainGridIndex {
  const cached = baseTerrainGridCache.get(field);
  if (cached) return cached;
  const xs = [...new Set(field.samples.map((sample) => sample.xMeters))].sort(
    (left, right) => left - right,
  );
  const zs = [...new Set(field.samples.map((sample) => sample.zMeters))].sort(
    (left, right) => left - right,
  );
  if (xs.length * zs.length !== field.samples.length)
    throw new Error(`Terrain field ${field.terrainPlanId} is not a complete rectangular grid`);
  const elevations = new Map<string, number>();
  const materials = new Map<string, string>();
  for (const sample of field.samples) {
    const key = `${sample.xMeters}:${sample.zMeters}`;
    if (elevations.has(key))
      throw new Error(`Terrain field ${field.terrainPlanId} repeats a grid sample`);
    elevations.set(key, sample.elevationMeters);
    materials.set(key, sample.materialId);
  }
  const result = { xs, zs, elevations, materials };
  baseTerrainGridCache.set(field, result);
  return result;
}

function nearestTerrainMaterial(
  field: BaseTerrainFieldArtifact,
  xMeters: number,
  zMeters: number,
): string {
  const { xs, zs, materials } = terrainGridIndex(field);
  const x = nearestCoordinate(xs, xMeters);
  const z = nearestCoordinate(zs, zMeters);
  const result = materials.get(`${x}:${z}`);
  if (!result) throw new Error(`Terrain field ${field.terrainPlanId} has no material sample`);
  return result;
}

function nearestCoordinate(values: readonly number[], target: number): number {
  let best = values[0]!;
  let distance = Math.abs(best - target);
  for (let index = 1; index < values.length; index += 1) {
    const candidate = Math.abs(values[index]! - target);
    if (candidate < distance) {
      best = values[index]!;
      distance = candidate;
    }
  }
  return best;
}

function nearestProfilePoint(
  profile: readonly RouteProfileStation[],
  xMeters: number,
  zMeters: number,
) {
  let best:
    | {
        readonly distanceSquared: number;
        readonly absoluteLateralMeters: number;
        readonly signedLateralMeters: number;
        readonly centerTopMeters: { readonly x: number; readonly y: number; readonly z: number };
      }
    | undefined;
  for (let index = 1; index < profile.length; index += 1) {
    const start = profile[index - 1]!.centerTopMeters;
    const end = profile[index]!.centerTopMeters;
    const dx = end.x - start.x;
    const dz = end.z - start.z;
    const lengthSquared = dx * dx + dz * dz;
    const amount =
      lengthSquared <= 1e-18
        ? 0
        : Math.max(
            0,
            Math.min(1, ((xMeters - start.x) * dx + (zMeters - start.z) * dz) / lengthSquared),
          );
    const centerTopMeters = {
      x: start.x + dx * amount,
      y: start.y + (end.y - start.y) * amount,
      z: start.z + dz * amount,
    };
    const offsetX = xMeters - centerTopMeters.x;
    const offsetZ = zMeters - centerTopMeters.z;
    const length = Math.sqrt(lengthSquared);
    const signedLateralMeters =
      length <= 1e-9
        ? Math.hypot(offsetX, offsetZ)
        : offsetX * (-dz / length) + offsetZ * (dx / length);
    const distanceSquared = offsetX * offsetX + offsetZ * offsetZ;
    if (!best || distanceSquared < best.distanceSquared)
      best = {
        distanceSquared,
        absoluteLateralMeters: Math.sqrt(distanceSquared),
        signedLateralMeters,
        centerTopMeters,
      };
  }
  if (!best) throw new Error("Route profile requires at least two stations");
  return best;
}

function triangleElevationAtXZ(
  first: { readonly x: number; readonly y: number; readonly z: number },
  second: { readonly x: number; readonly y: number; readonly z: number },
  third: { readonly x: number; readonly y: number; readonly z: number },
  xMeters: number,
  zMeters: number,
): number | undefined {
  const denominator =
    (second.z - third.z) * (first.x - third.x) + (third.x - second.x) * (first.z - third.z);
  if (Math.abs(denominator) <= 1e-12) return undefined;
  const firstWeight =
    ((second.z - third.z) * (xMeters - third.x) + (third.x - second.x) * (zMeters - third.z)) /
    denominator;
  const secondWeight =
    ((third.z - first.z) * (xMeters - third.x) + (first.x - third.x) * (zMeters - third.z)) /
    denominator;
  const thirdWeight = 1 - firstWeight - secondWeight;
  if (firstWeight < -1e-9 || secondWeight < -1e-9 || thirdWeight < -1e-9) return undefined;
  return first.y * firstWeight + second.y * secondWeight + third.y * thirdWeight;
}

function interpolateRouteVertex(
  start: { readonly x: number; readonly y: number; readonly z: number },
  end: { readonly x: number; readonly y: number; readonly z: number },
  amount: number,
) {
  return {
    x: start.x + (end.x - start.x) * amount,
    y: start.y + (end.y - start.y) * amount,
    z: start.z + (end.z - start.z) * amount,
  };
}

function smoothstep(value: number): number {
  const bounded = Math.max(0, Math.min(1, value));
  return bounded * bounded * (3 - 2 * bounded);
}

function enclosingCoordinates(
  values: readonly number[],
  target: number,
): readonly [number, number] {
  if (target <= values[0]!) return [values[0]!, values[0]!];
  if (target >= values.at(-1)!) return [values.at(-1)!, values.at(-1)!];
  for (let index = 1; index < values.length; index += 1)
    if (target <= values[index]!) return [values[index - 1]!, values[index]!];
  throw new Error("Terrain coordinate lookup failed");
}

function requiredElevation(
  values: ReadonlyMap<string, number>,
  xMeters: number,
  zMeters: number,
  terrainPlanId: string,
): number {
  const value = values.get(`${xMeters}:${zMeters}`);
  if (value === undefined)
    throw new Error(`Terrain field ${terrainPlanId} is missing a grid sample`);
  return value;
}

function lerp(start: number, end: number, amount: number): number {
  return start + (end - start) * amount;
}

function verifyHash(value: Record<string, unknown>, key: string, context: z.RefinementCtx): void {
  const material = { ...value };
  delete material[key];
  if (contentHash(stableJson(material)) !== value[key])
    context.addIssue({ code: "custom", path: [key], message: `${key} mismatch` });
}
