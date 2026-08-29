import test from "node:test";
import assert from "node:assert/strict";
import { contentHash, stableJson } from "../packages/contracts/src/index.js";
import {
  assertBasaltWorldReadback,
  createBasaltWorldReadback,
  createBasaltWorldTransaction,
  reconcileBasaltWorldReadback,
} from "../packages/studio-protocol/src/index.js";
import { BasaltStudioBridge } from "../packages/studio-bridge/src/index.js";

const hash = (value: string) => contentHash(value);

function chunk() {
  const material = {
    kind: "BasaltWorldChunkDelta" as const,
    chunkId: "chunk_a",
    worldPlanHash: hash("world"),
    populationHash: hash("population"),
    surfaceIds: ["terrain_a"],
    instanceIds: ["instance_a"],
    bounds: {
      minimum: { x: 0, y: 0, z: 0 },
      maximum: { x: 8, y: 8, z: 8 },
    },
  };
  const chunkHash = hash(stableJson(material));
  return {
    ...material,
    id: `basalt_chunk_${chunkHash.slice(0, 24)}`,
    transactionId: `basalt_tx_${chunkHash.slice(0, 32)}`,
    hash: chunkHash,
  };
}

test("Basalt connector advances detached preflight, apply, and commit in order", () => {
  const bridge = new BasaltStudioBridge({ maxQueue: 4 });
  const source = chunk();
  const manifestMaterial = {
    kind: "BasaltWorldEmissionManifest" as const,
    abi: "basalt-world-emission@1" as const,
    worldPlanHash: source.worldPlanHash,
    populationHash: source.populationHash,
    chunks: [source],
  };
  const manifest = { ...manifestMaterial, hash: hash(stableJson(manifestMaterial)) };
  bridge.enqueueManifest(manifest, hash("revision"));

  const preflight = bridge.nextTransaction()!;
  const preflightReadback = bridge.createReadback(preflight, "preflighted", hash("revision"));
  bridge.settle(preflight, preflightReadback);
  const apply = bridge.nextTransaction()!;
  const appliedReadback = bridge.createReadback(apply, "applied", hash("revision"));
  bridge.settle(apply, appliedReadback);
  const commit = bridge.nextTransaction()!;
  const committedReadback = bridge.createReadback(commit, "committed", hash("revision"));
  bridge.settle(commit, committedReadback);

  assert.equal(bridge.nextTransaction(), undefined);
  assert.equal(bridge.status().appliedTransactions, 1);
});

test("Basalt world readback rejects a changed Studio revision", () => {
  const transaction = createBasaltWorldTransaction({
    manifestHash: hash("manifest"),
    worldPlanHash: hash("world"),
    chunk: {
      chunkId: "chunk_a",
      worldPlanHash: hash("world"),
      hash: hash("chunk"),
      transactionId: "basalt_tx_a",
      instanceIds: [],
    },
    phase: "apply",
    expectedRevisionHash: hash("revision"),
  });
  const readback = createBasaltWorldReadback({
    transaction,
    phase: "applied",
    observedRevisionHash: hash("changed"),
    observedInstanceIds: [],
  });
  assertBasaltWorldReadback(readback);
  assert.throws(() => reconcileBasaltWorldReadback(transaction, readback, []), /revision changed/i);
});

test("Basalt bridge seals an unsigned Studio observation before advancing", () => {
  const bridge = new BasaltStudioBridge();
  const source = chunk();
  const manifestMaterial = {
    kind: "BasaltWorldEmissionManifest" as const,
    abi: "basalt-world-emission@1" as const,
    worldPlanHash: source.worldPlanHash,
    populationHash: source.populationHash,
    chunks: [source],
  };
  bridge.enqueueManifest(
    { ...manifestMaterial, hash: hash(stableJson(manifestMaterial)) },
    hash("revision"),
  );
  const transaction = bridge.nextTransaction()!;
  bridge.settle(transaction, {
    kind: "BasaltWorldReadbackObservation",
    abi: "basalt-world-readback@1",
    transactionHash: transaction.hash,
    chunkId: transaction.chunkId,
    phase: "preflighted",
    observedRevisionHash: hash("revision"),
    observedInstanceIds: transaction.instanceIds,
  });
  assert.equal(bridge.nextTransaction()!.phase, "apply");
});

test("Basalt bridge rejects an observation from a changed Studio revision", () => {
  const bridge = new BasaltStudioBridge();
  const source = chunk();
  const manifestMaterial = {
    kind: "BasaltWorldEmissionManifest" as const,
    abi: "basalt-world-emission@1" as const,
    worldPlanHash: source.worldPlanHash,
    populationHash: source.populationHash,
    chunks: [source],
  };
  bridge.enqueueManifest(
    { ...manifestMaterial, hash: hash(stableJson(manifestMaterial)) },
    hash("revision"),
  );
  const transaction = bridge.nextTransaction()!;
  assert.throws(
    () =>
      bridge.settle(transaction, {
        kind: "BasaltWorldReadbackObservation",
        abi: "basalt-world-readback@1",
        transactionHash: transaction.hash,
        chunkId: transaction.chunkId,
        phase: "preflighted",
        observedRevisionHash: hash("changed"),
        observedInstanceIds: transaction.instanceIds,
      }),
    /revision changed/i,
  );
});
