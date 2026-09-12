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

function sceneExport(bytes: Uint8Array, overrides: Record<string, unknown> = {}) {
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
    stairs: [],
    portals: [],
    materialIds: [],
    payloads: [
      {
        contentHash: shaBytes(bytes),
        byteLength: bytes.byteLength,
        mediaType: "model/gltf-binary" as const,
      },
    ],
    ...overrides,
  };
  return { ...material, hash: hash(stableJson(material)) } as typeof material & { hash: string };
}

/** Minimal valid 1x1x1 BVX field: single cell, one material, full occupancy. */
function tinyVoxelBytes(material = "mat_a", occupancy = 1, liquid = 0): Uint8Array {
  const name = new TextEncoder().encode(material);
  const bytes = new Uint8Array(52 + 2 + name.byteLength + 4 + 4 + 2);
  const view = new DataView(bytes.buffer);
  bytes.set([0x42, 0x56, 0x58, 0x32], 0);
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
  view.setFloat32(54 + name.byteLength + 4, liquid, true);
  view.setUint16(54 + name.byteLength + 8, 0, true);
  return bytes;
}

/** Scene export matching chunk(): terrain_a, instance_a/asset_a, one part. */
function appliedSceneExport(
  voxelBytes: Uint8Array,
  partBytes: Uint8Array,
  terrainRepaints?: { surfaceId: string; sourceMaterialId: string; targetMaterialId: string }[],
  terrainAppearance?: unknown,
) {
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
    ...(terrainRepaints ? { terrainRepaints } : {}),
    ...(terrainAppearance === undefined ? {} : { terrainAppearance }),
    roads: [],
    skirts: [],
    stairs: [],
    portals: [],
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
        liquid: 0,
        material: "Grass",
      },
    ],
    observedImportFactors: [{ contentHash: partHash, factor: 1 }],
  };
}

function materialMapFor(
  manifestHash: string,
  bindings: { materialId: string; robloxMaterial: string }[] = [
    { materialId: "mat_a", robloxMaterial: "Grass" },
  ],
) {
  return {
    kind: "BasaltMaterialMap" as const,
    abi: "basalt-material-map@1" as const,
    engine: "roblox" as const,
    exportHash: manifestHash,
    bindings,
  };
}

