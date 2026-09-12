import assert from "node:assert/strict";
import test from "node:test";
import { quantizeQ32_32 } from "../packages/basalt-types/src/fixed.js";
import {
  socketContractSchema,
  type SocketContract,
} from "../packages/basalt-types/src/asset-family.js";
import { fitJointPlanes } from "../packages/asset-inspection/src/index.js";
import {
  assertCatalogInventoryIdentity,
  buildAuthoredAssetFamilyRevision,
  buildJointSockets,
  evaluateModularKit,
  jointsMate,
  matingFaceSets,
  sealCatalogInventory,
  type CatalogAssetEnvelope,
} from "../packages/catalog-intelligence/src/index.js";
import { catalogAssetRecordSchema } from "../packages/basalt-types/src/index.js";

function cubeMesh(): {
  vertices: { x: number; y: number; z: number }[];
  triangles: [number, number, number][];
} {
  const vertices: { x: number; y: number; z: number }[] = [];
  for (const x of [-1, 1])
    for (const y of [-1, 1]) for (const z of [-1, 1]) vertices.push({ x, y, z });
  const id = (x: number, y: number, z: number): number =>
    vertices.findIndex((point) => point.x === x && point.y === y && point.z === z);
  const quad = (a: number, b: number, c: number, d: number): [number, number, number][] => [
    [a, b, c],
    [a, c, d],
  ];
  return {
    vertices,
    triangles: [
      ...quad(id(-1, -1, 1), id(1, -1, 1), id(1, 1, 1), id(-1, 1, 1)),
      ...quad(id(1, -1, -1), id(-1, -1, -1), id(-1, 1, -1), id(1, 1, -1)),
      ...quad(id(1, -1, 1), id(1, -1, -1), id(1, 1, -1), id(1, 1, 1)),
      ...quad(id(-1, -1, -1), id(-1, -1, 1), id(-1, 1, 1), id(-1, 1, -1)),
      ...quad(id(-1, 1, 1), id(1, 1, 1), id(1, 1, -1), id(-1, 1, -1)),
      ...quad(id(-1, -1, -1), id(1, -1, -1), id(1, -1, 1), id(-1, -1, 1)),
    ],
  };
}

function boxMesh(
  x0: number,
  x1: number,
): {
  vertices: { x: number; y: number; z: number }[];
  triangles: [number, number, number][];
} {
  const vertices: { x: number; y: number; z: number }[] = [];
  for (const x of [x0, x1])
    for (const y of [0, 2]) for (const z of [0, 2]) vertices.push({ x, y, z });
  const id = (x: number, y: number, z: number): number =>
    vertices.findIndex((point) => point.x === x && point.y === y && point.z === z);
  const quad = (a: number, b: number, c: number, d: number): [number, number, number][] => [
    [a, b, c],
    [a, c, d],
  ];
  return {
    vertices,
    triangles: [
      ...quad(id(x0, 0, 2), id(x1, 0, 2), id(x1, 2, 2), id(x0, 2, 2)),
      ...quad(id(x1, 0, 0), id(x0, 0, 0), id(x0, 2, 0), id(x1, 2, 0)),
      ...quad(id(x1, 0, 2), id(x1, 0, 0), id(x1, 2, 0), id(x1, 2, 2)),
      ...quad(id(x0, 0, 0), id(x0, 0, 2), id(x0, 2, 2), id(x0, 2, 0)),
      ...quad(id(x0, 2, 2), id(x1, 2, 2), id(x1, 2, 0), id(x0, 2, 0)),
      ...quad(id(x0, 0, 0), id(x1, 0, 0), id(x1, 0, 2), id(x0, 0, 2)),
    ],
  };
}

