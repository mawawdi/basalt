import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  CATALOG_QUALIFICATION_DESCRIPTION_PROPOSAL_SCHEMA,
  CATALOG_QUALIFICATION_DESCRIPTION_SET_SCHEMA,
  CATALOG_QUALIFICATION_DEVELOPMENT_QUERY_SET_SCHEMA,
  CATALOG_QUALIFICATION_DEVELOPMENT_RELEVANCE_DECISION_SCHEMA,
  CATALOG_QUALIFICATION_DEVELOPMENT_VALIDATOR_CASE_SET_SCHEMA,
  CATALOG_QUALIFICATION_DEVELOPMENT_VALIDATOR_COMPARISON_SCHEMA,
  CATALOG_QUALIFICATION_DEVELOPMENT_VALIDATOR_VERDICT_SET_SCHEMA,
  CATALOG_REVIEW_EVIDENCE_AUDIT_SCHEMA,
  isGenericCatalogDescription,
  requireCatalogQualificationDevelopmentRelevanceDecision,
  requireCatalogQualificationDevelopmentQueryPrerequisites,
  requireCatalogQualificationDevelopmentValidatorDecision,
  requireCatalogQualificationDevelopmentValidatorComparison,
  requireReviewedCatalogQualificationDevelopmentValidatorVerdictSet,
  requireCreatorReviewedCatalogQualificationDescriptions,
  sealArtifact,
  sealCatalogQualificationDevelopmentCandidatePool,
  sealCatalogQualificationDevelopmentRelevanceDecision,
  sealCatalogQualificationDevelopmentValidatorDecision,
  sealCatalogQualificationDevelopmentValidatorComparison,
  sealCatalogQualificationDescriptionDecision,
  sealCreatorReviewedCatalogQualificationDescriptionSet,
  sealReviewedCatalogQualificationDevelopmentValidatorVerdictSet,
  sealCatalogValidationReceipt,
} from "@basalt/catalog-authoring";

test("description pilot excludes collision companions and rejects generic placeholders", async () => {
  const proposal = CATALOG_QUALIFICATION_DESCRIPTION_PROPOSAL_SCHEMA.parse(
    JSON.parse(await readFile("registry/qualifications/catalog-description-proposal.json", "utf8")),
  );
  const audit = CATALOG_REVIEW_EVIDENCE_AUDIT_SCHEMA.parse(
    JSON.parse(
      await readFile("registry/qualifications/catalog-review-evidence-audit.json", "utf8"),
    ),
  );

  assert.equal(proposal.assets.length, 24);
  assert.equal(proposal.split, "development");
  assert.equal(proposal.proposalAuthority, "none");
  assert.equal(proposal.qualificationExecutionAuthorized, false);
  assert.equal(proposal.reviewEvidenceAuditHash, audit.hash);
  assert.equal(audit.findings.length, 61);
  assert.equal(
    audit.findings.every((entry) => entry.appearanceReviewDisposition === "excluded"),
    true,
  );
  assert.equal(
    audit.findings.every(
      (entry) =>
        entry.measuredPartRoles.length === 1 && entry.measuredPartRoles[0] === "collision_proxy",
    ),
    true,
    "every explicit collision companion must remain geometry-only",
  );
  assert.equal(audit.status, "eligible");
  const excluded = new Set(audit.findings.map((entry) => entry.sourceContentHash));
  assert.equal(
    proposal.assets.some((entry) => excluded.has(entry.sourceContentHash)),
    false,
    "non-renderable collision companions cannot enter appearance review",
  );
  assert.equal(
    proposal.assets.some((entry) =>
      entry.visibleDescription.text
        ? isGenericCatalogDescription(entry.visibleDescription.text)
        : false,
    ),
    false,
  );
  assert.equal(isGenericCatalogDescription("stylized object aggregate"), true);
  const tree = proposal.assets.find(
    (asset) =>
      asset.sourceContentHash ===
      "052942c66b259cfcf031a217b51b6a83def56c72617c5def78e0bf8d1eaeaeb0",
  );
  assert.ok(tree);
  assert.deepEqual(tree.selectionTags, [
    "complete",
    "environment_realizer",
    "single_object",
    "vegetation",
  ]);
  const descriptionsBySource = new Map(
    proposal.assets.map((asset) => [asset.sourceContentHash, asset.visibleDescription.text]),
  );
  assert.equal(
    descriptionsBySource.get("0034c2c42719801ce1e679c00d4062e8a86e39d6898c7ba57e52d760cc3b02bc"),
    "Beige pillar-shaped piece with a faceted cap",
  );
  assert.equal(
    descriptionsBySource.get("052942c66b259cfcf031a217b51b6a83def56c72617c5def78e0bf8d1eaeaeb0"),
    "Low-poly tree with a brown trunk and snow-covered green crown",
  );
  assert.equal(
    descriptionsBySource.get("098e0b264794ad8ecf671727d98951721b80770c8751877fa8bc08032798ec0f"),
    "Tabletop paper trimmer with a blue rectangular bed, straight guide rail, and black slider",
  );
  assert.equal(
    descriptionsBySource.get("47ce4f9f15f0e1136b3cc0e3f6949179867228675e2648aa44293658c1f75225"),
    "Two-tone conical party hat with a red-orange top and purple lower band",
  );

  // The targeted audit did not establish its more cautious objections to these assets.
  assert.equal(
    descriptionsBySource.get("1ee7945e406721919edd23b846ff1cafe3a88231931d2e3ec6a866399b17e855"),
    "Faceted mustard-yellow beanbag chair with a deep slouched seat",
  );
  assert.equal(
    descriptionsBySource.get("25c127f1e39ae40d42cf8f123e7f3a3f29619e4f31405af4ab1a41c399c2232a"),
    "Curved shallow tan earthen channel with grassy banks and stones",
  );
  assert.equal(
    descriptionsBySource.get("2519f7d3fef35f984e57282d802a434e5187dafbc5e9cc3fab9a9a7e2f39d15b"),
    "Slender bent palm tree with a small crown of bright-green fronds",
  );
});

