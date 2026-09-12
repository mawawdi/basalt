import test from "node:test";
import assert from "node:assert/strict";
import {
  briefMissedFamilyFactoryJobs,
  type FactoryMissBrief,
} from "../packages/world-compiler/src/factory-dispatch.js";
import {
  assertNeuralFamilyFactoryBatchIdentity,
  sealNeuralFamilyFactoryBatch,
} from "../packages/neural-asset/src/factory.js";
import { contentHash, stableJson } from "../packages/contracts/src/index.js";

const styleContractHash = contentHash(stableJson({ style: "test" }));
const worldPlanHash = contentHash("test-world-plan");

function miss(overrides: Partial<FactoryMissBrief> = {}): FactoryMissBrief {
  return {
    regionId: "grotto",
    role: "focal_insert",
    suggestedHandle: "props/focal_insert/stylized_low_poly/grotto_lanterns",
    boundingEnvelopeStuds: [2, 3, 1] as const,
    targetTexelDensity: 16,
    minArchetypeCount: 3,
    surfaceAffinity: "terrain",
    provider: "trellis2",
    referenceHash: contentHash("reference"),
    seed: 7,
    ...overrides,
  };
}

test("a focal miss queues one job per archetype with no instance transforms", () => {
  const briefed = briefMissedFamilyFactoryJobs({
    miss: miss(),
    worldPlanHash,
    styleContractHash,
  });
  assert.equal(briefed.requirement.requirement_id, "explore_grotto_focal_insert");
  assert.equal(briefed.jobs.length, 3);
  assert.deepEqual(
    briefed.jobs.map((job) => job.archetypeOrdinal),
    [0, 1, 2],
  );
  assert.ok(briefed.jobs.every((job) => job.status === "queued"));
  assert.ok(briefed.jobs.every((job) => !("position" in job)));
  const batch = sealNeuralFamilyFactoryBatch({
    worldPlanHash,
    styleContractHash,
    jobs: briefed.jobs,
  });
  assertNeuralFamilyFactoryBatchIdentity(batch);
});

test("an oversize miss fails closed naming the procedural route", () => {
  assert.throws(
    () =>
      briefMissedFamilyFactoryJobs({
        miss: miss({ boundingEnvelopeStuds: [9, 3, 1] }),
        worldPlanHash,
        styleContractHash,
      }),
    /procedural AssemblyRecipe/,
  );
});

test("a non-focal miss records its requirement but queues no neural jobs", () => {
  const briefed = briefMissedFamilyFactoryJobs({
    miss: miss({
      role: "canopy",
      suggestedHandle: "foliage/canopy/stylized_low_poly/grotto_palms",
    }),
    worldPlanHash,
    styleContractHash,
  });
  assert.equal(briefed.requirement.spatial_role, "canopy");
  assert.equal(briefed.jobs.length, 0);
});
