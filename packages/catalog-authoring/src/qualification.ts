import { z } from "zod";
import {
  COMPILATION_STATUS_SCHEMA,
  HASH_SCHEMA,
  compareCanonicalStrings,
  stableJson,
} from "@basalt/contracts";
import {
  ASSET_SEARCH_METADATA_RECEIPT_SCHEMA,
  CATALOG_METADATA_VIEW_SET_SCHEMA,
  CATALOG_SEARCH_METADATA_REQUEST_SET_SCHEMA,
  CATALOG_SEARCH_METADATA_SET_SCHEMA,
  type CatalogSearchMetadataRequestSet,
  type CatalogSearchMetadataSet,
} from "./metadata.js";
import {
  CATALOG_EMBEDDING_MATRIX_SCHEMA,
  CATALOG_EMBEDDING_SET_SCHEMA,
  CATALOG_QUERY_EMBEDDING_RECEIPT_SCHEMA,
  type CatalogEmbeddingMatrix,
  type CatalogEmbeddingSet,
  type CatalogQueryEmbeddingReceipt,
} from "./embeddings.js";
import {
  CATALOG_SEARCH_INDEX_SCHEMA,
  CATALOG_SEARCH_QUERY_SCHEMA,
  CATALOG_SEARCH_RESULT_SET_SCHEMA,
  sealCatalogSearchQuery,
  type CatalogSearchIndex,
  type CatalogSearchQuery,
  type CatalogSearchResultSet,
} from "./search.js";
import {
  CATALOG_CANDIDATE_DECISION_SCHEMA,
  CATALOG_SEARCH_VALIDATION_REQUEST_SCHEMA,
  CATALOG_VALIDATION_RECEIPT_SCHEMA,
  type CatalogCandidateDecision,
  type CatalogSearchValidationRequest,
  type CatalogValidationReceipt,
} from "./validation.js";
import {
  canonicalValues,
  requireCanonicalValues,
  sealArtifact,
  verifyArtifactHash,
} from "./artifact.js";

export const CATALOG_QUALIFICATION_SPLITS = ["development", "holdout", "model_selection"] as const;
export const CATALOG_QUALIFICATION_SPLIT_SCHEMA = z.enum(CATALOG_QUALIFICATION_SPLITS);
export type CatalogQualificationSplit = z.output<typeof CATALOG_QUALIFICATION_SPLIT_SCHEMA>;

export const CATALOG_RETRIEVAL_CHANNELS = [
  "basename_only",
  "hybrid",
  "image_text_only",
  "metadata_only",
] as const;
export const CATALOG_RETRIEVAL_CHANNEL_SCHEMA = z.enum(CATALOG_RETRIEVAL_CHANNELS);

export const CATALOG_ENRICHMENT_PROFILES = [
  "basename_and_image_text",
  "basename_and_metadata",
  "basename_only",
  "fully_enriched",
] as const;
export const CATALOG_ENRICHMENT_PROFILE_SCHEMA = z.enum(CATALOG_ENRICHMENT_PROFILES);

export const CATALOG_QUALIFICATION_SELECTION_RULE =
  "least_gpu_milliseconds_passing_all_gates_retain_twelve_views_when_cost_is_inconclusive" as const;

/** Frozen before any holdout execution. Evaluation contains no hidden acceptance thresholds. */
export const CATALOG_QUALIFICATION_POLICY_SCHEMA = z
  .object({
    kind: z.literal("CatalogQualificationPolicy"),
    policyId: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u),
    minimumUniformHitAtFiveMillionths: z.number().int().min(0).max(1_000_000),
    minimumUniformMeanReciprocalRankMillionths: z.number().int().min(0).max(1_000_000),
    minimumMixedHitAtFiveMillionths: z.number().int().min(0).max(1_000_000),
    minimumMixedMeanReciprocalRankMillionths: z.number().int().min(0).max(1_000_000),
    minimumDecisionAccuracyMillionths: z.number().int().min(0).max(1_000_000),
    minimumValidatorAccuracyMillionths: z.number().int().min(0).max(1_000_000),
    maximumHardNegativeFalseMatches: z.literal(0),
    maximumNoMatchFalseAcceptances: z.literal(0),
    maximumInsufficientReportedAsNoMatch: z.literal(0),
    requireFourAndTwelveViewEvidence: z.literal(true),
    requireIndependentWriterAndValidatorRuns: z.literal(true),
    holdoutMutationPolicy: z.literal("freeze_prompt_schema_models_and_thresholds_before_holdout"),
    selectionRule: z.literal(CATALOG_QUALIFICATION_SELECTION_RULE),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => verifyArtifactHash(value, context));
export type CatalogQualificationPolicy = z.output<typeof CATALOG_QUALIFICATION_POLICY_SCHEMA>;

const WRITER_CONFIGURATION_SCHEMA = z
  .object({
    modelId: z.string().regex(/^[a-z][a-z0-9_]{2,127}$/u),
    modelCommitHash: z.string().regex(/^[a-f0-9]{40,64}$/u),
    viewSet: CATALOG_METADATA_VIEW_SET_SCHEMA,
  })
  .strict();

const VALIDATOR_CONFIGURATION_SCHEMA = z
  .object({
    modelId: z.string().regex(/^[a-z][a-z0-9_]{2,127}$/u),
    modelCommitHash: z.string().regex(/^[a-f0-9]{40,64}$/u),
  })
  .strict();

const QUALIFICATION_ASSET_SCHEMA = z
  .object({
    sourceContentHash: HASH_SCHEMA,
    leakageGroupHash: HASH_SCHEMA,
    split: CATALOG_QUALIFICATION_SPLIT_SCHEMA,
    population: z.enum(["background", "cohort"]),
    evidenceExpectation: z.enum(["sufficient", "insufficient"]),
    mixedEnrichmentProfile: CATALOG_ENRICHMENT_PROFILE_SCHEMA,
    labelBasis: z.enum(["basename_heuristic_proposal", "independent_visual_review"]),
    stratum: z
      .enum([
        "aggregate",
        "attachment",
        "collision_companion",
        "misleading_name",
        "modular_piece",
        "out_of_kernel",
        "style_contrast",
        "vegetation",
        "whole_object",
      ])
      .optional(),
    adjudicatedNouns: z.array(z.string().trim().min(1).max(160)).min(1).max(16).optional(),
    adjudicationEvidenceHashes: z.array(HASH_SCHEMA).min(1).max(64).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.population === "background" && value.mixedEnrichmentProfile !== "basename_only")
      context.addIssue({
        code: "custom",
        path: ["mixedEnrichmentProfile"],
        message: "Qualification background assets remain basename-only",
      });
    if (
      value.population === "cohort" &&
      (!value.stratum || !value.adjudicatedNouns || !value.adjudicationEvidenceHashes)
    )
      context.addIssue({
        code: "custom",
        message: "Qualification cohort assets require adjudicated labels, stratum, and evidence",
      });
    if (
      value.population === "background" &&
      (value.stratum || value.adjudicatedNouns || value.adjudicationEvidenceHashes)
    )
      context.addIssue({
        code: "custom",
        message: "Background assets cannot carry cohort adjudication fields",
      });
    if (value.adjudicatedNouns)
      requireCanonicalValues(
        value.adjudicatedNouns,
        String,
        "qualification adjudicated nouns",
        context,
      );
    if (value.adjudicationEvidenceHashes)
      requireCanonicalValues(
        value.adjudicationEvidenceHashes,
        String,
        "qualification asset adjudication evidence",
        context,
      );
  });

const RELEVANCE_JUDGMENT_SCHEMA = z
  .object({
    sourceContentHash: HASH_SCHEMA,
    relevance: z.enum(["irrelevant", "relevant", "uncertain"]),
  })
  .strict();

const QUALIFICATION_QUERY_SCHEMA = z
  .object({
    queryId: z.string().regex(/^[a-z][a-z0-9_]{0,95}$/u),
    split: CATALOG_QUALIFICATION_SPLIT_SCHEMA,
    query: CATALOG_SEARCH_QUERY_SCHEMA,
    expectation: z.enum(["evidence_insufficient", "match", "no_match"]),
    judgmentBasis: z.enum(["basename_heuristic_proposal", "independent_visual_review"]),
    judgments: z.array(RELEVANCE_JUDGMENT_SCHEMA).min(1).max(512),
    adjudicationEvidenceHashes: z.array(HASH_SCHEMA).min(1).max(64),
  })
  .strict()
  .superRefine((value, context) => {
    requireCanonicalValues(
      value.judgments,
      (entry) => entry.sourceContentHash,
      "qualification relevance judgments",
      context,
    );
    requireCanonicalValues(
      value.adjudicationEvidenceHashes,
      String,
      "qualification adjudication evidence",
      context,
    );
    if (value.query.rankingMode !== "automatic" || value.query.referenceSourceContentHash)
      context.addIssue({
        code: "custom",
        path: ["query"],
        message: "Fixture queries are channel-neutral executable queries",
      });
    const relevant = value.judgments.filter((entry) => entry.relevance === "relevant").length;
    if (value.expectation === "match" && relevant === 0)
      context.addIssue({
        code: "custom",
        path: ["expectation"],
        message: "Match queries require at least one relevant asset",
      });
    if (value.expectation !== "match" && relevant > 0)
      context.addIssue({
        code: "custom",
        path: ["expectation"],
        message: "No-match and evidence-insufficient queries cannot contain a relevant asset",
      });
  });

const QUALIFICATION_VALIDATION_CASE_SCHEMA = z
  .object({
    caseId: z.string().regex(/^[a-z][a-z0-9_]{0,95}$/u),
    split: CATALOG_QUALIFICATION_SPLIT_SCHEMA,
    request: CATALOG_SEARCH_VALIDATION_REQUEST_SCHEMA,
    expectedVerdict: z.enum(["match", "mismatch", "uncertain"]),
    verdictBasis: z.enum(["basename_heuristic_proposal", "independent_visual_review"]),
    adjudicationEvidenceHashes: z.array(HASH_SCHEMA).min(1).max(64),
  })
  .strict()
  .superRefine((value, context) =>
    requireCanonicalValues(
      value.adjudicationEvidenceHashes,
      String,
      "validation adjudication evidence",
      context,
    ),
  );

const QUALIFICATION_REVIEW_IMAGE_PATH_SCHEMA = z
  .string()
  .regex(/^\.basalt\/catalog\/(?:review\/previews|qualification\/review)\/[A-Za-z0-9_./-]+\.png$/u);

const QUALIFICATION_REVIEW_PAGE_SCHEMA = z
  .object({
    pageKind: z.enum(["asset_descriptions", "query_asset_relevance", "validator_verdicts"]),
    split: CATALOG_QUALIFICATION_SPLIT_SCHEMA,
    pageNumber: z.number().int().positive(),
    relativePath: QUALIFICATION_REVIEW_IMAGE_PATH_SCHEMA,
    bytesHash: HASH_SCHEMA,
  })
  .strict();

const QUALIFICATION_REVIEW_VISUAL_SCHEMA = z
  .object({
    sourceContentHash: HASH_SCHEMA,
    renderEvidenceHash: HASH_SCHEMA,
    rgbHash: HASH_SCHEMA,
    rgbRelativePath: QUALIFICATION_REVIEW_IMAGE_PATH_SCHEMA,
    contactSheetRelativePath: QUALIFICATION_REVIEW_IMAGE_PATH_SCHEMA,
  })
  .strict();

const QUALIFICATION_REVIEW_ASSET_SCHEMA = z
  .object({
    sourceContentHash: HASH_SCHEMA,
    split: CATALOG_QUALIFICATION_SPLIT_SCHEMA,
    proposedEvidenceExpectation: z.enum(["sufficient", "insufficient"]),
    proposedStratum: z.enum([
      "aggregate",
      "attachment",
      "collision_companion",
      "misleading_name",
      "modular_piece",
      "out_of_kernel",
      "style_contrast",
      "vegetation",
      "whole_object",
    ]),
    proposedNouns: z.array(z.string().trim().min(1).max(160)).min(1).max(16),
  })
  .strict()
  .superRefine((value, context) =>
    requireCanonicalValues(value.proposedNouns, String, "proposed review nouns", context),
  );

const QUALIFICATION_REVIEW_QUERY_SCHEMA = z
  .object({
    queryId: z.string().regex(/^[a-z][a-z0-9_]{0,95}$/u),
    split: CATALOG_QUALIFICATION_SPLIT_SCHEMA,
    queryHash: HASH_SCHEMA,
    proposedExpectation: z.enum(["evidence_insufficient", "match", "no_match"]),
    proposedJudgments: z.array(RELEVANCE_JUDGMENT_SCHEMA).min(1).max(512),
  })
  .strict()
  .superRefine((value, context) =>
    requireCanonicalValues(
      value.proposedJudgments,
      (entry) => entry.sourceContentHash,
      "proposed query judgments",
      context,
    ),
  );

const QUALIFICATION_REVIEW_VALIDATOR_CASE_SCHEMA = z
  .object({
    caseId: z.string().regex(/^[a-z][a-z0-9_]{0,95}$/u),
    split: CATALOG_QUALIFICATION_SPLIT_SCHEMA,
    requestHash: HASH_SCHEMA,
    candidateSourceContentHash: HASH_SCHEMA,
    proposedVerdict: z.enum(["match", "mismatch", "uncertain"]),
  })
  .strict();

/**
 * The complete human-review input. Filename-derived values are proposals only;
 * this packet deliberately includes every answer-key surface, not only an asset
 * description contact sheet.
 */
export const CATALOG_QUALIFICATION_REVIEW_PACKET_SCHEMA = z
  .object({
    kind: z.literal("CatalogQualificationReviewPacket"),
    proposalFixtureHash: HASH_SCHEMA,
    visualReviewIndexHash: HASH_SCHEMA,
    proposalAuthority: z.literal("none"),
    reviewScope: z
      .object({
        assetDescriptions: z.literal("required"),
        queryAssetRelevance: z.literal("required"),
        validatorVerdicts: z.literal("required"),
      })
      .strict(),
    pages: z.array(QUALIFICATION_REVIEW_PAGE_SCHEMA).min(9).max(512),
    visuals: z.array(QUALIFICATION_REVIEW_VISUAL_SCHEMA).min(1).max(100_000),
    assets: z.array(QUALIFICATION_REVIEW_ASSET_SCHEMA).min(1).max(10_000),
    queries: z.array(QUALIFICATION_REVIEW_QUERY_SCHEMA).min(1).max(10_000),
    validationCases: z.array(QUALIFICATION_REVIEW_VALIDATOR_CASE_SCHEMA).min(1).max(10_000),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyArtifactHash(value, context);
    requireCanonicalValues(
      value.pages,
      (entry) => `${entry.pageKind}:${entry.split}:${String(entry.pageNumber).padStart(4, "0")}`,
      "qualification review pages",
      context,
    );
    requireCanonicalValues(
      value.visuals,
      (entry) => entry.sourceContentHash,
      "qualification review visuals",
      context,
    );
    requireCanonicalValues(
      value.assets,
      (entry) => entry.sourceContentHash,
      "qualification review assets",
      context,
    );
    requireCanonicalValues(
      value.queries,
      (entry) => entry.queryId,
      "qualification review queries",
      context,
    );
    requireCanonicalValues(
      value.validationCases,
      (entry) => entry.caseId,
      "qualification review validation cases",
      context,
    );
    for (const split of CATALOG_QUALIFICATION_SPLITS)
      for (const pageKind of [
        "asset_descriptions",
        "query_asset_relevance",
        "validator_verdicts",
      ] as const)
        if (!value.pages.some((entry) => entry.split === split && entry.pageKind === pageKind))
          context.addIssue({
            code: "custom",
            path: ["pages"],
            message: `Review packet lacks ${pageKind} pages for ${split}`,
          });
  });
