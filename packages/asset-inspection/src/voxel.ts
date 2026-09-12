import type { NormalizedMesh } from "./geometry.js";

export interface VoxelBounds {
  readonly minimum: readonly [number, number, number];
  readonly maximum: readonly [number, number, number];
}

export function computeVoxelVolumeInclusion(
  render: NormalizedMesh,
  collision: NormalizedMesh,
  resolution = 128,
): number {
  if (!Number.isInteger(resolution) || resolution < 4 || resolution > 256)
    throw new Error("Voxel resolution must be an integer between 4 and 256");
  const renderBounds = meshBounds(render);
  const collisionBounds = meshBounds(collision);
  const collisionVolume = boxVolume(collisionBounds);
  if (collisionVolume <= 0) return 0;
  const lower = collisionBounds.minimum;
  const upper = collisionBounds.maximum;
  const step = [
    (upper[0] - lower[0]) / resolution,
    (upper[1] - lower[1]) / resolution,
    (upper[2] - lower[2]) / resolution,
  ] as const;
  if (step.some((value) => value <= 0)) return 0;
  let collisionVoxels = 0;
  let includedVoxels = 0;
  for (let x = 0; x < resolution; x += 1)
    for (let y = 0; y < resolution; y += 1)
      for (let z = 0; z < resolution; z += 1) {
        const point = {
          x: lower[0] + (x + 0.5) * step[0],
          y: lower[1] + (y + 0.5) * step[1],
          z: lower[2] + (z + 0.5) * step[2],
        };
        if (!pointInsideBounds(point, collisionBounds)) continue;
        collisionVoxels += 1;
        if (pointInsideBounds(point, renderBounds)) includedVoxels += 1;
      }
  return collisionVoxels === 0 ? 0 : includedVoxels / collisionVoxels;
}

export function meshBounds(mesh: NormalizedMesh): VoxelBounds {
  if (mesh.vertices.length === 0) throw new Error("Cannot bound an empty mesh");
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  for (const point of mesh.vertices) {
    minimum[0] = Math.min(minimum[0]!, point.x);
    minimum[1] = Math.min(minimum[1]!, point.y);
    minimum[2] = Math.min(minimum[2]!, point.z);
    maximum[0] = Math.max(maximum[0]!, point.x);
    maximum[1] = Math.max(maximum[1]!, point.y);
    maximum[2] = Math.max(maximum[2]!, point.z);
  }
  return {
    minimum: [minimum[0]!, minimum[1]!, minimum[2]!],
    maximum: [maximum[0]!, maximum[1]!, maximum[2]!],
  };
}

export function boxVolume(bounds: VoxelBounds): number {
  return (
    Math.max(0, bounds.maximum[0] - bounds.minimum[0]) *
    Math.max(0, bounds.maximum[1] - bounds.minimum[1]) *
    Math.max(0, bounds.maximum[2] - bounds.minimum[2])
  );
}

function pointInsideBounds(
  point: { readonly x: number; readonly y: number; readonly z: number },
  bounds: VoxelBounds,
): boolean {
  return (
    point.x >= bounds.minimum[0] &&
    point.x <= bounds.maximum[0] &&
    point.y >= bounds.minimum[1] &&
    point.y <= bounds.maximum[1] &&
    point.z >= bounds.minimum[2] &&
    point.z <= bounds.maximum[2]
  );
}
