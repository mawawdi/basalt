import assert from "node:assert/strict";
import test from "node:test";
import { contentHash } from "../packages/contracts/src/index.js";
import { compareSpatialStrings } from "../packages/spatial-core/src/index.js";
import { BasaltStudioBridge } from "../packages/studio-bridge/src/index.js";
import type { RoadSegment } from "../packages/world-planning/src/index.js";
import {
  compileHierarchicalWorld,
  sealWorldAssetFamilyRegistry,
} from "../packages/world-compiler/src/index.js";
import { productionWorldPlanFixture } from "./helpers/production-world-fixtures.js";
import { groundingEvidenceFixture } from "./helpers/grounding-evidence.js";

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
    population: { groundingEvidence: groundingEvidenceFixture("FamilyGroundCover", 3) },
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

test("Basalt assembles route roads and binds segments to partition chunks", () => {
  const compile = () =>
    compileHierarchicalWorld({
      worldPlan: productionWorldPlanFixture({
        sceneId: "roadWorld",
        regionId: "roadRegion",
        surfaceId: "roadTerrain",
        routeId: "roadRoute",
        anchorId: "roadAnchor",
        cameraId: "roadCamera",
        materialId: "roadMaterial",
        name: "A road-bound world",
      }),
      styleContractHash: contentHash("style"),
      familyRegistry: sealWorldAssetFamilyRegistry([
        {
          familyId: "FamilyGroundCover",
          semanticTags: ["ground-cover"],
          styleTags: ["coherent"],
          roleTags: ["scatter"],
          variantCount: 3,
        },
      ]),
      familyRequests: [
        {
          biomeId: "roadRegion",
          semanticTags: ["ground-cover"],
          styleTags: ["coherent"],
          roleTags: ["scatter"],
          minimumFamilies: 1,
          maximumFamilies: 1,
          regionIds: ["roadRegion"],
          surfaceKinds: ["terrain"],
          maximumCount: 20,
          density: { minimum: 0.1, target: 0.4, maximum: 0.8 },
        },
      ],
      stage: "partition",
      population: { groundingEvidence: groundingEvidenceFixture("FamilyGroundCover", 3) },
    });
  const first = compile();
  const second = compile();
  assert.deepEqual(first.roadAssemblies, second.roadAssemblies);
  const roadBindings = (world: typeof first) =>
    world
      .partitionEmission!.chunks.map((chunk) => ({
        chunkId: chunk.chunkId,
        roadSegmentIds: chunk.roadSegmentIds,
      }))
      .sort((left, right) => compareSpatialStrings(left.chunkId, right.chunkId));
  assert.deepEqual(roadBindings(first), roadBindings(second));
  assert.ok(first.roadAssemblies);
  assert.equal(first.roadAssemblies.length, 1);
  assert.equal(first.roadAssemblies[0]!.routeId, "roadRoute");
  assert.ok(first.partitionEmission);
  const boundRoads = first.partitionEmission.chunks.flatMap((chunk) => chunk.roadSegmentIds);
  const allSegments: RoadSegment[] = first.roadAssemblies.flatMap((road) => road.segments);
  const assembledRoads = allSegments.map((segment) => segment.id);
  assert.deepEqual([...boundRoads].sort(), [...assembledRoads].sort());
  for (const chunk of first.partitionEmission.chunks) {
    for (const segmentId of chunk.roadSegmentIds) {
      const segment = allSegments.find((candidate) => candidate.id === segmentId)!;
      assert.equal(segment.chunkId, chunk.chunkId);
    }
  }
  const bridge = new BasaltStudioBridge();
  bridge.enqueueManifest(first.partitionEmission, contentHash("revision"));
  const transaction = bridge.nextTransaction()!;
  assert.deepEqual(
    [...transaction.roadSegmentIds].sort(),
    [...first.partitionEmission.chunks[0]!.roadSegmentIds].sort(),
  );
  const readback = bridge.createReadback(transaction, "preflighted", contentHash("revision"));
  bridge.settle(transaction, readback);
  assert.equal(bridge.nextTransaction()!.phase, "apply");
});
