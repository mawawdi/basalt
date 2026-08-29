import { z } from "zod";
import { contentHash, stableJson } from "../../contracts/src/index.js";
import { entityId, hashSchema } from "../../spatial-core/src/primitives.js";
import { REFERENCE_IMAGE_BINARY_ARTIFACT_SCHEMA } from "./references.js";
import {
  FLUX2_KLEIN_4B_PRODUCER,
  LONGCAT_IMAGE_EDIT_PRODUCER,
  QWEN_IMAGE_EDIT_2511_PRODUCER,
} from "./producers.js";

export const REGION_COMPOSITION_PORTFOLIO_ABI = "basalt-region-composition-portfolio@3" as const;
export const REGION_COMPOSITION_SELECTION_ABI = "basalt-region-composition-selection@3" as const;

export const REGION_COMPOSITION_PRODUCER_IDS = [
  FLUX2_KLEIN_4B_PRODUCER.id,
  LONGCAT_IMAGE_EDIT_PRODUCER.id,
  QWEN_IMAGE_EDIT_2511_PRODUCER.id,
] as const;

const score = z.number().finite().min(0).max(5);
const pngArtifact = REFERENCE_IMAGE_BINARY_ARTIFACT_SCHEMA.safeExtend({
  mediaType: z.literal("image/png"),
});

export const REGION_COMPOSITION_SCORE_SCHEMA = z
  .object({
    cameraPreservation: score,
    protectedPixelPreservation: score,
    surfacePreservation: score,
    routePreservation: score,
    requirementCoverage: score,
    instanceSeparability: score,
    visualCoherence: score,
    creativeValue: score,
  })
  .strict();
export type RegionCompositionScore = z.infer<typeof REGION_COMPOSITION_SCORE_SCHEMA>;

const candidateBase = z.object({
  producerId: z.enum(REGION_COMPOSITION_PRODUCER_IDS),
  producerQualificationHash: hashSchema,
  workerRequestHash: hashSchema,
  workerReceiptHash: hashSchema.nullable(),
  compositionIndex: z.number().int().min(0).max(2),
  seed: z.number().int().min(0).max(2_147_483_647),
  contextRenderHash: hashSchema,
  cameraCalibrationHash: hashSchema,
  protectedPixelMaskHash: hashSchema,
  regionalPlanHash: hashSchema,
  styleContractHash: hashSchema,
  promptHash: hashSchema,
  requirementHashes: z.array(hashSchema).min(1).max(256),
  elapsedMs: z.number().int().nonnegative(),
  gpuSeconds: z.number().finite().nonnegative(),
  estimatedCostUsd: z.number().finite().nonnegative(),
});

const eligibleCandidate = candidateBase
  .extend({
    status: z.literal("eligible"),
    output: pngArtifact,
    score: REGION_COMPOSITION_SCORE_SCHEMA,
    scoreEvidenceHash: hashSchema,
    blockingDefects: z.array(z.string().trim().min(1).max(160)).length(0),
  })
  .strict();

const failedCandidate = candidateBase
  .extend({
    status: z.enum(["incomplete", "rejected"]),
    output: z.null(),
    score: z.null(),
    scoreEvidenceHash: hashSchema.nullable(),
    blockingDefects: z.array(z.string().trim().min(1).max(160)).min(1).max(64),
  })
  .strict();

export const REGION_COMPOSITION_CANDIDATE_SCHEMA = z.discriminatedUnion("status", [
  eligibleCandidate,
  failedCandidate,
]);
export type RegionCompositionCandidate = z.infer<typeof REGION_COMPOSITION_CANDIDATE_SCHEMA>;

