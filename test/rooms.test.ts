import assert from "node:assert/strict";
import test from "node:test";
import { sealAssemblyRecipe } from "../packages/asset-factory/src/index.js";
import {
  assertRoomGraphIdentity,
  chunkRoomGraphContent,
  createBasaltWorldCompilerPlan,
  compileBasaltWorldFoundation,
  findUnreachableRooms,
  partitionPlate,
  planRooms,
  populateBasaltWorld,
  sealRoomProgram,
  verifyStairRun,
  type RoomGraph,
  type WorldFamilyPopulationPlan,
} from "../packages/world-compiler/src/index.js";
import { productionWorldPlanFixture } from "./helpers/production-world-fixtures.js";
import { groundingEvidenceFixture } from "./helpers/grounding-evidence.js";
import { testKit, testProgram, testRecipe } from "./helpers/room-fixtures.js";

test("room partition bisects the longer axis in program order", () => {
  const rooms = partitionPlate({ minX: -6, minZ: -5, maxX: 6, maxZ: 5 }, [
    { role: "living", minWidthStuds: 5, minDepthStuds: 4 },
    { role: "stair", minWidthStuds: 3, minDepthStuds: 3 },
  ]);
  assert.deepEqual(rooms, [
    { role: "living", minX: -6, minZ: -5, maxX: 0, maxZ: 5 },
    { role: "stair", minX: 0, minZ: -5, maxX: 6, maxZ: 5 },
  ]);
});

test("room partition lays strips spanning the cross axis", () => {
  const rooms = [
    { role: "living", minWidthStuds: 5, minDepthStuds: 4 },
    { role: "stair", minWidthStuds: 3, minDepthStuds: 3 },
  ];
  assert.deepEqual(partitionPlate({ minX: -6, minZ: -5, maxX: 6, maxZ: 5 }, rooms, "strips_x"), [
    { role: "living", minX: -6, minZ: -5, maxX: 0, maxZ: 5 },
    { role: "stair", minX: 0, minZ: -5, maxX: 6, maxZ: 5 },
  ]);
  assert.deepEqual(partitionPlate({ minX: -6, minZ: -5, maxX: 6, maxZ: 5 }, rooms, "strips_z"), [
    { role: "living", minX: -6, minZ: -5, maxX: 6, maxZ: 0 },
    { role: "stair", minX: -6, minZ: 0, maxX: 6, maxZ: 5 },
  ]);
  assert.throws(
    () =>
      partitionPlate({ minX: 0, minZ: 0, maxX: 12, maxZ: 10 }, [
        { role: "hall", minWidthStuds: 13, minDepthStuds: 4 },
      ]),
    /hall.*13\.00.*12\.00/i,
  );
});

test("room partition fails closed when minima exceed the plate", () => {
  assert.throws(
    () =>
      partitionPlate({ minX: 0, minZ: 0, maxX: 12, maxZ: 10 }, [
        { role: "hall", minWidthStuds: 20, minDepthStuds: 20 },
      ]),
    /hall.*20.*12|plate .* hall/i,
  );
});