function chunk(overrides: Record<string, unknown> = {}) {
  const material = {
    kind: "BasaltWorldChunkDelta" as const,
    chunkId: "chunk_a",
    worldPlanHash: hash("world"),
    populationHash: hash("population"),
    surfaceIds: ["terrain_a"],
    instanceIds: ["instance_a"],
    roadSegmentIds: ["road_a"],
    stairIds: [],
    portalIds: [],
    bounds: {
      minimum: { x: 0, y: 0, z: 0 },
      maximum: { x: 8, y: 8, z: 8 },
    },
    ...overrides,
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

test("Bridge replays water cells as Air plus sealed liquid", () => {
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
  const voxels = tinyVoxelBytes("mat_a", 0, 0.75);
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
  const water = {
    observedVoxelSpots: [
      { surfaceId: "terrain_a", x: 0, y: 0, z: 0, occupancy: 0, liquid: 0.75, material: "Air" },
    ],
    observedImportFactors: [{ contentHash: shaBytes(partBytes), factor: 1 }],
  };
  assert.throws(
    () =>
      bridge.settle(
        apply,
        bridge.createReadback(apply, "applied", hash("revision"), {
          ...water,
          observedVoxelSpots: [{ ...water.observedVoxelSpots[0]!, liquid: 0.5 }],
        }),
      ),
    /reads liquid 0\.5 against sealed 0\.75/,
  );
  assert.throws(
    () =>
      bridge.settle(
        apply,
        bridge.createReadback(apply, "applied", hash("revision"), {
          ...water,
          observedVoxelSpots: [{ ...water.observedVoxelSpots[0]!, material: "Grass" }],
        }),
      ),
    /reads material Grass against mapped Air/,
  );
  bridge.settle(apply, bridge.createReadback(apply, "applied", hash("revision"), water));
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

test("Bridge replays repainted cells through the substituted material", () => {
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
  const voxels = tinyVoxelBytes("mat_a", 1, 0);
  const partBytes = new Uint8Array([7, 7, 7, 7]);
  const scene = appliedSceneExport(
    voxels,
    partBytes,
    [{ surfaceId: "terrain_a", sourceMaterialId: "mat_a", targetMaterialId: "mat_b" }],
    { materialTints: [] },
  );
  bridge.enqueueSceneExport(
    scene,
    new Map([
      [shaBytes(voxels), voxels],
      [shaBytes(partBytes), partBytes],
    ]),
  );
  bridge.enqueueMaterialMap({
    kind: "BasaltMaterialMap" as const,
    abi: "basalt-material-map@1" as const,
    engine: "roblox" as const,
    exportHash: scene.hash,
    bindings: [
      { materialId: "mat_a", robloxMaterial: "Grass" },
      { materialId: "mat_b", robloxMaterial: "Sand" },
    ],
  });
  const preflight = bridge.nextTransaction()!;
  bridge.settle(preflight, bridge.createReadback(preflight, "preflighted", hash("revision")));
  const apply = bridge.nextTransaction()!;
  const repainted = {
    observedVoxelSpots: [
      { surfaceId: "terrain_a", x: 0, y: 0, z: 0, occupancy: 1, liquid: 0, material: "Sand" },
    ],
    observedImportFactors: [{ contentHash: shaBytes(partBytes), factor: 1 }],
  };
  assert.throws(
    () =>
      bridge.settle(
        apply,
        bridge.createReadback(apply, "applied", hash("revision"), {
          ...repainted,
          observedVoxelSpots: [{ ...repainted.observedVoxelSpots[0]!, material: "Grass" }],
        }),
      ),
    /reads material Grass against mapped Sand/,
  );
  bridge.settle(apply, bridge.createReadback(apply, "applied", hash("revision"), repainted));
  assert.equal(bridge.nextTransaction()!.phase, "commit");
});

const STAIR_ID = "roomgraph_test_stair_00_01";
const PORTAL_ID = "roomgraph_test_portal_00_00";
const STAIR_BASE = { x: 0.56, y: 0, z: -1.12 };
const STAIR_RISER = 0.56;
const STAIR_TREAD = (8 / 3) * 0.28;

function interiorExport() {
  return sceneExport(new Uint8Array([9]), {
    stairs: [
      {
        id: STAIR_ID,
        chunkId: "chunk_a",
        graphId: "roomgraph_test",
        materialId: "mat_stone",
        baseMeters: STAIR_BASE,
        yawStepsY90: 0,
        steps: 3,
        riserMeters: STAIR_RISER,
        treadMeters: STAIR_TREAD,
        widthMeters: 0.56,
      },
    ],
    portals: [
      {
        id: PORTAL_ID,
        chunkId: "chunk_a",
        graphId: "roomgraph_test",
        kind: "interior",
        roomA: "room_00_00",
        roomB: "room_00_01",
        positionMeters: { x: 0, y: 0, z: 0 },
        yawStepsY90: 1,
        widthMeters: 0.56,
      },
    ],
    materialIds: ["mat_stone"],
  });
}

function interiorChunk() {
  return chunk({
    surfaceIds: [],
    instanceIds: [],
    roadSegmentIds: [],
    stairIds: [STAIR_ID],
    portalIds: [PORTAL_ID],
  });
}

function prepareInteriorBridge() {
  const bridge = new BasaltStudioBridge({ maxQueue: 4 });
  const source = interiorChunk();
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
  const manifest = interiorExport();
  const partBytes = new Uint8Array([9]);
  bridge.enqueueSceneExport(manifest, new Map([[shaBytes(partBytes), partBytes]]));
  bridge.enqueueMaterialMap(
    materialMapFor(manifest.hash, [{ materialId: "mat_stone", robloxMaterial: "Concrete" }]),
  );
  const preflight = bridge.nextTransaction()!;
  bridge.settle(preflight, bridge.createReadback(preflight, "preflighted", hash("revision")));
  return { bridge, apply: bridge.nextTransaction()! };
}

function stairSteps(noise = 0) {
  return [0, 1, 2].map((step) => ({
    stairId: STAIR_ID,
    step,
    x: STAIR_BASE.x,
    y: STAIR_BASE.y + STAIR_RISER * (step + 0.5),
    z: STAIR_BASE.z + STAIR_TREAD * (step + 0.5) + noise,
    material: "Concrete",
  }));
}

function portalReading() {
  return { portalId: PORTAL_ID, x: 0, y: 0, z: 0, yawStepsY90: 1 };
}

test("Bridge replays applied stair steps against the sealed run", () => {
  const { bridge, apply } = prepareInteriorBridge();
  bridge.settle(
    apply,
    bridge.createReadback(apply, "applied", hash("revision"), {
      observedStairSteps: [...stairSteps(0.005)].reverse(),
      observedPortals: [portalReading()],
    }),
  );
  assert.equal(bridge.nextTransaction()!.phase, "commit");
});

test("Bridge rejects stair steps with gaps, drift, or wrong material", () => {
  const cases: { label: string; steps: ReturnType<typeof stairSteps>; pattern: RegExp }[] = [
    { label: "gap", steps: [stairSteps()[0]!, stairSteps()[2]!], pattern: /do not cover/ },
    { label: "drift", steps: stairSteps(0.05), pattern: /against sealed/ },
    {
      label: "material",
      steps: stairSteps().map((entry, index) =>
        index === 0 ? { ...entry, material: "Wood" } : entry,
      ),
      pattern: /against mapped/,
    },
  ];
  for (const entry of cases) {
    const { bridge, apply } = prepareInteriorBridge();
    assert.throws(
      () =>
        bridge.settle(
          apply,
          bridge.createReadback(apply, "applied", hash("revision"), {
            observedStairSteps: entry.steps,
            observedPortals: [portalReading()],
          }),
        ),
      entry.pattern,
      entry.label,
    );
  }
});

test("Bridge replays applied portal markers against sealed poses", () => {
  const { bridge, apply } = prepareInteriorBridge();
  bridge.settle(
    apply,
    bridge.createReadback(apply, "applied", hash("revision"), {
      observedStairSteps: stairSteps(),
      observedPortals: [portalReading()],
    }),
  );
  assert.equal(bridge.nextTransaction()!.phase, "commit");
});

test("Bridge rejects portal markers with gaps, drift, or wrong yaw", () => {
  const good = portalReading();
  const cases: { label: string; portals: (typeof good)[]; pattern: RegExp }[] = [
    { label: "gap", portals: [], pattern: /do not cover/ },
    { label: "drift", portals: [{ ...good, x: 0.05 }], pattern: /against sealed/ },
    { label: "yaw", portals: [{ ...good, yawStepsY90: 2 }], pattern: /yaw/ },
  ];
  for (const entry of cases) {
    const { bridge, apply } = prepareInteriorBridge();
    assert.throws(
      () =>
        bridge.settle(
          apply,
          bridge.createReadback(apply, "applied", hash("revision"), {
            observedStairSteps: stairSteps(),
            observedPortals: entry.portals,
          }),
        ),
      entry.pattern,
      entry.label,
    );
  }
});

test("Bridge rejects stair and portal evidence outside the applied phase", () => {
  const bridge = new BasaltStudioBridge({ maxQueue: 4 });
  const source = interiorChunk();
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
  const preflight = bridge.nextTransaction()!;
  assert.throws(
    () =>
      bridge.settle(
        preflight,
        bridge.createReadback(preflight, "preflighted", hash("revision"), {
          observedStairSteps: stairSteps(),
          observedPortals: [portalReading()],
        }),
      ),
    /must not carry observed evidence/,
  );
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
        observedStairIds: transaction.stairIds,
        observedPortalIds: transaction.portalIds,
        observedVoxelSpots: [
          { surfaceId: "terrain_a", x: 0, y: 0, z: 0, occupancy: 1, liquid: 0, material: "Grass" },
        ],
        observedImportFactors: [],
        observedStairSteps: [],
        observedPortals: [],
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
      stairIds: [],
      portalIds: [],
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
    observedStairIds: [],
    observedPortalIds: [],
  });
  assertBasaltWorldReadback(readback);
  assert.throws(
    () => reconcileBasaltWorldReadback(transaction, readback, [], [], [], []),
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
      stairIds: [],
      portalIds: [],
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
    liquid: 0.25,
    material: "Grass",
    ...overrides,
  });
  const input = {
    transaction,
    phase: "applied" as const,
    observedRevisionHash: hash("revision"),
    observedInstanceIds: [],
    observedRoadSegmentIds: [],
    observedStairIds: [],
    observedPortalIds: [],
  };
  assert.throws(
    () => createBasaltWorldReadback({ ...input, observedVoxelSpots: [spot({ x: -1 })] }),
    /invalid spot/,
  );
  assert.throws(
    () => createBasaltWorldReadback({ ...input, observedVoxelSpots: [spot({ liquid: 2 })] }),
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
  const step = (overrides = {}) => ({
    stairId: STAIR_ID,
    step: 0,
    x: 0,
    y: 0,
    z: 0,
    material: "Concrete",
    ...overrides,
  });
  const portal = (overrides = {}) => ({
    portalId: PORTAL_ID,
    x: 0,
    y: 0,
    z: 0,
    yawStepsY90: 1,
    ...overrides,
  });
  assert.throws(
    () => createBasaltWorldReadback({ ...input, observedStairSteps: [step({ step: -1 })] }),
    /invalid step/,
  );
  assert.throws(
    () => createBasaltWorldReadback({ ...input, observedStairSteps: [step(), step()] }),
    /repeats a stair step/,
  );
  assert.throws(
    () => createBasaltWorldReadback({ ...input, observedPortals: [portal({ yawStepsY90: 4 })] }),
    /invalid portal/,
  );
  assert.throws(
    () => createBasaltWorldReadback({ ...input, observedPortals: [portal(), portal()] }),
    /repeats a portal/,
  );
  const sealed = createBasaltWorldReadback({
    ...input,
    observedStairSteps: [step({ step: 1 }), step({ step: 0 })],
    observedPortals: [portal({ portalId: "roomgraph_b" }), portal({ portalId: "roomgraph_a" })],
  });
  assert.deepEqual(
    sealed.observedStairSteps.map((entry) => entry.step),
    [0, 1],
  );
  assert.deepEqual(
    sealed.observedPortals.map((entry) => entry.portalId),
    ["roomgraph_a", "roomgraph_b"],
  );
  // u8 quantization absorbs engine noise: 0.5 and 0.501 seal the same key.
  const left = sealVoxelSpotHashes([spot()]);
  const right = sealVoxelSpotHashes([spot({ occupancy: 0.501 })]);
  assert.deepEqual(left, right);
  const moved = sealVoxelSpotHashes([spot({ occupancy: 0.9 })]);
  assert.notDeepEqual(left, moved);
  const liquidNoise = sealVoxelSpotHashes([spot({ liquid: 0.251 })]);
  assert.deepEqual(left, liquidNoise);
  const liquidMoved = sealVoxelSpotHashes([spot({ liquid: 0.9 })]);
  assert.notDeepEqual(left, liquidMoved);
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
    observedStairIds: transaction.stairIds,
    observedPortalIds: transaction.portalIds,
    observedVoxelSpots: [],
    observedImportFactors: [],
    observedStairSteps: [],
    observedPortals: [],
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
        observedStairIds: transaction.stairIds,
        observedPortalIds: transaction.portalIds,
        observedVoxelSpots: [],
        observedImportFactors: [],
        observedStairSteps: [],
        observedPortals: [],
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
