import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { contentHash, stableJson } from "../packages/contracts/src/index.js";
import { quantizeQ32_32 } from "../packages/basalt-types/src/fixed.js";
import type { AssetFamilyRevision } from "../packages/basalt-types/src/index.js";
import type { CatalogAssetEnvelope } from "../packages/catalog-intelligence/src/contracts.js";
import { inspectGlb } from "../packages/asset-inspection/src/index.js";
import { parseVoxelField, sha256Bytes } from "../packages/world-planning/src/index.js";
import { BasaltStudioBridge } from "../packages/studio-bridge/src/index.js";
import {
  assertSceneExport,
  assessMeshPartBudget,
  compileHierarchicalWorld,
  emitSceneExport,
  sealWorldAssetFamilyRegistry,
  type BasaltHierarchicalWorld,
} from "../packages/world-compiler/src/index.js";
import { productionWorldPlanFixture } from "./helpers/production-world-fixtures.js";

/** Minimal valid single-triangle GLB; optional node matrix for mirror tests. */
function triangleGlb(nodeMatrix?: readonly number[]): Uint8Array {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const indices = new Uint16Array([0, 1, 2]);
  const binary = new Uint8Array(44);
  binary.set(new Uint8Array(positions.buffer), 0);
  binary.set(new Uint8Array(indices.buffer), 36);
  const document = {
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [
      {
        name: "triangleNode",
        mesh: 0,
        ...(nodeMatrix ? { matrix: [...nodeMatrix] } : {}),
      },
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    buffers: [{ byteLength: 44 }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36 },
      { buffer: 0, byteOffset: 36, byteLength: 6 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: "VEC3" },
      { bufferView: 1, componentType: 5123, count: 3, type: "SCALAR" },
    ],
  };
  const json = Buffer.from(JSON.stringify(document));
  const jsonPadded = Buffer.alloc(Math.ceil(json.length / 4) * 4, 0x20);
  json.copy(jsonPadded);
  const total = 12 + 8 + jsonPadded.byteLength + 8 + binary.byteLength;
  const out = Buffer.alloc(total);
  out.writeUInt32LE(0x46546c67, 0);
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(total, 8);
  out.writeUInt32LE(jsonPadded.byteLength, 12);
  out.writeUInt32LE(0x4e4f534a, 16);
  jsonPadded.copy(out, 20);
  const binHeader = 20 + jsonPadded.byteLength;
  out.writeUInt32LE(binary.byteLength, binHeader);
  out.writeUInt32LE(0x004e4942, binHeader + 4);
  Buffer.from(binary).copy(out, binHeader + 8);
  return new Uint8Array(out);
}

const TRIANGLE = triangleGlb();
const TRIANGLE_SHA = sha256Bytes(TRIANGLE);

function compilePartitionWorld(): BasaltHierarchicalWorld {
  return compileHierarchicalWorld({
    worldPlan: productionWorldPlanFixture({
      sceneId: "exportWorld",
      regionId: "exportRegion",
      surfaceId: "exportTerrain",
      routeId: "exportRoute",
      anchorId: "exportAnchor",
      cameraId: "exportCamera",
      materialId: "exportMaterial",
      name: "A scene export fixture",
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
        biomeId: "exportRegion",
        semanticTags: ["ground-cover"],
        styleTags: ["coherent"],
        roleTags: ["scatter"],
        minimumFamilies: 1,
        maximumFamilies: 1,
        regionIds: ["exportRegion"],
        surfaceKinds: ["terrain"],
        maximumCount: 6,
        density: { minimum: 0.1, target: 0.4, maximum: 0.8 },
      },
    ],
    stage: "partition",
  });
}

/**
 * Minimal inputs by design: emitSceneExport reads only familyId/archetypes
 * from revisions and record/source/status from envelopes (mirroring the
 * unparsed-input precedent of resolveCanonicalAssetFamilies).
 */
function catalogInputs() {
  const memberIds = ["asset_alpha", "asset_beta", "asset_gamma"];
  const revisions = [
    {
      familyId: "FamilyGroundCover",
      archetypes: memberIds.map((assetId) => ({ assetId })),
    } as unknown as AssetFamilyRevision,
  ];
  const zero = quantizeQ32_32(0);
  const assets = memberIds.map(
    (assetId, index) =>
      ({
        record: {
          assetId,
          pivotOffsetFromBottomCenter: { x: zero, y: zero, z: zero },
        },
        source: {
          relativePath: `registry/fixture/${assetId}.glb`,
          contentHash: TRIANGLE_SHA,
        },
        measurement: { status: "measured" },
        variantIndex: index,
      }) as unknown as CatalogAssetEnvelope,
  );
  const unitsByPath = Object.fromEntries(
    memberIds.map((assetId) => [`registry/fixture/${assetId}.glb`, 1]),
  );
  return { revisions, assets, unitsByPath };
}

function emit(world?: BasaltHierarchicalWorld) {
  const { revisions, assets, unitsByPath } = catalogInputs();
  return emitSceneExport({
    world: world ?? compilePartitionWorld(),
    revisions,
    assets,
    unitsByPath,
    readSourceBytes: () => TRIANGLE,
  });
}

