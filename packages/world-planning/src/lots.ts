import { z } from "zod";
import { contentHash, stableJson } from "../../contracts/src/index.js";
import {
  WORLD_PLAN_SCHEMA,
  WORLD_POINT2_SCHEMA,
  type SpatialWorldPlan,
  type WorldRegion,
  type WorldRoute,
} from "./contracts.js";
import { worldEntityId } from "./primitives.js";
import { isPointInRouteCorridor } from "./roads.js";

/**
 * Road-enclosed block subdivision for constructed districts. Blocks are the
 * connected components of plan cells outside every route corridor; allotments
 * are the axis-aligned rectangles of a deterministic guillotine decomposition
 * of each block. Splits align to road edges (not midpoints) so lots never
 * straddle a corridor, and midpoint size splits bring oversized free blocks
 * down to building scale. The solver is a pure function of the world plan:
 * no RNG, no palette, no brief roles. Zone tags ride on plan regions because
 * subdivision runs at plan-compile time, before any palette exists.
 */

export const LOT_SUBDIVISION_ABI = "basalt-lot-subdivision@1" as const;
export const DEFAULT_LOT_CELL_STUDS = 1 as const;
export const DEFAULT_MINIMUM_LOT_STUDS = 12 as const;
export const DEFAULT_MAXIMUM_LOT_STUDS = 30 as const;
export const DEFAULT_LOT_ROAD_MARGIN_STUDS = 2 as const;

const lotFrontageEdge = z.object({ from: WORLD_POINT2_SCHEMA, to: WORLD_POINT2_SCHEMA }).strict();

const lotRecord = z
  .object({
    id: worldEntityId,
    regionId: worldEntityId,
    blockIndex: z.number().int().nonnegative(),
    /** Axis-aligned rectangle corners in plan order (minX/minZ first). */
    polygon: z.array(WORLD_POINT2_SCHEMA).length(4),
    centroid: WORLD_POINT2_SCHEMA,
    areaStuds2: z.number().positive(),
    /** Lot edges directly adjacent to a route corridor (street frontage). */
    frontage: z.array(lotFrontageEdge).max(4),
  })
  .strict();

const lotBlockRecord = z
  .object({
    index: z.number().int().nonnegative(),
    cellCount: z.number().int().positive(),
    boundsMinimum: WORLD_POINT2_SCHEMA,
    boundsMaximum: WORLD_POINT2_SCHEMA,
    lotIds: z.array(worldEntityId),
  })
  .strict();

const lotSubdivisionMaterial = z
  .object({
    abi: z.literal(LOT_SUBDIVISION_ABI),
    regionId: worldEntityId,
    zoneTag: z.string().min(1).max(64).optional(),
    cellStuds: z.number().positive(),
    minLotStuds: z.number().positive(),
    maxLotStuds: z.number().positive(),
    roadMarginStuds: z.number().nonnegative(),
    blocks: z.array(lotBlockRecord).max(4096),
    lots: z.array(lotRecord).max(16384),
  })
  .strict();

export const LOT_SUBDIVISION_SCHEMA = lotSubdivisionMaterial
  .extend({
    hash: z.string().min(1).max(128),
  })
  .strict()
  .refine(
    (value) => value.hash === contentHash(stableJson({ ...value, hash: undefined })),
    "Lot subdivision hash must match its sealed material",
  );

export type LotRecord = z.infer<typeof lotRecord>;
export type LotBlockRecord = z.infer<typeof lotBlockRecord>;
export type LotSubdivision = z.infer<typeof LOT_SUBDIVISION_SCHEMA>;

export interface LotSubdivisionOptions {
  readonly cellStuds?: number;
  readonly minLotStuds?: number;
  readonly maxLotStuds?: number;
  readonly roadMarginStuds?: number;
}

export function sealLotSubdivision(input: z.input<typeof lotSubdivisionMaterial>): LotSubdivision {
  const material = lotSubdivisionMaterial.parse(input);
  return LOT_SUBDIVISION_SCHEMA.parse({
    ...material,
    hash: contentHash(stableJson(material)),
  });
}

export function assertLotSubdivision(value: unknown): asserts value is LotSubdivision {
  LOT_SUBDIVISION_SCHEMA.parse(value);
}

interface LotGrid {
  readonly minX: number;
  readonly minZ: number;
  readonly cell: number;
  readonly nx: number;
  readonly nz: number;
  /** Row-major free flags (true = outside every route corridor). */
  readonly free: readonly boolean[];
}

interface CellRect {
  readonly x0: number;
  readonly z0: number;
  readonly x1: number;
  readonly z1: number;
}

