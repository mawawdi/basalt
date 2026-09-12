import { dequantizeQ32_32 } from "../../basalt-types/src/fixed.js";
import type { SocketContract } from "../../basalt-types/src/index.js";
import { JOINT_PLANE_DISTANCE_STUDS } from "../../asset-inspection/src/joint-planes.js";

/**
 * Joint-mismatch budget shaped exactly like the world-plan tolerances
 * schema: support bounds face separation along the joint normal,
 * penetration bounds face overlap along the normal, and clearance bounds
 * lateral mismatch in the contact plane. Tilt has no separate allowance:
 * a tilted pair mates only when the tilt-induced offset at the contact
 * boundary still fits clearance.
 */
export interface JointTolerances {
  readonly support: number;
  readonly penetration: number;
  readonly clearance: number;
}

/**
 * Verdict geometry: the modularity gate holds faces to the fitter's own
 * plane gate, so a sealed kit mates under exact measured geometry and
 * world plans can only relax from there.
 */
export const JOINT_VERDICT_TOLERANCES: JointTolerances = {
  support: JOINT_PLANE_DISTANCE_STUDS,
  penetration: JOINT_PLANE_DISTANCE_STUDS,
  clearance: JOINT_PLANE_DISTANCE_STUDS,
};

const FLOAT_EPSILON = 1e-9;

export interface JointMateAssessment {
  readonly mates: boolean;
  readonly reasons: ReadonlyArray<string>;
}

export interface JointFrame {
  readonly normal: { readonly x: number; readonly y: number; readonly z: number };
  readonly origin: { readonly x: number; readonly y: number; readonly z: number };
  readonly radius: number;
}

function frameOf(socket: SocketContract): JointFrame {
  return {
    normal: {
      x: dequantizeQ32_32(socket.normal.x),
      y: dequantizeQ32_32(socket.normal.y),
      z: dequantizeQ32_32(socket.normal.z),
    },
    origin: {
      x: dequantizeQ32_32(socket.localOrigin.x),
      y: dequantizeQ32_32(socket.localOrigin.y),
      z: dequantizeQ32_32(socket.localOrigin.z),
    },
    radius: dequantizeQ32_32(socket.boundaryRadius),
  };
}

/** Whether two joint sockets mate under a tolerance triple, with reasons. */
export function jointsMate(
  left: SocketContract,
  right: SocketContract,
  tolerances: JointTolerances,
): JointMateAssessment {
  for (const [name, value] of Object.entries(tolerances)) {
    if (!Number.isFinite(value) || value < 0)
      throw new Error(`Joint mating requires a finite nonnegative ${name} tolerance`);
  }
  return jointsMateFrames(frameOf(left), frameOf(right), tolerances);
}

/**
 * Algebra-only mating precheck: agrees with the full assessment away from
 * float boundaries, no trigonometry, no reasons. Rotation search filters
 * candidates through this, then confirms passes with the full assessment,
 * so recorded verdicts are exactly full-assessment semantics.
 */
function framesMateQuick(a: JointFrame, b: JointFrame, tolerances: JointTolerances): boolean {
  const opposition = -(a.normal.x * b.normal.x + a.normal.y * b.normal.y + a.normal.z * b.normal.z);
  if (opposition <= 0) return false;
  const maxRadius = Math.max(a.radius, b.radius);
  const allowance = tolerances.clearance + FLOAT_EPSILON;
  if (maxRadius * maxRadius * (1 - opposition * opposition) > allowance * allowance) return false;
  const separation = {
    x: b.origin.x - a.origin.x,
    y: b.origin.y - a.origin.y,
    z: b.origin.z - a.origin.z,
  };
  const gap = separation.x * a.normal.x + separation.y * a.normal.y + separation.z * a.normal.z;
  if (gap > tolerances.support + FLOAT_EPSILON) return false;
  if (gap < -tolerances.penetration - FLOAT_EPSILON) return false;
  const lateralX = separation.x - gap * a.normal.x;
  const lateralY = separation.y - gap * a.normal.y;
  const lateralZ = separation.z - gap * a.normal.z;
  const lateral = Math.sqrt(lateralX * lateralX + lateralY * lateralY + lateralZ * lateralZ);
  return lateral <= a.radius + b.radius + tolerances.clearance + FLOAT_EPSILON;
}

