import { z } from "zod";
import { ASCII_ID_SCHEMA, HASH_SCHEMA, stableJson } from "@basalt/contracts";
import {
  CATALOG_EVIDENCE_CHANNELS,
  CATALOG_EVIDENCE_CHANNEL_SCHEMA,
  type CatalogEvidenceChannelName,
} from "./evidence.js";
import {
  canonicalValues,
  requireCanonicalValues,
  sealArtifact,
  verifyArtifactHash,
} from "./artifact.js";

export const CATALOG_REVIEW_SUBJECT_KINDS = ["asset", "pair"] as const;
export const CATALOG_REVIEW_SUBJECT_KIND_SCHEMA = z.enum(CATALOG_REVIEW_SUBJECT_KINDS);
export type CatalogReviewSubjectKind = z.output<typeof CATALOG_REVIEW_SUBJECT_KIND_SCHEMA>;

export const CATALOG_DEFECT_DOMAINS = [
  "appearance",
  "geometry",
  "installation",
  "integrity",
  "material",
  "metric",
  "realization",
  "rights",
  "semantics",
  "style",
  "substitution",
] as const;
export const CATALOG_DEFECT_DOMAIN_SCHEMA = z.enum(CATALOG_DEFECT_DOMAINS);

export const CATALOG_CALIBRATION_STRATUM_DIMENSIONS = [
  "evidence_quality",
  "installation",
  "material",
  "metric_scale",
  "realization",
  "semantic_boundary",
] as const;
export const CATALOG_CALIBRATION_STRATUM_DIMENSION_SCHEMA = z.enum(
  CATALOG_CALIBRATION_STRATUM_DIMENSIONS,
);

export const CATALOG_DEFECT_DEFINITION_SCHEMA = z
  .object({
    defectId: ASCII_ID_SCHEMA,
    domain: CATALOG_DEFECT_DOMAIN_SCHEMA,
    subjectKind: CATALOG_REVIEW_SUBJECT_KIND_SCHEMA,
    gateStatus: z.enum(["incomplete", "rejected"]),
    definition: z.string().trim().min(1).max(2048),
  })
  .strict();
export type CatalogDefectDefinition = z.output<typeof CATALOG_DEFECT_DEFINITION_SCHEMA>;

export const CATALOG_REVIEW_CRITERION_SCHEMA = z
  .object({
    criterionId: ASCII_ID_SCHEMA,
    subjectKind: CATALOG_REVIEW_SUBJECT_KIND_SCHEMA,
    definition: z.string().trim().min(1).max(2048),
    passCondition: z.string().trim().min(1).max(2048),
    failureDefectId: ASCII_ID_SCHEMA,
    requiredEvidenceChannels: z.array(CATALOG_EVIDENCE_CHANNEL_SCHEMA).min(1).max(7),
    requiresAdmittedAssertions: z.boolean(),
  })
  .strict()
  .superRefine((value, context) =>
    requireCanonicalValues(
      value.requiredEvidenceChannels,
      String,
      "criterion evidence channels",
      context,
    ),
  );
export type CatalogReviewCriterion = z.output<typeof CATALOG_REVIEW_CRITERION_SCHEMA>;

export const CATALOG_CALIBRATION_STRATUM_SCHEMA = z
  .object({
    stratumId: ASCII_ID_SCHEMA,
    dimension: CATALOG_CALIBRATION_STRATUM_DIMENSION_SCHEMA,
    definition: z.string().trim().min(1).max(2048),
    minimumAssetJudgments: z.number().int().nonnegative().max(100_000),
    minimumPairJudgments: z.number().int().nonnegative().max(100_000),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.minimumAssetJudgments === 0 && value.minimumPairJudgments === 0)
      context.addIssue({
        code: "custom",
        message: "A calibration stratum must require at least one judgment",
      });
  });
export type CatalogCalibrationStratum = z.output<typeof CATALOG_CALIBRATION_STRATUM_SCHEMA>;