const portfolioMaterial = z
  .object({
    kind: z.literal("RegionCompositionPortfolio"),
    abi: z.literal(REGION_COMPOSITION_PORTFOLIO_ABI),
    regionId: entityId,
    viewCellId: entityId,
    contextRenderHash: hashSchema,
    cameraCalibrationHash: hashSchema,
    protectedPixelMaskHash: hashSchema,
    regionalPlanHash: hashSchema,
    styleContractHash: hashSchema,
    promptHash: hashSchema,
    requirementHashes: z.array(hashSchema).min(1).max(256),
    proposalBudget: z.literal(3),
    allocationPolicy: z.enum(["one_per_active_provider", "measured_two_plus_one"]),
    seedSchedule: z.tuple([
      z.number().int().min(0).max(2_147_483_647),
      z.number().int().min(0).max(2_147_483_647),
      z.number().int().min(0).max(2_147_483_647),
    ]),
    candidates: z.array(REGION_COMPOSITION_CANDIDATE_SCHEMA).length(3),
  })
  .strict()
  .superRefine((value, context) => {
    const requirements = [...value.requirementHashes].sort();
    if (
      new Set(requirements).size !== requirements.length ||
      stableJson(requirements) !== stableJson(value.requirementHashes)
    )
      context.addIssue({
        code: "custom",
        path: ["requirementHashes"],
        message: "Composition requirements must be unique and canonical",
      });

    const keys = value.candidates.map(candidateKey);
    if (new Set(keys).size !== keys.length || stableJson(keys) !== stableJson([...keys].sort()))
      context.addIssue({
        code: "custom",
        path: ["candidates"],
        message: "Composition candidates must be unique and canonical",
      });

    for (const candidate of value.candidates) {
      if (
        candidate.contextRenderHash !== value.contextRenderHash ||
        candidate.cameraCalibrationHash !== value.cameraCalibrationHash ||
        candidate.protectedPixelMaskHash !== value.protectedPixelMaskHash ||
        candidate.regionalPlanHash !== value.regionalPlanHash ||
        candidate.styleContractHash !== value.styleContractHash ||
        candidate.promptHash !== value.promptHash ||
        stableJson(candidate.requirementHashes) !== stableJson(value.requirementHashes)
      )
        context.addIssue({
          code: "custom",
          path: ["candidates"],
          message: "Every composition candidate must use the frozen matched input",
        });
      if (candidate.seed !== value.seedSchedule[candidate.compositionIndex])
        context.addIssue({
          code: "custom",
          path: ["candidates"],
          message: "Every composition candidate must use its retained proposal-slot seed",
        });
    }
    const proposalSlots = value.candidates.map(({ compositionIndex }) => compositionIndex).sort();
    if (stableJson(proposalSlots) !== stableJson([0, 1, 2]))
      context.addIssue({
        code: "custom",
        path: ["candidates"],
        message: "A production portfolio must fill each of its three proposal slots exactly once",
      });
    const participatingProducers = new Set(value.candidates.map(({ producerId }) => producerId));
    const expectedProducerCount =
      value.allocationPolicy === "one_per_active_provider"
        ? REGION_COMPOSITION_PRODUCER_IDS.length
        : 2;
    if (participatingProducers.size !== expectedProducerCount)
      context.addIssue({
        code: "custom",
        path: ["candidates"],
        message:
          value.allocationPolicy === "one_per_active_provider"
            ? "Initial composition allocation must spend one proposal on every active provider"
            : "Measured composition allocation must spend its three proposals across two providers",
      });
  });

export const REGION_COMPOSITION_PORTFOLIO_SCHEMA = portfolioMaterial.safeExtend({
  hash: hashSchema,
});
export type RegionCompositionPortfolio = z.infer<typeof REGION_COMPOSITION_PORTFOLIO_SCHEMA>;

export function sealRegionCompositionPortfolio(
  input: z.input<typeof portfolioMaterial>,
): RegionCompositionPortfolio {
  const material = portfolioMaterial.parse(input);
  return REGION_COMPOSITION_PORTFOLIO_SCHEMA.parse({
    ...material,
    hash: contentHash(stableJson(material)),
  });
}

export function assertRegionCompositionPortfolioIdentity(
  value: unknown,
): asserts value is RegionCompositionPortfolio {
  const portfolio = REGION_COMPOSITION_PORTFOLIO_SCHEMA.parse(value);
  const { hash, ...material } = portfolio;
  if (contentHash(stableJson(material)) !== hash)
    throw new Error("Region-composition portfolio identity is invalid");
}

