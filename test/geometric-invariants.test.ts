import test from "node:test";
import assert from "node:assert/strict";
import { measureGeometry } from "../packages/catalog-intelligence/src/index.js";

test("closed box geometry has genus zero", () => {
  const vertices = [
    { x: -1, y: -1, z: -1 },
    { x: 1, y: -1, z: -1 },
    { x: 1, y: 1, z: -1 },
    { x: -1, y: 1, z: -1 },
    { x: -1, y: -1, z: 1 },
    { x: 1, y: -1, z: 1 },
    { x: 1, y: 1, z: 1 },
    { x: -1, y: 1, z: 1 },
  ];
  const triangles = [
    [0, 1, 2],
    [0, 2, 3],
    [4, 6, 5],
    [4, 7, 6],
    [0, 4, 5],
    [0, 5, 1],
    [1, 5, 6],
    [1, 6, 2],
    [2, 6, 7],
    [2, 7, 3],
    [3, 7, 4],
    [3, 4, 0],
  ] as const;
  const measurement = measureGeometry({ vertices, triangles });
  assert.equal(measurement.genus, 0);
});

test("manifold render surfaces with boundaries have component-aware genus zero", () => {
  const measurement = measureGeometry({
    vertices: [
      { x: -1, y: 0, z: -1 },
      { x: 1, y: 0, z: -1 },
      { x: 1, y: 0, z: 1 },
      { x: -1, y: 0, z: 1 },
    ],
    triangles: [
      [0, 1, 2],
      [0, 2, 3],
    ],
  });
  assert.equal(measurement.genus, 0);
  assert.equal(measurement.isManifold, true);
});

test("non-manifold topology is rejected rather than assigned a genus", () => {
  const measurement = measureGeometry({
    vertices: [
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 0, z: 0 },
      { x: 0, y: 1, z: 0 },
      { x: 0, y: 0, z: 1 },
      { x: 0, y: -1, z: 0 },
    ],
    triangles: [
      [0, 1, 2],
      [0, 3, 1],
      [0, 4, 1],
    ],
  });
  assert.equal(measurement.genus, -1);
  assert.equal(measurement.isManifold, false);
});
