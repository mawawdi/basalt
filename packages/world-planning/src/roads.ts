import { z } from "zod";
import { contentHash, stableJson } from "../../contracts/src/index.js";
import {
  WORLD_PLAN_SCHEMA,
  WORLD_VECTOR3_SCHEMA,
  type WorldRoute,
  type WorldVector3,
} from "./contracts.js";
import { worldEntityId, worldHash } from "./primitives.js";
import { PlacementSurfaceIndex } from "./surfaces.js";
import {
  MAXIMUM_ROUTE_PROFILE_SAMPLES,
  compileRouteSurfaceProfile,
  compileTerrainPlan,
} from "./terrain.js";

export const ROAD_ASSEMBLY_ABI = "basalt-road-assembly@1" as const;
export const DEFAULT_ROAD_CHUNK_SIZE = 128 as const;
export const MAXIMUM_ROAD_ASSEMBLY_SEGMENTS = MAXIMUM_ROUTE_PROFILE_SAMPLES;

const roadRibbonVertex = z
  .object({ position: WORLD_VECTOR3_SCHEMA, normal: WORLD_VECTOR3_SCHEMA })
  .strict();

const roadSegmentBounds = z
  .object({ minimum: WORLD_VECTOR3_SCHEMA, maximum: WORLD_VECTOR3_SCHEMA })
  .strict();

const roadSegment = z
  .object({
    id: worldEntityId,
    routeId: worldEntityId,
    dominantRegionId: worldEntityId,
    materialId: worldEntityId,
    chunkId: worldEntityId,
    startStationStuds: z.number().finite().nonnegative(),
    endStationStuds: z.number().finite().nonnegative(),
    vertices: z.array(roadRibbonVertex).min(4),
    bounds: roadSegmentBounds,
  })
  .strict();

const roadAssemblyMaterial = z
  .object({
    kind: z.literal("RoadAssembly"),
    abi: z.literal(ROAD_ASSEMBLY_ABI),
    routeId: worldEntityId,
    surfaceId: worldEntityId,
    closed: z.boolean(),
    widthStuds: z.number().finite().positive(),
    chunkSizeStuds: z.number().int().positive(),
    traversable: z.literal(true),
    maximumGradeDegrees: z.number().finite().nonnegative(),
    maximumStepHeight: z.number().finite().nonnegative(),
    profileHash: worldHash,
    crossSection: z
      .object({
        kind: z.literal("flat"),
        edgeDropStuds: z.number().finite().nonnegative(),
        innerFraction: z.number().finite().min(0).max(1),
      })
      .strict(),
    segments: z.array(roadSegment).min(1).max(MAXIMUM_ROAD_ASSEMBLY_SEGMENTS),
  })
  .strict();

export const ROAD_ASSEMBLY_SCHEMA = roadAssemblyMaterial
  .extend({ hash: worldHash })
  .strict()
  .refine(
    (value) => value.hash === contentHash(stableJson({ ...value, hash: undefined })),
    "Road assembly hash does not match its sealed material",
  );

export type RoadAssembly = z.infer<typeof ROAD_ASSEMBLY_SCHEMA>;
export type RoadSegment = RoadAssembly["segments"][number];

/**
 * Squared planimetric distance from a point to a route polyline. This is the
 * single corridor definition shared by road assembly, population exclusion,
 * and clearance relations: corridors are measured in XZ, never in 3D, so
 * slope never narrows the protected band.
 */
export function routeCorridorDistance2(
  points: readonly WorldVector3[],
  point: WorldVector3,
): number {
  let nearest = Number.POSITIVE_INFINITY;
  for (let index = 1; index < points.length; index += 1) {
    const first = points[index - 1]!;
    const second = points[index]!;
    const dx = second.x - first.x;
    const dz = second.z - first.z;
    const denominator = dx * dx + dz * dz;
    const t =
      denominator > 0
        ? Math.max(
            0,
            Math.min(1, ((point.x - first.x) * dx + (point.z - first.z) * dz) / denominator),
          )
        : 0;
    const cx = first.x + t * dx;
    const cz = first.z + t * dz;
    nearest = Math.min(nearest, (point.x - cx) * (point.x - cx) + (point.z - cz) * (point.z - cz));
  }
  return nearest;
}

export function isPointInRouteCorridor(
  points: readonly WorldVector3[],
  widthStuds: number,
  point: WorldVector3,
  clearanceStuds = 0,
): boolean {
  return routeCorridorDistance2(points, point) <= (widthStuds / 2 + clearanceStuds) ** 2;
}