const selectionMaterial = z.discriminatedUnion("status", [
  z
    .object({
      kind: z.literal("RegionCompositionSelection"),
      abi: z.literal(REGION_COMPOSITION_SELECTION_ABI),
      status: z.literal("eligible"),
      portfolioHash: hashSchema,
      selectedCandidateKey: z.string().trim().min(1).max(160),
      rankedCandidateKeys: z.array(z.string().trim().min(1).max(160)).min(1).max(3),
      selectedScore: score,
      excludedCandidateKeys: z.array(z.string().trim().min(1).max(160)).max(3),
    })
    .strict(),
  z
    .object({
      kind: z.literal("RegionCompositionSelection"),
      abi: z.literal(REGION_COMPOSITION_SELECTION_ABI),
      status: z.literal("incomplete"),
      portfolioHash: hashSchema,
      selectedCandidateKey: z.null(),
      rankedCandidateKeys: z.array(z.string().trim().min(1).max(160)).length(0),
      selectedScore: z.null(),
      excludedCandidateKeys: z.array(z.string().trim().min(1).max(160)).length(3),
    })
    .strict(),
]);

export const REGION_COMPOSITION_SELECTION_SCHEMA = z.intersection(
  selectionMaterial,
  z.object({ hash: hashSchema }),
);
export type RegionCompositionSelection = z.infer<typeof REGION_COMPOSITION_SELECTION_SCHEMA>;

export function selectRegionComposition(
  value: RegionCompositionPortfolio,
): RegionCompositionSelection {
  assertRegionCompositionPortfolioIdentity(value);
  const eligible = value.candidates
    .filter(
      (candidate): candidate is z.infer<typeof eligibleCandidate> =>
        candidate.status === "eligible",
    )
    .filter((candidate) => passesPhysicalImageGate(candidate.score))
    .map((candidate) => ({ candidate, total: weightedScore(candidate.score) }))
    .sort((left, right) => {
      const scoreDelta = right.total - left.total;
      if (Math.abs(scoreDelta) > 1e-9) return scoreDelta;
      const costDelta = left.candidate.estimatedCostUsd - right.candidate.estimatedCostUsd;
      if (Math.abs(costDelta) > 1e-9) return costDelta;
      const latencyDelta = left.candidate.elapsedMs - right.candidate.elapsedMs;
      return latencyDelta !== 0
        ? latencyDelta
        : candidateKey(left.candidate).localeCompare(candidateKey(right.candidate));
    });
  const acceptedKeys = new Set(eligible.map(({ candidate }) => candidateKey(candidate)));
  const excludedCandidateKeys = value.candidates
    .map(candidateKey)
    .filter((key) => !acceptedKeys.has(key))
    .sort();
  const material = eligible[0]
    ? {
        kind: "RegionCompositionSelection" as const,
        abi: REGION_COMPOSITION_SELECTION_ABI,
        status: "eligible" as const,
        portfolioHash: value.hash,
        selectedCandidateKey: candidateKey(eligible[0].candidate),
        rankedCandidateKeys: eligible.map(({ candidate }) => candidateKey(candidate)),
        selectedScore: eligible[0].total,
        excludedCandidateKeys,
      }
    : {
        kind: "RegionCompositionSelection" as const,
        abi: REGION_COMPOSITION_SELECTION_ABI,
        status: "incomplete" as const,
        portfolioHash: value.hash,
        selectedCandidateKey: null,
        rankedCandidateKeys: [] as string[],
        selectedScore: null,
        excludedCandidateKeys: value.candidates.map(candidateKey).sort(),
      };
  return REGION_COMPOSITION_SELECTION_SCHEMA.parse({
    ...material,
    hash: contentHash(stableJson(material)),
  });
}

function candidateKey(candidate: RegionCompositionCandidate): string {
  return `${candidate.producerId}:${candidate.compositionIndex}`;
}

function passesPhysicalImageGate(value: RegionCompositionScore): boolean {
  return (
    value.cameraPreservation >= 4 &&
    value.protectedPixelPreservation >= 4 &&
    value.surfacePreservation >= 4 &&
    value.routePreservation >= 4 &&
    value.requirementCoverage >= 3.5 &&
    value.instanceSeparability >= 3.5
  );
}

function weightedScore(value: RegionCompositionScore): number {
  return Number(
    (
      value.cameraPreservation * 0.1 +
      value.protectedPixelPreservation * 0.1 +
      value.surfacePreservation * 0.07 +
      value.routePreservation * 0.07 +
      value.requirementCoverage * 0.17 +
      value.instanceSeparability * 0.14 +
      value.visualCoherence * 0.17 +
      value.creativeValue * 0.18
    ).toFixed(9),
  );
}
