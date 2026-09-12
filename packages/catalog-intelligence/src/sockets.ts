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

export interface JointSocketFit {
  readonly normalQ32_32: Vector3Fixed;
  readonly originQ32_32: Vector3Fixed;
  readonly boundaryRadiusStuds: number;
  readonly inlierCount: number;
  readonly pointCount: number;
}

export interface JointSocketEvidence {
  readonly variantName: string;
  readonly jointPlaneFits: ReadonlyArray<JointSocketFit>;
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

/**
 * Assembles one assembly-joint socket per planar joint-face fit: origin at
 * the fitted face centroid, normal from the fitted plane, radius clipped to
 * the measured face boundary. Frames are Neutral contact (no plug geometry);
 * up is world +Y projected onto the plane for wall-like faces and world +Z
 * projected for slab-like faces, so wall joints share a canonical up.
 * Members without fits receive no sockets, and callers gate on evidence.
 */
export function buildJointSockets(evidence: JointSocketEvidence): SocketContract[] {
  const sanitized = evidence.variantName.replace(/[^A-Za-z0-9_-]/gu, "_").slice(0, 116);
  return evidence.jointPlaneFits.map((fit, index) => {
    if (!Number.isFinite(fit.boundaryRadiusStuds) || fit.boundaryRadiusStuds <= 0)
      throw new Error("Joint sockets require a positively clipped joint-plane fit");
    const normal = {
      x: dequantizeQ32_32(fit.normalQ32_32.x),
      y: dequantizeQ32_32(fit.normalQ32_32.y),
      z: dequantizeQ32_32(fit.normalQ32_32.z),
    };
    const length = Math.sqrt(normal.x * normal.x + normal.y * normal.y + normal.z * normal.z);
    if (!(length > 0)) throw new Error("Joint sockets require a nonzero joint-plane normal");
    const unit = { x: normal.x / length, y: normal.y / length, z: normal.z / length };
    const sanitizeZero = (value: number): number => (value === 0 ? 0 : value);
    // Slab-like faces (|ny| near 1) degenerate a +Y projection, so they take
    // the mount-style +Z reference instead. Both branches are provably
    // nonzero: the +Y projection keeps length sqrt(1-ny^2) >= sqrt(0.19), and
    // the +Z branch only runs where |ny| > 0.9, hence |nz| < sqrt(0.19).
    const reference = Math.abs(unit.y) <= 0.9 ? { x: 0, y: 1, z: 0 } : { x: 0, y: 0, z: 1 };
    const along = unit.x * reference.x + unit.y * reference.y + unit.z * reference.z;
    const up = {
      x: sanitizeZero(reference.x - along * unit.x),
      y: sanitizeZero(reference.y - along * unit.y),
      z: sanitizeZero(reference.z - along * unit.z),
    };
    const upLength = Math.sqrt(up.x * up.x + up.y * up.y + up.z * up.z);
    if (!(upLength > 1e-9)) throw new Error("Joint-plane normal admits no planar up reference");
    return socketContractSchema.parse({
      socketId: `joint_${sanitized}_${String(index + 1).padStart(2, "0")}`,
      role: "joint",
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