export type CatalogQualificationReviewPacket = z.output<
  typeof CATALOG_QUALIFICATION_REVIEW_PACKET_SCHEMA
>;

const REVIEW_ACTION_SCHEMA = z.enum(["confirmed", "revised"]);

const QUALIFICATION_ADJUDICATED_ASSET_SCHEMA = z
  .object({
    sourceContentHash: HASH_SCHEMA,
    reviewAction: REVIEW_ACTION_SCHEMA,
    evidenceExpectation: z.enum(["sufficient", "insufficient"]),
    stratum: z.enum([
      "aggregate",
      "attachment",
      "collision_companion",
      "misleading_name",
      "modular_piece",
      "out_of_kernel",
      "style_contrast",
      "vegetation",
      "whole_object",
    ]),
    adjudicatedNouns: z.array(z.string().trim().min(1).max(160)).min(1).max(16),
  })
  .strict()
  .superRefine((value, context) =>
    requireCanonicalValues(value.adjudicatedNouns, String, "adjudicated asset nouns", context),
  );

const QUALIFICATION_ADJUDICATED_RELEVANCE_SCHEMA = RELEVANCE_JUDGMENT_SCHEMA.extend({
  reviewAction: REVIEW_ACTION_SCHEMA,
}).strict();

const QUALIFICATION_ADJUDICATED_QUERY_SCHEMA = z
  .object({
    queryId: z.string().regex(/^[a-z][a-z0-9_]{0,95}$/u),
    expectationReviewAction: REVIEW_ACTION_SCHEMA,
    expectation: z.enum(["evidence_insufficient", "match", "no_match"]),
    judgments: z.array(QUALIFICATION_ADJUDICATED_RELEVANCE_SCHEMA).min(1).max(512),
  })
  .strict()
  .superRefine((value, context) =>
    requireCanonicalValues(
      value.judgments,
      (entry) => entry.sourceContentHash,
      "adjudicated query judgments",
      context,
    ),
  );

const QUALIFICATION_ADJUDICATED_VALIDATOR_CASE_SCHEMA = z
  .object({
    caseId: z.string().regex(/^[a-z][a-z0-9_]{0,95}$/u),
    reviewAction: REVIEW_ACTION_SCHEMA,
    expectedVerdict: z.enum(["match", "mismatch", "uncertain"]),
  })
  .strict();

/** Creator authority over the exact qualification answer key. */
export const CATALOG_QUALIFICATION_ADJUDICATION_DECISION_SCHEMA = z
  .object({
    kind: z.literal("CatalogQualificationAdjudicationDecision"),
    proposalFixtureHash: HASH_SCHEMA,
    reviewPacketHash: HASH_SCHEMA,
    reviewer: z
      .object({
        authority: z.literal("creator"),
        reviewerId: z.string().trim().min(1).max(160),
      })
      .strict(),
    reviewMethod: z.literal("independent_visual_review"),
    reviewerStatement: z.string().trim().min(32).max(2_048),
    reviewedAt: z.string().datetime({ offset: true }),
    coverage: z
      .object({
        assetDescriptions: z.literal("complete"),
        queryAssetRelevance: z.literal("complete"),
        validatorVerdicts: z.literal("complete"),
      })
      .strict(),
    assets: z.array(QUALIFICATION_ADJUDICATED_ASSET_SCHEMA).min(1).max(10_000),
    queries: z.array(QUALIFICATION_ADJUDICATED_QUERY_SCHEMA).min(1).max(10_000),
    validationCases: z.array(QUALIFICATION_ADJUDICATED_VALIDATOR_CASE_SCHEMA).min(1).max(10_000),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyArtifactHash(value, context);
    requireCanonicalValues(
      value.assets,
      (entry) => entry.sourceContentHash,
      "qualification adjudicated assets",
      context,
    );
    requireCanonicalValues(
      value.queries,
      (entry) => entry.queryId,
      "qualification adjudicated queries",
      context,
    );
    requireCanonicalValues(
      value.validationCases,
      (entry) => entry.caseId,
      "qualification adjudicated validation cases",
      context,
    );
  });
export type CatalogQualificationAdjudicationDecision = z.output<
  typeof CATALOG_QUALIFICATION_ADJUDICATION_DECISION_SCHEMA
>;

export const CATALOG_QUALIFICATION_CANDIDATE_POOL_SCHEMA = z
  .object({
    kind: z.literal("CatalogQualificationCandidatePool"),
    split: CATALOG_QUALIFICATION_SPLIT_SCHEMA,
    coverageScenario: z.enum(["mixed", "uniform"]),
    assets: z
      .array(
        z
          .object({
            sourceContentHash: HASH_SCHEMA,
            enrichmentProfile: CATALOG_ENRICHMENT_PROFILE_SCHEMA,
          })
          .strict(),
      )
      .min(1)
      .max(100_000),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyArtifactHash(value, context);
    requireCanonicalValues(
      value.assets,
      (entry) => entry.sourceContentHash,
      "qualification candidate pool",
      context,
    );
    if (
      value.coverageScenario === "uniform" &&
      value.assets.some((entry) => entry.enrichmentProfile !== "fully_enriched")
    )
      context.addIssue({
        code: "custom",
        path: ["assets"],
        message: "Uniform candidate pools require full enrichment for every asset",
      });
  });
export type CatalogQualificationCandidatePool = z.output<
  typeof CATALOG_QUALIFICATION_CANDIDATE_POOL_SCHEMA
>;

export const CATALOG_QUALIFICATION_FIXTURE_SCHEMA = z
  .object({
    kind: z.literal("CatalogQualificationFixture"),
    adjudication: z.discriminatedUnion("status", [
      z
        .object({
          status: z.literal("pending_creator_review"),
          proposalAuthor: z.literal("codex_agent"),
          proposalMethod: z.literal("basename_heuristic"),
        })
        .strict(),
      z
        .object({
          status: z.literal("creator_reviewed"),
          reviewerAuthority: z.literal("creator"),
          reviewerId: z.string().trim().min(1).max(160),
          reviewMethod: z.literal("independent_visual_review"),
          proposalFixtureHash: HASH_SCHEMA,
          reviewPacketHash: HASH_SCHEMA,
          decisionArtifactHash: HASH_SCHEMA,
        })
        .strict(),
    ]),
    sourceManifestHash: HASH_SCHEMA,
    measurementSetHash: HASH_SCHEMA,
    visualReviewIndexHash: HASH_SCHEMA,
    leakageAnalysisHash: HASH_SCHEMA,
    assets: z.array(QUALIFICATION_ASSET_SCHEMA).min(1).max(100_000),
    candidatePools: z.array(CATALOG_QUALIFICATION_CANDIDATE_POOL_SCHEMA).length(6),
    queries: z.array(QUALIFICATION_QUERY_SCHEMA).min(1).max(10_000),
    validationCases: z.array(QUALIFICATION_VALIDATION_CASE_SCHEMA).min(1).max(10_000),
    writerConfigurations: z.array(WRITER_CONFIGURATION_SCHEMA).min(1).max(16),
    validatorConfigurations: z.array(VALIDATOR_CONFIGURATION_SCHEMA).min(1).max(16),
    adjudicationProtocolHash: HASH_SCHEMA,
    qualificationPolicyHash: HASH_SCHEMA,
    searchPolicyHash: HASH_SCHEMA,
    candidateDecisionPolicyHash: HASH_SCHEMA,
    modelDeclarationsHash: HASH_SCHEMA,
    modelRolePolicyHash: HASH_SCHEMA,
    metadataPromptTemplateHash: HASH_SCHEMA,
    validationPromptTemplateHash: HASH_SCHEMA,
    metadataSchemaHash: HASH_SCHEMA,
    validationSchemaHash: HASH_SCHEMA,
    selectionRule: z.literal(CATALOG_QUALIFICATION_SELECTION_RULE),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyArtifactHash(value, context);
    requireCanonicalValues(
      value.assets,
      (entry) => entry.sourceContentHash,
      "qualification assets",
      context,
    );
    requireCanonicalValues(
      value.candidatePools,
      candidatePoolIdentity,
      "qualification candidate pools",
      context,
    );
    requireCanonicalValues(
      value.queries,
      (entry) => entry.queryId,
      "qualification queries",
      context,
    );
    requireCanonicalValues(
      value.validationCases,
      (entry) => entry.caseId,
      "qualification validation cases",
      context,
    );
    requireCanonicalValues(
      value.writerConfigurations,
      writerConfigurationIdentity,
      "qualification writer configurations",
      context,
    );
    requireCanonicalValues(
      value.validatorConfigurations,
      (entry) => entry.modelId,
      "qualification validator configurations",
      context,
    );
    validateFixtureRelationships(value, context);
    const expectedBasis =
      value.adjudication.status === "creator_reviewed"
        ? "independent_visual_review"
        : "basename_heuristic_proposal";
    if (
      value.assets.some(
        (entry) => entry.population === "cohort" && entry.labelBasis !== expectedBasis,
      ) ||
      value.queries.some((entry) => entry.judgmentBasis !== expectedBasis) ||
      value.validationCases.some((entry) => entry.verdictBasis !== expectedBasis)
    )
      context.addIssue({
        code: "custom",
        path: ["adjudication"],
        message: "Qualification answer-key basis does not match its adjudication status",
      });
  });
export type CatalogQualificationFixture = z.output<typeof CATALOG_QUALIFICATION_FIXTURE_SCHEMA>;

const METADATA_RUN_SCHEMA = z
  .object({
    writerModelId: z.string().regex(/^[a-z][a-z0-9_]{2,127}$/u),
    writerModelCommitHash: z.string().regex(/^[a-f0-9]{40,64}$/u),
    writerViewSet: CATALOG_METADATA_VIEW_SET_SCHEMA,
    coverageScenario: z.enum(["mixed", "uniform"]),
    requestSetHash: HASH_SCHEMA,
    metadataSetHash: HASH_SCHEMA,
  })
  .strict();

const EMBEDDING_RUN_SCHEMA = z
  .object({
    coverageScenario: z.enum(["mixed", "uniform"]),
    modelId: z.string().regex(/^[a-z][a-z0-9_]{2,127}$/u),
    modelCommitHash: z.string().regex(/^[a-f0-9]{40,64}$/u),
    embeddingSetHash: HASH_SCHEMA,
    embeddingMatrixHash: HASH_SCHEMA,
  })
  .strict();

const INDEX_RUN_SCHEMA = z
  .object({
    writerModelId: z.string().regex(/^[a-z][a-z0-9_]{2,127}$/u),
    writerViewSet: CATALOG_METADATA_VIEW_SET_SCHEMA,
    coverageScenario: z.enum(["mixed", "uniform"]),
    candidatePoolHash: HASH_SCHEMA,
    indexHash: HASH_SCHEMA,
  })
  .strict();

const RETRIEVAL_RUN_SCHEMA = z
  .object({
    queryId: z.string().regex(/^[a-z][a-z0-9_]{0,95}$/u),
    writerModelId: z.string().regex(/^[a-z][a-z0-9_]{2,127}$/u),
    writerViewSet: CATALOG_METADATA_VIEW_SET_SCHEMA,
    channel: CATALOG_RETRIEVAL_CHANNEL_SCHEMA,
    coverageScenario: z.enum(["mixed", "uniform"]),
    queryHash: HASH_SCHEMA,
    queryEmbeddingReceiptHash: HASH_SCHEMA.optional(),
    resultSetHash: HASH_SCHEMA,
  })
  .strict();

const INDEPENDENT_VALIDATION_RUN_SCHEMA = z
  .object({
    caseId: z.string().regex(/^[a-z][a-z0-9_]{0,95}$/u),
    validatorModelId: z.string().regex(/^[a-z][a-z0-9_]{2,127}$/u),
    validatorModelCommitHash: z.string().regex(/^[a-f0-9]{40,64}$/u),
    requestHash: HASH_SCHEMA,
    receiptHash: HASH_SCHEMA,
  })
  .strict();

const DECISION_RUN_SCHEMA = z
  .object({
    queryId: z.string().regex(/^[a-z][a-z0-9_]{0,95}$/u),
    writerModelId: z.string().regex(/^[a-z][a-z0-9_]{2,127}$/u),
    writerViewSet: CATALOG_METADATA_VIEW_SET_SCHEMA,
    validatorModelId: z.string().regex(/^[a-z][a-z0-9_]{2,127}$/u),
    coverageScenario: z.literal("mixed"),
    resultSetHash: HASH_SCHEMA,
    validations: z
      .array(z.object({ requestHash: HASH_SCHEMA, receiptHash: HASH_SCHEMA }).strict())
      .max(8),
    decisionHash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    requireCanonicalValues(
      value.validations,
      (entry) => entry.requestHash,
      "qualification decision validations",
      context,
    );
  });

export const CATALOG_QUALIFICATION_EVIDENCE_SCHEMA = z
  .object({
    kind: z.literal("CatalogQualificationEvidence"),
    split: CATALOG_QUALIFICATION_SPLIT_SCHEMA,
    fixtureHash: HASH_SCHEMA,
    searchPolicyHash: HASH_SCHEMA,
    qualificationPolicyHash: HASH_SCHEMA,
    candidateDecisionPolicyHash: HASH_SCHEMA,
    modelDeclarationsHash: HASH_SCHEMA,
    modelRolePolicyHash: HASH_SCHEMA,
    metadataPromptTemplateHash: HASH_SCHEMA,
    validationPromptTemplateHash: HASH_SCHEMA,
    metadataSchemaHash: HASH_SCHEMA,
    validationSchemaHash: HASH_SCHEMA,
    workerImplementationHash: HASH_SCHEMA,
    frozenSelectionHash: HASH_SCHEMA.optional(),
    metadataRuns: z.array(METADATA_RUN_SCHEMA).max(128),
    embeddingRuns: z.array(EMBEDDING_RUN_SCHEMA).max(8),
    indexRuns: z.array(INDEX_RUN_SCHEMA).max(128),
    retrievalRuns: z.array(RETRIEVAL_RUN_SCHEMA).max(1_000_000),
    independentValidationRuns: z.array(INDEPENDENT_VALIDATION_RUN_SCHEMA).max(100_000),
    decisionRuns: z.array(DECISION_RUN_SCHEMA).max(1_000_000),
    compilerAuthority: z.literal(false),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyArtifactHash(value, context);
    requireCanonicalValues(
      value.metadataRuns,
      metadataRunIdentity,
      "qualification metadata runs",
      context,
    );
    requireCanonicalValues(
      value.embeddingRuns,
      (entry) => entry.coverageScenario,
      "qualification embedding runs",
      context,
    );
    requireCanonicalValues(value.indexRuns, indexRunIdentity, "qualification indexes", context);
    requireCanonicalValues(
      value.retrievalRuns,
      retrievalRunIdentity,
      "qualification retrieval runs",
      context,
    );
    requireCanonicalValues(
      value.independentValidationRuns,
      independentValidationRunIdentity,
      "qualification independent validator runs",
      context,
    );
    requireCanonicalValues(
      value.decisionRuns,
      decisionRunIdentity,
      "qualification decisions",
      context,
    );
    if ((value.split === "holdout") !== (value.frozenSelectionHash !== undefined))
      context.addIssue({
        code: "custom",
        path: ["frozenSelectionHash"],
        message: "Only holdout evidence binds, and holdout evidence must bind, a frozen selection",
      });
  });
