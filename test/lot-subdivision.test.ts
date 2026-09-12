import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  WORLD_PLAN_SCHEMA,
  assertLotSubdivision,
  isPointInRouteCorridor,
  subdivideWorldPlanToLots,
  type LotSubdivision,
  type SpatialWorldPlan,
} from "../packages/world-planning/src/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const districtPlanJson = JSON.parse(
  readFileSync(resolve(root, "test/fixtures/district-region.plan.json"), "utf8"),
) as unknown;
const districtPlan = WORLD_PLAN_SCHEMA.parse(districtPlanJson);

function regionBounds(regionId: string): {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
} {
  const region = districtPlan.regions.find((candidate) => candidate.id === regionId);
  assert.ok(region);
  assert.equal(region.volume.kind, "extruded_polygon");
  const xs = region.volume.footprint.map((point) => point.x);
  const zs = region.volume.footprint.map((point) => point.z);
  return {
    minX: Math.min(...xs),
    minZ: Math.min(...zs),
    maxX: Math.max(...xs),
    maxZ: Math.max(...zs),
  };
}

function rectOf(lot: { polygon: readonly { x: number; z: number }[] }): {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
} {
  const xs = lot.polygon.map((point) => point.x);
  const zs = lot.polygon.map((point) => point.z);
  return { x0: Math.min(...xs), z0: Math.min(...zs), x1: Math.max(...xs), z1: Math.max(...zs) };
}

function inAnyCorridor(plan: SpatialWorldPlan, x: number, z: number, margin: number): boolean {
  return plan.routes.some((route) =>
    isPointInRouteCorridor(route.points, route.width, { x, y: 0, z }, margin),
  );
}

test("district fixture subdivides into zoned road-enclosed lots", () => {
  const subdivisions = subdivideWorldPlanToLots(districtPlanJson);
  assert.equal(subdivisions.length, 4);
  assert.deepEqual(
    subdivisions.map((subdivision) => [subdivision.regionId, subdivision.zoneTag]),
    [
      ["district_p_0_0", "residential"],
      ["district_p_0_1", "commercial"],
      ["district_p_1_0", "civic"],
      ["district_p_1_1", "residential"],
    ],
  );
  for (const subdivision of subdivisions) {
    assertLotSubdivision(subdivision);
    assert.equal(subdivision.blocks.length, 2);
    assert.equal(subdivision.lots.length, 4);
  }
  const first = subdivisions[0]!;
  assert.deepEqual(
    first.blocks.map((block) => [block.cellCount, block.lotIds.length]),
    [
      [1105, 0],
      [1600, 4],
    ],
  );
  assert.deepEqual(first.lots[0], {
    id: "lot_district_p_0_0_1_00",
    regionId: "district_p_0_0",
    blockIndex: 1,
    polygon: [
      { x: -40, z: -40 },
      { x: -20, z: -40 },
      { x: -20, z: -20 },
      { x: -40, z: -20 },
    ],
    centroid: { x: -30, z: -30 },
    areaStuds2: 400,
    frontage: [
      { from: { x: -40, z: -40 }, to: { x: -40, z: -20 } },
      { from: { x: -40, z: -40 }, to: { x: -20, z: -40 } },
    ],
  });
});

test("lot subdivision is byte-identical across runs", () => {
  const first = subdivideWorldPlanToLots(districtPlanJson);
  const second = subdivideWorldPlanToLots(structuredClone(districtPlanJson));
  assert.deepEqual(second, first);
  assert.equal(second[0]!.hash, first[0]!.hash);
});

