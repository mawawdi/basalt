import test from "node:test";
import assert from "node:assert/strict";
import { contentHash, stableJson } from "../packages/contracts/src/index.js";
import {
  attachInstancesToPopulation,
  chunkRoomGraphContent,
  compileBasaltWorldFoundation,
  createBasaltWorldEmission,
  createBasaltWorldCompilerPlan,
  planRooms,
  populateBasaltWorld,
  sealWorldPopulationArtifact,
  type GroundingEvidenceFile,
  type WorldFamilyPopulationPlan,
  type WorldPopulationInstance,
} from "../packages/world-compiler/src/index.js";
import { productionWorldPlanFixture } from "./helpers/production-world-fixtures.js";
import { groundingEvidenceFixture } from "./helpers/grounding-evidence.js";
import { testKit, testProgram, testRecipe } from "./helpers/room-fixtures.js";

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
            footprint: { contactRadiusStuds: 0.5, restYStuds: 0, dropsStuds: [0, 0, 0, 0] },
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
            footprint: { contactRadiusStuds: 0.5, restYStuds: 0, dropsStuds: [0, 0, 0, 0] },
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
  const population = populateBasaltWorld(foundation, plan, {
    groundingEvidence: groundingEvidenceFixture("basaltFoliage", 1),
  });
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
  const population = populateBasaltWorld(foundation, plan, {
    groundingEvidence: groundingEvidenceFixture("basaltFoliage", 1),
  });
  const first = createBasaltWorldEmission(foundation, population, 64);
  const second = createBasaltWorldEmission(foundation, population, 64);
  assert.deepEqual(first, second);
  assert.equal(first.kind, "BasaltWorldEmissionManifest");
  assert.ok(first.chunks.length > 0);
  assert.ok(first.chunks.every((chunk) => chunk.transactionId.startsWith("basalt_tx_")));
  assert.ok(first.chunks.every((chunk) => chunk.surfaceIds.includes("basaltTerrain")));
  assert.ok(first.chunks.every((chunk) => chunk.stairIds.length === 0));
  assert.ok(first.chunks.every((chunk) => chunk.portalIds.length === 0));
});

test("Basalt attaches assembly instances to the sealed population", () => {
  const foundation = compileBasaltWorldFoundation(fixture());
  const plan = createBasaltWorldCompilerPlan({
    foundation,
    styleContractHash: contentHash("basalt-style"),
    familyPlans: [familyPlan()],
  });
  const population = populateBasaltWorld(foundation, plan, {
    groundingEvidence: groundingEvidenceFixture("basaltFoliage", 1),
  });
  assert.deepEqual(attachInstancesToPopulation(population, []), population);
  const home = population.chunks[0]!.chunkId;
  const extra: WorldPopulationInstance[] = [
    {
      id: "asm_test_home_00",
      familyId: "family_test_huts",
      archetypeId: "family_test_huts_archetype_0",
      chunkId: home,
      position: { x: 1, y: 0, z: 2 },
      rotation: [0, 0, 0, 1],
      scale: 1,
      footprint: { contactRadiusStuds: 1, restYStuds: 0, dropsStuds: [0, 0, 0, 0] },
    },
    {
      id: "asm_test_far_00",
      familyId: "family_test_huts",
      archetypeId: "family_test_huts_archetype_0",
      chunkId: "chunk_9_9",
      position: { x: 1153, y: 0, z: 1154 },
      rotation: [0, 0, 0, 1],
      scale: 1,
      footprint: { contactRadiusStuds: 1, restYStuds: 0, dropsStuds: [0, 0, 0, 0] },
    },
  ];
  const merged = attachInstancesToPopulation(population, extra);
  assert.equal(merged.instanceCount, population.instanceCount + 2);
  assert.equal(merged.worldPlanHash, population.worldPlanHash);
  assert.equal(merged.populationPlanHash, population.populationPlanHash);
  const homeChunk = merged.chunks.find((chunk) => chunk.chunkId === home)!;
  assert.ok(homeChunk.familyIds.includes("family_test_huts"));
  assert.ok(homeChunk.instances.some((instance) => instance.id === "asm_test_home_00"));
  const farChunk = merged.chunks.find((chunk) => chunk.chunkId === "chunk_9_9")!;
  assert.deepEqual(farChunk.familyIds, ["family_test_huts"]);
  assert.throws(() => attachInstancesToPopulation(merged, extra), /already carries instance/);
});