export function jointsMateFrames(
  a: JointFrame,
  b: JointFrame,
  tolerances: JointTolerances,
): JointMateAssessment {
  const reasons: string[] = [];
  const opposition = -(a.normal.x * b.normal.x + a.normal.y * b.normal.y + a.normal.z * b.normal.z);
  const tiltRadians = Math.acos(Math.max(-1, Math.min(1, opposition)));
  const tiltDegrees = (tiltRadians * 180) / Math.PI;
  // Hemisphere gate first: the tilt-to-offset mapping only holds near
  // opposition. Faces pointing the same way (tilt at or past 90 degrees)
  // can never mate, no matter how small sin(tilt) floats back to.
  if (opposition <= 0)
    reasons.push(
      `joint normals are not opposed (tilt ${tiltDegrees.toFixed(4)} degrees from mating alignment)`,
    );
  const edgeOffset = Math.max(a.radius, b.radius) * Math.sin(tiltRadians);
  if (edgeOffset > tolerances.clearance + FLOAT_EPSILON)
    reasons.push(
      `joint tilt ${tiltDegrees.toFixed(4)} degrees displaces the contact boundary by ${edgeOffset.toFixed(4)} studs, beyond clearance ${tolerances.clearance}`,
    );
  const separation = {
    x: b.origin.x - a.origin.x,
    y: b.origin.y - a.origin.y,
    z: b.origin.z - a.origin.z,
  };
  const gap = separation.x * a.normal.x + separation.y * a.normal.y + separation.z * a.normal.z;
  if (gap > tolerances.support + FLOAT_EPSILON)
    reasons.push(`joint gap ${gap.toFixed(4)} studs exceeds support ${tolerances.support}`);
  if (gap < -tolerances.penetration - FLOAT_EPSILON)
    reasons.push(
      `joint overlap ${(-gap).toFixed(4)} studs exceeds penetration ${tolerances.penetration}`,
    );
  const lateralX = separation.x - gap * a.normal.x;
  const lateralY = separation.y - gap * a.normal.y;
  const lateralZ = separation.z - gap * a.normal.z;
  const lateral = Math.sqrt(lateralX * lateralX + lateralY * lateralY + lateralZ * lateralZ);
  if (lateral > a.radius + b.radius + tolerances.clearance + FLOAT_EPSILON)
    reasons.push(
      `joint centers ${lateral.toFixed(4)} studs apart exceed contact radii ${a.radius.toFixed(4)}+${b.radius.toFixed(4)} plus clearance ${tolerances.clearance}`,
    );
  return { mates: reasons.length === 0, reasons };
}

export type ModularKitStatus = "modular" | "pending" | "quarantined";

export interface ModularKitMember {
  readonly assetId: string;
  readonly variantName: string;
  readonly sockets: ReadonlyArray<SocketContract>;
  /** Joint-plane refusal reason, or null when the member measured cleanly. */
  readonly refusal: string | null;
  /** Sealed member bounds in Q32.32, dequantized once for placement. */
  readonly boundsMinimumQ32_32: { readonly x: string; readonly y: string; readonly z: string };
  readonly boundsMaximumQ32_32: { readonly x: string; readonly y: string; readonly z: string };
}

export interface MatingJointPair {
  readonly leftMember: number;
  readonly leftSocket: number;
  readonly rightMember: number;
  readonly rightSocket: number;
  /** Quarter-turns about +Y applied to the right member to mate. */
  readonly rotationStepsY90: number;
}

interface MemberPlacement {
  readonly frames: ReadonlyArray<JointFrame>;
  readonly boundsMinimum: { readonly x: number; readonly y: number; readonly z: number };
  readonly boundsMaximum: { readonly x: number; readonly y: number; readonly z: number };
}

