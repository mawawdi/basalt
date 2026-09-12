import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentHash, stableJson } from "../packages/contracts/src/index.js";
import {
  assertBasaltWorldReadback,
  createBasaltWorldReadback,
  createBasaltWorldTransaction,
  reconcileBasaltWorldReadback,
  sealVoxelSpotHashes,
} from "../packages/studio-protocol/src/index.js";
import {
  BasaltStudioBridge,
  createBasaltStudioBridgeServer,
} from "../packages/studio-bridge/src/index.js";
import { createHash } from "node:crypto";

const hash = (value: string) => contentHash(value);
const shaBytes = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function sceneExport(bytes: Uint8Array) {
  const material = {
    kind: "BasaltSceneExport" as const,
    abi: "basalt-scene-export@1",
    worldPlanHash: hash("world"),
    populationHash: hash("population"),
    studMeters: 0.28,
    placementConvention: {
      lengthUnit: "meter" as const,
      upAxis: "+Y" as const,
      handedness: "right-handed" as const,
      instanceComposition: "T.R.S",
    },
    instances: [],
    assets: [],
    parts: [],
    terrain: [],
    roads: [],
    skirts: [],
    materialIds: [],
    payloads: [
      {
        contentHash: shaBytes(bytes),
        byteLength: bytes.byteLength,
        mediaType: "model/gltf-binary" as const,
      },
    ],
  };
  return { ...material, hash: hash(stableJson(material)) };
}

/** Minimal valid 1x1x1 BVX field: single cell, one material, full occupancy. */
function tinyVoxelBytes(material = "mat_a", occupancy = 1): Uint8Array {
  const name = new TextEncoder().encode(material);
  const bytes = new Uint8Array(52 + 2 + name.byteLength + 4 + 2);
  const view = new DataView(bytes.buffer);
  bytes.set([0x42, 0x56, 0x58, 0x31], 0);
  view.setUint32(4, 1, true);
  view.setUint32(8, 1, true);
  view.setUint32(12, 1, true);
  view.setFloat64(16, 0, true);
  view.setFloat64(24, 0, true);
  view.setFloat64(32, 0, true);
  view.setFloat64(40, 4, true);
  view.setUint32(48, 1, true);
  view.setUint16(52, name.byteLength, true);
  bytes.set(name, 54);
  view.setFloat32(54 + name.byteLength, occupancy, true);
  view.setUint16(54 + name.byteLength + 4, 0, true);
  return bytes;
}

/** Scene export matching chunk(): terrain_a, instance_a/asset_a, one part. */
function appliedSceneExport(voxelBytes: Uint8Array, partBytes: Uint8Array) {
  const material = {
    kind: "BasaltSceneExport" as const,
    abi: "basalt-scene-export@1",
    worldPlanHash: hash("world"),
    populationHash: hash("population"),
    studMeters: 0.28,
    placementConvention: {
      lengthUnit: "meter" as const,
      upAxis: "+Y" as const,
      handedness: "right-handed" as const,
      instanceComposition: "T.R.S",
    },
    instances: [{ id: "instance_a", assetId: "asset_a" }],
    assets: [{ assetId: "asset_a", partHashes: [shaBytes(partBytes)] }],
    parts: [{ contentHash: shaBytes(partBytes) }],
    terrain: [{ surfaceId: "terrain_a", voxelHash: shaBytes(voxelBytes) }],
    roads: [],
    skirts: [],
    materialIds: ["mat_a"],
    payloads: [
      {
        contentHash: shaBytes(voxelBytes),
        byteLength: voxelBytes.byteLength,
        mediaType: "application/x-basalt-voxels" as const,
      },
      {
        contentHash: shaBytes(partBytes),
        byteLength: partBytes.byteLength,
        mediaType: "model/gltf-binary" as const,
      },
    ],
  };
  return { ...material, hash: hash(stableJson(material)) };
}

function appliedEvidence(partHash: string) {
  return {
    observedVoxelSpots: [
      {
        surfaceId: "terrain_a",
        x: 0,
        y: 0,
        z: 0,
        occupancy: 1,
        material: "Grass",
      },
    ],
    observedImportFactors: [{ contentHash: partHash, factor: 1 }],
  };
}

