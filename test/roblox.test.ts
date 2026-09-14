import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { compileBasaltWorld } from "@basalt/world-compiler";
import {
  ROBLOX_ASSET_BINDING_SCHEMA,
  ROBLOX_IMPORT_REPORT_PATH,
  ROBLOX_IMPORT_REPORT_SCHEMA,
  ROBLOX_READBACK_SCHEMA,
  ROBLOX_TRACE_EVENT_SCHEMA,
  ROBLOX_TERRAIN_SURFACE_SAMPLE_OFFSET_METERS,
  ROBLOX_TERRAIN_VOXEL_METERS,
  RobloxImportBridge,
  createRobloxImportManifest,
  installRobloxCredential,
  metersToRobloxReadbackMicrometers,
  metersToRobloxStuds,
  robloxStudsToMeters,
  robloxTerrainSolidOccupancy,
  sealRobloxAssetBinding,
} from "@basalt/roblox";
import { loadSemanticRegistry } from "./helpers/semantic-registry.js";
import { worldFixture } from "./helpers/world-fixture.js";

test("Roblox is the only unit-conversion and import-protocol boundary", async () => {
  assert.equal(metersToRobloxStuds(0.28), 1);
  assert.ok(Math.abs(robloxStudsToMeters(100) - 28) < 1e-12);
  assert.ok(Math.abs(robloxStudsToMeters(metersToRobloxStuds(12.345)) - 12.345) < 1e-12);
  assert.equal(metersToRobloxReadbackMicrometers(4.958333333333334), 4_958_334);
  assert.equal(metersToRobloxReadbackMicrometers(-4.958333333333334), -4_958_334);
  assert.equal(ROBLOX_TERRAIN_VOXEL_METERS, 1.12);
  assert.equal(ROBLOX_TERRAIN_SURFACE_SAMPLE_OFFSET_METERS, 0.56);
  assert.equal(robloxTerrainSolidOccupancy(0, -1.12), 0.5);
  assert.equal(robloxTerrainSolidOccupancy(0, 0), 0);
  assert.equal(robloxTerrainSolidOccupancy(0, -2.24), 1);
  assert.throws(() => robloxTerrainSolidOccupancy(Number.NaN, 0), /finite/u);
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
      constructedElements: [],
      constructedOpenings: [],
      traceEvents: [],
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
    const accepted = (await response.json()) as {
      state: string;
      worldBuildHash: string;
      loweringGapCount: number;
      stage: string;
      progress: { complete: number; total: number };
      observedWorldStateHash: string;
    };
    assert.equal(accepted.observedWorldStateHash, transaction.expectedObservedWorldStateHash);
    assert.equal(accepted.state, "pending");
    assert.equal(accepted.worldBuildHash, manifest.worldBuildHash);
    assert.equal(accepted.loweringGapCount, 0);
    assert.equal(accepted.stage, "foundation");
    assert.deepEqual(accepted.progress, { complete: 1, total: manifest.transactions.length });
    const report = ROBLOX_IMPORT_REPORT_SCHEMA.parse(
      JSON.parse(await readFile(join(root, ROBLOX_IMPORT_REPORT_PATH), "utf8")),
    );
    assert.equal(report.state, "pending");
    assert.equal(report.stage, "foundation");
    assert.equal(report.records.length, 1);
    assert.equal(report.records[0]!.transactionId, transaction.transactionId);
    assert.equal(report.diagnostics.length, 0);

    const restarted = (await (
      await fetch(`${base}/restart`, { method: "POST", headers })
    ).json()) as typeof accepted;
    assert.equal(restarted.state, "pending");
    assert.equal(restarted.worldBuildHash, manifest.worldBuildHash);
    assert.equal(restarted.loweringGapCount, 0);
    assert.equal(restarted.stage, "preflight");
    assert.deepEqual(restarted.progress, { complete: 0, total: manifest.transactions.length });

    const replayedPreflight = await fetch(`${base}/readback`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(exactReadback(manifest, transaction)),
    });
    assert.equal(replayedPreflight.status, 200);
    const foundationTransaction = manifest.transactions[1]!;
    const failed = await fetch(`${base}/readback`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        ...exactReadback(manifest, foundationTransaction),
        status: "incomplete",
        diagnostics: ["synthetic terrain failure"],
        traceEvents: [terrainTrace("foundation")],
      }),
    });
    assert.equal(failed.status, 200);
    const failedReport = ROBLOX_IMPORT_REPORT_SCHEMA.parse(
      JSON.parse(await readFile(join(root, ROBLOX_IMPORT_REPORT_PATH), "utf8")),
    );
    assert.equal(failedReport.state, "incomplete");
    assert.deepEqual(failedReport.diagnostics, ["synthetic terrain failure"]);
    assert.deepEqual(failedReport.traceEvents, [terrainTrace("foundation")]);
  } finally {
    if (bridge) await bridge.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("Roblox terrain traces retain complete grounding evidence without becoming world authority", () => {
  const trace = terrainTrace("readback");
  assert.deepEqual(ROBLOX_TRACE_EVENT_SCHEMA.parse(trace), trace);
  assert.throws(() =>
    ROBLOX_TRACE_EVENT_SCHEMA.parse({
      ...trace,
      maximumBodyGapMeters: Number.NaN,
    }),
  );
});

test("local bridge drains the canonical transaction sequence and replays acknowledgements idempotently", async () => {
  const root = await mkdtemp(join(tmpdir(), "basalt-roblox-sequence-test-"));
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
    const url = `http://127.0.0.1:${port}/readback`;
    const headers = {
      Authorization: `Bearer ${credential.token}`,
      "content-type": "application/json",
    };
    let firstBody = "";
    for (const [index, transaction] of manifest.transactions.entries()) {
      const readback = {
        ...exactReadback(manifest, transaction),
        traceEvents: transaction.stage === "foundation" ? [terrainTrace("foundation")] : [],
      };
      const body = JSON.stringify(readback);
      if (index === 0) firstBody = body;
      const response = await fetch(url, { method: "POST", headers, body });
      assert.equal(response.status, 200);
      const status = (await response.json()) as { state: string; progress: { complete: number } };
      assert.equal(status.progress.complete, index + 1);
      assert.equal(
        status.state,
        index === manifest.transactions.length - 1 ? "complete" : "pending",
      );
    }
    const replay = await fetch(url, { method: "POST", headers, body: firstBody });
    assert.equal(replay.status, 200);
    const replayStatus = (await replay.json()) as {
      state: string;
      progress: { complete: number; total: number };
    };
    assert.equal(replayStatus.state, "complete");
    assert.deepEqual(replayStatus.progress, {
      complete: manifest.transactions.length,
      total: manifest.transactions.length,
    });
    const report = ROBLOX_IMPORT_REPORT_SCHEMA.parse(
      JSON.parse(await readFile(join(root, ROBLOX_IMPORT_REPORT_PATH), "utf8")),
    );
    assert.equal(report.state, "complete");
    assert.equal(report.records.length, manifest.transactions.length);
    assert.deepEqual(report.traceEvents, [terrainTrace("foundation")]);
  } finally {
    if (bridge) await bridge.stop();
    await rm(root, { recursive: true, force: true });
  }
});