test("room planning seals the two-story golden graph", () => {
  const graph = planRooms(testRecipe(), testKit(), testProgram(), { regionId: "basaltRegion" });
  assertRoomGraphIdentity(graph);
  assert.equal(graph.id, "roomgraph_recipe_test_rooms_00");
  assert.equal(graph.recipeId, "recipe_test_rooms_00");
  assert.equal(graph.kitId, "kit_test_rooms");
  assert.equal(graph.lotId, "lot_test_rooms_00");
  assert.equal(graph.regionId, "basaltRegion");
  assert.deepEqual(
    graph.floors.map((floor) => ({
      level: floor.level,
      baseYStuds: floor.baseYStuds,
      ceilingYStuds: floor.ceilingYStuds,
      rooms: floor.rooms,
    })),
    [
      {
        level: 0,
        baseYStuds: 0,
        ceilingYStuds: 6,
        rooms: [
          { roomId: "room_00_00", role: "living", minX: -6, minZ: -5, maxX: 0, maxZ: 5 },
          { roomId: "room_00_01", role: "stair", minX: 0, minZ: -5, maxX: 6, maxZ: 5 },
        ],
      },
      {
        level: 1,
        baseYStuds: 6,
        ceilingYStuds: 11,
        rooms: [
          { roomId: "room_01_00", role: "sleep", minX: -4, minZ: -4, maxX: 0, maxZ: 4 },
          { roomId: "room_01_01", role: "stair", minX: 0, minZ: -4, maxX: 4, maxZ: 4 },
        ],
      },
    ],
  );
  assert.deepEqual(graph.portals, [
    {
      portalId: "portal_00_00",
      kind: "interior",
      roomA: "room_00_00",
      roomB: "room_00_01",
      position: { x: 0, y: 0, z: 0 },
      yawStepsY90: 1,
      widthStuds: 2,
    },
    {
      portalId: "portal_00_en",
      kind: "entrance",
      roomA: "room_00_01",
      position: { x: 6, y: 0, z: 2 },
      yawStepsY90: 1,
      widthStuds: 2,
      boundComponentId: "cmp_02",
    },
    {
      portalId: "portal_01_00",
      kind: "interior",
      roomA: "room_01_00",
      roomB: "room_01_01",
      position: { x: 0, y: 6, z: 0 },
      yawStepsY90: 1,
      widthStuds: 2,
    },
  ]);
  assert.deepEqual(graph.stairs, [
    {
      stairId: "stair_00_01",
      fromLevel: 0,
      toLevel: 1,
      fromRoomId: "room_00_01",
      toRoomId: "room_01_01",
      materialId: "test_stone",
      basePosition: { x: 2, y: 0, z: -4 },
      yawStepsY90: 0,
      steps: 3,
      riseStuds: 6,
      runLengthStuds: 8,
      riserStuds: 2,
      treadStuds: 8 / 3,
      widthStuds: 2,
      slopeRiseOverRun: 0.75,
    },
  ]);
  assert.equal(graph.entranceRoomId, "room_00_01");
  assert.deepEqual(findUnreachableRooms(graph), []);
  const again = planRooms(testRecipe(), testKit(), testProgram(), { regionId: "basaltRegion" });
  assert.deepEqual(again, graph);
});

test("room content chunks stairs by run center and portals by pose", () => {
  const graph = planRooms(testRecipe(), testKit(), testProgram(), { regionId: "basaltRegion" });
  const content = chunkRoomGraphContent([graph], 128);
  assert.deepEqual(
    content.stairs.map((entry) => ({
      id: entry.id,
      chunkId: entry.chunkId,
      bounds: entry.bounds,
    })),
    [
      {
        id: "roomgraph_recipe_test_rooms_00_stair_00_01",
        chunkId: "chunk_0_0",
        bounds: {
          minimum: { x: 1, y: 0, z: -4 },
          maximum: { x: 3, y: 6, z: 4 },
        },
      },
    ],
  );
  assert.deepEqual(
    content.portals.map((entry) => ({ id: entry.id, chunkId: entry.chunkId })),
    [
      { id: "roomgraph_recipe_test_rooms_00_portal_00_00", chunkId: "chunk_0_0" },
      { id: "roomgraph_recipe_test_rooms_00_portal_00_en", chunkId: "chunk_0_0" },
      { id: "roomgraph_recipe_test_rooms_00_portal_01_00", chunkId: "chunk_0_0" },
    ],
  );
  const split = chunkRoomGraphContent([graph], 4);
  assert.deepEqual(
    split.portals.map((entry) => entry.chunkId),
    ["chunk_0_0", "chunk_1_0", "chunk_0_0"],
  );
  assert.throws(() => chunkRoomGraphContent([graph], 0), /chunk size must be positive/i);
});

test("room planning honors per-floor strip layouts", () => {
  const { hash: _sealed, ...base } = testProgram();
  const program = sealRoomProgram({
    ...base,
    id: "program_test_rooms_04",
    floors: [
      { level: 0, layout: "strips_z", rooms: base.floors[0]!.rooms },
      { level: 1, layout: "strips_z", rooms: base.floors[1]!.rooms },
    ],
  });
  const graph = planRooms(testRecipe(), testKit(), program, { regionId: "basaltRegion" });
  assert.deepEqual(graph.floors[0]!.rooms, [
    { roomId: "room_00_00", role: "living", minX: -6, minZ: -5, maxX: 6, maxZ: 0 },
    { roomId: "room_00_01", role: "stair", minX: -6, minZ: 0, maxX: 6, maxZ: 5 },
  ]);
  assert.deepEqual(
    graph.portals.find((portal) => portal.portalId === "portal_00_00"),
    {
      portalId: "portal_00_00",
      kind: "interior",
      roomA: "room_00_00",
      roomB: "room_00_01",
      position: { x: 0, y: 0, z: 0 },
      yawStepsY90: 0,
      widthStuds: 2,
    },
  );
  assert.equal(graph.entranceRoomId, "room_00_01");
  assert.deepEqual(graph.stairs, [
    {
      stairId: "stair_00_01",
      fromLevel: 0,
      toLevel: 1,
      fromRoomId: "room_00_01",
      toRoomId: "room_01_01",
      materialId: "test_stone",
      basePosition: { x: -4, y: 0, z: 2 },
      yawStepsY90: 1,
      steps: 3,
      riseStuds: 6,
      runLengthStuds: 8,
      riserStuds: 2,
      treadStuds: 8 / 3,
      widthStuds: 2,
      slopeRiseOverRun: 0.75,
    },
  ]);
});

