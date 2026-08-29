import test from "node:test";
import assert from "node:assert/strict";
import { contentHash } from "../packages/contracts/src/index.js";
import {
  assertNeuralFamilyFactoryBatchIdentity,
  queueNeuralFamilyFactoryJobs,
} from "../packages/neural-asset/src/index.js";

const hash = (value: string) => contentHash(value);

test("neural generation is queued by family and never carries instance transforms", () => {
  const batch = queueNeuralFamilyFactoryJobs({
    worldPlanHash: hash("world"),
    styleContractHash: hash("style"),
    jobs: [
      {
        requirementId: "rock_requirement",
        familyId: "rock_family",
        provider: "trellis2",
        referenceHash: hash("reference"),
        expectedBoundsStuds: { x: 2, y: 3, z: 1 },
        seed: 17,
        archetypeOrdinal: 0,
      },
      {
        requirementId: "rock_requirement",
        familyId: "rock_family",
        provider: "hunyuan3d_2_1",
        referenceHash: hash("reference"),
        expectedBoundsStuds: { x: 2, y: 3, z: 1 },
        seed: 18,
        archetypeOrdinal: 1,
      },
    ],
  });
  assertNeuralFamilyFactoryBatchIdentity(batch);
  assert.equal(batch.jobs.length, 2);
  assert.ok(batch.jobs.every((job) => job.status === "queued"));
  assert.ok(!("position" in batch.jobs[0]!));
});
