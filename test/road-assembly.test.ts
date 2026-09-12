import assert from "node:assert/strict";
import test from "node:test";
import {
  WORLD_PLAN_SCHEMA,
  analyzeRouteGrades,
  assertRoadAssembly,
  assemblePlanRoads,
  compileRoadAssembly,
  compileWorldPlan,
  isPointInRouteCorridor,
  routeCorridorDistance2,
  type SpatialWorldPlan,
} from "../packages/world-planning/src/index.js";
import { productionWorldPlanFixture } from "./helpers/production-world-fixtures.js";

function fixture(): SpatialWorldPlan {
  return productionWorldPlanFixture({
    sceneId: "roadWorld",
    regionId: "roadRegion",
    surfaceId: "roadTerrain",
    routeId: "roadRoute",
    anchorId: "roadAnchor",
    cameraId: "roadCamera",
    materialId: "roadMaterial",
    name: "A road assembly fixture",
  });
}

function twoRegionFixture(): SpatialWorldPlan {
  const plan = fixture();
  const raw = JSON.parse(JSON.stringify(plan)) as Record<string, unknown>;
  const regions = raw.regions as Record<string, unknown>[];
  regions.push({
    id: "roadEast",
    name: "East road region",
    purpose: "Exercise multi-region road splits.",
    volume: {
      kind: "extruded_polygon",
      footprint: [
        { x: 0, z: -30 },
        { x: 30, z: -30 },
        { x: 30, z: 30 },
        { x: 0, z: 30 },
      ],
      verticalRange: { minimum: -4, maximum: 40 },
    },
    compositionMeasures: [],
    refinementPriority: 50,
  });
  const terrain = (raw.terrainPlans as Record<string, unknown>[])[0]!;
  const terrainRegions = terrain.regions as Record<string, unknown>[];
  terrainRegions[0]!.footprint = [
    { x: -30, z: -30 },
    { x: 0, z: -30 },
    { x: 0, z: 30 },
    { x: -30, z: 30 },
  ];
  terrainRegions[0]!.blendWidth = 2;
  terrainRegions.push({
    regionId: "roadEast",
    footprint: [
      { x: 0, z: -30 },
      { x: 30, z: -30 },
      { x: 30, z: 30 },
      { x: 0, z: 30 },
    ],
    blendWidth: 2,
    baseElevation: 4,
    noiseLayers: [],
    materialWeights: [{ materialId: "roadEastMaterial", weight: 1 }],
  });
  const routes = raw.routes as Record<string, unknown>[];
  routes[0]!.regionIds = ["roadRegion", "roadEast"];
  routes[0]!.maximumStepHeight = 4;
  const cameras = raw.cameras as Record<string, unknown>[];
  cameras[0]!.regionIds = ["roadRegion", "roadEast"];
  return WORLD_PLAN_SCHEMA.parse(raw);
}

test("Road assembly seals one ribbon per route with chunked segments", () => {
  const compiled = compileWorldPlan(fixture());
  const assemblies = assemblePlanRoads(compiled.plan, compiled.surfaces);
  assert.equal(assemblies.length, 1);
  const assembly = assemblies[0]!;
  assertRoadAssembly(assembly);
  assert.equal(assembly.routeId, "roadRoute");
  assert.equal(assembly.surfaceId, "roadTerrain");
  assert.equal(assembly.traversable, true);
  assert.ok(assembly.segments.length >= 1);
  for (const segment of assembly.segments) {
    assert.equal(segment.routeId, "roadRoute");
    assert.equal(segment.dominantRegionId, "roadRegion");
    assert.equal(segment.materialId, "roadMaterial");
    assert.ok(segment.vertices.length >= 4);
    assert.ok(segment.endStationStuds >= segment.startStationStuds);
    assert.ok(segment.bounds.minimum.x <= segment.bounds.maximum.x);
  }
  const ribbonWidth = Math.hypot(
    assembly.segments[0]!.vertices[0]!.position.x - assembly.segments[0]!.vertices[1]!.position.x,
    assembly.segments[0]!.vertices[0]!.position.z - assembly.segments[0]!.vertices[1]!.position.z,
  );
  assert.ok(Math.abs(ribbonWidth - 6) < 1e-4);
});

test("Road assembly is deterministic across runs and declaration order", () => {
  const first = assemblePlanRoads(fixture());
  const second = assemblePlanRoads(fixture());
  assert.deepEqual(first, second);
  const reordered = JSON.parse(JSON.stringify(fixture())) as SpatialWorldPlan;
  reordered.routes = [...reordered.routes].reverse();
  reordered.terrainPlans = [...reordered.terrainPlans].reverse();
  const third = assemblePlanRoads(WORLD_PLAN_SCHEMA.parse(reordered));
  assert.deepEqual(
    third.map((assembly) => assembly.hash),
    first.map((assembly) => assembly.hash),
  );
});