test("joint-plane fit finds all six cube faces exactly", () => {
  const result = fitJointPlanes(cubeMesh());
  assert.equal(result.status, "fit");
  assert.equal(result.fits.length, 6);
  assert.deepEqual(result.fits[0], {
    normal: { x: -1, y: 0, z: 0 },
    origin: { x: -1, y: 0, z: 0 },
    boundaryRadiusStuds: 1,
    axisAlignmentDegrees: 0,
    faceAreaStuds2: 4,
    inlierCount: 2,
    pointCount: 12,
  });
  for (const fit of result.fits) {
    assert.equal(fit.boundaryRadiusStuds, 1);
    assert.equal(fit.axisAlignmentDegrees, 0);
    assert.equal(fit.faceAreaStuds2, 4);
  }
});

test("joint-plane fit is byte-identical across runs", () => {
  const left = boxMesh(0, 2);
  const right = boxMesh(2, 4);
  const mesh = {
    vertices: [...left.vertices, ...right.vertices],
    triangles: [
      ...left.triangles,
      ...right.triangles.map(([a, b, c]): [number, number, number] => [a + 8, b + 8, c + 8]),
    ],
  };
  const first = fitJointPlanes(mesh);
  const second = fitJointPlanes(structuredClone(mesh));
  assert.deepEqual(second, first);
});

test("joint-plane fit splits coplanar patches and drops interior faces", () => {
  const left = boxMesh(0, 2);
  const right = boxMesh(2, 4);
  const mesh = {
    vertices: [...left.vertices, ...right.vertices],
    triangles: [
      ...left.triangles,
      ...right.triangles.map(([a, b, c]): [number, number, number] => [a + 8, b + 8, c + 8]),
    ],
  };
  const result = fitJointPlanes(mesh);
  assert.equal(result.status, "fit");
  assert.equal(result.fits.length, 10);
  for (const fit of result.fits) {
    assert.notEqual(fit.origin.x, 2);
    assert.ok(fit.boundaryRadiusStuds >= 0.2);
  }
});

test("joint-plane fit refuses empty, non-planar, and sliver geometry", () => {
  const empty = fitJointPlanes({ vertices: [], triangles: [] });
  assert.deepEqual(empty, { status: "refused", reason: "no_triangles" });
  const tetra = fitJointPlanes({
    vertices: [
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 0, z: 0 },
      { x: 0, y: 1, z: 0 },
      { x: 0, y: 0, z: 1 },
    ],
    triangles: [
      [0, 1, 2],
      [0, 1, 3],
      [0, 2, 3],
      [1, 2, 3],
    ],
  });
  assert.deepEqual(tetra, { status: "refused", reason: "no_planar_faces" });
  const sliver = fitJointPlanes({
    vertices: [
      { x: 0, y: 0, z: 0 },
      { x: 4, y: 0, z: 0 },
      { x: 4, y: 0.25, z: 0 },
      { x: 0, y: 0.25, z: 0 },
    ],
    triangles: [
      [0, 1, 2],
      [0, 2, 3],
    ],
  });
  assert.deepEqual(sliver, { status: "refused", reason: "degenerate_faces" });
});

