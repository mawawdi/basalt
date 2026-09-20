import { z } from "zod";
import { murmurHash3Uint32 } from "./primitives.js";

const finite = z.number().finite();
export const HORIZONTAL_MASK_POINT_SCHEMA = z.object({ x: finite, z: finite }).strict();
export type HorizontalMaskPoint = z.output<typeof HORIZONTAL_MASK_POINT_SCHEMA>;

export const HORIZONTAL_MASK_EDGE_PROFILE_SCHEMA = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z
        .literal("hard")
        .describe("An exact authored boundary for intentionally geometric surfaces."),
    })
    .strict(),
  z
    .object({
      kind: z
        .literal("organic")
        .describe("A deterministic world-space displacement of the authored coarse boundary."),
      seed: z.number().int().nonnegative().safe(),
      wavelengthMeters: finite
        .positive()
        .describe("World-space scale of the broad boundary variation in meters."),
      displacementMeters: finite
        .positive()
        .describe("Maximum inward or outward displacement from the coarse polygon in meters."),
    })
    .strict(),
]);
export type HorizontalMaskEdgeProfile = z.output<typeof HORIZONTAL_MASK_EDGE_PROFILE_SCHEMA>;

export const HORIZONTAL_MASK_SCHEMA = z
  .object({
    polygon: z
      .array(HORIZONTAL_MASK_POINT_SCHEMA)
      .min(3)
      .describe("A tight coarse envelope around the intended space, not an object bounding box."),
    edgeProfile: HORIZONTAL_MASK_EDGE_PROFILE_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    if (Math.abs(polygonArea(value.polygon)) <= 1e-9)
      context.addIssue({ code: "custom", path: ["polygon"], message: "Mask has zero area" });
  });
export type HorizontalMask = z.output<typeof HORIZONTAL_MASK_SCHEMA>;

/** Negative inside, positive outside, with the authored edge displacement already applied. */
export function horizontalMaskSignedDistance(
  mask: HorizontalMask,
  point: HorizontalMaskPoint,
): number {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.z))
    throw new Error("Horizontal mask coordinates must be finite");
  const coarseDistance = coarsePolygonSignedDistance(mask.polygon, point);
  if (mask.edgeProfile.kind === "hard") return coarseDistance;
  return (
    coarseDistance -
    mask.edgeProfile.displacementMeters *
      organicBoundaryNoise(point, mask.edgeProfile.seed, mask.edgeProfile.wavelengthMeters)
  );
}

export function horizontalMaskContainsPoint(
  mask: HorizontalMask,
  point: HorizontalMaskPoint,
): boolean {
  return horizontalMaskSignedDistance(mask, point) <= 0;
}

/** Complete X/Z envelope, including every possible organic displacement. */
export function horizontalMaskBounds(mask: HorizontalMask): {
  readonly min: HorizontalMaskPoint;
  readonly max: HorizontalMaskPoint;
} {
  const margin = mask.edgeProfile.kind === "organic" ? mask.edgeProfile.displacementMeters : 0;
  return {
    min: {
      x: Math.min(...mask.polygon.map((point) => point.x)) - margin,
      z: Math.min(...mask.polygon.map((point) => point.z)) - margin,
    },
    max: {
      x: Math.max(...mask.polygon.map((point) => point.x)) + margin,
      z: Math.max(...mask.polygon.map((point) => point.z)) + margin,
    },
  };
}

/** Conservative measured-footprint test used when a placement must stay outside a mask. */
export function horizontalMaskMayIntersectBounds(
  mask: HorizontalMask,
  bounds: {
    readonly min: HorizontalMaskPoint;
    readonly max: HorizontalMaskPoint;
  },
): boolean {
  const center = {
    x: (bounds.min.x + bounds.max.x) / 2,
    z: (bounds.min.z + bounds.max.z) / 2,
  };
  const radius = Math.hypot(bounds.max.x - bounds.min.x, bounds.max.z - bounds.min.z) / 2;
  const displacement =
    mask.edgeProfile.kind === "organic" ? mask.edgeProfile.displacementMeters : 0;
  return coarsePolygonSignedDistance(mask.polygon, center) <= radius + displacement;
}

function coarsePolygonSignedDistance(
  polygon: readonly HorizontalMaskPoint[],
  point: HorizontalMaskPoint,
) {
  return (pointInPolygon(point, polygon) ? -1 : 1) * distanceToPolygon(point, polygon);
}

function organicBoundaryNoise(
  point: HorizontalMaskPoint,
  seed: number,
  wavelength: number,
): number {
  const broad = valueNoise(point.x / wavelength, point.z / wavelength, seed);
  const detail = valueNoise(
    (point.x * 2) / wavelength,
    (point.z * 2) / wavelength,
    seed ^ 0x6d_2b_79_f5,
  );
  return (broad * 0.72 + detail * 0.28) * 2 - 1;
}

function valueNoise(x: number, z: number, seed: number): number {
  const ix = Math.floor(x),
    iz = Math.floor(z),
    tx = smoothstep(x - ix),
    tz = smoothstep(z - iz);
  const top = mix(latticeNoise(ix, iz, seed), latticeNoise(ix + 1, iz, seed), tx);
  const bottom = mix(latticeNoise(ix, iz + 1, seed), latticeNoise(ix + 1, iz + 1, seed), tx);
  return mix(top, bottom, tz);
}

function latticeNoise(x: number, z: number, seed: number): number {
  return (
    murmurHash3Uint32(Math.imul(x, 0x1f_12_3b_b5) ^ Math.imul(z, 0x5f_35_64_95) ^ (seed | 0)) /
    0x1_0000_0000
  );
}

function pointInPolygon(point: HorizontalMaskPoint, polygon: readonly HorizontalMaskPoint[]) {
  for (let index = 0; index < polygon.length; index += 1)
    if (distanceToSegment(point, polygon[index]!, polygon[(index + 1) % polygon.length]!) <= 1e-9)
      return true;
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const currentPoint = polygon[index]!;
    const previousPoint = polygon[previous]!;
    if (
      currentPoint.z > point.z !== previousPoint.z > point.z &&
      point.x <
        ((previousPoint.x - currentPoint.x) * (point.z - currentPoint.z)) /
          (previousPoint.z - currentPoint.z) +
          currentPoint.x
    )
      inside = !inside;
  }
  return inside;
}

function distanceToPolygon(point: HorizontalMaskPoint, polygon: readonly HorizontalMaskPoint[]) {
  let result = Number.POSITIVE_INFINITY;
  for (let index = 0; index < polygon.length; index += 1)
    result = Math.min(
      result,
      distanceToSegment(point, polygon[index]!, polygon[(index + 1) % polygon.length]!),
    );
  return result;
}

function distanceToSegment(
  point: HorizontalMaskPoint,
  start: HorizontalMaskPoint,
  end: HorizontalMaskPoint,
) {
  const dx = end.x - start.x,
    dz = end.z - start.z,
    denominator = dx * dx + dz * dz;
  const parameter =
    denominator <= 1e-9
      ? 0
      : Math.max(
          0,
          Math.min(1, ((point.x - start.x) * dx + (point.z - start.z) * dz) / denominator),
        );
  return Math.hypot(point.x - (start.x + parameter * dx), point.z - (start.z + parameter * dz));
}

function polygonArea(points: readonly HorizontalMaskPoint[]) {
  let area = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]!;
    const next = points[(index + 1) % points.length]!;
    area += current.x * next.z - next.x * current.z;
  }
  return area / 2;
}

function smoothstep(value: number) {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
}

function mix(left: number, right: number, amount: number) {
  return left + (right - left) * amount;
}
