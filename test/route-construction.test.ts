import assert from "node:assert/strict";
import test from "node:test";
import { contentHash } from "@basalt/contracts";
import {
  affectedCompilationTaskClosure,
  compileBasaltWorld,
  compileBasaltWorldIncremental,
  compilationTaskId,
  sampleBaseTerrainFieldElevation,
  sampleTerrainFieldElevation,
  sealCompiledWorldFoundation,
} from "@basalt/world-compiler";
import {
  compileWorldPlan,
  sealSpatialWorldPlan,
  type SpatialWorldPlan,
  type WorldRoute,
} from "@basalt/world-planning";
import { loadSemanticRegistry } from "./helpers/semantic-registry.js";
import { worldFixture } from "./helpers/world-fixture.js";
import { routeCorridorFixture } from "./helpers/route-corridor-fixture.js";

const routeStyleHash = contentHash("route-corridor-style");

test("the route-corridor integration fixture seals every treatment deterministically", async () => {
  const module = await loadSemanticRegistry();
  const fixture = await routeCorridorFixture(module);
  const first = compileBasaltWorld(fixture.compileInput);
  const second = compileBasaltWorld(fixture.compileInput);
  assert.equal(first.status, "eligible");
  assert.equal(first.worldBuildHash, second.worldBuildHash);
  assert.deepEqual(first.foundation.routeConstructions.map((route) => route.treatmentKind).sort(), [
    "cut_fill",
    "elevated",
    "follow_surface",
  ]);
  assert.ok(first.foundation.routeConstructions.some((route) => route.bends.length > 0));
  assert.ok(first.foundation.routeConstructions.some((route) => route.supports.length > 0));
  assert.equal(first.foundation.routeJunctions.length, 1);
  const field = first.foundation.terrainFields[0]!;
  const baseField = first.foundation.baseTerrainFields[0]!;
  for (const route of first.foundation.routeConstructions) {
    if (route.terrainTreatment.kind !== "grade") continue;
    for (const segment of route.travelSegments)
      for (let longitudinal = 0; longitudinal <= 4; longitudinal += 1)
        for (let lateral = 0; lateral <= 4; lateral += 1) {
          const start = interpolateVector(
            segment.vertices[0]!.positionMeters,
            segment.vertices[1]!.positionMeters,
            lateral / 4,
          );
          const end = interpolateVector(
            segment.vertices[2]!.positionMeters,
            segment.vertices[3]!.positionMeters,
            lateral / 4,
          );
          const surface = interpolateVector(start, end, longitudinal / 4);
          const terrain = sampleTerrainFieldElevation(
            field,
            baseField,
            first.foundation.routeConstructions,
            first.foundation.routeJunctions,
            surface.x,
            surface.z,
          );
          const clearance = surface.y - terrain;
          const exposedBodyGap = Math.max(0, clearance - route.thicknessMeters);
          assert.ok(
            clearance >= route.terrainTreatment.surfaceRevealMeters - 1e-8 &&
              exposedBodyGap <= route.terrainTreatment.groundingToleranceMeters + 1e-8,
            `${route.routeId} has uncoordinated terrain contact: top clearance ${clearance.toFixed(9)}m, body gap ${exposedBodyGap.toFixed(9)}m`,
          );
        }
  }
  const junction = first.foundation.routeJunctions[0]!;
  assert.equal(junction.terrainTreatment.kind, "grade");
  for (let index = 0; index < 16; index += 1) {
    const angle = (Math.PI * 2 * index) / 16;
    const x = junction.centerTopMeters.x + Math.cos(angle) * junction.radiusMeters;
    const z = junction.centerTopMeters.z + Math.sin(angle) * junction.radiusMeters;
    const terrain = sampleTerrainFieldElevation(
      field,
      baseField,
      first.foundation.routeConstructions,
      first.foundation.routeJunctions,
      x,
      z,
    );
    const clearance = junction.centerTopMeters.y - terrain;
    const exposedBodyGap = Math.max(0, clearance - junction.thicknessMeters);
    assert.ok(
      clearance >= junction.terrainTreatment.surfaceRevealMeters - 1e-8 &&
        exposedBodyGap <= junction.terrainTreatment.groundingToleranceMeters + 1e-8,
    );
  }
});

