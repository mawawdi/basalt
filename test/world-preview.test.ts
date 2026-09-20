import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const views = await import(pathToFileURL(resolve("scripts/world-preview-views.mjs")).href);

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