/** Subdivide every region of a world plan into road-enclosed building lots. */
export function subdivideWorldPlanToLots(
  planInput: unknown,
  options?: LotSubdivisionOptions,
): readonly LotSubdivision[] {
  const plan = WORLD_PLAN_SCHEMA.parse(planInput);
  return plan.regions.map((region) => subdivideRegion(plan, region, options ?? {}));
}

function subdivideRegion(
  plan: SpatialWorldPlan,
  region: WorldRegion,
  options: LotSubdivisionOptions,
): LotSubdivision {
  const cell = options.cellStuds ?? DEFAULT_LOT_CELL_STUDS;
  const minLot = options.minLotStuds ?? DEFAULT_MINIMUM_LOT_STUDS;
  const maxLot = options.maxLotStuds ?? DEFAULT_MAXIMUM_LOT_STUDS;
  const margin = options.roadMarginStuds ?? DEFAULT_LOT_ROAD_MARGIN_STUDS;
  if (!(cell > 0) || !(minLot > 0) || !(maxLot >= minLot) || !(margin >= 0))
    throw new Error(`Region ${region.id} lot options are degenerate`);
  const bounds = rectangularBounds(region);
  const grid = rasterizeFreeCells(plan.routes, bounds, cell, margin);
  const minCells = Math.max(1, Math.ceil(minLot / cell - 1e-9));
  const blocks = connectedBlocks(grid, minCells * minCells * cell * cell);
  const lots: LotRecord[] = [];
  const blockRecords: LotBlockRecord[] = [];
  blocks.forEach((block, blockIndex) => {
    const rects = decomposeBlock(grid, block, minCells, maxLot / cell);
    const lotIds: string[] = [];
    rects.forEach((rect, lotIndex) => {
      const id = `lot_${region.id}_${blockIndex}_${String(lotIndex).padStart(2, "0")}`;
      lotIds.push(id);
      lots.push(toLotRecord(grid, plan.routes, margin, id, region.id, blockIndex, rect));
    });
    blockRecords.push({
      index: blockIndex,
      cellCount: block.cells.length,
      boundsMinimum: { x: grid.minX + block.rect.x0 * cell, z: grid.minZ + block.rect.z0 * cell },
      boundsMaximum: { x: grid.minX + block.rect.x1 * cell, z: grid.minZ + block.rect.z1 * cell },
      lotIds,
    });
  });
  return sealLotSubdivision({
    abi: LOT_SUBDIVISION_ABI,
    regionId: region.id,
    ...(region.zoneTag === undefined ? {} : { zoneTag: region.zoneTag }),
    cellStuds: cell,
    minLotStuds: minLot,
    maxLotStuds: maxLot,
    roadMarginStuds: margin,
    blocks: blockRecords,
    lots,
  });
}

function rectangularBounds(region: WorldRegion): {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
} {
  const { volume } = region;
  if (volume.kind !== "extruded_polygon")
    throw new Error(
      `Region ${region.id} lot subdivision requires an extruded_polygon volume, found ${volume.kind}`,
    );
  const footprint = volume.footprint;
  if (footprint.length !== 4)
    throw new Error(
      `Region ${region.id} lot subdivision requires a rectangular footprint, found ${footprint.length} vertices`,
    );
  const xs = footprint.map((point) => point.x);
  const zs = footprint.map((point) => point.z);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minZ = Math.min(...zs);
  const maxZ = Math.max(...zs);
  const onRectangle = footprint.every(
    (point) =>
      (Math.abs(point.x - minX) <= 1e-6 || Math.abs(point.x - maxX) <= 1e-6) &&
      (Math.abs(point.z - minZ) <= 1e-6 || Math.abs(point.z - maxZ) <= 1e-6),
  );
  if (!onRectangle || !(maxX - minX > 0) || !(maxZ - minZ > 0))
    throw new Error(`Region ${region.id} lot subdivision requires an axis-aligned rectangle`);
  return { minX, minZ, maxX, maxZ };
}

function rasterizeFreeCells(
  routes: readonly WorldRoute[],
  bounds: { minX: number; minZ: number; maxX: number; maxZ: number },
  cell: number,
  margin: number,
): LotGrid {
  const nx = Math.max(1, Math.floor((bounds.maxX - bounds.minX) / cell + 1e-9));
  const nz = Math.max(1, Math.floor((bounds.maxZ - bounds.minZ) / cell + 1e-9));
  const free: boolean[] = new Array<boolean>(nx * nz);
  for (let iz = 0; iz < nz; iz += 1) {
    for (let ix = 0; ix < nx; ix += 1) {
      const point = {
        x: bounds.minX + (ix + 0.5) * cell,
        y: 0,
        z: bounds.minZ + (iz + 0.5) * cell,
      };
      free[iz * nx + ix] = !routes.some((route) =>
        isPointInRouteCorridor(route.points, route.width, point, margin),
      );
    }
  }
  return { minX: bounds.minX, minZ: bounds.minZ, cell, nx, nz, free };
}