test("joint sockets seal wall and slab frames with canonical up", () => {
  const [wall] = buildJointSockets({
    variantName: "wall_panel",
    jointPlaneFits: [
      {
        normalQ32_32: { x: quantizeQ32_32(1), y: quantizeQ32_32(0), z: quantizeQ32_32(0) },
        originQ32_32: { x: quantizeQ32_32(2), y: quantizeQ32_32(0), z: quantizeQ32_32(0) },
        boundaryRadiusStuds: 1,
        inlierCount: 2,
        pointCount: 12,
      },
    ],
  });
  assert.deepEqual(wall, {
    socketId: "joint_wall_panel_01",
    role: "joint",
    polarity: "Neutral",
    localOrigin: { x: "8589934592", y: "0", z: "0" },
    normal: { x: "4294967296", y: "0", z: "0" },
    upVector: { x: "0", y: "4294967296", z: "0" },
    boundaryRadius: "4294967296",
    angularStepDegrees: 0,
  });
  const [slab] = buildJointSockets({
    variantName: "floor_plate",
    jointPlaneFits: [
      {
        normalQ32_32: { x: quantizeQ32_32(0), y: quantizeQ32_32(1), z: quantizeQ32_32(0) },
        originQ32_32: { x: quantizeQ32_32(0), y: quantizeQ32_32(2), z: quantizeQ32_32(0) },
        boundaryRadiusStuds: 1,
        inlierCount: 2,
        pointCount: 12,
      },
    ],
  });
  assert.deepEqual(slab!.upVector, { x: "0", y: "0", z: "4294967296" });
  const [sanitized] = buildJointSockets({
    variantName: "Wall Panel!",
    jointPlaneFits: [
      {
        normalQ32_32: { x: quantizeQ32_32(1), y: quantizeQ32_32(0), z: quantizeQ32_32(0) },
        originQ32_32: { x: quantizeQ32_32(0), y: quantizeQ32_32(0), z: quantizeQ32_32(0) },
        boundaryRadiusStuds: 1,
        inlierCount: 2,
        pointCount: 12,
      },
    ],
  });
  assert.equal(sanitized!.socketId, "joint_Wall_Panel__01");
});

test("joint sockets fail closed on degenerate fits", () => {
  assert.throws(
    () =>
      buildJointSockets({
        variantName: "wall",
        jointPlaneFits: [
          {
            normalQ32_32: { x: quantizeQ32_32(1), y: quantizeQ32_32(0), z: quantizeQ32_32(0) },
            originQ32_32: { x: quantizeQ32_32(0), y: quantizeQ32_32(0), z: quantizeQ32_32(0) },
            boundaryRadiusStuds: 0,
            inlierCount: 2,
            pointCount: 12,
          },
        ],
      }),
    /positively clipped/,
  );
  assert.throws(
    () =>
      buildJointSockets({
        variantName: "wall",
        jointPlaneFits: [
          {
            normalQ32_32: { x: quantizeQ32_32(0), y: quantizeQ32_32(0), z: quantizeQ32_32(0) },
            originQ32_32: { x: quantizeQ32_32(0), y: quantizeQ32_32(0), z: quantizeQ32_32(0) },
            boundaryRadiusStuds: 1,
            inlierCount: 2,
            pointCount: 12,
          },
        ],
      }),
    /nonzero/,
  );
});

function jointSocket(overrides: {
  origin: readonly [number, number, number];
  normal: readonly [number, number, number];
  radius?: number;
}): SocketContract {
  return socketContractSchema.parse({
    socketId: "joint_test_01",
    role: "joint",
    polarity: "Neutral",
    localOrigin: {
      x: quantizeQ32_32(overrides.origin[0]),
      y: quantizeQ32_32(overrides.origin[1]),
      z: quantizeQ32_32(overrides.origin[2]),
    },
    normal: {
      x: quantizeQ32_32(overrides.normal[0]),
      y: quantizeQ32_32(overrides.normal[1]),
      z: quantizeQ32_32(overrides.normal[2]),
    },
    upVector: { x: quantizeQ32_32(0), y: quantizeQ32_32(1), z: quantizeQ32_32(0) },
    boundaryRadius: quantizeQ32_32(overrides.radius ?? 1),
    angularStepDegrees: 0,
  });
}

test("opposed coplanar joints mate cleanly", () => {
  const assessment = jointsMate(
    jointSocket({ origin: [0, 0, 0], normal: [1, 0, 0] }),
    jointSocket({ origin: [0, 0, 0], normal: [-1, 0, 0] }),
    { support: 0.1, penetration: 0.1, clearance: 0.1 },
  );
  assert.deepEqual(assessment, { mates: true, reasons: [] });
});