function exactReadback(
  manifest: ReturnType<typeof createRobloxImportManifest>,
  transaction: ReturnType<typeof createRobloxImportManifest>["transactions"][number],
) {
  return {
    kind: "RobloxReadback" as const,
    sessionHash: manifest.sessionHash,
    worldBuildHash: manifest.worldBuildHash,
    transactionId: transaction.transactionId,
    status: "complete" as const,
    instances: transaction.expectedInstanceHashes.map(({ instanceId, hash }) => ({
      instanceId,
      realizedHash: hash,
    })),
    artifacts: transaction.expectedArtifactHashes,
    constructedElements: transaction.expectedConstructedElements,
    constructedOpenings: transaction.expectedConstructedOpenings,
    traceEvents: [],
    diagnostics: [],
  };
}

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

function terrainTrace(phase: "foundation" | "readback") {
  return {
    kind: "route_terrain" as const,
    phase,
    routeId: "PavedRoad",
    segmentId: `RouteSegment_${"a".repeat(52)}`,
    requiredSurfaceRevealMeters: 0.08,
    maximumGroundingGapMeters: 0.12,
    minimumSurfaceClearanceMeters: 0.081,
    maximumSurfaceClearanceMeters: 0.2371,
    maximumBodyGapMeters: 0.0771,
    maximumGroundingBottomClearanceMeters: -0.0056,
    groundingDepthMeters: 0.0827,
    startAdjustmentMeters: 0.04,
    finishAdjustmentMeters: 0.04,
    minimumAtMeters: { x: 10, y: 1, z: 2 },
    maximumAtMeters: { x: 11, y: 1.2, z: 2.2 },
    maximumBodyGapAtMeters: { x: 11, y: 1.04, z: 2.2 },
  };
}
