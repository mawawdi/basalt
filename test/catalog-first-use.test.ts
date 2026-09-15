import assert from "node:assert/strict";
import test from "node:test";
import { createRobloxImportManifest } from "@basalt/roblox";
import { compileBasaltWorld } from "@basalt/world-compiler";
import { catalogFirstUseFixture } from "./helpers/catalog-first-use-fixture.js";
import { loadSemanticRegistry } from "./helpers/semantic-registry.js";

test("the first-use fixture resolves only real committed catalog authority", async () => {
  const module = await loadSemanticRegistry();
  const fixture = await catalogFirstUseFixture(module);
  const baseline = compileBasaltWorld({
    semanticModule: module,
    catalogSnapshot: fixture.catalogCommit.snapshot,
    catalogAssets: fixture.measurements.assets,
    spatialPlan: fixture.plan,
  });
  const changed = compileBasaltWorld({
    semanticModule: module,
    catalogSnapshot: fixture.catalogCommit.snapshot,
    catalogAssets: fixture.measurements.assets,
    spatialPlan: fixture.changedPlan,
  });
  assert.equal(baseline.catalogSnapshotHash, fixture.catalogCommit.snapshot.hash);
  assert.equal(baseline.catalogResolution.requirementsHash.length, 64);
  assert.equal(fixture.requirements.length, 4);

  const eligibleSources = new Set(
    fixture.catalogCommit.dispositions
      .filter((entry) => entry.status === "eligible")
      .map((entry) => entry.sourceContentHash),
  );
  const assetByHash = new Map(fixture.measurements.assets.map((asset) => [asset.hash, asset]));
  for (const instance of baseline.instances) {
    const asset = assetByHash.get(instance.assetHash);
    assert.ok(asset, `missing retained measurement ${instance.assetHash}`);
    assert.ok(eligibleSources.has(asset.source.contentHash));
    assert.ok(
      baseline.catalogResolution.bindings.some(
        (binding) =>
          binding.entryHandle === instance.entryHandle && binding.memberId === instance.memberId,
      ),
    );
  }

  const stableBaseline = baseline.instances
    .filter((entry) => entry.intentId !== "PlaceOutdoorProp")
    .map(stableInstance);
  const stableChanged = changed.instances
    .filter((entry) => entry.intentId !== "PlaceOutdoorProp")
    .map(stableInstance);
  assert.deepEqual(stableChanged, stableBaseline);

  if (fixture.catalogCommit.snapshot.entries.length === 0) {
    assert.equal(baseline.status, "incomplete");
    assert.equal(baseline.instances.length, 0);
    assert.deepEqual(baseline.catalogResolution.gaps.map((entry) => entry.requirementId).sort(), [
      "OutdoorGroundcover",
      "OutdoorProps",
      "OutdoorRocks",
      "OutdoorTrees",
    ]);
  } else if (baseline.instances.length > 0) {
    assert.equal(baseline.status, "eligible");
    assert.deepEqual(baseline.diagnostics, []);
    const countsByIntent = new Map<string, number>();
    for (const instance of baseline.instances)
      countsByIntent.set(instance.intentId, (countsByIntent.get(instance.intentId) ?? 0) + 1);
    assert.deepEqual(
      [...countsByIntent].sort(([left], [right]) => left.localeCompare(right)),
      [
        ["PlaceOutdoorGroundcover", 14],
        ["PlaceOutdoorProp", 1],
        ["PlaceOutdoorRocks", 4],
        ["PlaceOutdoorTrees", 6],
      ],
    );
    const importManifest = createRobloxImportManifest(baseline);
    assert.deepEqual(
      importManifest.loweringGaps
        .filter((entry) => entry.kind === "asset_binding")
        .map((entry) => entry.subjectHash),
      [...new Set(baseline.instances.map((entry) => entry.assetHash))].sort(),
    );
  }
});

function stableInstance(instance: {
  readonly instanceId: string;
  readonly intentId: string;
  readonly entryHandle: string;
  readonly memberId: string;
  readonly assetHash: string;
  readonly transformMeters: unknown;
  readonly boundsMeters: unknown;
}) {
  return {
    instanceId: instance.instanceId,
    intentId: instance.intentId,
    entryHandle: instance.entryHandle,
    memberId: instance.memberId,
    assetHash: instance.assetHash,
    transformMeters: instance.transformMeters,
    boundsMeters: instance.boundsMeters,
  };
}