export type CatalogQualificationEvidence = z.output<typeof CATALOG_QUALIFICATION_EVIDENCE_SCHEMA>;

export const CATALOG_QUALIFICATION_SELECTION_SCHEMA = z
  .object({
    kind: z.literal("CatalogQualificationSelection"),
    fixtureHash: HASH_SCHEMA,
    modelSelectionReportHash: HASH_SCHEMA,
    modelSelectionEvidenceHash: HASH_SCHEMA,
    searchPolicyHash: HASH_SCHEMA,
    qualificationPolicyHash: HASH_SCHEMA,
    candidateDecisionPolicyHash: HASH_SCHEMA,
    modelDeclarationsHash: HASH_SCHEMA,
    modelRolePolicyHash: HASH_SCHEMA,
    metadataPromptTemplateHash: HASH_SCHEMA,
    validationPromptTemplateHash: HASH_SCHEMA,
    metadataSchemaHash: HASH_SCHEMA,
    validationSchemaHash: HASH_SCHEMA,
    workerImplementationHash: HASH_SCHEMA,
    selectedWriterModelId: z.string().regex(/^[a-z][a-z0-9_]{2,127}$/u),
    selectedWriterModelCommitHash: z.string().regex(/^[a-f0-9]{40,64}$/u),
    selectedWriterViewSet: CATALOG_METADATA_VIEW_SET_SCHEMA,
    selectedValidatorModelId: z.string().regex(/^[a-z][a-z0-9_]{2,127}$/u),
    selectedValidatorModelCommitHash: z.string().regex(/^[a-f0-9]{40,64}$/u),
    selectionRule: z.literal(CATALOG_QUALIFICATION_SELECTION_RULE),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => verifyArtifactHash(value, context));
export type CatalogQualificationSelection = z.output<typeof CATALOG_QUALIFICATION_SELECTION_SCHEMA>;

const CHANNEL_METRICS_SCHEMA = z
  .object({
    writerModelId: z.string().regex(/^[a-z][a-z0-9_]{2,127}$/u),
    writerViewSet: CATALOG_METADATA_VIEW_SET_SCHEMA,
    channel: CATALOG_RETRIEVAL_CHANNEL_SCHEMA,
    coverageScenario: z.enum(["mixed", "uniform"]),
    relevantQueryCount: z.number().int().nonnegative(),
    relevantJudgmentCount: z.number().int().nonnegative(),
    hitAtFiveMillionths: z.number().int().min(0).max(1_000_000),
    pooledRecallAtFiveMillionths: z.number().int().min(0).max(1_000_000),
    meanReciprocalRankMillionths: z.number().int().min(0).max(1_000_000),
  })
  .strict();

const VALIDATOR_METRICS_SCHEMA = z
  .object({
    modelId: z.string().regex(/^[a-z][a-z0-9_]{2,127}$/u),
    caseCount: z.number().int().nonnegative(),
    exactVerdictMillionths: z.number().int().min(0).max(1_000_000),
    hardNegativeFalseMatchCount: z.number().int().nonnegative(),
    gpuMilliseconds: z.number().int().nonnegative(),
  })
  .strict();

const DECISION_METRICS_SCHEMA = z
  .object({
    writerModelId: z.string().regex(/^[a-z][a-z0-9_]{2,127}$/u),
    writerViewSet: CATALOG_METADATA_VIEW_SET_SCHEMA,
    validatorModelId: z.string().regex(/^[a-z][a-z0-9_]{2,127}$/u),
    caseCount: z.number().int().nonnegative(),
    matchCaseCount: z.number().int().nonnegative(),
    noMatchCaseCount: z.number().int().nonnegative(),
    evidenceInsufficientCaseCount: z.number().int().nonnegative(),
    exactOutcomeMillionths: z.number().int().min(0).max(1_000_000),
    noMatchFalseAcceptanceCount: z.number().int().nonnegative(),
    noMatchFalseAcceptanceMillionths: z.number().int().min(0).max(1_000_000),
    insufficientReportedAsNoMatchCount: z.number().int().nonnegative(),
    insufficientReportedAsNoMatchMillionths: z.number().int().min(0).max(1_000_000),
    gpuMilliseconds: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.matchCaseCount + value.noMatchCaseCount + value.evidenceInsufficientCaseCount !==
      value.caseCount
    )
      context.addIssue({
        code: "custom",
        path: ["caseCount"],
        message: "Decision outcome strata must sum to the total case count",
      });
  });

export const CATALOG_QUALIFICATION_REPORT_SCHEMA = z
  .object({
    kind: z.literal("CatalogQualificationReport"),
    status: COMPILATION_STATUS_SCHEMA,
    split: CATALOG_QUALIFICATION_SPLIT_SCHEMA,
    fixtureHash: HASH_SCHEMA,
    evidenceHash: HASH_SCHEMA,
    frozenSelectionHash: HASH_SCHEMA.optional(),
    searchPolicyHash: HASH_SCHEMA,
    qualificationPolicyHash: HASH_SCHEMA,
    candidateDecisionPolicyHash: HASH_SCHEMA,
    modelDeclarationsHash: HASH_SCHEMA,
    modelRolePolicyHash: HASH_SCHEMA,
    metadataPromptTemplateHash: HASH_SCHEMA,
    validationPromptTemplateHash: HASH_SCHEMA,
    metadataSchemaHash: HASH_SCHEMA,
    validationSchemaHash: HASH_SCHEMA,
    workerImplementationHash: HASH_SCHEMA,
    selectedWriterModelId: z.string().regex(/^[a-z][a-z0-9_]{2,127}$/u),
    selectedWriterModelCommitHash: z.string().regex(/^[a-f0-9]{40,64}$/u),
    selectedWriterViewSet: CATALOG_METADATA_VIEW_SET_SCHEMA,
    selectedValidatorModelId: z.string().regex(/^[a-z][a-z0-9_]{2,127}$/u),
    selectedValidatorModelCommitHash: z.string().regex(/^[a-f0-9]{40,64}$/u),
    candidatePopulations: z
      .object({ uniform: z.number().int().positive(), mixed: z.number().int().positive() })
      .strict(),
    channelMetrics: z.array(CHANNEL_METRICS_SCHEMA).min(1).max(1_024),
    validatorMetrics: z.array(VALIDATOR_METRICS_SCHEMA).min(1).max(32),
    decisionMetrics: z.array(DECISION_METRICS_SCHEMA).min(1).max(512),
    selectedGpuMilliseconds: z.number().int().nonnegative(),
    totalGpuMilliseconds: z.number().int().nonnegative(),
    gates: z
      .object({
        evidenceCoverage: z.boolean(),
        hybridRetrieval: z.boolean(),
        mixedEnrichmentCoverage: z.boolean(),
        noMatchSafety: z.boolean(),
        acceptanceDecisionSafety: z.boolean(),
        validatorSafety: z.boolean(),
        viewCountQualified: z.boolean(),
        rolesQualifiedIndependently: z.boolean(),
        frozenSelection: z.boolean(),
      })
      .strict(),
    diagnostics: z.array(z.string().trim().min(1).max(2_048)).max(256),
    compilerAuthority: z.literal(false),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyArtifactHash(value, context);
    requireCanonicalValues(
      value.channelMetrics,
      channelMetricIdentity,
      "qualification channel metrics",
      context,
    );
    requireCanonicalValues(
      value.validatorMetrics,
      (entry) => entry.modelId,
      "qualification validator metrics",
      context,
    );
    requireCanonicalValues(
      value.decisionMetrics,
      decisionMetricIdentity,
      "qualification decision metrics",
      context,
    );
    requireCanonicalValues(value.diagnostics, String, "qualification diagnostics", context);
    const expected = Object.values(value.gates).every(Boolean) ? "eligible" : "incomplete";
    if (value.status !== expected)
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "Qualification status does not match its gates",
      });
    if ((value.split === "holdout") !== (value.frozenSelectionHash !== undefined))
      context.addIssue({
        code: "custom",
        path: ["frozenSelectionHash"],
        message: "Only a holdout report binds a frozen selection",
      });
  });
export type CatalogQualificationReport = z.output<typeof CATALOG_QUALIFICATION_REPORT_SCHEMA>;

export interface CatalogQualificationArtifacts {
  readonly metadataRequestSets: readonly CatalogSearchMetadataRequestSet[];
  readonly metadataSets: readonly CatalogSearchMetadataSet[];
  readonly embeddingSets: readonly CatalogEmbeddingSet[];
  readonly embeddingMatrices: readonly CatalogEmbeddingMatrix[];
  readonly indexes: readonly CatalogSearchIndex[];
  readonly queryEmbeddingReceipts: readonly CatalogQueryEmbeddingReceipt[];
  readonly resultSets: readonly CatalogSearchResultSet[];
  readonly validationRequests: readonly CatalogSearchValidationRequest[];
  readonly validationReceipts: readonly CatalogValidationReceipt[];
  readonly decisions: readonly CatalogCandidateDecision[];
}

export function sealCatalogQualificationCandidatePool(
  input: Omit<CatalogQualificationCandidatePool, "kind" | "hash">,
): CatalogQualificationCandidatePool {
  return sealArtifact(CATALOG_QUALIFICATION_CANDIDATE_POOL_SCHEMA, {
    kind: "CatalogQualificationCandidatePool" as const,
    ...input,
    assets: canonicalValues(
      input.assets,
      (entry) => entry.sourceContentHash,
      "qualification candidate pool",
    ),
  });
}

export function sealCatalogQualificationFixture(
  input: Omit<CatalogQualificationFixture, "kind" | "hash">,
): CatalogQualificationFixture {
  return sealArtifact(CATALOG_QUALIFICATION_FIXTURE_SCHEMA, {
    kind: "CatalogQualificationFixture" as const,
    ...input,
    assets: canonicalValues(
      input.assets,
      (entry) => entry.sourceContentHash,
      "qualification assets",
    ),
    candidatePools: canonicalValues(
      input.candidatePools,
      candidatePoolIdentity,
      "qualification candidate pools",
    ),
    queries: canonicalValues(input.queries, (entry) => entry.queryId, "qualification queries"),
    validationCases: canonicalValues(
      input.validationCases,
      (entry) => entry.caseId,
      "qualification validation cases",
    ),
    writerConfigurations: canonicalValues(
      input.writerConfigurations,
      writerConfigurationIdentity,
      "qualification writer configurations",
    ),
    validatorConfigurations: canonicalValues(
      input.validatorConfigurations,
      (entry) => entry.modelId,
      "qualification validator configurations",
    ),
  });
}

export function sealCatalogQualificationReviewPacket(
  input: Omit<CatalogQualificationReviewPacket, "kind" | "proposalAuthority" | "hash">,
): CatalogQualificationReviewPacket {
  return sealArtifact(CATALOG_QUALIFICATION_REVIEW_PACKET_SCHEMA, {
    kind: "CatalogQualificationReviewPacket" as const,
    ...input,
    proposalAuthority: "none" as const,
    pages: canonicalValues(
      input.pages,
      (entry) => `${entry.pageKind}:${entry.split}:${String(entry.pageNumber).padStart(4, "0")}`,
      "qualification review pages",
    ),
    visuals: canonicalValues(
      input.visuals,
      (entry) => entry.sourceContentHash,
      "qualification review visuals",
    ),
    assets: canonicalValues(
      input.assets,
      (entry) => entry.sourceContentHash,
      "qualification review assets",
    ),
    queries: canonicalValues(
      input.queries.map((entry) => ({
        ...entry,
        proposedJudgments: canonicalValues(
          entry.proposedJudgments,
          (judgment) => judgment.sourceContentHash,
          "proposed query judgments",
        ),
      })),
      (entry) => entry.queryId,
      "qualification review queries",
    ),
    validationCases: canonicalValues(
      input.validationCases,
      (entry) => entry.caseId,
      "qualification review validation cases",
    ),
  });
}

export function sealCatalogQualificationAdjudicationDecision(
  input: Omit<CatalogQualificationAdjudicationDecision, "kind" | "hash">,
): CatalogQualificationAdjudicationDecision {
  return sealArtifact(CATALOG_QUALIFICATION_ADJUDICATION_DECISION_SCHEMA, {
    kind: "CatalogQualificationAdjudicationDecision" as const,
    ...input,
    assets: canonicalValues(
      input.assets,
      (entry) => entry.sourceContentHash,
      "qualification adjudicated assets",
    ),
    queries: canonicalValues(
      input.queries.map((entry) => ({
        ...entry,
        judgments: canonicalValues(
          entry.judgments,
          (judgment) => judgment.sourceContentHash,
          "adjudicated query judgments",
        ),
      })),
      (entry) => entry.queryId,
      "qualification adjudicated queries",
    ),
    validationCases: canonicalValues(
      input.validationCases,
      (entry) => entry.caseId,
      "qualification adjudicated validation cases",
    ),
  });
}

/**
 * Applies a completed creator decision to the non-authoritative proposal. The
 * answer key cannot be finalized by editing status/provenance fields in place.
 */