/** Quarter-turn about +Y: (x, y, z) -> (z, y, -x) per step. Exact. */
export function rotateY90Steps(
  point: { readonly x: number; readonly y: number; readonly z: number },
  steps: number,
): { readonly x: number; readonly y: number; readonly z: number } {
  const normalized = ((steps % 4) + 4) % 4;
  if (normalized === 0) return point;
  if (normalized === 1) return { x: point.z, y: point.y, z: -point.x };
  if (normalized === 2) return { x: -point.x, y: point.y, z: -point.z };
  return { x: -point.z, y: point.y, z: point.x };
}

function transformBounds(
  placement: MemberPlacement,
  steps: number,
  translation: { readonly x: number; readonly y: number; readonly z: number },
): {
  readonly minimum: { readonly x: number; readonly y: number; readonly z: number };
  readonly maximum: { readonly x: number; readonly y: number; readonly z: number };
} {
  const corners = [
    { x: placement.boundsMinimum.x, y: placement.boundsMinimum.y, z: placement.boundsMinimum.z },
    { x: placement.boundsMaximum.x, y: placement.boundsMinimum.y, z: placement.boundsMinimum.z },
    { x: placement.boundsMinimum.x, y: placement.boundsMaximum.y, z: placement.boundsMinimum.z },
    { x: placement.boundsMaximum.x, y: placement.boundsMaximum.y, z: placement.boundsMaximum.z },
    { x: placement.boundsMinimum.x, y: placement.boundsMinimum.y, z: placement.boundsMaximum.z },
    { x: placement.boundsMaximum.x, y: placement.boundsMinimum.y, z: placement.boundsMaximum.z },
    { x: placement.boundsMinimum.x, y: placement.boundsMaximum.y, z: placement.boundsMaximum.z },
    { x: placement.boundsMaximum.x, y: placement.boundsMaximum.y, z: placement.boundsMaximum.z },
  ].map((corner) => {
    const rotated = rotateY90Steps(corner, steps);
    return {
      x: rotated.x + translation.x,
      y: rotated.y + translation.y,
      z: rotated.z + translation.z,
    };
  });
  return {
    minimum: {
      x: Math.min(...corners.map((corner) => corner.x)),
      y: Math.min(...corners.map((corner) => corner.y)),
      z: Math.min(...corners.map((corner) => corner.z)),
    },
    maximum: {
      x: Math.max(...corners.map((corner) => corner.x)),
      y: Math.max(...corners.map((corner) => corner.y)),
      z: Math.max(...corners.map((corner) => corner.z)),
    },
  };
}

/**
 * Whether two member volumes can sit disjoint after alignment. Touching at
 * the contact plane (zero-thickness overlap) is disjoint; strictly
 * overlapping interiors are not. AABB-conservative: interlocking concave
 * pieces read as colliding and stay quarantined with reasons.
 */
function volumesDisjoint(
  left: MemberPlacement,
  right: MemberPlacement,
  steps: number,
  translation: { readonly x: number; readonly y: number; readonly z: number },
): boolean {
  const moved = transformBounds(right, steps, translation);
  return (
    moved.minimum.x >= left.boundsMaximum.x - FLOAT_EPSILON ||
    left.boundsMinimum.x >= moved.maximum.x - FLOAT_EPSILON ||
    moved.minimum.y >= left.boundsMaximum.y - FLOAT_EPSILON ||
    left.boundsMinimum.y >= moved.maximum.y - FLOAT_EPSILON ||
    moved.minimum.z >= left.boundsMaximum.z - FLOAT_EPSILON ||
    left.boundsMinimum.z >= moved.maximum.z - FLOAT_EPSILON
  );
}

export interface ModularKitVerdict {
  readonly status: ModularKitStatus;
  readonly reason: string;
  /** Mating socket index pairs in assessment order; empty unless modular. */
  readonly matingPairs: ReadonlyArray<MatingJointPair>;
}

/**
 * Grid-placement search for one face pair: quarter-turns about +Y in
 * ascending order, each followed by the face-centering translation. The
 * first rotation whose aligned faces verify under the tolerances with
 * disjoint volumes wins; null when no grid placement mates. Candidates
 * filter through the algebra precheck, so the full assessment (with
 * trigonometry) runs only on passes and the recorded failure sample.
 */