test("grounded routes jointly construct their profile, terrain bed, and corridor masks", async () => {
  const base = await basePlan();
  const route = groundedRoute({
    routeId: "HillsideTrail",
    alignmentMeters: [
      { x: 3, z: 10 },
      { x: 10.08, z: 10 },
      { x: 17, z: 12 },
    ],
  });
  const plan = reseal(base, {
    routes: [route],
    terrainPlans: base.terrainPlans.map((terrain) => ({
      ...terrain,
      resolution: { columns: 21, rows: 21 },
      operations: [
        { kind: "raise" as const, center: { x: 10, z: 10 }, radiusMeters: 8, deltaMeters: 3 },
      ],
    })),
  });
  const first = sealCompiledWorldFoundation(compileWorldPlan(plan));
  const second = sealCompiledWorldFoundation(compileWorldPlan(plan));
  assert.equal(first.foundationHash, second.foundationHash);
  assert.equal(first.status, "eligible");
  const construction = first.routeConstructions[0]!;
  const field = first.terrainFields[0]!;
  const baseField = first.baseTerrainFields[0]!;
  assert.equal(construction.treatmentKind, "follow_surface");
  assert.equal(construction.bends.length, 1);
  assert.ok(field.routeConstructionHashes.includes(construction.hash));
  assert.equal(construction.materialMask?.terrainMaterialId, "Ground");
  assert.equal(construction.vegetationMask.halfWidthMeters, 1.5);
  for (const segment of construction.travelSegments)
    for (let longitudinal = 0; longitudinal <= 4; longitudinal += 1)
      for (let lateral = 0; lateral <= 4; lateral += 1) {
        const start = interpolateVector(
          segment.vertices[0]!.positionMeters,
          segment.vertices[1]!.positionMeters,
          lateral / 4,
        );
        const end = interpolateVector(
          segment.vertices[2]!.positionMeters,
          segment.vertices[3]!.positionMeters,
          lateral / 4,
        );
        const surface = interpolateVector(start, end, longitudinal / 4);
        const terrain = sampleTerrainFieldElevation(
          field,
          baseField,
          first.routeConstructions,
          first.routeJunctions,
          surface.x,
          surface.z,
        );
        const clearance = surface.y - terrain;
        const exposedBodyGap = Math.max(0, clearance - construction.thicknessMeters);
        assert.ok(
          clearance >= 0.08 - 1e-8 && exposedBodyGap <= 0.08 + 1e-8,
          `route surface/terrain mismatch at ${surface.x.toFixed(6)},${surface.z.toFixed(6)}: surface=${surface.y.toFixed(9)} terrain=${terrain.toFixed(9)} clearance=${clearance.toFixed(9)}`,
        );
      }
});

