import assert from "node:assert/strict";
import test from "node:test";
import { contentHash } from "@basalt/contracts";
import { OccupancyIndex, sealOccupancyReservation, type SpatialObb } from "@basalt/spatial-core";

const evidenceHash = contentHash("measured-collision-evidence");
const identityRotation: [number, number, number, number] = [0, 0, 0, 1];

function reservation(sourceInstanceId: string, obb: SpatialObb) {
  return sealOccupancyReservation({
    sourceInstanceId,
    surfaceId: "shared_surface",
    stratum: "object",
    bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 10 } },
    collisionEvidenceHash: evidenceHash,
    narrowPhaseObbs: [obb],
  });
}

test("occupancy uses measured narrow phase after full-extent broad phase", () => {
  const index = new OccupancyIndex();
  index.reserve(
    reservation("instance_a", {
      center: { x: 1, y: 1, z: 1 },
      halfSize: { x: 0.5, y: 0.5, z: 0.5 },
      rotation: identityRotation,
    }),
  );
  const separated = reservation("instance_b", {
    center: { x: 9, y: 9, z: 9 },
    halfSize: { x: 0.5, y: 0.5, z: 0.5 },
    rotation: identityRotation,
  });
  assert.deepEqual(index.conflicts(separated), []);

  const intersecting = reservation("instance_c", {
    center: { x: 1.4, y: 1, z: 1 },
    halfSize: { x: 0.5, y: 0.5, z: 0.5 },
    rotation: identityRotation,
  });
  assert.equal(index.conflicts(intersecting).length, 1);
});

test("occupancy refuses unproven narrow-phase geometry", () => {
  assert.throws(
    () =>
      sealOccupancyReservation({
        sourceInstanceId: "instance_a",
        surfaceId: "shared_surface",
        stratum: "object",
        bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 2, y: 2, z: 2 } },
        narrowPhaseObbs: [
          {
            center: { x: 1, y: 1, z: 1 },
            halfSize: { x: 1, y: 1, z: 1 },
            rotation: identityRotation,
          },
        ],
      }),
    /measured collision evidence/,
  );
});
