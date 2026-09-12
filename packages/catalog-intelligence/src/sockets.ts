import {
  quantizeQ32_32,
  socketContractSchema,
  type SocketContract,
  type Vector3Fixed,
} from "../../basalt-types/src/index.js";
import { dequantizeQ32_32 } from "../../basalt-types/src/fixed.js";

export interface MountSocketEvidence {
  readonly variantName: string;
  readonly boundsMin: Vector3Fixed;
  readonly boundsMax: Vector3Fixed;
  readonly contactAreaStuds2: number;
}

/**
 * Derives a ground-mount socket from measured evidence: origin at the bottom
 * center of the member bounds, radius from the measured bottom-contact area.
 * The frame is Neutral contact (no plug geometry): normal follows the support
 * direction, up is an arbitrary perpendicular reference. Archetypes without
 * bottom contact receive no socket; callers must gate on evidence.
 */
export function buildMountSocket(evidence: MountSocketEvidence): SocketContract {
  if (!Number.isFinite(evidence.contactAreaStuds2) || evidence.contactAreaStuds2 <= 0)
    throw new Error("Mount sockets require positive bottom-contact evidence");
  const min = {
    x: dequantizeQ32_32(evidence.boundsMin.x),
    y: dequantizeQ32_32(evidence.boundsMin.y),
    z: dequantizeQ32_32(evidence.boundsMin.z),
  };
  const max = {
    x: dequantizeQ32_32(evidence.boundsMax.x),
    y: dequantizeQ32_32(evidence.boundsMax.y),
    z: dequantizeQ32_32(evidence.boundsMax.z),
  };
  const sanitized = evidence.variantName.replace(/[^A-Za-z0-9_-]/gu, "_").slice(0, 121);
  return socketContractSchema.parse({
    socketId: `mount_${sanitized}`,
    role: "mount",
    polarity: "Neutral",
    localOrigin: {
      x: quantizeQ32_32((min.x + max.x) / 2),
      y: quantizeQ32_32(min.y),
      z: quantizeQ32_32((min.z + max.z) / 2),
    },
    normal: { x: "0", y: "4294967296", z: "0" },
    upVector: { x: "0", y: "0", z: "4294967296" },
    boundaryRadius: quantizeQ32_32(Math.sqrt(evidence.contactAreaStuds2 / Math.PI)),
    angularStepDegrees: 0,
  });
}
