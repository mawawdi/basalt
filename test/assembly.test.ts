import assert from "node:assert/strict";
import test from "node:test";
import { quantizeQ32_32 } from "../packages/basalt-types/src/fixed.js";
import type { ModularKitRequirement } from "../packages/asset-factory/src/index.js";
import { jointsMateFrames, rotateY90Steps } from "../packages/catalog-intelligence/src/index.js";
import { dequantizeQ32_32 } from "../packages/basalt-types/src/fixed.js";
import {
  assembleLotOnKit,
  AssemblyContradictionError,
  lowerAssemblyToInstances,
  type AssemblyLot,
} from "../packages/world-compiler/src/index.js";

function socket(
  socketId: string,
  normal: readonly [number, number, number],
  origin: readonly [number, number, number],
  radius: number,
) {
  const q = (v: number): string => quantizeQ32_32(v);
  return {
    socketId,
    role: "joint",
    polarity: "Neutral" as const,
    localOrigin: { x: q(origin[0]), y: q(origin[1]), z: q(origin[2]) },
    normal: { x: q(normal[0]), y: q(normal[1]), z: q(normal[2]) },
    upVector: { x: q(0), y: q(1), z: q(0) },
    boundaryRadius: q(radius),
    angularStepDegrees: 0,
  };
}

function archetype(
  archetypeId: string,
  name: string,
  variantIndex: number,
  envelope: readonly [number, number, number],
  center: readonly [number, number, number],
  sockets: ReturnType<typeof socket>[],
) {
  return {
    archetypeId,
    name,
    semanticRole: "architecture",
    sourceFamilyId: "family_test_huts",
    sourceVariantIndex: variantIndex,
    boundingEnvelope: envelope,
    boundsCenterStuds: center,
    maxTriangleBudget: 100,
    sockets,
    supportedSurfaceKinds: ["floor"],
  };
}

const hutA = archetype(
  "hutA",
  "hut_a",
  0,
  [6, 4, 6],
  [0, 2, 0],
  [
    socket("joint_hut_a_01", [0, -1, 0], [0, 0, 0], 2),
    socket("joint_hut_a_02", [0, 1, 0], [0, 4, 0], 2),
    socket("joint_hut_a_03", [1, 0, 0], [3, 2, 0], 1.5),
  ],
);
const hutB = archetype(
  "hutB",
  "hut_b",
  1,
  [4, 3, 4],
  [0, 1.5, 0],
  [
    socket("joint_hut_b_01", [0, -1, 0], [0, 0, 0], 1.5),
    socket("joint_hut_b_02", [1, 0, 0], [2, 1.5, 0], 1),
  ],
);
const doorD = archetype(
  "doorD",
  "door_d",
  2,
  [2, 3, 1],
  [0, 1.5, 0],
  [socket("joint_door_d_01", [0, 0, -1], [0, 1.5, -0.5], 0.8)],
);

function testKit(): ModularKitRequirement {
  return {
    kind: "ModularKitRequirement",
    abi: "basalt-modular-kit@1",
    kitId: "kit_test_huts",
    name: "Test huts",
    styleContractHash: "ab".repeat(32),
    studsPerUnit: 1,
    modulePitchStuds: 2,
    archetypes: [hutA, hutB, doorD] as ModularKitRequirement["archetypes"],
    adjacencyRules: [
      {
        sourceArchetypeId: "hutA",
        sourceSocketId: "joint_hut_a_02",
        targetArchetypeId: "hutB",
        targetSocketId: "joint_hut_b_01",
        probabilityWeight: 1,
      },
      {
        sourceArchetypeId: "hutA",
        sourceSocketId: "joint_hut_a_03",
        targetArchetypeId: "doorD",
        targetSocketId: "joint_door_d_01",
        probabilityWeight: 1,
      },
      {
        sourceArchetypeId: "hutB",
        sourceSocketId: "joint_hut_b_02",
        targetArchetypeId: "doorD",
        targetSocketId: "joint_door_d_01",
        probabilityWeight: 1,
      },
      {
        sourceArchetypeId: "hutA",
        sourceSocketId: "joint_hut_a_02",
        targetArchetypeId: "hutA",
        targetSocketId: "joint_hut_a_01",
        probabilityWeight: 1,
      },
    ],
    tolerances: { socketMismatchThreshold: 0.01, maxMeshInterpenetration: 0 },
  };
}