test("cut-fill profiles smooth a crest while respecting explicit earthwork limits", async () => {
  const base = await basePlan();
  const route: WorldRoute = {
    ...groundedRoute({
      routeId: "CrestRoad",
      alignmentMeters: [
        { x: 2, z: 10 },
        { x: 18, z: 10 },
      ],
    }),
    elevationControls: [
      {
        controlId: "CrestRoadStart",
        stationFraction: 0,
        surfaceElevation: { kind: "absolute", elevationMeters: 1.08 },
      },
      {
        controlId: "CrestRoadEnd",
        stationFraction: 1,
        surfaceElevation: { kind: "absolute", elevationMeters: 1.08 },
      },
    ],
    construction: {
      kind: "cut_fill",
      surfaceRevealMeters: 0.08,
      crossfallRatio: 0,
      maximumGradeRatio: 0.12,
      maximumGradeChangePerMeter: 0.03,
      shoulderWidthMeters: 1,
      blendWidthMeters: 2,
      maximumCutDepthMeters: 4,
      maximumFillDepthMeters: 2,
      groundingToleranceMeters: 0.08,
      vegetationClearanceMeters: 0.75,
      terrainMaterialId: "Asphalt",
    },
  };
  const plan = reseal(base, {
    routes: [route],
    terrainPlans: base.terrainPlans.map((terrain) => ({
      ...terrain,
      resolution: { columns: 21, rows: 21 },
      operations: [
        { kind: "raise" as const, center: { x: 10, z: 10 }, radiusMeters: 6, deltaMeters: 3 },
      ],
    })),
  });
  const foundation = sealCompiledWorldFoundation(compileWorldPlan(plan));
  const construction = foundation.routeConstructions[0]!;
  assert.equal(construction.status, "eligible");
  assert.ok(
    construction.profile.every((station) => Math.abs(station.centerTopMeters.y - 1.08) <= 1e-9),
  );
  const baseAtCrest = sampleBaseTerrainFieldElevation(foundation.baseTerrainFields[0]!, 10, 10);
  const finalAtCrest = sampleTerrainFieldElevation(
    foundation.terrainFields[0]!,
    foundation.baseTerrainFields[0]!,
    foundation.routeConstructions,
    foundation.routeJunctions,
    10,
    10,
  );
  assert.ok(baseAtCrest > finalAtCrest);
  assert.ok(Math.abs(finalAtCrest - 1) <= 1e-9);
});

test("bend radius is a hard horizontal construction constraint", async () => {
  const base = await basePlan();
  assert.throws(
    () =>
      reseal(base, {
        routes: [
          {
            ...groundedRoute({
              routeId: "ImpossibleBend",
              alignmentMeters: [
                { x: 2, z: 2 },
                { x: 10, z: 2 },
                { x: 10, z: 10 },
              ],
            }),
            bendRadiusMeters: 100,
          },
        ],
      }),
    /does not fit span/u,
  );
});

test("ordinary route bends use angle-bounded mitered spans without exposed seams", async () => {
  const base = await basePlan();
  const routeBase = groundedRoute({
    routeId: "MiteredRoad",
    alignmentMeters: [
      { x: 2, z: 2 },
      { x: 10, z: 2 },
      { x: 10, z: 10 },
    ],
  });
  const route: WorldRoute = {
    ...routeBase,
    elevationControls: [
      {
        controlId: "MiteredRoadStart",
        stationFraction: 0,
        surfaceElevation: { kind: "absolute", elevationMeters: 3 },
      },
      {
        controlId: "MiteredRoadEnd",
        stationFraction: 1,
        surfaceElevation: { kind: "absolute", elevationMeters: 3 },
      },
    ],
    construction: {
      kind: "cut_fill",
      surfaceRevealMeters: 0.08,
      crossfallRatio: 0,
      maximumGradeRatio: 1,
      maximumGradeChangePerMeter: 0.25,
      shoulderWidthMeters: 0.5,
      blendWidthMeters: 1,
      maximumCutDepthMeters: 4,
      maximumFillDepthMeters: 4,
      groundingToleranceMeters: 0.08,
      vegetationClearanceMeters: 0.5,
      terrainMaterialId: "Ground",
    },
  };
  const foundation = sealCompiledWorldFoundation(
    compileWorldPlan(reseal(base, { routes: [route] })),
  );
  const segments = foundation.routeConstructions[0]!.travelSegments;
  assert.equal(segments[0]!.startPlanMiterMeters, 0);
  assert.equal(segments.at(-1)!.endPlanMiterMeters, 0);

  let turningPairs = 0;
  for (let index = 1; index < segments.length; index += 1) {
    const before = segments[index - 1]!;
    const after = segments[index]!;
    const beforeDirection = horizontalSegmentDirection(before);
    const afterDirection = horizontalSegmentDirection(after);
    const dot = Math.max(
      -1,
      Math.min(1, beforeDirection.x * afterDirection.x + beforeDirection.z * afterDirection.z),
    );
    const turnRadians = Math.acos(dot);
    if (turnRadians <= 1e-8) continue;
    turningPairs += 1;
    assert.ok(turnRadians <= Math.PI / 36 + 1e-10, `turn ${turnRadians} exceeds 5 degrees`);
    assert.ok(before.endPlanMiterMeters > 0);
    assert.ok(after.startPlanMiterMeters > 0);
    assert.ok(Math.abs(before.endPlanMiterMeters - after.startPlanMiterMeters) <= 1e-10);

    const cross = beforeDirection.x * afterDirection.z - beforeDirection.z * afterDirection.x;
    const beforeOuter = before.vertices[cross > 0 ? 2 : 3]!.positionMeters;
    const afterOuter = after.vertices[cross > 0 ? 0 : 1]!.positionMeters;
    assert.ok(
      Math.hypot(
        beforeOuter.x - afterOuter.x,
        beforeOuter.y - afterOuter.y,
        beforeOuter.z - afterOuter.z,
      ) <= 1e-8,
      "adjacent mitered spans must meet at their outside corner",
    );
  }
  assert.ok(turningPairs >= 18, "the quarter turn should be tessellated at five degrees or finer");
});

