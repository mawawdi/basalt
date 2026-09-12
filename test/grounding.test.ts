import assert from "node:assert/strict";
import test from "node:test";
import {
  calibrateGroundingSurface,
  groundPlacement,
  groundingKindFromSpan,
  groundingPolicyFor,
  indexGroundingEvidence,
  validateInterlockClearance,
  type GroundingArchetypeEvidence,
  type GroundingSurfaceSampler,
} from "../packages/world-compiler/src/index.js";

function evidence(overrides: Partial<GroundingArchetypeEvidence> = {}): GroundingArchetypeEvidence {
  return {
    assetId: "groundAsset",
    boundsMinimumStuds: { x: -1, y: 0, z: -1 },
    boundsMaximumStuds: { x: 1, y: 4, z: 1 },
    contactRadiusStuds: 0.5,
    ...overrides,
  };
}

/** Analytic surface: world = uv × scale, height + normal caller-defined. */
function stubSurface(options: {
  height?: (u: number, v: number) => number;
  normal?: { x: number; y: number; z: number };
  worldPerUv?: number;
}): GroundingSurfaceSampler {
  const height = options.height ?? (() => 0);
  const normal = options.normal ?? { x: 0, y: 1, z: 0 };
  const scale = options.worldPerUv ?? 2;
  return {
    sample: (_surfaceId, coordinate) => ({
      position: {
        x: coordinate.u * scale,
        y: height(coordinate.u, coordinate.v),
        z: coordinate.v * scale,
      },
      normal: { ...normal },
    }),
    coordinateBounds: (_surfaceId) => ({
      u: { minimum: 0, maximum: 10 },
      v: { minimum: 0, maximum: 10 },
    }),
  };
}

function rotationTiltDegrees(rotation: readonly [number, number, number, number]): number {
  const upY = 1 - 2 * (rotation[0] * rotation[0] + rotation[2] * rotation[2]);
  return (Math.acos(Math.max(-1, Math.min(1, upY))) * 180) / Math.PI;
}

test("Grounding classifies evidence spans without names or tags", () => {
  assert.equal(groundingKindFromSpan({ x: 5, y: 0.5, z: 5 }), "flat");
  assert.equal(groundingKindFromSpan({ x: 3, y: 4, z: 3 }), "compact");
  assert.equal(groundingKindFromSpan({ x: 2, y: 4, z: 2 }), "tall");
  assert.equal(groundingKindFromSpan({ x: 4, y: 9.32, z: 5 }), "tall");
  assert.equal(groundingKindFromSpan({ x: 5, y: 1, z: 5 }), "compact");
  assert.equal(groundingKindFromSpan({ x: 2, y: 3, z: 2 }), "compact");
  assert.throws(() => groundingKindFromSpan({ x: 0, y: 1, z: 0 }), /degenerate/);
  assert.deepEqual(groundingPolicyFor("flat"), {
    align: "normal",
    maximumTiltDegrees: 25,
    liftStuds: 0.05,
    embedStuds: 0,
    maximumSlopeDegrees: 30,
  });
  assert.deepEqual(groundingPolicyFor("tall"), {
    align: "upright",
    maximumTiltDegrees: 0,
    liftStuds: 0,
    embedStuds: 0.2,
    maximumSlopeDegrees: 40,
  });
});

test("Grounding rests centered assets on the sampled point with margin", () => {
  const sampler = stubSurface({});
  const calibration = calibrateGroundingSurface(sampler, "surface");
  assert.ok(Math.abs(calibration.worldPerU - 2) < 1e-9);
  const placed = groundPlacement({
    surfaceId: "surface",
    coordinate: { u: 3, v: 4 },
    yaw: 0.7,
    scale: 1,
    seed: "instance_1",
    evidence: evidence(),
    sampler,
    calibration,
  });
  assert.equal(placed.kind, "tall");
  assert.ok(Math.abs(placed.position.x - 6) < 1e-9);
  assert.ok(Math.abs(placed.position.z - 8) < 1e-9);
  assert.ok(Math.abs(placed.position.y - -0.2) < 1e-9);
  assert.equal(placed.rotation[0], 0);
  assert.equal(placed.rotation[2], 0);
});

test("Grounding keeps rebased contact on the sample at any yaw or scale", () => {
  const sampler = stubSurface({});
  const calibration = calibrateGroundingSurface(sampler, "surface");
  // Production shape: bottom_center_obb rebased bounds, contact at origin.
  const rebased = evidence({
    boundsMinimumStuds: { x: -2.5, y: 0, z: -2.5 },
    boundsMaximumStuds: { x: 2.5, y: 0.14, z: 2.5 },
    contactRadiusStuds: 2,
  });
  for (const [yaw, scale] of [
    [0, 1],
    [Math.PI, 2],
    [Math.PI / 3, 1.08],
  ] as const) {
    const placed = groundPlacement({
      surfaceId: "surface",
      coordinate: { u: 3, v: 4 },
      yaw,
      scale,
      seed: "instance_2",
      evidence: rebased,
      sampler,
      calibration,
    });
    assert.equal(placed.kind, "flat");
    assert.ok(Math.abs(placed.position.x - 6) < 1e-9, `yaw ${yaw} scale ${scale} shifts x`);
    assert.ok(Math.abs(placed.position.z - 8) < 1e-9, `yaw ${yaw} scale ${scale} shifts z`);
    assert.ok(Math.abs(placed.position.y - 0.05) < 1e-9);
  }
});

