import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, symlink, writeFile, mkdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const harness = await import(pathToFileURL(resolve("scripts/generation-benchmark.mjs")).href);
const views = await import(pathToFileURL(resolve("scripts/world-preview-views.mjs")).href);

test("generation review cannot turn invalid, stale or uncertain evidence into success", () => {
  const brief = { checks: ["Camp is visible"] };
  const capture = { ok: true, worldBuildHash: "a".repeat(64) };
  const review = {
    worldBuildHash: capture.worldBuildHash,
    status: "eligible",
    authority: "delegated_ai",
    independent: false,
    checks: [{ check: brief.checks[0], verdict: "pass", note: "Visible in camp view." }],
    note: "Inspected the complete evidence packet.",
  };
  assert.doesNotThrow(() => harness.validateReview(review, brief, capture));
  assert.throws(() => harness.validateReview(review, brief, { ...capture, ok: false }));
  assert.throws(() =>
    harness.validateReview({ ...review, worldBuildHash: "b".repeat(64) }, brief, capture),
  );
  assert.throws(() => harness.validateReview({ ...review, independent: true }, brief, capture));
  assert.throws(() =>
    harness.validateReview(
      { ...review, checks: [{ ...review.checks[0], verdict: "uncertain" }] },
      brief,
      capture,
    ),
  );
  const run = {
    id: "sample",
    status: "incomplete",
    startedAt: 1000,
    finishedAt: 101000,
    events: [{ action: "capture", ok: true, elapsedSeconds: 95, seconds: 5 }],
    reviews: [],
  };
  const summary = harness.summarizeRun(run);
  assert.equal(summary.firstPreviewSeconds, 95);
  assert.equal(summary.withinTarget, false);
  assert.equal(summary.modelCallCount, null);
  assert.equal(summary.engineVerified, false);
  assert.equal(
    harness.summarizeRun({
      ...run,
      status: "eligible",
      reviews: [{ ...review, elapsedSeconds: 301 }],
    }).withinTarget,
    false,
  );
});

test("optional artifacts distinguish missing files from unsafe paths", async () => {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), "basalt-generation-")));
  try {
    assert.equal(await harness.optionalArtifactHash(root, "absent.json"), undefined);
    await writeFile(resolve(root, "run.json"), "{}");
    assert.match(await harness.optionalArtifactHash(root, "run.json"), /^[0-9a-f]{64}$/);
    await symlink(resolve(root, "run.json"), resolve(root, "link.json"));
    await mkdir(resolve(root, "directory"));
    await assert.rejects(harness.optionalArtifactHash(root, "link.json"));
    await assert.rejects(harness.optionalArtifactHash(root, "directory"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("inspection cameras bind the exact world and reject unusable or unsafe captures", () => {
  const hash = "a".repeat(64);
  const cameras = views.defaultPreviewViews(hash, { x: 50, y: 2, z: 50 }, 100);
  const packet = { worldBuildHash: hash, cameras };
  assert.deepEqual(views.parsePreviewViews(packet, hash), cameras);
  assert.throws(() => views.parsePreviewViews(packet, "b".repeat(64)), /different world/);
  assert.throws(
    () => views.parsePreviewViews({ ...packet, cameras: [cameras[0], cameras[0]] }, hash),
    /unique/,
  );
  for (const camera of [
    { ...cameras[0], cameraId: "../outside" },
    { ...cameras[0], lookAtMeters: cameras[0].positionMeters },
    { ...cameras[0], up: { x: 0, y: 0, z: 0 } },
    { ...cameras[0], positionMeters: { x: 0, y: 0, z: 0 }, lookAtMeters: { x: 0, y: 1, z: 0 } },
  ])
    assert.throws(() => views.parsePreviewViews({ ...packet, cameras: [camera] }, hash));
});
