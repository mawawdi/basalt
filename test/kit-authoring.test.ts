import assert from "node:assert/strict";
import test from "node:test";
import { quantizeQ32_32 } from "../packages/basalt-types/src/fixed.js";
import {
  assertAssemblyRecipeIdentity,
  buildKitRequirement,
  sealAssemblyRecipe,
  type KitMemberEvidence,
} from "../packages/asset-factory/src/index.js";

function fit(
  normal: readonly [number, number, number],
  origin: readonly [number, number, number],
  radius = 1,
): KitMemberEvidence["jointPlaneFits"][number] {
  return {
    normalQ32_32: {
      x: quantizeQ32_32(normal[0]),
      y: quantizeQ32_32(normal[1]),
      z: quantizeQ32_32(normal[2]),
    },
    originQ32_32: {
      x: quantizeQ32_32(origin[0]),
      y: quantizeQ32_32(origin[1]),
      z: quantizeQ32_32(origin[2]),
    },
    boundaryRadiusStuds: radius,
    inlierCount: 2,
    pointCount: 12,
  };
}

function member(
  assetId: string,
  variantName: string,
  fits: KitMemberEvidence["jointPlaneFits"],
  bounds: {
    minimum: readonly [number, number, number];
    maximum: readonly [number, number, number];
  },
): KitMemberEvidence {
  return {
    assetId,
    variantName,
    semanticRole: "architecture",
    sourceFamilyId: "family_test_walls",
    sourceVariantIndex: assetId === "wallA" ? 0 : 1,
    boundsStuds: [
      bounds.maximum[0] - bounds.minimum[0],
      bounds.maximum[1] - bounds.minimum[1],
      bounds.maximum[2] - bounds.minimum[2],
    ],
    boundsMinimumQ32_32: {
      x: quantizeQ32_32(bounds.minimum[0]),
      y: quantizeQ32_32(bounds.minimum[1]),
      z: quantizeQ32_32(bounds.minimum[2]),
    },
    boundsMaximumQ32_32: {
      x: quantizeQ32_32(bounds.maximum[0]),
      y: quantizeQ32_32(bounds.maximum[1]),
      z: quantizeQ32_32(bounds.maximum[2]),
    },
    triangleCount: 12,
    supportedSurfaceKinds: ["floor", "terrain"],
    jointPlaneFits: fits,
    jointPlaneRefusal: null,
  };
}

const wallA = member("wallA", "wall_a", [fit([1, 0, 0], [2, 1, 0])], {
  minimum: [-2, 0, -1],
  maximum: [2, 2, 1],
});
const wallB = member("wallB", "wall_b", [fit([-1, 0, 0], [5, 1, 0])], {
  minimum: [5, 0, -1],
  maximum: [7, 2, 1],
});

test("kit authoring seals measured archetypes and adjacency", () => {
  const requirement = buildKitRequirement({
    kitId: "kit_test_walls",
    name: "Test walls",
    styleContractHash: "ab".repeat(32),
    members: [wallA, wallB],
  });
  assert.equal(requirement.kind, "ModularKitRequirement");
  assert.equal(requirement.modulePitchStuds, 2);
  assert.deepEqual(requirement.tolerances, {
    socketMismatchThreshold: 0.01,
    maxMeshInterpenetration: 0,
  });
  assert.deepEqual(
    requirement.archetypes.map((archetype) => archetype.archetypeId),
    ["wallA", "wallB"],
  );
  assert.deepEqual(requirement.archetypes[0], {
    archetypeId: "wallA",
    name: "wall_a",
    semanticRole: "architecture",
    sourceFamilyId: "family_test_walls",
    sourceVariantIndex: 0,
    boundingEnvelope: [4, 2, 2],
    boundsCenterStuds: [0, 1, 0],
    maxTriangleBudget: 12,
    sockets: [
      {
        socketId: "joint_wall_a_01",
        role: "joint",
        polarity: "Neutral",
        localOrigin: { x: "8589934592", y: "4294967296", z: "0" },
        normal: { x: "4294967296", y: "0", z: "0" },
        upVector: { x: "0", y: "4294967296", z: "0" },
        boundaryRadius: "4294967296",
        angularStepDegrees: 0,
      },
    ],
    supportedSurfaceKinds: ["floor", "terrain"],
    exposedSurfaces: [],
  });
  assert.deepEqual(requirement.adjacencyRules, [
    {
      sourceArchetypeId: "wallA",
      sourceSocketId: "joint_wall_a_01",
      targetArchetypeId: "wallB",
      targetSocketId: "joint_wall_b_01",
      probabilityWeight: 1,
    },
  ]);
});

test("kit authoring absorbs declaration order", () => {
  const ordered = buildKitRequirement({
    kitId: "kit_test_walls",
    name: "Test walls",
    styleContractHash: "ab".repeat(32),
    members: [wallA, wallB],
  });
  const reversed = buildKitRequirement({
    kitId: "kit_test_walls",
    name: "Test walls",
    styleContractHash: "ab".repeat(32),
    members: [wallB, wallA],
  });
  assert.deepEqual(reversed, ordered);
});