function placeableSteps(
  left: MemberPlacement,
  leftSocket: number,
  right: MemberPlacement,
  rightSocket: number,
  tolerances: JointTolerances,
): number | null {
  const a = left.frames[leftSocket]!;
  const b = right.frames[rightSocket]!;
  for (let steps = 0; steps < 4; steps += 1) {
    const rotatedNormal = rotateY90Steps(b.normal, steps);
    const rotatedOrigin = rotateY90Steps(b.origin, steps);
    const translation = {
      x: a.origin.x - rotatedOrigin.x,
      y: a.origin.y - rotatedOrigin.y,
      z: a.origin.z - rotatedOrigin.z,
    };
    // Identity placement never tiles: same-member coincidence is shared
    // authored geometry (mirrored variants, repeated submeshes), not an
    // assembly move. Cross-member coincidence stays legal (split blocks).
    if (
      left === right &&
      translation.x * translation.x +
        translation.y * translation.y +
        translation.z * translation.z <=
        FLOAT_EPSILON * FLOAT_EPSILON
    )
      continue;
    const aligned: JointFrame = {
      normal: rotatedNormal,
      origin: {
        x: rotatedOrigin.x + translation.x,
        y: rotatedOrigin.y + translation.y,
        z: rotatedOrigin.z + translation.z,
      },
      radius: b.radius,
    };
    if (!framesMateQuick(a, aligned, tolerances)) continue;
    if (!volumesDisjoint(left, right, steps, translation)) continue;
    if (!jointsMateFrames(a, aligned, tolerances).mates) continue;
    return steps;
  }
  return null;
}

/**
 * Full-assessment reasons for the first pair in loop order, on demand.
 * Reports the unrotated alignment's reasons and notes the rotation search,
 * so the sample names the dominant failure without listing all four turns.
 */
function firstFailureReasons(
  members: ReadonlyArray<ModularKitMember>,
  placements: ReadonlyArray<MemberPlacement>,
  tolerances: JointTolerances,
): ReadonlyArray<string> {
  for (let left = 0; left < members.length; left += 1) {
    for (let right = left; right < members.length; right += 1) {
      const leftFrames = placements[left]!.frames;
      const rightFrames = placements[right]!.frames;
      for (let a = 0; a < leftFrames.length; a += 1) {
        for (let b = 0; b < rightFrames.length; b += 1) {
          if (left === right && b <= a) continue;
          const base = leftFrames[a]!;
          const candidate = rightFrames[b]!;
          const translation = {
            x: base.origin.x - candidate.origin.x,
            y: base.origin.y - candidate.origin.y,
            z: base.origin.z - candidate.origin.z,
          };
          const aligned: JointFrame = {
            normal: candidate.normal,
            origin: {
              x: candidate.origin.x + translation.x,
              y: candidate.origin.y + translation.y,
              z: candidate.origin.z + translation.z,
            },
            radius: candidate.radius,
          };
          return [
            ...jointsMateFrames(base, aligned, tolerances).reasons,
            "all 4 quarter-turns fail",
          ];
        }
      }
    }
  }
  return [];
}

/**
 * Per-member mating socket indices from a verdict. Seals carry only this
 * subset: faces outside it afford no in-family assembly, while measurement
 * keeps every face for later cross-family passes.
 */
export function matingFaceSets(
  verdict: ModularKitVerdict,
  memberCount: number,
): ReadonlyArray<ReadonlySet<number>> {
  const sets: Set<number>[] = Array.from({ length: memberCount }, () => new Set<number>());
  for (const pair of verdict.matingPairs) {
    sets[pair.leftMember]?.add(pair.leftSocket);
    sets[pair.rightMember]?.add(pair.rightSocket);
  }
  return sets;
}

