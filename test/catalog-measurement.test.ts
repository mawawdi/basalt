import assert from "node:assert/strict";
import test from "node:test";
import { catalogGeometryHash, type NormalizedMesh } from "@basalt/asset-inspection";

test("catalog geometry identity ignores source translation and serialization order", () => {
  const original: NormalizedMesh = {
    vertices: [
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 0, z: 0 },
      { x: 0, y: 1, z: 0 },
    ],
    triangles: [[0, 1, 2]],
  };
  const reordered: NormalizedMesh = {
    vertices: [
      { x: 10, y: 21, z: 30 },
      { x: 10, y: 20, z: 30 },
      { x: 11, y: 20, z: 30 },
      { x: 10, y: 20, z: 30 },
    ],
    triangles: [[0, 2, 3]],
  };
  assert.equal(catalogGeometryHash(original), catalogGeometryHash(reordered));
  assert.notEqual(
    catalogGeometryHash(original),
    catalogGeometryHash({
      ...original,
      vertices: original.vertices.map((vertex) => ({
        x: vertex.x * 2,
        y: vertex.y * 2,
        z: vertex.z * 2,
      })),
    }),
  );
});