test("Scene export resolves every instance to content-hashed geometry", () => {
  const world = compilePartitionWorld();
  const { manifest, payloads } = emit(world);
  assertSceneExport(manifest);
  assert.ok(manifest.instances.length > 0);
  const memberIds = ["asset_alpha", "asset_beta", "asset_gamma"];
  for (const instance of manifest.instances) {
    const variant = Number.parseInt(instance.archetypeId.split("_archetype_")[1]!, 10);
    assert.equal(instance.assetId, memberIds[variant]);
  }
  for (const asset of manifest.assets) {
    assert.ok(asset.partHashes.length > 0);
    for (const hash of asset.partHashes) {
      const bytes = payloads.get(hash)!;
      assert.ok(bytes.byteLength > 0);
      assert.equal(sha256Bytes(bytes), hash);
      assert.equal(inspectGlb(bytes, {}).triangleCount, 1);
    }
  }
  const source = world.microPopulation!.chunks.flatMap((chunk) => chunk.instances);
  for (const instance of manifest.instances) {
    const original = source.find((candidate) => candidate.id === instance.id)!;
    assert.equal(instance.positionMeters.x, original.position.x * 0.28);
    assert.deepEqual(instance.rotation, [...original.rotation]);
  }
  assert.ok(!stableJson(manifest).includes("rbxassetid"));
});

test("Scene export is deterministic across runs", () => {
  const world = compilePartitionWorld();
  const first = emit(world);
  const second = emit(world);
  assert.deepEqual(first.manifest, second.manifest);
  assert.deepEqual([...first.payloads.keys()], [...second.payloads.keys()]);
  for (const [hash, bytes] of first.payloads) assert.deepEqual(bytes, second.payloads.get(hash));
});

test("Scene export carries connector-complete lowering evidence", () => {
  // Everything the fixed Luau connector assumes: resolvable assets, bounded
  // parts, voxel payloads, mapped materials, and paired ribbon vertices.
  const { manifest } = emit();
  assert.equal(manifest.studMeters, 0.28);
  assert.equal(
    manifest.placementConvention.instanceComposition,
    "T(positionMeters).R(rotationQuaternion).S(uniformScale).T(-pivotOffsetMeters).S(unitsToMeters)",
  );
  const assets = new Map(manifest.assets.map((asset) => [asset.assetId, asset]));
  const parts = new Map(manifest.parts.map((part) => [part.contentHash, part]));
  const payloads = new Map(manifest.payloads.map((entry) => [entry.contentHash, entry]));
  const materialIds = new Set(manifest.materialIds);
  assert.ok(manifest.instances.length > 0);
  for (const instance of manifest.instances) {
    const asset = assets.get(instance.assetId);
    assert.ok(asset, `instance ${instance.id} resolves its asset`);
    assert.ok(asset.partHashes.length > 0);
    for (const partHash of asset.partHashes) {
      const part = parts.get(partHash);
      assert.ok(part, `asset ${asset.assetId} resolves part ${partHash}`);
      assert.ok(part.triangleCount > 0);
      assert.ok(part.boundsSourceUnits.minimum.x <= part.boundsSourceUnits.maximum.x);
      assert.ok(part.boundsSourceUnits.minimum.y <= part.boundsSourceUnits.maximum.y);
      assert.ok(part.boundsSourceUnits.minimum.z <= part.boundsSourceUnits.maximum.z);
      for (const axis of ["x", "y", "z"] as const)
        assert.ok(Number.isFinite(part.pivotSourceUnits[axis]));
    }
  }
  for (const entry of manifest.terrain) {
    const payload = payloads.get(entry.voxelHash);
    assert.ok(payload, `terrain ${entry.surfaceId} binds its voxel payload`);
    assert.equal(payload.mediaType, "application/x-basalt-voxels");
    for (const materialId of entry.materials) assert.ok(materialIds.has(materialId));
  }
  for (const road of manifest.roads) {
    for (const segment of road.segments) {
      assert.ok(materialIds.has(segment.materialId));
      assert.ok(segment.vertices.length >= 4);
      assert.equal(segment.vertices.length % 2, 0);
    }
  }
});

test("Scene export seals the conformance golden", () => {
  // Fixed-timestamp worlds emit byte-identical exports across processes;
  // future engine adapters validate against this locked manifest hash.
  const { manifest } = emit();
  assert.equal(manifest.hash, "a413374f7a6a89b86fe1daff50b3f961cb11f2f9a54a023da9b1d7ef98da73e5");
});

test("Scene export matches the checked-in conformance fixture", async () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures/scene-conformance");
  const { manifest, payloads } = emit();
  const filed = JSON.parse(await readFile(resolve(root, "scene-manifest.json"), "utf8"));
  assert.deepEqual(manifest, filed);
  for (const entry of manifest.payloads) {
    const extension = entry.mediaType === "model/gltf-binary" ? "glb" : "bvx";
    const bytes = new Uint8Array(
      await readFile(resolve(root, `payloads/${entry.contentHash}.${extension}`)),
    );
    assert.deepEqual(payloads.get(entry.contentHash), bytes);
  }
});