const lot: AssemblyLot = {
  lotId: "lot_test_assembly_00",
  minX: 0,
  minZ: 0,
  maxX: 20,
  maxZ: 20,
  groundHeightStuds: 0,
};

test("assembly seals anchor plus stacked floor golden", () => {
  const recipe = assembleLotOnKit(lot, testKit(), { seed: 1 });
  assert.equal(recipe.id, "recipe_lot_test_assembly_00_kit_test_huts");
  assert.equal(recipe.kitId, "kit_test_huts");
  assert.equal(recipe.lotId, "lot_test_assembly_00");
  assert.deepEqual(
    recipe.socketedComponents.map((component) => [
      component.componentId,
      component.archetypeId,
      component.socketId ?? null,
      component.position,
      component.rotationStepsY90,
    ]),
    [
      ["cmp_00", "hutA", null, { x: 10, y: 0, z: 10 }, 0],
      ["cmp_01", "hutB", "joint_hut_b_01", { x: 10, y: 4, z: 10 }, 3],
    ],
  );
});

test("assembly attaches inserts at open sockets", () => {
  const recipe = assembleLotOnKit(lot, testKit(), { seed: 1, emptyWeight: 0.0001 });
  assert.deepEqual(
    recipe.socketedComponents.map((component) => [
      component.componentId,
      component.archetypeId,
      component.socketId ?? null,
      component.position,
      component.rotationStepsY90,
    ]),
    [
      ["cmp_00", "hutA", null, { x: 10, y: 0, z: 10 }, 0],
      ["cmp_01", "hutB", "joint_hut_b_01", { x: 10, y: 4, z: 10 }, 3],
      ["cmp_02", "doorD", "joint_door_d_01", { x: 13.5, y: 0.5, z: 10 }, 1],
      ["cmp_03", "doorD", "joint_door_d_01", { x: 10, y: 4, z: 12.5 }, 0],
    ],
  );
});

test("assembly absorbs kit declaration order", () => {
  const kit = testKit();
  const ordered = assembleLotOnKit(lot, kit, { seed: 3, emptyWeight: 0.0001 });
  const shuffled = assembleLotOnKit(
    lot,
    {
      ...kit,
      archetypes: [...kit.archetypes].reverse() as ModularKitRequirement["archetypes"],
      adjacencyRules: [...kit.adjacencyRules].reverse(),
    },
    { seed: 3, emptyWeight: 0.0001 },
  );
  assert.deepEqual(shuffled, ordered);
});

test("assembly contradicts when no anchor fits", () => {
  const tiny: AssemblyLot = { ...lot, lotId: "lot_test_tiny_00", maxX: 2, maxZ: 2 };
  assert.throws(
    () => assembleLotOnKit(tiny, testKit(), { seed: 1 }),
    (error: unknown) => {
      assert.ok(error instanceof AssemblyContradictionError);
      assert.match(
        (error as Error).message,
        /Lot lot_test_tiny_00 fits no kit_test_huts anchor.*2\.00x2\.00.*4\.00 studs on its short side/,
      );
      return true;
    },
  );
});

test("assembly with no free upward sockets returns the anchored recipe", () => {
  const base = testKit();
  const hut = {
    ...base.archetypes[0]!,
    sockets: [socket("joint_ground_only", [0, -1, 0], [0, 0, 0], 2)],
  };
  const recipe = assembleLotOnKit(
    lot,
    { ...base, archetypes: [hut], adjacencyRules: [] },
    { seed: 1 },
  );
  assert.equal(recipe.socketedComponents.length, 1);
  assert.equal(recipe.socketedComponents[0]!.archetypeId, hut.archetypeId);
});