test("Basalt emission deltas carry chunked room stairs and portals", () => {
  const foundation = compileBasaltWorldFoundation(fixture());
  const plan = createBasaltWorldCompilerPlan({
    foundation,
    styleContractHash: contentHash("basalt-style"),
    familyPlans: [familyPlan()],
  });
  const population = populateBasaltWorld(foundation, plan, {
    groundingEvidence: groundingEvidenceFixture("basaltFoliage", 1),
  });
  const graph = planRooms(testRecipe(), testKit(), testProgram(), { regionId: "basaltRegion" });
  const rooms = chunkRoomGraphContent([graph], 64);
  const manifest = createBasaltWorldEmission(foundation, population, 64, [], rooms);
  const stairId = "roomgraph_recipe_test_rooms_00_stair_00_01";
  const delta = manifest.chunks.find((chunk) => chunk.stairIds.includes(stairId))!;
  assert.deepEqual(delta.stairIds, [stairId]);
  assert.deepEqual(delta.portalIds, [
    "roomgraph_recipe_test_rooms_00_portal_00_00",
    "roomgraph_recipe_test_rooms_00_portal_00_en",
    "roomgraph_recipe_test_rooms_00_portal_01_00",
  ]);
  assert.ok(delta.bounds.minimum.x <= 1 && delta.bounds.maximum.x >= 3);
  assert.ok(delta.bounds.minimum.z <= -4 && delta.bounds.maximum.z >= 4);
  assert.ok(delta.bounds.maximum.y >= 6);
});

test("Basalt spacing separates contact discs across families", () => {
  const foundation = compileBasaltWorldFoundation(fixture());
  const trunkPlan: WorldFamilyPopulationPlan = {
    ...familyPlan(),
    familyId: "basaltTrunks",
    minimumCount: 6,
    maximumCount: 6,
    variationSeed: 11,
  };
  const plan = createBasaltWorldCompilerPlan({
    foundation,
    styleContractHash: contentHash("basalt-style"),
    familyPlans: [familyPlan(), trunkPlan],
  });
  const foliage = groundingEvidenceFixture("basaltFoliage", 1);
  const trunks = groundingEvidenceFixture("basaltTrunks", 1);
  const population = populateBasaltWorld(foundation, plan, {
    groundingEvidence: { ...foliage, evidence: [...foliage.evidence, ...trunks.evidence] },
  });
  const instances = population.chunks.flatMap((chunk) => chunk.instances);
  assert.ok(instances.some((instance) => instance.familyId === "basaltFoliage"));
  assert.ok(instances.some((instance) => instance.familyId === "basaltTrunks"));
  // Fixture evidence is rebased, so origins coincide with contact patches.
  for (let left = 0; left < instances.length; left += 1) {
    for (let right = left + 1; right < instances.length; right += 1) {
      const a = instances[left]!;
      const b = instances[right]!;
      const clearance = Math.max(0.5 * a.scale, 0.25) + Math.max(0.5 * b.scale, 0.25);
      const distance = Math.hypot(a.position.x - b.position.x, a.position.z - b.position.z);
      assert.ok(distance + 1e-9 >= clearance);
    }
  }
});