/** Assemble every declared route of a world plan into sealed road geometry. */
export function assemblePlanRoads(
  planInput: unknown,
  surfaces?: PlacementSurfaceIndex,
  options?: { readonly chunkSizeStuds?: number },
): readonly RoadAssembly[] {
  const plan = WORLD_PLAN_SCHEMA.parse(planInput);
  const index =
    surfaces ??
    new PlacementSurfaceIndex(plan.terrainPlans.map(compileTerrainPlan), plan.constructedSurfaces);
  return plan.routes.map((route) => compileRoadAssembly(route, index, options));
}

/**
 * Lower one declared route into a sealed ribbon assembly. The route surface
 * profile is the centerline authority: non-traversable routes fail closed
 * before any geometry is produced, and every sample binds its dominant
 * declared region plus dominant material.
 */
export function compileRoadAssembly(
  route: WorldRoute,
  surfaces: PlacementSurfaceIndex,
  options?: { readonly chunkSizeStuds?: number },
): RoadAssembly {
  const chunkSize = options?.chunkSizeStuds ?? DEFAULT_ROAD_CHUNK_SIZE;
  if (!Number.isInteger(chunkSize) || chunkSize <= 0)
    throw new Error(`Road chunk size must be a positive integer for route ${route.id}`);
  const profile = compileRouteSurfaceProfile(route, surfaces);
  if (!profile.traversable)
    throw new Error(
      `Route ${route.id} is non-traversable (grade ${profile.maximumGradeDegrees}deg, step ${profile.maximumStepHeight})`,
    );
  const samples = profile.samples;
  if (samples.length < 2) throw new Error(`Route ${route.id} produced no ribbon samples`);

  const halfWidth = route.width / 2;
  const stations: number[] = [0];
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1]!.position;
    const current = samples[index]!.position;
    stations.push(
      stations[index - 1]! + Math.hypot(current.x - previous.x, current.z - previous.z),
    );
  }

  const frames = samples.map((sample, index) => {
    // Closed profiles repeat the first point as the last sample; tangents
    // wrap past the duplicate so the seam frame matches exactly.
    const beforeIndex = route.closed
      ? index === 0
        ? samples.length - 2
        : index - 1
      : Math.max(0, index - 1);
    const afterIndex = route.closed
      ? index === samples.length - 1
        ? 1
        : index + 1
      : Math.min(samples.length - 1, index + 1);
    const before = samples[beforeIndex]!;
    const after = samples[afterIndex]!;
    const tangent = normalize({
      x: after.position.x - before.position.x,
      y: after.position.y - before.position.y,
      z: after.position.z - before.position.z,
    });
    if (!tangent)
      throw new Error(`Route ${route.id} has a degenerate ribbon frame at sample ${index}`);
    const cross = normalize(crossProduct(sample.normal, tangent));
    if (!cross)
      throw new Error(`Route ${route.id} has a degenerate ribbon frame at sample ${index}`);
    const dominantRegionId = dominantAllowedRegion(sample.regionWeights, route.regionIds);
    if (!dominantRegionId)
      throw new Error(`Route ${route.id} leaves its declared regions at sample ${index}`);
    const materialId = dominantKey(sample.materialWeights);
    if (!materialId) throw new Error(`Route ${route.id} has no bound material at sample ${index}`);
    return {
      left: f32Vector({
        x: sample.position.x + cross.x * halfWidth,
        y: sample.position.y + cross.y * halfWidth,
        z: sample.position.z + cross.z * halfWidth,
      }),
      right: f32Vector({
        x: sample.position.x - cross.x * halfWidth,
        y: sample.position.y - cross.y * halfWidth,
        z: sample.position.z - cross.z * halfWidth,
      }),
      normal: { ...sample.normal },
      dominantRegionId,
      materialId,
      chunkId: `chunk_${Math.floor(sample.position.x / chunkSize)}_${Math.floor(sample.position.z / chunkSize)}`,
    };
  });

  const runs = splitRuns(frames);
  const segments = runs.map((run, runIndex) => {
    const start = run.start > 0 ? run.start - 1 : run.start;
    const end = run.end < frames.length - 1 ? run.end + 1 : run.end;
    const vertices = frames.slice(start, end + 1).flatMap((frame) => [
      { position: frame.left, normal: frame.normal },
      { position: frame.right, normal: frame.normal },
    ]);
    return {
      id: worldEntityId.parse(
        `road_${contentHash(stableJson({ routeId: route.id, runIndex })).slice(0, 24)}`,
      ),
      routeId: route.id,
      dominantRegionId: run.dominantRegionId,
      materialId: run.materialId,
      chunkId: run.chunkId,
      startStationStuds: f32(stations[start]!),
      endStationStuds: f32(stations[end]!),
      vertices,
      bounds: ribbonBounds(vertices.map((vertex) => vertex.position)),
    };
  });
  if (segments.length > MAXIMUM_ROAD_ASSEMBLY_SEGMENTS)
    throw new Error(`Route ${route.id} exceeds ${MAXIMUM_ROAD_ASSEMBLY_SEGMENTS} road segments`);

  return sealRoadAssembly({
    kind: "RoadAssembly" as const,
    abi: ROAD_ASSEMBLY_ABI,
    routeId: route.id,
    surfaceId: route.surfaceId,
    closed: route.closed,
    widthStuds: route.width,
    chunkSizeStuds: chunkSize,
    traversable: true as const,
    maximumGradeDegrees: profile.maximumGradeDegrees,
    maximumStepHeight: profile.maximumStepHeight,
    profileHash: profile.profileHash,
    crossSection: { kind: "flat" as const, edgeDropStuds: 0, innerFraction: 1 },
    segments,
  });
}