export function sealCreatorReviewedCatalogQualificationFixture(input: {
  readonly proposal: CatalogQualificationFixture;
  readonly reviewPacket: CatalogQualificationReviewPacket;
  readonly decision: CatalogQualificationAdjudicationDecision;
}): CatalogQualificationFixture {
  const proposal = CATALOG_QUALIFICATION_FIXTURE_SCHEMA.parse(input.proposal);
  if (proposal.adjudication.status !== "pending_creator_review")
    throw new Error("Qualification adjudication must start from the pending proposal fixture");
  const reviewPacket = CATALOG_QUALIFICATION_REVIEW_PACKET_SCHEMA.parse(input.reviewPacket);
  const decision = CATALOG_QUALIFICATION_ADJUDICATION_DECISION_SCHEMA.parse(input.decision);
  validateQualificationReviewPacketAgainstProposal(proposal, reviewPacket);
  validateQualificationDecisionAgainstPacket(reviewPacket, decision);

  const assetsBySource = new Map(
    decision.assets.map((entry) => [entry.sourceContentHash, entry] as const),
  );
  const queriesById = new Map(decision.queries.map((entry) => [entry.queryId, entry] as const));
  const casesById = new Map(
    decision.validationCases.map((entry) => [entry.caseId, entry] as const),
  );
  const { kind: _kind, hash: _hash, ...material } = proposal;
  const finalized = sealCatalogQualificationFixture({
    ...material,
    adjudication: {
      status: "creator_reviewed",
      reviewerAuthority: "creator",
      reviewerId: decision.reviewer.reviewerId,
      reviewMethod: "independent_visual_review",
      proposalFixtureHash: proposal.hash,
      reviewPacketHash: reviewPacket.hash,
      decisionArtifactHash: decision.hash,
    },
    assets: proposal.assets.map((asset) => {
      if (asset.population !== "cohort") return asset;
      const adjudicated = assetsBySource.get(asset.sourceContentHash)!;
      return {
        ...asset,
        evidenceExpectation: adjudicated.evidenceExpectation,
        stratum: adjudicated.stratum,
        adjudicatedNouns: adjudicated.adjudicatedNouns,
        labelBasis: "independent_visual_review" as const,
        adjudicationEvidenceHashes: answerKeyEvidenceHashes(
          asset.adjudicationEvidenceHashes!,
          reviewPacket.hash,
          decision.hash,
        ),
      };
    }),
    queries: proposal.queries.map((query) => {
      const adjudicated = queriesById.get(query.queryId)!;
      return {
        ...query,
        expectation: adjudicated.expectation,
        judgmentBasis: "independent_visual_review" as const,
        judgments: adjudicated.judgments.map(({ reviewAction: _reviewAction, ...entry }) => entry),
        adjudicationEvidenceHashes: answerKeyEvidenceHashes(
          query.adjudicationEvidenceHashes,
          reviewPacket.hash,
          decision.hash,
        ),
      };
    }),
    validationCases: proposal.validationCases.map((validationCase) => {
      const adjudicated = casesById.get(validationCase.caseId)!;
      return {
        ...validationCase,
        expectedVerdict: adjudicated.expectedVerdict,
        verdictBasis: "independent_visual_review" as const,
        adjudicationEvidenceHashes: answerKeyEvidenceHashes(
          validationCase.adjudicationEvidenceHashes,
          reviewPacket.hash,
          decision.hash,
        ),
      };
    }),
  });
  requireCreatorReviewedQualificationFixture({
    fixture: finalized,
    proposal,
    reviewPacket,
    decision,
  });
  return finalized;
}

export function sealCatalogQualificationPolicy(
  input: Omit<CatalogQualificationPolicy, "kind" | "hash">,
): CatalogQualificationPolicy {
  return sealArtifact(CATALOG_QUALIFICATION_POLICY_SCHEMA, {
    kind: "CatalogQualificationPolicy" as const,
    ...input,
  });
}

export function sealCatalogQualificationEvidence(
  input: Omit<CatalogQualificationEvidence, "kind" | "compilerAuthority" | "hash">,
): CatalogQualificationEvidence {
  return sealArtifact(CATALOG_QUALIFICATION_EVIDENCE_SCHEMA, {
    kind: "CatalogQualificationEvidence" as const,
    ...input,
    metadataRuns: canonicalValues(
      input.metadataRuns,
      metadataRunIdentity,
      "qualification metadata runs",
    ),
    embeddingRuns: canonicalValues(
      input.embeddingRuns,
      (entry) => entry.coverageScenario,
      "qualification embedding runs",
    ),
    indexRuns: canonicalValues(input.indexRuns, indexRunIdentity, "qualification indexes"),
    retrievalRuns: canonicalValues(
      input.retrievalRuns,
      retrievalRunIdentity,
      "qualification retrieval runs",
    ),
    independentValidationRuns: canonicalValues(
      input.independentValidationRuns,
      independentValidationRunIdentity,
      "qualification independent validator runs",
    ),
    decisionRuns: canonicalValues(
      input.decisionRuns.map((entry) => ({
        ...entry,
        validations: canonicalValues(
          entry.validations,
          (validation) => validation.requestHash,
          "qualification decision validations",
        ),
      })),
      decisionRunIdentity,
      "qualification decisions",
    ),
    compilerAuthority: false as const,
  });
}

export function sealCatalogQualificationSelection(input: {
  readonly fixture: CatalogQualificationFixture;
  readonly report: CatalogQualificationReport;
  readonly evidence: CatalogQualificationEvidence;
}): CatalogQualificationSelection {
  const fixture = CATALOG_QUALIFICATION_FIXTURE_SCHEMA.parse(input.fixture);
  const report = CATALOG_QUALIFICATION_REPORT_SCHEMA.parse(input.report);
  const evidence = CATALOG_QUALIFICATION_EVIDENCE_SCHEMA.parse(input.evidence);
  if (
    report.status !== "eligible" ||
    report.split !== "model_selection" ||
    evidence.split !== "model_selection" ||
    report.fixtureHash !== fixture.hash ||
    report.evidenceHash !== evidence.hash
  )
    throw new Error("Only an eligible model-selection report can freeze holdout configuration");
  return sealArtifact(CATALOG_QUALIFICATION_SELECTION_SCHEMA, {
    kind: "CatalogQualificationSelection" as const,
    fixtureHash: fixture.hash,
    modelSelectionReportHash: report.hash,
    modelSelectionEvidenceHash: evidence.hash,
    searchPolicyHash: report.searchPolicyHash,
    qualificationPolicyHash: report.qualificationPolicyHash,
    candidateDecisionPolicyHash: report.candidateDecisionPolicyHash,
    modelDeclarationsHash: report.modelDeclarationsHash,
    modelRolePolicyHash: report.modelRolePolicyHash,
    metadataPromptTemplateHash: report.metadataPromptTemplateHash,
    validationPromptTemplateHash: report.validationPromptTemplateHash,
    metadataSchemaHash: report.metadataSchemaHash,
    validationSchemaHash: report.validationSchemaHash,
    workerImplementationHash: report.workerImplementationHash,
    selectedWriterModelId: report.selectedWriterModelId,
    selectedWriterModelCommitHash: report.selectedWriterModelCommitHash,
    selectedWriterViewSet: report.selectedWriterViewSet,
    selectedValidatorModelId: report.selectedValidatorModelId,
    selectedValidatorModelCommitHash: report.selectedValidatorModelCommitHash,
    selectionRule: fixture.selectionRule,
  });
}

export function evaluateCatalogQualification(input: {
  readonly split: CatalogQualificationSplit;
  readonly fixture: CatalogQualificationFixture;
  readonly proposalFixture: CatalogQualificationFixture;
  readonly reviewPacket: CatalogQualificationReviewPacket;
  readonly adjudicationDecision: CatalogQualificationAdjudicationDecision;
  readonly evidence: CatalogQualificationEvidence;
  readonly artifacts: CatalogQualificationArtifacts;
  readonly policy: CatalogQualificationPolicy;
  readonly frozenSelection?: CatalogQualificationSelection;
  readonly selectedWriterModelId?: string;
  readonly selectedWriterViewSet?: "cardinal_four" | "canonical_twelve";
  readonly selectedValidatorModelId?: string;
}): CatalogQualificationReport {
  const fixture = CATALOG_QUALIFICATION_FIXTURE_SCHEMA.parse(input.fixture);
  requireCreatorReviewedQualificationFixture({
    fixture,
    proposal: input.proposalFixture,
    reviewPacket: input.reviewPacket,
    decision: input.adjudicationDecision,
  });
  const evidence = CATALOG_QUALIFICATION_EVIDENCE_SCHEMA.parse(input.evidence);
  const policy = CATALOG_QUALIFICATION_POLICY_SCHEMA.parse(input.policy);
  const selection = input.frozenSelection
    ? CATALOG_QUALIFICATION_SELECTION_SCHEMA.parse(input.frozenSelection)
    : undefined;
  validateCatalogQualificationLineage({
    split: input.split,
    fixture,
    evidence,
    policy,
    selection,
  });
  const verified = verifyCatalogQualificationArtifacts({
    fixture,
    evidence,
    artifacts: input.artifacts,
  });
  const queries = fixture.queries.filter((entry) => entry.split === input.split);
  const validationCases = fixture.validationCases.filter((entry) => entry.split === input.split);
  const requiredWriters = selection
    ? [
        requireWriterConfiguration(
          fixture,
          selection.selectedWriterModelId,
          selection.selectedWriterViewSet,
        ),
      ]
    : fixture.writerConfigurations;
  const requiredValidators = selection
    ? [requireValidatorConfiguration(fixture, selection.selectedValidatorModelId)]
    : fixture.validatorConfigurations;
  const exactCoverage = catalogQualificationEvidenceHasExactCoverage({
    evidence,
    queries,
    validationCases,
    writers: requiredWriters,
    validators: requiredValidators,
  });
  const channelMetrics = calculateChannelMetrics(fixture, evidence, verified.resultSets);
  const validatorMetrics = calculateValidatorMetrics(
    fixture,
    evidence,
    verified.validationReceipts,
  );
  const decisionMetrics = calculateDecisionMetrics(
    fixture,
    evidence,
    verified.decisions,
    verified.validationReceipts,
  );
  const choice = selectConfiguration({
    fixture,
    policy,
    evidence,
    metadataSets: verified.metadataSets,
    channelMetrics,
    validatorMetrics,
    decisionMetrics,
    selection,
    selectedWriterModelId: input.selectedWriterModelId,
    selectedWriterViewSet: input.selectedWriterViewSet,
    selectedValidatorModelId: input.selectedValidatorModelId,
  });
  const uniformHybrid = channelMetrics.find(
    (entry) =>
      entry.writerModelId === choice.writer.modelId &&
      entry.writerViewSet === choice.writer.viewSet &&
      entry.channel === "hybrid" &&
      entry.coverageScenario === "uniform",
  );
  const mixedHybrid = channelMetrics.find(
    (entry) =>
      entry.writerModelId === choice.writer.modelId &&
      entry.writerViewSet === choice.writer.viewSet &&
      entry.channel === "hybrid" &&
      entry.coverageScenario === "mixed",
  );
  const validator = validatorMetrics.find((entry) => entry.modelId === choice.validator.modelId);
  const decisions = decisionMetrics.find(
    (entry) =>
      entry.writerModelId === choice.writer.modelId &&
      entry.writerViewSet === choice.writer.viewSet &&
      entry.validatorModelId === choice.validator.modelId,
  );
  const gates = {
    evidenceCoverage: exactCoverage,
    hybridRetrieval:
      (uniformHybrid?.hitAtFiveMillionths ?? 0) >= policy.minimumUniformHitAtFiveMillionths &&
      (uniformHybrid?.meanReciprocalRankMillionths ?? 0) >=
        policy.minimumUniformMeanReciprocalRankMillionths,
    mixedEnrichmentCoverage:
      (mixedHybrid?.hitAtFiveMillionths ?? 0) >= policy.minimumMixedHitAtFiveMillionths &&
      (mixedHybrid?.meanReciprocalRankMillionths ?? 0) >=
        policy.minimumMixedMeanReciprocalRankMillionths,
    noMatchSafety:
      (decisions?.noMatchFalseAcceptanceCount ?? Number.MAX_SAFE_INTEGER) <=
      policy.maximumNoMatchFalseAcceptances,
    acceptanceDecisionSafety:
      (decisions?.exactOutcomeMillionths ?? 0) >= policy.minimumDecisionAccuracyMillionths &&
      (decisions?.insufficientReportedAsNoMatchCount ?? Number.MAX_SAFE_INTEGER) <=
        policy.maximumInsufficientReportedAsNoMatch,
    validatorSafety:
      (validator?.exactVerdictMillionths ?? 0) >= policy.minimumValidatorAccuracyMillionths &&
      (validator?.hardNegativeFalseMatchCount ?? Number.MAX_SAFE_INTEGER) <=
        policy.maximumHardNegativeFalseMatches,
    viewCountQualified:
      input.split === "holdout"
        ? selection !== undefined
        : requiredWriters.some((entry) => entry.viewSet === "cardinal_four") &&
          requiredWriters.some((entry) => entry.viewSet === "canonical_twelve"),
    rolesQualifiedIndependently:
      policy.requireIndependentWriterAndValidatorRuns &&
      evidence.metadataRuns.length > 0 &&
      evidence.independentValidationRuns.length > 0,
    frozenSelection: input.split === "holdout" ? selection !== undefined : true,
  };
  const diagnostics = canonicalValues(
    Object.entries(gates)
      .filter(([, passed]) => !passed)
      .map(([name]) => `Qualification gate failed: ${name}`),
    String,
    "qualification diagnostics",
  );
  const uniformPool = candidatePoolFor(fixture, input.split, "uniform");
  const mixedPool = candidatePoolFor(fixture, input.split, "mixed");
  const selectedGpuMilliseconds =
    metadataGpuMilliseconds(evidence, verified.metadataSets, choice.writer) +
    (validator?.gpuMilliseconds ?? 0) +
    (decisions?.gpuMilliseconds ?? 0) +
    sharedEmbeddingGpuMilliseconds(input.artifacts);
  return sealArtifact(CATALOG_QUALIFICATION_REPORT_SCHEMA, {
    kind: "CatalogQualificationReport" as const,
    status: diagnostics.length === 0 ? ("eligible" as const) : ("incomplete" as const),
    split: input.split,
    fixtureHash: fixture.hash,
    evidenceHash: evidence.hash,
    ...(selection ? { frozenSelectionHash: selection.hash } : {}),
    searchPolicyHash: fixture.searchPolicyHash,
    qualificationPolicyHash: policy.hash,
    candidateDecisionPolicyHash: fixture.candidateDecisionPolicyHash,
    modelDeclarationsHash: fixture.modelDeclarationsHash,
    modelRolePolicyHash: fixture.modelRolePolicyHash,
    metadataPromptTemplateHash: fixture.metadataPromptTemplateHash,
    validationPromptTemplateHash: fixture.validationPromptTemplateHash,
    metadataSchemaHash: fixture.metadataSchemaHash,
    validationSchemaHash: fixture.validationSchemaHash,
    workerImplementationHash: evidence.workerImplementationHash,
    selectedWriterModelId: choice.writer.modelId,
    selectedWriterModelCommitHash: choice.writer.modelCommitHash,
    selectedWriterViewSet: choice.writer.viewSet,
    selectedValidatorModelId: choice.validator.modelId,
    selectedValidatorModelCommitHash: choice.validator.modelCommitHash,
    candidatePopulations: { uniform: uniformPool.assets.length, mixed: mixedPool.assets.length },
    channelMetrics: canonicalValues(
      channelMetrics,
      channelMetricIdentity,
      "qualification channel metrics",
    ),
    validatorMetrics: canonicalValues(
      validatorMetrics,
      (entry) => entry.modelId,
      "qualification validator metrics",
    ),
    decisionMetrics: canonicalValues(
      decisionMetrics,
      decisionMetricIdentity,
      "qualification decision metrics",
    ),
    selectedGpuMilliseconds,
    totalGpuMilliseconds: uniqueReceiptGpuMilliseconds(input.artifacts),
    gates,
    diagnostics,
    compilerAuthority: false as const,
  });
}