export const CATALOG_ADMISSION_RUBRIC_SCHEMA = z
  .object({
    kind: z.literal("CatalogAdmissionRubric"),
    rubricId: ASCII_ID_SCHEMA,
    semanticModuleHash: HASH_SCHEMA,
    evidenceChannels: z.array(CATALOG_EVIDENCE_CHANNEL_SCHEMA).length(7),
    defects: z.array(CATALOG_DEFECT_DEFINITION_SCHEMA).min(1).max(256),
    criteria: z.array(CATALOG_REVIEW_CRITERION_SCHEMA).min(2).max(256),
    strata: z.array(CATALOG_CALIBRATION_STRATUM_SCHEMA).min(1).max(256),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyArtifactHash(value, context);
    requireCanonicalValues(value.evidenceChannels, String, "rubric evidence channels", context);
    requireCanonicalValues(value.defects, (entry) => entry.defectId, "rubric defects", context);
    requireCanonicalValues(
      value.criteria,
      (entry) => entry.criterionId,
      "review criteria",
      context,
    );
    requireCanonicalValues(value.strata, (entry) => entry.stratumId, "calibration strata", context);

    if (stableJson(value.evidenceChannels) !== stableJson(CATALOG_EVIDENCE_CHANNELS))
      context.addIssue({
        code: "custom",
        path: ["evidenceChannels"],
        message: "The rubric must cover every evidence channel exactly once",
      });

    const defects = new Map(value.defects.map((entry) => [entry.defectId, entry]));
    const referencedDefects = new Set<string>();
    const usedChannels = new Set<CatalogEvidenceChannelName>();
    for (const [index, criterion] of value.criteria.entries()) {
      const defect = defects.get(criterion.failureDefectId);
      referencedDefects.add(criterion.failureDefectId);
      for (const channel of criterion.requiredEvidenceChannels) usedChannels.add(channel);
      if (!defect)
        context.addIssue({
          code: "custom",
          path: ["criteria", index, "failureDefectId"],
          message: `Unknown defect ${criterion.failureDefectId}`,
        });
      else if (defect.subjectKind !== criterion.subjectKind)
        context.addIssue({
          code: "custom",
          path: ["criteria", index, "failureDefectId"],
          message: "Criterion and defect subject kinds must match",
        });
    }
    for (const [index, defect] of value.defects.entries())
      if (!referencedDefects.has(defect.defectId))
        context.addIssue({
          code: "custom",
          path: ["defects", index],
          message: `Defect ${defect.defectId} is not exercised by a review criterion`,
        });
    for (const channel of CATALOG_EVIDENCE_CHANNELS)
      if (!usedChannels.has(channel))
        context.addIssue({
          code: "custom",
          path: ["criteria"],
          message: `No review criterion consumes the ${channel} channel`,
        });
    for (const subjectKind of CATALOG_REVIEW_SUBJECT_KINDS)
      if (!value.criteria.some((criterion) => criterion.subjectKind === subjectKind))
        context.addIssue({
          code: "custom",
          path: ["criteria"],
          message: `The rubric requires at least one ${subjectKind} criterion`,
        });
  });
export type CatalogAdmissionRubric = z.output<typeof CATALOG_ADMISSION_RUBRIC_SCHEMA>;

export function sealCatalogAdmissionRubric(
  input: Omit<CatalogAdmissionRubric, "kind" | "hash">,
): CatalogAdmissionRubric {
  return sealArtifact(CATALOG_ADMISSION_RUBRIC_SCHEMA, {
    kind: "CatalogAdmissionRubric" as const,
    ...input,
    evidenceChannels: canonicalValues(input.evidenceChannels, String, "rubric evidence channels"),
    defects: canonicalValues(input.defects, (entry) => entry.defectId, "rubric defects"),
    criteria: canonicalValues(
      input.criteria.map((criterion) => ({
        ...criterion,
        requiredEvidenceChannels: canonicalValues(
          criterion.requiredEvidenceChannels,
          String,
          "criterion evidence channels",
        ),
      })),
      (entry) => entry.criterionId,
      "review criteria",
    ),
    strata: canonicalValues(input.strata, (entry) => entry.stratumId, "calibration strata"),
  });
}