test("assembly lowering emits engine instances", () => {
  const recipe = assembleLotOnKit(lot, testKit(), { seed: 1 });
  const instances = lowerAssemblyToInstances(recipe, testKit(), "chunk_0_0");
  assert.equal(instances.length, 2);
  assert.deepEqual(
    instances.map((instance) => [
      instance.id,
      instance.familyId,
      instance.archetypeId,
      instance.chunkId,
      instance.position,
      instance.scale,
    ]),
    [
      [
        "asm_recipe_lot_test_assembly_00_kit_test_huts_cmp_00",
        "family_test_huts",
        "family_test_huts_archetype_0",
        "chunk_0_0",
        { x: 10, y: 0, z: 10 },
        1,
      ],
      [
        "asm_recipe_lot_test_assembly_00_kit_test_huts_cmp_01",
        "family_test_huts",
        "family_test_huts_archetype_1",
        "chunk_0_0",
        { x: 10, y: 4, z: 10 },
        1,
      ],
    ],
  );
  assert.deepEqual(instances[0]!.rotation, [0, 0, 0, 1]);
  assert.equal(instances[1]!.rotation[0], 0);
  assert.equal(instances[1]!.rotation[2], 0);
  assert.ok(Math.abs(instances[1]!.rotation[1] - Math.SQRT1_2) < 1e-12);
  assert.ok(Math.abs(instances[1]!.rotation[3] + Math.SQRT1_2) < 1e-12);
  assert.ok(Math.abs(instances[0]!.footprint.contactRadiusStuds - Math.sqrt(72) / 2) < 1e-12);
  assert.equal(instances[0]!.footprint.restYStuds, 0);
  assert.deepEqual(instances[0]!.footprint.dropsStuds, [0, 0, 0, 0]);
  assert.throws(
    () => lowerAssemblyToInstances(recipe, { ...testKit(), kitId: "kit_other" }, "chunk_0_0"),
    /not kit_other/,
  );
});