test("Grounding rests on the highest footprint sample and refuses cliffs", () => {
  const sampler = stubSurface({ height: (u) => (u > 3 ? 0.5 : 0) });
  const calibration = calibrateGroundingSurface(sampler, "surface");
  const placed = groundPlacement({
    surfaceId: "surface",
    coordinate: { u: 3, v: 4 },
    yaw: 0,
    scale: 1,
    seed: "instance_3",
    evidence: evidence({
      boundsMinimumStuds: { x: -2, y: 0, z: -2 },
      boundsMaximumStuds: { x: 2, y: 0.2, z: 2 },
      contactRadiusStuds: 1,
    }),
    sampler,
    calibration,
  });
  assert.ok(Math.abs(placed.position.y - 0.55) < 1e-9);
  const cliff = stubSurface({ height: (u) => (u > 3 ? 5 : 0) });
  assert.throws(
    () =>
      groundPlacement({
        surfaceId: "surface",
        coordinate: { u: 3, v: 4 },
        yaw: 0,
        scale: 1,
        seed: "instance_3",
        evidence: evidence({
          boundsMinimumStuds: { x: -2, y: 0, z: -2 },
          boundsMaximumStuds: { x: 2, y: 0.2, z: 2 },
          contactRadiusStuds: 1,
        }),
        sampler: cliff,
        calibration: calibrateGroundingSurface(cliff, "surface"),
      }),
    /unsupported placement/,
  );
});

test("Grounding caps normal alignment at the policy maximum tilt", () => {
  const steep = stubSurface({ normal: { x: 0, y: Math.SQRT1_2, z: Math.SQRT1_2 } });
  const calibration = calibrateGroundingSurface(steep, "surface");
  const flatEvidence = evidence({
    boundsMinimumStuds: { x: -2, y: 0, z: -2 },
    boundsMaximumStuds: { x: 2, y: 0.2, z: 2 },
    contactRadiusStuds: 1,
  });
  const placed = groundPlacement({
    surfaceId: "surface",
    coordinate: { u: 3, v: 4 },
    yaw: 0,
    scale: 1,
    seed: "instance_4",
    evidence: flatEvidence,
    sampler: steep,
    calibration,
  });
  assert.ok(Math.abs(rotationTiltDegrees(placed.rotation) - 25) < 1e-6);
  const gentle = stubSurface({
    normal: { x: 0, y: Math.cos(Math.PI / 18), z: Math.sin(Math.PI / 18) },
  });
  const followed = groundPlacement({
    surfaceId: "surface",
    coordinate: { u: 3, v: 4 },
    yaw: 0,
    scale: 1,
    seed: "instance_4",
    evidence: flatEvidence,
    sampler: gentle,
    calibration: calibrateGroundingSurface(gentle, "surface"),
  });
  assert.ok(Math.abs(rotationTiltDegrees(followed.rotation) - 10) < 1e-6);
});

test("Grounding is deterministic and validates its evidence", () => {
  const sampler = stubSurface({});
  const calibration = calibrateGroundingSurface(sampler, "surface");
  const input = {
    surfaceId: "surface",
    coordinate: { u: 3, v: 4 },
    yaw: 0.7,
    scale: 1,
    seed: "instance_5",
    evidence: evidence(),
    sampler,
    calibration,
  };
  assert.deepEqual(groundPlacement(input), groundPlacement(input));
  assert.throws(() => groundPlacement({ ...input, scale: 0 }), /positive/);
  assert.throws(
    () => groundPlacement({ ...input, evidence: evidence({ contactRadiusStuds: 0 }) }),
    /too_small/,
  );
  assert.throws(
    () =>
      indexGroundingEvidence({
        kind: "BasaltFamilyGroundingEvidence",
        abi: "basalt-family-grounding-evidence@1",
        inventoryHash: "0".repeat(64),
        evidence: [
          { familyId: "dupFamily", archetypes: [evidence()] },
          { familyId: "dupFamily", archetypes: [evidence()] },
        ],
      }),
    /Duplicate grounding evidence/,
  );
});

test("Interlock clearance judges footprint penetration", () => {
  validateInterlockClearance(
    [
      { position: { x: 0, y: 0, z: 0 }, radius: 1 },
      { position: { x: 2, y: 0, z: 0 }, radius: 1 },
    ],
    0,
  );
  validateInterlockClearance(
    [
      { position: { x: 0, y: 0, z: 0 }, radius: 1 },
      { position: { x: 1.9, y: 0, z: 0 }, radius: 1 },
    ],
    0.2,
  );
  assert.throws(
    () =>
      validateInterlockClearance(
        [
          { position: { x: 0, y: 0, z: 0 }, radius: 1 },
          { position: { x: 1.5, y: 0, z: 0 }, radius: 1 },
        ],
        0.2,
      ),
    /interlock/,
  );
  assert.throws(
    () => validateInterlockClearance([{ position: { x: 0, y: 0, z: 0 }, radius: -1 }], 0),
    /non-negative/,
  );
});