test("kit sockets keep stable face indices across the mating subset", () => {
  const tilt = (7 * Math.PI) / 180;
  const multi = member(
    "wallC",
    "wall_c",
    [
      fit([1, 0, 0], [2, 1, 0]),
      fit([Math.cos(tilt), Math.sin(tilt), 0], [5, 1, 0]),
      fit([1, 0, 0], [2, 1, 0]),
    ],
    { minimum: [-2, 0, -1], maximum: [2, 2, 1] },
  );
  const requirement = buildKitRequirement({
    kitId: "kit_test_subset",
    name: "Test subset",
    styleContractHash: "ab".repeat(32),
    members: [multi, wallB],
  });
  const archetype = requirement.archetypes.find((entry) => entry.archetypeId === "wallC")!;
  assert.deepEqual(
    archetype.sockets.map((socket) => socket.socketId),
    ["joint_wall_c_01", "joint_wall_c_03"],
  );
});

test("kit authoring honors authored rule weights and refs", () => {
  const requirement = buildKitRequirement({
    kitId: "kit_test_walls",
    name: "Test walls",
    styleContractHash: "ab".repeat(32),
    members: [wallA, wallB],
    modulePitchStuds: 4,
    authoredRules: [
      {
        sourceArchetypeId: "wallA",
        sourceSocketId: "joint_wall_a_01",
        targetArchetypeId: "wallB",
        targetSocketId: "joint_wall_b_01",
        probabilityWeight: 3,
      },
    ],
  });
  assert.equal(requirement.modulePitchStuds, 4);
  assert.deepEqual(requirement.adjacencyRules, [
    {
      sourceArchetypeId: "wallA",
      sourceSocketId: "joint_wall_a_01",
      targetArchetypeId: "wallB",
      targetSocketId: "joint_wall_b_01",
      probabilityWeight: 3,
    },
  ]);
  assert.throws(
    () =>
      buildKitRequirement({
        kitId: "kit_test_walls",
        name: "Test walls",
        styleContractHash: "ab".repeat(32),
        members: [wallA, wallB],
        authoredRules: [
          {
            sourceArchetypeId: "wallA",
            sourceSocketId: "joint_wall_a_99",
            targetArchetypeId: "wallB",
            targetSocketId: "joint_wall_b_01",
          },
        ],
      }),
    /unknown source socket joint_wall_a_99/,
  );
});

test("kit authoring fails closed on incoherent and degenerate kits", () => {
  const tilt = (7 * Math.PI) / 180;
  const wedge = member(
    "wedgeC",
    "wedge_c",
    [fit([Math.cos(tilt), Math.sin(tilt), 0], [50, 0, 0])],
    {
      minimum: [49, -1, -1],
      maximum: [51, 1, 1],
    },
  );
  assert.throws(
    () =>
      buildKitRequirement({
        kitId: "kit_test_wedge",
        name: "Test wedge",
        styleContractHash: "ab".repeat(32),
        members: [wallA, wallB, wedge],
      }),
    /kit_test_wedge is not authorable.*combine with nothing: wedge_c \(wedgeC\)/,
  );
  assert.throws(
    () =>
      buildKitRequirement({
        kitId: "kit_test_empty",
        name: "Test empty",
        styleContractHash: "ab".repeat(32),
        members: [],
      }),
    /declares no members/,
  );
  assert.throws(
    () =>
      buildKitRequirement({
        kitId: "kit_test_dup",
        name: "Test dup",
        styleContractHash: "ab".repeat(32),
        members: [wallA, wallA],
      }),
    /declares wallA twice/,
  );
  assert.throws(
    () =>
      buildKitRequirement({
        kitId: "kit_test_big",
        name: "Test big",
        styleContractHash: "ab".repeat(32),
        members: [{ ...wallA }, { ...wallB, triangleCount: 100_000 }],
      }),
    /beyond the 65536 archetype budget/,
  );
});

test("assembly recipes seal placed components with grid transforms", () => {
  const recipe = sealAssemblyRecipe({
    kind: "AssemblyRecipe",
    abi: "basalt-assembly-recipe@1",
    id: "recipe_test_lot",
    styleContractHash: "ab".repeat(32),
    kitId: "kit_test_walls",
    lotId: "lot_test_00",
    socketedComponents: [
      {
        componentId: "cmp_b",
        archetypeId: "wallB",
        socketId: "joint_wall_b_01",
        semanticRole: "architecture",
        position: { x: 4, y: 0, z: 0 },
        rotationStepsY90: 2,
      },
      {
        componentId: "cmp_a",
        archetypeId: "wallA",
        semanticRole: "architecture",
        position: { x: 0, y: 0, z: 0 },
        rotationStepsY90: 0,
      },
    ],
  });
  assertAssemblyRecipeIdentity(recipe);
  assert.equal(recipe.shell, undefined);
  assert.deepEqual(
    recipe.socketedComponents.map((component) => component.componentId),
    ["cmp_a", "cmp_b"],
  );
  assert.equal(recipe.socketedComponents[0]!.socketId, undefined);
  assert.deepEqual(recipe.socketedComponents[1]!.position, { x: 4, y: 0, z: 0 });
});
