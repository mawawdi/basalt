import { z } from "zod";
import {
  HASH_SCHEMA,
  compareCanonicalStrings,
  contentHash,
  deepFreezeJson,
  stableJson,
} from "@basalt/contracts";
import {
  WORLD_AABB_SCHEMA,
  WORLD_ENTITY_ID_SCHEMA,
  WORLD_VECTOR3_SCHEMA,
  type SpatialWorldPlan,
  type WorldRoute,
  type WorldVector3,
} from "./contracts.js";

const vertex = z
  .object({ positionMeters: WORLD_VECTOR3_SCHEMA, normal: WORLD_VECTOR3_SCHEMA })
  .strict();
const segment = z
  .object({
    segmentId: WORLD_ENTITY_ID_SCHEMA,
    startStationMeters: z.number().finite().nonnegative(),
    endStationMeters: z.number().finite().nonnegative(),
    vertices: z.array(vertex).length(4),
    boundsMeters: WORLD_AABB_SCHEMA,
  })
  .strict();
export const ROAD_ASSEMBLY_SCHEMA = z
  .object({
    kind: z.literal("RoadAssembly"),
    routeId: WORLD_ENTITY_ID_SCHEMA,
    routeHash: HASH_SCHEMA,
    widthMeters: z.number().finite().positive(),
    chunkSizeMeters: z.number().finite().positive(),
    segments: z.array(segment).min(1).max(65_536),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => verify(value, context));
export type RoadAssembly = z.output<typeof ROAD_ASSEMBLY_SCHEMA>;
export type RoadSegment = RoadAssembly["segments"][number];

export function compileRoadAssembly(route: WorldRoute, chunkSizeMeters = 4.48): RoadAssembly {
  const pieces: RoadSegment[] = [];
  let station = 0;
  for (let index = 1; index < route.pointsMeters.length; index += 1) {
    const from = route.pointsMeters[index - 1]!;
    const to = route.pointsMeters[index]!;
    const length = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
    const subdivisions = Math.max(1, Math.ceil(length / chunkSizeMeters));
    for (let slice = 0; slice < subdivisions; slice += 1) {
      const a = lerp(from, to, slice / subdivisions);
      const b = lerp(from, to, (slice + 1) / subdivisions);
      const direction = normalize({ x: b.x - a.x, y: b.y - a.y, z: b.z - a.z });
      const lateral = normalize({ x: -direction.z, y: 0, z: direction.x });
      const half = route.widthMeters / 2;
      const points = [
        offset(a, lateral, -half),
        offset(a, lateral, half),
        offset(b, lateral, -half),
        offset(b, lateral, half),
      ];
      const end = station + length / subdivisions;
      pieces.push({
        segmentId: `Road_${index}_${slice}`,
        startStationMeters: station,
        endStationMeters: end,
        vertices: points.map((positionMeters) => ({
          positionMeters,
          normal: { x: 0, y: 1, z: 0 },
        })),
        boundsMeters: bounds(points, route.heightClearanceMeters),
      });
      station = end;
    }
  }
  const material = {
    kind: "RoadAssembly" as const,
    routeId: route.routeId,
    routeHash: contentHash(stableJson(route)),
    widthMeters: route.widthMeters,
    chunkSizeMeters,
    segments: pieces,
  };
  return deepFreezeJson(
    ROAD_ASSEMBLY_SCHEMA.parse({ ...material, hash: contentHash(stableJson(material)) }),
  );
}

export function assemblePlanRoads(
  plan: SpatialWorldPlan,
  chunkSizeMeters?: number,
): readonly RoadAssembly[] {
  return [...plan.routes]
    .sort((a, b) => compareCanonicalStrings(a.routeId, b.routeId))
    .map((route) => compileRoadAssembly(route, chunkSizeMeters));
}

export function routeCorridorDistanceSquared(
  points: readonly WorldVector3[],
  point: WorldVector3,
): number {
  let minimum = Number.POSITIVE_INFINITY;
  for (let index = 1; index < points.length; index += 1) {
    const a = points[index - 1]!;
    const b = points[index]!;
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const denominator = dx * dx + dz * dz;
    const t =
      denominator === 0
        ? 0
        : Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.z - a.z) * dz) / denominator));
    minimum = Math.min(minimum, (point.x - (a.x + t * dx)) ** 2 + (point.z - (a.z + t * dz)) ** 2);
  }
  return minimum;
}

