import assert from "node:assert/strict";
import { existsSync, readdirSync, rmSync } from "node:fs";
import test from "node:test";
import { contentHash } from "@basalt/contracts";
import { sealAssetPlacementGeometry, REALIZATION_INTENT_SCHEMA } from "@basalt/catalog-model";
import {
  measureTriangleHeightBands,
  measureAssetPlacementGeometry,
  type NormalizedMesh,
} from "@basalt/asset-inspection";
import {
  horizontalMaskContainsPoint,
  OccupancyIndex,
  sealOccupancyReservation,
} from "@basalt/spatial-core";
import {
  compileBasaltWorld,
  distributeVegetation,
  canopyInfluenceAt,
  vegetationGroundElevation,
  type VegetationIntent,
  type RealizedInstance,
} from "@basalt/world-compiler";
import { sealSpatialWorldPlan } from "@basalt/world-planning";
import { worldFixture } from "./helpers/world-fixture.js";
import {
  TEST_VEGETATION_EXECUTION_POLICY,
  TEST_WORLD_EXECUTION_POLICY,
} from "./helpers/execution-policy.js";
import { loadSemanticRegistry } from "./helpers/semantic-registry.js";

function intent(
  intentId = "Canopy",
  layer: VegetationIntent["vegetation"]["layer"] = "canopy",
): VegetationIntent {
  return {
    kind: "surface_scatter",
    intentId,
    requirementId: "Trees",
    priority: 1,
    regionId: "MainRegion",
    surfaceId: "GroundSurface",
    boundary: [
      { u: 1, v: 1 },
      { u: 19, v: 1 },
      { u: 19, v: 19 },
      { u: 1, v: 19 },
    ],
    targetCount: 100,
    minimumCount: 0,
    minimumSeparationMeters: 0,
    densityField: {
      fieldId: "TestHabitat",
      seed: 8,
      edgeFadeMeters: 1,
      wavelengthMeters: 8,
      minimumDensity: 1,
      patchContrast: 1,
    },
    vegetation: {
      areaId: "TestArea",
      habitatFieldId: "TestHabitat",
      layer,
      candidateDensityPerSquareMeter: 0.5,
      spacingMeters: { minimum: 2, maximum: 3 },
      canopyIntentIds: [],
      canopyResponse: { open: 1, covered: 1 },
      maximumSlopeDegrees: 30,
      maximumSupportReliefMeters: 0.35,
      groundEmbedMeters: 0.025,
      routeClearanceHeightMeters: 3,
      clearings: [],
    },
  };
}

function hardClearing(
  bounds: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } },
  falloffMeters: number,
): VegetationIntent["vegetation"]["clearings"][number] {
  return {
    mask: {
      polygon: [
        { x: bounds.min.x, z: bounds.min.z },
        { x: bounds.max.x, z: bounds.min.z },
        { x: bounds.max.x, z: bounds.max.z },
        { x: bounds.min.x, z: bounds.max.z },
      ],
      edgeProfile: { kind: "hard" },
    },
    verticalRangeMeters: { minimum: bounds.min.y, maximum: bounds.max.y },
    falloffMeters,
  };
}

// The sampler only consumes placement identity and bounds. Geometry is tested separately below.
function accepted(id: string, x: number, z: number): RealizedInstance {
  return {
    intentId: id,
    boundsMeters: { min: { x: x - 3, y: 0, z: z - 3 }, max: { x: x + 3, y: 7, z: z + 3 } },
  } as RealizedInstance;
}

