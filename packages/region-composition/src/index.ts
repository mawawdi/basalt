import { z } from "zod";
import {
  HASH_SCHEMA,
  compareCanonicalStrings,
  contentHash,
  deepFreezeJson,
  stableJson,
} from "@basalt/contracts";
import {
  WORLD_ENTITY_ID_SCHEMA,
  WORLD_POINT2_SCHEMA,
  type SpatialWorldPlan,
} from "@basalt/world-planning";

const placementCandidate = z
  .object({
    candidateId: WORLD_ENTITY_ID_SCHEMA,
    regionId: WORLD_ENTITY_ID_SCHEMA,
    surfaceId: WORLD_ENTITY_ID_SCHEMA,
    pointMeters: WORLD_POINT2_SCHEMA,
    score: z.number().finite(),
    evidenceHashes: z.array(HASH_SCHEMA),
  })
  .strict();
export const REGION_COMPOSITION_SCHEMA = z
  .object({
    kind: z.literal("RegionComposition"),
    planHash: HASH_SCHEMA,
    regionId: WORLD_ENTITY_ID_SCHEMA,
    candidates: z.array(placementCandidate),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    const material = { ...value };
    delete (material as Partial<typeof value>).hash;
    if (contentHash(stableJson(material)) !== value.hash)
      context.addIssue({ code: "custom", path: ["hash"], message: "Composition hash mismatch" });
  });
export type RegionComposition = z.output<typeof REGION_COMPOSITION_SCHEMA>;

/**
 * Builds deterministic, engine-neutral candidate sites. This package does not
 * select assets or claim that a candidate can be occupied.
 */
export function composeRegion(plan: SpatialWorldPlan, regionId: string): RegionComposition {
  const surfaces = plan.placementSurfaces
    .filter((entry) => entry.regionId === regionId)
    .sort((left, right) => compareCanonicalStrings(left.surfaceId, right.surfaceId));
  const candidates = surfaces.map((surface, index) => ({
    candidateId: `Candidate_${index + 1}`,
    regionId,
    surfaceId: surface.surfaceId,
    pointMeters: {
      x: (surface.bounds.min.x + surface.bounds.max.x) / 2,
      z: (surface.bounds.min.z + surface.bounds.max.z) / 2,
    },
    score: 1,
    evidenceHashes: [surface.sourceHash],
  }));
  const material = {
    kind: "RegionComposition" as const,
    planHash: plan.planHash,
    regionId,
    candidates,
  };
  return deepFreezeJson(
    REGION_COMPOSITION_SCHEMA.parse({ ...material, hash: contentHash(stableJson(material)) }),
  );
}