test("joint mating fails closed per tolerance with reasons", () => {
  const gap = jointsMate(
    jointSocket({ origin: [0, 0, 0], normal: [1, 0, 0] }),
    jointSocket({ origin: [2, 0, 0], normal: [-1, 0, 0] }),
    { support: 0.5, penetration: 0.5, clearance: 0.5 },
  );
  assert.deepEqual(gap, {
    mates: false,
    reasons: ["joint gap 2.0000 studs exceeds support 0.5"],
  });
  const overlap = jointsMate(
    jointSocket({ origin: [0, 0, 0], normal: [1, 0, 0] }),
    jointSocket({ origin: [-0.3, 0, 0], normal: [-1, 0, 0] }),
    { support: 0.5, penetration: 0.1, clearance: 0.5 },
  );
  assert.deepEqual(overlap, {
    mates: false,
    reasons: ["joint overlap 0.3000 studs exceeds penetration 0.1"],
  });
  const lateral = jointsMate(
    jointSocket({ origin: [0, 0, 0], normal: [1, 0, 0] }),
    jointSocket({ origin: [0, 0, 3], normal: [-1, 0, 0] }),
    { support: 0.5, penetration: 0.5, clearance: 0.5 },
  );
  assert.deepEqual(lateral, {
    mates: false,
    reasons: [
      "joint centers 3.0000 studs apart exceed contact radii 1.0000+1.0000 plus clearance 0.5",
    ],
  });
  const tiltRadians = (10 * Math.PI) / 180;
  const tilt = jointsMate(
    jointSocket({ origin: [0, 0, 0], normal: [1, 0, 0] }),
    jointSocket({ origin: [0, 0, 0], normal: [-Math.cos(tiltRadians), 0, Math.sin(tiltRadians)] }),
    { support: 0.5, penetration: 0.5, clearance: 0.1 },
  );
  assert.equal(tilt.mates, false);
  assert.equal(tilt.reasons.length, 1);
  assert.match(tilt.reasons[0]!, /joint tilt .* beyond clearance 0\.1/);
  const sameDirection = jointsMate(
    jointSocket({ origin: [0, 0, 0], normal: [1, 0, 0] }),
    jointSocket({ origin: [0, 0, 0], normal: [1, 0, 0] }),
    { support: 0.5, penetration: 0.5, clearance: 0.5 },
  );
  assert.equal(sameDirection.mates, false);
  assert.match(sameDirection.reasons.join("; "), /not opposed/);
  assert.throws(
    () =>
      jointsMate(
        jointSocket({ origin: [0, 0, 0], normal: [1, 0, 0] }),
        jointSocket({ origin: [0, 0, 0], normal: [-1, 0, 0] }),
        { support: -1, penetration: 0.1, clearance: 0.1 },
      ),
    /nonnegative support/,
  );
});

function kitMember(
  assetId: string,
  variantName: string,
  faces: ReadonlyArray<{
    origin: readonly [number, number, number];
    normal: readonly [number, number, number];
  }>,
  options: {
    refusal?: string | null;
    boundsMinimum?: readonly [number, number, number];
    boundsMaximum?: readonly [number, number, number];
  } = {},
): {
  assetId: string;
  variantName: string;
  sockets: SocketContract[];
  refusal: string | null;
  boundsMinimumQ32_32: { x: string; y: string; z: string };
  boundsMaximumQ32_32: { x: string; y: string; z: string };
} {
  const minimum = options.boundsMinimum ?? [-1, -1, -1];
  const maximum = options.boundsMaximum ?? [1, 1, 1];
  return {
    assetId,
    variantName,
    sockets: faces.map((face, index) =>
      socketContractSchema.parse({
        ...jointSocket(face),
        socketId: `joint_${variantName}_${String(index + 1).padStart(2, "0")}`,
      }),
    ),
    refusal: options.refusal ?? null,
    boundsMinimumQ32_32: {
      x: quantizeQ32_32(minimum[0]),
      y: quantizeQ32_32(minimum[1]),
      z: quantizeQ32_32(minimum[2]),
    },
    boundsMaximumQ32_32: {
      x: quantizeQ32_32(maximum[0]),
      y: quantizeQ32_32(maximum[1]),
      z: quantizeQ32_32(maximum[2]),
    },
  };
}