export function sealRoadAssembly(input: z.input<typeof roadAssemblyMaterial>): RoadAssembly {
  const material = roadAssemblyMaterial.parse(input);
  return ROAD_ASSEMBLY_SCHEMA.parse({
    ...material,
    hash: contentHash(stableJson(material)),
  });
}

export function assertRoadAssembly(value: unknown): asserts value is RoadAssembly {
  ROAD_ASSEMBLY_SCHEMA.parse(value);
}

function splitRuns(
  frames: readonly { dominantRegionId: string; materialId: string; chunkId: string }[],
): { start: number; end: number; dominantRegionId: string; materialId: string; chunkId: string }[] {
  const runs: {
    start: number;
    end: number;
    dominantRegionId: string;
    materialId: string;
    chunkId: string;
  }[] = [];
  let start = 0;
  for (let index = 1; index <= frames.length; index += 1) {
    const current = frames[index];
    const previous = frames[index - 1]!;
    if (
      index === frames.length ||
      !current ||
      current.dominantRegionId !== previous.dominantRegionId ||
      current.materialId !== previous.materialId ||
      current.chunkId !== previous.chunkId
    ) {
      runs.push({
        start,
        end: index - 1,
        dominantRegionId: previous.dominantRegionId,
        materialId: previous.materialId,
        chunkId: previous.chunkId,
      });
      start = index;
    }
  }
  return runs;
}

/** Exact-maximum dominant key with lexicographic tiebreaks: order-independent. */
function dominantKey(weights: Readonly<Record<string, number>>): string | undefined {
  let best: string | undefined;
  let bestWeight = Number.NEGATIVE_INFINITY;
  for (const key of Object.keys(weights).sort()) {
    const weight = weights[key]!;
    if (weight > bestWeight) {
      best = key;
      bestWeight = weight;
    }
  }
  return best;
}

/**
 * Dominant region restricted to the route's declared regions. Region fields
 * are smooth blends that never reach exact zero, so declared-region support
 * below 1e-6 counts as outside: the route has left its declared regions.
 */
function dominantAllowedRegion(
  weights: Readonly<Record<string, number>>,
  allowed: readonly string[],
): string | undefined {
  let best: string | undefined;
  let bestWeight = 0;
  let allowedTotal = 0;
  for (const key of Object.keys(weights).sort()) {
    if (!allowed.includes(key)) continue;
    const weight = weights[key]!;
    allowedTotal += weight;
    if (weight > bestWeight) {
      best = key;
      bestWeight = weight;
    }
  }
  if (!(allowedTotal > 1e-6)) return undefined;
  return best;
}

function ribbonBounds(positions: readonly WorldVector3[]): {
  readonly minimum: WorldVector3;
  readonly maximum: WorldVector3;
} {
  const minimum = {
    x: Number.POSITIVE_INFINITY,
    y: Number.POSITIVE_INFINITY,
    z: Number.POSITIVE_INFINITY,
  };
  const maximum = {
    x: Number.NEGATIVE_INFINITY,
    y: Number.NEGATIVE_INFINITY,
    z: Number.NEGATIVE_INFINITY,
  };
  for (const position of positions) {
    minimum.x = Math.min(minimum.x, position.x);
    minimum.y = Math.min(minimum.y, position.y);
    minimum.z = Math.min(minimum.z, position.z);
    maximum.x = Math.max(maximum.x, position.x);
    maximum.y = Math.max(maximum.y, position.y);
    maximum.z = Math.max(maximum.z, position.z);
  }
  return { minimum, maximum };
}

function crossProduct(a: WorldVector3, b: WorldVector3): WorldVector3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function normalize(value: WorldVector3): WorldVector3 | undefined {
  const length = Math.hypot(value.x, value.y, value.z);
  if (!(length > 1e-9)) return undefined;
  return { x: value.x / length, y: value.y / length, z: value.z / length };
}

function f32(value: number): number {
  const result = Math.fround(Math.abs(value) < 1e-12 ? 0 : value);
  return Object.is(result, -0) ? 0 : result;
}

function f32Vector(value: WorldVector3): WorldVector3 {
  return { x: f32(value.x), y: f32(value.y), z: f32(value.z) };
}
