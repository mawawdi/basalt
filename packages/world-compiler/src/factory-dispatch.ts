import { contentHash } from "../../contracts/src/index.js";
import {
  familyRequirementSchema,
  type FamilyRequirement,
  type SpatialRole,
} from "../../basalt-types/src/index.js";
import { MAX_NEURAL_ASSET_BOUND_STUDS } from "../../asset-factory/src/contracts.js";
import {
  sealNeuralFamilyFactoryJob,
  type NeuralFamilyFactoryJob,
} from "../../neural-asset/src/factory.js";
import type { NeuralProviderId } from "../../neural-asset/src/execution.js";

export interface FactoryMissBrief {
  readonly regionId: string;
  readonly role: SpatialRole;
  readonly suggestedHandle: string;
  readonly boundingEnvelopeStuds: readonly [number, number, number];
  readonly targetTexelDensity: number;
  readonly minArchetypeCount: number;
  readonly surfaceAffinity: string;
  readonly provider: NeuralProviderId;
  readonly referenceHash: string;
  readonly seed: number;
}

export interface BriefedFactoryMiss {
  readonly requirement: FamilyRequirement;
  readonly jobs: readonly NeuralFamilyFactoryJob[];
}

/**
 * Briefs the offline family factory for one registry miss. The explore
 * requirement is always recorded; neural jobs queue only for focal inserts
 * within the 8-stud bound (the queue's hard contract). Anything larger fails
 * closed naming the procedural route. Queued jobs carry no instance data.
 */
export function briefMissedFamilyFactoryJobs(input: {
  readonly miss: FactoryMissBrief;
  readonly worldPlanHash: string;
  readonly styleContractHash: string;
}): BriefedFactoryMiss {
  const { miss } = input;
  if (Math.max(...miss.boundingEnvelopeStuds) > MAX_NEURAL_ASSET_BOUND_STUDS)
    throw new Error(
      `Registry miss for ${miss.regionId}/${miss.role} exceeds the ${MAX_NEURAL_ASSET_BOUND_STUDS}-stud neural bound; brief a procedural AssemblyRecipe cohort instead`,
    );
  const [boundX, boundY, boundZ] = miss.boundingEnvelopeStuds;
  const requirement = familyRequirementSchema.parse({
    requirement_id: `explore_${miss.regionId}_${miss.role}`,
    suggested_handle: miss.suggestedHandle,
    spatial_role: miss.role,
    bounding_envelope_studs: [boundX, boundY, boundZ],
    target_texel_density: miss.targetTexelDensity,
    min_archetype_count: miss.minArchetypeCount,
    surface_affinity: miss.surfaceAffinity,
  });
  if (miss.role !== "focal_insert") return { requirement, jobs: [] };
  if (miss.boundingEnvelopeStuds.some((bound) => !(bound > 0)))
    throw new Error(
      `Registry miss for ${miss.regionId}/${miss.role} needs positive expected bounds to queue neural jobs`,
    );
  const jobs = Array.from({ length: miss.minArchetypeCount }, (_, archetypeOrdinal) =>
    sealNeuralFamilyFactoryJob({
      kind: "NeuralFamilyFactoryJob",
      abi: "basalt-neural-family-factory-job@1",
      requirementId: requirement.requirement_id,
      familyId: `pending_${contentHash(miss.suggestedHandle).slice(0, 12)}`,
      provider: miss.provider,
      referenceHash: miss.referenceHash,
      styleContractHash: input.styleContractHash,
      acquisitionContext: "focal_insert",
      expectedBoundsStuds: { x: boundX, y: boundY, z: boundZ },
      seed: miss.seed + archetypeOrdinal,
      archetypeOrdinal,
      status: "queued",
    }),
  );
  return { requirement, jobs };
}
