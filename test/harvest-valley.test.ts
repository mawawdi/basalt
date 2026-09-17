import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  CATALOG_AUTHORITY_COMMIT_SCHEMA,
  CATALOG_CREATOR_REVIEW_DECISION_SCHEMA,
  sealCatalogCreatorReviewDecision,
} from "@basalt/catalog-authoring";
import { compileBasaltWorld, sampleTerrainFieldElevation } from "@basalt/world-compiler";
import {
  harvestValleyFixture,
  HARVEST_VALLEY_SIZE_METERS,
} from "./helpers/harvest-valley-fixture.js";
import { loadSemanticRegistry } from "./helpers/semantic-registry.js";

test("Harvest Valley resolves a varied exterior scene without primitive structures or catalog gaps", async () => {
  const fixture = await harvestValleyFixture(await loadSemanticRegistry());
  const world = compileBasaltWorld(fixture.compileInput);
  assert.equal(world.status, "eligible", world.diagnostics.join("; "));
  assert.equal(compileBasaltWorld(fixture.compileInput).worldBuildHash, world.worldBuildHash);
  assert.deepEqual(world.catalogResolution.gaps, []);
  assert.deepEqual(world.diagnostics, []);
  assert.equal(world.meso.constructedStructures.length, 0);
  assert.equal(fixture.plan.structuralPrograms.length, 0);
  const treeHandles = new Set(
    fixture.catalogCommit.snapshot.entries
      .filter(
        (entry) =>
          entry.kind !== "collection" && entry.semantic.denotation.conceptId === "bsc_000003",
      )
      .map((entry) => entry.handle),
  );
  const trees = world.instances.filter((item) => treeHandles.has(item.entryHandle));
  const nearestTreeDistances = trees
    .map((tree) => {
      const at = tree.transformMeters.position;
      return Math.min(
        ...trees
          .filter((other) => other !== tree)
          .map((other) => {
            const to = other.transformMeters.position;
            return Math.hypot(at.x - to.x, at.z - to.z);
          }),
      );
    })
    .sort((a, b) => a - b);
  assert.ok(
    nearestTreeDistances[Math.floor(nearestTreeDistances.length / 2)]! < 5,
    "Woodland canopies must form stands rather than isolated park trees",
  );
  assert.ok(
    !world.instances.some((item) => {
      const { x, z } = item.transformMeters.position;
      return x > 57 && x < 68 && z > 10 && z < 28;
    }),
    "The arrival pasture is an intentional empty space",
  );
  assert.equal(new Set(world.instances.map((item) => item.entryHandle)).size, 60);
  for (const handle of [
    "rural_farmhouse",
    "rural_long_barn",
    "rural_small_barn",
    "rural_wind_pump",
    "rural_stone_arch",
    "rural_canvas_shelter",
  ])
    assert.equal(world.instances.filter((item) => item.entryHandle === handle).length, 1, handle);
  // The rotor, tail, and tower occupy different parts of the source envelope.
  // At 20 degrees, rotating its aggregate box overstates X by 1.246 m and Z
  // by 0.539 m. These are the union of the three separately rotated boxes.
  const windPump = world.instances.find((item) => item.entryHandle === "rural_wind_pump")!;
  for (const [axis, expected] of Object.entries({
    x: 3.9443368086460993,
    y: 11.48051731963642,
    z: 5.285626651233812,
  })) {
    const key = axis as "x" | "y" | "z";
    assert.ok(
      Math.abs(windPump.boundsMeters.max[key] - windPump.boundsMeters.min[key] - expected) < 1e-8,
      `wind pump ${axis} must match bounds of its individually rotated parts`,
    );
  }
  assert.ok(
    !world.instances.some((item) =>
      ["tree_pine_large_01_ground", "tree_willow_large_01_ground"].includes(item.entryHandle),
    ),
  );
  assert.equal(world.foundation.routeConstructions.length, 13);
  assert.ok(
    world.foundation.routeConstructions.every(
      (route) => route.treatmentKind === "follow_surface" && route.status === "eligible",
    ),
  );
  for (const intent of fixture.plan.realizationIntents) {
    if (intent.kind !== "single" || intent.yawDegrees === undefined) continue;
    const instance = world.instances.find((item) => item.intentId === intent.intentId);
    assert.ok(instance, intent.intentId);
    assert.ok(
      Math.abs(
        instance.transformMeters.rotation[1] - Math.sin((intent.yawDegrees * Math.PI) / 360),
      ) < 1e-10,
    );
    assert.ok(
      Math.abs(
        instance.transformMeters.rotation[3] - Math.cos((intent.yawDegrees * Math.PI) / 360),
      ) < 1e-10,
    );
  }
  const surfaceHeight = (x: number, z: number) =>
    sampleTerrainFieldElevation(
      world.foundation.terrainFields[0]!,
      world.foundation.baseTerrainFields[0]!,
      world.foundation.routeConstructions,
      world.foundation.routeJunctions,
      x,
      z,
    );
  for (const run of fixture.fenceRuns) {
    for (let i = 1; i < run.length; i += 1) {
      const previous = world.instances.find((entry) => entry.intentId === run[i - 1])!;
      const next = world.instances.find((entry) => entry.intentId === run[i])!;
      const gapX = Math.max(
        0,
        previous.boundsMeters.min.x - next.boundsMeters.max.x,
        next.boundsMeters.min.x - previous.boundsMeters.max.x,
      );
      const gapZ = Math.max(
        0,
        previous.boundsMeters.min.z - next.boundsMeters.max.z,
        next.boundsMeters.min.z - previous.boundsMeters.max.z,
      );
      assert.ok(Math.hypot(gapX, gapZ) < 1e-6, `${run[i]} leaves an accidental fence gap`);
      assert.ok(
        Math.abs(previous.boundsMeters.min.y - next.boundsMeters.min.y) < 1e-6,
        `${run[i]} leaves an uneven fence joint`,
      );
    }
  }
  const contactIds = new Set([
    "Farmhouse",
    "MainBarn",
    "UpperBarn",
    "Market",
    "WindPump",
    "StockTrough",
    "FarmBench",
    "Shelter",
    "Campfire",
    "CampLog",
    ...fixture.fenceRuns.flat(),
  ]);
  for (const instance of world.instances) {
    const at = instance.transformMeters.position;
    assert.ok(
      Math.abs(instance.boundsMeters.min.y - surfaceHeight(at.x, at.z)) < 1e-8,
      `${instance.intentId} is not bottom-aligned`,
    );
    if (!contactIds.has(instance.intentId)) continue;
    const b = instance.boundsMeters;
    for (const x of [b.min.x, (b.min.x + b.max.x) / 2, b.max.x])
      for (const z of [b.min.z, (b.min.z + b.max.z) / 2, b.max.z])
        assert.ok(
          Math.abs(b.min.y - surfaceHeight(x, z)) < 0.005,
          `${instance.intentId} lacks a flat complete footprint at ${x}, ${z}`,
        );
  }
  const connected = new Set(["Arrival"]);
  for (let pass = 0; pass < fixture.plan.routes.length; pass += 1)
    for (const junction of fixture.plan.routeJunctions)
      if (junction.participants.some((part) => connected.has(part.routeId)))
        for (const part of junction.participants) connected.add(part.routeId);
  assert.equal(connected.size, fixture.plan.routes.length);
  for (const instance of world.instances) {
    assert.ok(instance.boundsMeters.min.x >= 0 && instance.boundsMeters.min.z >= 0);
    assert.ok(
      instance.boundsMeters.max.x <= HARVEST_VALLEY_SIZE_METERS &&
        instance.boundsMeters.max.z <= HARVEST_VALLEY_SIZE_METERS,
    );
    for (const route of world.foundation.routeConstructions)
      for (const segment of route.travelSegments) {
        const object = instance.boundsMeters;
        const travel = segment.boundsMeters;
        assert.ok(
          object.max.x <= travel.min.x ||
            object.min.x >= travel.max.x ||
            object.max.z <= travel.min.z ||
            object.min.z >= travel.max.z,
          `${instance.intentId} blocks ${route.routeId}`,
        );
      }
  }
});

