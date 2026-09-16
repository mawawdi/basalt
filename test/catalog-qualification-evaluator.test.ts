import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  CATALOG_QUALIFICATION_POLICY_SCHEMA,
  CATALOG_QUALIFICATION_SELECTION_RULE,
  CATALOG_QUALIFICATION_SELECTION_SCHEMA,
  CATALOG_RETRIEVAL_CHANNELS,
  CATALOG_SEARCH_RESULT_SET_SCHEMA,
  calculateCatalogDecisionOutcomeMetrics,
  calculateCatalogRankingMetrics,
  catalogQualificationEvidenceHasExactCoverage,
  sealArtifact,
  sealCatalogQualificationEvidence,
  sealCatalogSearchQuery,
  validateCatalogQualificationLineage,
  verifyCatalogQualificationArtifacts,
  type CatalogQualificationEvidence,
  type CatalogQualificationFixture,
} from "@basalt/catalog-authoring";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

test("qualification reports Hit@5 separately from pooled Recall@5", () => {
  const metrics = calculateCatalogRankingMetrics([
    {
      relevantSourceContentHashes: ["asset-a", "asset-b"],
      rankedSourceContentHashes: ["asset-a", "x", "y", "z", "w"],
    },
    {
      relevantSourceContentHashes: ["asset-c"],
      rankedSourceContentHashes: ["x", "y", "z", "w", "asset-c"],
    },
    {
      relevantSourceContentHashes: [],
      rankedSourceContentHashes: ["x"],
    },
  ]);

  assert.deepEqual(metrics, {
    relevantQueryCount: 2,
    relevantJudgmentCount: 3,
    hitAtFiveMillionths: 1_000_000,
    pooledRecallAtFiveMillionths: 666_667,
    meanReciprocalRankMillionths: 600_000,
  });
});

test("qualification decision safety uses no-match and insufficient strata as denominators", () => {
  const metrics = calculateCatalogDecisionOutcomeMetrics([
    { expectation: "match", outcome: "suitable_match" },
    { expectation: "match", outcome: "no_suitable_match" },
    { expectation: "no_match", outcome: "suitable_match" },
    { expectation: "no_match", outcome: "no_suitable_match" },
    { expectation: "no_match", outcome: "no_suitable_match" },
    { expectation: "evidence_insufficient", outcome: "no_suitable_match" },
    { expectation: "evidence_insufficient", outcome: "evidence_insufficient" },
  ]);

  assert.deepEqual(metrics, {
    caseCount: 7,
    matchCaseCount: 2,
    noMatchCaseCount: 3,
    evidenceInsufficientCaseCount: 2,
    exactOutcomeMillionths: 571_429,
    noMatchFalseAcceptanceCount: 1,
    noMatchFalseAcceptanceMillionths: 333_333,
    insufficientReportedAsNoMatchCount: 1,
    insufficientReportedAsNoMatchMillionths: 500_000,
  });
});

test("qualification coverage is split-isolated and exact for each configuration", async () => {
  const fixture = await loadFixture();
  const writer = fixture.writerConfigurations[0]!;
  const validator = fixture.validatorConfigurations[0]!;
  const developmentQueries = fixture.queries.filter((entry) => entry.split === "development");
  const developmentCases = fixture.validationCases.filter((entry) => entry.split === "development");
  const evidence = exactCoverageEvidence(
    fixture,
    writer,
    validator,
    developmentQueries,
    developmentCases,
  );

  assert.equal(
    catalogQualificationEvidenceHasExactCoverage({
      evidence,
      queries: developmentQueries,
      validationCases: developmentCases,
      writers: [writer],
      validators: [validator],
    }),
    true,
  );
  assert.equal(
    catalogQualificationEvidenceHasExactCoverage({
      evidence: { ...evidence, retrievalRuns: evidence.retrievalRuns.slice(1) },
      queries: developmentQueries,
      validationCases: developmentCases,
      writers: [writer],
      validators: [validator],
    }),
    false,
    "one missing channel/query run must fail exact coverage",
  );
  assert.equal(
    catalogQualificationEvidenceHasExactCoverage({
      evidence,
      queries: fixture.queries.filter((entry) => entry.split === "holdout"),
      validationCases: fixture.validationCases.filter((entry) => entry.split === "holdout"),
      writers: [writer],
      validators: [validator],
    }),
    false,
    "development evidence must not fill holdout coverage",
  );
  assert.equal(
    catalogQualificationEvidenceHasExactCoverage({
      evidence,
      queries: developmentQueries,
      validationCases: developmentCases,
      writers: [writer, fixture.writerConfigurations[1]!],
      validators: [validator],
    }),
    false,
    "one writer configuration must not fill another writer's coverage",
  );
});