test("development requests are distinct, executable, and contain no answer key", async () => {
  const proposal = CATALOG_QUALIFICATION_DESCRIPTION_PROPOSAL_SCHEMA.parse(
    JSON.parse(await readFile("registry/qualifications/catalog-description-proposal.json", "utf8")),
  );
  const decision = JSON.parse(
    await readFile("registry/qualifications/catalog-description-decision.json", "utf8"),
  );
  const descriptions = CATALOG_QUALIFICATION_DESCRIPTION_SET_SCHEMA.parse(
    JSON.parse(await readFile("registry/qualifications/catalog-description-set.json", "utf8")),
  );
  const queries = CATALOG_QUALIFICATION_DEVELOPMENT_QUERY_SET_SCHEMA.parse(
    JSON.parse(
      await readFile("registry/qualifications/catalog-development-query-set.json", "utf8"),
    ),
  );

  assert.doesNotThrow(() =>
    requireCatalogQualificationDevelopmentQueryPrerequisites({
      proposal,
      decision,
      descriptions,
      queries,
    }),
  );
  assert.equal(queries.queries.length, 20);
  assert.equal(queries.answerKeyAuthority, "none");
  assert.equal(queries.qualificationExecutionAuthorized, false);
  assert.equal(queries.nextStage, "candidate_pooling");
  assert.deepEqual(queries.poolingPlan.retrievalChannels, [
    "basename_only",
    "hybrid",
    "image_text_only",
    "metadata_only",
  ]);
  assert.equal(
    queries.queries.filter((entry) => entry.coverageTags.includes("metric_limit")).length >= 6,
    true,
  );
  assert.equal(
    queries.queries.filter((entry) => entry.coverageTags.includes("no_match_probe")).length >= 2,
    true,
  );
  assert.equal(
    queries.queries.filter((entry) => entry.coverageTags.includes("unobservable_property"))
      .length >= 3,
    true,
  );
  const reviewedDescriptions = new Set(
    descriptions.assets.flatMap((asset) =>
      asset.visibleDescription.text ? [asset.visibleDescription.text] : [],
    ),
  );
  for (const entry of queries.queries) {
    assert.equal(entry.request.rankingMode, "automatic");
    assert.equal(entry.request.referenceSourceContentHash, undefined);
    assert.equal(reviewedDescriptions.has(entry.request.text), false);
    assert.deepEqual(Object.keys(entry).sort(), [
      "authoringNote",
      "coverageTags",
      "queryId",
      "request",
    ]);
    assert.equal(Object.hasOwn(entry, "expectation"), false);
    assert.equal(Object.hasOwn(entry, "judgments"), false);
  }

  const { kind: _kind, hash: _hash, ...queryMaterial } = queries;
  const staleQueries = sealArtifact(CATALOG_QUALIFICATION_DEVELOPMENT_QUERY_SET_SCHEMA, {
    kind: "CatalogQualificationDevelopmentQuerySet" as const,
    ...queryMaterial,
    descriptionDecisionArtifactHash: "f".repeat(64),
  });
  assert.throws(
    () =>
      requireCatalogQualificationDevelopmentQueryPrerequisites({
        proposal,
        decision,
        descriptions,
        queries: staleQueries,
      }),
    /does not bind the exact reviewed descriptions and evidence/iu,
  );
});