test("smooth vertical profiles use angle-bounded pitch joins without exposed depth seams", async () => {
  const base = await basePlan();
  const appearance = routeAppearance("WoodPlanks", { red: 112, green: 83, blue: 52 });
  const route: WorldRoute = {
    ...groundedRoute({
      routeId: "VerticalMiterBoardwalk",
      alignmentMeters: [
        { x: 2, z: 1 },
        { x: 6, z: 1 },
      ],
    }),
    appearance,
    maximumSegmentLengthMeters: 100,
    elevationControls: [
      {
        controlId: "VerticalMiterBoardwalkStart",
        stationFraction: 0,
        surfaceElevation: { kind: "absolute", elevationMeters: 2.5 },
      },
      {
        controlId: "VerticalMiterBoardwalkEnd",
        stationFraction: 1,
        surfaceElevation: { kind: "absolute", elevationMeters: 1.5 },
      },
    ],
    construction: {
      kind: "elevated",
      maximumGradeRatio: 0.5,
      minimumGroundClearanceMeters: 0.5,
      supportSpacingMeters: 3,
      supportRadiusMeters: 0.15,
      maximumSupportHeightMeters: 5,
      vegetationClearanceMeters: 0.5,
      supportAppearance: appearance,
    },
  };
  const foundation = sealCompiledWorldFoundation(
    compileWorldPlan(reseal(base, { routes: [route] })),
  );
  assert.equal(foundation.status, "eligible");
  const construction = foundation.routeConstructions[0]!;
  const segments = construction.travelSegments;
  assert.ok(segments.length > 1, "vertical curvature must refine an initially single span");
  let profileJoins = 0;
  let exactOuterJoins = 0;
  for (let index = 1; index < segments.length; index += 1) {
    const before = segments[index - 1]!;
    const after = segments[index]!;
    const beforePitch = Math.atan(before.gradeRatio);
    const afterPitch = Math.atan(after.gradeRatio);
    const deflection = Math.abs(afterPitch - beforePitch);
    assert.ok(deflection <= Math.PI / 180 + 1e-10, `pitch change ${deflection} exceeds 1 degree`);
    if (deflection <= 1e-8) continue;
    profileJoins += 1;
    const expected = construction.thicknessMeters * Math.tan(deflection / 2);
    assert.ok(Math.abs(before.endProfileMiterMeters - expected) <= 1e-10);
    assert.ok(Math.abs(after.startProfileMiterMeters - expected) <= 1e-10);

    if (afterPitch <= beforePitch) continue;
    const beforeBottom = routeSegmentBottomCenter(before, "end", construction.thicknessMeters);
    const afterBottom = routeSegmentBottomCenter(after, "start", construction.thicknessMeters);
    assert.ok(distance3(beforeBottom, afterBottom) <= 1e-8);
    exactOuterJoins += 1;
  }
  assert.ok(profileJoins > 0);
  assert.ok(exactOuterJoins > 0);
});