function materialMapFor(manifestHash: string) {
  return {
    kind: "BasaltMaterialMap" as const,
    abi: "basalt-material-map@1" as const,
    engine: "roblox" as const,
    exportHash: manifestHash,
    bindings: [{ materialId: "mat_a", robloxMaterial: "Grass" }],
  };
}

function chunk() {
  const material = {
    kind: "BasaltWorldChunkDelta" as const,
    chunkId: "chunk_a",
    worldPlanHash: hash("world"),
    populationHash: hash("population"),
    surfaceIds: ["terrain_a"],
    instanceIds: ["instance_a"],
    roadSegmentIds: ["road_a"],
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
  const voxels = tinyVoxelBytes();
  const partBytes = new Uint8Array([7, 7, 7, 7]);
  const scene = appliedSceneExport(voxels, partBytes);
  bridge.enqueueSceneExport(
    scene,
    new Map([
      [shaBytes(voxels), voxels],
      [shaBytes(partBytes), partBytes],
    ]),
  );
  bridge.enqueueMaterialMap(materialMapFor(scene.hash));

  const preflight = bridge.nextTransaction()!;
  const preflightReadback = bridge.createReadback(preflight, "preflighted", hash("revision"));
  bridge.settle(preflight, preflightReadback);
  const apply = bridge.nextTransaction()!;
  const appliedReadback = bridge.createReadback(
    apply,
    "applied",
    hash("revision"),
    appliedEvidence(shaBytes(partBytes)),
  );
  bridge.settle(apply, appliedReadback);
  const commit = bridge.nextTransaction()!;
  const committedReadback = bridge.createReadback(commit, "committed", hash("revision"));
  bridge.settle(commit, committedReadback);

  assert.equal(bridge.nextTransaction(), undefined);
  assert.equal(bridge.status().appliedTransactions, 1);
});

test("Bridge replays applied voxel spots against the sealed payload", () => {
  const setup = () => {
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
    const voxels = tinyVoxelBytes();
    const partBytes = new Uint8Array([7, 7, 7, 7]);
    const scene = appliedSceneExport(voxels, partBytes);
    bridge.enqueueSceneExport(
      scene,
      new Map([
        [shaBytes(voxels), voxels],
        [shaBytes(partBytes), partBytes],
      ]),
    );
    bridge.enqueueMaterialMap(materialMapFor(scene.hash));
    const preflight = bridge.nextTransaction()!;
    bridge.settle(preflight, bridge.createReadback(preflight, "preflighted", hash("revision")));
    return { bridge, partHash: shaBytes(partBytes) };
  };
  const { bridge, partHash } = setup();
  const apply = bridge.nextTransaction()!;
  const good = appliedEvidence(partHash);
  assert.throws(
    () =>
      bridge.settle(
        apply,
        bridge.createReadback(apply, "applied", hash("revision"), {
          ...good,
          observedVoxelSpots: [{ ...good.observedVoxelSpots[0]!, occupancy: 0.5 }],
        }),
      ),
    /reads occupancy 0\.5 against sealed 1/,
  );
  assert.throws(
    () =>
      bridge.settle(
        apply,
        bridge.createReadback(apply, "applied", hash("revision"), {
          ...good,
          observedVoxelSpots: [{ ...good.observedVoxelSpots[0]!, material: "Sand" }],
        }),
      ),
    /reads material Sand against mapped Grass/,
  );
  assert.throws(
    () =>
      bridge.settle(
        apply,
        bridge.createReadback(apply, "applied", hash("revision"), {
          ...good,
          observedVoxelSpots: [],
        }),
      ),
    /do not cover the chunk surfaces/,
  );
  assert.throws(
    () =>
      bridge.settle(
        apply,
        bridge.createReadback(apply, "applied", hash("revision"), {
          ...good,
          observedImportFactors: [],
        }),
      ),
    /do not cover the lowered parts/,
  );
  // Failures never advance the queue: the honest readback still settles.
  bridge.settle(apply, bridge.createReadback(apply, "applied", hash("revision"), good));
  assert.equal(bridge.nextTransaction()!.phase, "commit");
});