test("description finalization binds the exact reviewed values and decision contents", async () => {
  const proposal = CATALOG_QUALIFICATION_DESCRIPTION_PROPOSAL_SCHEMA.parse(
    JSON.parse(await readFile("registry/qualifications/catalog-description-proposal.json", "utf8")),
  );
  const decision = sealCatalogQualificationDescriptionDecision({
    proposalHash: proposal.hash,
    reviewer: { authority: "creator", reviewerId: "synthetic-test-creator" },
    reviewMethod: "independent_visible_description_review",
    reviewerStatement:
      "Synthetic creator independently reviewed every visual and measured description input.",
    reviewedAt: "2026-09-15T00:00:00.000Z",
    coverage: "complete",
    assets: proposal.assets.map((asset) => ({
      sourceContentHash: asset.sourceContentHash,
      reviewAction: "accurate",
      evidenceUsability: asset.evidenceUsability,
      visibleDescription: asset.visibleDescription,
    })),
  });
  const descriptions = sealCreatorReviewedCatalogQualificationDescriptionSet({
    proposal,
    decision,
  });

  assert.doesNotThrow(() =>
    requireCreatorReviewedCatalogQualificationDescriptions({
      proposal,
      decision,
      descriptions,
    }),
  );
  assert.equal(descriptions.decisionArtifactHash, decision.hash);
  assert.equal(descriptions.qualificationExecutionAuthorized, false);
  assert.deepEqual(Object.keys(decision.assets[0]!).sort(), [
    "evidenceUsability",
    "reviewAction",
    "sourceContentHash",
    "visibleDescription",
  ]);
  assert.deepEqual(Object.keys(descriptions.assets[0]!).sort(), [
    "evidenceUsability",
    "sourceContentHash",
    "visibleDescription",
  ]);

  const { kind: _kind, hash: _hash, ...descriptionMaterial } = descriptions;
  const statusOnlyMutation = sealArtifact(CATALOG_QUALIFICATION_DESCRIPTION_SET_SCHEMA, {
    kind: "CatalogQualificationDescriptionSet" as const,
    ...descriptionMaterial,
    decisionArtifactHash: "f".repeat(64),
  });
  assert.throws(
    () =>
      requireCreatorReviewedCatalogQualificationDescriptions({
        proposal,
        decision,
        descriptions: statusOnlyMutation,
      }),
    /does not match the exact creator decision contents/iu,
  );

  const first = decision.assets[0]!;
  const { kind: _decisionKind, hash: _decisionHash, ...decisionMaterial } = decision;
  const changedDecision = sealCatalogQualificationDescriptionDecision({
    ...decisionMaterial,
    assets: decision.assets.map((asset) =>
      asset.sourceContentHash === first.sourceContentHash
        ? {
            ...asset,
            reviewAction: "edited" as const,
            visibleDescription: {
              status: "concrete" as const,
              text: `${asset.visibleDescription.text} with an independently revised detail`,
              uncertaintyReason: null,
            },
          }
        : asset,
    ),
  });
  const changedDescriptions = sealCreatorReviewedCatalogQualificationDescriptionSet({
    proposal,
    decision: changedDecision,
  });
  assert.match(changedDescriptions.assets[0]!.visibleDescription.text ?? "", /revised detail/u);
  assert.throws(
    () =>
      requireCreatorReviewedCatalogQualificationDescriptions({
        proposal,
        decision: changedDecision,
        descriptions,
      }),
    /does not match the exact creator decision contents/iu,
  );

  const invalidAccurateDecision = sealCatalogQualificationDescriptionDecision({
    ...decisionMaterial,
    assets: changedDecision.assets.map((asset) =>
      asset.sourceContentHash === first.sourceContentHash
        ? { ...asset, reviewAction: "accurate" as const }
        : asset,
    ),
  });
  assert.throws(
    () =>
      sealCreatorReviewedCatalogQualificationDescriptionSet({
        proposal,
        decision: invalidAccurateDecision,
      }),
    /review action does not match/iu,
  );

  assert.throws(
    () =>
      CATALOG_QUALIFICATION_DESCRIPTION_PROPOSAL_SCHEMA.parse({
        ...proposal,
        assets: proposal.assets.slice(1),
      }),
    /artifact hash mismatch|24/iu,
  );
});

