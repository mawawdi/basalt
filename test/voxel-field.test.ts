import test from "node:test";
import assert from "node:assert/strict";
import type { TerrainFieldArtifact } from "../packages/world-planning/src/contracts.js";
import {
  exportVoxelField,
  parseVoxelField,
  sha256Bytes,
} from "../packages/world-planning/src/voxels.js";

const CELL = 4;

/**
 * Sample grid whose points land exactly on voxel cell centers (step 2 over
 * ±8 with 4-stud cells), so each column tests a pure, unblended height.
 */
function field(heightAtIJ: (column: number, row: number) => number): TerrainFieldArtifact {
  const columns = 9;
  const rows = 9;
  const halfWidth = 8;
  const samples = [];
  for (let row = 0; row < rows; row += 1)
    for (let column = 0; column < columns; column += 1)
      samples.push({
        position: {
          x: -halfWidth + column * 2,
          y: heightAtIJ(column, row),
          z: -halfWidth + row * 2,
        },
        materialWeights: { datumMaterial: 1 },
      });
  return {
    surfaceId: "datumSurface",
    resolution: { columns, rows },
    bounds: {
      x: { minimum: -halfWidth, maximum: halfWidth },
      z: { minimum: -halfWidth, maximum: halfWidth },
    },
    samples,
  } as unknown as TerrainFieldArtifact;
}

/** Engine surface rule: center + occupancy x cell, topmost non-empty cell. */
function renderedHeight(
  occupancy: ArrayLike<number>,
  dimensions: readonly [number, number, number],
  originY: number,
  ix: number,
  iz: number,
): number {
  const [nx, ny, nz] = dimensions;
  for (let iy = ny - 1; iy >= 0; iy -= 1) {
    const occ = occupancy[ix + nx * (iz + nz * iy)]!;
    if (occ > 0) return originY + (iy + 0.5) * CELL + occ * CELL;
  }
  throw new Error("Column has no non-empty cell");
}

test("Voxel datum renders a flat plain on its plan height", () => {
  const exported = exportVoxelField(field(() => 0));
  assert.deepEqual(exported.dimensions, [4, 1, 4]);
  assert.deepEqual(exported.originStuds, [-8, -4, -8]);
  const parsed = parseVoxelField(exported.bytes);
  for (let iz = 0; iz < 4; iz += 1)
    for (let ix = 0; ix < 4; ix += 1) {
      assert.equal(parsed.occupancy[ix + 4 * iz], 0.5);
      assert.equal(renderedHeight(parsed.occupancy, parsed.dimensions, -4, ix, iz), 0);
    }
});

test("Voxel datum renders a carved strip below its surroundings", () => {
  // Sample row 3 sits on voxel row 1 (z = -2): carve it, leave the rest flat.
  const exported = exportVoxelField(
    field((_column: number, row: number) => (row === 3 ? -0.084 : 0)),
  );
  const parsed = parseVoxelField(exported.bytes);
  const carved = renderedHeight(parsed.occupancy, parsed.dimensions, parsed.originStuds[1], 1, 1);
  const plain = renderedHeight(parsed.occupancy, parsed.dimensions, parsed.originStuds[1], 1, 3);
  assert.ok(Math.abs(carved - -0.084) < 1e-6, `carved renders at ${carved}`);
  assert.ok(Math.abs(plain - 0) < 1e-6, `plain renders at ${plain}`);
  assert.ok(Math.abs(plain - carved - 0.084) < 1e-6);
});

test("Voxel datum renders a face-exact surface from the cell below", () => {
  const exported = exportVoxelField(
    field((column: number, row: number) => (column === 1 && row === 1 ? -4 : 0)),
  );
  const parsed = parseVoxelField(exported.bytes);
  assert.deepEqual(parsed.dimensions, [4, 2, 4]);
  // Column (0, 0) targets the shared face at -4: upper cell [-4, 0] is empty,
  // lower cell [-8, -4] carries it at 0.5.
  assert.equal(parsed.occupancy[0 + 4 * (0 + 4 * 1)], 0);
  assert.equal(parsed.occupancy[0 + 4 * (0 + 4 * 0)], 0.5);
  assert.equal(renderedHeight(parsed.occupancy, parsed.dimensions, -8, 0, 0), -4);
  assert.equal(renderedHeight(parsed.occupancy, parsed.dimensions, -8, 3, 3), 0);
});

