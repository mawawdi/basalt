import { z } from "zod";
import { ASCII_ID_SCHEMA, HASH_SCHEMA } from "@basalt/contracts";
import { CATALOG_ENTRY_KIND_SCHEMA } from "@basalt/catalog-model";
import { CATALOG_DEFECT_DOMAIN_SCHEMA, CATALOG_REVIEW_SUBJECT_KIND_SCHEMA } from "./rubric.js";
import {
  canonicalValues,
  requireCanonicalValues,
  sealArtifact,
  verifyArtifactHash,
} from "./artifact.js";
import { CATALOG_FEATURE_CHANNEL_SCHEMA } from "./features.js";
import { CATALOG_PREDICTION_FACET_SCHEMA } from "./facets.js";

const RISK_TARGET_SCHEMA = z
  .object({
    riskId: ASCII_ID_SCHEMA,
    stratumId: ASCII_ID_SCHEMA,
    defectDomain: CATALOG_DEFECT_DOMAIN_SCHEMA,
    subjectKind: CATALOG_REVIEW_SUBJECT_KIND_SCHEMA,
    maximumDefectRateMillionths: z.number().int().positive().max(1_000_000),
    confidenceMillionths: z.number().int().positive().max(999_999),
    acceptanceNumber: z.number().int().nonnegative().max(100),
  })
  .strict();

export const CATALOG_ADMISSION_POLICY_SCHEMA = z
  .object({
    kind: z.literal("CatalogAdmissionPolicy"),
    policyId: ASCII_ID_SCHEMA,
    pilot: z
      .object({
        groupsPerRole: z.number().int().positive().max(10_000),
        selectionSeedHash: HASH_SCHEMA,
        requireStatic: z.literal(true),
        requireSinglePart: z.literal(true),
        requireSingleMaterial: z.literal(true),
        requireBottomContact: z.literal(true),
      })
      .strict(),
    prediction: z
      .object({
        requiredAssertionKinds: z.array(CATALOG_PREDICTION_FACET_SCHEMA).min(1).max(5),
        minimumDependencyGroups: z.number().int().positive().max(16),
        minimumCalibrationSamples: z.number().int().positive().max(100_000),
        calibrationConfidenceMillionths: z.number().int().positive().max(999_999),
        minimumPrecisionLowerBoundMillionths: z.number().int().positive().max(1_000_000),
        maximumPredictionSetSize: z.number().int().positive().max(64),
        noveltyThresholdMillionths: z.number().int().positive().max(1_000_000),
      })
      .strict(),
    substitution: z
      .object({
        requiredFeatureChannels: z.array(CATALOG_FEATURE_CHANNEL_SCHEMA).min(1).max(3),
        minimumSimilarityMillionthsByChannel: z.record(
          CATALOG_FEATURE_CHANNEL_SCHEMA,
          z.number().int().min(-1_000_000).max(1_000_000),
        ),
        maximumAxisRatioMillionths: z.number().int().min(1_000_000).max(100_000_000),
      })
      .strict(),
    riskTargets: z.array(RISK_TARGET_SCHEMA).min(1).max(128),
    automaticallyAdmissibleEntryKinds: z.array(CATALOG_ENTRY_KIND_SCHEMA).max(6),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyArtifactHash(value, context);
    requireCanonicalValues(
      value.prediction.requiredAssertionKinds,
      String,
      "required assertion kinds",
      context,
    );
    requireCanonicalValues(
      value.substitution.requiredFeatureChannels,
      String,
      "required feature channels",
      context,
    );
    requireCanonicalValues(value.riskTargets, (entry) => entry.riskId, "risk targets", context);
    requireCanonicalValues(
      value.automaticallyAdmissibleEntryKinds,
      String,
      "automatically admissible entry kinds",
      context,
    );
    for (const channel of value.substitution.requiredFeatureChannels)
      if (value.substitution.minimumSimilarityMillionthsByChannel[channel] === undefined)
        context.addIssue({
          code: "custom",
          path: ["substitution", "minimumSimilarityMillionthsByChannel", channel],
          message: `Missing similarity threshold for ${channel}`,
        });
  });
export type CatalogAdmissionPolicy = z.output<typeof CATALOG_ADMISSION_POLICY_SCHEMA>;

export function sealCatalogAdmissionPolicy(
  input: Omit<CatalogAdmissionPolicy, "kind" | "hash">,
): CatalogAdmissionPolicy {
  return sealArtifact(CATALOG_ADMISSION_POLICY_SCHEMA, {
    kind: "CatalogAdmissionPolicy" as const,
    ...input,
    prediction: {
      ...input.prediction,
      requiredAssertionKinds: canonicalValues(
        input.prediction.requiredAssertionKinds,
        String,
        "required assertion kinds",
      ),
    },
    substitution: {
      ...input.substitution,
      requiredFeatureChannels: canonicalValues(
        input.substitution.requiredFeatureChannels,
        String,
        "required feature channels",
      ),
    },
    riskTargets: canonicalValues(input.riskTargets, (entry) => entry.riskId, "risk targets"),
    automaticallyAdmissibleEntryKinds: canonicalValues(
      input.automaticallyAdmissibleEntryKinds,
      String,
      "automatically admissible entry kinds",
    ),
  });
}
