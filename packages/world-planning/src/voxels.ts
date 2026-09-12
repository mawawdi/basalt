import { createHash } from "node:crypto";
import { compareSpatialStrings } from "../../spatial-core/src/primitives.js";
import type { TerrainFieldArtifact, TerrainFieldSample } from "./contracts.js";

/** Default voxel edge length in studs. Matches the Roblox terrain cell. */
export const VOXEL_CELL_SIZE_STUDS = 4 as const;
/** Hard cap on exported voxel cells per terrain surface. */
export const MAXIMUM_VOXEL_CELLS = 1_048_576 as const;
/** Hard cap on readback spot cells per terrain surface. */
export const VOXEL_SPOT_CELL_CAP = 32 as const;
/**
 * Observed-vs-sealed occupancy tolerance for readback spots. Covers u8
 * engine quantization of the sealed f32 occupancy plus float noise; the
 * connector mirrors this value (see `VOXEL_SPOT_TOLERANCE`).
 */
export const VOXEL_SPOT_OCCUPANCY_TOLERANCE = 0.004 as const;
const VOXEL_MAGIC = "BVX1";

export interface VoxelFieldExport {
  readonly surfaceId: string;
  readonly cellSizeStuds: number;
  readonly originStuds: readonly [number, number, number];
  readonly dimensions: readonly [number, number, number];
  readonly materials: readonly string[];
  readonly bytes: Uint8Array;
  readonly contentHash: string;
}

/**
 * Lower one terrain heightfield to a deterministic voxel grid. Occupancy is
 * the clamped fraction of each cell below the bilinearly interpolated
 * surface; each column takes the dominant material at its center with
 * code-unit tiebreaks. Index order is x-fastest, then z, then y:
 * `index = x + dimX * (z + dimZ * y)`.
 *
 * Binary layout (all little-endian): magic `BVX1`, dims u32 x3, origin
 * f64 x3, cell size f64, material count u32, per material (name length
 * u16 + utf8), occupancy f32 per cell, material index u16 per cell.
 * The origin is an exact multiple of the cell size in every axis.
 */