test("qualification lineage rejects stale policies and requires the exact frozen holdout selection", async () => {
  const fixture = await loadFixture();
  const policy = CATALOG_QUALIFICATION_POLICY_SCHEMA.parse(
    JSON.parse(await readFile("registry/qualification-policy.json", "utf8")),
  );
  const workerImplementationHash = HASH_A;
  const development = emptyEvidence(fixture, "development", workerImplementationHash);
  assert.doesNotThrow(() =>
    validateCatalogQualificationLineage({
      split: "development",
      fixture,
      evidence: development,
      policy,
      selection: undefined,
    }),
  );

  const stalePolicyEvidence = sealCatalogQualificationEvidence({
    ...evidenceMaterial(development),
    searchPolicyHash: HASH_B,
  });
  assert.throws(
    () =>
      validateCatalogQualificationLineage({
        split: "development",
        fixture,
        evidence: stalePolicyEvidence,
        policy,
        selection: undefined,
      }),
    /stale search policy/iu,
  );

  const selection = frozenSelection(fixture, workerImplementationHash);
  const holdout = sealCatalogQualificationEvidence({
    ...emptyEvidenceMaterial(fixture, "holdout", workerImplementationHash),
    frozenSelectionHash: selection.hash,
  });
  assert.doesNotThrow(() =>
    validateCatalogQualificationLineage({
      split: "holdout",
      fixture,
      evidence: holdout,
      policy,
      selection,
    }),
  );
  assert.throws(
    () =>
      validateCatalogQualificationLineage({
        split: "holdout",
        fixture,
        evidence: holdout,
        policy,
        selection: undefined,
      }),
    /exact frozen model-selection artifact/iu,
  );

  const staleSelection = frozenSelection(fixture, HASH_C);
  const staleHoldout = sealCatalogQualificationEvidence({
    ...emptyEvidenceMaterial(fixture, "holdout", workerImplementationHash),
    frozenSelectionHash: staleSelection.hash,
  });
  assert.throws(
    () =>
      validateCatalogQualificationLineage({
        split: "holdout",
        fixture,
        evidence: staleHoldout,
        policy,
        selection: staleSelection,
      }),
    /stale worker implementation/iu,
  );
});

test("qualification artifact verification rejects missing and contradictory references", async () => {
  const fixture = await loadFixture();
  const fixtureQuery = fixture.queries.find((entry) => entry.split === "development")!;
  const writer = fixture.writerConfigurations[0]!;
  const { kind: _queryKind, hash: _queryHash, ...queryMaterial } = fixtureQuery.query;
  const query = sealCatalogSearchQuery({
    ...queryMaterial,
    rankingMode: "basename_only",
    validationLimit: 0,
  });
  const evidence = sealCatalogQualificationEvidence({
    ...emptyEvidenceMaterial(fixture, "development", HASH_A),
    retrievalRuns: [
      {
        queryId: fixtureQuery.queryId,
        writerModelId: writer.modelId,
        writerViewSet: writer.viewSet,
        channel: "basename_only",
        coverageScenario: "uniform",
        queryHash: query.hash,
        resultSetHash: HASH_B,
      },
    ],
  });
  const emptyArtifacts = {
    metadataRequestSets: [],
    metadataSets: [],
    embeddingSets: [],
    embeddingMatrices: [],
    indexes: [],
    queryEmbeddingReceipts: [],
    resultSets: [],
    validationRequests: [],
    validationReceipts: [],
    decisions: [],
  } as const;
  assert.throws(
    () => verifyCatalogQualificationArtifacts({ fixture, evidence, artifacts: emptyArtifacts }),
    /missing referenced search result set/iu,
  );

  const contradictoryResult = sealArtifact(CATALOG_SEARCH_RESULT_SET_SCHEMA, {
    kind: "CatalogSearchResultSet" as const,
    status: "eligible" as const,
    query,
    indexHash: HASH_C,
    results: [],
    filteredCandidates: [],
    diagnostics: [],
    compilerAuthority: false as const,
  });
  const contradictoryEvidence = sealCatalogQualificationEvidence({
    ...emptyEvidenceMaterial(fixture, "development", HASH_A),
    retrievalRuns: [
      {
        queryId: fixtureQuery.queryId,
        writerModelId: writer.modelId,
        writerViewSet: writer.viewSet,
        channel: "basename_only",
        coverageScenario: "uniform",
        queryHash: query.hash,
        resultSetHash: contradictoryResult.hash,
      },
    ],
  });
  assert.throws(
    () =>
      verifyCatalogQualificationArtifacts({
        fixture,
        evidence: contradictoryEvidence,
        artifacts: { ...emptyArtifacts, resultSets: [contradictoryResult] },
      }),
    /contradictory query or index lineage/iu,
  );
});