test("vegetation jointly spaces species, replays independent of input order, and never fills a quota by retrying", () => {
  const first = intent("Birch"),
    second = intent("Pine");
  const run = (intents: VegetationIntent[], executionPolicy = TEST_VEGETATION_EXECUTION_POLICY) => {
    const points: Array<{ id: string; x: number; z: number }> = [];
    const summaries = distributeVegetation(intents, {
      seed: 4,
      initialCanopy: [],
      executionPolicy,
      heightAt: () => 0,
      place: (plant, p) => {
        points.push({ id: plant.intentId, x: p.x, z: p.z });
        return accepted(plant.intentId, p.x, p.z);
      },
    });
    return { points, summaries };
  };
  const result = run([first, second]);
  assert.deepEqual(result, run([second, first]));
  assert.deepEqual(
    result,
    run([first, second], {
      ...TEST_VEGETATION_EXECUTION_POLICY,
      candidateBatchSize: 3,
    }),
    "Execution batch size cannot change the completed canonical result",
  );
  assert.deepEqual(
    result.points,
    run([first, second], {
      ...TEST_VEGETATION_EXECUTION_POLICY,
      candidateBatchSize: 5,
      mergeFanIn: 2,
    }).points,
    "External merge fan-in cannot change the completed canonical result",
  );
  const resumeDirectory = ".basalt/test-runtime/resumed-vegetation-runs";
  rmSync(resumeDirectory, { recursive: true, force: true });
  let resumed: ReturnType<typeof run> | undefined;
  for (let invocation = 0; invocation < 10; invocation++) {
    resumed = run([first, second], {
      policyId: "ResumedVegetationTest",
      origin: "Deliberately interrupted deterministic test execution",
      candidateBatchSize: 7,
      mergeFanIn: 3,
      candidateRunDirectory: resumeDirectory,
      maximumCandidateEvaluations: 60,
    });
    if (resumed.summaries.every((summary) => summary.executionStatus === "complete")) break;
    assert.equal(resumed.points.length, 0, "Partial candidate runs cannot emit placements");
    assert.match(resumed.summaries[0]!.execution.exhaustionReason ?? "", /retains resumable work/u);
  }
  assert.ok(resumed);
  assert.deepEqual(resumed.points, result.points);
  assert.equal(existsSync(resumeDirectory), true, "The policy-owned checkpoint root remains");
  assert.deepEqual(readdirSync(resumeDirectory), [], "Completed logical runs remove checkpoints");
  assert.equal(new Set(result.points.map((p) => p.id)).size, 2);
  for (let i = 0; i < result.points.length; i++)
    for (let j = i + 1; j < result.points.length; j++)
      assert.ok(
        Math.hypot(
          result.points[i]!.x - result.points[j]!.x,
          result.points[i]!.z - result.points[j]!.z,
        ) >= 2,
      );
  assert.deepEqual(
    result.points,
    run([
      { ...first, targetCount: 500 },
      { ...second, targetCount: 500 },
    ]).points,
  );
  const refused = distributeVegetation([first], {
    seed: 4,
    initialCanopy: [],
    executionPolicy: TEST_VEGETATION_EXECUTION_POLICY,
    heightAt: () => 0,
    place: () => undefined,
  });
  assert.equal(refused[0]!.trials, 162);
  assert.equal(refused[0]!.placed, 0);
  const exhausted = run(
    [
      {
        ...first,
        boundary: [
          { u: 0, v: 0 },
          { u: 10000, v: 0 },
          { u: 10000, v: 10000 },
          { u: 0, v: 10000 },
        ],
      },
    ],
    {
      policyId: "ExhaustedVegetationTest",
      origin: "Deliberately small allocation used to verify resumable exhaustion",
      candidateBatchSize: 64,
      mergeFanIn: 4,
      candidateRunDirectory: ".basalt/test-runtime/exhausted-vegetation-runs",
      maximumCandidateEvaluations: 1_000,
    },
  );
  assert.equal(exhausted.points.length, 0);
  assert.equal(exhausted.summaries[0]!.executionStatus, "resource_exhausted");
  assert.equal(exhausted.summaries[0]!.trials, 50_000_000);
});

test("undergrowth responds only to accepted canopy, with authored open-ground preferences", () => {
  const trees = intent("TreesCanopy");
  const fern = intent("Ferns", "understory");
  fern.vegetation.canopyIntentIds = [trees.intentId];
  fern.vegetation.canopyResponse = { open: 0, covered: 1 };
  const run = (acceptTrees: boolean) => {
    const canopy: RealizedInstance[] = [];
    let understory = 0;
    const result = distributeVegetation([fern, trees], {
      seed: 4,
      initialCanopy: [],
      executionPolicy: TEST_VEGETATION_EXECUTION_POLICY,
      heightAt: () => 0,
      place: (plant, p) => {
        if (plant.intentId === trees.intentId && !acceptTrees) return undefined;
        if (plant.intentId === fern.intentId) {
          assert.ok(canopyInfluenceAt(canopy, p.x, p.z) > 0);
          understory++;
        }
        const instance = accepted(plant.intentId, p.x, p.z);
        if (plant.intentId === trees.intentId) canopy.push(instance);
        return instance;
      },
    });
    return { result, understory };
  };
  assert.equal(run(false).understory, 0);
  assert.ok(run(true).understory > 10);
});