export function exportVoxelField(
  field: TerrainFieldArtifact,
  options?: { readonly cellSizeStuds?: number },
): VoxelFieldExport {
  const cell = options?.cellSizeStuds ?? VOXEL_CELL_SIZE_STUDS;
  if (!Number.isFinite(cell) || cell <= 0)
    throw new Error(`Voxel cell size must be positive for surface ${field.surfaceId}`);
  const { columns, rows } = field.resolution;
  const stepX = (field.bounds.x.maximum - field.bounds.x.minimum) / (columns - 1);
  const stepZ = (field.bounds.z.maximum - field.bounds.z.minimum) / (rows - 1);
  let minH = Number.POSITIVE_INFINITY;
  let maxH = Number.NEGATIVE_INFINITY;
  for (const sample of field.samples) {
    minH = Math.min(minH, sample.position.y);
    maxH = Math.max(maxH, sample.position.y);
  }
  // Grid origins are cell-aligned in every axis so lowering adapters can
  // address whole cells without resampling; the grid extends to still cover
  // the declared bounds. Terrain is a solid volume below its surface: extend
  // one cell down so the lowest surface always has solid voxels beneath it
  // (a flat plain exactly on a cell boundary would otherwise export no solid
  // cells at all). Occupancy measures from the cell CENTER, not the cell
  // bottom: the engine's dual-contouring mesher overflows geometry into
  // neighboring voxels, and the rendered surface of the topmost non-empty
  // cell lands at center + occupancy x cell size (empirically fitted across
  // 73 sculpted columns; a solid plateau stands a full 2 studs above its
  // voxel tops). Bottom-measured occupancy buries every placement by half a
  // cell; center-measured occupancy puts the rendered surface on the plan
  // height it was sealed from.
  const originX = Math.floor(field.bounds.x.minimum / cell) * cell + 0;
  const originZ = Math.floor(field.bounds.z.minimum / cell) * cell + 0;
  const nx = Math.max(1, Math.ceil((field.bounds.x.maximum - originX) / cell));
  const nz = Math.max(1, Math.ceil((field.bounds.z.maximum - originZ) / cell));
  const yFloor = Math.floor(minH / cell) * cell - cell;
  const yCeil = Math.ceil(maxH / cell) * cell;
  const ny = Math.max(1, Math.round((yCeil - yFloor) / cell));
  const origin: readonly [number, number, number] = [originX, yFloor, originZ];
  const total = nx * ny * nz;
  if (total > MAXIMUM_VOXEL_CELLS)
    throw new Error(
      `Terrain surface ${field.surfaceId} exceeds ${MAXIMUM_VOXEL_CELLS} voxel cells`,
    );
  const at = (column: number, row: number): TerrainFieldSample =>
    field.samples[
      Math.min(rows - 1, Math.max(0, row)) * columns + Math.min(columns - 1, Math.max(0, column))
    ]!;
  const heightAt = (x: number, z: number): number => {
    const fx = (x - field.bounds.x.minimum) / stepX;
    const fz = (z - field.bounds.z.minimum) / stepZ;
    const c0 = Math.min(columns - 2, Math.max(0, Math.floor(fx)));
    const r0 = Math.min(rows - 2, Math.max(0, Math.floor(fz)));
    const tx = Math.min(1, Math.max(0, fx - c0));
    const tz = Math.min(1, Math.max(0, fz - r0));
    const h00 = at(c0, r0).position.y;
    const h10 = at(c0 + 1, r0).position.y;
    const h01 = at(c0, r0 + 1).position.y;
    const h11 = at(c0 + 1, r0 + 1).position.y;
    return h00 * (1 - tx) * (1 - tz) + h10 * tx * (1 - tz) + h01 * (1 - tx) * tz + h11 * tx * tz;
  };
  const materialAt = (x: number, z: number): string => {
    const fx = (x - field.bounds.x.minimum) / stepX;
    const fz = (z - field.bounds.z.minimum) / stepZ;
    const column = Math.min(columns - 1, Math.max(0, Math.round(fx)));
    const row = Math.min(rows - 1, Math.max(0, Math.round(fz)));
    const weights = at(column, row).materialWeights;
    let best = "";
    let bestWeight = Number.NEGATIVE_INFINITY;
    for (const key of Object.keys(weights).sort(compareSpatialStrings)) {
      const weight = weights[key]!;
      if (weight > bestWeight) {
        best = key;
        bestWeight = weight;
      }
    }
    if (!best) throw new Error(`Terrain surface ${field.surfaceId} has no bound material`);
    return best;
  };
  const occupancy = new Float32Array(total);
  const columnMaterial: string[] = new Array(nx * nz);
  for (let iz = 0; iz < nz; iz += 1)
    for (let ix = 0; ix < nx; ix += 1) {
      const cx = origin[0] + (ix + 0.5) * cell;
      const cz = origin[2] + (iz + 0.5) * cell;
      const surfaceH = heightAt(cx, cz);
      const material = materialAt(cx, cz);
      columnMaterial[iz * nx + ix] = material;
      for (let iy = 0; iy < ny; iy += 1) {
        const cellCenter = origin[1] + (iy + 0.5) * cell;
        occupancy[ix + nx * (iz + nz * iy)] = Math.min(
          1,
          Math.max(0, (surfaceH - cellCenter) / cell),
        );
      }
    }
  const materials = [...new Set(columnMaterial)].sort(compareSpatialStrings);
  if (materials.length > 65_535)
    throw new Error(`Terrain surface ${field.surfaceId} exceeds 65535 materials`);
  const materialIndex = new Map(materials.map((id, index) => [id, index]));
  const encodedNames = materials.map((id) => new TextEncoder().encode(id));
  for (const [index, encoded] of encodedNames.entries()) {
    if (encoded.byteLength > 65_535)
      throw new Error(`Terrain material id is too long: ${materials[index]}`);
  }
  const headerLength =
    4 + 12 + 24 + 8 + 4 + encodedNames.reduce((sum, name) => sum + 2 + name.byteLength, 0);
  const bytes = new Uint8Array(headerLength + total * 4 + total * 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < VOXEL_MAGIC.length; i += 1) view.setUint8(i, VOXEL_MAGIC.charCodeAt(i));
  view.setUint32(4, nx, true);
  view.setUint32(8, ny, true);
  view.setUint32(12, nz, true);
  view.setFloat64(16, origin[0], true);
  view.setFloat64(24, origin[1], true);
  view.setFloat64(32, origin[2], true);
  view.setFloat64(40, cell, true);
  view.setUint32(48, materials.length, true);
  let offset = 52;
  for (const encoded of encodedNames) {
    view.setUint16(offset, encoded.byteLength, true);
    offset += 2;
    bytes.set(encoded, offset);
    offset += encoded.byteLength;
  }
  for (let i = 0; i < total; i += 1) {
    view.setFloat32(offset, occupancy[i]!, true);
    offset += 4;
  }
  for (let iy = 0; iy < ny; iy += 1)
    for (let iz = 0; iz < nz; iz += 1)
      for (let ix = 0; ix < nx; ix += 1) {
        view.setUint16(offset, materialIndex.get(columnMaterial[iz * nx + ix]!)!, true);
        offset += 2;
      }
  return {
    surfaceId: field.surfaceId,
    cellSizeStuds: cell,
    originStuds: origin,
    dimensions: [nx, ny, nz],
    materials,
    bytes,
    contentHash: sha256Bytes(bytes),
  };
}

