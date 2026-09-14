import { z } from "zod";
import { COMPILATION_STATUS_SCHEMA, HASH_SCHEMA } from "@basalt/contracts";
import {
  canonicalValues,
  requireCanonicalValues,
  sealArtifact,
  verifyArtifactHash,
} from "./artifact.js";
import { CATALOG_METADATA_VIEW_SET_SCHEMA } from "./metadata.js";
import { CATALOG_MODEL_ROLE_SCHEMA } from "./model-policy.js";

export const CATALOG_QUALIFICATION_SPLITS = ["development", "holdout", "model_selection"] as const;
export const CATALOG_QUALIFICATION_SPLIT_SCHEMA = z.enum(CATALOG_QUALIFICATION_SPLITS);

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

/** Frozen before holdout execution; evaluation code contains no hidden acceptance thresholds. */
export const CATALOG_QUALIFICATION_POLICY_SCHEMA = z
  .object({
    kind: z.literal("CatalogQualificationPolicy"),
    policyId: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u),
    minimumUniformRecallAtFiveMillionths: z.number().int().min(0).max(1_000_000),
    minimumUniformMeanReciprocalRankMillionths: z.number().int().min(0).max(1_000_000),
    minimumMixedRecallAtFiveMillionths: z.number().int().min(0).max(1_000_000),
    minimumMixedMeanReciprocalRankMillionths: z.number().int().min(0).max(1_000_000),
    minimumDecisionAccuracyMillionths: z.number().int().min(0).max(1_000_000),
    minimumValidatorAccuracyMillionths: z.number().int().min(0).max(1_000_000),
    maximumHardNegativeFalseMatches: z.literal(0),
    requireFourAndTwelveViewEvidence: z.literal(true),
    requireIndependentWriterAndValidatorRuns: z.literal(true),
    holdoutMutationPolicy: z.literal("freeze_prompt_schema_models_and_thresholds_before_holdout"),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => verifyArtifactHash(value, context));
export type CatalogQualificationPolicy = z.output<typeof CATALOG_QUALIFICATION_POLICY_SCHEMA>;

const QUALIFICATION_ASSET_SCHEMA = z
  .object({
    sourceContentHash: HASH_SCHEMA,
    leakageGroupHash: HASH_SCHEMA,
    split: CATALOG_QUALIFICATION_SPLIT_SCHEMA,
    evidenceExpectation: z.enum(["sufficient", "insufficient"]),
    enrichmentProfile: CATALOG_ENRICHMENT_PROFILE_SCHEMA,
  })
  .strict();

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
    text: z.string().trim().min(1).max(512),
    expectation: z.enum(["evidence_insufficient", "match", "no_match"]),
    judgments: z.array(RELEVANCE_JUDGMENT_SCHEMA).min(1).max(512),
  })
  .strict()
  .superRefine((value, context) => {
    requireCanonicalValues(
      value.judgments,
      (entry) => entry.sourceContentHash,
      "qualification relevance judgments",
      context,
    );
    const relevant = value.judgments.filter((entry) => entry.relevance === "relevant").length;
    if (value.expectation === "match" && relevant === 0)
      context.addIssue({
        code: "custom",
        path: ["expectation"],
        message: "Match queries require at least one relevant asset",
      });
    if (value.expectation === "no_match" && relevant > 0)
      context.addIssue({
        code: "custom",
        path: ["expectation"],
        message: "No-match queries cannot contain a relevant asset",
      });
  });

const QUALIFICATION_VALIDATION_CASE_SCHEMA = z
  .object({
    caseId: z.string().regex(/^[a-z][a-z0-9_]{0,95}$/u),
    split: CATALOG_QUALIFICATION_SPLIT_SCHEMA,
    requirementHash: HASH_SCHEMA,
    sourceContentHash: HASH_SCHEMA,
    expectedVerdict: z.enum(["match", "mismatch", "uncertain"]),
  })
  .strict();