export function qualificationAuthorizesCorpus(
  reportInput: CatalogQualificationReport,
  selectionInput: CatalogQualificationSelection,
  fixtureInput: CatalogQualificationFixture,
  proposalFixtureInput: CatalogQualificationFixture,
  reviewPacketInput: CatalogQualificationReviewPacket,
  decisionInput: CatalogQualificationAdjudicationDecision,
): boolean {
  const report = CATALOG_QUALIFICATION_REPORT_SCHEMA.parse(reportInput);
  if (report.status !== "eligible" || report.split !== "holdout" || !report.frozenSelectionHash)
    return false;
  const selection = CATALOG_QUALIFICATION_SELECTION_SCHEMA.parse(selectionInput);
  const fixture = CATALOG_QUALIFICATION_FIXTURE_SCHEMA.parse(fixtureInput);
  requireCreatorReviewedQualificationFixture({
    fixture,
    proposal: proposalFixtureInput,
    reviewPacket: reviewPacketInput,
    decision: decisionInput,
  });
  return (
    report.frozenSelectionHash === selection.hash &&
    report.fixtureHash === fixture.hash &&
    report.fixtureHash === selection.fixtureHash &&
    report.selectedWriterModelId === selection.selectedWriterModelId &&
    report.selectedWriterModelCommitHash === selection.selectedWriterModelCommitHash &&
    report.selectedWriterViewSet === selection.selectedWriterViewSet &&
    report.selectedValidatorModelId === selection.selectedValidatorModelId &&
    report.selectedValidatorModelCommitHash === selection.selectedValidatorModelCommitHash
  );
}

export function validateProductionCatalogQualificationFixture(
  fixtureInput: CatalogQualificationFixture,
): void {
  const fixture = CATALOG_QUALIFICATION_FIXTURE_SCHEMA.parse(fixtureInput);
  for (const split of CATALOG_QUALIFICATION_SPLITS) {
    const cohort = fixture.assets.filter(
      (entry) => entry.split === split && entry.population === "cohort",
    );
    const queries = fixture.queries.filter((entry) => entry.split === split);
    const cases = fixture.validationCases.filter((entry) => entry.split === split);
    if (cohort.length !== 64 || queries.length !== 48 || cases.length !== 48)
      throw new Error(
        `Qualification ${split} requires exactly 64 cohort assets, 48 queries, and 48 validator cases`,
      );
    for (const expectation of ["match", "no_match", "evidence_insufficient"] as const)
      if (!queries.some((entry) => entry.expectation === expectation))
        throw new Error(`Qualification ${split} lacks ${expectation} queries`);
  }
}

export function requireCreatorReviewedQualificationFixture(input: {
  readonly fixture: CatalogQualificationFixture;
  readonly proposal: CatalogQualificationFixture;
  readonly reviewPacket: CatalogQualificationReviewPacket;
  readonly decision: CatalogQualificationAdjudicationDecision;
}): void {
  const fixture = CATALOG_QUALIFICATION_FIXTURE_SCHEMA.parse(input.fixture);
  if (fixture.adjudication.status !== "creator_reviewed")
    throw new Error(
      "Qualification fixture remains pending creator review and cannot authorize model execution",
    );
  const reviewPacket = CATALOG_QUALIFICATION_REVIEW_PACKET_SCHEMA.parse(input.reviewPacket);
  const decision = CATALOG_QUALIFICATION_ADJUDICATION_DECISION_SCHEMA.parse(input.decision);
  const proposal = CATALOG_QUALIFICATION_FIXTURE_SCHEMA.parse(input.proposal);
  validateQualificationReviewPacketAgainstProposal(proposal, reviewPacket);
  const adjudication = fixture.adjudication;
  if (
    adjudication.proposalFixtureHash !== reviewPacket.proposalFixtureHash ||
    adjudication.proposalFixtureHash !== decision.proposalFixtureHash ||
    adjudication.reviewPacketHash !== reviewPacket.hash ||
    adjudication.reviewPacketHash !== decision.reviewPacketHash ||
    adjudication.decisionArtifactHash !== decision.hash ||
    adjudication.reviewerId !== decision.reviewer.reviewerId
  )
    throw new Error("Qualification fixture does not bind the exact creator review artifacts");
  validateQualificationDecisionAgainstPacket(reviewPacket, decision);
  validateQualificationReviewScopeAgainstFixture(fixture, reviewPacket, false);

  const decisionAssets = new Map(
    decision.assets.map((entry) => [entry.sourceContentHash, entry] as const),
  );
  const decisionQueries = new Map(decision.queries.map((entry) => [entry.queryId, entry] as const));
  const decisionCases = new Map(
    decision.validationCases.map((entry) => [entry.caseId, entry] as const),
  );
  for (const asset of fixture.assets.filter((entry) => entry.population === "cohort")) {
    const adjudicatedAsset = decisionAssets.get(asset.sourceContentHash);
    if (
      !adjudicatedAsset ||
      asset.labelBasis !== "independent_visual_review" ||
      asset.evidenceExpectation !== adjudicatedAsset.evidenceExpectation ||
      asset.stratum !== adjudicatedAsset.stratum ||
      stableJson(asset.adjudicatedNouns) !== stableJson(adjudicatedAsset.adjudicatedNouns) ||
      !asset.adjudicationEvidenceHashes?.includes(reviewPacket.hash) ||
      !asset.adjudicationEvidenceHashes.includes(decision.hash)
    )
      throw new Error(
        `Qualification asset answer key does not match creator decision: ${asset.sourceContentHash}`,
      );
  }
  for (const query of fixture.queries) {
    const adjudicatedQuery = decisionQueries.get(query.queryId);
    const decidedJudgments = adjudicatedQuery?.judgments.map(
      ({ reviewAction: _reviewAction, ...entry }) => entry,
    );
    if (
      !adjudicatedQuery ||
      query.judgmentBasis !== "independent_visual_review" ||
      query.expectation !== adjudicatedQuery.expectation ||
      stableJson(query.judgments) !== stableJson(decidedJudgments) ||
      !query.adjudicationEvidenceHashes.includes(reviewPacket.hash) ||
      !query.adjudicationEvidenceHashes.includes(decision.hash)
    )
      throw new Error(
        `Qualification query answer key does not match creator decision: ${query.queryId}`,
      );
  }
  for (const validationCase of fixture.validationCases) {
    const adjudicatedCase = decisionCases.get(validationCase.caseId);
    if (
      !adjudicatedCase ||
      validationCase.verdictBasis !== "independent_visual_review" ||
      validationCase.expectedVerdict !== adjudicatedCase.expectedVerdict ||
      !validationCase.adjudicationEvidenceHashes.includes(reviewPacket.hash) ||
      !validationCase.adjudicationEvidenceHashes.includes(decision.hash)
    )
      throw new Error(
        `Qualification validator answer key does not match creator decision: ${validationCase.caseId}`,
      );
  }
}

function validateQualificationReviewPacketAgainstProposal(
  proposal: CatalogQualificationFixture,
  reviewPacket: CatalogQualificationReviewPacket,
): void {
  if (proposal.adjudication.status !== "pending_creator_review")
    throw new Error("Qualification review packet requires the pending proposal fixture");
  if (
    reviewPacket.proposalFixtureHash !== proposal.hash ||
    reviewPacket.visualReviewIndexHash !== proposal.visualReviewIndexHash
  )
    throw new Error("Qualification review packet binds another proposal or visual review index");
  validateQualificationReviewScopeAgainstFixture(proposal, reviewPacket, true);
}

function validateQualificationReviewScopeAgainstFixture(
  fixture: CatalogQualificationFixture,
  reviewPacket: CatalogQualificationReviewPacket,
  compareProposals: boolean,
): void {
  const cohort = fixture.assets.filter((entry) => entry.population === "cohort");
  requireExactJson(
    "qualification review asset coverage",
    reviewPacket.assets.map((entry) => entry.sourceContentHash),
    cohort.map((entry) => entry.sourceContentHash),
  );
  requireExactJson(
    "qualification review query coverage",
    reviewPacket.queries.map((entry) => entry.queryId),
    fixture.queries.map((entry) => entry.queryId),
  );
  requireExactJson(
    "qualification review validator coverage",
    reviewPacket.validationCases.map((entry) => entry.caseId),
    fixture.validationCases.map((entry) => entry.caseId),
  );
  const visuals = new Map(
    reviewPacket.visuals.map((entry) => [entry.sourceContentHash, entry] as const),
  );
  requireExactJson(
    "qualification review visual coverage",
    reviewPacket.visuals.map((entry) => entry.sourceContentHash),
    cohort.map((entry) => entry.sourceContentHash),
  );
  const assets = new Map(cohort.map((entry) => [entry.sourceContentHash, entry] as const));
  for (const reviewAsset of reviewPacket.assets) {
    const asset = assets.get(reviewAsset.sourceContentHash)!;
    if (
      reviewAsset.split !== asset.split ||
      !asset.adjudicationEvidenceHashes?.includes(
        visuals.get(reviewAsset.sourceContentHash)!.renderEvidenceHash,
      )
    )
      throw new Error(
        `Qualification asset review evidence is stale: ${reviewAsset.sourceContentHash}`,
      );
    if (
      compareProposals &&
      (reviewAsset.proposedEvidenceExpectation !== asset.evidenceExpectation ||
        reviewAsset.proposedStratum !== asset.stratum ||
        stableJson(reviewAsset.proposedNouns) !== stableJson(asset.adjudicatedNouns))
    )
      throw new Error(
        `Qualification asset review proposal is stale: ${reviewAsset.sourceContentHash}`,
      );
  }
  const reviewQueries = new Map(
    reviewPacket.queries.map((entry) => [entry.queryId, entry] as const),
  );
  for (const query of fixture.queries) {
    const reviewQuery = reviewQueries.get(query.queryId)!;
    if (
      reviewQuery.split !== query.split ||
      reviewQuery.queryHash !== query.query.hash ||
      stableJson(reviewQuery.proposedJudgments.map((entry) => entry.sourceContentHash)) !==
        stableJson(query.judgments.map((entry) => entry.sourceContentHash)) ||
      query.judgments.some((entry) => !visuals.has(entry.sourceContentHash))
    )
      throw new Error(`Qualification query review input is stale: ${query.queryId}`);
    if (
      compareProposals &&
      (reviewQuery.proposedExpectation !== query.expectation ||
        stableJson(reviewQuery.proposedJudgments) !== stableJson(query.judgments))
    )
      throw new Error(`Qualification query review proposal is stale: ${query.queryId}`);
  }
  const reviewCases = new Map(
    reviewPacket.validationCases.map((entry) => [entry.caseId, entry] as const),
  );
  for (const validationCase of fixture.validationCases) {
    const reviewCase = reviewCases.get(validationCase.caseId)!;
    if (
      reviewCase.split !== validationCase.split ||
      reviewCase.requestHash !== validationCase.request.hash ||
      reviewCase.candidateSourceContentHash !==
        validationCase.request.candidate.sourceContentHash ||
      !visuals.has(reviewCase.candidateSourceContentHash)
    )
      throw new Error(`Qualification validator review input is stale: ${validationCase.caseId}`);
    if (compareProposals && reviewCase.proposedVerdict !== validationCase.expectedVerdict)
      throw new Error(`Qualification validator review proposal is stale: ${validationCase.caseId}`);
  }
}

function validateQualificationDecisionAgainstPacket(
  reviewPacket: CatalogQualificationReviewPacket,
  decision: CatalogQualificationAdjudicationDecision,
): void {
  if (
    decision.proposalFixtureHash !== reviewPacket.proposalFixtureHash ||
    decision.reviewPacketHash !== reviewPacket.hash
  )
    throw new Error("Creator adjudication decision binds another review packet or proposal");
  requireExactJson(
    "creator decision asset coverage",
    decision.assets.map((entry) => entry.sourceContentHash),
    reviewPacket.assets.map((entry) => entry.sourceContentHash),
  );
  requireExactJson(
    "creator decision query coverage",
    decision.queries.map((entry) => entry.queryId),
    reviewPacket.queries.map((entry) => entry.queryId),
  );
  requireExactJson(
    "creator decision validator coverage",
    decision.validationCases.map((entry) => entry.caseId),
    reviewPacket.validationCases.map((entry) => entry.caseId),
  );
  const assets = new Map(
    reviewPacket.assets.map((entry) => [entry.sourceContentHash, entry] as const),
  );
  for (const decidedAsset of decision.assets) {
    const proposed = assets.get(decidedAsset.sourceContentHash)!;
    const changed =
      decidedAsset.evidenceExpectation !== proposed.proposedEvidenceExpectation ||
      decidedAsset.stratum !== proposed.proposedStratum ||
      stableJson(decidedAsset.adjudicatedNouns) !== stableJson(proposed.proposedNouns);
    requireReviewAction(decidedAsset.reviewAction, changed, decidedAsset.sourceContentHash);
  }
  const queries = new Map(reviewPacket.queries.map((entry) => [entry.queryId, entry] as const));
  for (const decidedQuery of decision.queries) {
    const proposed = queries.get(decidedQuery.queryId)!;
    requireReviewAction(
      decidedQuery.expectationReviewAction,
      decidedQuery.expectation !== proposed.proposedExpectation,
      `${decidedQuery.queryId} expectation`,
    );
    requireExactJson(
      `${decidedQuery.queryId} relevance coverage`,
      decidedQuery.judgments.map((entry) => entry.sourceContentHash),
      proposed.proposedJudgments.map((entry) => entry.sourceContentHash),
    );
    const proposedJudgments = new Map(
      proposed.proposedJudgments.map((entry) => [entry.sourceContentHash, entry] as const),
    );
    for (const judgment of decidedQuery.judgments)
      requireReviewAction(
        judgment.reviewAction,
        judgment.relevance !== proposedJudgments.get(judgment.sourceContentHash)!.relevance,
        `${decidedQuery.queryId}:${judgment.sourceContentHash}`,
      );
  }
  const validationCases = new Map(
    reviewPacket.validationCases.map((entry) => [entry.caseId, entry] as const),
  );
  for (const decidedCase of decision.validationCases) {
    const proposed = validationCases.get(decidedCase.caseId)!;
    requireReviewAction(
      decidedCase.reviewAction,
      decidedCase.expectedVerdict !== proposed.proposedVerdict,
      decidedCase.caseId,
    );
  }
}

function requireReviewAction(
  action: "confirmed" | "revised",
  changed: boolean,
  subject: string,
): void {
  if ((action === "revised") !== changed)
    throw new Error(`Creator review action does not match the adjudicated value: ${subject}`);
}

function requireExactJson(label: string, actual: unknown, expected: unknown): void {
  if (stableJson(actual) !== stableJson(expected)) throw new Error(`${label} must be exact`);
}

function answerKeyEvidenceHashes(
  current: readonly string[],
  reviewPacketHash: string,
  decisionHash: string,
): string[] {
  return canonicalValues(
    [...new Set([...current, reviewPacketHash, decisionHash])],
    String,
    "qualification answer-key evidence hashes",
  );
}