/** Parse bytes previously written by `exportVoxelField`; fails closed on mismatch. */
export function parseVoxelField(bytes: Uint8Array): {
  readonly dimensions: readonly [number, number, number];
  readonly originStuds: readonly [number, number, number];
  readonly cellSizeStuds: number;
  readonly materials: readonly string[];
  readonly occupancy: ReadonlyArray<number>;
  readonly materialIndex: ReadonlyArray<number>;
} {
  if (bytes.byteLength < 52) throw new Error("Voxel payload is truncated");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = String.fromCharCode(
    view.getUint8(0),
    view.getUint8(1),
    view.getUint8(2),
    view.getUint8(3),
  );
  if (magic !== VOXEL_MAGIC) throw new Error("Voxel payload has an unknown magic");
  const dimensions = [
    view.getUint32(4, true),
    view.getUint32(8, true),
    view.getUint32(12, true),
  ] as const;
  const origin = [
    view.getFloat64(16, true),
    view.getFloat64(24, true),
    view.getFloat64(32, true),
  ] as const;
  const cellSize = view.getFloat64(40, true);
  const materialCount = view.getUint32(48, true);
  let offset = 52;
  const materials: string[] = [];
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let i = 0; i < materialCount; i += 1) {
    if (offset + 2 > bytes.byteLength)
      throw new Error("Voxel payload truncates its material table");
    const length = view.getUint16(offset, true);
    offset += 2;
    if (offset + length > bytes.byteLength)
      throw new Error("Voxel payload truncates a material name");
    materials.push(decoder.decode(bytes.subarray(offset, offset + length)));
    offset += length;
  }
  const total = dimensions[0] * dimensions[1] * dimensions[2];
  if (offset + total * 6 !== bytes.byteLength)
    throw new Error("Voxel payload length disagrees with its dimensions");
  const occupancy: number[] = new Array(total);
  for (let i = 0; i < total; i += 1) {
    occupancy[i] = view.getFloat32(offset, true);
    offset += 4;
  }
  const materialIndex: number[] = new Array(total);
  for (let i = 0; i < total; i += 1) {
    const index = view.getUint16(offset, true);
    if (index >= materials.length) throw new Error("Voxel payload references unknown material");
    materialIndex[i] = index;
    offset += 2;
  }
  return {
    dimensions,
    originStuds: origin,
    cellSizeStuds: cellSize,
    materials,
    occupancy,
    materialIndex,
  };
}

export function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Deterministic readback spot cells for a field: the 8 corners, the center,
 * then flat-order samples at an adaptive stride, deduplicated and capped.
 * The connector implements this exact rule (`VoxelSpots.cells`); the host
 * requires an exact cell-set match, so any rule drift fails closed at settle.
 */
export function voxelSpotCells(
  dimensions: readonly [number, number, number],
): Array<readonly [number, number, number]> {
  const [nx, ny, nz] = dimensions;
  if (
    !Number.isSafeInteger(nx) ||
    !Number.isSafeInteger(ny) ||
    !Number.isSafeInteger(nz) ||
    nx < 1 ||
    ny < 1 ||
    nz < 1
  )
    throw new Error("Voxel spot cells need positive integer dimensions");
  const total = nx * ny * nz;
  const seen = new Set<number>();
  const cells: Array<readonly [number, number, number]> = [];
  const push = (x: number, y: number, z: number): void => {
    const flat = x + nx * (z + nz * y);
    if (seen.has(flat)) return;
    seen.add(flat);
    cells.push([x, y, z]);
  };
  for (const x of [0, nx - 1])
    for (const y of [0, ny - 1]) for (const z of [0, nz - 1]) push(x, y, z);
  push(Math.floor(nx / 2), Math.floor(ny / 2), Math.floor(nz / 2));
  const step = Math.max(1, Math.floor(total / (VOXEL_SPOT_CELL_CAP - 9)));
  for (let i = 0; i < VOXEL_SPOT_CELL_CAP - 9 && cells.length < VOXEL_SPOT_CELL_CAP; i += 1) {
    const flat = (i * step) % total;
    const x = flat % nx;
    const rest = (flat - x) / nx;
    const z = rest % nz;
    push(x, (rest - z) / nz, z);
  }
  cells.sort((left, right) => left[0] - right[0] || left[1] - right[1] || left[2] - right[2]);
  return cells;
}