test("relevance review binds every exact pooled pair and keeps validator review separate", async () => {
  const reviewedDevelopmentDecision =
    CATALOG_QUALIFICATION_DEVELOPMENT_RELEVANCE_DECISION_SCHEMA.parse(
      JSON.parse(
        await readFile(
          "registry/qualifications/catalog-development-relevance-decision.json",
          "utf8",
        ),
      ),
    );
  assert.equal(reviewedDevelopmentDecision.status, "reviewed");
  assert.equal(reviewedDevelopmentDecision.reviewer.authority, "delegated_ai");
  assert.equal(reviewedDevelopmentDecision.relevanceJudgmentAuthority, "delegated_ai");
  assert.equal(reviewedDevelopmentDecision.queries.flatMap((entry) => entry.judgments).length, 230);
  assert.equal(reviewedDevelopmentDecision.qualificationExecutionAuthorized, false);

  const queries = CATALOG_QUALIFICATION_DEVELOPMENT_QUERY_SET_SCHEMA.parse(
    JSON.parse(
      await readFile("registry/qualifications/catalog-development-query-set.json", "utf8"),
    ),
  );
  const candidateSourceContentHash = "1".repeat(64);
  const candidateMeasurementHash = "2".repeat(64);
  const candidateRenderEvidenceHash = "3".repeat(64);
  const channels = ["basename_only", "hybrid", "image_text_only", "metadata_only"] as const;
  const pool = sealCatalogQualificationDevelopmentCandidatePool({
    querySetHash: queries.hash,
    descriptionSetHash: queries.descriptionSetHash,
    sourceManifestHash: "4".repeat(64),
    measurementSetHash: queries.measurementSetHash,
    visualReviewIndexHash: queries.visualReviewIndexHash,
    sourceNameHintSetHash: "5".repeat(64),
    searchPolicyHash: "6".repeat(64),
    metadataWriter: {
      modelId: "qwen3_vl_8b",
      modelCommitHash: "7".repeat(40),
      viewSet: "canonical_twelve",
      evidenceMode: "visual_only",
      requestSetHash: "8".repeat(64),
      metadataSetHash: "9".repeat(64),
    },
    imageTextRetriever: {
      modelId: "siglip2_so400m_384",
      modelCommitHash: "a".repeat(40),
      embeddingSetHash: "b".repeat(64),
      embeddingMatrixHash: "c".repeat(64),
    },
    indexHash: "d".repeat(64),
    resultDepthPerChannel: queries.poolingPlan.resultDepthPerChannel,
    queryPools: queries.queries.map((query, queryIndex) => {
      const retrievals = channels.map((channel, channelIndex) => ({
        channel,
        executedQueryHash: String((queryIndex + channelIndex) % 10).repeat(64),
        resultSetHash: String((queryIndex + channelIndex + 1) % 10).repeat(64),
        rankedSourceContentHashes: [candidateSourceContentHash],
      }));
      return {
        queryId: query.queryId,
        requestHash: query.request.hash,
        retrievals,
        manualRecallSeeds: [],
        candidates: [
          {
            sourceContentHash: candidateSourceContentHash,
            population: "background" as const,
            measurementHash: candidateMeasurementHash,
            renderEvidenceHash: candidateRenderEvidenceHash,
            retrievedBy: retrievals.map((retrieval) => ({
              channel: retrieval.channel,
              rank: 1,
              resultSetHash: retrieval.resultSetHash,
            })),
            includedByManualRecallSeed: false,
          },
        ],
      };
    }),
  });
  const decisionMaterial = {
    candidatePoolHash: pool.hash,
    querySetHash: queries.hash,
    reviewer: { authority: "creator" as const, reviewerId: "synthetic-test-creator" },
    reviewMethod: "independent_query_asset_relevance_review" as const,
    reviewerStatement:
      "Synthetic creator independently reviewed each query and its complete pooled candidate evidence.",
    reviewedAt: "2026-09-16T00:00:00.000Z",
    coverage: "complete" as const,
    queries: queries.queries.map((query) => ({
      queryId: query.queryId,
      requestHash: query.request.hash,
      requestDisposition: "accepted" as const,
      requestIssue: null,
      judgments: [
        {
          sourceContentHash: candidateSourceContentHash,
          measurementHash: candidateMeasurementHash,
          renderEvidenceHash: candidateRenderEvidenceHash,
          verdict: "relevant" as const,
          note: null,
        },
      ],
    })),
  };
  const decision = sealCatalogQualificationDevelopmentRelevanceDecision(decisionMaterial);

  assert.doesNotThrow(() =>
    requireCatalogQualificationDevelopmentRelevanceDecision({ queries, pool, decision }),
  );
  assert.equal(decision.status, "reviewed");
  assert.equal(decision.nextStage, "validator_execution_and_review");
  assert.equal(decision.validatorVerdictsReviewed, false);
  assert.equal(decision.qualificationExecutionAuthorized, false);

  const staleEvidence = sealCatalogQualificationDevelopmentRelevanceDecision({
    ...decisionMaterial,
    queries: decisionMaterial.queries.map((query, index) =>
      index === 0
        ? {
            ...query,
            judgments: query.judgments.map((judgment) => ({
              ...judgment,
              renderEvidenceHash: "e".repeat(64),
            })),
          }
        : query,
    ),
  });
  assert.throws(
    () =>
      requireCatalogQualificationDevelopmentRelevanceDecision({
        queries,
        pool,
        decision: staleEvidence,
      }),
    /does not match pooled candidate evidence/iu,
  );

  const rejectedQuery = sealCatalogQualificationDevelopmentRelevanceDecision({
    ...decisionMaterial,
    queries: decisionMaterial.queries.map((query, index) =>
      index === 0
        ? {
            ...query,
            requestDisposition: "rejected_for_reauthoring" as const,
            requestIssue: "The request combines requirements that cannot be judged together.",
            judgments: [],
          }
        : query,
    ),
  });
  assert.equal(rejectedQuery.status, "changes_requested");
  assert.equal(rejectedQuery.nextStage, "query_reauthoring");
});

