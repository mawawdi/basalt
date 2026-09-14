import { SPATIAL_AABB_SCHEMA, SPATIAL_VECTOR3_SCHEMA } from "./occupancy.js";

export interface SpatialRayHit {
  readonly distance: number;
  readonly point: { readonly x: number; readonly y: number; readonly z: number };
}

/** Deterministic slab intersection over a normalized or non-normalized finite ray. */
export function rayAabbIntersection(
  originInput: unknown,
  directionInput: unknown,
  boundsInput: unknown,
  maximumDistance = Number.POSITIVE_INFINITY,
): SpatialRayHit | undefined {
  const origin = SPATIAL_VECTOR3_SCHEMA.parse(originInput);
  const direction = SPATIAL_VECTOR3_SCHEMA.parse(directionInput);
  const bounds = SPATIAL_AABB_SCHEMA.parse(boundsInput);
  const length = Math.hypot(direction.x, direction.y, direction.z);
  if (length <= 1e-12) throw new Error("Ray direction cannot be zero");
  if (Number.isNaN(maximumDistance) || maximumDistance < 0)
    throw new Error("Ray maximum distance must be nonnegative");
  const unit = { x: direction.x / length, y: direction.y / length, z: direction.z / length };
  let near = 0;
  let far = maximumDistance;
  for (const axis of ["x", "y", "z"] as const) {
    if (Math.abs(unit[axis]) <= 1e-12) {
      if (origin[axis] < bounds.min[axis] || origin[axis] > bounds.max[axis]) return undefined;
      continue;
    }
    let first = (bounds.min[axis] - origin[axis]) / unit[axis];
    let second = (bounds.max[axis] - origin[axis]) / unit[axis];
    if (first > second) [first, second] = [second, first];
    near = Math.max(near, first);
    far = Math.min(far, second);
    if (near > far) return undefined;
  }
  return {
    distance: near,
    point: {
      x: origin.x + unit.x * near,
      y: origin.y + unit.y * near,
      z: origin.z + unit.z * near,
    },
  };
}

export function segmentHasLineOfSight(
  startInput: unknown,
  endInput: unknown,
  obstacles: readonly unknown[],
  ignoredBounds: readonly unknown[] = [],
): boolean {
  const start = SPATIAL_VECTOR3_SCHEMA.parse(startInput);
  const end = SPATIAL_VECTOR3_SCHEMA.parse(endInput);
  const direction = { x: end.x - start.x, y: end.y - start.y, z: end.z - start.z };
  const distance = Math.hypot(direction.x, direction.y, direction.z);
  if (distance <= 1e-12) return true;
  const ignored = ignoredBounds.map((entry) => SPATIAL_AABB_SCHEMA.parse(entry));
  return !obstacles.some((entry) => {
    const bounds = SPATIAL_AABB_SCHEMA.parse(entry);
    if (ignored.some((candidate) => sameBounds(candidate, bounds))) return false;
    const hit = rayAabbIntersection(start, direction, bounds, distance);
    return hit !== undefined && hit.distance > 1e-8 && hit.distance < distance - 1e-8;
  });
}

export type SupportedVisibilityPrimitive =
  | {
      readonly kind: "box";
      readonly bounds: unknown;
    }
  | {
      readonly kind: "vertical_cylinder";
      readonly center: unknown;
      readonly radius: number;
      readonly height: number;
    }
  | { readonly kind: "unsupported"; readonly bounds: unknown };