test("elevated routes preserve terrain and emit measured supports", async () => {
  const base = await basePlan();
  const appearance = routeAppearance("WoodPlanks", { red: 112, green: 83, blue: 52 });
  const route: WorldRoute = {
    ...groundedRoute({
      routeId: "StreamBoardwalk",
      alignmentMeters: [
        { x: 10, z: 3 },
        { x: 10, z: 17 },
      ],
    }),
    appearance,
    elevationControls: [
      {
        controlId: "StreamBoardwalkStart",
        stationFraction: 0,
        surfaceElevation: { kind: "absolute", elevationMeters: 2.5 },
      },
      {
        controlId: "StreamBoardwalkEnd",
        stationFraction: 1,
        surfaceElevation: { kind: "absolute", elevationMeters: 2.5 },
      },
    ],
    construction: {
      kind: "elevated",
      maximumGradeRatio: 0.1,
      minimumGroundClearanceMeters: 0.5,
      supportSpacingMeters: 3,
      supportRadiusMeters: 0.15,
      maximumSupportHeightMeters: 5,
      vegetationClearanceMeters: 0.5,
      supportAppearance: appearance,
    },
  };
  const plan = reseal(base, {
    routes: [route],
    terrainPlans: base.terrainPlans.map((terrain) => ({
      ...terrain,
      resolution: { columns: 21, rows: 21 },
      operations: [
        { kind: "carve" as const, center: { x: 10, z: 10 }, radiusMeters: 4, depthMeters: 1.5 },
      ],
    })),
  });
  const foundation = sealCompiledWorldFoundation(compileWorldPlan(plan));
  const construction = foundation.routeConstructions[0]!;
  assert.equal(construction.terrainTreatment.kind, "preserve");
  assert.ok(construction.supports.length >= 5);
  assert.deepEqual(foundation.terrainFields[0]!.routeConstructionHashes, []);
  for (const point of [
    { x: 10, z: 3 },
    { x: 10, z: 10 },
    { x: 10, z: 17 },
  ])
    assert.equal(
      sampleTerrainFieldElevation(
        foundation.terrainFields[0]!,
        foundation.baseTerrainFields[0]!,
        foundation.routeConstructions,
        foundation.routeJunctions,
        point.x,
        point.z,
      ),
      sampleBaseTerrainFieldElevation(foundation.baseTerrainFields[0]!, point.x, point.z),
    );
});

test("junctions seal shared endpoint geometry instead of overlapping independent strips", async () => {
  const base = await basePlan();
  const first = groundedRoute({
    routeId: "WestRoad",
    alignmentMeters: [
      { x: 2, z: 10 },
      { x: 10, z: 10 },
    ],
  });
  const second = groundedRoute({
    routeId: "NorthRoad",
    alignmentMeters: [
      { x: 10, z: 18 },
      { x: 10, z: 10 },
    ],
  });
  const plan = reseal(base, {
    routes: [first, second],
    routeJunctions: [
      {
        junctionId: "Crossing",
        kind: "intersection",
        positionMeters: { x: 10, z: 10 },
        surfaceElevation: { kind: "terrain_clearance", clearanceMeters: 0.08 },
        participants: [
          { routeId: "WestRoad", endpoint: "end" },
          { routeId: "NorthRoad", endpoint: "end" },
        ],
        maximumSnapDistanceMeters: 0.1,
        radiusMeters: 1,
        appearance: routeAppearance("Asphalt", { red: 68, green: 70, blue: 74 }),
      },
    ],
  });
  const foundation = sealCompiledWorldFoundation(compileWorldPlan(plan));
  assert.equal(foundation.routeJunctions.length, 1);
  const junction = foundation.routeJunctions[0]!;
  assert.equal(
    junction.centerTopMeters.y,
    sampleBaseTerrainFieldElevation(foundation.baseTerrainFields[0]!, 10, 10) + 0.08,
  );
  assert.ok(
    foundation.routeConstructions.every(
      (route) =>
        route.profile.at(-1)!.centerTopMeters.x === junction.centerTopMeters.x &&
        route.profile.at(-1)!.centerTopMeters.z === junction.centerTopMeters.z &&
        route.profile.at(-1)!.centerTopMeters.y === junction.centerTopMeters.y,
    ),
  );
  assert.equal(junction.terrainTreatment.kind, "grade");
  assert.ok(foundation.terrainFields[0]!.routeJunctionHashes.includes(junction.hash));
  const junctionTerrain = sampleTerrainFieldElevation(
    foundation.terrainFields[0]!,
    foundation.baseTerrainFields[0]!,
    foundation.routeConstructions,
    foundation.routeJunctions,
    10.4,
    10.4,
  );
  assert.ok(Math.abs(junction.centerTopMeters.y - junctionTerrain - 0.08) <= 1e-9);
});