/**
 * Family-level modularity gate. A kit is modular when every member exposes
 * at least one measured joint face and every member takes part in at least
 * one mating pair — across members, or a member tiling with itself through
 * two of its own faces. Mating is placeability, not local-frame
 * coincidence: the right member may take grid quarter-turns about +Y (kit
 * pieces keep their authored up) plus the face-centering translation, and
 * the pair mates when the aligned faces verify under the tolerances with
 * disjoint volumes. Refused members hold the verdict at pending
 * (measurement, not geometry, is missing); measured-but-faceless,
 * unmated, or partially mating families are quarantined with the precise
 * reason, so a later cross-family kit pass can distinguish hopeless
 * geometry from in-family mismatch.
 */
export function evaluateModularKit(
  members: ReadonlyArray<ModularKitMember>,
  tolerances: JointTolerances = JOINT_VERDICT_TOLERANCES,
): ModularKitVerdict {
  if (members.length === 0) throw new Error("Modular kit verdict requires at least one member");
  for (const member of members) {
    if (member.refusal !== null)
      return {
        status: "pending",
        reason: `member ${member.variantName} (${member.assetId}) awaits joint measurement: ${member.refusal}`,
        matingPairs: [],
      };
    if (member.sockets.length === 0)
      return {
        status: "quarantined",
        reason: `member ${member.variantName} (${member.assetId}) exposes no planar joint faces`,
        matingPairs: [],
      };
  }
  const placements: MemberPlacement[] = members.map((member) => ({
    frames: member.sockets.map(frameOf),
    boundsMinimum: {
      x: dequantizeQ32_32(member.boundsMinimumQ32_32.x),
      y: dequantizeQ32_32(member.boundsMinimumQ32_32.y),
      z: dequantizeQ32_32(member.boundsMinimumQ32_32.z),
    },
    boundsMaximum: {
      x: dequantizeQ32_32(member.boundsMaximumQ32_32.x),
      y: dequantizeQ32_32(member.boundsMaximumQ32_32.y),
      z: dequantizeQ32_32(member.boundsMaximumQ32_32.z),
    },
  }));
  const matingPairs: MatingJointPair[] = [];
  for (let left = 0; left < members.length; left += 1) {
    for (let right = left; right < members.length; right += 1) {
      const leftPlacement = placements[left]!;
      const rightPlacement = placements[right]!;
      for (let a = 0; a < leftPlacement.frames.length; a += 1) {
        for (let b = 0; b < rightPlacement.frames.length; b += 1) {
          // Same-member pairs assess each unordered face pair once; a face
          // never mates with itself.
          if (left === right && b <= a) continue;
          const steps = placeableSteps(leftPlacement, a, rightPlacement, b, tolerances);
          if (steps !== null)
            matingPairs.push({
              leftMember: left,
              leftSocket: a,
              rightMember: right,
              rightSocket: b,
              rotationStepsY90: steps,
            });
        }
      }
    }
  }
  const firstFailure = firstFailureReasons(members, placements, tolerances);
  const faceCount = members.reduce((total, member) => total + member.sockets.length, 0);
  if (matingPairs.length > 0) {
    // A kit piece that combines with nothing is decor, not kit: every
    // member must take part in at least one mating pair.
    const mated = new Set<number>();
    for (const pair of matingPairs) {
      mated.add(pair.leftMember);
      mated.add(pair.rightMember);
    }
    const unmated = members
      .map((member, index) => ({ member, index }))
      .filter(({ index }) => !mated.has(index))
      .map(({ member }) => `${member.variantName} (${member.assetId})`);
    if (unmated.length === 0)
      return {
        status: "modular",
        reason: `${members.length} members expose ${faceCount} joint faces with ${matingPairs.length} mating pairs`,
        matingPairs,
      };
    const named = unmated.slice(0, 3).join(", ");
    const remainder = unmated.length > 3 ? ` and ${unmated.length - 3} more` : "";
    return {
      status: "quarantined",
      reason:
        `${faceCount} joint faces measured with ${matingPairs.length} mating pairs, ` +
        `but ${unmated.length} of ${members.length} members combine with nothing: ${named}${remainder}`,
      matingPairs: [],
    };
  }
  const detail = firstFailure.length === 0 ? "no candidate pair" : firstFailure.join("; ");
  return {
    status: "quarantined",
    reason: `${faceCount} joint faces measured, no mating pair across ${members.length} members: ${detail}`,
    matingPairs,
  };
}