/** Exact visibility for the primitive vocabulary supported by declarative construction. */
export function segmentPrimitiveVisibility(
  startInput: unknown,
  endInput: unknown,
  obstacles: readonly SupportedVisibilityPrimitive[],
): "blocked" | "clear" | "unresolved" {
  const start = SPATIAL_VECTOR3_SCHEMA.parse(startInput);
  const end = SPATIAL_VECTOR3_SCHEMA.parse(endInput);
  const direction = { x: end.x - start.x, y: end.y - start.y, z: end.z - start.z };
  const distance = Math.hypot(direction.x, direction.y, direction.z);
  if (distance <= 1e-12) return "clear";
  let unresolved = false;
  for (const obstacle of obstacles) {
    if (obstacle.kind === "unsupported") {
      const broadPhaseHit = rayAabbIntersection(start, direction, obstacle.bounds, distance);
      if (
        broadPhaseHit &&
        broadPhaseHit.distance > 1e-8 &&
        broadPhaseHit.distance < distance - 1e-8
      )
        unresolved = true;
      continue;
    }
    const hit =
      obstacle.kind === "box"
        ? rayAabbIntersection(start, direction, obstacle.bounds, distance)
        : rayVerticalCylinderIntersection(start, direction, obstacle, distance);
    if (hit && hit.distance > 1e-8 && hit.distance < distance - 1e-8) return "blocked";
  }
  return unresolved ? "unresolved" : "clear";
}

export function rayVerticalCylinderIntersection(
  originInput: unknown,
  directionInput: unknown,
  cylinderInput: {
    readonly center: unknown;
    readonly radius: number;
    readonly height: number;
  },
  maximumDistance = Number.POSITIVE_INFINITY,
): SpatialRayHit | undefined {
  const origin = SPATIAL_VECTOR3_SCHEMA.parse(originInput);
  const direction = SPATIAL_VECTOR3_SCHEMA.parse(directionInput);
  const center = SPATIAL_VECTOR3_SCHEMA.parse(cylinderInput.center);
  const radius = cylinderInput.radius;
  const height = cylinderInput.height;
  if (!Number.isFinite(radius) || radius <= 0 || !Number.isFinite(height) || height <= 0)
    throw new Error("Cylinder dimensions must be positive and finite");
  const length = Math.hypot(direction.x, direction.y, direction.z);
  if (length <= 1e-12) throw new Error("Ray direction cannot be zero");
  const unit = { x: direction.x / length, y: direction.y / length, z: direction.z / length };
  const candidates: number[] = [];
  const ox = origin.x - center.x;
  const oz = origin.z - center.z;
  const a = unit.x ** 2 + unit.z ** 2;
  if (a > 1e-12) {
    const b = 2 * (ox * unit.x + oz * unit.z);
    const c = ox ** 2 + oz ** 2 - radius ** 2;
    const discriminant = b * b - 4 * a * c;
    if (discriminant >= 0)
      for (const distance of [
        (-b - Math.sqrt(discriminant)) / (2 * a),
        (-b + Math.sqrt(discriminant)) / (2 * a),
      ]) {
        const y = origin.y + unit.y * distance;
        if (
          distance >= 0 &&
          distance <= maximumDistance &&
          y >= center.y - height / 2 &&
          y <= center.y + height / 2
        )
          candidates.push(distance);
      }
  }
  if (Math.abs(unit.y) > 1e-12)
    for (const sign of [-1, 1] as const) {
      const distance = (center.y + (sign * height) / 2 - origin.y) / unit.y;
      const x = origin.x + unit.x * distance - center.x;
      const z = origin.z + unit.z * distance - center.z;
      if (distance >= 0 && distance <= maximumDistance && x * x + z * z <= radius ** 2)
        candidates.push(distance);
    }
  const nearest = candidates.sort((left, right) => left - right)[0];
  return nearest === undefined
    ? undefined
    : {
        distance: nearest,
        point: {
          x: origin.x + unit.x * nearest,
          y: origin.y + unit.y * nearest,
          z: origin.z + unit.z * nearest,
        },
      };
}

function sameBounds(
  left: {
    readonly min: Record<"x" | "y" | "z", number>;
    readonly max: Record<"x" | "y" | "z", number>;
  },
  right: {
    readonly min: Record<"x" | "y" | "z", number>;
    readonly max: Record<"x" | "y" | "z", number>;
  },
): boolean {
  return (["x", "y", "z"] as const).every(
    (axis) => left.min[axis] === right.min[axis] && left.max[axis] === right.max[axis],
  );
}
