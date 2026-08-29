import assert from "node:assert/strict";
import test from "node:test";
import { contentHash } from "../packages/contracts/src/index.js";
import {
  compileHierarchicalWorld,
  sealWorldAssetFamilyRegistry,
} from "../packages/world-compiler/src/index.js";
import { productionWorldPlanFixture } from "./helpers/production-world-fixtures.js";

test("Basalt can stop after the macro foundation while workers are offline", () => {
  const world = compileHierarchicalWorld({
    worldPlan: productionWorldPlanFixture({
      sceneId: "macroWorld",
      regionId: "macroRegion",
      surfaceId: "macroTerrain",
      routeId: "macroRoute",
      anchorId: "macroAnchor",
      cameraId: "macroCamera",
      materialId: "macroMaterial",
      name: "A macro world",
    }),
    styleContractHash: contentHash("style"),
    stage: "macro",
  });
  assert.equal(world.kind, "BasaltHierarchicalWorld");
  assert.equal(world.mesoPlan, undefined);
  assert.equal(world.microPopulation, undefined);
  assert.equal(world.partitionEmission, undefined);
});

test("Basalt resolves families once, then emits deterministic partition deltas", () => {
  const worldPlan = productionWorldPlanFixture({
    sceneId: "partitionWorld",
    regionId: "partitionRegion",
    surfaceId: "partitionTerrain",
    routeId: "partitionRoute",
    anchorId: "partitionAnchor",
    cameraId: "partitionCamera",
    materialId: "partitionMaterial",
    name: "A partition world",
  });
  const registry = sealWorldAssetFamilyRegistry([
    {
      familyId: "FamilyGroundCover",
      semanticTags: ["ground-cover"],
      styleTags: ["coherent"],
      roleTags: ["scatter"],
      variantCount: 3,
    },
  ]);
  const world = compileHierarchicalWorld({
    worldPlan,
    styleContractHash: contentHash("style"),
    familyRegistry: registry,
    familyRequests: [
      {
        biomeId: "partitionRegion",
        semanticTags: ["ground-cover"],
        styleTags: ["coherent"],
        roleTags: ["scatter"],
        minimumFamilies: 1,
        maximumFamilies: 1,
        regionIds: ["partitionRegion"],
        surfaceKinds: ["terrain"],
        maximumCount: 20,
        density: { minimum: 0.1, target: 0.4, maximum: 0.8 },
      },
    ],
    stage: "partition",
  });
  assert.ok(world.mesoPlan);
  assert.ok(world.microPopulation);
  assert.ok(world.partitionEmission);
  assert.ok(world.partitionEmission.chunks.length > 0);
  assert.ok(
    world.microPopulation.chunks
      .flatMap((chunk) => chunk.instances)
      .every((instance) => instance.archetypeId.startsWith("FamilyGroundCover_archetype_")),
  );
});