export const CATALOG_LEAKAGE_RELATION_KINDS = [
  "canonical_geometry_identity",
  "exact_content_identity",
  "geometry_containment",
  "near_duplicate_shape",
  "shared_material_payload",
] as const;
export const CATALOG_LEAKAGE_RELATION_KIND_SCHEMA = z.enum(CATALOG_LEAKAGE_RELATION_KINDS);

export const CATALOG_HARD_LEAKAGE_RELATION_KINDS = [
  "canonical_geometry_identity",
  "exact_content_identity",
  "geometry_containment",
  "near_duplicate_shape",
] as const;

export const CATALOG_CONTEXT_RELATION_KINDS = ["shared_material_payload"] as const;

export const CATALOG_LEAKAGE_GROUPING_POLICY_SCHEMA = z
  .object({
    kind: z.literal("CatalogLeakageGroupingPolicy"),
    observedRelationKinds: z.array(CATALOG_LEAKAGE_RELATION_KIND_SCHEMA).length(5),
    groupingRelationKinds: z.array(CATALOG_LEAKAGE_RELATION_KIND_SCHEMA).length(4),
    contextRelationKinds: z.array(CATALOG_LEAKAGE_RELATION_KIND_SCHEMA).length(1),
    nearDuplicateSimilarity: z
      .object({
        numerator: z.number().int().positive(),
        denominator: z.number().int().positive(),
      })
      .strict(),
    transitiveClosureRequired: z.literal(true),
    sourceMetadataPermitted: z.literal(false),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyArtifactHash(value, context);
    requireCanonicalValues(
      value.observedRelationKinds,
      String,
      "observed leakage relation kinds",
      context,
    );
    requireCanonicalValues(
      value.groupingRelationKinds,
      String,
      "hard leakage relation kinds",
      context,
    );
    requireCanonicalValues(value.contextRelationKinds, String, "context relation kinds", context);
    if (stableJson(value.observedRelationKinds) !== stableJson(CATALOG_LEAKAGE_RELATION_KINDS))
      context.addIssue({
        code: "custom",
        path: ["observedRelationKinds"],
        message: "Leakage analysis requires every physical relation kind",
      });
    if (stableJson(value.groupingRelationKinds) !== stableJson(CATALOG_HARD_LEAKAGE_RELATION_KINDS))
      context.addIssue({
        code: "custom",
        path: ["groupingRelationKinds"],
        message: "Leakage grouping requires every identity-bearing relation kind",
      });
    if (stableJson(value.contextRelationKinds) !== stableJson(CATALOG_CONTEXT_RELATION_KINDS))
      context.addIssue({
        code: "custom",
        path: ["contextRelationKinds"],
        message: "Material sharing must remain contextual rather than identity-bearing",
      });
    if (value.nearDuplicateSimilarity.numerator >= value.nearDuplicateSimilarity.denominator)
      context.addIssue({
        code: "custom",
        path: ["nearDuplicateSimilarity"],
        message: "Near-duplicate similarity must be a proper fraction",
      });
  });
export type CatalogLeakageGroupingPolicy = z.output<typeof CATALOG_LEAKAGE_GROUPING_POLICY_SCHEMA>;

export function sealCatalogLeakageGroupingPolicy(
  input: Omit<CatalogLeakageGroupingPolicy, "kind" | "hash">,
): CatalogLeakageGroupingPolicy {
  return sealArtifact(CATALOG_LEAKAGE_GROUPING_POLICY_SCHEMA, {
    kind: "CatalogLeakageGroupingPolicy" as const,
    ...input,
    observedRelationKinds: canonicalValues(
      input.observedRelationKinds,
      String,
      "observed leakage relation kinds",
    ),
    groupingRelationKinds: canonicalValues(
      input.groupingRelationKinds,
      String,
      "hard leakage relation kinds",
    ),
    contextRelationKinds: canonicalValues(
      input.contextRelationKinds,
      String,
      "context relation kinds",
    ),
  });
}