test("hard clearings and slope limits survive high budgets; vegetation contracts reject invalid lineage", async () => {
  const plant = intent();
  const clearing = { min: { x: 5, y: -1, z: 5 }, max: { x: 15, y: 5, z: 15 } };
  plant.vegetation.clearings = [hardClearing(clearing, 2)];
  const positions: Array<{ x: number; z: number }> = [];
  distributeVegetation([plant], {
    seed: 1,
    initialCanopy: [],
    executionPolicy: TEST_VEGETATION_EXECUTION_POLICY,
    heightAt: () => 0,
    place: (_, p) => {
      positions.push(p);
      return accepted("Canopy", p.x, p.z);
    },
  });
  assert.ok(positions.length > 0);
  assert.ok(positions.every((p) => p.x < 5 || p.x > 15 || p.z < 5 || p.z > 15));
  assert.equal(
    distributeVegetation([plant], {
      seed: 1,
      initialCanopy: [],
      executionPolicy: TEST_VEGETATION_EXECUTION_POLICY,
      heightAt: (_, x) => 2 * x,
      place: () => {
        throw new Error("Slope should reject before placement");
      },
    })[0]!.placed,
    0,
  );
  assert.throws(() => REALIZATION_INTENT_SCHEMA.parse({ ...plant, densityField: undefined }));
  assert.throws(() =>
    REALIZATION_INTENT_SCHEMA.parse({
      ...plant,
      vegetation: { ...plant.vegetation, spacingMeters: { minimum: 4, maximum: 2 } },
    }),
  );
  const fixture = await worldFixture(await loadSemanticRegistry());
  const { kind: _kind, coordinateSystem: _coordinate, planHash: _hash, ...body } = fixture.plan;
  const fern = intent("Ferns", "understory");
  fern.vegetation.canopyIntentIds = ["AbsentTree"];
  assert.throws(
    () => sealSpatialWorldPlan({ ...body, realizationIntents: [fern] }),
    /unavailable canopy/,
  );
});

test("organic clearings exclude vegetation with the same deterministic mask used by terrain paint", () => {
  const plant = intent();
  const mask = {
    polygon: [
      { x: 5, z: 5 },
      { x: 15, z: 5 },
      { x: 15, z: 15 },
      { x: 5, z: 15 },
    ],
    edgeProfile: {
      kind: "organic" as const,
      seed: 91_337,
      wavelengthMeters: 4.5,
      displacementMeters: 1.75,
    },
  };
  plant.vegetation.clearings = [
    {
      mask,
      verticalRangeMeters: { minimum: -1, maximum: 5 },
      falloffMeters: 0,
    },
  ];
  const positions: Array<{ x: number; z: number }> = [];
  distributeVegetation([plant], {
    seed: 1,
    initialCanopy: [],
    executionPolicy: TEST_VEGETATION_EXECUTION_POLICY,
    heightAt: () => 0,
    place: (_, point) => {
      positions.push(point);
      return accepted("Canopy", point.x, point.z);
    },
  });
  assert.ok(positions.length > 0);
  assert.ok(
    positions.every((point) => !horizontalMaskContainsPoint(mask, point)),
    "Accepted plant origins must stay outside the resolved organic activity-space boundary",
  );
});

test("plant support probes the rotated bottom footprint, rejects excessive relief, and embeds shallowly", () => {
  const geometry = sealAssetPlacementGeometry({
    assetHash: contentHash("asset"),
    sourceContentHash: contentHash("source"),
    geometryHash: contentHash("mesh"),
    bands: [{ min: { x: -1, y: 0, z: -0.1 }, max: { x: 1, y: 0.3, z: 0.1 } }],
  });
  const input = {
    geometry,
    x: 10,
    z: 0,
    yawRadians: 0,
    maximumReliefMeters: 0.25,
    embedMeters: 0.025,
    heightAt: (x: number) => 0.1 * x,
  };
  assert.ok(Math.abs(vegetationGroundElevation(input)! - 0.875) < 1e-9);
  assert.equal(vegetationGroundElevation({ ...input, maximumReliefMeters: 0.15 }), undefined);
  assert.ok(
    vegetationGroundElevation({ ...input, maximumReliefMeters: 0.15, yawRadians: Math.PI / 2 }) !==
      undefined,
  );
  assert.equal(vegetationGroundElevation({ ...input, heightAt: () => NaN }), undefined);
});