test("validator verdict review remains separate and binds the exact reviewed decision", async () => {
  const caseSet = CATALOG_QUALIFICATION_DEVELOPMENT_VALIDATOR_CASE_SET_SCHEMA.parse(
    JSON.parse(
      await readFile("registry/qualifications/catalog-development-validator-case-set.json", "utf8"),
    ),
  );
  assert.equal(caseSet.caseCount, 44);
  assert.deepEqual(caseSet.proposedVerdictCounts, {
    match: 15,
    mismatch: 20,
    uncertain: 9,
  });
  assert.equal(caseSet.proposedVerdictAuthority, "derived_hypothesis");
  assert.equal(caseSet.validatorVerdictsReviewed, false);
  assert.equal(caseSet.qualificationExecutionAuthorized, false);
  assert.equal(
    caseSet.cases.filter((entry) => entry.selectionReason === "top_ranked_irrelevant").length,
    20,
  );

  const decision = sealCatalogQualificationDevelopmentValidatorDecision({
    caseSetHash: caseSet.hash,
    relevanceDecisionHash: caseSet.relevanceDecisionHash,
    reviewer: {
      authority: "delegated_ai",
      reviewerId: "synthetic-delegated-validator-reviewer",
    },
    reviewMethod: "independent_validator_verdict_review",
    reviewerStatement:
      "Synthetic delegated reviewer independently checked every validator case for contract testing.",
    reviewedAt: "2026-09-16T00:00:00.000Z",
    coverage: "complete",
    cases: caseSet.cases.map((entry) => ({
      caseId: entry.caseId,
      validationRequestHash: entry.validationRequest.hash,
      reviewAction: "confirmed",
      expectedVerdict: entry.proposedVerdict,
      note: null,
    })),
  });
  assert.doesNotThrow(() =>
    requireCatalogQualificationDevelopmentValidatorDecision({ caseSet, decision }),
  );
  assert.equal(decision.status, "reviewed");
  assert.equal(decision.validatorVerdictAuthority, "delegated_ai");
  assert.equal(decision.qualificationExecutionAuthorized, false);

  const verdictSet = sealReviewedCatalogQualificationDevelopmentValidatorVerdictSet({
    caseSet,
    decision,
  });
  assert.doesNotThrow(() =>
    requireReviewedCatalogQualificationDevelopmentValidatorVerdictSet({
      caseSet,
      decision,
      verdictSet,
    }),
  );
  assert.equal(verdictSet.decisionArtifactHash, decision.hash);
  assert.equal(verdictSet.qualificationExecutionAuthorized, false);

  const workerImplementationHash = "a".repeat(64);
  const models = [
    { modelId: "synthetic_validator_a", modelCommitHash: "b".repeat(40) },
    { modelId: "synthetic_validator_b", modelCommitHash: "c".repeat(40) },
  ];
  const receipts = models.flatMap((model) =>
    caseSet.cases.map((authored) => {
      const expected = verdictSet.cases.find((entry) => entry.caseId === authored.caseId)!;
      return sealCatalogValidationReceipt({
        request: authored.validationRequest,
        status: "eligible",
        adapterId: "synthetic-validator",
        adapterImplementationHash: "d".repeat(64),
        workerImplementationHash,
        runtimeImplementationHash: "e".repeat(64),
        modelId: model.modelId,
        modelCommitHash: model.modelCommitHash,
        promptHash: "f".repeat(64),
        rawOutputHash: "1".repeat(64),
        validation: {
          verdict: expected.expectedVerdict,
          observedObjectType: { status: "observed", value: "synthetic test object" },
          reasons: ["Synthetic exact-verdict comparison evidence."],
          mismatchedConstraints: [],
          visibleLimitations: [],
        },
        diagnostics: [],
        resourceUsage: {
          inputImageCount: 12,
          inputPixels: 1,
          inputTokens: 1,
          outputTokens: 1,
          elapsedMilliseconds: 1,
          peakResidentBytes: 1,
          gpuMilliseconds: 1,
        },
      });
    }),
  );
  const comparison = sealCatalogQualificationDevelopmentValidatorComparison({
    caseSet,
    verdictSet,
    modelDeclarationsHash: "2".repeat(64),
    modelRolePolicyHash: "3".repeat(64),
    workerImplementationHash,
    models,
    receipts,
  });
  assert.doesNotThrow(() =>
    requireCatalogQualificationDevelopmentValidatorComparison({
      caseSet,
      verdictSet,
      comparison,
      receipts,
    }),
  );
  assert.equal(
    CATALOG_QUALIFICATION_DEVELOPMENT_VALIDATOR_COMPARISON_SCHEMA.parse(comparison).metrics.every(
      (entry) => entry.exactVerdictMillionths === 1_000_000,
    ),
    true,
  );
  assert.equal(comparison.promotionAuthorized, false);
  assert.equal(comparison.qualificationExecutionAuthorized, false);
  assert.throws(
    () =>
      requireCatalogQualificationDevelopmentValidatorComparison({
        caseSet,
        verdictSet,
        comparison,
        receipts: receipts.slice(1),
      }),
    /lacks exact eligible execution evidence/iu,
  );

  const { kind: _kind, hash: _hash, ...verdictMaterial } = verdictSet;
  const provenanceOnlyMutation = sealArtifact(
    CATALOG_QUALIFICATION_DEVELOPMENT_VALIDATOR_VERDICT_SET_SCHEMA,
    {
      kind: "CatalogQualificationDevelopmentValidatorVerdictSet" as const,
      ...verdictMaterial,
      decisionArtifactHash: "f".repeat(64),
    },
  );
  assert.throws(
    () =>
      requireReviewedCatalogQualificationDevelopmentValidatorVerdictSet({
        caseSet,
        decision,
        verdictSet: provenanceOnlyMutation,
      }),
    /does not match the exact reviewed decision contents/iu,
  );
});
