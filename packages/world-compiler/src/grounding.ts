import { z } from "zod";
import { contentHash, stableJson } from "../../contracts/src/index.js";
import { createMurmurHash3Random } from "../../spatial-core/src/primitives.js";
import { worldEntityId, worldHash } from "./primitives.js";
import { alignToNormalCapped } from "./relations.js";

/**
 * Deterministic instance grounding. Population samples where an instance goes;
 * this solver decides how it rests: footprint-supersampled rest height at the
 * sampled XZ verbatim, and per-kind orientation (upright trunks,
 * normal-aligned cover). Evidence bounds are rebased (bottom_center_obb), so
 * no pivot compensation happens here; the connector applies T(-pivot) once.
 *
 * Evidence classes derive from measured spans only, never from names or tags:
 * flat cover aligns to the terrain normal under a tilt cap, tall growth stays
 * upright with buried roots, compact props rest upright on the surface.
 */

const finite = z.number().finite();
const groundingVector3 = z.object({ x: finite, y: finite, z: finite }).strict();

const groundingArchetypeSchema = z
  .object({
    assetId: worldEntityId,
    boundsMinimumStuds: groundingVector3,
    boundsMaximumStuds: groundingVector3,
    contactRadiusStuds: finite.positive(),
  })
  .strict();
export type GroundingArchetypeEvidence = z.infer<typeof groundingArchetypeSchema>;

const familyGroundingEvidenceSchema = z
  .object({
    familyId: worldEntityId,
    archetypes: z.array(groundingArchetypeSchema).min(1).max(4096),
  })
  .strict();
export type FamilyGroundingEvidence = z.infer<typeof familyGroundingEvidenceSchema>;

export const GROUNDING_EVIDENCE_FILE_SCHEMA = z
  .object({
    kind: z.literal("BasaltFamilyGroundingEvidence"),
    abi: z.literal("basalt-family-grounding-evidence@1"),
    inventoryHash: worldHash,
    evidence: z.array(familyGroundingEvidenceSchema).max(4096),
  })
  .strict();
export type GroundingEvidenceFile = z.infer<typeof GROUNDING_EVIDENCE_FILE_SCHEMA>;

export type GroundingEvidenceIndex = ReadonlyMap<string, readonly GroundingArchetypeEvidence[]>;

export function indexGroundingEvidence(file: GroundingEvidenceFile): GroundingEvidenceIndex {
  const parsed = GROUNDING_EVIDENCE_FILE_SCHEMA.parse(file);
  const index = new Map<string, readonly GroundingArchetypeEvidence[]>();
  for (const family of parsed.evidence) {
    if (index.has(family.familyId))
      throw new Error(`Duplicate grounding evidence for family: ${family.familyId}`);
    index.set(family.familyId, family.archetypes);
  }
  return index;
}

export type GroundingKind = "flat" | "compact" | "tall";

const FLAT_RATIO = 0.2;
const TALL_RATIO = 1.5;

/** Classify by measured span ratios. Thresholds are inclusive on both sides. */
export function groundingKindFromSpan(span: { x: number; y: number; z: number }): GroundingKind {
  const horizontal = Math.max(span.x, span.z);
  if (!(horizontal > 0) || !(span.y >= 0)) throw new Error("Grounding span is degenerate");
  if (span.y < FLAT_RATIO * horizontal) return "flat";
  if (span.y > TALL_RATIO * horizontal) return "tall";
  return "compact";
}

export interface GroundingPolicy {
  readonly align: "upright" | "normal";
  readonly maximumTiltDegrees: number;
  /** Rest height above the highest footprint sample, in studs. */
  readonly liftStuds: number;
  /** Deliberate burial below the rest height, in studs. */
  readonly embedStuds: number;
  /** Steepest surface accepted for placement, in degrees. */
  readonly maximumSlopeDegrees: number;
}

const GROUNDING_POLICIES: Record<GroundingKind, GroundingPolicy> = {
  // Thin cover floats on any engine deviation without a positive margin; the
  // 0.05-stud budget matches the road clearance precedent.
  flat: {
    align: "normal",
    maximumTiltDegrees: 25,
    liftStuds: 0.05,
    embedStuds: 0,
    maximumSlopeDegrees: 30,
  },
  compact: {
    align: "upright",
    maximumTiltDegrees: 0,
    liftStuds: 0.04,
    embedStuds: 0,
    maximumSlopeDegrees: 45,
  },
  // Trunks stand through the surface: roots bury, crowns never hover.
  tall: {
    align: "upright",
    maximumTiltDegrees: 0,
    liftStuds: 0,
    embedStuds: 0.2,
    maximumSlopeDegrees: 40,
  },
};

export function groundingPolicyFor(kind: GroundingKind): GroundingPolicy {
  return GROUNDING_POLICIES[kind];
}

/** Minimal surface access; PlacementSurfaceIndex satisfies this structurally. */
export interface GroundingSurfaceSampler {
  sample(
    surfaceId: string,
    coordinate: { u: number; v: number },
  ): { position: { x: number; y: number; z: number }; normal: { x: number; y: number; z: number } };
  coordinateBounds(surfaceId: string): {
    u: { minimum: number; maximum: number };
    v: { minimum: number; maximum: number };
  };
}

export interface SurfaceCalibration {
  readonly worldPerU: number;
  readonly worldPerV: number;
}

/**
 * Calibrate UV step per world stud from surface corners so footprint rings
 * land in world units regardless of surface parametrization.
 */
