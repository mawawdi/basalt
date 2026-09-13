import assert from "node:assert/strict";
import test from "node:test";
import { fitJointPlanes, fitSupportPlane } from "@basalt/asset-inspection";

test("joint measurement retains a small disconnected surface beyond the sample budget", () => {
  const size = 65;
  const vertices: Array<{ x: number; y: number; z: number }> = [];
  for (let y = 0; y <= size; y += 1)
    for (let x = 0; x <= size; x += 1) vertices.push({ x, y, z: 0 });
  const at = (x: number, y: number) => y * (size + 1) + x;
  const triangles: Array<[number, number, number]> = [];
  for (let y = 0; y < size; y += 1)
    for (let x = 0; x < size; x += 1) {
      triangles.push([at(x, y), at(x + 1, y), at(x + 1, y + 1)]);
      triangles.push([at(x, y), at(x + 1, y + 1), at(x, y + 1)]);
    }
  const offset = vertices.length;
  vertices.push(
    { x: 200, y: 0, z: 0 },
    { x: 200, y: 2, z: 0 },
    { x: 200, y: 2, z: 2 },
    { x: 200, y: 0, z: 2 },
  );
  triangles.push([offset, offset + 1, offset + 2], [offset, offset + 2, offset + 3]);
  assert.ok(triangles.length > 8192);

  const result = fitJointPlanes({ vertices, triangles });
  assert.equal(result.status, "fit");
  assert.equal(result.fits.length, 2);
  assert.deepEqual(
    result.fits.map((fit) => fit.faceAreaSquareMeters).sort((left, right) => left - right),
    [4, size * size],
  );
});

test("support measurement retains a small disconnected foot beyond the sample budget", () => {
  const size = 65;
  const patches = [];
  for (let z = 0; z < size; z += 1)
    for (let x = 0; x < size; x += 1) {
      patches.push({
        polygon: [
          { x, y: 0, z },
          { x: x + 1, y: 0, z },
          { x: x + 1, y: 0, z: z + 1 },
        ],
      });
      patches.push({
        polygon: [
          { x, y: 0, z },
          { x: x + 1, y: 0, z: z + 1 },
          { x, y: 0, z: z + 1 },
        ],
      });
    }
  patches.push(
    {
      polygon: [
        { x: 200, y: 0, z: 0 },
        { x: 202, y: 0, z: 0 },
        { x: 202, y: 0, z: 2 },
      ],
    },
    {
      polygon: [
        { x: 200, y: 0, z: 0 },
        { x: 202, y: 0, z: 2 },
        { x: 200, y: 0, z: 2 },
      ],
    },
  );
  assert.ok(patches.reduce((sum, patch) => sum + patch.polygon.length, 0) > 4096);

  const result = fitSupportPlane(patches, 17);
  assert.equal(result.status, "fit");
  assert.equal(result.fits.length, 2);
  assert.ok(result.fits.every((fit) => fit.boundaryRadiusMeters > 0));
});