export function validateCatalogQualificationLineage(input: {
  readonly split: CatalogQualificationSplit;
  readonly fixture: CatalogQualificationFixture;
  readonly evidence: CatalogQualificationEvidence;
  readonly policy: CatalogQualificationPolicy;
  readonly selection: CatalogQualificationSelection | undefined;
}): void {
  const { split, fixture, evidence, policy, selection } = input;
  if (evidence.split !== split) throw new Error("Qualification evidence belongs to another split");
  if (evidence.fixtureHash !== fixture.hash)
    throw new Error("Qualification evidence binds another fixture");
  if (fixture.qualificationPolicyHash !== policy.hash)
    throw new Error("Qualification fixture binds another frozen qualification policy");
  for (const [name, actual, expected] of [
    ["search policy", evidence.searchPolicyHash, fixture.searchPolicyHash],
    ["qualification policy", evidence.qualificationPolicyHash, fixture.qualificationPolicyHash],
    [
      "candidate-decision policy",
      evidence.candidateDecisionPolicyHash,
      fixture.candidateDecisionPolicyHash,
    ],
    ["model declarations", evidence.modelDeclarationsHash, fixture.modelDeclarationsHash],
    ["model-role policy", evidence.modelRolePolicyHash, fixture.modelRolePolicyHash],
    ["metadata prompt", evidence.metadataPromptTemplateHash, fixture.metadataPromptTemplateHash],
    [
      "validation prompt",
      evidence.validationPromptTemplateHash,
      fixture.validationPromptTemplateHash,
    ],
    ["metadata schema", evidence.metadataSchemaHash, fixture.metadataSchemaHash],
    ["validation schema", evidence.validationSchemaHash, fixture.validationSchemaHash],
  ] as const)
    if (actual !== expected) throw new Error(`Qualification evidence binds stale ${name}`);
  if (split === "holdout") {
    if (!selection || evidence.frozenSelectionHash !== selection.hash)
      throw new Error("Holdout evidence requires the exact frozen model-selection artifact");
    for (const [name, actual, expected] of [
      ["fixture", selection.fixtureHash, fixture.hash],
      ["search policy", selection.searchPolicyHash, fixture.searchPolicyHash],
      ["qualification policy", selection.qualificationPolicyHash, fixture.qualificationPolicyHash],
      [
        "candidate-decision policy",
        selection.candidateDecisionPolicyHash,
        fixture.candidateDecisionPolicyHash,
      ],
      ["model declarations", selection.modelDeclarationsHash, fixture.modelDeclarationsHash],
      ["model-role policy", selection.modelRolePolicyHash, fixture.modelRolePolicyHash],
      ["metadata prompt", selection.metadataPromptTemplateHash, fixture.metadataPromptTemplateHash],
      [
        "validation prompt",
        selection.validationPromptTemplateHash,
        fixture.validationPromptTemplateHash,
      ],
      ["metadata schema", selection.metadataSchemaHash, fixture.metadataSchemaHash],
      ["validation schema", selection.validationSchemaHash, fixture.validationSchemaHash],
      [
        "worker implementation",
        selection.workerImplementationHash,
        evidence.workerImplementationHash,
      ],
    ] as const)
      if (actual !== expected) throw new Error(`Frozen selection binds stale ${name}`);
  } else if (selection || evidence.frozenSelectionHash) {
    throw new Error("Development and model-selection runs cannot consume a frozen selection");
  }
}

export function verifyCatalogQualificationArtifacts(input: {
  readonly fixture: CatalogQualificationFixture;
  readonly evidence: CatalogQualificationEvidence;
  readonly artifacts: CatalogQualificationArtifacts;
}) {
  const { fixture, evidence } = input;
  const requestSets = artifactMap(
    input.artifacts.metadataRequestSets,
    CATALOG_SEARCH_METADATA_REQUEST_SET_SCHEMA,
    "metadata request set",
  );
  const metadataSets = artifactMap(
    input.artifacts.metadataSets,
    CATALOG_SEARCH_METADATA_SET_SCHEMA,
    "metadata set",
  );
  const embeddingSets = artifactMap(
    input.artifacts.embeddingSets,
    CATALOG_EMBEDDING_SET_SCHEMA,
    "embedding set",
  );
  const embeddingMatrices = artifactMap(
    input.artifacts.embeddingMatrices,
    CATALOG_EMBEDDING_MATRIX_SCHEMA,
    "embedding matrix",
  );
  const indexes = artifactMap(input.artifacts.indexes, CATALOG_SEARCH_INDEX_SCHEMA, "search index");
  const queryEmbeddings = artifactMap(
    input.artifacts.queryEmbeddingReceipts,
    CATALOG_QUERY_EMBEDDING_RECEIPT_SCHEMA,
    "query embedding receipt",
  );
  const resultSets = artifactMap(
    input.artifacts.resultSets,
    CATALOG_SEARCH_RESULT_SET_SCHEMA,
    "search result set",
  );
  const validationRequests = artifactMap(
    input.artifacts.validationRequests,
    CATALOG_SEARCH_VALIDATION_REQUEST_SCHEMA,
    "validation request",
  );
  const validationReceipts = artifactMap(
    input.artifacts.validationReceipts,
    CATALOG_VALIDATION_RECEIPT_SCHEMA,
    "validation receipt",
  );
  const decisions = artifactMap(
    input.artifacts.decisions,
    CATALOG_CANDIDATE_DECISION_SCHEMA,
    "candidate decision",
  );
  const splitQueries = new Map(
    fixture.queries
      .filter((entry) => entry.split === evidence.split)
      .map((entry) => [entry.queryId, entry] as const),
  );
  const splitCases = new Map(
    fixture.validationCases
      .filter((entry) => entry.split === evidence.split)
      .map((entry) => [entry.caseId, entry] as const),
  );
  const writers = new Map(
    fixture.writerConfigurations.map(
      (entry) => [writerConfigurationIdentity(entry), entry] as const,
    ),
  );
  const validators = new Map(
    fixture.validatorConfigurations.map((entry) => [entry.modelId, entry] as const),
  );

  for (const run of evidence.metadataRuns) {
    const writer = writers.get(writerRunConfigurationIdentity(run));
    if (!writer || writer.modelCommitHash !== run.writerModelCommitHash)
      throw new Error(
        `Unknown metadata writer configuration ${writerRunConfigurationIdentity(run)}`,
      );
    const requestSet = requiredArtifact(requestSets, run.requestSetHash, "metadata request set");
    const set = requiredArtifact(metadataSets, run.metadataSetHash, "metadata set");
    if (set.requestSetHash !== requestSet.hash || set.status !== "eligible")
      throw new Error("Qualification metadata set does not bind one complete request set");
    if (
      requestSet.sourceManifestHash !== fixture.sourceManifestHash ||
      requestSet.measurementSetHash !== fixture.measurementSetHash ||
      requestSet.visualReviewIndexHash !== fixture.visualReviewIndexHash ||
      requestSet.promptTemplateHash !== fixture.metadataPromptTemplateHash
    )
      throw new Error("Qualification metadata request set has contradictory lineage");
    const requestByHash = new Map(requestSet.requests.map((entry) => [entry.hash, entry] as const));
    const expectedSources = expectedEnrichedSources(
      candidatePoolFor(fixture, evidence.split, run.coverageScenario),
      "metadata",
    );
    const actualSources: string[] = [];
    for (const receipt of set.receipts) {
      ASSET_SEARCH_METADATA_RECEIPT_SCHEMA.parse(receipt);
      const request = requestByHash.get(receipt.requestHash);
      if (
        !request ||
        !set.requestedHashes.includes(request.hash) ||
        request.viewSet !== run.writerViewSet ||
        request.evidenceMode !== "visual_and_name" ||
        request.promptTemplateHash !== fixture.metadataPromptTemplateHash ||
        receipt.status !== "eligible" ||
        receipt.modelId !== run.writerModelId ||
        receipt.modelCommitHash !== run.writerModelCommitHash ||
        receipt.sourceContentHash !== request.sourceContentHash
      )
        throw new Error("Qualification metadata receipt contradicts its writer run");
      actualSources.push(receipt.sourceContentHash);
    }
    if (
      !sameValues(actualSources, expectedSources) ||
      set.receipts.length !== set.requestedHashes.length
    )
      throw new Error("Qualification metadata run has a mismatched candidate universe");
  }

  for (const run of evidence.embeddingRuns) {
    const set = requiredArtifact(embeddingSets, run.embeddingSetHash, "embedding set");
    const matrix = requiredArtifact(embeddingMatrices, run.embeddingMatrixHash, "embedding matrix");
    if (
      set.status !== "eligible" ||
      set.sourceManifestHash !== fixture.sourceManifestHash ||
      set.visualReviewIndexHash !== fixture.visualReviewIndexHash ||
      matrix.purpose !== "image_text_retrieval" ||
      matrix.embeddingSetHash !== set.hash ||
      matrix.sourceManifestHash !== fixture.sourceManifestHash
    )
      throw new Error("Qualification embedding run has contradictory lineage");
    const expectedSources = expectedEnrichedSources(
      candidatePoolFor(fixture, evidence.split, run.coverageScenario),
      "image_text",
    );
    const receipts = set.receipts.filter((entry) => entry.purpose === "image_text_retrieval");
    if (
      receipts.some(
        (entry) => entry.modelId !== run.modelId || entry.modelCommitHash !== run.modelCommitHash,
      ) ||
      !sameValues(
        receipts.map((entry) => entry.sourceContentHash),
        expectedSources,
      ) ||
      !sameValues(
        matrix.rows.map((entry) => entry.sourceContentHash),
        expectedSources,
      )
    )
      throw new Error("Qualification embedding run has a mismatched candidate universe");
  }

  for (const run of evidence.indexRuns) {
    requireKnownWriter(writers, run.writerModelId, run.writerViewSet);
    const pool = candidatePoolFor(fixture, evidence.split, run.coverageScenario);
    if (pool.hash !== run.candidatePoolHash)
      throw new Error("Qualification index binds another candidate pool");
    const index = requiredArtifact(indexes, run.indexHash, "search index");
    const metadataRun = evidence.metadataRuns.find(
      (entry) =>
        entry.writerModelId === run.writerModelId &&
        entry.writerViewSet === run.writerViewSet &&
        entry.coverageScenario === run.coverageScenario,
    );
    const embeddingRun = evidence.embeddingRuns.find(
      (entry) => entry.coverageScenario === run.coverageScenario,
    );
    if (
      !metadataRun ||
      !embeddingRun ||
      index.sourceManifestHash !== fixture.sourceManifestHash ||
      index.measurementSetHash !== fixture.measurementSetHash ||
      index.visualReviewIndexHash !== fixture.visualReviewIndexHash ||
      index.searchPolicyHash !== fixture.searchPolicyHash ||
      index.metadataSetHash !== metadataRun.metadataSetHash ||
      index.imageTextEmbeddingMatrixHash !== embeddingRun.embeddingMatrixHash ||
      index.shapeEmbeddingMatrixHash !== undefined ||
      !sameValues(
        index.documents.map((entry) => entry.sourceContentHash),
        pool.assets.map((entry) => entry.sourceContentHash),
      )
    )
      throw new Error("Qualification index has contradictory lineage or candidate universe");
    const profileBySource = new Map(
      pool.assets.map((entry) => [entry.sourceContentHash, entry.enrichmentProfile] as const),
    );
    for (const document of index.documents) {
      const profile = profileBySource.get(document.sourceContentHash);
      if (
        !profile ||
        !document.renderEvidenceHash ||
        (document.metadataEvidence !== undefined) !== profileHasMetadata(profile) ||
        (document.imageTextEmbeddingRow !== undefined) !== profileHasImageText(profile)
      )
        throw new Error("Qualification index enrichment mask differs from the frozen pool");
    }
  }

  for (const run of evidence.retrievalRuns) {
    const fixtureQuery = splitQueries.get(run.queryId);
    if (!fixtureQuery) throw new Error(`Unknown qualification query ${run.queryId}`);
    const indexRun = evidence.indexRuns.find(
      (entry) =>
        entry.writerModelId === run.writerModelId &&
        entry.writerViewSet === run.writerViewSet &&
        entry.coverageScenario === run.coverageScenario,
    );
    const result = requiredArtifact(resultSets, run.resultSetHash, "search result set");
    const expectedQuery = qualificationSearchQuery(fixtureQuery.query, run.channel, 0);
    if (
      !indexRun ||
      result.indexHash !== indexRun.indexHash ||
      result.query.hash !== run.queryHash ||
      run.queryHash !== expectedQuery.hash ||
      stableJson(result.query) !== stableJson(expectedQuery) ||
      result.queryEmbeddingReceiptHash !== run.queryEmbeddingReceiptHash
    )
      throw new Error("Qualification retrieval result has contradictory query or index lineage");
    const needsEmbedding = run.channel === "hybrid" || run.channel === "image_text_only";
    if (needsEmbedding) {
      const receipt = requiredArtifact(
        queryEmbeddings,
        run.queryEmbeddingReceiptHash,
        "query embedding receipt",
      );
      const embeddingRun = evidence.embeddingRuns.find(
        (entry) => entry.coverageScenario === run.coverageScenario,
      );
      const matrix = embeddingRun
        ? requiredArtifact(embeddingMatrices, embeddingRun.embeddingMatrixHash, "embedding matrix")
        : undefined;
      if (
        receipt.queryHash !== expectedQuery.hash ||
        !matrix ||
        receipt.modelImplementationHash !== matrix.modelImplementationHash
      )
        throw new Error("Qualification query embedding does not bind the indexed model");
    } else if (run.queryEmbeddingReceiptHash) {
      throw new Error("Lexical qualification ablations cannot claim query embedding evidence");
    }
  }

  for (const run of evidence.independentValidationRuns) {
    const fixtureCase = splitCases.get(run.caseId);
    const validator = validators.get(run.validatorModelId);
    if (!fixtureCase) throw new Error(`Unknown qualification validation case ${run.caseId}`);
    if (!validator || validator.modelCommitHash !== run.validatorModelCommitHash)
      throw new Error(`Unknown validator configuration ${run.validatorModelId}`);
    const request = requiredArtifact(validationRequests, run.requestHash, "validation request");
    const receipt = requiredArtifact(validationReceipts, run.receiptHash, "validation receipt");
    if (
      request.hash !== fixtureCase.request.hash ||
      stableJson(request) !== stableJson(fixtureCase.request) ||
      receipt.status !== "eligible" ||
      receipt.requestHash !== request.hash ||
      receipt.modelId !== run.validatorModelId ||
      receipt.modelCommitHash !== run.validatorModelCommitHash
    )
      throw new Error("Qualification validator receipt contradicts its executable case");
  }

  for (const run of evidence.decisionRuns) {
    const fixtureQuery = splitQueries.get(run.queryId);
    if (!fixtureQuery) throw new Error(`Unknown qualification decision query ${run.queryId}`);
    requireKnownWriter(writers, run.writerModelId, run.writerViewSet);
    const validator = validators.get(run.validatorModelId);
    if (!validator)
      throw new Error(`Unknown qualification decision validator ${run.validatorModelId}`);
    const indexRun = evidence.indexRuns.find(
      (entry) =>
        entry.writerModelId === run.writerModelId &&
        entry.writerViewSet === run.writerViewSet &&
        entry.coverageScenario === "mixed",
    );
    const result = requiredArtifact(resultSets, run.resultSetHash, "decision result set");
    const expectedQuery = qualificationSearchQuery(
      fixtureQuery.query,
      "hybrid",
      fixtureQuery.query.validationLimit,
    );
    const decision = requiredArtifact(decisions, run.decisionHash, "candidate decision");
    if (
      !indexRun ||
      result.indexHash !== indexRun.indexHash ||
      stableJson(result.query) !== stableJson(expectedQuery) ||
      decision.resultSetHash !== result.hash ||
      decision.queryHash !== expectedQuery.hash ||
      decision.policyHash !== fixture.candidateDecisionPolicyHash
    )
      throw new Error("Qualification decision has contradictory query, index, or policy lineage");
    const resultReceiptHashes = result.results
      .flatMap((entry) => (entry.validationReceiptHash ? [entry.validationReceiptHash] : []))
      .sort(compareCanonicalStrings);
    if (
      !sameValues(
        resultReceiptHashes,
        run.validations.map((entry) => entry.receiptHash),
      )
    )
      throw new Error("Qualification decision does not bind its exact validation receipts");
    for (const validation of run.validations) {
      const request = requiredArtifact(
        validationRequests,
        validation.requestHash,
        "decision validation request",
      );
      const receipt = requiredArtifact(
        validationReceipts,
        validation.receiptHash,
        "decision validation receipt",
      );
      if (
        request.query.hash !== expectedQuery.hash ||
        receipt.requestHash !== request.hash ||
        receipt.status !== "eligible" ||
        receipt.modelId !== run.validatorModelId ||
        receipt.modelCommitHash !== validator.modelCommitHash ||
        receipt.sourceContentHash !== request.candidate.sourceContentHash
      )
        throw new Error("Qualification decision references a mismatched validator receipt");
    }
  }
  return { metadataSets, resultSets, validationReceipts, decisions };
}