async function loadFixture(): Promise<CatalogQualificationFixture> {
  const policy = CATALOG_QUALIFICATION_POLICY_SCHEMA.parse(
    JSON.parse(await readFile("registry/qualification-policy.json", "utf8")),
  );
  const query = sealCatalogSearchQuery({
    text: "synthetic independently reviewed bench",
    styleTerms: ["stylized"],
    rankingMode: "automatic",
    constraints: { commercialUseRequired: true, redistributionRequired: true },
    limit: 5,
    validationLimit: 2,
  });
  const queries = [
    { queryId: "development_match", split: "development" },
    { queryId: "holdout_match", split: "holdout" },
    { queryId: "model_selection_match", split: "model_selection" },
  ].map((entry) => ({
    ...entry,
    query,
    expectation: "match",
    judgmentBasis: "independent_visual_review",
    judgments: [{ sourceContentHash: HASH_A, relevance: "relevant" }],
    adjudicationEvidenceHashes: [HASH_A],
  }));
  const validationCases = queries.map((entry) => ({
    caseId: `${entry.split}_validator`,
    split: entry.split,
    request: { hash: HASH_A, candidate: { sourceContentHash: HASH_A } },
    expectedVerdict: "match",
    verdictBasis: "independent_visual_review",
    adjudicationEvidenceHashes: [HASH_A],
  }));
  return {
    kind: "CatalogQualificationFixture",
    hash: HASH_C,
    adjudication: {
      status: "creator_reviewed",
      reviewerAuthority: "creator",
      reviewerId: "synthetic-test-creator",
      reviewMethod: "independent_visual_review",
      proposalFixtureHash: HASH_A,
      reviewPacketHash: HASH_B,
      decisionArtifactHash: HASH_C,
    },
    sourceManifestHash: HASH_A,
    measurementSetHash: HASH_A,
    visualReviewIndexHash: HASH_A,
    leakageAnalysisHash: HASH_A,
    assets: [],
    candidatePools: [],
    queries,
    validationCases,
    writerConfigurations: [
      { modelId: "writer_model", modelCommitHash: "d".repeat(40), viewSet: "cardinal_four" },
      { modelId: "writer_model", modelCommitHash: "d".repeat(40), viewSet: "canonical_twelve" },
    ],
    validatorConfigurations: [{ modelId: "validator_model", modelCommitHash: "e".repeat(40) }],
    adjudicationProtocolHash: HASH_A,
    qualificationPolicyHash: policy.hash,
    searchPolicyHash: HASH_A,
    candidateDecisionPolicyHash: HASH_A,
    modelDeclarationsHash: HASH_A,
    modelRolePolicyHash: HASH_A,
    metadataPromptTemplateHash: HASH_A,
    validationPromptTemplateHash: HASH_A,
    metadataSchemaHash: HASH_A,
    validationSchemaHash: HASH_A,
    selectionRule: CATALOG_QUALIFICATION_SELECTION_RULE,
  } as unknown as CatalogQualificationFixture;
}

function emptyEvidence(
  fixture: CatalogQualificationFixture,
  split: "development" | "model_selection",
  workerImplementationHash: string,
): CatalogQualificationEvidence {
  return sealCatalogQualificationEvidence(
    emptyEvidenceMaterial(fixture, split, workerImplementationHash),
  );
}

function emptyEvidenceMaterial(
  fixture: CatalogQualificationFixture,
  split: "development" | "holdout" | "model_selection",
  workerImplementationHash: string,
) {
  return {
    split,
    fixtureHash: fixture.hash,
    searchPolicyHash: fixture.searchPolicyHash,
    qualificationPolicyHash: fixture.qualificationPolicyHash,
    candidateDecisionPolicyHash: fixture.candidateDecisionPolicyHash,
    modelDeclarationsHash: fixture.modelDeclarationsHash,
    modelRolePolicyHash: fixture.modelRolePolicyHash,
    metadataPromptTemplateHash: fixture.metadataPromptTemplateHash,
    validationPromptTemplateHash: fixture.validationPromptTemplateHash,
    metadataSchemaHash: fixture.metadataSchemaHash,
    validationSchemaHash: fixture.validationSchemaHash,
    workerImplementationHash,
    metadataRuns: [],
    embeddingRuns: [],
    indexRuns: [],
    retrievalRuns: [],
    independentValidationRuns: [],
    decisionRuns: [],
  };
}