test("Scene export fixture enqueues on the bridge byte-identical", async () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures/scene-conformance");
  const manifest = JSON.parse(await readFile(resolve(root, "scene-manifest.json"), "utf8"));
  const payloads = new Map<string, Uint8Array>();
  for (const entry of manifest.payloads) {
    const extension = entry.mediaType === "model/gltf-binary" ? "glb" : "bvx";
    payloads.set(
      entry.contentHash,
      new Uint8Array(await readFile(resolve(root, `payloads/${entry.contentHash}.${extension}`))),
    );
  }
  const bridge = new BasaltStudioBridge();
  const status = bridge.enqueueSceneExport(manifest, payloads);
  assert.equal(status.exportHash, manifest.hash);
  assert.deepEqual(bridge.sceneExport(), manifest);
  for (const [hash, bytes] of payloads) assert.deepEqual(bridge.readPayload(hash), bytes);
});

test("Scene export voxelizes terrain with solid cells below flat plains", () => {
  const { manifest, payloads } = emit();
  assert.equal(manifest.terrain.length, 1);
  const field = manifest.terrain[0]!;
  const parsed = parseVoxelField(payloads.get(field.voxelHash)!);
  assert.deepEqual(parsed.dimensions, [...field.dimensions]);
  assert.deepEqual(parsed.materials, [...field.materials]);
  assert.ok(parsed.occupancy.some((value) => value === 1));
  assert.ok(parsed.occupancy.every((value) => value >= 0 && value <= 1));
  for (const axis of parsed.originStuds)
    assert.ok(Number.isInteger(axis / parsed.cellSizeStuds), "voxel origins are cell-aligned");
  assert.throws(() => parseVoxelField(new Uint8Array([1, 2, 3])));
});

test("Mesh part budgets judge eligible, rejected, and incomplete", () => {
  assert.deepEqual(
    assessMeshPartBudget({
      triangleCount: 100,
      byteLength: 1000,
      boundaryEdgeCount: 0,
      nonManifoldEdgeCount: 0,
    }),
    { status: "eligible" },
  );
  assert.equal(
    assessMeshPartBudget({
      triangleCount: 20001,
      byteLength: 1000,
      boundaryEdgeCount: 0,
      nonManifoldEdgeCount: 0,
    }).status,
    "rejected",
  );
  assert.equal(
    assessMeshPartBudget({
      triangleCount: 100,
      byteLength: 20971521,
      boundaryEdgeCount: 0,
      nonManifoldEdgeCount: 0,
    }).status,
    "rejected",
  );
  assert.equal(
    assessMeshPartBudget({
      triangleCount: 0,
      byteLength: 100,
      boundaryEdgeCount: 0,
      nonManifoldEdgeCount: 0,
    }).status,
    "rejected",
  );
  const open = assessMeshPartBudget({
    triangleCount: 100,
    byteLength: 1000,
    boundaryEdgeCount: 3,
    nonManifoldEdgeCount: 0,
  });
  if (open.status !== "incomplete") assert.fail(`expected incomplete, got ${open.status}`);
  assert.match(open.reason, /watertight/);
  assert.equal(
    assessMeshPartBudget({
      triangleCount: 1.5,
      byteLength: 1000,
      boundaryEdgeCount: 0,
      nonManifoldEdgeCount: 0,
    }).status,
    "rejected",
  );
});

test("Scene export carries roads in meters", () => {
  const { manifest } = emit();
  assert.equal(manifest.roads.length, 1);
  const road = manifest.roads[0]!;
  assert.equal(road.routeId, "exportRoute");
  assert.ok(road.segments.length > 0);
  for (const segment of road.segments) assert.ok(segment.vertices.length >= 4);
});

test("Scene export fails closed on resolution and evidence gaps", () => {
  const world = compilePartitionWorld();
  const { revisions, assets, unitsByPath } = catalogInputs();
  const base = { world, revisions, assets, unitsByPath, readSourceBytes: () => TRIANGLE };
  assert.throws(() => emitSceneExport({ ...base, revisions: [] }), /unknown family/);
  assert.throws(
    () =>
      emitSceneExport({
        ...base,
        revisions: [
          {
            familyId: "FamilyGroundCover",
            archetypes: [{ assetId: "asset_alpha" }],
          } as unknown as AssetFamilyRevision,
        ],
      }),
    /variant/,
  );
  assert.throws(() => emitSceneExport({ ...base, unitsByPath: {} }), /source units/);
  assert.throws(
    () => emitSceneExport({ ...base, readSourceBytes: () => new Uint8Array([9]) }),
    /content hash/,
  );
  const mirrored = triangleGlb([-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const mirroredSha = sha256Bytes(mirrored);
  const mirroredAssets = assets.map(
    (asset) =>
      ({
        ...asset,
        source: { ...asset.source, contentHash: mirroredSha },
      }) as unknown as CatalogAssetEnvelope,
  );
  assert.throws(
    () => emitSceneExport({ ...base, assets: mirroredAssets, readSourceBytes: () => mirrored }),
    /mirrored/,
  );
});