test("Road assembly splits segments where the dominant region changes", () => {
  const compiled = compileWorldPlan(twoRegionFixture());
  const assemblies = assemblePlanRoads(compiled.plan, compiled.surfaces);
  assert.equal(assemblies.length, 1);
  const regions = assemblies[0]!.segments.map((segment) => segment.dominantRegionId);
  assert.ok(regions.includes("roadRegion"));
  assert.ok(regions.includes("roadEast"));
  const east = assemblies[0]!.segments.find((segment) => segment.dominantRegionId === "roadEast")!;
  assert.equal(east.materialId, "roadEastMaterial");
});

test("Road assembly shares bit-identical joints between adjacent segments", () => {
  const compiled = compileWorldPlan(twoRegionFixture());
  const assembly = assemblePlanRoads(compiled.plan, compiled.surfaces, { chunkSizeStuds: 16 })[0]!;
  assert.ok(assembly.segments.length >= 2);
  for (let index = 1; index < assembly.segments.length; index += 1) {
    const previous = assembly.segments[index - 1]!;
    const current = assembly.segments[index]!;
    assert.deepEqual(current.vertices.slice(0, 4), previous.vertices.slice(-4));
    assert.ok(current.startStationStuds <= previous.endStationStuds);
  }
});

test("Road assembly closes loops without a seam gap", () => {
  const raw = JSON.parse(JSON.stringify(fixture())) as Record<string, unknown>;
  const routes = raw.routes as Record<string, unknown>[];
  routes[0]!.points = [
    { x: -10, y: 0, z: -10 },
    { x: 10, y: 0, z: -10 },
    { x: 10, y: 0, z: 10 },
    { x: -10, y: 0, z: 10 },
  ];
  routes[0]!.closed = true;
  const compiled = compileWorldPlan(WORLD_PLAN_SCHEMA.parse(raw));
  const assembly = assemblePlanRoads(compiled.plan, compiled.surfaces)[0]!;
  assertRoadAssembly(assembly);
  assert.equal(assembly.closed, true);
  const first = assembly.segments[0]!.vertices[0]!.position;
  const lastVertices = assembly.segments[assembly.segments.length - 1]!.vertices;
  const last = lastVertices[lastVertices.length - 2]!.position;
  assert.deepEqual(last, first);
});

test("Road assembly fails closed on non-traversable routes", () => {
  const compiled = compileWorldPlan(twoRegionFixture());
  const grades = analyzeRouteGrades(compiled.plan, compiled.surfaces);
  assert.ok(grades[0]!.maximumGradeDegrees > 0);
  const raw = JSON.parse(JSON.stringify(twoRegionFixture())) as Record<string, unknown>;
  const routes = raw.routes as Record<string, unknown>[];
  routes[0]!.maximumSlopeDegrees = grades[0]!.maximumGradeDegrees / 2;
  const steep = compileWorldPlan(WORLD_PLAN_SCHEMA.parse(raw));
  assert.throws(() => assemblePlanRoads(steep.plan, steep.surfaces), /non-traversable/);
});

test("Road assembly fails closed when a route leaves its declared regions", () => {
  const raw = JSON.parse(JSON.stringify(twoRegionFixture())) as Record<string, unknown>;
  const routes = raw.routes as Record<string, unknown>[];
  routes[0]!.regionIds = ["roadRegion"];
  routes[0]!.points = [
    { x: 12, y: 0, z: 0 },
    { x: 20, y: 0, z: 0 },
  ];
  const compiled = compileWorldPlan(WORLD_PLAN_SCHEMA.parse(raw));
  assert.throws(
    () => compileRoadAssembly(compiled.plan.routes[0]!, compiled.surfaces),
    /leaves its declared regions/,
  );
});

test("Road assembly rejects tampered hashes", () => {
  const assembly = assemblePlanRoads(fixture())[0]!;
  assert.throws(() => assertRoadAssembly({ ...assembly, hash: "0".repeat(64) }));
});

test("Route corridor distance is planimetric and shared", () => {
  const points = [
    { x: -20, y: 0, z: 0 },
    { x: 20, y: 0, z: 0 },
  ];
  assert.equal(routeCorridorDistance2(points, { x: 0, y: 99, z: 0 }), 0);
  assert.equal(routeCorridorDistance2(points, { x: 0, y: 0, z: 3 }), 9);
  assert.equal(isPointInRouteCorridor(points, 6, { x: 5, y: 0, z: 2.9 }), true);
  assert.equal(isPointInRouteCorridor(points, 6, { x: 5, y: 0, z: 3.1 }), false);
  assert.equal(isPointInRouteCorridor(points, 6, { x: 5, y: 0, z: 3.1 }, 0.5), true);
});
