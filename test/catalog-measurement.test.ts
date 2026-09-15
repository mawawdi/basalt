import assert from "node:assert/strict";
import test from "node:test";
import {
  catalogGeometryHash,
  measureCatalogBottomSupport,
  type NormalizedMesh,
} from "@basalt/asset-inspection";

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

test("catalog support keeps exact planar bases as positive-area evidence", () => {
  const mesh: NormalizedMesh = {
    vertices: [
      { x: -1, y: 0, z: -1 },
      { x: 1, y: 0, z: -1 },
      { x: 1, y: 0, z: 1 },
      { x: -1, y: 0, z: 1 },
      { x: 0, y: 2, z: 0 },
    ],
    triangles: [
      [0, 2, 1],
      [0, 3, 2],
      [0, 1, 4],
      [1, 2, 4],
      [2, 3, 4],
      [3, 0, 4],
    ],
  };
  const support = measureCatalogBottomSupport(mesh, "a".repeat(64));
  assert.equal(support.status, "measured");
  assert.equal(support.measurementMethod, "planar_patch_fit");
  assert.ok(support.contactAreaSquareMeters > 0);
});

test("catalog support admits a pointed lower extent without inventing planar area", () => {
  const mesh: NormalizedMesh = {
    vertices: [
      { x: 0, y: 0, z: 0 },
      { x: -1, y: 1, z: -1 },
      { x: 1, y: 1, z: -1 },
      { x: 0, y: 1, z: 1 },
    ],
    triangles: [
      [0, 1, 2],
      [0, 2, 3],
      [0, 3, 1],
      [1, 3, 2],
    ],
  };
  const support = measureCatalogBottomSupport(mesh, "b".repeat(64));
  assert.deepEqual(
    support.status === "measured"
      ? {
          status: support.status,
          method: support.measurementMethod,
          area: support.contactAreaSquareMeters,
        }
      : support,
    { status: "measured", method: "lower_extrema", area: 0 },
  );
});

test("catalog support measures crossed foliage cards from lower extrema", () => {
  const mesh: NormalizedMesh = {
    vertices: [
      { x: -1, y: 0, z: 0 },
      { x: 1, y: 0, z: 0 },
      { x: -1, y: 2, z: 0 },
      { x: 1, y: 2, z: 0 },
      { x: 0, y: 0, z: -1 },
      { x: 0, y: 0, z: 1 },
      { x: 0, y: 2, z: -1 },
      { x: 0, y: 2, z: 1 },
    ],
    triangles: [
      [0, 1, 3],
      [0, 3, 2],
      [4, 5, 7],
      [4, 7, 6],
    ],
  };
  const first = measureCatalogBottomSupport(mesh, "c".repeat(64));
  const second = measureCatalogBottomSupport(mesh, "c".repeat(64));
  assert.equal(first.status, "measured");
  assert.equal(first.measurementMethod, "lower_extrema");
  assert.equal(first.contactAreaSquareMeters, 0);
  assert.deepEqual(first, second);
});
