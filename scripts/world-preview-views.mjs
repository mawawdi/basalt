import { z } from "zod";
import { HASH_SCHEMA } from "@basalt/contracts";
import { WORLD_CAMERA_SCHEMA } from "@basalt/world-planning";

const packetSchema = z
  .object({
    worldBuildHash: HASH_SCHEMA,
    cameras: z.array(WORLD_CAMERA_SCHEMA).min(1),
  })
  .strict();

export function parsePreviewViews(input, worldBuildHash) {
  const packet = packetSchema.parse(input);
  if (packet.worldBuildHash !== worldBuildHash)
    throw new Error("Preview views bind a different world");
  const names = new Set();
  for (const camera of packet.cameras) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(camera.cameraId) || names.has(camera.cameraId))
      throw new Error("Preview camera IDs must be unique safe filenames");
    names.add(camera.cameraId);
    const p = camera.positionMeters,
      t = camera.lookAtMeters,
      u = camera.up;
    const d = [t.x - p.x, t.y - p.y, t.z - p.z];
    const cross = [d[1] * u.z - d[2] * u.y, d[2] * u.x - d[0] * u.z, d[0] * u.y - d[1] * u.x];
    if (
      Math.hypot(...d) < 1e-6 ||
      Math.hypot(...cross) / Math.hypot(...d) / Math.hypot(u.x, u.y, u.z) < 1e-6
    )
      throw new Error("Preview camera needs a nondegenerate viewing direction and up vector");
  }
  return packet.cameras;
}

export function defaultPreviewViews(worldBuildHash, center, extent) {
  const descriptions = [
    ["overview", [0.74, 0.95, -0.74], [0, 0, 0]],
    ["arrival", [0.1, 0.08, -0.29], [-0.06, 0.03, -0.04]],
    ["ridge", [0.44, 0.28, 0.47], [0.03, 0.04, 0.01]],
  ];
  const point = (v) => ({
    x: center.x + v[0] * extent,
    y: center.y + v[1] * extent,
    z: center.z + v[2] * extent,
  });
  return parsePreviewViews(
    {
      worldBuildHash,
      cameras: descriptions.map(([cameraId, position, target]) => ({
        cameraId,
        positionMeters: point(position),
        lookAtMeters: point(target),
        up: { x: 0, y: 1, z: 0 },
        fieldOfViewDegrees: 52,
        regionIds: [],
        readabilityIntent: {
          kind: "art_directed",
          rationale: "Generic inspection view; does not establish coverage of requested features.",
        },
      })),
    },
    worldBuildHash,
  );
}