test("Bridge enforces sidecar recorded import factors on applied", () => {
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
  const voxels = tinyVoxelBytes();
  const partBytes = new Uint8Array([7, 7, 7, 7]);
  const partHash = shaBytes(partBytes);
  const scene = appliedSceneExport(voxels, partBytes);
  bridge.enqueueSceneExport(
    scene,
    new Map([
      [shaBytes(voxels), voxels],
      [partHash, partBytes],
    ]),
  );
  bridge.enqueueMaterialMap(materialMapFor(scene.hash));
  bridge.enqueueSidecar({
    kind: "BasaltEngineSidecar",
    abi: "basalt-engine-sidecar@1",
    engine: "roblox",
    exportHash: scene.hash,
    bindings: [
      {
        contentHash: partHash,
        assetId: "12345",
        uploadedAt: "2026-09-12T00:00:00.000Z",
        budgets: { triangles: 1, bytes: 4, watertight: false },
        importFactor: 1,
      },
    ],
  });
  const preflight = bridge.nextTransaction()!;
  bridge.settle(preflight, bridge.createReadback(preflight, "preflighted", hash("revision")));
  const apply = bridge.nextTransaction()!;
  const good = appliedEvidence(partHash);
  assert.throws(
    () =>
      bridge.settle(
        apply,
        bridge.createReadback(apply, "applied", hash("revision"), {
          ...good,
          observedImportFactors: [{ contentHash: partHash, factor: 1.05 }],
        }),
      ),
    /drifts past recorded 1/,
  );
  bridge.settle(apply, bridge.createReadback(apply, "applied", hash("revision"), good));
  assert.equal(bridge.nextTransaction()!.phase, "commit");
});

test("Bridge rejects observed evidence outside the applied phase", () => {
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
        observedRevisionHash: hash("revision"),
        observedInstanceIds: transaction.instanceIds,
        observedRoadSegmentIds: transaction.roadSegmentIds,
        observedVoxelSpots: [
          { surfaceId: "terrain_a", x: 0, y: 0, z: 0, occupancy: 1, material: "Grass" },
        ],
        observedImportFactors: [],
      }),
    /must not carry observed evidence/,
  );
});

test("Bridge persists sealed readbacks with spot hashes to disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "basalt-readbacks-"));
  const bridge = new BasaltStudioBridge({ readbackDir: dir });
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
  const voxels = tinyVoxelBytes();
  const partBytes = new Uint8Array([7, 7, 7, 7]);
  const scene = appliedSceneExport(voxels, partBytes);
  bridge.enqueueSceneExport(
    scene,
    new Map([
      [shaBytes(voxels), voxels],
      [shaBytes(partBytes), partBytes],
    ]),
  );
  bridge.enqueueMaterialMap(materialMapFor(scene.hash));
  const preflight = bridge.nextTransaction()!;
  bridge.settle(preflight, bridge.createReadback(preflight, "preflighted", hash("revision")));
  const apply = bridge.nextTransaction()!;
  bridge.settle(
    apply,
    bridge.createReadback(apply, "applied", hash("revision"), appliedEvidence(shaBytes(partBytes))),
  );
  for (const transaction of [preflight, apply]) {
    const filed = JSON.parse(readFileSync(join(dir, `${transaction.hash}.json`), "utf8"));
    assert.equal(filed.kind, "BasaltWorldReadback");
    assert.equal(filed.transactionHash, transaction.hash);
    assert.equal(filed.exportHash, scene.hash);
    assert.equal(filed.hash, hash(stableJson({ ...filed, hash: undefined })));
  }
  const applied = JSON.parse(readFileSync(join(dir, `${apply.hash}.json`), "utf8"));
  assert.equal(applied.spotHashes.length, 1);
  assert.equal(applied.spotHashes[0].surfaceId, "terrain_a");
  assert.match(applied.spotHashes[0].spotHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(applied.spotHashes, sealVoxelSpotHashes(applied.observedVoxelSpots));
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
      roadSegmentIds: [],
    },
    phase: "apply",
    expectedRevisionHash: hash("revision"),
  });
  const readback = createBasaltWorldReadback({
    transaction,
    phase: "applied",
    observedRevisionHash: hash("changed"),
    observedInstanceIds: [],
    observedRoadSegmentIds: [],
  });
  assertBasaltWorldReadback(readback);
  assert.throws(
    () => reconcileBasaltWorldReadback(transaction, readback, [], []),
    /revision changed/i,
  );
});