test("triangle bands cover face interiors between vertices, allow space below crowns, and retain trunks", () => {
  const mesh: NormalizedMesh = {
    vertices: [
      { x: -0.2, y: 0, z: -0.2 },
      { x: 0.2, y: 0, z: 0.2 },
      { x: 0.2, y: 4, z: 0.2 },
      { x: -3, y: 3, z: -3 },
      { x: 3, y: 3, z: -3 },
      { x: 0, y: 4, z: 3 },
    ],
    triangles: [
      [0, 1, 2],
      [3, 4, 5],
    ],
  };
  const bands = measureTriangleHeightBands(mesh);
  assert.ok(bands.length > 5);
  for (const triangle of mesh.triangles)
    for (let a = 0; a <= 20; a++)
      for (let b = 0; b <= 20 - a; b++) {
        const p = { x: 0, y: 0, z: 0 };
        const weights = [a / 20, b / 20, 1 - (a + b) / 20];
        for (let i = 0; i < 3; i++)
          for (const axis of ["x", "y", "z"] as const)
            p[axis] += mesh.vertices[triangle[i]!]![axis] * weights[i]!;
        assert.ok(
          bands.some((box) =>
            ["x", "y", "z"].every(
              (axis) =>
                p[axis as keyof typeof p] >= box.min[axis as keyof typeof p] &&
                p[axis as keyof typeof p] <= box.max[axis as keyof typeof p],
            ),
          ),
        );
      }
  const occupancy = new OccupancyIndex();
  occupancy.reserve(
    sealOccupancyReservation({
      sourceInstanceId: "Tree",
      surfaceId: "Ground",
      stratum: "plant",
      bounds: { min: { x: -3.01, y: -0.01, z: -3.01 }, max: { x: 3.01, y: 4.01, z: 3.01 } },
      collisionEvidenceHash: contentHash("synthetic mesh"),
      narrowPhaseObbs: bands.map(({ min, max }) => ({
        center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
        halfSize: { x: (max.x - min.x) / 2, y: (max.y - min.y) / 2, z: (max.z - min.z) / 2 },
        rotation: [0, 0, 0, 1],
      })),
    }),
  );
  const probe = (x: number) =>
    sealOccupancyReservation({
      sourceInstanceId: "Shrub",
      surfaceId: "Ground",
      stratum: "plant",
      bounds: { min: { x: x - 0.3, y: 0, z: -0.3 }, max: { x: x + 0.3, y: 1, z: 0.3 } },
    });
  assert.equal(occupancy.conflicts(probe(1)).length, 0);
  assert.equal(occupancy.conflicts(probe(0)).length, 1);
});

test("placement geometry retains every measured height band beyond former collection ceilings", () => {
  const mesh: NormalizedMesh = {
    vertices: [
      { x: -0.5, y: 0, z: -0.5 },
      { x: 0.5, y: 0, z: 0.5 },
      { x: 0, y: 100, z: 0 },
    ],
    triangles: [[0, 1, 2]],
  };
  const bands = measureTriangleHeightBands(mesh);
  assert.ok(bands.length > 64);
  assert.ok(bands[0]!.min.y <= 0 && bands[0]!.min.y >= -1e-6);
  assert.ok(bands.at(-1)!.max.y >= 100 && bands.at(-1)!.max.y <= 100 + 1e-6);
});

test("compiler requires measured plant geometry, preserves route and clearing extents, binds hashes, and reports unmet minima", async () => {
  const semanticModule = await loadSemanticRegistry();
  const fixture = await worldFixture(semanticModule);
  const { kind: _kind, coordinateSystem: _coordinates, planHash: _hash, ...body } = fixture.plan;
  const plant = intent();
  plant.vegetation.clearings = [
    hardClearing({ min: { x: 6, y: -1, z: 6 }, max: { x: 13, y: 4, z: 13 } }, 0),
  ];
  const geometry = sealAssetPlacementGeometry({
    assetHash: fixture.asset.hash,
    sourceContentHash: fixture.asset.source.contentHash,
    geometryHash: fixture.asset.geometryHash,
    bands: [{ min: { x: -0.5, y: 0, z: -0.5 }, max: { x: 0.5, y: 2, z: 0.5 } }],
  });
  const compile = (intents: VegetationIntent[], placementGeometry = [geometry]) =>
    compileBasaltWorld({
      semanticModule,
      catalogSnapshot: fixture.snapshot,
      catalogAssets: [fixture.asset],
      spatialPlan: sealSpatialWorldPlan({ ...body, realizationIntents: intents }),
      placementGeometry,
      executionPolicy: TEST_WORLD_EXECUTION_POLICY,
    });
  const world = compile([plant]);
  assert.equal(world.status, "eligible", world.diagnostics.join("; "));
  assert.ok(world.instances.length > 0);
  for (const instance of world.instances) {
    const b = instance.boundsMeters;
    assert.ok(b.max.x <= 6 || b.min.x >= 13 || b.max.z <= 6 || b.min.z >= 13);
    assert.ok(b.min.z >= 2.5);
    assert.ok(instance.evidenceHashes.includes(geometry.hash));
  }
  assert.equal(world.worldBuildHash, compile([plant]).worldBuildHash);
  assert.equal(compile([plant], []).status, "incomplete");
  assert.equal(compile([{ ...plant, minimumCount: 100 }]).status, "incomplete");
  assert.throws(
    () =>
      compile(
        [plant],
        [
          sealAssetPlacementGeometry({
            assetHash: contentHash("stale"),
            sourceContentHash: geometry.sourceContentHash,
            geometryHash: geometry.geometryHash,
            bands: geometry.bands,
          }),
        ],
      ),
    /bound to/,
  );
  assert.throws(
    () => measureAssetPlacementGeometry(new Uint8Array([1, 2]), fixture.asset),
    /source hash/,
  );
});
