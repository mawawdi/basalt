import {
  quantizeQ32_32,
  socketContractSchema,
  type SocketContract,
  type Vector3Fixed,
} from "../../basalt-types/src/index.js";
import { dequantizeQ32_32 } from "../../basalt-types/src/fixed.js";

export interface MountSocketFit {
  readonly normalQ32_32: Vector3Fixed;
  readonly originQ32_32: Vector3Fixed;
  readonly boundaryRadiusStuds: number;
  readonly inlierCount: number;
  readonly pointCount: number;
}

export interface MountSocketEvidence {
  readonly variantName: string;
  readonly supportPlaneFits: ReadonlyArray<MountSocketFit>;
}

/**
 * Assembles one ground-mount socket per support-plane fit: origin at the
 * fitted inlier centroid, normal from the fitted plane, radius clipped to the
 * measured contact boundary. Frames are Neutral contact (no plug geometry);
 * up is world +Z projected onto the plane. Socket ids index uniformly so a
 * later second foot never renames the first. Members without fits receive no
 * sockets, and callers gate on evidence.
 */
export function buildMountSockets(evidence: MountSocketEvidence): SocketContract[] {
  const sanitized = evidence.variantName.replace(/[^A-Za-z0-9_-]/gu, "_").slice(0, 116);
  return evidence.supportPlaneFits.map((fit, index) => {
    if (!Number.isFinite(fit.boundaryRadiusStuds) || fit.boundaryRadiusStuds <= 0)
      throw new Error("Mount sockets require a positively clipped support-plane fit");
    const normal = {
      x: dequantizeQ32_32(fit.normalQ32_32.x),
      y: dequantizeQ32_32(fit.normalQ32_32.y),
      z: dequantizeQ32_32(fit.normalQ32_32.z),
    };
    const length = Math.sqrt(normal.x * normal.x + normal.y * normal.y + normal.z * normal.z);
    if (!(length > 0)) throw new Error("Mount sockets require a nonzero support-plane normal");
    const unit = { x: normal.x / length, y: normal.y / length, z: normal.z / length };
    const sanitizeZero = (value: number): number => (value === 0 ? 0 : value);
    const up = {
      x: sanitizeZero(-unit.x * unit.z),
      y: sanitizeZero(-unit.y * unit.z),
      z: sanitizeZero(1 - unit.z * unit.z),
    };
    const upLength = Math.sqrt(up.x * up.x + up.y * up.y + up.z * up.z);
    if (!(upLength > 1e-9)) throw new Error("Support-plane normal admits no planar up reference");
    return socketContractSchema.parse({
      socketId: `mount_${sanitized}_${String(index + 1).padStart(2, "0")}`,
      role: "mount",
      polarity: "Neutral",
      localOrigin: { ...fit.originQ32_32 },
      normal: { ...fit.normalQ32_32 },
      upVector: {
        x: quantizeQ32_32(up.x / upLength),
        y: quantizeQ32_32(up.y / upLength),
        z: quantizeQ32_32(up.z / upLength),
      },
      boundaryRadius: quantizeQ32_32(fit.boundaryRadiusStuds),
      angularStepDegrees: 0,
    });
  });
}
