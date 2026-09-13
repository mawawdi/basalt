import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { compileBasaltWorld } from "@basalt/world-compiler";
import {
  ROBLOX_ASSET_BINDING_SCHEMA,
  ROBLOX_READBACK_SCHEMA,
  ROBLOX_TERRAIN_VOXEL_METERS,
  RobloxImportBridge,
  createRobloxImportManifest,
  installRobloxCredential,
  metersToRobloxStuds,
  robloxStudsToMeters,
  sealRobloxAssetBinding,
} from "@basalt/roblox";
import { loadSemanticRegistry } from "./helpers/semantic-registry.js";
import { worldFixture } from "./helpers/world-fixture.js";

test("Roblox is the only unit-conversion and import-protocol boundary", async () => {
  assert.equal(metersToRobloxStuds(0.28), 1);
  assert.ok(Math.abs(robloxStudsToMeters(100) - 28) < 1e-12);
  assert.ok(Math.abs(robloxStudsToMeters(metersToRobloxStuds(12.345)) - 12.345) < 1e-12);
  assert.equal(ROBLOX_TERRAIN_VOXEL_METERS, 1.12);
  const module = await loadSemanticRegistry();
  const fixture = await worldFixture(module);
  const world = compileBasaltWorld({
    semanticModule: module,
    catalogSnapshot: fixture.snapshot,
    catalogAssets: [fixture.asset],
    spatialPlan: fixture.plan,
  });
  const manifest = createRobloxImportManifest(world, [
    sealRobloxAssetBinding({
      assetHash: fixture.asset.hash,
      robloxAssetId: 123,
      sourceArtifactHash: fixture.asset.source.sourceArtifact!.artifactHash,
      materialExpectations: [materialExpectation()],
    }),
  ]);
  assert.equal(manifest.worldStatus, "eligible");
  assert.equal(
    manifest.transactions.map((entry) => entry.stage).join(","),
    "preflight,foundation,meso,micro,readback,commit",
  );
  assert.equal(manifest.loweringGaps.length, 0);
});

test("Roblox lowering gaps remain explicit when no admitted binding exists", async () => {
  const module = await loadSemanticRegistry();
  const fixture = await worldFixture(module);
  const world = compileBasaltWorld({
    semanticModule: module,
    catalogSnapshot: fixture.snapshot,
    catalogAssets: [fixture.asset],
    spatialPlan: fixture.plan,
  });
  const manifest = createRobloxImportManifest(world);
  assert.equal(manifest.loweringGaps.length, 1);
  assert.equal(
    manifest.transactions.flatMap((transaction) => transaction.instances)[0]?.materialExpectations
      .length,
    0,
  );
});

test("Roblox material bindings are sealed against expectation changes", () => {
  const binding = sealRobloxAssetBinding({
    assetHash: "a".repeat(64),
    robloxAssetId: 123,
    sourceArtifactHash: "b".repeat(64),
    materialExpectations: [materialExpectation()],
  });
  assert.throws(() =>
    ROBLOX_ASSET_BINDING_SCHEMA.parse({
      ...binding,
      materialExpectations: [{ ...binding.materialExpectations[0]!, material: "Glass" }],
    }),
  );
});

test("local bridge requires authentication and advances only exact readback", async () => {
  const root = await mkdtemp(join(tmpdir(), "basalt-roblox-test-"));
  let bridge: RobloxImportBridge | undefined;
  try {
    const module = await loadSemanticRegistry();
    const fixture = await worldFixture(module);
    const world = compileBasaltWorld({
      semanticModule: module,
      catalogSnapshot: fixture.snapshot,
      catalogAssets: [fixture.asset],
      spatialPlan: fixture.plan,
    });
    const manifest = createRobloxImportManifest(world, [
      sealRobloxAssetBinding({
        assetHash: fixture.asset.hash,
        robloxAssetId: 123,
        sourceArtifactHash: fixture.asset.source.sourceArtifact!.artifactHash,
        materialExpectations: [materialExpectation()],
      }),
    ]);
    const credential = await installRobloxCredential(root);
    bridge = new RobloxImportBridge({ workspaceRoot: root, manifest, credential });
    const port = await bridge.start();
    const base = `http://127.0.0.1:${port}`;
    assert.equal((await fetch(`${base}/health`)).status, 200);
    assert.equal((await fetch(`${base}/session`)).status, 401);
    const headers = { Authorization: `Bearer ${credential.token}` };
    const session = (await (await fetch(`${base}/session`, { headers })).json()) as {
      state: string;
    };
    assert.equal(session.state, "pending");
    const transaction = manifest.transactions[0]!;
    const readback = {
      kind: "RobloxReadback" as const,
      sessionHash: manifest.sessionHash,
      worldBuildHash: manifest.worldBuildHash,
      transactionId: transaction.transactionId,
      status: "complete" as const,
      instances: [],
      artifacts: [],
      diagnostics: [],
    };
    assert.doesNotThrow(() => ROBLOX_READBACK_SCHEMA.parse(readback));
    assert.throws(
      () =>
        ROBLOX_READBACK_SCHEMA.parse({
          ...readback,
          observedWorldStateHash: transaction.expectedObservedWorldStateHash,
        }),
      /unrecognized|invalid/iu,
    );
    const response = await fetch(`${base}/readback`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(readback),
    });
    assert.equal(response.status, 200);
    const accepted = (await response.json()) as { observedWorldStateHash: string };
    assert.equal(accepted.observedWorldStateHash, transaction.expectedObservedWorldStateHash);
  } finally {
    if (bridge) await bridge.stop();
    await rm(root, { recursive: true, force: true });
  }
});

function materialExpectation() {
  return {
    partPath: [{ name: "Renderable", siblingOrdinal: 0 }],
    className: "MeshPart",
    material: "Plastic",
    color: { red: 255, green: 255, blue: 255 },
    transparency: 0,
    reflectance: 0,
  };
}