test("assembly recipes verify geometrically across seeds", () => {
  const kit = testKit();
  for (const seed of [1, 2, 3, 4, 5]) {
    const recipe = assembleLotOnKit(lot, kit, { seed, emptyWeight: 0.0001 });
    const boxes = recipe.socketedComponents.map((component) => {
      const archetype = kit.archetypes.find(
        (entry) => entry.archetypeId === component.archetypeId,
      )!;
      const [sizeX, sizeY, sizeZ] = archetype.boundingEnvelope;
      const [centerX, centerY, centerZ] = archetype.boundsCenterStuds;
      const corners = [
        { x: centerX - sizeX / 2, y: centerY - sizeY / 2, z: centerZ - sizeZ / 2 },
        { x: centerX + sizeX / 2, y: centerY + sizeY / 2, z: centerZ + sizeZ / 2 },
      ].flatMap((a) =>
        [a.x].flatMap((x) =>
          [centerY - sizeY / 2, centerY + sizeY / 2].flatMap((y) =>
            [centerZ - sizeZ / 2, centerZ + sizeZ / 2].map((z) => ({ x, y, z })),
          ),
        ),
      );
      const world = corners.map((corner) => {
        const rotated = rotateY90Steps(corner, component.rotationStepsY90);
        return {
          x: rotated.x + component.position.x,
          y: rotated.y + component.position.y,
          z: rotated.z + component.position.z,
        };
      });
      return {
        minX: Math.min(...world.map((point) => point.x)),
        maxX: Math.max(...world.map((point) => point.x)),
        minY: Math.min(...world.map((point) => point.y)),
        maxY: Math.max(...world.map((point) => point.y)),
        minZ: Math.min(...world.map((point) => point.z)),
        maxZ: Math.max(...world.map((point) => point.z)),
      };
    });
    boxes.forEach((box, index) => {
      const budget = index === 0 ? 0 : 4;
      assert.ok(box.minX >= lot.minX - budget - 1e-9, `seed ${seed} component ${index} in x`);
      assert.ok(box.maxX <= lot.maxX + budget + 1e-9, `seed ${seed} component ${index} in x`);
      assert.ok(box.minZ >= lot.minZ - budget - 1e-9, `seed ${seed} component ${index} in z`);
      assert.ok(box.maxZ <= lot.maxZ + budget + 1e-9, `seed ${seed} component ${index} in z`);
      assert.ok(box.minY >= lot.groundHeightStuds - 0.5 - 1e-9, `seed ${seed} above grade`);
      for (let other = index + 1; other < boxes.length; other += 1) {
        const candidate = boxes[other]!;
        const disjoint =
          candidate.minX >= box.maxX - 1e-9 ||
          box.minX >= candidate.maxX - 1e-9 ||
          candidate.minY >= box.maxY - 1e-9 ||
          box.minY >= candidate.maxY - 1e-9 ||
          candidate.minZ >= box.maxZ - 1e-9 ||
          box.minZ >= candidate.maxZ - 1e-9;
        assert.ok(disjoint, `seed ${seed} components ${index}/${other} disjoint`);
      }
    });
    recipe.socketedComponents.forEach((component, index) => {
      if (component.socketId === undefined) return;
      const archetype = kit.archetypes.find(
        (entry) => entry.archetypeId === component.archetypeId,
      )!;
      const socket = archetype.sockets.find((entry) => entry.socketId === component.socketId)!;
      const own = {
        normal: {
          x: dequantizeQ32_32(socket.normal.x),
          y: dequantizeQ32_32(socket.normal.y),
          z: dequantizeQ32_32(socket.normal.z),
        },
        origin: {
          x: dequantizeQ32_32(socket.localOrigin.x),
          y: dequantizeQ32_32(socket.localOrigin.y),
          z: dequantizeQ32_32(socket.localOrigin.z),
        },
        radius: dequantizeQ32_32(socket.boundaryRadius),
      };
      const ownWorld = {
        normal: rotateY90Steps(own.normal, component.rotationStepsY90),
        origin: {
          x: rotateY90Steps(own.origin, component.rotationStepsY90).x + component.position.x,
          y: rotateY90Steps(own.origin, component.rotationStepsY90).y + component.position.y,
          z: rotateY90Steps(own.origin, component.rotationStepsY90).z + component.position.z,
        },
        radius: own.radius,
      };
      const mated = recipe.socketedComponents.some((other, otherIndex) => {
        if (otherIndex === index) return false;
        const otherArchetype = kit.archetypes.find(
          (entry) => entry.archetypeId === other.archetypeId,
        )!;
        return otherArchetype.sockets.some((candidate) => {
          const frame = {
            normal: {
              x: dequantizeQ32_32(candidate.normal.x),
              y: dequantizeQ32_32(candidate.normal.y),
              z: dequantizeQ32_32(candidate.normal.z),
            },
            origin: {
              x: dequantizeQ32_32(candidate.localOrigin.x),
              y: dequantizeQ32_32(candidate.localOrigin.y),
              z: dequantizeQ32_32(candidate.localOrigin.z),
            },
            radius: dequantizeQ32_32(candidate.boundaryRadius),
          };
          const world = {
            normal: rotateY90Steps(frame.normal, other.rotationStepsY90),
            origin: {
              x: rotateY90Steps(frame.origin, other.rotationStepsY90).x + other.position.x,
              y: rotateY90Steps(frame.origin, other.rotationStepsY90).y + other.position.y,
              z: rotateY90Steps(frame.origin, other.rotationStepsY90).z + other.position.z,
            },
            radius: frame.radius,
          };
          return jointsMateFrames(ownWorld, world, {
            support: 0.01,
            penetration: 0,
            clearance: 0.01,
          }).mates;
        });
      });
      assert.ok(mated, `seed ${seed} component ${index} mates`);
    });
  }
});
