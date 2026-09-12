import test from "node:test";
import assert from "node:assert/strict";
import {
  fitSupportPlane,
  seedFromAssetId,
  type SupportPlaneFit,
  type SupportPlanePatch,
} from "../packages/asset-inspection/src/index.js";

function patch(ring: ReadonlyArray<readonly [number, number, number]>): SupportPlanePatch {
  return { polygon: ring.map(([x, y, z]) => ({ x, y, z })) };
}

function fitted(patches: SupportPlanePatch[], seed = 7): SupportPlaneFit {
  const result = fitSupportPlane(patches, seed);
  assert.equal(result.status, "fit");
  assert.equal(result.fits.length, 1);
  return result.fits[0]!;
}

const square = patch([
  [1, 0, 1],
  [-1, 0, 1],
  [-1, 0, -1],
  [1, 0, -1],
]);

test("support-plane fit finds flat contact exactly", () => {
  const fit = fitted([square]);
  assert.deepEqual(fit.normal, { x: 0, y: 1, z: 0 });
  assert.deepEqual(fit.origin, { x: 0, y: 0, z: 0 });
  assert.equal(fit.boundaryRadiusStuds, 1);
  assert.equal(fit.inlierCount, 4);
  assert.equal(fit.pointCount, 4);
});

test("support-plane origin follows the inlier centroid, not bounds center", () => {
  const trapezoid = patch([
    [0, 0, 0],
    [4, 0, 0],
    [3, 0, 2],
    [0, 0, 2],
  ]);
  const fit = fitted([trapezoid]);
  assert.equal(fit.origin.x, 1.75);
  assert.equal(fit.origin.z, 1);
  assert.equal(fit.boundaryRadiusStuds, 1);
});

test("support-plane fit ignores outlier spikes", () => {
  const fit = fitted([{ polygon: [...square.polygon, { x: 0, y: 5, z: 0 }] }]);
  assert.deepEqual(fit.normal, { x: 0, y: 1, z: 0 });
  assert.equal(fit.inlierCount, 4);
  assert.equal(fit.pointCount, 5);
  assert.equal(fit.boundaryRadiusStuds, 1);
});

test("support-plane fit rescues connected rim contact off-center", () => {
  const ring = [
    patch([
      [-2, 0, 1],
      [2, 0, 1],
      [2, 0, 2],
      [-2, 0, 2],
    ]),
    patch([
      [-2, 0, -2],
      [2, 0, -2],
      [2, 0, -1],
      [-2, 0, -1],
    ]),
    patch([
      [-2, 0, -1],
      [-1, 0, -1],
      [-1, 0, 1],
      [-2, 0, 1],
    ]),
    patch([
      [1, 0, -1],
      [2, 0, -1],
      [2, 0, 1],
      [1, 0, 1],
    ]),
  ];
  const fit = fitted(ring);
  assert.deepEqual(fit.normal, { x: 0, y: 1, z: 0 });
  assert.deepEqual(fit.origin, { x: 0, y: 0, z: 1.5 });
  assert.ok(Math.abs(fit.boundaryRadiusStuds - 0.5) < 1e-9);
});

test("support-plane clipping ignores interior triangulation diagonals", () => {
  const bar = [
    patch([
      [-8, 0, 0],
      [8, 0, 1],
      [-8, 0, 1],
    ]),
    patch([
      [-8, 0, 0],
      [8, 0, 0],
      [8, 0, 1],
    ]),
  ];
  const fit = fitted(bar);
  assert.deepEqual(fit.origin, { x: 0, y: 0, z: 0.5 });
  assert.equal(fit.boundaryRadiusStuds, 0.5);
});

test("support-plane fit mounts each disjoint foot", () => {
  const left = patch([
    [0, 0, 0],
    [1, 0, 0],
    [1, 0, 1],
    [0, 0, 1],
  ]);
  const right = patch([
    [5, 0, 0],
    [6, 0, 0],
    [6, 0, 1],
    [5, 0, 1],
  ]);
  const result = fitSupportPlane([left, right], 7);
  assert.equal(result.status, "fit");
  assert.equal(result.fits.length, 2);
  assert.deepEqual(result.fits[0]!.origin, { x: 0.5, y: 0, z: 0.5 });
  assert.deepEqual(result.fits[1]!.origin, { x: 5.5, y: 0, z: 0.5 });
  assert.equal(result.fits[0]!.boundaryRadiusStuds, 0.5);
  assert.equal(result.fits[1]!.boundaryRadiusStuds, 0.5);
});

test("support-plane fit refuses non-mount geometry", () => {
  const wall = patch([
    [0, 0, 0],
    [0, 2, 0],
    [0, 2, 1],
    [0, 0, 1],
  ]);
  assert.deepEqual(fitSupportPlane([wall], 7), { status: "refused", reason: "no_plane" });
  assert.deepEqual(fitSupportPlane([{ polygon: [{ x: 0, y: 0, z: 0 }] }], 7), {
    status: "refused",
    reason: "sparse_points",
  });
  assert.deepEqual(fitSupportPlane([], 7), { status: "refused", reason: "no_patches" });
});

test("support-plane fit is deterministic across runs and seeds", () => {
  const first = fitSupportPlane([square], 7);
  assert.deepEqual(fitSupportPlane([square], 7), first);
  assert.deepEqual(fitSupportPlane([square], 7), first);
  assert.deepEqual(fitSupportPlane([square], 123456789), first);
});

test("asset ids seed deterministically", () => {
  assert.equal(seedFromAssetId("catalog_00000001ff"), 1);
  assert.equal(seedFromAssetId("catalog_00000001ff"), seedFromAssetId("catalog_00000001ff"));
});