test("modular kit verdict admits placeable kits at any pivot", () => {
  const acrossMembers = evaluateModularKit([
    kitMember("assetA", "wall_a", [{ origin: [2, 1, 0], normal: [1, 0, 0] }], {
      boundsMinimum: [-2, 0, -1],
      boundsMaximum: [2, 2, 1],
    }),
    kitMember("assetB", "wall_b", [{ origin: [5, 1, 0], normal: [-1, 0, 0] }], {
      boundsMinimum: [5, 0, -1],
      boundsMaximum: [7, 2, 1],
    }),
  ]);
  assert.deepEqual(acrossMembers, {
    status: "modular",
    reason: "2 members expose 2 joint faces with 1 mating pairs",
    matingPairs: [
      { leftMember: 0, leftSocket: 0, rightMember: 1, rightSocket: 0, rotationStepsY90: 0 },
    ],
  });
  const selfTiling = evaluateModularKit([
    kitMember(
      "assetC",
      "panel_c",
      [
        { origin: [-1, 0, 0], normal: [-1, 0, 0] },
        { origin: [1, 0, 0], normal: [1, 0, 0] },
      ],
      { boundsMinimum: [-1, -1, -1], boundsMaximum: [1, 1, 1] },
    ),
  ]);
  assert.deepEqual(selfTiling, {
    status: "modular",
    reason: "1 members expose 2 joint faces with 1 mating pairs",
    matingPairs: [
      { leftMember: 0, leftSocket: 0, rightMember: 0, rightSocket: 1, rotationStepsY90: 0 },
    ],
  });
  assert.deepEqual(matingFaceSets(acrossMembers, 2), [new Set([0]), new Set([0])]);
  assert.deepEqual(matingFaceSets(selfTiling, 1), [new Set([0, 1])]);
});

test("modular kit verdict places corners through quarter-turns", () => {
  const verdict = evaluateModularKit([
    kitMember("assetA", "wall_a", [{ origin: [2, 1, 0], normal: [1, 0, 0] }], {
      boundsMinimum: [-2, 0, -1],
      boundsMaximum: [2, 2, 1],
    }),
    kitMember("assetB", "wall_b", [{ origin: [0, 1, 2], normal: [0, 0, 1] }], {
      boundsMinimum: [-1, 0, -2],
      boundsMaximum: [1, 2, 2],
    }),
  ]);
  assert.equal(verdict.status, "modular");
  assert.deepEqual(verdict.matingPairs, [
    { leftMember: 0, leftSocket: 0, rightMember: 1, rightSocket: 0, rotationStepsY90: 3 },
  ]);
});

test("modular kit verdict holds refused members at pending", () => {
  const verdict = evaluateModularKit([
    kitMember("assetA", "wall_a", [{ origin: [0, 0, 0], normal: [1, 0, 0] }]),
    {
      ...kitMember("assetB", "wall_b", []),
      refusal: "no_planar_faces",
    },
  ]);
  assert.deepEqual(verdict, {
    status: "pending",
    reason: "member wall_b (assetB) awaits joint measurement: no_planar_faces",
    matingPairs: [],
  });
});

test("modular kit verdict quarantines faceless and unmated kits with reasons", () => {
  const faceless = evaluateModularKit([
    kitMember("assetA", "wall_a", [{ origin: [0, 0, 0], normal: [1, 0, 0] }]),
    kitMember("assetB", "wall_b", []),
  ]);
  assert.deepEqual(faceless, {
    status: "quarantined",
    reason: "member wall_b (assetB) exposes no planar joint faces",
    matingPairs: [],
  });
  const tiltRadians = (7 * Math.PI) / 180;
  const unmated = evaluateModularKit([
    kitMember(
      "assetC",
      "wedge_c",
      [
        { origin: [0, 0, 0], normal: [1, 0, 0] },
        { origin: [5, 0, 0], normal: [Math.cos(tiltRadians), Math.sin(tiltRadians), 0] },
      ],
      { boundsMinimum: [-1, -1, -1], boundsMaximum: [6, 1, 1] },
    ),
  ]);
  assert.equal(unmated.status, "quarantined");
  assert.match(unmated.reason, /no mating pair across 1 members/);
  assert.match(unmated.reason, /all 4 quarter-turns fail/);
  assert.deepEqual(unmated.matingPairs, []);
  assert.throws(() => evaluateModularKit([]), /at least one member/);
});