test("Basalt readback seals canonical evidence with quantized spot hashes", () => {
  const transaction = createBasaltWorldTransaction({
    manifestHash: hash("manifest"),
    worldPlanHash: hash("world"),
    chunk: {
      chunkId: "chunk_a",
      worldPlanHash: hash("world"),
      hash: hash("chunk"),
      transactionId: "basalt_tx_a",
      instanceIds: [],
      roadSegmentIds: [],
    },
    phase: "apply",
    expectedRevisionHash: hash("revision"),
  });
  const spot = (overrides = {}) => ({
    surfaceId: "terrain_a",
    x: 0,
    y: 0,
    z: 0,
    occupancy: 0.5,
    material: "Grass",
    ...overrides,
  });
  const input = {
    transaction,
    phase: "applied" as const,
    observedRevisionHash: hash("revision"),
    observedInstanceIds: [],
    observedRoadSegmentIds: [],
  };
  assert.throws(
    () => createBasaltWorldReadback({ ...input, observedVoxelSpots: [spot({ x: -1 })] }),
    /invalid spot/,
  );
  assert.throws(
    () =>
      createBasaltWorldReadback({
        ...input,
        observedVoxelSpots: [spot(), spot()],
      }),
    /repeats a surface cell/,
  );
  assert.throws(
    () =>
      createBasaltWorldReadback({
        ...input,
        observedImportFactors: [{ contentHash: "0".repeat(64), factor: 0 }],
      }),
    /invalid factor/,
  );
  // u8 quantization absorbs engine noise: 0.5 and 0.501 seal the same key.
  const left = sealVoxelSpotHashes([spot()]);
  const right = sealVoxelSpotHashes([spot({ occupancy: 0.501 })]);
  assert.deepEqual(left, right);
  const moved = sealVoxelSpotHashes([spot({ occupancy: 0.9 })]);
  assert.notDeepEqual(left, moved);
  assert.equal(left[0]!.surfaceId, "terrain_a");
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
    observedRoadSegmentIds: transaction.roadSegmentIds,
    observedVoxelSpots: [],
    observedImportFactors: [],
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
        observedRoadSegmentIds: transaction.roadSegmentIds,
        observedVoxelSpots: [],
        observedImportFactors: [],
      }),
    /revision changed/i,
  );
});

test("Bridge serves hash-verified scene payloads", () => {
  const bridge = new BasaltStudioBridge();
  const bytes = new Uint8Array([103, 108, 84, 70]);
  const manifest = sceneExport(bytes);
  const status = bridge.enqueueSceneExport(
    manifest,
    new Map([[manifest.payloads[0]!.contentHash, bytes]]),
  );
  assert.equal(status.exportHash, manifest.hash);
  assert.deepEqual(bridge.readPayload(manifest.payloads[0]!.contentHash), bytes);
  assert.throws(() => bridge.readPayload("0".repeat(64)), /Unknown scene payload/);
});

test("Bridge fails closed on payload evidence gaps", () => {
  const bridge = new BasaltStudioBridge();
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const manifest = sceneExport(bytes);
  const key = manifest.payloads[0]!.contentHash;
  assert.throws(() => bridge.enqueueSceneExport(manifest, new Map()), /missing payload/);
  assert.throws(
    () => bridge.enqueueSceneExport(manifest, new Map([[key, new Uint8Array([1, 2])]])),
    /length disagrees/,
  );
  assert.throws(
    () => bridge.enqueueSceneExport(manifest, new Map([[key, new Uint8Array([9, 9, 9, 9])]])),
    /hash mismatch/,
  );
  assert.throws(
    () => bridge.enqueueSceneExport({ ...manifest, hash: "0".repeat(64) }, new Map([[key, bytes]])),
    /hash mismatch/,
  );
  const oversize = { ...manifest.payloads[0]!, byteLength: 20 * 1024 * 1024 + 1 };
  assert.throws(
    () => bridge.enqueueSceneExport({ ...manifest, payloads: [oversize] }, new Map()),
    /Invalid Basalt scene export/,
  );
});

