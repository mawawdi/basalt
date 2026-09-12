import test from "node:test";
import assert from "node:assert/strict";
import { VOXEL_SPOT_CELL_CAP, voxelSpotCells } from "../packages/world-planning/src/voxels.js";

test("Voxel spot cells cover a point field with its single cell", () => {
  assert.deepEqual(voxelSpotCells([1, 1, 1]), [[0, 0, 0]]);
});

test("Voxel spot cells cover a flat quad with its four cells", () => {
  assert.deepEqual(voxelSpotCells([2, 1, 2]), [
    [0, 0, 0],
    [0, 0, 1],
    [1, 0, 0],
    [1, 0, 1],
  ]);
});

test("Voxel spot cells span corners, center, and stride samples", () => {
  const cells = voxelSpotCells([16, 2, 16]);
  assert.ok(cells.length > 9 && cells.length <= VOXEL_SPOT_CELL_CAP);
  assert.deepEqual(new Set(cells.map(([x, y, z]) => `${x},${y},${z}`)).size, cells.length);
  for (const [x, y, z] of [
    [0, 0, 0],
    [15, 0, 0],
    [0, 0, 15],
    [15, 0, 15],
    [0, 1, 0],
    [15, 1, 0],
    [0, 1, 15],
    [15, 1, 15],
    [8, 1, 8],
  ]) {
    assert.ok(
      cells.some((cell) => cell[0] === x && cell[1] === y && cell[2] === z),
      `missing spot cell ${x},${y},${z}`,
    );
  }
  const sorted = [...cells].sort(
    (left, right) => left[0] - right[0] || left[1] - right[1] || left[2] - right[2],
  );
  assert.deepEqual(cells, sorted);
  // Byte-pinned rule output: the connector mirrors these exact cells.
  assert.deepEqual(cells, [
    [0, 0, 0],
    [0, 0, 11],
    [0, 0, 15],
    [0, 1, 0],
    [0, 1, 6],
    [0, 1, 15],
    [2, 0, 4],
    [2, 0, 15],
    [2, 1, 10],
    [4, 0, 8],
    [4, 1, 3],
    [4, 1, 14],
    [6, 0, 1],
    [6, 0, 12],
    [6, 1, 7],
    [8, 0, 5],
    [8, 1, 0],
    [8, 1, 8],
    [8, 1, 11],
    [10, 0, 9],
    [10, 1, 4],
    [12, 0, 2],
    [12, 0, 13],
    [12, 1, 8],
    [14, 0, 6],
    [14, 1, 1],
    [14, 1, 12],
    [15, 0, 0],
    [15, 0, 15],
    [15, 1, 0],
    [15, 1, 15],
  ]);
});

test("Voxel spot cells reject degenerate dimensions", () => {
  assert.throws(() => voxelSpotCells([0, 1, 1]), /positive integer dimensions/);
  assert.throws(() => voxelSpotCells([1.5, 1, 1]), /positive integer dimensions/);
});