interface BlockCells {
  readonly rect: CellRect;
  readonly cells: readonly number[];
}

function connectedBlocks(grid: LotGrid, minAreaStuds2: number): BlockCells[] {
  const seen = new Array<boolean>(grid.nx * grid.nz).fill(false);
  const blocks: BlockCells[] = [];
  for (let seed = 0; seed < grid.nx * grid.nz; seed += 1) {
    if (!grid.free[seed]! || seen[seed]!) continue;
    const cells: number[] = [];
    const stack = [seed];
    seen[seed] = true;
    let x0 = grid.nx;
    let z0 = grid.nz;
    let x1 = 0;
    let z1 = 0;
    while (stack.length > 0) {
      const at = stack.pop()!;
      cells.push(at);
      const ix = at % grid.nx;
      const iz = Math.floor(at / grid.nx);
      x0 = Math.min(x0, ix);
      z0 = Math.min(z0, iz);
      x1 = Math.max(x1, ix + 1);
      z1 = Math.max(z1, iz + 1);
      if (ix > 0 && grid.free[at - 1]! && !seen[at - 1]!) {
        seen[at - 1] = true;
        stack.push(at - 1);
      }
      if (ix + 1 < grid.nx && grid.free[at + 1]! && !seen[at + 1]!) {
        seen[at + 1] = true;
        stack.push(at + 1);
      }
      if (iz > 0 && grid.free[at - grid.nx]! && !seen[at - grid.nx]!) {
        seen[at - grid.nx] = true;
        stack.push(at - grid.nx);
      }
      if (iz + 1 < grid.nz && grid.free[at + grid.nx]! && !seen[at + grid.nx]!) {
        seen[at + grid.nx] = true;
        stack.push(at + grid.nx);
      }
    }
    // Sliver blocks below the minimum lot area are dropped, never emitted.
    if (cells.length * grid.cell * grid.cell < minAreaStuds2 - 1e-9) continue;
    blocks.push({ rect: { x0, z0, x1, z1 }, cells });
  }
  // Deterministic block order: north edge first, then west edge.
  blocks.sort((a, b) => a.rect.z0 - b.rect.z0 || a.rect.x0 - b.rect.x0);
  return blocks;
}

function prefixCount(prefix: readonly number[], stride: number, rect: CellRect): number {
  return (
    prefix[rect.z1 * stride + rect.x1]! -
    prefix[rect.z0 * stride + rect.x1]! -
    prefix[rect.z1 * stride + rect.x0]! +
    prefix[rect.z0 * stride + rect.x0]!
  );
}

function rectArea(rect: CellRect): number {
  return (rect.x1 - rect.x0) * (rect.z1 - rect.z0);
}

/**
 * Guillotine decomposition of one block. Only the block's own cells read as
 * free: a concave block bbox can cover road cells and neighboring blocks, and
 * reading the raw grid there would emit lots on land the block does not own.
 * Mixed rectangles split along the grid line that maximizes the purer child's
 * free fraction (road-edge alignment); free rectangles split at the midpoint
 * while oversized. Leaves are kept only when fully free and at least the
 * minimum lot size, so no lot ever straddles a corridor. Children are strictly
 * smaller, so recursion always terminates; tie-breaks are positional, so
 * output is deterministic.
 */