test("room planning skips unroomed plates without stairs", () => {
  const { hash: _sealed, ...base } = testProgram();
  const program = sealRoomProgram({
    ...base,
    id: "program_test_rooms_05",
    floors: [base.floors[0]!],
    stair: null,
  });
  const graph = planRooms(testRecipe(), testKit(), program, { regionId: "basaltRegion" });
  assert.equal(graph.floors.length, 1);
  assert.deepEqual(graph.stairs, []);
  assert.equal(graph.entranceRoomId, "room_00_01");
  assert.deepEqual(findUnreachableRooms(graph), []);
});

test("room planning contradicts across unroomed levels", () => {
  const { hash: _recipeSealed, ...recipeBase } = testRecipe();
  const recipe = sealAssemblyRecipe({
    ...recipeBase,
    id: "recipe_test_rooms_03",
    socketedComponents: [
      ...recipeBase.socketedComponents,
      {
        componentId: "cmp_03",
        archetypeId: "hutB",
        socketId: "joint_hut_b_down",
        semanticRole: "architecture",
        position: { x: 0, y: 11, z: 0 },
        rotationStepsY90: 0,
      },
    ],
  });
  const { hash: _programSealed, ...programBase } = testProgram();
  const program = sealRoomProgram({
    ...programBase,
    id: "program_test_rooms_06",
    floors: [
      programBase.floors[0]!,
      {
        level: 2,
        layout: "bisect" as const,
        rooms: [{ role: "loft", minWidthStuds: 2, minDepthStuds: 2 }],
      },
    ],
  });
  assert.throws(
    () => planRooms(recipe, testKit(), program, { regionId: "basaltRegion" }),
    /level 1 unroomed/,
  );
  const noGround = sealRoomProgram({
    ...programBase,
    id: "program_test_rooms_07",
    floors: [programBase.floors[1]!],
    stair: null,
  });
  assert.throws(
    () => planRooms(testRecipe(), testKit(), noGround, { regionId: "basaltRegion" }),
    /no ground-floor rooms/,
  );
});

test("stair runs verify slope, riser, tread, and width bounds", () => {
  assert.deepEqual(
    verifyStairRun({
      riseStuds: 6,
      runLengthStuds: 8,
      overlapWidthStuds: 4,
      stepModule: { maxRiserStuds: 2, minTreadStuds: 1, widthStuds: 2 },
    }),
    { steps: 3, riserStuds: 2, treadStuds: 8 / 3, slopeRiseOverRun: 0.75 },
  );
  assert.throws(
    () =>
      verifyStairRun({
        riseStuds: 6,
        runLengthStuds: 4,
        overlapWidthStuds: 4,
        stepModule: { maxRiserStuds: 2, minTreadStuds: 1, widthStuds: 2 },
      }),
    /slope .*1\.5.*1\b/i,
  );
  assert.throws(
    () =>
      verifyStairRun({
        riseStuds: 6,
        runLengthStuds: 8,
        overlapWidthStuds: 4,
        stepModule: { maxRiserStuds: 2, minTreadStuds: 3, widthStuds: 2 },
      }),
    /tread/i,
  );
  assert.throws(
    () =>
      verifyStairRun({
        riseStuds: 6,
        runLengthStuds: 8,
        overlapWidthStuds: 1,
        stepModule: { maxRiserStuds: 2, minTreadStuds: 1, widthStuds: 2 },
      }),
    /width/i,
  );
});

test("room connectivity reports rooms cut off from the entrance", () => {
  const graph = planRooms(testRecipe(), testKit(), testProgram(), { regionId: "basaltRegion" });
  const severed: RoomGraph = {
    ...graph,
    portals: graph.portals.filter((portal) => portal.portalId !== "portal_01_00"),
    stairs: [],
  };
  assert.deepEqual(findUnreachableRooms(severed), ["room_01_00", "room_01_01"]);
});

