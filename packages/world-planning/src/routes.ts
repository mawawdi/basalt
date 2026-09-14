import type { WorldPoint2, WorldRoute, WorldVector3 } from "./contracts.js";
import {
  resolveHorizontalAlignment,
  sampleHorizontalPrimitive,
  type ResolvedHorizontalBend,
} from "./route-horizontal.js";

const EPSILON = 1e-9;
// A route bend is eventually realized by bounded engine primitives. Constraining
// angular error as well as chord length keeps the realized outer edge smooth
// even when terrain samples are sparse or an author permits long segments.
const MAXIMUM_BEND_SPAN_RADIANS = Math.PI / 36;

export interface RouteAlignmentSpan {
  readonly kind: "line" | "bend";
  readonly sourceSpanIndex: number;
  readonly sourceVertexIndex?: number;
  readonly startStationMeters: number;
  readonly endStationMeters: number;
  readonly start: WorldPoint2;
  readonly end: WorldPoint2;
  readonly tangent: WorldPoint2;
  readonly lateral: WorldPoint2;
}

export interface ResolvedRouteAlignment {
  readonly spans: readonly RouteAlignmentSpan[];
  readonly bends: readonly ResolvedHorizontalBend[];
  readonly totalLengthMeters: number;
}

/**
 * Resolve the authored control polyline into bounded line and circular-arc
 * spans. Horizontal design is completed before the vertical profile is
 * sampled, so surface geometry, terrain treatment, and route masks consume
 * one centerline.
 */
export function resolveRouteAlignment(
  route: WorldRoute,
  maximumSpanMeters: number,
): ResolvedRouteAlignment {
  if (!Number.isFinite(maximumSpanMeters) || maximumSpanMeters <= 0)
    throw new Error("Route alignment span must be positive and finite");
  const resolved = resolveHorizontalAlignment({
    routeId: route.routeId,
    points: route.alignmentMeters,
    bendRadiusMeters: route.bendRadiusMeters,
    closed: route.closed,
  });
  const spans: RouteAlignmentSpan[] = [];
  let stationMeters = 0;
  for (const primitive of resolved.primitives) {
    const subdivisions = Math.max(
      1,
      Math.ceil(primitive.lengthMeters / maximumSpanMeters),
      primitive.kind === "arc"
        ? Math.ceil(Math.abs(primitive.sweepRadians) / MAXIMUM_BEND_SPAN_RADIANS)
        : 1,
    );
    for (let subdivision = 0; subdivision < subdivisions; subdivision += 1) {
      const startAmount = subdivision / subdivisions;
      const endAmount = (subdivision + 1) / subdivisions;
      const start = sampleHorizontalPrimitive(primitive, startAmount);
      const end = sampleHorizontalPrimitive(primitive, endAmount);
      const spanLengthMeters = primitive.lengthMeters / subdivisions;
      const chord = normalized(
        end.position.x - start.position.x,
        end.position.z - start.position.z,
      );
      spans.push({
        kind: primitive.kind === "arc" ? "bend" : "line",
        sourceSpanIndex: primitive.sourceSpanIndex,
        ...(primitive.kind === "arc" ? { sourceVertexIndex: primitive.sourceVertexIndex } : {}),
        startStationMeters: stationMeters,
        endStationMeters: stationMeters + spanLengthMeters,
        start: start.position,
        end: end.position,
        tangent: chord,
        lateral: { x: -chord.z, z: chord.x },
      });
      stationMeters += spanLengthMeters;
    }
  }
  return { spans, bends: resolved.bends, totalLengthMeters: resolved.totalLengthMeters };
}

export function routeAlignmentSpans(
  route: WorldRoute,
  maximumSpanMeters: number,
): readonly RouteAlignmentSpan[] {
  return resolveRouteAlignment(route, maximumSpanMeters).spans;
}

export function routeAlignmentLength(route: WorldRoute): number {
  return resolveHorizontalAlignment({
    routeId: route.routeId,
    points: route.alignmentMeters,
    bendRadiusMeters: route.bendRadiusMeters,
    closed: route.closed,
  }).totalLengthMeters;
}

export function sampleRouteAlignment(
  route: WorldRoute,
  fraction: number,
): {
  readonly position: WorldPoint2;
  readonly tangent: WorldPoint2;
  readonly stationMeters: number;
} {
  if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1)
    throw new Error("Route sample fraction must be within [0, 1]");
  const resolved = resolveHorizontalAlignment({
    routeId: route.routeId,
    points: route.alignmentMeters,
    bendRadiusMeters: route.bendRadiusMeters,
    closed: route.closed,
  });
  const target = resolved.totalLengthMeters * fraction;
  let traversed = 0;
  for (let index = 0; index < resolved.primitives.length; index += 1) {
    const primitive = resolved.primitives[index]!;
    if (target <= traversed + primitive.lengthMeters || index === resolved.primitives.length - 1) {
      const amount = Math.max(0, Math.min(1, (target - traversed) / primitive.lengthMeters));
      const sample = sampleHorizontalPrimitive(primitive, amount);
      return { position: sample.position, tangent: sample.tangent, stationMeters: target };
    }
    traversed += primitive.lengthMeters;
  }
  throw new Error(`Route ${route.routeId} could not be sampled`);
}

export function routeCorridorDistanceSquared(
  points: readonly WorldPoint2[],
  point: Pick<WorldVector3, "x" | "z">,
): number {
  let minimum = Number.POSITIVE_INFINITY;
  for (let index = 1; index < points.length; index += 1) {
    const a = points[index - 1]!;
    const b = points[index]!;
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const denominator = dx * dx + dz * dz;
    const amount =
      denominator === 0
        ? 0
        : Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.z - a.z) * dz) / denominator));
    minimum = Math.min(
      minimum,
      (point.x - (a.x + amount * dx)) ** 2 + (point.z - (a.z + amount * dz)) ** 2,
    );
  }
  return minimum;
}

export function isPointInRouteCorridor(
  points: readonly WorldPoint2[],
  point: Pick<WorldVector3, "x" | "z">,
  widthMeters: number,
  clearanceMeters = 0,
): boolean {
  return routeCorridorDistanceSquared(points, point) <= (widthMeters / 2 + clearanceMeters) ** 2;
}

/** Conservative full-footprint broad phase used by lot subdivision. */
export function routeCorridorIntersectsAabbXZ(
  points: readonly WorldPoint2[],
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

function normalized(x: number, z: number): WorldPoint2 {
  const length = Math.hypot(x, z);
  if (length <= EPSILON) throw new Error("Resolved route span is degenerate");
  return { x: x / length, z: z / length };
}

function segmentIntersectsRectangle(
  start: WorldPoint2,
  end: WorldPoint2,
  rectangle: {
    readonly minX: number;
    readonly maxX: number;
    readonly minZ: number;
    readonly maxZ: number;
  },
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