test("district lots are disjoint, in-bounds, and corridor-free", () => {
  const subdivisions = subdivideWorldPlanToLots(districtPlanJson);
  for (const subdivision of subdivisions) {
    const bounds = regionBounds(subdivision.regionId);
    const rects = subdivision.lots.map(rectOf);
    rects.forEach((rect, index) => {
      assert.ok(rect.x0 >= bounds.minX && rect.x1 <= bounds.maxX);
      assert.ok(rect.z0 >= bounds.minZ && rect.z1 <= bounds.maxZ);
      for (let other = index + 1; other < rects.length; other += 1) {
        const candidate = rects[other]!;
        const overlapX = Math.min(rect.x1, candidate.x1) - Math.max(rect.x0, candidate.x0);
        const overlapZ = Math.min(rect.z1, candidate.z1) - Math.max(rect.z0, candidate.z0);
        assert.ok(overlapX <= 0 || overlapZ <= 0, "lots must not overlap");
      }
    });
    for (const lot of subdivision.lots) {
      const rect = rectOf(lot);
      for (let x = rect.x0 + 0.5; x < rect.x1; x += 1)
        for (let z = rect.z0 + 0.5; z < rect.z1; z += 1)
          assert.equal(
            inAnyCorridor(districtPlan, x, z, subdivision.roadMarginStuds),
            false,
            `${lot.id} must not cover a corridor cell`,
          );
      for (const edge of lot.frontage) {
        const onBoundary =
          lot.polygon.some((point) => point.x === edge.from.x && point.z === edge.from.z) &&
          lot.polygon.some((point) => point.x === edge.to.x && point.z === edge.to.z);
        assert.equal(onBoundary, true);
        const midX = (edge.from.x + edge.to.x) / 2;
        const midZ = (edge.from.z + edge.to.z) / 2;
        const outwardX = edge.from.x === edge.to.x ? (midX <= rect.x0 ? -0.5 : 0.5) : 0;
        const outwardZ = edge.from.z === edge.to.z ? (midZ <= rect.z0 ? -0.5 : 0.5) : 0;
        assert.equal(
          inAnyCorridor(
            districtPlan,
            midX + outwardX,
            midZ + outwardZ,
            subdivision.roadMarginStuds,
          ),
          true,
          `${lot.id} frontage must face a corridor`,
        );
      }
    }
  }
});

interface SyntheticSpec {
  readonly footprint: { x: number; z: number }[];
  readonly routes?: unknown[];
  readonly zoneTag?: string;
  readonly volume?: unknown;
}

function syntheticPlanJson(spec: SyntheticSpec): unknown {
  const plan = structuredClone(districtPlanJson) as {
    regions: unknown[];
    regionRelations: unknown[];
    terrainPlans: unknown[];
    constructedSurfaces: unknown[];
    routes: unknown[];
    anchors: unknown[];
    collisionProxies: unknown[];
    assetRequirements: unknown[];
    cameras: { regionIds: string[] }[];
  };
  plan.regions = [
    {
      id: "lotsynth",
      name: "Synthetic lot region",
      purpose: "Exercise the lot subdivision solver.",
      ...(spec.zoneTag === undefined ? {} : { zoneTag: spec.zoneTag }),
      refinementPriority: 100,
      volume:
        spec.volume ??
        ({
          kind: "extruded_polygon",
          footprint: spec.footprint,
          verticalRange: { minimum: -10, maximum: 20 },
        } as const),
      compositionMeasures: [],
    },
  ];
  plan.regionRelations = [];
  plan.constructedSurfaces = [];
  plan.routes = spec.routes ?? [];
  if (plan.routes.length > 0) {
    const template = (districtPlanJson as { terrainPlans: Record<string, unknown>[] })
      .terrainPlans[0]!;
    const xs = spec.footprint.map((point) => point.x);
    const zs = spec.footprint.map((point) => point.z);
    plan.terrainPlans = [
      {
        ...template,
        id: "lotsynth_terrain",
        surfaceId: "lotsynth_surface",
        bounds: {
          x: { minimum: Math.min(...xs), maximum: Math.max(...xs) },
          z: { minimum: Math.min(...zs), maximum: Math.max(...zs) },
        },
        regions: [
          {
            ...(template.regions as Record<string, unknown>[])[0]!,
            regionId: "lotsynth",
            footprint: spec.footprint,
          },
        ],
      },
    ];
  } else {
    plan.terrainPlans = [];
  }
  plan.anchors = [];
  plan.collisionProxies = [];
  plan.assetRequirements = [];
  plan.cameras = [{ ...plan.cameras[0]!, regionIds: ["lotsynth"] }];
  return WORLD_PLAN_SCHEMA.parse(plan);
}

function districtRoute(points: { x: number; y: number; z: number }[]): unknown {
  const template = (districtPlanJson as { routes: Record<string, unknown>[] }).routes[0]!;
  return {
    ...template,
    id: "lotsynth_road",
    surfaceId: "lotsynth_surface",
    regionIds: ["lotsynth"],
    points,
    closed: false,
    reachableAnchorIds: [],
  };
}