test("room planning contradicts when the entrance family is absent", () => {
  const { hash: _sealed, ...base } = testProgram();
  const program = sealRoomProgram({
    ...base,
    id: "program_test_rooms_01",
    entrance: { kind: "door_component", familyId: "family_test_missing" },
  });
  assert.throws(
    () => planRooms(testRecipe(), testKit(), program, { regionId: "basaltRegion" }),
    /family_test_missing/,
  );
});

test("room planning contradicts when stair rooms do not overlap", () => {
  const { hash: _sealed, ...base } = testProgram();
  const program = sealRoomProgram({
    ...base,
    id: "program_test_rooms_02",
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
          { role: "stair", minWidthStuds: 3, minDepthStuds: 3 },
          { role: "sleep", minWidthStuds: 4, minDepthStuds: 3 },
        ],
      },
    ],
  });
  assert.throws(
    () => planRooms(testRecipe(), testKit(), program, { regionId: "basaltRegion" }),
    /stair.*overlap|overlap.*stair/i,
  );
});

test("room planning contradicts on disjoint floor plates", () => {
  const { hash: _sealed, ...base } = testRecipe();
  const recipe = sealAssemblyRecipe({
    ...base,
    id: "recipe_test_rooms_01",
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
        archetypeId: "hutA",
        semanticRole: "architecture",
        position: { x: 30, y: 0, z: 0 },
        rotationStepsY90: 0,
      },
    ],
  });
  const { hash: _programSealed, ...programBase } = testProgram();
  const program = sealRoomProgram({
    ...programBase,
    id: "program_test_rooms_03",
    floors: [programBase.floors[0]!],
    stair: null,
  });
  assert.throws(
    () => planRooms(recipe, testKit(), program, { regionId: "basaltRegion" }),
    /rectilinear|disjoint|single rect/i,
  );
});

test("room planning snaps ground-contact sills to the voxel grid", () => {
  const { hash: _sealed, ...base } = testRecipe();
  const recipe = sealAssemblyRecipe({
    ...base,
    id: "recipe_test_rooms_02",
    socketedComponents: testRecipe().socketedComponents.map((component) => ({
      ...component,
      position: { ...component.position, y: component.position.y + 1 },
    })),
  });
  const graph = planRooms(recipe, testKit(), testProgram(), { regionId: "basaltRegion" });
  assert.equal(graph.floors[0]!.baseYStuds, 1);
  assert.equal(graph.floors[1]!.baseYStuds, 7);
  const entrance = graph.portals.find((portal) => portal.kind === "entrance")!;
  assert.equal(entrance.position.y, 0);
  const groundInterior = graph.portals.find((portal) => portal.portalId === "portal_00_00")!;
  assert.equal(groundInterior.position.y, 0);
  const upperInterior = graph.portals.find((portal) => portal.portalId === "portal_01_00")!;
  assert.equal(upperInterior.position.y, 7);
  assert.equal(graph.stairs[0]!.basePosition.y, 0);
});

function clutterPlan(): WorldFamilyPopulationPlan {
  return {
    familyId: "basaltClutter",
    regionIds: ["basaltRegion"],
    surfaceKinds: ["floor"],
    distribution: "wall_anchored",
    minimumCount: 2,
    maximumCount: 4,
    density: { minimum: 0.1, target: 0.35, maximum: 0.6 },
    variationSeed: 11,
    excludedRouteIds: [],
    excludedRegionIds: [],
  };
}