test("mixed authored catalog batches retain exact review roots and honest delegated provenance", async () => {
  const commit = CATALOG_AUTHORITY_COMMIT_SCHEMA.parse(
    JSON.parse(await readFile("registry/catalog.json", "utf8")),
  );
  const visualRoots = commit.retainedEvidence.filter(
    (entry) => entry.kind === "CatalogVisualReviewIndex",
  );
  assert.ok(visualRoots.length >= 2);
  assert.ok(commit.acceptanceAudits.some((audit) => audit.reviewer.authority === "creator"));
  const audit = commit.acceptanceAudits.find(
    (entry) => entry.reviewer.authority === "delegated_ai",
  );
  assert.ok(audit);
  const decision = CATALOG_CREATOR_REVIEW_DECISION_SCHEMA.parse(
    JSON.parse(await readFile(`registry/evidence/${audit.reviewDecisionHash}.json`, "utf8")),
  );
  assert.equal(decision.reviewMethod, "delegated_visual_review");
  const { kind: _kind, hash: _hash, ...material } = decision;
  assert.throws(
    () =>
      sealCatalogCreatorReviewDecision({ ...material, reviewMethod: "independent_visual_review" }),
    /provenance/u,
  );
  assert.throws(
    () =>
      CATALOG_AUTHORITY_COMMIT_SCHEMA.parse({
        ...commit,
        retainedEvidence: commit.retainedEvidence.filter(
          (entry) => entry.artifactHash !== visualRoots[0]!.artifactHash,
        ),
      }),
    /stale or incomplete/u,
  );
});