export function calibrateGroundingSurface(
  sampler: GroundingSurfaceSampler,
  surfaceId: string,
): SurfaceCalibration {
  const bounds = sampler.coordinateBounds(surfaceId);
  const corner = (u: number, v: number) => sampler.sample(surfaceId, { u, v }).position;
  const origin = corner(bounds.u.minimum, bounds.v.minimum);
  const alongU = corner(bounds.u.maximum, bounds.v.minimum);
  const alongV = corner(bounds.u.minimum, bounds.v.maximum);
  const spanU = Math.max(bounds.u.maximum - bounds.u.minimum, 1e-9);
  const spanV = Math.max(bounds.v.maximum - bounds.v.minimum, 1e-9);
  return {
    worldPerU: Math.max(Math.hypot(alongU.x - origin.x, alongU.z - origin.z) / spanU, 1e-9),
    worldPerV: Math.max(Math.hypot(alongV.x - origin.x, alongV.z - origin.z) / spanV, 1e-9),
  };
}

const FOOTPRINT_SAMPLES = 4;

export interface GroundPlacementInput {
  readonly surfaceId: string;
  readonly coordinate: { u: number; v: number };
  readonly yaw: number;
  readonly scale: number;
  /** Stable seed material (the instance id) for footprint jitter. */
  readonly seed: string;
  readonly evidence: GroundingArchetypeEvidence;
  readonly sampler: GroundingSurfaceSampler;
  readonly calibration: SurfaceCalibration;
}

export interface GroundedPlacement {
  readonly position: { x: number; y: number; z: number };
  readonly rotation: [number, number, number, number];
  readonly kind: GroundingKind;
  /** Footprint drops: ring heights minus rest height, always ≤ 0. */
  readonly footprint: {
    readonly contactRadiusStuds: number;
    readonly restYStuds: number;
    readonly dropsStuds: readonly [number, number, number, number];
  };
}

export function groundPlacement(input: GroundPlacementInput): GroundedPlacement {
  if (!Number.isFinite(input.scale) || input.scale <= 0)
    throw new Error("Grounding scale must be positive");
  const evidence = groundingArchetypeSchema.parse(input.evidence);
  const span = {
    x: evidence.boundsMaximumStuds.x - evidence.boundsMinimumStuds.x,
    y: evidence.boundsMaximumStuds.y - evidence.boundsMinimumStuds.y,
    z: evidence.boundsMaximumStuds.z - evidence.boundsMinimumStuds.z,
  };
  const kind = groundingKindFromSpan(span);
  const policy = groundingPolicyFor(kind);
  const center = input.sampler.sample(input.surfaceId, input.coordinate);

  const footprintRadius = evidence.contactRadiusStuds * input.scale;
  const ringAngle =
    createMurmurHash3Random(
      Number.parseInt(contentHash(stableJson([input.seed, "footprint"])).slice(0, 8), 16) >>> 0,
    )() *
    Math.PI *
    2;
  const bounds = input.sampler.coordinateBounds(input.surfaceId);
  const clamp = (value: number, minimum: number, maximum: number) =>
    Math.min(maximum, Math.max(minimum, value));
  const heights = [center.position.y];
  for (let index = 0; index < FOOTPRINT_SAMPLES; index += 1) {
    const angle = ringAngle + (index * Math.PI * 2) / FOOTPRINT_SAMPLES;
    const ring = input.sampler.sample(input.surfaceId, {
      u: clamp(
        input.coordinate.u + (Math.cos(angle) * footprintRadius) / input.calibration.worldPerU,
        bounds.u.minimum,
        bounds.u.maximum,
      ),
      v: clamp(
        input.coordinate.v + (Math.sin(angle) * footprintRadius) / input.calibration.worldPerV,
        bounds.v.minimum,
        bounds.v.maximum,
      ),
    });
    heights.push(ring.position.y);
  }
  const restY = Math.max(...heights);
  const supportSpan = restY - Math.min(...heights);
  if (supportSpan > footprintRadius + 0.5)
    throw new Error(
      `Footprint spans ${supportSpan.toFixed(3)} studs of relief for radius ${footprintRadius.toFixed(3)}; refusing unsupported placement`,
    );

  const aligned =
    policy.align === "upright"
      ? ([0, Math.sin(input.yaw / 2), 0, Math.cos(input.yaw / 2)] as [
          number,
          number,
          number,
          number,
        ])
      : alignToNormalCapped(center.normal, input.yaw, policy.maximumTiltDegrees);
  const rotation: [number, number, number, number] = [
    aligned[0],
    aligned[1],
    aligned[2],
    aligned[3],
  ];
  if (rotationTiltDegrees(rotation) > policy.maximumTiltDegrees + 1e-6)
    throw new Error("Grounded tilt exceeds alignment tolerance");

  // Evidence bounds arrive rebased (bottom_center_obb): the contact patch is
  // already at the bounds-frame origin, so the sampled point is the position
  // verbatim. Never re-anchor by the absolute pivot here; that mixes frames
  // and shifts pivoted assets by the artist's GLB offset.
  return {
    position: {
      x: center.position.x,
      y: restY + policy.liftStuds - policy.embedStuds,
      z: center.position.z,
    },
    rotation,
    kind,
    footprint: {
      contactRadiusStuds: evidence.contactRadiusStuds,
      restYStuds: restY,
      dropsStuds: [
        heights[1]! - restY,
        heights[2]! - restY,
        heights[3]! - restY,
        heights[4]! - restY,
      ],
    },
  };
}

function rotationTiltDegrees(rotation: readonly [number, number, number, number]): number {
  const qx = rotation[0];
  const qz = rotation[2];
  // Rotated up vector: second row of the quaternion rotation matrix.
  const upY = 1 - 2 * (qx * qx + qz * qz);
  return (Math.acos(Math.max(-1, Math.min(1, upY))) * 180) / Math.PI;
}