export const CATALOG_QUALIFICATION_FIXTURE_SCHEMA = z
  .object({
    kind: z.literal("CatalogQualificationFixture"),
    assets: z.array(QUALIFICATION_ASSET_SCHEMA).min(64).max(10_000),
    queries: z.array(QUALIFICATION_QUERY_SCHEMA).min(64).max(10_000),
    validationCases: z.array(QUALIFICATION_VALIDATION_CASE_SCHEMA).min(64).max(10_000),
    adjudicationProtocolHash: HASH_SCHEMA,
    qualificationPolicyHash: HASH_SCHEMA,
    searchPolicyHash: HASH_SCHEMA,
    candidateDecisionPolicyHash: HASH_SCHEMA,
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
    const sourceHashes = new Set(value.assets.map((entry) => entry.sourceContentHash));
    const enrichmentProfiles = new Set(value.assets.map((entry) => entry.enrichmentProfile));
    for (const profile of CATALOG_ENRICHMENT_PROFILES)
      if (!enrichmentProfiles.has(profile))
        context.addIssue({
          code: "custom",
          path: ["assets"],
          message: `Qualification fixture lacks mixed-enrichment profile ${profile}`,
        });
    const groupSplits = new Map<string, string>();
    for (const asset of value.assets) {
      const current = groupSplits.get(asset.leakageGroupHash);
      if (current && current !== asset.split)
        context.addIssue({
          code: "custom",
          path: ["assets"],
          message: `Leakage group ${asset.leakageGroupHash} crosses qualification splits`,
        });
      groupSplits.set(asset.leakageGroupHash, asset.split);
    }
    for (const query of value.queries)
      for (const judgment of query.judgments)
        if (!sourceHashes.has(judgment.sourceContentHash))
          context.addIssue({
            code: "custom",
            path: ["queries"],
            message: `Query ${query.queryId} judges an asset outside the pool`,
          });
    for (const validationCase of value.validationCases)
      if (!sourceHashes.has(validationCase.sourceContentHash))
        context.addIssue({
          code: "custom",
          path: ["validationCases"],
          message: `Validation case ${validationCase.caseId} references an asset outside the pool`,
        });
  });
export type CatalogQualificationFixture = z.output<typeof CATALOG_QUALIFICATION_FIXTURE_SCHEMA>;

const ROLE_RUN_SCHEMA = z
  .object({
    role: CATALOG_MODEL_ROLE_SCHEMA,
    modelId: z.string().regex(/^[a-z][a-z0-9_]{2,127}$/u),
    modelCommitHash: z.string().regex(/^[a-f0-9]{40,64}$/u),
    viewSet: CATALOG_METADATA_VIEW_SET_SCHEMA,
    outputSetHash: HASH_SCHEMA,
    gpuMilliseconds: z.number().int().nonnegative(),
  })
  .strict();

const RETRIEVAL_RUN_SCHEMA = z
  .object({
    queryId: z.string().regex(/^[a-z][a-z0-9_]{0,95}$/u),
    writerModelId: z
      .string()
      .regex(/^[a-z][a-z0-9_]{2,127}$/u)
      .optional(),
    viewSet: CATALOG_METADATA_VIEW_SET_SCHEMA.optional(),
    channel: CATALOG_RETRIEVAL_CHANNEL_SCHEMA,
    coverageScenario: z.enum(["mixed", "uniform"]),
    rankedSourceContentHashes: z.array(HASH_SCHEMA).max(100),
    resultHash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.rankedSourceContentHashes).size !== value.rankedSourceContentHashes.length)
      context.addIssue({
        code: "custom",
        path: ["rankedSourceContentHashes"],
        message: "Qualification rankings cannot repeat an asset",
      });
  });

const VALIDATION_RUN_SCHEMA = z
  .object({
    caseId: z.string().regex(/^[a-z][a-z0-9_]{0,95}$/u),
    validatorModelId: z.string().regex(/^[a-z][a-z0-9_]{2,127}$/u),
    verdict: z.enum(["match", "mismatch", "uncertain"]),
    receiptHash: HASH_SCHEMA,
  })
  .strict();

const DECISION_RUN_SCHEMA = z
  .object({
    queryId: z.string().regex(/^[a-z][a-z0-9_]{0,95}$/u),
    outcome: z.enum(["evidence_insufficient", "no_suitable_match", "suitable_match"]),
    decisionHash: HASH_SCHEMA,
  })
  .strict();