export function catalogQualificationEvidenceHasExactCoverage(input: {
  readonly evidence: CatalogQualificationEvidence;
  readonly queries: readonly CatalogQualificationFixture["queries"][number][];
  readonly validationCases: readonly CatalogQualificationFixture["validationCases"][number][];
  readonly writers: readonly CatalogQualificationFixture["writerConfigurations"][number][];
  readonly validators: readonly CatalogQualificationFixture["validatorConfigurations"][number][];
}): boolean {
  const expectedMetadata = input.writers.flatMap((writer) =>
    (["mixed", "uniform"] as const).map(
      (scenario) => `${writerConfigurationIdentity(writer)}:${scenario}`,
    ),
  );
  const expectedRetrieval = input.writers.flatMap((writer) =>
    input.queries.flatMap((query) => [
      ...CATALOG_RETRIEVAL_CHANNELS.map(
        (channel) => `${writerConfigurationIdentity(writer)}:${query.queryId}:${channel}:uniform`,
      ),
      `${writerConfigurationIdentity(writer)}:${query.queryId}:hybrid:mixed`,
    ]),
  );
  const expectedValidation = input.validators.flatMap((validator) =>
    input.validationCases.map((entry) => `${validator.modelId}:${entry.caseId}`),
  );
  const expectedDecisions = input.writers.flatMap((writer) =>
    input.validators.flatMap((validator) =>
      input.queries.map(
        (query) =>
          `${writerConfigurationIdentity(writer)}:${validator.modelId}:${query.queryId}:mixed`,
      ),
    ),
  );
  return (
    sameValues(input.evidence.metadataRuns.map(metadataRunIdentity), expectedMetadata) &&
    sameValues(
      input.evidence.embeddingRuns.map((entry) => entry.coverageScenario),
      ["mixed", "uniform"],
    ) &&
    sameValues(input.evidence.indexRuns.map(indexRunIdentity), expectedMetadata) &&
    sameValues(input.evidence.retrievalRuns.map(retrievalRunIdentity), expectedRetrieval) &&
    sameValues(
      input.evidence.independentValidationRuns.map(independentValidationRunIdentity),
      expectedValidation,
    ) &&
    sameValues(input.evidence.decisionRuns.map(decisionRunIdentity), expectedDecisions)
  );
}

export interface CatalogRankingMetricCase {
  readonly relevantSourceContentHashes: readonly string[];
  readonly rankedSourceContentHashes: readonly string[];
}

export interface CatalogRankingMetrics {
  readonly relevantQueryCount: number;
  readonly relevantJudgmentCount: number;
  readonly hitAtFiveMillionths: number;
  readonly pooledRecallAtFiveMillionths: number;
  readonly meanReciprocalRankMillionths: number;
}

/** Ranking metrics apply only to queries with at least one independently judged relevant asset. */
export function calculateCatalogRankingMetrics(
  cases: readonly CatalogRankingMetricCase[],
): CatalogRankingMetrics {
  let hits = 0;
  let reciprocalRank = 0;
  let relevantJudgments = 0;
  let relevantRetrieved = 0;
  let relevantQueries = 0;
  for (const metricCase of cases) {
    if (metricCase.relevantSourceContentHashes.length === 0) continue;
    relevantQueries += 1;
    relevantJudgments += metricCase.relevantSourceContentHashes.length;
    const relevant = new Set(metricCase.relevantSourceContentHashes);
    const firstRank = metricCase.rankedSourceContentHashes.findIndex((entry) =>
      relevant.has(entry),
    );
    if (firstRank >= 0) reciprocalRank += 1 / (firstRank + 1);
    const topFive = new Set(metricCase.rankedSourceContentHashes.slice(0, 5));
    const found = metricCase.relevantSourceContentHashes.filter((entry) =>
      topFive.has(entry),
    ).length;
    if (found > 0) hits += 1;
    relevantRetrieved += found;
  }
  return {
    relevantQueryCount: relevantQueries,
    relevantJudgmentCount: relevantJudgments,
    hitAtFiveMillionths: ratioMillionths(hits, relevantQueries),
    pooledRecallAtFiveMillionths: ratioMillionths(relevantRetrieved, relevantJudgments),
    meanReciprocalRankMillionths: Math.round(
      (reciprocalRank / Math.max(1, relevantQueries)) * 1_000_000,
    ),
  };
}

export interface CatalogDecisionOutcomeMetricCase {
  readonly expectation: "evidence_insufficient" | "match" | "no_match";
  readonly outcome: "evidence_insufficient" | "no_suitable_match" | "suitable_match";
}

export interface CatalogDecisionOutcomeMetrics {
  readonly caseCount: number;
  readonly matchCaseCount: number;
  readonly noMatchCaseCount: number;
  readonly evidenceInsufficientCaseCount: number;
  readonly exactOutcomeMillionths: number;
  readonly noMatchFalseAcceptanceCount: number;
  readonly noMatchFalseAcceptanceMillionths: number;
  readonly insufficientReportedAsNoMatchCount: number;
  readonly insufficientReportedAsNoMatchMillionths: number;
}

/** Decision safety rates retain their own semantic denominators. */
export function calculateCatalogDecisionOutcomeMetrics(
  cases: readonly CatalogDecisionOutcomeMetricCase[],
): CatalogDecisionOutcomeMetrics {
  let exact = 0;
  let matchCases = 0;
  let noMatchCases = 0;
  let evidenceInsufficientCases = 0;
  let falseAcceptances = 0;
  let insufficientNoMatches = 0;
  for (const metricCase of cases) {
    const expected =
      metricCase.expectation === "match"
        ? "suitable_match"
        : metricCase.expectation === "no_match"
          ? "no_suitable_match"
          : "evidence_insufficient";
    if (metricCase.expectation === "match") matchCases += 1;
    if (metricCase.expectation === "no_match") noMatchCases += 1;
    if (metricCase.expectation === "evidence_insufficient") evidenceInsufficientCases += 1;
    if (metricCase.outcome === expected) exact += 1;
    if (metricCase.expectation === "no_match" && metricCase.outcome === "suitable_match")
      falseAcceptances += 1;
    if (
      metricCase.expectation === "evidence_insufficient" &&
      metricCase.outcome === "no_suitable_match"
    )
      insufficientNoMatches += 1;
  }
  return {
    caseCount: cases.length,
    matchCaseCount: matchCases,
    noMatchCaseCount: noMatchCases,
    evidenceInsufficientCaseCount: evidenceInsufficientCases,
    exactOutcomeMillionths: ratioMillionths(exact, cases.length),
    noMatchFalseAcceptanceCount: falseAcceptances,
    noMatchFalseAcceptanceMillionths: ratioMillionths(falseAcceptances, noMatchCases),
    insufficientReportedAsNoMatchCount: insufficientNoMatches,
    insufficientReportedAsNoMatchMillionths: ratioMillionths(
      insufficientNoMatches,
      evidenceInsufficientCases,
    ),
  };
}

function calculateChannelMetrics(
  fixture: CatalogQualificationFixture,
  evidence: CatalogQualificationEvidence,
  results: ReadonlyMap<string, CatalogSearchResultSet>,
): z.output<typeof CHANNEL_METRICS_SCHEMA>[] {
  const queryById = new Map(fixture.queries.map((entry) => [entry.queryId, entry] as const));
  const groups = groupBy(evidence.retrievalRuns, (entry) =>
    [entry.writerModelId, entry.writerViewSet, entry.channel, entry.coverageScenario].join(":"),
  );
  return [...groups.values()].map((runs) => {
    const first = runs[0]!;
    const metrics = calculateCatalogRankingMetrics(
      runs.map((run) => {
        const query = queryById.get(run.queryId)!;
        const relevant = query.judgments
          .filter((entry) => entry.relevance === "relevant")
          .map((entry) => entry.sourceContentHash);
        const ranked = results
          .get(run.resultSetHash)!
          .results.map((entry) => entry.sourceContentHash);
        return {
          relevantSourceContentHashes: relevant,
          rankedSourceContentHashes: ranked,
        };
      }),
    );
    return {
      writerModelId: first.writerModelId,
      writerViewSet: first.writerViewSet,
      channel: first.channel,
      coverageScenario: first.coverageScenario,
      ...metrics,
    };
  });
}

function calculateValidatorMetrics(
  fixture: CatalogQualificationFixture,
  evidence: CatalogQualificationEvidence,
  receipts: ReadonlyMap<string, CatalogValidationReceipt>,
): z.output<typeof VALIDATOR_METRICS_SCHEMA>[] {
  const cases = new Map(fixture.validationCases.map((entry) => [entry.caseId, entry] as const));
  const groups = groupBy(evidence.independentValidationRuns, (entry) => entry.validatorModelId);
  return [...groups].map(([modelId, runs]) => {
    let exact = 0;
    let hardNegativeFalseMatches = 0;
    const receiptGpuMilliseconds = new Map<string, number>();
    for (const run of runs) {
      const expected = cases.get(run.caseId)!.expectedVerdict;
      const receipt = receipts.get(run.receiptHash)!;
      const verdict = receipt.validation!.verdict;
      if (verdict === expected) exact += 1;
      if (expected === "mismatch" && verdict === "match") hardNegativeFalseMatches += 1;
      receiptGpuMilliseconds.set(receipt.hash, receipt.resourceUsage.gpuMilliseconds);
    }
    return {
      modelId,
      caseCount: runs.length,
      exactVerdictMillionths: ratioMillionths(exact, runs.length),
      hardNegativeFalseMatchCount: hardNegativeFalseMatches,
      gpuMilliseconds: [...receiptGpuMilliseconds.values()].reduce((sum, value) => sum + value, 0),
    };
  });
}

function calculateDecisionMetrics(
  fixture: CatalogQualificationFixture,
  evidence: CatalogQualificationEvidence,
  decisions: ReadonlyMap<string, CatalogCandidateDecision>,
  validationReceipts: ReadonlyMap<string, CatalogValidationReceipt>,
): z.output<typeof DECISION_METRICS_SCHEMA>[] {
  const queries = new Map(fixture.queries.map((entry) => [entry.queryId, entry] as const));
  const groups = groupBy(evidence.decisionRuns, (entry) =>
    [entry.writerModelId, entry.writerViewSet, entry.validatorModelId].join(":"),
  );
  return [...groups.values()].map((runs) => {
    const first = runs[0]!;
    const receiptHashes = new Set<string>();
    const metrics = calculateCatalogDecisionOutcomeMetrics(
      runs.map((run) => {
        for (const validation of run.validations) receiptHashes.add(validation.receiptHash);
        return {
          expectation: queries.get(run.queryId)!.expectation,
          outcome: decisions.get(run.decisionHash)!.outcome,
        };
      }),
    );
    return {
      writerModelId: first.writerModelId,
      writerViewSet: first.writerViewSet,
      validatorModelId: first.validatorModelId,
      ...metrics,
      gpuMilliseconds: [...receiptHashes].reduce(
        (sum, hash) => sum + validationReceipts.get(hash)!.resourceUsage.gpuMilliseconds,
        0,
      ),
    };
  });
}

function selectConfiguration(input: {
  readonly fixture: CatalogQualificationFixture;
  readonly policy: CatalogQualificationPolicy;
  readonly evidence: CatalogQualificationEvidence;
  readonly metadataSets: ReadonlyMap<string, CatalogSearchMetadataSet>;
  readonly channelMetrics: readonly z.output<typeof CHANNEL_METRICS_SCHEMA>[];
  readonly validatorMetrics: readonly z.output<typeof VALIDATOR_METRICS_SCHEMA>[];
  readonly decisionMetrics: readonly z.output<typeof DECISION_METRICS_SCHEMA>[];
  readonly selection: CatalogQualificationSelection | undefined;
  readonly selectedWriterModelId: string | undefined;
  readonly selectedWriterViewSet: "cardinal_four" | "canonical_twelve" | undefined;
  readonly selectedValidatorModelId: string | undefined;
}) {
  if (input.selection)
    return {
      writer: requireWriterConfiguration(
        input.fixture,
        input.selection.selectedWriterModelId,
        input.selection.selectedWriterViewSet,
      ),
      validator: requireValidatorConfiguration(
        input.fixture,
        input.selection.selectedValidatorModelId,
      ),
    };
  if (
    input.selectedWriterModelId ||
    input.selectedWriterViewSet ||
    input.selectedValidatorModelId
  ) {
    if (
      !input.selectedWriterModelId ||
      !input.selectedWriterViewSet ||
      !input.selectedValidatorModelId
    )
      throw new Error("Qualification selection overrides require writer, views, and validator");
    return {
      writer: requireWriterConfiguration(
        input.fixture,
        input.selectedWriterModelId,
        input.selectedWriterViewSet,
      ),
      validator: requireValidatorConfiguration(input.fixture, input.selectedValidatorModelId),
    };
  }
  const candidates = input.fixture.writerConfigurations.flatMap((writer) =>
    input.fixture.validatorConfigurations.map((validator) => ({
      writer,
      validator,
      passes: configurationPasses(
        writer,
        validator,
        input.policy,
        input.channelMetrics,
        input.validatorMetrics,
        input.decisionMetrics,
      ),
      cost:
        metadataGpuMilliseconds(input.evidence, input.metadataSets, writer) +
        (input.validatorMetrics.find((entry) => entry.modelId === validator.modelId)
          ?.gpuMilliseconds ?? Number.MAX_SAFE_INTEGER) +
        (input.decisionMetrics.find(
          (entry) =>
            entry.writerModelId === writer.modelId &&
            entry.writerViewSet === writer.viewSet &&
            entry.validatorModelId === validator.modelId,
        )?.gpuMilliseconds ?? Number.MAX_SAFE_INTEGER),
    })),
  );
  const passing = candidates.filter((entry) => entry.passes);
  const ranked = (passing.length > 0 ? passing : candidates).sort(
    (left, right) =>
      left.cost - right.cost ||
      (left.writer.viewSet === right.writer.viewSet
        ? 0
        : left.writer.viewSet === "canonical_twelve"
          ? -1
          : 1) ||
      writerConfigurationIdentity(left.writer).localeCompare(
        writerConfigurationIdentity(right.writer),
      ) ||
      left.validator.modelId.localeCompare(right.validator.modelId),
  );
  const selected = ranked[0];
  if (!selected) throw new Error("Qualification fixture declares no selectable configurations");
  return { writer: selected.writer, validator: selected.validator };
}