test("impossible route earthworks remain incomplete and cannot mutate terrain", async () => {
  const base = await basePlan();
  const route: WorldRoute = {
    ...groundedRoute({
      routeId: "ImpossibleRoad",
      alignmentMeters: [
        { x: 2, z: 10 },
        { x: 18, z: 10 },
      ],
    }),
    elevationControls: [
      {
        controlId: "ImpossibleStart",
        stationFraction: 0,
        surfaceElevation: { kind: "absolute", elevationMeters: 0.08 },
      },
      {
        controlId: "ImpossibleEnd",
        stationFraction: 1,
        surfaceElevation: { kind: "absolute", elevationMeters: 8.08 },
      },
    ],
    construction: {
      kind: "cut_fill",
      surfaceRevealMeters: 0.08,
      crossfallRatio: 0,
      maximumGradeRatio: 0.1,
      maximumGradeChangePerMeter: 0.01,
      shoulderWidthMeters: 0.5,
      blendWidthMeters: 1,
      maximumCutDepthMeters: 0.1,
      maximumFillDepthMeters: 0.1,
      groundingToleranceMeters: 0.05,
      vegetationClearanceMeters: 0.5,
      terrainMaterialId: "Asphalt",
    },
  };
  const foundation = sealCompiledWorldFoundation(
    compileWorldPlan(reseal(base, { routes: [route] })),
  );
  assert.equal(foundation.status, "incomplete");
  assert.equal(foundation.routeConstructions[0]!.status, "incomplete");
  assert.equal(foundation.routeConstructions[0]!.terrainTreatment.kind, "preserve");
  assert.deepEqual(foundation.terrainFields[0]!.routeConstructionHashes, []);
  assert.ok(foundation.diagnostics.some((entry) => entry.includes(":grade:")));
});

test("the foundation gate rejects overlapping grounded surfaces with an exposed void", async () => {
  const base = await basePlan();
  const lower = groundedRoute({
    routeId: "LowerRoute",
    alignmentMeters: [
      { x: 2, z: 10 },
      { x: 18, z: 10 },
    ],
  });
  const upper: WorldRoute = {
    ...groundedRoute({
      routeId: "UpperRoute",
      alignmentMeters: [
        { x: 2, z: 10 },
        { x: 18, z: 10 },
      ],
    }),
    elevationControls: [
      {
        controlId: "UpperRouteStart",
        stationFraction: 0,
        surfaceElevation: { kind: "terrain_clearance", clearanceMeters: 1.08 },
      },
      {
        controlId: "UpperRouteEnd",
        stationFraction: 1,
        surfaceElevation: { kind: "terrain_clearance", clearanceMeters: 1.08 },
      },
    ],
    terrainPriority: 1,
  };
  const foundation = sealCompiledWorldFoundation(
    compileWorldPlan(reseal(base, { routes: [lower, upper] })),
  );
  assert.ok(foundation.routeConstructions.every((route) => route.status === "eligible"));
  assert.equal(foundation.status, "incomplete");
  assert.ok(
    foundation.diagnostics.some(
      (entry) => entry.includes("route:UpperRoute:terrain_contact") && entry.includes("outside"),
    ),
  );
});