export const CATALOG_QUALIFICATION_EVIDENCE_SCHEMA = z
  .object({
    kind: z.literal("CatalogQualificationEvidence"),
    fixtureHash: HASH_SCHEMA,
    searchPolicyHash: HASH_SCHEMA,
    qualificationPolicyHash: HASH_SCHEMA,
    candidateDecisionPolicyHash: HASH_SCHEMA,
    roleRuns: z.array(ROLE_RUN_SCHEMA).min(2).max(64),
    retrievalRuns: z.array(RETRIEVAL_RUN_SCHEMA).min(1).max(100_000),
    validationRuns: z.array(VALIDATION_RUN_SCHEMA).min(1).max(100_000),
    decisionRuns: z.array(DECISION_RUN_SCHEMA).min(1).max(100_000),
    compilerAuthority: z.literal(false),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyArtifactHash(value, context);
    requireCanonicalValues(
      value.roleRuns,
      (entry) => `${entry.role}:${entry.modelId}:${entry.viewSet}`,
      "qualification role runs",
      context,
    );
    requireCanonicalValues(
      value.retrievalRuns,
      (entry) =>
        `${entry.queryId}:${entry.writerModelId ?? "none"}:${entry.viewSet ?? "none"}:${entry.channel}:${entry.coverageScenario}`,
      "qualification retrieval runs",
      context,
    );
    requireCanonicalValues(
      value.validationRuns,
      (entry) => `${entry.caseId}:${entry.validatorModelId}`,
      "qualification validation runs",
      context,
    );
    requireCanonicalValues(
      value.decisionRuns,
      (entry) => entry.queryId,
      "qualification decisions",
      context,
    );
    const retrievalQueries = new Set(value.retrievalRuns.map((entry) => entry.queryId));
    for (const decision of value.decisionRuns)
      if (!retrievalQueries.has(decision.queryId))
        context.addIssue({
          code: "custom",
          message: `Decision ${decision.queryId} has no retrieval evidence`,
        });
  });
export type CatalogQualificationEvidence = z.output<typeof CATALOG_QUALIFICATION_EVIDENCE_SCHEMA>;

const CHANNEL_METRICS_SCHEMA = z
  .object({
    channel: CATALOG_RETRIEVAL_CHANNEL_SCHEMA,
    writerModelId: z
      .string()
      .regex(/^[a-z][a-z0-9_]{2,127}$/u)
      .optional(),
    viewSet: CATALOG_METADATA_VIEW_SET_SCHEMA.optional(),
    coverageScenario: z.enum(["mixed", "uniform"]),
    queryCount: z.number().int().nonnegative(),
    recallAtFiveMillionths: z.number().int().min(0).max(1_000_000),
    meanReciprocalRankMillionths: z.number().int().min(0).max(1_000_000),
  })
  .strict();

const VALIDATOR_METRICS_SCHEMA = z
  .object({
    modelId: z.string().regex(/^[a-z][a-z0-9_]{2,127}$/u),
    caseCount: z.number().int().nonnegative(),
    exactVerdictMillionths: z.number().int().min(0).max(1_000_000),
    hardNegativeFalseMatchCount: z.number().int().nonnegative(),
  })
  .strict();

const DECISION_METRICS_SCHEMA = z
  .object({
    caseCount: z.number().int().nonnegative(),
    exactOutcomeMillionths: z.number().int().min(0).max(1_000_000),
    noMatchFalseAcceptanceCount: z.number().int().nonnegative(),
    insufficientFalseNoMatchCount: z.number().int().nonnegative(),
  })
  .strict();