function configurationPasses(
  writer: CatalogQualificationFixture["writerConfigurations"][number],
  validator: CatalogQualificationFixture["validatorConfigurations"][number],
  policy: CatalogQualificationPolicy,
  channels: readonly z.output<typeof CHANNEL_METRICS_SCHEMA>[],
  validators: readonly z.output<typeof VALIDATOR_METRICS_SCHEMA>[],
  decisions: readonly z.output<typeof DECISION_METRICS_SCHEMA>[],
): boolean {
  const uniform = channels.find(
    (entry) =>
      entry.writerModelId === writer.modelId &&
      entry.writerViewSet === writer.viewSet &&
      entry.channel === "hybrid" &&
      entry.coverageScenario === "uniform",
  );
  const mixed = channels.find(
    (entry) =>
      entry.writerModelId === writer.modelId &&
      entry.writerViewSet === writer.viewSet &&
      entry.channel === "hybrid" &&
      entry.coverageScenario === "mixed",
  );
  const validation = validators.find((entry) => entry.modelId === validator.modelId);
  const decision = decisions.find(
    (entry) =>
      entry.writerModelId === writer.modelId &&
      entry.writerViewSet === writer.viewSet &&
      entry.validatorModelId === validator.modelId,
  );
  return Boolean(
    uniform &&
    mixed &&
    validation &&
    decision &&
    uniform.hitAtFiveMillionths >= policy.minimumUniformHitAtFiveMillionths &&
    uniform.meanReciprocalRankMillionths >= policy.minimumUniformMeanReciprocalRankMillionths &&
    mixed.hitAtFiveMillionths >= policy.minimumMixedHitAtFiveMillionths &&
    mixed.meanReciprocalRankMillionths >= policy.minimumMixedMeanReciprocalRankMillionths &&
    validation.exactVerdictMillionths >= policy.minimumValidatorAccuracyMillionths &&
    validation.hardNegativeFalseMatchCount <= policy.maximumHardNegativeFalseMatches &&
    decision.exactOutcomeMillionths >= policy.minimumDecisionAccuracyMillionths &&
    decision.noMatchFalseAcceptanceCount <= policy.maximumNoMatchFalseAcceptances &&
    decision.insufficientReportedAsNoMatchCount <= policy.maximumInsufficientReportedAsNoMatch,
  );
}

function validateFixtureRelationships(
  fixture: CatalogQualificationFixture,
  context: z.RefinementCtx,
): void {
  const assets = new Map(fixture.assets.map((entry) => [entry.sourceContentHash, entry] as const));
  const groupSplits = new Map<string, CatalogQualificationSplit>();
  for (const asset of fixture.assets) {
    const existing = groupSplits.get(asset.leakageGroupHash);
    if (existing && existing !== asset.split)
      context.addIssue({
        code: "custom",
        path: ["assets"],
        message: `Leakage group ${asset.leakageGroupHash} crosses qualification splits`,
      });
    groupSplits.set(asset.leakageGroupHash, asset.split);
  }
  for (const split of CATALOG_QUALIFICATION_SPLITS) {
    const cohort = fixture.assets.filter(
      (entry) => entry.split === split && entry.population === "cohort",
    );
    const splitAssets = fixture.assets.filter((entry) => entry.split === split);
    const uniform = fixture.candidatePools.find(
      (entry) => entry.split === split && entry.coverageScenario === "uniform",
    );
    const mixed = fixture.candidatePools.find(
      (entry) => entry.split === split && entry.coverageScenario === "mixed",
    );
    const expectedUniform = cohort.map((entry) => ({
      sourceContentHash: entry.sourceContentHash,
      enrichmentProfile: "fully_enriched" as const,
    }));
    const expectedMixed = splitAssets.map((entry) => ({
      sourceContentHash: entry.sourceContentHash,
      enrichmentProfile: entry.mixedEnrichmentProfile,
    }));
    if (!uniform || stableJson(uniform.assets) !== stableJson(expectedUniform))
      context.addIssue({
        code: "custom",
        path: ["candidatePools"],
        message: `Uniform ${split} candidate pool differs from its cohort`,
      });
    if (!mixed || stableJson(mixed.assets) !== stableJson(expectedMixed))
      context.addIssue({
        code: "custom",
        path: ["candidatePools"],
        message: `Mixed ${split} candidate pool differs from its assigned corpus population`,
      });
    const profiles = new Set(cohort.map((entry) => entry.mixedEnrichmentProfile));
    for (const profile of CATALOG_ENRICHMENT_PROFILES)
      if (!profiles.has(profile))
        context.addIssue({
          code: "custom",
          path: ["assets"],
          message: `Qualification ${split} cohort lacks mixed-enrichment profile ${profile}`,
        });
  }
  for (const query of fixture.queries) {
    const uniform = fixture.candidatePools.find(
      (entry) => entry.split === query.split && entry.coverageScenario === "uniform",
    );
    const universe = new Set(uniform?.assets.map((entry) => entry.sourceContentHash));
    for (const judgment of query.judgments) {
      const asset = assets.get(judgment.sourceContentHash);
      if (!asset || asset.split !== query.split || !universe.has(judgment.sourceContentHash))
        context.addIssue({
          code: "custom",
          path: ["queries"],
          message: `Query ${query.queryId} judges an asset outside its split cohort`,
        });
    }
  }
  for (const validationCase of fixture.validationCases) {
    const asset = assets.get(validationCase.request.candidate.sourceContentHash);
    if (!asset || asset.split !== validationCase.split || asset.population !== "cohort")
      context.addIssue({
        code: "custom",
        path: ["validationCases"],
        message: `Validation case ${validationCase.caseId} references an asset outside its split cohort`,
      });
  }
}

function qualificationSearchQuery(
  query: CatalogSearchQuery,
  channel: z.output<typeof CATALOG_RETRIEVAL_CHANNEL_SCHEMA>,
  validationLimit: number,
): CatalogSearchQuery {
  return sealCatalogSearchQuery({
    text: query.text,
    styleTerms: query.styleTerms,
    rankingMode: channel,
    constraints: query.constraints,
    limit: query.limit,
    validationLimit,
  });
}

function candidatePoolFor(
  fixture: CatalogQualificationFixture,
  split: CatalogQualificationSplit,
  scenario: "mixed" | "uniform",
): CatalogQualificationCandidatePool {
  const pool = fixture.candidatePools.find(
    (entry) => entry.split === split && entry.coverageScenario === scenario,
  );
  if (!pool) throw new Error(`Qualification fixture lacks ${split} ${scenario} candidate pool`);
  return pool;
}

function expectedEnrichedSources(
  pool: CatalogQualificationCandidatePool,
  purpose: "image_text" | "metadata",
): string[] {
  return pool.assets
    .filter((entry) =>
      purpose === "metadata"
        ? profileHasMetadata(entry.enrichmentProfile)
        : profileHasImageText(entry.enrichmentProfile),
    )
    .map((entry) => entry.sourceContentHash);
}

function profileHasMetadata(profile: z.output<typeof CATALOG_ENRICHMENT_PROFILE_SCHEMA>): boolean {
  return profile === "basename_and_metadata" || profile === "fully_enriched";
}

function profileHasImageText(profile: z.output<typeof CATALOG_ENRICHMENT_PROFILE_SCHEMA>): boolean {
  return profile === "basename_and_image_text" || profile === "fully_enriched";
}

function requireWriterConfiguration(
  fixture: CatalogQualificationFixture,
  modelId: string,
  viewSet: "cardinal_four" | "canonical_twelve",
) {
  const writer = fixture.writerConfigurations.find(
    (entry) => entry.modelId === modelId && entry.viewSet === viewSet,
  );
  if (!writer) throw new Error(`Unknown qualification writer configuration ${modelId}:${viewSet}`);
  return writer;
}

function requireValidatorConfiguration(fixture: CatalogQualificationFixture, modelId: string) {
  const validator = fixture.validatorConfigurations.find((entry) => entry.modelId === modelId);
  if (!validator) throw new Error(`Unknown qualification validator configuration ${modelId}`);
  return validator;
}

function requireKnownWriter<T>(
  writers: ReadonlyMap<string, T>,
  modelId: string,
  viewSet: "cardinal_four" | "canonical_twelve",
): T {
  const key = `${modelId}:${viewSet}`;
  const writer = writers.get(key);
  if (!writer) throw new Error(`Unknown qualification writer configuration ${key}`);
  return writer;
}

function artifactMap<T extends { readonly hash: string }>(
  values: readonly unknown[],
  schema: { parse(value: unknown): T },
  label: string,
): Map<string, T> {
  const result = new Map<string, T>();
  for (const value of values) {
    const parsed = schema.parse(value);
    if (result.has(parsed.hash)) throw new Error(`Duplicate ${label} ${parsed.hash}`);
    result.set(parsed.hash, parsed);
  }
  return result;
}

function requiredArtifact<T>(
  artifacts: ReadonlyMap<string, T>,
  hash: string | undefined,
  label: string,
): T {
  if (!hash) throw new Error(`Missing referenced ${label}`);
  const artifact = artifacts.get(hash);
  if (!artifact) throw new Error(`Missing referenced ${label} ${hash}`);
  return artifact;
}

function groupBy<T>(values: readonly T[], key: (value: T) => string): Map<string, T[]> {
  const result = new Map<string, T[]>();
  for (const value of values) {
    const identity = key(value);
    result.set(identity, [...(result.get(identity) ?? []), value]);
  }
  return result;
}

function sameValues(left: readonly string[], right: readonly string[]): boolean {
  return (
    stableJson([...left].sort(compareCanonicalStrings)) ===
    stableJson([...right].sort(compareCanonicalStrings))
  );
}

function ratioMillionths(numerator: number, denominator: number): number {
  return Math.round((numerator / Math.max(1, denominator)) * 1_000_000);
}

function metadataGpuMilliseconds(
  evidence: CatalogQualificationEvidence,
  metadataSets: ReadonlyMap<string, CatalogSearchMetadataSet>,
  writer: CatalogQualificationFixture["writerConfigurations"][number],
): number {
  const usage = new Map<string, number>();
  for (const run of evidence.metadataRuns) {
    if (run.writerModelId !== writer.modelId || run.writerViewSet !== writer.viewSet) continue;
    for (const receipt of metadataSets.get(run.metadataSetHash)?.receipts ?? [])
      usage.set(receipt.hash, receipt.resourceUsage.gpuMilliseconds);
  }
  return [...usage.values()].reduce((sum, value) => sum + value, 0);
}

function uniqueReceiptGpuMilliseconds(artifacts: CatalogQualificationArtifacts): number {
  const usage = new Map<string, number>();
  for (const set of artifacts.metadataSets)
    for (const receipt of set.receipts)
      usage.set(receipt.hash, receipt.resourceUsage.gpuMilliseconds);
  for (const receipt of artifacts.validationReceipts)
    usage.set(receipt.hash, receipt.resourceUsage.gpuMilliseconds);
  for (const set of artifacts.embeddingSets)
    for (const receipt of set.receipts) usage.set(receipt.hash, receipt.gpuMilliseconds);
  for (const receipt of artifacts.queryEmbeddingReceipts)
    usage.set(receipt.workerOutputHash, receipt.batchGpuMilliseconds);
  return [...usage.values()].reduce((sum, value) => sum + value, 0);
}

function sharedEmbeddingGpuMilliseconds(artifacts: CatalogQualificationArtifacts): number {
  const usage = new Map<string, number>();
  for (const set of artifacts.embeddingSets)
    for (const receipt of set.receipts) usage.set(receipt.hash, receipt.gpuMilliseconds);
  for (const receipt of artifacts.queryEmbeddingReceipts)
    usage.set(receipt.workerOutputHash, receipt.batchGpuMilliseconds);
  return [...usage.values()].reduce((sum, value) => sum + value, 0);
}

function candidatePoolIdentity(value: {
  readonly split: string;
  readonly coverageScenario: string;
}) {
  return `${value.split}:${value.coverageScenario}`;
}

function writerConfigurationIdentity(value: {
  readonly modelId: string;
  readonly viewSet: string;
}) {
  return `${value.modelId}:${value.viewSet}`;
}

function writerRunConfigurationIdentity(value: {
  readonly writerModelId: string;
  readonly writerViewSet: string;
}) {
  return `${value.writerModelId}:${value.writerViewSet}`;
}

function metadataRunIdentity(value: {
  readonly writerModelId: string;
  readonly writerViewSet: string;
  readonly coverageScenario: string;
}) {
  return `${writerRunConfigurationIdentity(value)}:${value.coverageScenario}`;
}

function indexRunIdentity(value: {
  readonly writerModelId: string;
  readonly writerViewSet: string;
  readonly coverageScenario: string;
}) {
  return `${writerRunConfigurationIdentity(value)}:${value.coverageScenario}`;
}

function retrievalRunIdentity(value: {
  readonly writerModelId: string;
  readonly writerViewSet: string;
  readonly queryId: string;
  readonly channel: string;
  readonly coverageScenario: string;
}) {
  return `${writerRunConfigurationIdentity(value)}:${value.queryId}:${value.channel}:${value.coverageScenario}`;
}

function independentValidationRunIdentity(value: {
  readonly validatorModelId: string;
  readonly caseId: string;
}) {
  return `${value.validatorModelId}:${value.caseId}`;
}

function decisionRunIdentity(value: {
  readonly writerModelId: string;
  readonly writerViewSet: string;
  readonly validatorModelId: string;
  readonly queryId: string;
  readonly coverageScenario: string;
}) {
  return `${writerRunConfigurationIdentity(value)}:${value.validatorModelId}:${value.queryId}:${value.coverageScenario}`;
}

function channelMetricIdentity(value: {
  readonly writerModelId: string;
  readonly writerViewSet: string;
  readonly channel: string;
  readonly coverageScenario: string;
}) {
  return `${writerRunConfigurationIdentity(value)}:${value.channel}:${value.coverageScenario}`;
}

function decisionMetricIdentity(value: {
  readonly writerModelId: string;
  readonly writerViewSet: string;
  readonly validatorModelId: string;
}) {
  return `${writerRunConfigurationIdentity(value)}:${value.validatorModelId}`;
}