function evidenceMaterial(evidence: CatalogQualificationEvidence) {
  const { kind: _kind, compilerAuthority: _authority, hash: _hash, ...material } = evidence;
  return material;
}

function exactCoverageEvidence(
  fixture: CatalogQualificationFixture,
  writer: CatalogQualificationFixture["writerConfigurations"][number],
  validator: CatalogQualificationFixture["validatorConfigurations"][number],
  queries: CatalogQualificationFixture["queries"],
  validationCases: CatalogQualificationFixture["validationCases"],
): CatalogQualificationEvidence {
  return sealCatalogQualificationEvidence({
    ...emptyEvidenceMaterial(fixture, "development", HASH_A),
    metadataRuns: (["mixed", "uniform"] as const).map((coverageScenario) => ({
      writerModelId: writer.modelId,
      writerModelCommitHash: writer.modelCommitHash,
      writerViewSet: writer.viewSet,
      coverageScenario,
      requestSetHash: HASH_A,
      metadataSetHash: HASH_B,
    })),
    embeddingRuns: (["mixed", "uniform"] as const).map((coverageScenario) => ({
      coverageScenario,
      modelId: "siglip_retrieval",
      modelCommitHash: "d".repeat(40),
      embeddingSetHash: HASH_A,
      embeddingMatrixHash: HASH_B,
    })),
    indexRuns: (["mixed", "uniform"] as const).map((coverageScenario) => ({
      writerModelId: writer.modelId,
      writerViewSet: writer.viewSet,
      coverageScenario,
      candidatePoolHash: HASH_A,
      indexHash: HASH_B,
    })),
    retrievalRuns: queries.flatMap((query) => [
      ...CATALOG_RETRIEVAL_CHANNELS.map((channel) => ({
        queryId: query.queryId,
        writerModelId: writer.modelId,
        writerViewSet: writer.viewSet,
        channel,
        coverageScenario: "uniform" as const,
        queryHash: HASH_A,
        resultSetHash: HASH_B,
      })),
      {
        queryId: query.queryId,
        writerModelId: writer.modelId,
        writerViewSet: writer.viewSet,
        channel: "hybrid" as const,
        coverageScenario: "mixed" as const,
        queryHash: HASH_A,
        resultSetHash: HASH_B,
      },
    ]),
    independentValidationRuns: validationCases.map((validationCase) => ({
      caseId: validationCase.caseId,
      validatorModelId: validator.modelId,
      validatorModelCommitHash: validator.modelCommitHash,
      requestHash: HASH_A,
      receiptHash: HASH_B,
    })),
    decisionRuns: queries.map((query) => ({
      queryId: query.queryId,
      writerModelId: writer.modelId,
      writerViewSet: writer.viewSet,
      validatorModelId: validator.modelId,
      coverageScenario: "mixed" as const,
      resultSetHash: HASH_A,
      validations: [],
      decisionHash: HASH_B,
    })),
  });
}

function frozenSelection(fixture: CatalogQualificationFixture, workerImplementationHash: string) {
  const writer = fixture.writerConfigurations[0]!;
  const validator = fixture.validatorConfigurations[0]!;
  return sealArtifact(CATALOG_QUALIFICATION_SELECTION_SCHEMA, {
    kind: "CatalogQualificationSelection" as const,
    fixtureHash: fixture.hash,
    modelSelectionReportHash: HASH_A,
    modelSelectionEvidenceHash: HASH_B,
    searchPolicyHash: fixture.searchPolicyHash,
    qualificationPolicyHash: fixture.qualificationPolicyHash,
    candidateDecisionPolicyHash: fixture.candidateDecisionPolicyHash,
    modelDeclarationsHash: fixture.modelDeclarationsHash,
    modelRolePolicyHash: fixture.modelRolePolicyHash,
    metadataPromptTemplateHash: fixture.metadataPromptTemplateHash,
    validationPromptTemplateHash: fixture.validationPromptTemplateHash,
    metadataSchemaHash: fixture.metadataSchemaHash,
    validationSchemaHash: fixture.validationSchemaHash,
    workerImplementationHash,
    selectedWriterModelId: writer.modelId,
    selectedWriterModelCommitHash: writer.modelCommitHash,
    selectedWriterViewSet: writer.viewSet,
    selectedValidatorModelId: validator.modelId,
    selectedValidatorModelCommitHash: validator.modelCommitHash,
    selectionRule: CATALOG_QUALIFICATION_SELECTION_RULE,
  });
}