test("Voxel datum renders relief columns on their plan heights", () => {
  const exported = exportVoxelField(
    field((column: number, row: number) => column * 0.5 + row * 0.25 - 2),
  );
  const parsed = parseVoxelField(exported.bytes);
  for (const [ix, iz] of [
    [0, 0],
    [3, 1],
    [1, 3],
    [3, 3],
  ] as Array<[number, number]>) {
    // Voxel column (ix, iz) centers on sample (2 ix + 1, 2 iz + 1).
    const expected = (2 * ix + 1) * 0.5 + (2 * iz + 1) * 0.25 - 2;
    const rendered = renderedHeight(
      parsed.occupancy,
      parsed.dimensions,
      parsed.originStuds[1],
      ix,
      iz,
    );
    assert.ok(Math.abs(rendered - expected) < 1e-6, `column renders at ${rendered}`);
  }
});

test("Voxel datum round-trips dimensions, origin, materials, and hash", () => {
  const exported = exportVoxelField(field(() => 0));
  const parsed = parseVoxelField(exported.bytes);
  assert.deepEqual(parsed.dimensions, exported.dimensions);
  assert.deepEqual(parsed.originStuds, exported.originStuds);
  assert.deepEqual(parsed.materials, ["datumMaterial"]);
  assert.equal(parsed.cellSizeStuds, CELL);
  assert.equal(sha256Bytes(exported.bytes), exported.contentHash);
});

test("Voxel liquid seals all-zero without a sea level", () => {
  const parsed = parseVoxelField(exportVoxelField(field(() => 0)).bytes);
  assert.ok(parsed.liquid.every((value) => value === 0));
  assert.equal(parsed.liquid.length, parsed.occupancy.length);
});

test("Voxel liquid fills the air above a drowned plain", () => {
  const parsed = parseVoxelField(
    exportVoxelField(
      field(() => 0),
      { seaLevelStuds: 4 },
    ).bytes,
  );
  assert.deepEqual(parsed.dimensions, [4, 2, 4]);
  for (let iz = 0; iz < 4; iz += 1)
    for (let ix = 0; ix < 4; ix += 1) {
      // Lower cell is solid rock to its top: no water inside it.
      assert.equal(parsed.liquid[ix + 4 * (iz + 4 * 0)], 0);
      // Upper cell is open air below the sea: full of water.
      assert.equal(parsed.liquid[ix + 4 * (iz + 4 * 1)], 1);
    }
});

test("Voxel liquid stays dry above the sea", () => {
  const parsed = parseVoxelField(
    exportVoxelField(
      field(() => 0),
      { seaLevelStuds: -8 },
    ).bytes,
  );
  assert.deepEqual(parsed.dimensions, [4, 1, 4]);
  assert.ok(parsed.liquid.every((value) => value === 0));
});

test("Voxel liquid derives a shoreline across relief", () => {
  // Sample columns step from -4 to 4; voxel column ix centers on 2 ix - 3.
  const parsed = parseVoxelField(
    exportVoxelField(
      field((column: number) => column - 4),
      { seaLevelStuds: 0 },
    ).bytes,
  );
  assert.deepEqual(parsed.dimensions, [4, 3, 4]);
  // Drowned column (surface -3): middle cell holds 0.75 water over rock.
  assert.equal(parsed.liquid[0 + 4 * (0 + 4 * 0)], 0);
  assert.ok(Math.abs(parsed.liquid[0 + 4 * (0 + 4 * 1)]! - 0.75) < 1e-6);
  assert.equal(parsed.liquid[0 + 4 * (0 + 4 * 2)], 0);
  // High column (surface 3): dry at every level.
  assert.ok([0, 1, 2].every((iy) => parsed.liquid[3 + 4 * (0 + 4 * iy)] === 0));
});

test("Voxel payloads seal magic BVX2 and refuse BVX1 bytes", () => {
  const exported = exportVoxelField(field(() => 0));
  assert.equal(String.fromCharCode(exported.bytes[0]!, exported.bytes[1]!), "BV");
  assert.equal(String.fromCharCode(exported.bytes[2]!, exported.bytes[3]!), "X2");
  const legacy = Uint8Array.from(exported.bytes);
  legacy[3] = "1".charCodeAt(0);
  assert.throws(() => parseVoxelField(legacy), /unknown magic/);
  assert.throws(
    () =>
      exportVoxelField(
        field(() => 0),
        { seaLevelStuds: Number.NaN },
      ),
    /finite/,
  );
});
