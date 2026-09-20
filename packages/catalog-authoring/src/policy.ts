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

const RISK_TARGET_SCHEMA = z
  .object({
    riskId: ASCII_ID_SCHEMA,
    stratumId: ASCII_ID_SCHEMA,
    defectDomain: CATALOG_DEFECT_DOMAIN_SCHEMA,
    subjectKind: CATALOG_REVIEW_SUBJECT_KIND_SCHEMA,
    maximumDefectRateMillionths: z.number().int().positive().max(1_000_000),
    confidenceMillionths: z.number().int().positive().max(999_999),
    acceptanceNumber: z.number().int().nonnegative().safe(),
  })
  .strict();

/** Catalog authority policy deliberately contains no model, ranking, or search settings. */
export const CATALOG_ADMISSION_POLICY_SCHEMA = z
  .object({
    kind: z.literal("CatalogAdmissionPolicy"),
    policyId: ASCII_ID_SCHEMA,
    automaticAdmissionEnabled: z.literal(false),
    automaticallyAdmissibleEntryKinds: z.array(CATALOG_ENTRY_KIND_SCHEMA).length(0),
    riskTargets: z.array(RISK_TARGET_SCHEMA).min(1),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyArtifactHash(value, context);
    requireCanonicalValues(value.riskTargets, (entry) => entry.riskId, "risk targets", context);
  });
export type CatalogAdmissionPolicy = z.output<typeof CATALOG_ADMISSION_POLICY_SCHEMA>;

export const CATALOG_SEARCH_FIELD_NAMES = [
  "alternateNouns",
  "caption",
  "colors",
  "environments",
  "materials",
  "primaryNoun",
  "sourceBasename",
  "styleTerms",
  "useCases",
  "visibleText",
] as const;
export const CATALOG_SEARCH_FIELD_NAME_SCHEMA = z.enum(CATALOG_SEARCH_FIELD_NAMES);

const SEARCH_FIELD_WEIGHTS_SCHEMA = z
  .object({
    alternateNouns: z.literal(3),
    caption: z.literal(3),
    colors: z.literal(2),
    environments: z.literal(1),
    materials: z.literal(2),
    primaryNoun: z.literal(4),
    sourceBasename: z.literal(1),
    styleTerms: z.literal(2),
    useCases: z.literal(1),
    visibleText: z.literal(2),
  })
  .strict();

export const CATALOG_SEARCH_POLICY_SCHEMA = z
  .object({
    kind: z.literal("CatalogSearchPolicy"),
    policyId: ASCII_ID_SCHEMA,
    origin: z.string().trim().min(1),
    fieldWeights: SEARCH_FIELD_WEIGHTS_SCHEMA,
    reciprocalRankConstant: z.number().int().positive().safe(),
    fusionNormalization: z.literal("per_document_available_channels"),
    tokenizerImplementationHash: HASH_SCHEMA,
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => verifyArtifactHash(value, context));
export type CatalogSearchPolicy = z.output<typeof CATALOG_SEARCH_POLICY_SCHEMA>;

/** Frozen policy for the requirement-specific accept/abstain stage after retrieval. */
export const CATALOG_CANDIDATE_DECISION_POLICY_SCHEMA = z
  .object({
    kind: z.literal("CatalogCandidateDecisionPolicy"),
    policyId: ASCII_ID_SCHEMA,
    minimumValidatedCandidates: z.number().int().min(1).safe(),
    minimumMatchCount: z.literal(1),
    uncertainOutcome: z.literal("evidence_insufficient"),
    allMismatchOutcome: z.literal("no_suitable_match"),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => verifyArtifactHash(value, context));
export type CatalogCandidateDecisionPolicy = z.output<
  typeof CATALOG_CANDIDATE_DECISION_POLICY_SCHEMA
>;

export const CATALOG_SUBSTITUTION_PROPOSAL_POLICY_SCHEMA = z
  .object({
    kind: z.literal("CatalogSubstitutionProposalPolicy"),
    policyId: ASCII_ID_SCHEMA,
    minimumImageTextSimilarityMillionths: z.number().int().min(-1_000_000).max(1_000_000),
    minimumShapeSimilarityMillionths: z.number().int().min(-1_000_000).max(1_000_000),
    maximumAxisRatioMillionths: z.number().int().min(1_000_000).max(100_000_000),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => verifyArtifactHash(value, context));
export type CatalogSubstitutionProposalPolicy = z.output<
  typeof CATALOG_SUBSTITUTION_PROPOSAL_POLICY_SCHEMA
>;

export function sealCatalogAdmissionPolicy(
  input: Omit<
    CatalogAdmissionPolicy,
    "kind" | "automaticAdmissionEnabled" | "automaticallyAdmissibleEntryKinds" | "hash"
  >,
): CatalogAdmissionPolicy {
  return sealArtifact(CATALOG_ADMISSION_POLICY_SCHEMA, {
    kind: "CatalogAdmissionPolicy" as const,
    ...input,
    automaticAdmissionEnabled: false as const,
    automaticallyAdmissibleEntryKinds: [],
    riskTargets: canonicalValues(input.riskTargets, (entry) => entry.riskId, "risk targets"),
  });
}

export function sealCatalogSearchPolicy(
  input: Omit<CatalogSearchPolicy, "kind" | "hash">,
): CatalogSearchPolicy {
  return sealArtifact(CATALOG_SEARCH_POLICY_SCHEMA, {
    kind: "CatalogSearchPolicy" as const,
    ...input,
  });
}

export function sealCatalogCandidateDecisionPolicy(
  input: Omit<CatalogCandidateDecisionPolicy, "kind" | "hash">,
): CatalogCandidateDecisionPolicy {
  return sealArtifact(CATALOG_CANDIDATE_DECISION_POLICY_SCHEMA, {
    kind: "CatalogCandidateDecisionPolicy" as const,
    ...input,
  });
}

export function sealCatalogSubstitutionProposalPolicy(
  input: Omit<CatalogSubstitutionProposalPolicy, "kind" | "hash">,
): CatalogSubstitutionProposalPolicy {
  return sealArtifact(CATALOG_SUBSTITUTION_PROPOSAL_POLICY_SCHEMA, {
    kind: "CatalogSubstitutionProposalPolicy" as const,
    ...input,
  });
}
