import test from "node:test";
import assert from "node:assert/strict";
import {
  accumulateNodeWorldMatrices,
  calculateStudConversion,
} from "../packages/asset-inspection/src/index.js";
import { normalizeSceneGraph, rebaseAssetPivot } from "../packages/prepared-asset/src/index.js";

test("normalization accumulates nested transforms and maps glTF +Z to engine -Z", () => {
  const matrices = accumulateNodeWorldMatrices([
    { translation: [1, 0, 0] },
    { parentIndex: 0, translation: [2, 0, 0], meshIndex: 0 },
  ]);
  assert.equal(matrices[1]![12], 3);
  const normalized = normalizeSceneGraph(
    {
      nodes: [{ meshIndex: 0 }],
      meshes: [
        {
          vertices: [
            { x: 0, y: 0, z: 2 },
            { x: 1, y: 0, z: 2 },
            { x: 0, y: 1, z: 2 },
          ],
          triangles: [[0, 1, 2]],
        },
      ],
    },
    { pivotPolicy: "volumetric_center" },
  );
  assert.equal(normalized.meshes[0]!.vertices[0]!.z, -2 / 0.28);
});

test("normalization converts source meters directly without avatar-height targeting", () => {
  const heightMeters = 9.3;
  const normalized = normalizeSceneGraph(
    {
      nodes: [{ meshIndex: 0 }],
      meshes: [
        {
          vertices: [
            { x: 0, y: 0, z: 0 },
            { x: 1, y: 0, z: 0 },
            { x: 0, y: heightMeters, z: 0 },
          ],
          triangles: [[0, 1, 2]],
        },
      ],
    },
    { pivotPolicy: "volumetric_center" },
  );
  const ys = normalized.meshes[0]!.vertices.map((vertex) => vertex.y);
  assert.equal(Math.max(...ys) - Math.min(...ys), heightMeters / 0.28);
  assert.equal(normalized.studsPerSourceUnit, 1 / 0.28);
});

test("pivot rebasing returns fixed-point provenance", () => {
  const result = rebaseAssetPivot(
    {
      vertices: [
        { x: -1, y: 2, z: -2 },
        { x: 3, y: 6, z: 4 },
      ],
      triangles: [[0, 1, 0]],
    },
    "bottom_center_obb",
  );
  assert.equal(result.mesh.vertices[0]!.x, -2);
  assert.equal(result.mesh.vertices[0]!.y, 0);
  assert.equal(result.pivotOffset.x, "4294967296");
});

test("stud conversion divides source meters by the canonical stud size", () => {
  assert.equal(calculateStudConversion(1.0), 1 / 0.28);
  assert.equal(calculateStudConversion(0.1), 0.1 / 0.28);
  assert.equal(calculateStudConversion(0.01), 0.01 / 0.28);
});

test("normalization honors per-source unit decades", () => {
  const span = (units: number, unitScaleMeters: number) => {
    const normalized = normalizeSceneGraph(
      {
        nodes: [{ meshIndex: 0 }],
        meshes: [
          {
            vertices: [
              { x: 0, y: 0, z: 0 },
              { x: units, y: 0, z: 0 },
              { x: 0, y: units, z: 0 },
            ],
            triangles: [[0, 1, 2]],
          },
        ],
        unitScaleMeters,
      },
      { pivotPolicy: "volumetric_center" },
    );
    const xs = normalized.meshes[0]!.vertices.map((vertex) => vertex.x);
    return {
      extentStuds: Math.max(...xs) - Math.min(...xs),
      rate: normalized.studsPerSourceUnit,
    };
  };
  // FBX oracle anchors: ScaleCharacter height 1.8798 m, sedan length 51.654
  // decimeters, shark length 394.052 centimeters.
  assert.deepEqual(span(1.8798, 1.0), {
    extentStuds: 1.8798 * calculateStudConversion(1.0),
    rate: 1 / 0.28,
  });
  assert.deepEqual(span(51.654, 0.1), {
    extentStuds: 51.654 * calculateStudConversion(0.1),
    rate: 0.1 / 0.28,
  });
  assert.deepEqual(span(394.052, 0.01), {
    extentStuds: 394.052 * calculateStudConversion(0.01),
    rate: 0.01 / 0.28,
  });
});
