import { horizontalMaskBounds, horizontalMaskContainsPoint } from "@basalt/spatial-core";
import type { TerrainPlan, WorldPoint2 } from "./contracts.js";

export { horizontalMaskBounds, horizontalMaskContainsPoint };

const EPSILON = 1e-9;

/**
 * Evaluate the authored terrain program at one horizontal world-space point.
 * This is the single continuous surface definition used to seal height fields
 * and to resolve terrain-relative routes before an engine adapter quantizes it.
 */
export function evaluateTerrainElevation(
  plan: TerrainPlan,
  xMeters: number,
  zMeters: number,
): number {
  if (!Number.isFinite(xMeters) || !Number.isFinite(zMeters))
    throw new Error("Terrain coordinates must be finite");
  let elevationMeters = plan.baseElevationMeters;
  for (const operation of plan.operations) {
    if (operation.kind === "paint") continue;
    if (operation.kind === "raise") {
      const distance = Math.hypot(xMeters - operation.center.x, zMeters - operation.center.z);
      if (distance < operation.radiusMeters)
        elevationMeters +=
          operation.deltaMeters * smoothstep(1 - distance / operation.radiusMeters);
      continue;
    }
    if (operation.kind === "carve") {
      const distance = Math.hypot(xMeters - operation.center.x, zMeters - operation.center.z);
      if (distance < operation.radiusMeters)
        elevationMeters -=
          operation.depthMeters * smoothstep(1 - distance / operation.radiusMeters);
      continue;
    }
    const point = { x: xMeters, z: zMeters };
    if (pointInPolygon(point, operation.polygon)) {
      elevationMeters = operation.elevationMeters;
      continue;
    }
    if (operation.blendWidthMeters <= 0) continue;
    const distance = distanceToPolygon(point, operation.polygon);
    if (distance < operation.blendWidthMeters) {
      const influence = smoothstep(1 - distance / operation.blendWidthMeters);
      elevationMeters += (operation.elevationMeters - elevationMeters) * influence;
    }
  }
  return elevationMeters;
}

function smoothstep(value: number): number {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
}

/** Authored material masks change appearance only; later paint wins on overlap. */
export function evaluateTerrainMaterial(
  plan: TerrainPlan,
  xMeters: number,
  zMeters: number,
): string {
  if (!Number.isFinite(xMeters) || !Number.isFinite(zMeters))
    throw new Error("Terrain coordinates must be finite");
  let materialId = plan.materialId;
  for (const operation of plan.operations)
    if (
      operation.kind === "paint" &&
      terrainPaintContainsPoint(operation, { x: xMeters, z: zMeters })
    )
      materialId = operation.materialId;
  return materialId;
}

type TerrainPaintOperation = Extract<TerrainPlan["operations"][number], { kind: "paint" }>;

/** Resolve one authored paint mask in continuous world space before grid or engine quantization. */
export function terrainPaintContainsPoint(
  operation: TerrainPaintOperation,
  point: WorldPoint2,
): boolean {
  return horizontalMaskContainsPoint(operation.mask, point);
}

export function terrainPlanContainsHorizontalPoint(
  plan: TerrainPlan,
  xMeters: number,
  zMeters: number,
): boolean {
  return (
    xMeters >= plan.boundsMeters.x.minimum - EPSILON &&
    xMeters <= plan.boundsMeters.x.maximum + EPSILON &&
    zMeters >= plan.boundsMeters.z.minimum - EPSILON &&
    zMeters <= plan.boundsMeters.z.maximum + EPSILON
  );
}

function pointInPolygon(point: WorldPoint2, polygon: readonly WorldPoint2[]): boolean {
  for (let index = 0; index < polygon.length; index += 1)
    if (pointOnSegment(point, polygon[index]!, polygon[(index + 1) % polygon.length]!)) return true;
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

function distanceToPolygon(point: WorldPoint2, polygon: readonly WorldPoint2[]): number {
  let result = Number.POSITIVE_INFINITY;
  for (let index = 0; index < polygon.length; index += 1)
    result = Math.min(
      result,
      distanceToSegment(point, polygon[index]!, polygon[(index + 1) % polygon.length]!),
    );
  return result;
}

function distanceToSegment(point: WorldPoint2, start: WorldPoint2, end: WorldPoint2): number {
  const dx = end.x - start.x;
  const dz = end.z - start.z;
  const denominator = dx * dx + dz * dz;
  const parameter =
    denominator <= EPSILON
      ? 0
      : Math.max(
          0,
          Math.min(1, ((point.x - start.x) * dx + (point.z - start.z) * dz) / denominator),
        );
  return Math.hypot(point.x - (start.x + parameter * dx), point.z - (start.z + parameter * dz));
}

function pointOnSegment(point: WorldPoint2, start: WorldPoint2, end: WorldPoint2): boolean {
  return distanceToSegment(point, start, end) <= EPSILON;
}