test("modular kit verdict quarantines kits with unmated members", () => {
  const tiltRadians = (7 * Math.PI) / 180;
  const verdict = evaluateModularKit([
    kitMember("assetA", "wall_a", [{ origin: [2, 1, 0], normal: [1, 0, 0] }], {
      boundsMinimum: [-2, 0, -1],
      boundsMaximum: [2, 2, 1],
    }),
    kitMember("assetB", "wall_b", [{ origin: [5, 1, 0], normal: [-1, 0, 0] }], {
      boundsMinimum: [5, 0, -1],
      boundsMaximum: [7, 2, 1],
    }),
    kitMember(
      "assetC",
      "wedge_c",
      [{ origin: [50, 0, 0], normal: [Math.cos(tiltRadians), Math.sin(tiltRadians), 0] }],
      { boundsMinimum: [49, -1, -1], boundsMaximum: [51, 1, 1] },
    ),
  ]);
  assert.deepEqual(verdict, {
    status: "quarantined",
    reason:
      "3 joint faces measured with 1 mating pairs, but 1 of 3 members combine with nothing: wedge_c (assetC)",
    matingPairs: [],
  });
});

test("family seal fails closed beyond the 128-socket archetype bound", () => {
  const fit = {
    normalQ32_32: { x: quantizeQ32_32(1), y: quantizeQ32_32(0), z: quantizeQ32_32(0) },
    originQ32_32: { x: quantizeQ32_32(0), y: quantizeQ32_32(0), z: quantizeQ32_32(0) },
    boundaryRadiusStuds: 1,
    inlierCount: 2,
    pointCount: 12,
  };
  const declaration = {
    familyName: "guard_test",
    handle: "architecture/guard/stylized_low_poly/guard_test",
    displayName: "Guard Test",
    semanticRole: "architecture",
    styleTokens: ["test"],
    sharedTrimSheetAssetId: "shared_trim_sheet_pending",
    members: [{ assetId: "guardAsset", sourcePath: "pack/guard.glb", variantName: "guard" }],
    status: "declared" as const,
    jointSockets: true,
  };
  const assets = [
    catalogAssetRecordSchema.parse({
      assetId: "guardAsset",
      sourceFileHash: "a".repeat(64),
      canonicalName: "guardAsset",
      boundingBox: { min: { x: "0", y: "0", z: "0" }, max: { x: "1", y: "2", z: "1" } },
      pivotOffsetFromBottomCenter: { x: "0", y: "0", z: "0" },
      triangleCount: 12,
      vertexCount: 8,
      submeshCount: 1,
      materialSlotCount: 1,
      textures: [],
      collisionProxy: { type: "None" },
      topologicalGenus: 0,
      semanticTags: [],
      isManifold: true,
      admissionStatus: "pending",
      merkleLeafHash: "a".repeat(64),
    }),
  ];
  assert.throws(
    () =>
      buildAuthoredAssetFamilyRevision(declaration, assets, {
        jointContacts: { guardAsset: { jointPlaneFits: Array.from({ length: 129 }, () => fit) } },
      }),
    /beyond the 128-socket archetype bound/,
  );
});