test("Basalt population keeps support footprints over the surface", () => {
  const foundation = compileBasaltWorldFoundation(fixture());
  const slabs: WorldFamilyPopulationPlan = {
    ...familyPlan(),
    familyId: "basaltSlabs",
    minimumCount: 4,
    maximumCount: 6,
    variationSeed: 21,
  };
  const poles: WorldFamilyPopulationPlan = {
    ...familyPlan(),
    familyId: "basaltPoles",
    minimumCount: 6,
    maximumCount: 6,
    variationSeed: 22,
  };
  const plan = createBasaltWorldCompilerPlan({
    foundation,
    styleContractHash: contentHash("basalt-style"),
    familyPlans: [slabs, poles],
  });
  const evidence = {
    kind: "BasaltFamilyGroundingEvidence",
    abi: "basalt-family-grounding-evidence@1",
    inventoryHash: "0".repeat(64),
    evidence: [
      {
        familyId: "basaltSlabs",
        archetypes: [
          {
            assetId: "basaltSlabs_asset_0",
            boundsMinimumStuds: { x: -9, y: 0, z: -9 },
            boundsMaximumStuds: { x: 9, y: 0.5, z: 9 },
            contactRadiusStuds: 0.1,
          },
        ],
      },
      {
        familyId: "basaltPoles",
        archetypes: [
          {
            assetId: "basaltPoles_asset_0",
            boundsMinimumStuds: { x: -13, y: 0, z: -10 },
            boundsMaximumStuds: { x: 13, y: 44, z: 10 },
            contactRadiusStuds: 0.2,
          },
        ],
      },
    ],
  } as unknown as GroundingEvidenceFile;
  const first = populateBasaltWorld(foundation, plan, { groundingEvidence: evidence });
  const second = populateBasaltWorld(foundation, plan, { groundingEvidence: evidence });
  assert.deepEqual(first, second);
  const instances = first.chunks.flatMap((chunk) => chunk.instances);
  const byFamily = (familyId: string) => instances.filter((i) => i.familyId === familyId);
  assert.equal(byFamily("basaltSlabs").length, 4);
  assert.equal(byFamily("basaltPoles").length, 6);
  // Full-quaternion render math, independent of the yaw-only gate: evidence
  // bounds are rebased (pivot at the bounds-frame origin), so corners render
  // at position + R(corner * scale) with no pivot compensation, and must stay
  // over the ±30 fixture surface.
  const rotate = (q: readonly number[], p: { x: number; y: number; z: number }) => {
    const [qx, qy, qz, qw] = q;
    return {
      x:
        (1 - 2 * (qy! * qy! + qz! * qz!)) * p.x +
        2 * (qx! * qy! - qz! * qw!) * p.y +
        2 * (qx! * qz! + qy! * qw!) * p.z,
      z:
        2 * (qx! * qz! - qy! * qw!) * p.x +
        2 * (qy! * qz! + qx! * qw!) * p.y +
        (1 - 2 * (qx! * qx! + qy! * qy!)) * p.z,
    };
  };
  for (const instance of byFamily("basaltSlabs")) {
    for (const cx of [-9, 9])
      for (const cz of [-9, 9]) {
        const corner = rotate(instance.rotation, {
          x: cx * instance.scale,
          y: 0,
          z: cz * instance.scale,
        });
        const x = instance.position.x + corner.x;
        const z = instance.position.z + corner.z;
        assert.ok(
          x >= -30 - 1e-9 && x <= 30 + 1e-9 && z >= -30 - 1e-9 && z <= 30 + 1e-9,
          `slab corner renders past the surface at ${x}, ${z}`,
        );
      }
  }
  for (const instance of byFamily("basaltPoles")) {
    // Rebased bounds put the contact disk at the sealed position verbatim.
    const radius = 0.2 * instance.scale;
    assert.ok(
      instance.position.x - radius >= -30 - 1e-9 &&
        instance.position.x + radius <= 30 + 1e-9 &&
        instance.position.z - radius >= -30 - 1e-9 &&
        instance.position.z + radius <= 30 + 1e-9,
      `pole contact disk leaves the surface at ${instance.position.x}, ${instance.position.z}`,
    );
  }
});

test("Basalt elevation bands admit and refuse by sample height", () => {
  const foundation = compileBasaltWorldFoundation(fixture());
  const run = (band?: { minimum?: number; maximum?: number }) => {
    const plan = createBasaltWorldCompilerPlan({
      foundation,
      styleContractHash: contentHash("basalt-style"),
      familyPlans: [{ ...familyPlan(), ...(band ? { elevationBandStuds: band } : {}) }],
    });
    return populateBasaltWorld(foundation, plan, {
      groundingEvidence: groundingEvidenceFixture("basaltFoliage", 1),
    });
  };
  const open = run();
  const placed = (pop: ReturnType<typeof run>) => pop.chunks.flatMap((chunk) => chunk.instances);
  // The flat fixture rests at 0: a covering band places the same count
  // (ids differ: instance ids key on the plan hash, which covers the band).
  const covered = run({ minimum: -1, maximum: 1 });
  assert.equal(covered.instanceCount, open.instanceCount);
  for (const instance of placed(covered))
    assert.ok(
      instance.footprint.restYStuds >= -1 && instance.footprint.restYStuds <= 1,
      `banded instance escapes its band at ${instance.footprint.restYStuds}`,
    );
  assert.equal(run({ minimum: 1 }).instanceCount, 0);
  assert.equal(run({ maximum: -1 }).instanceCount, 0);
  assert.ok(open.instanceCount > 0, "open run must place to prove the bands refuse");
});

test("Basalt rejects inverted elevation bands at plan time", () => {
  const foundation = compileBasaltWorldFoundation(fixture());
  assert.throws(
    () =>
      createBasaltWorldCompilerPlan({
        foundation,
        styleContractHash: contentHash("basalt-style"),
        familyPlans: [{ ...familyPlan(), elevationBandStuds: { minimum: 2, maximum: 1 } }],
      }),
    /elevation band is inverted/,
  );
});

test("Basalt cluster distribution fills counts deterministically", () => {
  const foundation = compileBasaltWorldFoundation(fixture());
  const clustered: WorldFamilyPopulationPlan = {
    ...familyPlan(),
    distribution: "cluster",
    minimumCount: 12,
    maximumCount: 12,
  };
  const plan = createBasaltWorldCompilerPlan({
    foundation,
    styleContractHash: contentHash("basalt-style"),
    familyPlans: [clustered],
  });
  const options = { groundingEvidence: groundingEvidenceFixture("basaltFoliage", 1) };
  const first = populateBasaltWorld(foundation, plan, options);
  const second = populateBasaltWorld(foundation, plan, options);
  assert.deepEqual(first, second);
  assert.equal(first.instanceCount, 12);
});