test("Bridge binds sidecar and material map to the enqueued export", () => {
  const bridge = new BasaltStudioBridge();
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const manifest = sceneExport(bytes);
  const key = manifest.payloads[0]!.contentHash;
  const sidecar = {
    kind: "BasaltEngineSidecar" as const,
    abi: "basalt-engine-sidecar@1" as const,
    engine: "roblox" as const,
    exportHash: manifest.hash,
    bindings: [
      {
        contentHash: key,
        assetId: "12345",
        uploadedAt: "2026-09-12T00:00:00.000Z",
        budgets: { triangles: 12, bytes: 4, watertight: true },
      },
    ],
  };
  const materialMap = {
    kind: "BasaltMaterialMap" as const,
    abi: "basalt-material-map@1" as const,
    engine: "roblox" as const,
    exportHash: manifest.hash,
    bindings: [{ materialId: "sliceMaterial", robloxMaterial: "Grass" }],
  };
  assert.throws(() => bridge.enqueueSidecar(sidecar), /before its sidecar/);
  assert.throws(() => bridge.enqueueMaterialMap(materialMap), /before its material map/);
  bridge.enqueueSceneExport(manifest, new Map([[key, bytes]]));
  bridge.enqueueSidecar(sidecar);
  bridge.enqueueMaterialMap(materialMap);
  assert.deepEqual(bridge.sidecar(), sidecar);
  assert.deepEqual(bridge.materialMap(), materialMap);
  assert.throws(
    () => bridge.enqueueSidecar({ ...sidecar, exportHash: "0".repeat(64) }),
    /different scene export/,
  );
  assert.throws(
    () => bridge.enqueueMaterialMap({ ...materialMap, exportHash: "0".repeat(64) }),
    /different scene export/,
  );
  assert.throws(
    () =>
      bridge.enqueueSidecar({
        ...sidecar,
        bindings: [{ ...sidecar.bindings[0]!, assetId: "rbxassetid://12345" }],
      }),
    /Invalid Basalt engine sidecar binding/,
  );
  assert.throws(
    () =>
      bridge.enqueueMaterialMap({
        ...materialMap,
        bindings: [{ materialId: "sliceMaterial", robloxMaterial: "Not A Material" }],
      }),
    /Invalid Basalt material map binding/,
  );
});

test("Bridge serves export and payload routes over HTTP", async () => {
  const bridge = new BasaltStudioBridge();
  const bytes = new Uint8Array([103, 108, 84, 70, 2, 0, 0, 0]);
  const manifest = sceneExport(bytes);
  bridge.enqueueSceneExport(manifest, new Map([[manifest.payloads[0]!.contentHash, bytes]]));
  const key = manifest.payloads[0]!.contentHash;
  bridge.enqueueSidecar({
    kind: "BasaltEngineSidecar",
    abi: "basalt-engine-sidecar@1",
    engine: "roblox",
    exportHash: manifest.hash,
    bindings: [
      {
        contentHash: key,
        assetId: 12345,
        uploadedAt: "2026-09-12T00:00:00.000Z",
        budgets: { triangles: 12, bytes: 8, watertight: false },
      },
    ],
  });
  bridge.enqueueMaterialMap({
    kind: "BasaltMaterialMap",
    abi: "basalt-material-map@1",
    engine: "roblox",
    exportHash: manifest.hash,
    bindings: [{ materialId: "sliceMaterial", robloxMaterial: "Grass" }],
  });
  const server = createBasaltStudioBridgeServer(bridge, { port: 0 });
  try {
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const base = `http://127.0.0.1:${address.port}`;
    const exported = await (await fetch(`${base}/export`)).json();
    assert.equal(exported.hash, manifest.hash);
    const sidecarRoute = await (await fetch(`${base}/sidecar`)).json();
    assert.equal(sidecarRoute.exportHash, manifest.hash);
    assert.equal(sidecarRoute.bindings[0].assetId, 12345);
    const materialRoute = await (await fetch(`${base}/material-map`)).json();
    assert.equal(materialRoute.bindings[0].robloxMaterial, "Grass");
    const fetched = new Uint8Array(
      await (await fetch(`${base}/payload/${manifest.payloads[0]!.contentHash}`)).arrayBuffer(),
    );
    assert.deepEqual(fetched, bytes);
    const unknown = await fetch(`${base}/payload/${"0".repeat(64)}`);
    assert.equal(unknown.status, 400);
    const malformed = await fetch(`${base}/payload/not-a-hash`);
    assert.equal(malformed.status, 400);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