test("joint evidence participates in sealed inventory identity", () => {
  const fit = {
    normalQ32_32: { x: quantizeQ32_32(1), y: quantizeQ32_32(0), z: quantizeQ32_32(0) },
    originQ32_32: { x: quantizeQ32_32(0), y: quantizeQ32_32(0), z: quantizeQ32_32(0) },
    boundaryRadiusStuds: 1,
    axisAlignmentDegrees: 0,
    faceAreaStuds2: 4,
    inlierCount: 2,
    pointCount: 12,
  };
  const envelope = (jointPlaneFits: (typeof fit)[]): CatalogAssetEnvelope => ({
    kind: "CatalogAssetEnvelope",
    abi: "basalt-catalog-intelligence@2",
    record: {
      assetId: "jointTestAsset",
      sourceFileHash: "ab".repeat(32),
      canonicalName: "joint-test",
      boundingBox: {
        min: { x: "0", y: "0", z: "0" },
        max: { x: "8589934592", y: "8589934592", z: "8589934592" },
      },
      pivotOffsetFromBottomCenter: { x: "0", y: "0", z: "0" },
      triangleCount: 12,
      vertexCount: 8,
      submeshCount: 1,
      materialSlotCount: 1,
      textures: [],
      collisionProxy: { type: "None" },
      topologicalGenus: 0,
      semanticTags: [],
      isManifold: true,
      admissionStatus: "locally_qualified",
      merkleLeafHash: "cd".repeat(32),
    },
    source: {
      kind: "creator_owned",
      packageId: "jointTest",
      relativePath: "test/joint.glb",
      contentHash: "ef".repeat(32),
      licenseId: "test",
      commercialUsePermitted: true,
      redistributionPermitted: true,
      attribution: "test",
    },
    measurement: {
      status: "measured",
      boundsStuds: [2, 2, 2],
      boundsMinimumQ32_32: { x: "0", y: "0", z: "0" },
      boundsMaximumQ32_32: { x: "8589934592", y: "8589934592", z: "8589934592" },
      pivotOffsetQ32_32: { x: "0", y: "0", z: "0" },
      triangleCount: 12,
      vertexCount: 8,
      submeshCount: 1,
      materialSlotCount: 1,
      texturePixelCount: 1024,
      supportedSurfaceKinds: ["terrain"],
      primaryContact: "bottom",
      bottomContactAreaStuds2: 4,
      supportPlaneFits: [],
      supportPlaneRefusal: "no_patches",
      jointPlaneFits,
      jointPlaneRefusal: null,
      surfaceAreaStuds2: 24,
      texelDensityPixelsPerStud: 8,
      topologicalGenus: 0,
      hasManifoldTopology: true,
      geometryEvidenceStatus: "validated",
      materialAppearanceHashes: [],
      pbrChannels: ["base_color"],
      renderable: true,
      collision: {
        status: "none",
        syntacticGate: false,
        volumetricGate: false,
        complexityGate: false,
        watertight: false,
        convex: false,
        convexComponentCount: 0,
      },
      normalizedPivot: "bottom_center_obb",
      textureEvidence: "embedded",
      textureFacts: [],
    },
  });
  const seal = (jointPlaneFits: (typeof fit)[]) =>
    sealCatalogInventory({
      sourceManifestHashes: ["00".repeat(32)],
      assets: [envelope(jointPlaneFits)],
      familyDeclarations: [],
      families: [],
      familyCards: [],
      diagnostics: {
        unmatchedCollisionCompanions: 0,
        ambiguousCollisionCompanions: 0,
        renderablesWithValidCollisionBindings: 0,
        trimMappingsRejectedByEnergy: 0,
        incompleteCandidates: 0,
        kindFamilyDiagnostics: [],
        modularKitDiagnostics: {
          modularFamilies: 0,
          pendingFamilies: 0,
          quarantinedFamilies: 0,
          quarantined: [],
        },
      },
    });
  const withoutJoints = seal([]);
  const withJoints = seal([fit]);
  assert.notEqual(withJoints.hash, withoutJoints.hash);
  assertCatalogInventoryIdentity(withoutJoints);
  assertCatalogInventoryIdentity(withJoints);
});