export function isPointInRouteCorridor(
  points: readonly WorldVector3[],
  point: WorldVector3,
  widthMeters: number,
  clearanceMeters = 0,
): boolean {
  return routeCorridorDistanceSquared(points, point) <= (widthMeters / 2 + clearanceMeters) ** 2;
}

/**
 * Conservative broad-phase test for a complete footprint against a route
 * corridor. Expanding the footprint by the route radius prevents a lot from
 * being admitted merely because its center happens to miss the road.
 */
export function routeCorridorIntersectsAabbXZ(
  points: readonly WorldVector3[],
  bounds: { readonly min: WorldVector3; readonly max: WorldVector3 },
  widthMeters: number,
  clearanceMeters = 0,
): boolean {
  const expansion = widthMeters / 2 + clearanceMeters;
  const expanded = {
    minX: bounds.min.x - expansion,
    maxX: bounds.max.x + expansion,
    minZ: bounds.min.z - expansion,
    maxZ: bounds.max.z + expansion,
  };
  for (let index = 1; index < points.length; index += 1)
    if (segmentIntersectsRectangle(points[index - 1]!, points[index]!, expanded)) return true;
  return false;
}

function lerp(a: WorldVector3, b: WorldVector3, t: number): WorldVector3 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
}
function offset(a: WorldVector3, direction: WorldVector3, amount: number): WorldVector3 {
  return {
    x: a.x + direction.x * amount,
    y: a.y + direction.y * amount,
    z: a.z + direction.z * amount,
  };
}
function normalize(value: WorldVector3): WorldVector3 {
  const length = Math.hypot(value.x, value.y, value.z);
  if (length <= 1e-9) throw new Error("Road direction cannot be zero");
  return { x: value.x / length, y: value.y / length, z: value.z / length };
}

function segmentIntersectsRectangle(
  start: WorldVector3,
  end: WorldVector3,
  rectangle: { minX: number; maxX: number; minZ: number; maxZ: number },
): boolean {
  let minimum = 0;
  let maximum = 1;
  const dx = end.x - start.x;
  const dz = end.z - start.z;
  for (const [origin, delta, low, high] of [
    [start.x, dx, rectangle.minX, rectangle.maxX],
    [start.z, dz, rectangle.minZ, rectangle.maxZ],
  ] as const) {
    if (Math.abs(delta) <= 1e-12) {
      if (origin < low || origin > high) return false;
      continue;
    }
    const first = (low - origin) / delta;
    const second = (high - origin) / delta;
    const entry = Math.min(first, second);
    const exit = Math.max(first, second);
    minimum = Math.max(minimum, entry);
    maximum = Math.min(maximum, exit);
    if (minimum > maximum) return false;
  }
  return true;
}
function bounds(points: readonly WorldVector3[], height: number) {
  return {
    min: {
      x: Math.min(...points.map((p) => p.x)),
      y: Math.min(...points.map((p) => p.y)),
      z: Math.min(...points.map((p) => p.z)),
    },
    max: {
      x: Math.max(...points.map((p) => p.x)),
      y: Math.max(...points.map((p) => p.y)) + height,
      z: Math.max(...points.map((p) => p.z)),
    },
  };
}
function verify(value: RoadAssembly, context: z.RefinementCtx): void {
  const material = { ...value };
  delete (material as Partial<RoadAssembly>).hash;
  if (contentHash(stableJson(material)) !== value.hash)
    context.addIssue({ code: "custom", path: ["hash"], message: "Road assembly hash mismatch" });
}
