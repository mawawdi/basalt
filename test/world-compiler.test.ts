import test from "node:test";
import assert from "node:assert/strict";
import { contentHash, stableJson } from "../packages/contracts/src/index.js";
import {
  compileBasaltWorldFoundation,
  createBasaltWorldEmission,
  createBasaltWorldCompilerPlan,
  populateBasaltWorld,
  sealWorldPopulationArtifact,
  type WorldFamilyPopulationPlan,
} from "../packages/world-compiler/src/index.js";
import { productionWorldPlanFixture } from "./helpers/production-world-fixtures.js";

function fixture() {
  return productionWorldPlanFixture({
    sceneId: "basaltWorld",
    regionId: "basaltRegion",
    surfaceId: "basaltTerrain",
    routeId: "basaltRoute",
    anchorId: "basaltAnchor",
    cameraId: "basaltCamera",
    materialId: "basaltMaterial",
    name: "A layered world compiler fixture",
  });
}

function familyPlan(): WorldFamilyPopulationPlan {
  return {
    familyId: "basaltFoliage",
    regionIds: ["basaltRegion"],
    surfaceKinds: ["terrain"],
    distribution: "poisson_scatter",
    minimumCount: 8,
    maximumCount: 24,
    density: { minimum: 0.1, target: 0.35, maximum: 0.6 },
    variationSeed: 7,
    excludedRouteIds: ["basaltRoute"],
    excludedRegionIds: [],
  };
}

test("Basalt compiles macro world authority before family work", () => {
  const foundation = compileBasaltWorldFoundation(fixture());
  assert.equal(foundation.kind, "BasaltWorldFoundation");
  assert.deepEqual(foundation.regionIds, ["basaltRegion"]);
  assert.deepEqual(foundation.routeIds, ["basaltRoute"]);
  assert.equal(foundation.worldPlanHash.length, 64);
  assert.equal(foundation.surfaceIndexHash.length, 64);
});

test("Basalt family plans are deterministic and region-bound", () => {
  const foundation = compileBasaltWorldFoundation(fixture());
  const first = createBasaltWorldCompilerPlan({
    foundation,
    styleContractHash: contentHash("basalt-style"),
    familyPlans: [familyPlan()],
  });
  const second = createBasaltWorldCompilerPlan({
    foundation,
    styleContractHash: contentHash("basalt-style"),
    familyPlans: [{ ...familyPlan(), regionIds: ["basaltRegion"] }],
  });
  assert.deepEqual(first, second);
  assert.ok(!("createdAt" in first), "sealed plans carry no wall-clock evidence");
  assert.throws(
    () =>
      createBasaltWorldCompilerPlan({
        foundation,
        styleContractHash: contentHash("basalt-style"),
        familyPlans: [{ ...familyPlan(), regionIds: ["unknownRegion"] }],
      }),
    /unknown region/i,
  );
});

test("Basalt population artifact canonicalizes chunks and reuses family handles", () => {
  const worldPlanHash = contentHash("world");
  const populationPlanHash = contentHash("population");
  const artifact = sealWorldPopulationArtifact({
    worldPlanHash,
    populationPlanHash,
    chunks: [
      {
        chunkId: "chunkB",
        familyIds: ["basaltFoliage"],
        instances: [
          {
            id: "instanceB",
            familyId: "basaltFoliage",
            archetypeId: "treeA",
            chunkId: "chunkB",
            position: { x: 1, y: 0, z: 2 },
            rotation: [0, 0, 0, 1],
            scale: 1,
          },
        ],
      },
      {
        chunkId: "chunkA",
        familyIds: ["basaltFoliage"],
        instances: [
          {
            id: "instanceA",
            familyId: "basaltFoliage",
            archetypeId: "treeB",
            chunkId: "chunkA",
            position: { x: 0, y: 0, z: 0 },
            rotation: [0, 0, 0, 1],
            scale: 1.1,
          },
        ],
      },
    ],
  });
  assert.equal(artifact.instanceCount, 2);
  assert.deepEqual(
    artifact.chunks.map((chunk) => chunk.chunkId),
    ["chunkA", "chunkB"],
  );
  assert.equal(stableJson(artifact.chunks[0]!.familyIds), stableJson(["basaltFoliage"]));
});

test("Basalt population resolves families against indexed surfaces", () => {
  const foundation = compileBasaltWorldFoundation(fixture());
  const plan = createBasaltWorldCompilerPlan({
    foundation,
    styleContractHash: contentHash("basalt-style"),
    familyPlans: [familyPlan()],
  });
  const population = populateBasaltWorld(foundation, plan);
  assert.ok(population.instanceCount > 0);
  assert.ok(population.instanceCount <= 24);
  assert.ok(population.chunks.every((chunk) => chunk.familyIds.includes("basaltFoliage")));
  assert.ok(
    population.chunks
      .flatMap((chunk) => chunk.instances)
      .every((instance) => Math.abs(Math.hypot(...instance.rotation) - 1) < 1e-6),
  );
});

test("Basalt lowers population into deterministic connector-sized transaction deltas", () => {
  const foundation = compileBasaltWorldFoundation(fixture());
  const plan = createBasaltWorldCompilerPlan({
    foundation,
    styleContractHash: contentHash("basalt-style"),
    familyPlans: [familyPlan()],
  });
  const population = populateBasaltWorld(foundation, plan);
  const first = createBasaltWorldEmission(foundation, population, 64);
  const second = createBasaltWorldEmission(foundation, population, 64);
  assert.deepEqual(first, second);
  assert.equal(first.kind, "BasaltWorldEmissionManifest");
  assert.ok(first.chunks.length > 0);
  assert.ok(first.chunks.every((chunk) => chunk.transactionId.startsWith("basalt_tx_")));
  assert.ok(first.chunks.every((chunk) => chunk.surfaceIds.includes("basaltTerrain")));
});
