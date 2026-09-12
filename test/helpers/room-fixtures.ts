import { quantizeQ32_32 } from "../../packages/basalt-types/src/fixed.js";
import {
  sealAssemblyRecipe,
  type AssemblyRecipe,
  type ModularKitRequirement,
} from "../../packages/asset-factory/src/index.js";
import {
  ROOM_PROGRAM_ABI,
  sealRoomProgram,
  type RoomProgram,
} from "../../packages/world-compiler/src/index.js";

/**
 * Shared two-story room fixtures: hut anchor, stacked hut, door insert,
 * plus the living/stair program. Phase 5 export, emission, and bridge
 * tests reuse the same sealed shell the room solver tests prove.
 */
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
  sourceFamilyId: string,
  variantIndex: number,
  envelope: readonly [number, number, number],
  center: readonly [number, number, number],
  sockets: ReturnType<typeof socket>[],
) {
  return {
    archetypeId,
    name: archetypeId.toLowerCase(),
    semanticRole: "architecture",
    sourceFamilyId,
    sourceVariantIndex: variantIndex,
    boundingEnvelope: envelope,
    boundsCenterStuds: center,
    maxTriangleBudget: 100,
    sockets,
    supportedSurfaceKinds: ["floor"],
  };
}

export function testKit(): ModularKitRequirement {
  return {
    kind: "ModularKitRequirement",
    abi: "basalt-modular-kit@1",
    kitId: "kit_test_rooms",
    name: "Test rooms",
    styleContractHash: "ab".repeat(32),
    studsPerUnit: 1,
    modulePitchStuds: 2,
    archetypes: [
      archetype(
        "hutA",
        "family_test_huts",
        0,
        [12, 6, 10],
        [0, 3, 0],
        [
          socket("joint_hut_a_down", [0, -1, 0], [0, 0, 0], 2),
          socket("joint_hut_a_up", [0, 1, 0], [0, 6, 0], 2),
        ],
      ),
      archetype(
        "hutB",
        "family_test_huts",
        1,
        [8, 5, 8],
        [0, 2.5, 0],
        [
          socket("joint_hut_b_down", [0, -1, 0], [0, 0, 0], 1.5),
          socket("joint_hut_b_up", [0, 1, 0], [0, 5, 0], 1.5),
        ],
      ),
      archetype(
        "doorD",
        "family_test_doors",
        0,
        [2, 4, 1],
        [0, 2, 0],
        [socket("joint_door_d_back", [0, 0, -1], [0, 2, -0.5], 0.8)],
      ),
    ] as ModularKitRequirement["archetypes"],
    adjacencyRules: [],
    tolerances: { socketMismatchThreshold: 0.01, maxMeshInterpenetration: 0 },
  };
}

export function testRecipe(): AssemblyRecipe {
  return sealAssemblyRecipe({
    kind: "AssemblyRecipe",
    abi: "basalt-assembly-recipe@1",
    id: "recipe_test_rooms_00",
    styleContractHash: "ab".repeat(32),
    kitId: "kit_test_rooms",
    lotId: "lot_test_rooms_00",
    socketedComponents: [
      {
        componentId: "cmp_00",
        archetypeId: "hutA",
        semanticRole: "architecture",
        position: { x: 0, y: 0, z: 0 },
        rotationStepsY90: 0,
      },
      {
        componentId: "cmp_01",
        archetypeId: "hutB",
        socketId: "joint_hut_b_down",
        semanticRole: "architecture",
        position: { x: 0, y: 6, z: 0 },
        rotationStepsY90: 0,
      },
      {
        componentId: "cmp_02",
        archetypeId: "doorD",
        socketId: "joint_door_d_back",
        semanticRole: "architecture",
        position: { x: 6, y: 0, z: 2 },
        rotationStepsY90: 0,
      },
    ],
  });
}

export function testProgram(): RoomProgram {
  return sealRoomProgram({
    kind: "RoomProgram",
    abi: ROOM_PROGRAM_ABI,
    id: "program_test_rooms_00",
    floors: [
      {
        level: 0,
        rooms: [
          { role: "living", minWidthStuds: 5, minDepthStuds: 4 },
          { role: "stair", minWidthStuds: 3, minDepthStuds: 3 },
        ],
      },
      {
        level: 1,
        rooms: [
          { role: "sleep", minWidthStuds: 4, minDepthStuds: 3 },
          { role: "stair", minWidthStuds: 3, minDepthStuds: 3 },
        ],
      },
    ],
    doorWidthStuds: 2,
    stairMaterialId: "test_stone",
    entrance: { kind: "door_component", familyId: "family_test_doors" },
    stair: { maxRiserStuds: 2, minTreadStuds: 1, widthStuds: 2 },
  });
}