export const CATALOG_QUALIFICATION_REPORT_SCHEMA = z
  .object({
    kind: z.literal("CatalogQualificationReport"),
    status: COMPILATION_STATUS_SCHEMA,
    fixtureHash: HASH_SCHEMA,
    evidenceHash: HASH_SCHEMA,
    searchPolicyHash: HASH_SCHEMA,
    qualificationPolicyHash: HASH_SCHEMA,
    candidateDecisionPolicyHash: HASH_SCHEMA,
    selectedWriterModelId: z.string().regex(/^[a-z][a-z0-9_]{2,127}$/u),
    selectedWriterViewSet: CATALOG_METADATA_VIEW_SET_SCHEMA,
    selectedValidatorModelId: z.string().regex(/^[a-z][a-z0-9_]{2,127}$/u),
    channelMetrics: z.array(CHANNEL_METRICS_SCHEMA).min(4).max(64),
    validatorMetrics: z.array(VALIDATOR_METRICS_SCHEMA).min(1).max(16),
    decisionMetrics: DECISION_METRICS_SCHEMA,
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
      (entry) =>
        `${entry.channel}:${entry.writerModelId ?? "none"}:${entry.viewSet ?? "none"}:${entry.coverageScenario}`,
      "qualification channel metrics",
      context,
    );
    requireCanonicalValues(
      value.validatorMetrics,
      (entry) => entry.modelId,
      "qualification validator metrics",
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
  });
export type CatalogQualificationReport = z.output<typeof CATALOG_QUALIFICATION_REPORT_SCHEMA>;

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
    queries: canonicalValues(input.queries, (entry) => entry.queryId, "qualification queries"),
    validationCases: canonicalValues(
      input.validationCases,
      (entry) => entry.caseId,
      "qualification validation cases",
    ),
  });
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
    roleRuns: canonicalValues(
      input.roleRuns,
      (entry) => `${entry.role}:${entry.modelId}:${entry.viewSet}`,
      "qualification role runs",
    ),
    retrievalRuns: canonicalValues(
      input.retrievalRuns,
      (entry) =>
        `${entry.queryId}:${entry.writerModelId ?? "none"}:${entry.viewSet ?? "none"}:${entry.channel}:${entry.coverageScenario}`,
      "qualification retrieval runs",
    ),
    validationRuns: canonicalValues(
      input.validationRuns,
      (entry) => `${entry.caseId}:${entry.validatorModelId}`,
      "qualification validation runs",
    ),
    decisionRuns: canonicalValues(
      input.decisionRuns,
      (entry) => entry.queryId,
      "qualification decisions",
    ),
    compilerAuthority: false as const,
  });
}