test("a road-free region subdivides to its full extent", () => {
  const plan = syntheticPlanJson({
    footprint: [
      { x: -10, z: -10 },
      { x: 10, z: -10 },
      { x: 10, z: 10 },
      { x: -10, z: 10 },
    ],
    zoneTag: "civic",
  });
  const subdivisions = subdivideWorldPlanToLots(plan);
  assert.equal(subdivisions.length, 1);
  const subdivision = subdivisions[0]!;
  assertLotSubdivision(subdivision);
  assert.equal(subdivision.zoneTag, "civic");
  assert.equal(subdivision.blocks.length, 1);
  assert.equal(subdivision.lots.length, 1);
  assert.deepEqual(subdivision.lots[0]!.polygon, [
    { x: -10, z: -10 },
    { x: 10, z: -10 },
    { x: 10, z: 10 },
    { x: -10, z: 10 },
  ]);
  assert.deepEqual(subdivision.lots[0]!.frontage, []);
  assert.equal(subdivision.lots[0]!.areaStuds2, 400);
});

test("a road through a region splits lots to both sides with frontage", () => {
  const plan = syntheticPlanJson({
    footprint: [
      { x: -30, z: -20 },
      { x: 30, z: -20 },
      { x: 30, z: 20 },
      { x: -30, z: 20 },
    ],
    routes: [
      districtRoute([
        { x: -30, y: 0, z: 0 },
        { x: 30, y: 0, z: 0 },
      ]),
    ],
  });
  const parsed = WORLD_PLAN_SCHEMA.parse(plan);
  const subdivisions = subdivideWorldPlanToLots(plan);
  assert.equal(subdivisions.length, 1);
  const subdivision: LotSubdivision = subdivisions[0]!;
  assert.equal(subdivision.zoneTag, undefined);
  assert.ok(subdivision.lots.length >= 2);
  const north = subdivision.lots.filter((lot) => rectOf(lot).z0 >= 0);
  const south = subdivision.lots.filter((lot) => rectOf(lot).z1 <= 0);
  assert.ok(north.length >= 1 && south.length >= 1);
  for (const lot of subdivision.lots) {
    const rect = rectOf(lot);
    for (let x = rect.x0 + 0.5; x < rect.x1; x += 1)
      for (let z = rect.z0 + 0.5; z < rect.z1; z += 1)
        assert.equal(inAnyCorridor(parsed, x, z, subdivision.roadMarginStuds), false);
  }
  const frontageCount = subdivision.lots.flatMap((lot) => lot.frontage).length;
  assert.ok(frontageCount >= 2);
});

test("a sub-minimum region seals with zero lots", () => {
  const plan = syntheticPlanJson({
    footprint: [
      { x: -30, z: -5 },
      { x: 30, z: -5 },
      { x: 30, z: 5 },
      { x: -30, z: 5 },
    ],
  });
  const subdivisions = subdivideWorldPlanToLots(plan);
  assert.equal(subdivisions.length, 1);
  assertLotSubdivision(subdivisions[0]);
  assert.equal(subdivisions[0]!.blocks.length, 1);
  assert.equal(subdivisions[0]!.lots.length, 0);
});

test("non-rectangular and non-polygon regions fail closed", () => {
  const triangle = syntheticPlanJson({
    footprint: [
      { x: -10, z: -10 },
      { x: 10, z: -10 },
      { x: 0, z: 10 },
    ],
  });
  assert.throws(() => subdivideWorldPlanToLots(triangle), /rectangular footprint/);
  const box = syntheticPlanJson({
    footprint: [
      { x: -10, z: -10 },
      { x: 10, z: -10 },
      { x: 10, z: 10 },
      { x: -10, z: 10 },
    ],
    volume: {
      kind: "oriented_box",
      center: { x: 0, y: 0, z: 0 },
      axes: {
        x: { x: 1, y: 0, z: 0 },
        y: { x: 0, y: 1, z: 0 },
        z: { x: 0, y: 0, z: 1 },
      },
      halfSize: { x: 10, y: 10, z: 10 },
    },
  });
  assert.throws(() => subdivideWorldPlanToLots(box), /extruded_polygon/);
});

test("degenerate lot options fail closed", () => {
  assert.throws(
    () => subdivideWorldPlanToLots(districtPlanJson, { minLotStuds: 30, maxLotStuds: 12 }),
    /degenerate/,
  );
});