test("wall-anchored clutter hugs room walls clear of portals and stairs", () => {
  const foundation = compileBasaltWorldFoundation(
    productionWorldPlanFixture({
      sceneId: "basaltWorld",
      regionId: "basaltRegion",
      surfaceId: "basaltTerrain",
      routeId: "basaltRoute",
      anchorId: "basaltAnchor",
      cameraId: "basaltCamera",
      materialId: "basaltMaterial",
      name: "A layered world compiler fixture",
    }),
  );
  const graph = planRooms(testRecipe(), testKit(), testProgram(), { regionId: "basaltRegion" });
  const plan = createBasaltWorldCompilerPlan({
    foundation,
    styleContractHash: "cd".repeat(32),
    familyPlans: [clutterPlan()],
  });
  const options = {
    groundingEvidence: groundingEvidenceFixture("basaltClutter", 1),
    interiorRooms: [graph],
  };
  const first = populateBasaltWorld(foundation, plan, options);
  const second = populateBasaltWorld(foundation, plan, options);
  assert.deepEqual(second, first);
  const instances = first.chunks.flatMap((chunk) => chunk.instances);
  assert.equal(instances.length, 2);
  const rooms = graph.floors.flatMap((floor) =>
    floor.rooms.map((room) => ({ ...room, level: floor.level, floorY: floor.baseYStuds })),
  );
  const occupied = new Set<string>();
  for (const instance of instances) {
    assert.ok(instance.id.startsWith("instance_"));
    assert.equal(instance.familyId, "basaltClutter");
    const room = rooms.find(
      (entry) =>
        instance.position.x >= entry.minX &&
        instance.position.x <= entry.maxX &&
        instance.position.z >= entry.minZ &&
        instance.position.z <= entry.maxZ &&
        instance.position.y === entry.floorY,
    );
    assert.ok(room, "clutter instance sits inside exactly one room");
    occupied.add(room!.roomId);
    const inset = 0.5 * instance.scale + 0.5;
    const distances = [
      { wall: "minX", distance: instance.position.x - room!.minX, inward: [1, 0] as const },
      { wall: "maxX", distance: room!.maxX - instance.position.x, inward: [-1, 0] as const },
      { wall: "minZ", distance: instance.position.z - room!.minZ, inward: [0, 1] as const },
      { wall: "maxZ", distance: room!.maxZ - instance.position.z, inward: [0, -1] as const },
    ];
    const nearest = Math.min(...distances.map((entry) => entry.distance));
    assert.ok(Math.abs(nearest - inset) < 1e-9, "clutter rests at wall inset plus clearance");
    const facings = distances
      .filter((entry) => Math.abs(entry.distance - nearest) < 1e-9)
      .map((entry) => entry.inward);
    const yawFor = (inward: readonly [number, number]): number => {
      if (inward[0] === 0 && inward[1] === 1) return 0;
      if (inward[0] === 0 && inward[1] === -1) return Math.PI;
      if (inward[0] === 1) return Math.PI / 2;
      return -Math.PI / 2;
    };
    const matchesFacing = facings.some((inward) => {
      const yaw = yawFor(inward);
      const expected = [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)];
      return (
        Math.abs(instance.rotation[0]! - expected[0]!) < 1e-9 &&
        Math.abs(instance.rotation[1]! - expected[1]!) < 1e-9 &&
        Math.abs(instance.rotation[2]! - expected[2]!) < 1e-9 &&
        Math.abs(instance.rotation[3]! - expected[3]!) < 1e-9
      );
    });
    assert.ok(matchesFacing, "clutter faces into the room");
    assert.equal(instance.position.y, room!.floorY);
    assert.equal(instance.footprint.restYStuds, room!.floorY);
    for (const floor of graph.floors) {
      if (floor.level !== room!.level) continue;
      for (const portal of graph.portals) {
        const onLevel = floor.rooms.some(
          (entry) =>
            entry.roomId === portal.roomA ||
            (portal.kind === "interior" && entry.roomId === portal.roomB),
        );
        if (!onLevel) continue;
        const gap = Math.hypot(
          instance.position.x - portal.position.x,
          instance.position.z - portal.position.z,
        );
        assert.ok(
          gap + 1e-9 >= portal.widthStuds / 2 + 2,
          `clutter keeps portal keepout at ${portal.portalId}`,
        );
      }
    }
    for (const stair of graph.stairs) {
      if (stair.fromLevel !== room!.level && stair.toLevel !== room!.level) continue;
      const alongZ = stair.yawStepsY90 % 2 === 0;
      const run = alongZ
        ? {
            minX: stair.basePosition.x - stair.widthStuds / 2,
            maxX: stair.basePosition.x + stair.widthStuds / 2,
            minZ: stair.basePosition.z,
            maxZ: stair.basePosition.z + stair.runLengthStuds,
          }
        : {
            minX: stair.basePosition.x,
            maxX: stair.basePosition.x + stair.runLengthStuds,
            minZ: stair.basePosition.z - stair.widthStuds / 2,
            maxZ: stair.basePosition.z + stair.widthStuds / 2,
          };
      const dx = Math.max(run.minX - instance.position.x, 0, instance.position.x - run.maxX);
      const dz = Math.max(run.minZ - instance.position.z, 0, instance.position.z - run.maxZ);
      assert.ok(
        Math.hypot(dx, dz) + 1e-9 >= instance.footprint.contactRadiusStuds,
        `clutter keeps clear of ${stair.stairId}`,
      );
    }
  }
  assert.deepEqual([...occupied].sort(), ["room_00_00", "room_00_01"]);
});