export function evaluateCatalogQualification(input: {
  readonly fixture: CatalogQualificationFixture;
  readonly evidence: CatalogQualificationEvidence;
  readonly policy: CatalogQualificationPolicy;
  readonly selectedWriterModelId: string;
  readonly selectedWriterViewSet: "cardinal_four" | "canonical_twelve";
  readonly selectedValidatorModelId: string;
}): CatalogQualificationReport {
  const fixture = CATALOG_QUALIFICATION_FIXTURE_SCHEMA.parse(input.fixture);
  const evidence = CATALOG_QUALIFICATION_EVIDENCE_SCHEMA.parse(input.evidence);
  const policy = CATALOG_QUALIFICATION_POLICY_SCHEMA.parse(input.policy);
  if (evidence.fixtureHash !== fixture.hash)
    throw new Error("Qualification evidence binds another fixture");
  if (fixture.qualificationPolicyHash !== policy.hash)
    throw new Error("Qualification fixture binds another frozen qualification policy");
  if (
    evidence.searchPolicyHash !== fixture.searchPolicyHash ||
    evidence.qualificationPolicyHash !== fixture.qualificationPolicyHash ||
    evidence.candidateDecisionPolicyHash !== fixture.candidateDecisionPolicyHash
  )
    throw new Error("Qualification evidence does not bind the fixture's frozen policies");
  const queryById = new Map(fixture.queries.map((entry) => [entry.queryId, entry] as const));
  const channelGroups = new Map<string, CatalogQualificationEvidence["retrievalRuns"]>();
  for (const run of evidence.retrievalRuns) {
    const key = `${run.channel}:${run.writerModelId ?? "none"}:${run.viewSet ?? "none"}:${run.coverageScenario}`;
    const existing = channelGroups.get(key) ?? [];
    channelGroups.set(key, [...existing, run]);
  }
  const channelMetrics = [...channelGroups].map(([, runs]) => {
    let hits = 0;
    let reciprocalRank = 0;
    for (const run of runs) {
      const query = queryById.get(run.queryId);
      if (!query) continue;
      const relevant = new Set(
        query.judgments
          .filter((entry) => entry.relevance === "relevant")
          .map((entry) => entry.sourceContentHash),
      );
      const rank = run.rankedSourceContentHashes.findIndex((entry) => relevant.has(entry));
      if (rank >= 0 && rank < 5) hits += 1;
      if (rank >= 0) reciprocalRank += 1 / (rank + 1);
    }
    const first = runs[0]!;
    return {
      channel: first.channel,
      ...(first.writerModelId ? { writerModelId: first.writerModelId } : {}),
      ...(first.viewSet ? { viewSet: first.viewSet } : {}),
      coverageScenario: first.coverageScenario,
      queryCount: runs.length,
      recallAtFiveMillionths: Math.round((hits / Math.max(1, runs.length)) * 1_000_000),
      meanReciprocalRankMillionths: Math.round(
        (reciprocalRank / Math.max(1, runs.length)) * 1_000_000,
      ),
    };
  });
  const validationByModel = new Map<string, CatalogQualificationEvidence["validationRuns"]>();
  for (const run of evidence.validationRuns)
    validationByModel.set(run.validatorModelId, [
      ...(validationByModel.get(run.validatorModelId) ?? []),
      run,
    ]);
  const caseById = new Map(fixture.validationCases.map((entry) => [entry.caseId, entry] as const));
  const validatorMetrics = [...validationByModel].map(([modelId, runs]) => {
    let exact = 0;
    let falseMatches = 0;
    for (const run of runs) {
      const expected = caseById.get(run.caseId)?.expectedVerdict;
      if (expected === run.verdict) exact += 1;
      if (expected === "mismatch" && run.verdict === "match") falseMatches += 1;
    }
    return {
      modelId,
      caseCount: runs.length,
      exactVerdictMillionths: Math.round((exact / Math.max(1, runs.length)) * 1_000_000),
      hardNegativeFalseMatchCount: falseMatches,
    };
  });
  const selectedHybrid = channelMetrics.find(
    (entry) =>
      entry.channel === "hybrid" &&
      entry.writerModelId === input.selectedWriterModelId &&
      entry.viewSet === input.selectedWriterViewSet &&
      entry.coverageScenario === "uniform",
  );
  const selectedMixedHybrid = channelMetrics.find(
    (entry) =>
      entry.channel === "hybrid" &&
      entry.writerModelId === input.selectedWriterModelId &&
      entry.viewSet === input.selectedWriterViewSet &&
      entry.coverageScenario === "mixed",
  );
  const selectedValidator = validatorMetrics.find(
    (entry) => entry.modelId === input.selectedValidatorModelId,
  );
  const runKeys = new Set(evidence.roleRuns.map((entry) => `${entry.role}:${entry.modelId}`));
  const writerViewSets = new Set(
    evidence.roleRuns
      .filter(
        (entry) =>
          entry.role === "metadata_writer" && entry.modelId === input.selectedWriterModelId,
      )
      .map((entry) => entry.viewSet),
  );
  const expectedOutcome = (queryId: string) => {
    const expectation = queryById.get(queryId)?.expectation;
    return expectation === "match"
      ? "suitable_match"
      : expectation === "no_match"
        ? "no_suitable_match"
        : "evidence_insufficient";
  };
  let exactDecisions = 0;
  let noMatchFalseAcceptanceCount = 0;
  let insufficientFalseNoMatchCount = 0;
  for (const run of evidence.decisionRuns) {
    const expected = expectedOutcome(run.queryId);
    if (run.outcome === expected) exactDecisions += 1;
    if (expected === "no_suitable_match" && run.outcome === "suitable_match")
      noMatchFalseAcceptanceCount += 1;
    if (expected === "evidence_insufficient" && run.outcome === "no_suitable_match")
      insufficientFalseNoMatchCount += 1;
  }
  const decisionMetrics = {
    caseCount: evidence.decisionRuns.length,
    exactOutcomeMillionths: Math.round(
      (exactDecisions / Math.max(1, evidence.decisionRuns.length)) * 1_000_000,
    ),
    noMatchFalseAcceptanceCount,
    insufficientFalseNoMatchCount,
  };
  const retrievalCoverage = new Set(
    evidence.retrievalRuns.map(
      (entry) => `${entry.queryId}:${entry.channel}:${entry.coverageScenario}`,
    ),
  );
  const gates = {
    evidenceCoverage:
      fixture.queries.every((query) =>
        ["basename_only", "image_text_only", "metadata_only", "hybrid"].every((channel) =>
          retrievalCoverage.has(`${query.queryId}:${channel}:uniform`),
        ),
      ) &&
      fixture.queries.every((query) => retrievalCoverage.has(`${query.queryId}:hybrid:mixed`)) &&
      evidence.validationRuns.length >= fixture.validationCases.length &&
      evidence.decisionRuns.length === fixture.queries.length,
    hybridRetrieval:
      (selectedHybrid?.recallAtFiveMillionths ?? 0) >=
        policy.minimumUniformRecallAtFiveMillionths &&
      (selectedHybrid?.meanReciprocalRankMillionths ?? 0) >=
        policy.minimumUniformMeanReciprocalRankMillionths,
    mixedEnrichmentCoverage:
      (selectedMixedHybrid?.recallAtFiveMillionths ?? 0) >=
        policy.minimumMixedRecallAtFiveMillionths &&
      (selectedMixedHybrid?.meanReciprocalRankMillionths ?? 0) >=
        policy.minimumMixedMeanReciprocalRankMillionths,
    noMatchSafety:
      decisionMetrics.noMatchFalseAcceptanceCount === policy.maximumHardNegativeFalseMatches,
    acceptanceDecisionSafety:
      decisionMetrics.exactOutcomeMillionths >= policy.minimumDecisionAccuracyMillionths &&
      decisionMetrics.insufficientFalseNoMatchCount === 0,
    validatorSafety:
      (selectedValidator?.exactVerdictMillionths ?? 0) >=
        policy.minimumValidatorAccuracyMillionths &&
      (selectedValidator?.hardNegativeFalseMatchCount ?? 1) ===
        policy.maximumHardNegativeFalseMatches,
    viewCountQualified:
      writerViewSets.has("cardinal_four") && writerViewSets.has("canonical_twelve"),
    rolesQualifiedIndependently:
      runKeys.has(`metadata_writer:${input.selectedWriterModelId}`) &&
      runKeys.has(`requirement_validator:${input.selectedValidatorModelId}`),
  };
  const diagnostics = Object.entries(gates)
    .filter(([, passed]) => !passed)
    .map(([name]) => `Qualification gate failed: ${name}`)
    .sort();
  return sealArtifact(CATALOG_QUALIFICATION_REPORT_SCHEMA, {
    kind: "CatalogQualificationReport" as const,
    status: diagnostics.length === 0 ? ("eligible" as const) : ("incomplete" as const),
    fixtureHash: fixture.hash,
    evidenceHash: evidence.hash,
    searchPolicyHash: fixture.searchPolicyHash,
    qualificationPolicyHash: policy.hash,
    candidateDecisionPolicyHash: fixture.candidateDecisionPolicyHash,
    selectedWriterModelId: input.selectedWriterModelId,
    selectedWriterViewSet: input.selectedWriterViewSet,
    selectedValidatorModelId: input.selectedValidatorModelId,
    channelMetrics: canonicalValues(
      channelMetrics,
      (entry) =>
        `${entry.channel}:${entry.writerModelId ?? "none"}:${entry.viewSet ?? "none"}:${entry.coverageScenario}`,
      "qualification channel metrics",
    ),
    validatorMetrics: canonicalValues(
      validatorMetrics,
      (entry) => entry.modelId,
      "qualification validator metrics",
    ),
    decisionMetrics,
    gates,
    diagnostics,
    compilerAuthority: false as const,
  });
}

export function qualificationAuthorizesCorpus(report: CatalogQualificationReport): boolean {
  return CATALOG_QUALIFICATION_REPORT_SCHEMA.parse(report).status === "eligible";
}
