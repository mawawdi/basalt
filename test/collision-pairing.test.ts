import test from "node:test";
import assert from "node:assert/strict";
import { pairCollisionCompanions } from "../packages/catalog-intelligence/src/index.js";

const box = {
  vertices: [
    { x: -1, y: -1, z: -1 },
    { x: 1, y: -1, z: -1 },
    { x: 1, y: 1, z: -1 },
    { x: -1, y: 1, z: -1 },
    { x: -1, y: -1, z: 1 },
    { x: 1, y: -1, z: 1 },
    { x: 1, y: 1, z: 1 },
    { x: -1, y: 1, z: 1 },
  ],
  triangles: [
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
  ],
} as const;

test("collision companions bind only after all gates pass", () => {
  const result = pairCollisionCompanions(
    [
      {
        assetId: "render",
        sourcePath: "Rock.glb",
        packageId: "pack",
        kind: "render",
        mesh: box,
        triangleCount: 100,
      },
      {
        assetId: "collision",
        sourcePath: "Rock_Collision.glb",
        packageId: "pack",
        kind: "collision",
        mesh: box,
        triangleCount: 12,
      },
    ],
    { voxelResolution: 8 },
  );
  assert.equal(result.bindings.length, 1);
  assert.equal(result.bindings[0]!.evidence.volumetricInclusion, 1);
  assert.equal(result.renderCandidates.length, 0);
});
