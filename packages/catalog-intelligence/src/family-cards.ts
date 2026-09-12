import {
  dequantizeQ32_32,
  familyCardSchema,
  parseFamilyHandle,
  ROLE_CLEARANCE_DEFAULTS,
  ROLE_DENSITY_DEFAULTS,
  STUD_METERS,
  STYLIZED_MASS_DENSITY_KG_PER_M3,
  type AABBFixed,
  type AssetFamilyRevision,
  type FamilyCard,
} from "../../basalt-types/src/index.js";

export interface FamilyCardEvidence {
  readonly surfaceTypes?: readonly string[];
  readonly memberBounds?: Readonly<Record<string, AABBFixed>>;
}

type Dimensions = [number, number, number];

function dimensionsOf(envelope: AABBFixed): Dimensions {
  const min = [
    dequantizeQ32_32(envelope.min.x),
    dequantizeQ32_32(envelope.min.y),
    dequantizeQ32_32(envelope.min.z),
  ];
  const max = [
    dequantizeQ32_32(envelope.max.x),
    dequantizeQ32_32(envelope.max.y),
    dequantizeQ32_32(envelope.max.z),
  ];
  return max.map((value, index) => Math.max(0, value - min[index]!)) as Dimensions;
}

function boundingVolumeMassKg(dimensions: Dimensions): number {
  const volumeM3 = dimensions[0] * dimensions[1] * dimensions[2] * STUD_METERS ** 3;
  return volumeM3 * STYLIZED_MASS_DENSITY_KG_PER_M3;
}

export function buildFamilyCard(
  revision: AssetFamilyRevision,
  evidence: FamilyCardEvidence = {},
): FamilyCard {
  const parsed = parseFamilyHandle(revision.familyHandle);
  const composite = dimensionsOf(revision.compositeBoundingEnvelope);
  const archetypes = revision.archetypes.map((archetype) => {
    const bounds = evidence.memberBounds?.[archetype.assetId]
      ? dimensionsOf(evidence.memberBounds[archetype.assetId]!)
      : composite;
    return {
      token: archetype.variantName,
      bounds,
      mass: boundingVolumeMassKg(bounds),
    };
  });
  const socketGroups = [
    ...new Set(
      revision.archetypes.flatMap((archetype) =>
        archetype.registeredSockets.map((socket) => socket.role),
      ),
    ),
  ].sort();
  return familyCardSchema.parse({
    handle: revision.familyHandle,
    fid: revision.familyId,
    roles: [parsed.spatialRole],
    archetypes,
    affinities: {
      surfaces: [...(evidence.surfaceTypes ?? [])].sort(),
      // No slope evidence exists yet; 90 leaves placement unconstrained.
      max_slope_deg: 90,
      clearance_rad: ROLE_CLEARANCE_DEFAULTS[parsed.spatialRole],
    },
    density: ROLE_DENSITY_DEFAULTS[parsed.spatialRole],
    sockets: socketGroups.length
      ? { grid_step: composite, elevation_step_dh: 0, compatible_groups: socketGroups }
      : null,
  });
}