test("a route edit executes its affected dependency closure but reuses authored base terrain", async () => {
  const module = await loadSemanticRegistry();
  const fixture = await worldFixture(module);
  const input = {
    semanticModule: module,
    catalogSnapshot: fixture.snapshot,
    catalogAssets: [fixture.asset],
    spatialPlan: fixture.plan,
  };
  const previous = compileBasaltWorld(input);
  const changedPlan = reseal(fixture.plan, {
    routes: fixture.plan.routes.map((route) => ({
      ...route,
      alignmentMeters: [
        route.alignmentMeters[0]!,
        { x: 10, z: 2.5 },
        route.alignmentMeters.at(-1)!,
      ],
    })),
  });
  const routeTaskId = compilationTaskId("route", "route_construction", "MainRoute");
  const affectedTaskIds = affectedCompilationTaskClosure(previous.tasks, [routeTaskId]);
  const result = compileBasaltWorldIncremental(
    { ...input, spatialPlan: changedPlan },
    { previousWorldBuild: previous, affectedTaskIds },
  );
  const baseTaskId = compilationTaskId("terrain", "terrain_base", "GroundTerrain");
  const finalTerrainTaskId = compilationTaskId("terrain", "terrain_final", "GroundTerrain");
  assert.ok(result.executedTaskIds.includes(routeTaskId));
  assert.ok(result.executedTaskIds.includes(finalTerrainTaskId));
  assert.equal(result.executedTaskIds.includes(baseTaskId), false);
  assert.equal(
    result.worldBuild.foundation.baseTerrainFields[0]!.hash,
    previous.foundation.baseTerrainFields[0]!.hash,
  );
  assert.notEqual(
    result.worldBuild.foundation.routeConstructions[0]!.hash,
    previous.foundation.routeConstructions[0]!.hash,
  );
  assert.notEqual(
    result.worldBuild.foundation.terrainFields[0]!.hash,
    previous.foundation.terrainFields[0]!.hash,
  );
});

async function basePlan(): Promise<SpatialWorldPlan> {
  const module = await loadSemanticRegistry();
  const fixture = await worldFixture(module);
  return reseal(fixture.plan, {
    catalogRequirements: [],
    realizationIntents: [],
    constructionPrograms: [],
    routes: [],
    routeJunctions: [],
  });
}

function groundedRoute(input: {
  readonly routeId: string;
  readonly alignmentMeters: WorldRoute["alignmentMeters"];
}): WorldRoute {
  return {
    routeId: input.routeId,
    semanticEntityId: "RouteEntity",
    regionIds: ["MainRegion"],
    surfaceId: "GroundSurface",
    alignmentMeters: input.alignmentMeters,
    elevationControls: [
      {
        controlId: `${input.routeId}Start`,
        stationFraction: 0,
        surfaceElevation: { kind: "terrain_clearance", clearanceMeters: 0.08 },
      },
      {
        controlId: `${input.routeId}End`,
        stationFraction: 1,
        surfaceElevation: { kind: "terrain_clearance", clearanceMeters: 0.08 },
      },
    ],
    widthMeters: 2,
    thicknessMeters: 0.16,
    bendRadiusMeters: 2,
    maximumSegmentLengthMeters: 1,
    terrainPriority: 0,
    appearance: routeAppearance("Asphalt", { red: 68, green: 70, blue: 74 }),
    construction: {
      kind: "follow_surface",
      surfaceRevealMeters: 0.08,
      crossfallRatio: 0,
      maximumGradeRatio: 1,
      shoulderWidthMeters: 0.5,
      blendWidthMeters: 1,
      maximumCutDepthMeters: 4,
      maximumFillDepthMeters: 4,
      groundingToleranceMeters: 0.08,
      vegetationClearanceMeters: 0.5,
      terrainMaterialId: "Ground",
    },
    closed: false,
  };
}

function routeAppearance(
  materialId: string,
  baseColorSrgb: { readonly red: number; readonly green: number; readonly blue: number },
) {
  return { materialId, styleProfileHash: routeStyleHash, baseColorSrgb };
}