function decomposeBlock(
  grid: LotGrid,
  block: BlockCells,
  minCells: number,
  maxCells: number,
): CellRect[] {
  const owned = new Array<boolean>(grid.nx * grid.nz).fill(false);
  for (const cell of block.cells) owned[cell] = true;
  const stride = grid.nx + 1;
  const prefix: number[] = new Array<number>((grid.nx + 1) * (grid.nz + 1)).fill(0);
  for (let iz = 0; iz < grid.nz; iz += 1) {
    let row = 0;
    for (let ix = 0; ix < grid.nx; ix += 1) {
      row += owned[iz * grid.nx + ix]! ? 1 : 0;
      prefix[(iz + 1) * stride + ix + 1] = prefix[iz * stride + ix + 1]! + row;
    }
  }
  const ownedCount = (rect: CellRect): number => prefixCount(prefix, stride, rect);
  const kept: CellRect[] = [];
  const split = (rect: CellRect): void => {
    const width = rect.x1 - rect.x0;
    const height = rect.z1 - rect.z0;
    const free = ownedCount(rect);
    const area = rectArea(rect);
    if (free === area) {
      // Oversized but unsplittable on an axis (halves below minimum): keep whole.
      const axes: Array<"x" | "z"> = width >= height ? ["x", "z"] : ["z", "x"];
      for (const axis of axes) {
        const length = axis === "x" ? width : height;
        if (length * grid.cell <= maxCells * grid.cell) continue;
        const lo = axis === "x" ? rect.x0 : rect.z0;
        const mid = lo + Math.floor(length / 2);
        if (mid - lo < minCells || lo + length - mid < minCells) continue;
        split(axis === "x" ? { ...rect, x1: mid } : { ...rect, z1: mid });
        split(axis === "x" ? { ...rect, x0: mid } : { ...rect, z0: mid });
        return;
      }
      if (width >= minCells && height >= minCells) kept.push(rect);
      return;
    }
    const nodeFraction = free / area;
    let best: { axis: "x" | "z"; cut: number; score: number } | undefined;
    const consider = (axis: "x" | "z", cut: number, first: CellRect, second: CellRect): void => {
      const score = Math.max(
        ownedCount(first) / rectArea(first),
        ownedCount(second) / rectArea(second),
      );
      if (
        best === undefined ||
        score > best.score + 1e-12 ||
        (Math.abs(score - best.score) <= 1e-12 &&
          (axis === "x" && best.axis === "z" ? true : axis === best.axis && cut < best.cut))
      ) {
        best = { axis, cut, score };
      }
    };
    for (let cut = rect.x0 + minCells; cut + minCells <= rect.x1; cut += 1)
      consider("x", cut, { ...rect, x1: cut }, { ...rect, x0: cut });
    for (let cut = rect.z0 + minCells; cut + minCells <= rect.z1; cut += 1)
      consider("z", cut, { ...rect, z1: cut }, { ...rect, z0: cut });
    if (best === undefined || best.score <= nodeFraction + 1e-12) return;
    split(best.axis === "x" ? { ...rect, x1: best.cut } : { ...rect, z1: best.cut });
    split(best.axis === "x" ? { ...rect, x0: best.cut } : { ...rect, z0: best.cut });
  };
  split(block.rect);
  kept.sort((a, b) => a.z0 - b.z0 || a.x0 - b.x0);
  return kept;
}

function toLotRecord(
  grid: LotGrid,
  routes: readonly WorldRoute[],
  margin: number,
  id: string,
  regionId: string,
  blockIndex: number,
  rect: CellRect,
): LotRecord {
  const x0 = grid.minX + rect.x0 * grid.cell;
  const x1 = grid.minX + rect.x1 * grid.cell;
  const z0 = grid.minZ + rect.z0 * grid.cell;
  const z1 = grid.minZ + rect.z1 * grid.cell;
  const polygon = [
    { x: x0, z: z0 },
    { x: x1, z: z0 },
    { x: x1, z: z1 },
    { x: x0, z: z1 },
  ];
  const frontage: Array<{ from: { x: number; z: number }; to: { x: number; z: number } }> = [];
  const inCorridor = (x: number, z: number): boolean =>
    routes.some((route) =>
      isPointInRouteCorridor(route.points, route.width, { x, y: 0, z }, margin),
    );
  // Sample the strip just outside each edge; any corridor sample marks frontage.
  const edgeSamples = (edge: "west" | "east" | "north" | "south"): boolean => {
    if (edge === "west" || edge === "east") {
      const x = edge === "west" ? x0 - grid.cell / 2 : x1 + grid.cell / 2;
      for (let iz = rect.z0; iz < rect.z1; iz += 1)
        if (inCorridor(x, grid.minZ + (iz + 0.5) * grid.cell)) return true;
      return false;
    }
    const z = edge === "north" ? z0 - grid.cell / 2 : z1 + grid.cell / 2;
    for (let ix = rect.x0; ix < rect.x1; ix += 1)
      if (inCorridor(grid.minX + (ix + 0.5) * grid.cell, z)) return true;
    return false;
  };
  if (edgeSamples("west")) frontage.push({ from: polygon[0]!, to: polygon[3]! });
  if (edgeSamples("east")) frontage.push({ from: polygon[1]!, to: polygon[2]! });
  if (edgeSamples("north")) frontage.push({ from: polygon[0]!, to: polygon[1]! });
  if (edgeSamples("south")) frontage.push({ from: polygon[3]!, to: polygon[2]! });
  return {
    id,
    regionId,
    blockIndex,
    polygon,
    centroid: { x: (x0 + x1) / 2, z: (z0 + z1) / 2 },
    areaStuds2: (x1 - x0) * (z1 - z0),
    frontage,
  };
}