function interpolateVector(
  start: { readonly x: number; readonly y: number; readonly z: number },
  end: { readonly x: number; readonly y: number; readonly z: number },
  amount: number,
) {
  return {
    x: start.x + (end.x - start.x) * amount,
    y: start.y + (end.y - start.y) * amount,
    z: start.z + (end.z - start.z) * amount,
  };
}

function horizontalSegmentDirection(segment: {
  readonly vertices: readonly {
    readonly positionMeters: { readonly x: number; readonly y: number; readonly z: number };
  }[];
}) {
  const start = interpolateVector(
    segment.vertices[0]!.positionMeters,
    segment.vertices[1]!.positionMeters,
    0.5,
  );
  const finish = interpolateVector(
    segment.vertices[2]!.positionMeters,
    segment.vertices[3]!.positionMeters,
    0.5,
  );
  const length = Math.hypot(finish.x - start.x, finish.z - start.z);
  return { x: (finish.x - start.x) / length, z: (finish.z - start.z) / length };
}

function routeSegmentBottomCenter(
  segment: {
    readonly vertices: readonly {
      readonly positionMeters: { readonly x: number; readonly y: number; readonly z: number };
    }[];
  },
  endpoint: "start" | "end",
  thicknessMeters: number,
) {
  const start = interpolateVector(
    segment.vertices[0]!.positionMeters,
    segment.vertices[1]!.positionMeters,
    0.5,
  );
  const finish = interpolateVector(
    segment.vertices[2]!.positionMeters,
    segment.vertices[3]!.positionMeters,
    0.5,
  );
  const travel = normalizeVector3({
    x: finish.x - start.x,
    y: finish.y - start.y,
    z: finish.z - start.z,
  });
  const rawLateral = normalizeVector3({
    x:
      segment.vertices[1]!.positionMeters.x -
      segment.vertices[0]!.positionMeters.x +
      segment.vertices[3]!.positionMeters.x -
      segment.vertices[2]!.positionMeters.x,
    y:
      segment.vertices[1]!.positionMeters.y -
      segment.vertices[0]!.positionMeters.y +
      segment.vertices[3]!.positionMeters.y -
      segment.vertices[2]!.positionMeters.y,
    z:
      segment.vertices[1]!.positionMeters.z -
      segment.vertices[0]!.positionMeters.z +
      segment.vertices[3]!.positionMeters.z -
      segment.vertices[2]!.positionMeters.z,
  });
  const lateralDotTravel =
    rawLateral.x * travel.x + rawLateral.y * travel.y + rawLateral.z * travel.z;
  const lateral = normalizeVector3({
    x: rawLateral.x - travel.x * lateralDotTravel,
    y: rawLateral.y - travel.y * lateralDotTravel,
    z: rawLateral.z - travel.z * lateralDotTravel,
  });
  let up = normalizeVector3({
    x: lateral.y * travel.z - lateral.z * travel.y,
    y: lateral.z * travel.x - lateral.x * travel.z,
    z: lateral.x * travel.y - lateral.y * travel.x,
  });
  if (up.y < 0) {
    up = { x: -up.x, y: -up.y, z: -up.z };
  }
  const top = endpoint === "start" ? start : finish;
  return {
    x: top.x - up.x * thicknessMeters,
    y: top.y - up.y * thicknessMeters,
    z: top.z - up.z * thicknessMeters,
  };
}

function normalizeVector3(value: { readonly x: number; readonly y: number; readonly z: number }) {
  const length = Math.hypot(value.x, value.y, value.z);
  return { x: value.x / length, y: value.y / length, z: value.z / length };
}

function distance3(
  left: { readonly x: number; readonly y: number; readonly z: number },
  right: { readonly x: number; readonly y: number; readonly z: number },
) {
  return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
}

function reseal(
  plan: SpatialWorldPlan,
  replacement: Partial<Omit<SpatialWorldPlan, "kind" | "coordinateSystem" | "planHash">>,
): SpatialWorldPlan {
  const { kind: _kind, coordinateSystem: _coordinateSystem, planHash: _hash, ...input } = plan;
  return sealSpatialWorldPlan({ ...input, ...replacement });
}
