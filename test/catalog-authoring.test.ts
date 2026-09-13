import assert from "node:assert/strict";
import test from "node:test";
import {
  ASSET_SEMANTIC_HYPOTHESIS_RECEIPT_SCHEMA,
  DEFAULT_CATALOG_ADMISSION_POLICY,
  CATALOG_RENDER_EVIDENCE_SCHEMA,
  CATALOG_REVIEW_VIEWPOINTS,
  applyCatalogAdmissionDecisions,
  buildCatalogAdmissionCohorts,
  buildCatalogHypothesisPanel,
  buildCatalogReviewPlan,
  sealAssetSemanticHypothesisReceipt,
  sealAssetSemanticHypothesisRequest,
  sealCatalogAuthorityCommit,
  sealCatalogCohortAudit,
  sealCatalogCohortDecision,
  sealCatalogHypothesisReceiptSet,
  sealCatalogHypothesisRequestSet,
  sealCatalogRenderEvidence,
  sealCatalogVisualEmbeddingReceipt,
  sealCatalogVisualEmbeddingSet,
} from "@basalt/catalog-authoring";
import {
  sealCatalogAssetArtifact,
  sealCatalogMeasurementSet,
  sealCatalogSnapshot,
} from "@basalt/catalog-model";
import { contentHash, stableJson } from "@basalt/contracts";
import { sealSemanticAssertionBundle } from "@basalt/semantic-kernel";
import { catalogFixture } from "./helpers/catalog-fixture.js";
import { loadSemanticRegistry } from "./helpers/semantic-registry.js";

test("catalog render evidence requires the canonical multiview rig and all channels", () => {
  const evidence = sealCatalogRenderEvidence({
    sourceContentHash: contentHash("source"),
    rendererImplementationHash: contentHash("renderer"),
    cameraRigHash: contentHash("camera"),
    lightingHash: contentHash("lighting"),
    materialModeHash: contentHash("materials"),
    views: CATALOG_REVIEW_VIEWPOINTS.map((view) => ({
      ...view,
      rgbHash: contentHash(`${view.viewId}:rgb`),
      silhouetteHash: contentHash(`${view.viewId}:silhouette`),
      normalizedDepthHash: contentHash(`${view.viewId}:depth`),
    })),
    contactSheetHash: contentHash("sheet"),
  });
  assert.equal(evidence.views.length, 12);
  assert.equal(CATALOG_RENDER_EVIDENCE_SCHEMA.parse(evidence).hash, evidence.hash);
  assert.throws(
    () =>
      CATALOG_RENDER_EVIDENCE_SCHEMA.parse({
        ...evidence,
        views: evidence.views.slice(1),
      }),
    /12|length/iu,
  );
});

test("vision receipts are deterministic provenance with hypothesis-only authority", () => {
  const request = sealAssetSemanticHypothesisRequest({
    sourceContentHash: contentHash("hypothesis-source"),
    measurementHash: contentHash("hypothesis-measurement"),
    renderEvidenceHash: contentHash("hypothesis-render"),
    semanticModuleHash: contentHash("hypothesis-module"),
    semanticLexiconHash: contentHash("hypothesis-lexicon"),
    requestedConceptIds: ["bsc_000003"],
  });
  const assertions = sealSemanticAssertionBundle({
    authority: "hypothesis",
    hypothesisSourceHash: request.hash,
    assertions: [],
    abstentions: ["Insufficient visual evidence"],
  });
  const input = {
    requestHash: request.hash,
    sourceContentHash: request.sourceContentHash,
    measurementHash: request.measurementHash,
    renderEvidenceHash: request.renderEvidenceHash,
    semanticModuleHash: request.semanticModuleHash,
    semanticLexiconHash: request.semanticLexiconHash,
    adapterHash: contentHash("vision-adapter"),
    modelImplementationHash: contentHash("vision-model-implementation"),
    assertions,
    diagnostics: [],
    resourceUse: { inputTokens: 100, outputTokens: 20, computeMilliseconds: 50 },
  };
  const first = sealAssetSemanticHypothesisReceipt(input);
  const second = sealAssetSemanticHypothesisReceipt(input);
  assert.equal(first.hash, second.hash);
  assert.equal(first.compilerAuthority, false);
  assert.equal("timestamp" in first, false);

  const unrelatedAssertions = sealSemanticAssertionBundle({
    authority: "hypothesis",
    hypothesisSourceHash: contentHash("another-request"),
    assertions: [],
    abstentions: ["Not evaluated for this request"],
  });
  assert.throws(
    () => sealAssetSemanticHypothesisReceipt({ ...input, assertions: unrelatedAssertions }),
    /exact request/u,
  );

  const admitted = sealSemanticAssertionBundle({ authority: "admitted", assertions: [] });
  assert.throws(
    () =>
      ASSET_SEMANTIC_HYPOTHESIS_RECEIPT_SCHEMA.parse({
        ...first,
        assertions: admitted,
      }),
    /hypothesis|invalid input/iu,
  );
});

test("independent hypotheses form a sampled cohort without making confidence authoritative", async () => {
  const module = await loadSemanticRegistry();
  const fixture = await catalogFixture(module);
  const request = sealAssetSemanticHypothesisRequest({
    sourceContentHash: fixture.asset.source.contentHash,
    measurementHash: fixture.asset.hash,
    renderEvidenceHash: contentHash("panel-render"),
    semanticModuleHash: module.snapshot.hash,
    semanticLexiconHash: contentHash("panel-lexicon"),
    requestedConceptIds: [fixture.declaration.semantic.denotation.conceptId],
  });
  const requests = sealCatalogHypothesisRequestSet({
    status: "incomplete",
    measurementSetHash: contentHash("panel-measurements"),
    visualReviewIndexHash: contentHash("panel-review"),
    semanticModuleHash: request.semanticModuleHash,
    semanticLexiconHash: request.semanticLexiconHash,
    requests: [request],
    diagnostics: ["Hypotheses are non-authoritative"],
  });
  const receipt = (model: string, confidence: number) =>
    sealAssetSemanticHypothesisReceipt({
      requestHash: request.hash,
      sourceContentHash: request.sourceContentHash,
      measurementHash: request.measurementHash,
      renderEvidenceHash: request.renderEvidenceHash,
      semanticModuleHash: request.semanticModuleHash,
      semanticLexiconHash: request.semanticLexiconHash,
      adapterHash: contentHash(`adapter:${model}`),
      modelImplementationHash: contentHash(`model:${model}`),
      assertions: sealSemanticAssertionBundle({
        authority: "hypothesis",
        hypothesisSourceHash: request.hash,
        assertions: [
          {
            assertionKind: "denotation",
            subject: { kind: "catalog_asset", id: fixture.asset.assetId },
            concept: fixture.declaration.semantic.denotation,
            confidence,
          },
          {
            assertionKind: "realization_form",
            subject: { kind: "catalog_asset", id: fixture.asset.assetId },
            realizationForm: "whole",
            confidence,
          },
        ],
        abstentions: [],
      }),
      diagnostics: [],
      resourceUse: { inputTokens: 10, outputTokens: 4, computeMilliseconds: 2 },
    });
  const receipts = sealCatalogHypothesisReceiptSet({
    status: "eligible",
    requestSetHash: requests.hash,
    receipts: [receipt("first", 0.99), receipt("second", 0.51)],
    missingRequestHashes: [],
    diagnostics: [],
  });
  const panel = buildCatalogHypothesisPanel({
    policy: DEFAULT_CATALOG_ADMISSION_POLICY,
    requests,
    receipts,
  });
  assert.equal(panel.items[0]?.outcome, "consensus");
  assert.equal("confidence" in panel.items[0]!.consensusSignature!, false);

  const embedding = sealCatalogVisualEmbeddingReceipt({
    sourceContentHash: fixture.asset.source.contentHash,
    renderEvidenceHash: request.renderEvidenceHash,
    embeddingImplementationHash: contentHash("embedding-model"),
    values: [100, 0, 10, 0, 3, 0, 0, 1],
  });
  const embeddingSet = sealCatalogVisualEmbeddingSet({
    visualReviewIndexHash: requests.visualReviewIndexHash,
    embeddingImplementationHash: embedding.embeddingImplementationHash,
    expectedSourceContentHashes: [fixture.asset.source.contentHash],
    receipts: [embedding],
  });
  const measurements = {
    kind: "CatalogMeasurementSet" as const,
    status: "eligible" as const,
    sourceManifestHash: contentHash("panel-source-manifest"),
    assets: [fixture.asset],
    diagnostics: [],
    hash: requests.measurementSetHash,
  };
  const cohorts = buildCatalogAdmissionCohorts({
    policy: DEFAULT_CATALOG_ADMISSION_POLICY,
    panel,
    measurements,
    visualEmbeddings: embeddingSet,
    styleProfileHandle: "neutral",
  });
  assert.equal(cohorts.cohorts.length, 1);
  const reviewPlan = buildCatalogReviewPlan({
    policy: DEFAULT_CATALOG_ADMISSION_POLICY,
    panel,
    cohorts,
    measurements,
    visualEmbeddings: embeddingSet,
  });
  assert.equal(reviewPlan.selectedSourceCount, 1);
  assert.equal(reviewPlan.representedSourceCount, 1);

  const cohort = cohorts.cohorts[0]!;
  const decision = sealCatalogCohortDecision({
    policyHash: DEFAULT_CATALOG_ADMISSION_POLICY.hash,
    cohortId: cohort.cohortId,
    cohortHash: cohort.hash,
    reviewPlanHash: reviewPlan.hash,
    authorityId: "test_curator",
    reviewedSamples: [
      {
        sourceContentHash: fixture.asset.source.contentHash,
        finding: "conforms",
        note: "The sample matches the exact denotation, whole-object form, and visual cohort.",
      },
    ],
    action: {
      kind: "admit_substitution_set",
      entryHandle: "panel_tree_set",
      styleProfileHandle: "neutral",
      selectionWeight: 1,
    },
    rationale: "Two independent hypotheses agree and the required cohort sample conforms.",
  });
  const admitted = applyCatalogAdmissionDecisions({
    policy: DEFAULT_CATALOG_ADMISSION_POLICY,
    module,
    measurements,
    receipts,
    panel,
    cohorts,
    reviewPlan,
    decisions: [decision],
    audits: [],
    existingDeclarations: [],
    existingAssertions: [],
    existingDispositions: [
      {
        sourceContentHash: fixture.asset.source.contentHash,
        status: "incomplete",
        reason: "Awaiting cohort decision",
      },
    ],
  });
  assert.equal(admitted.status, "eligible");
  assert.equal(admitted.declarations[0]?.kind, "substitution_set");
  assert.equal(admitted.dispositions[0]?.status, "eligible");
  assert.ok(admitted.assertions[0]?.assertions.every((assertion) => !("confidence" in assertion)));

  const snapshot = sealCatalogSnapshot({
    semanticModule: module,
    semanticAssertions: admitted.assertions,
    styleProfiles: [fixture.styleProfile],
    assets: [fixture.asset],
    declarations: admitted.declarations,
    dispositions: admitted.dispositions,
    sourceContentHashes: [fixture.asset.source.contentHash],
  });
  assert.equal(snapshot.status, "eligible");
});

test("a failed independent audit blocks cohort materialization", async () => {
  const module = await loadSemanticRegistry();
  const fixture = await catalogFixture(module);
  const request = sealAssetSemanticHypothesisRequest({
    sourceContentHash: fixture.asset.source.contentHash,
    measurementHash: fixture.asset.hash,
    renderEvidenceHash: contentHash("audit-render"),
    semanticModuleHash: module.snapshot.hash,
    semanticLexiconHash: contentHash("audit-lexicon"),
    requestedConceptIds: [fixture.declaration.semantic.denotation.conceptId],
  });
  const requests = sealCatalogHypothesisRequestSet({
    status: "eligible",
    measurementSetHash: contentHash("audit-measurements"),
    visualReviewIndexHash: contentHash("audit-review"),
    semanticModuleHash: request.semanticModuleHash,
    semanticLexiconHash: request.semanticLexiconHash,
    requests: [request],
    diagnostics: [],
  });
  const makeReceipt = (suffix: string) =>
    sealAssetSemanticHypothesisReceipt({
      requestHash: request.hash,
      sourceContentHash: request.sourceContentHash,
      measurementHash: request.measurementHash,
      renderEvidenceHash: request.renderEvidenceHash,
      semanticModuleHash: request.semanticModuleHash,
      semanticLexiconHash: request.semanticLexiconHash,
      adapterHash: contentHash(`audit-adapter:${suffix}`),
      modelImplementationHash: contentHash(`audit-model:${suffix}`),
      assertions: sealSemanticAssertionBundle({
        authority: "hypothesis",
        hypothesisSourceHash: request.hash,
        assertions: [
          {
            assertionKind: "denotation",
            subject: { kind: "catalog_asset", id: fixture.asset.assetId },
            concept: fixture.declaration.semantic.denotation,
            confidence: 1,
          },
          {
            assertionKind: "realization_form",
            subject: { kind: "catalog_asset", id: fixture.asset.assetId },
            realizationForm: "whole",
            confidence: 1,
          },
        ],
        abstentions: [],
      }),
      diagnostics: [],
      resourceUse: { inputTokens: 1, outputTokens: 1, computeMilliseconds: 1 },
    });
  const receipts = sealCatalogHypothesisReceiptSet({
    status: "eligible",
    requestSetHash: requests.hash,
    receipts: [makeReceipt("a"), makeReceipt("b")],
    missingRequestHashes: [],
    diagnostics: [],
  });
  const panel = buildCatalogHypothesisPanel({
    policy: DEFAULT_CATALOG_ADMISSION_POLICY,
    requests,
    receipts,
  });
  const embedding = sealCatalogVisualEmbeddingReceipt({
    sourceContentHash: fixture.asset.source.contentHash,
    renderEvidenceHash: request.renderEvidenceHash,
    embeddingImplementationHash: contentHash("audit-embedding"),
    values: [1, 1, 1, 1, 1, 1, 1, 1],
  });
  const embeddings = sealCatalogVisualEmbeddingSet({
    visualReviewIndexHash: requests.visualReviewIndexHash,
    embeddingImplementationHash: embedding.embeddingImplementationHash,
    expectedSourceContentHashes: [fixture.asset.source.contentHash],
    receipts: [embedding],
  });
  const measurements = {
    kind: "CatalogMeasurementSet" as const,
    status: "eligible" as const,
    sourceManifestHash: contentHash("audit-source"),
    assets: [fixture.asset],
    diagnostics: [],
    hash: requests.measurementSetHash,
  };
  const cohorts = buildCatalogAdmissionCohorts({
    policy: DEFAULT_CATALOG_ADMISSION_POLICY,
    panel,
    measurements,
    visualEmbeddings: embeddings,
    styleProfileHandle: "neutral",
  });
  const reviewPlan = buildCatalogReviewPlan({
    policy: DEFAULT_CATALOG_ADMISSION_POLICY,
    panel,
    cohorts,
    measurements,
    visualEmbeddings: embeddings,
  });
  const cohort = cohorts.cohorts[0]!;
  const decision = sealCatalogCohortDecision({
    policyHash: DEFAULT_CATALOG_ADMISSION_POLICY.hash,
    cohortId: cohort.cohortId,
    cohortHash: cohort.hash,
    reviewPlanHash: reviewPlan.hash,
    authorityId: "test_curator",
    reviewedSamples: [
      {
        sourceContentHash: fixture.asset.source.contentHash,
        finding: "conforms",
        note: "Initial review passed.",
      },
    ],
    action: {
      kind: "admit_substitution_set",
      entryHandle: "audited_tree_set",
      styleProfileHandle: "neutral",
      selectionWeight: 1,
    },
    rationale: "Initial evidence supports admission.",
  });
  const failedAudit = sealCatalogCohortAudit({
    policyHash: DEFAULT_CATALOG_ADMISSION_POLICY.hash,
    cohortHash: cohort.hash,
    decisionHash: decision.hash,
    auditorId: "test_auditor",
    samples: [
      {
        sourceContentHash: fixture.asset.source.contentHash,
        finding: "violation",
        diagnostic: "Independent audit found a semantic mismatch.",
      },
    ],
  });
  const result = applyCatalogAdmissionDecisions({
    policy: DEFAULT_CATALOG_ADMISSION_POLICY,
    module,
    measurements,
    receipts,
    panel,
    cohorts,
    reviewPlan,
    decisions: [decision],
    audits: [failedAudit],
    existingDeclarations: [],
    existingAssertions: [],
    existingDispositions: [
      {
        sourceContentHash: fixture.asset.source.contentHash,
        status: "incomplete",
        reason: "Awaiting audit",
      },
    ],
  });
  assert.equal(result.status, "incomplete");
  assert.equal(result.declarations.length, 0);
  assert.match(result.diagnostics[0]!, /failed audit/u);
});

test("visual evidence splits semantic peers deterministically and independently of input order", async () => {
  const module = await loadSemanticRegistry();
  const fixture = await catalogFixture(module);
  const { kind: _assetKind, assetId: _assetId, hash: _assetHash, ...assetMaterial } = fixture.asset;
  const secondSourceHash = contentHash("catalog-fixture-visually-distinct-source");
  const secondAsset = sealCatalogAssetArtifact({
    ...assetMaterial,
    source: {
      ...assetMaterial.source,
      contentHash: secondSourceHash,
      sourceArtifact: {
        ...assetMaterial.source.sourceArtifact!,
        artifactHash: secondSourceHash,
      },
    },
  });
  const lexiconHash = contentHash("visual-cluster-lexicon");
  const visualReviewIndexHash = contentHash("visual-cluster-review-index");
  const measurementSet = sealCatalogMeasurementSet({
    sourceManifestHash: contentHash("visual-cluster-source-manifest"),
    assets: [fixture.asset, secondAsset],
    diagnostics: [],
  });
  const makeRequest = (asset: typeof fixture.asset, suffix: string) =>
    sealAssetSemanticHypothesisRequest({
      sourceContentHash: asset.source.contentHash,
      measurementHash: asset.hash,
      renderEvidenceHash: contentHash(`visual-cluster-render:${suffix}`),
      semanticModuleHash: module.snapshot.hash,
      semanticLexiconHash: lexiconHash,
      requestedConceptIds: [fixture.declaration.semantic.denotation.conceptId],
    });
  const firstRequest = makeRequest(fixture.asset, "first");
  const secondRequest = makeRequest(secondAsset, "second");

  const run = (reverse: boolean) => {
    const requests = sealCatalogHypothesisRequestSet({
      status: "eligible",
      measurementSetHash: measurementSet.hash,
      visualReviewIndexHash,
      semanticModuleHash: module.snapshot.hash,
      semanticLexiconHash: lexiconHash,
      requests: reverse ? [secondRequest, firstRequest] : [firstRequest, secondRequest],
      diagnostics: [],
    });
    const makeReceipt = (
      request: typeof firstRequest,
      asset: typeof fixture.asset,
      implementation: string,
    ) =>
      sealAssetSemanticHypothesisReceipt({
        requestHash: request.hash,
        sourceContentHash: request.sourceContentHash,
        measurementHash: request.measurementHash,
        renderEvidenceHash: request.renderEvidenceHash,
        semanticModuleHash: request.semanticModuleHash,
        semanticLexiconHash: request.semanticLexiconHash,
        adapterHash: contentHash(`visual-cluster-adapter:${implementation}`),
        modelImplementationHash: contentHash(`visual-cluster-model:${implementation}`),
        assertions: sealSemanticAssertionBundle({
          authority: "hypothesis",
          hypothesisSourceHash: request.hash,
          assertions: [
            {
              assertionKind: "denotation",
              subject: { kind: "catalog_asset", id: asset.assetId },
              concept: fixture.declaration.semantic.denotation,
              confidence: 0.95,
            },
            {
              assertionKind: "realization_form",
              subject: { kind: "catalog_asset", id: asset.assetId },
              realizationForm: "whole",
              confidence: 0.95,
            },
          ],
          abstentions: [],
        }),
        diagnostics: [],
        resourceUse: { inputTokens: 1, outputTokens: 1, computeMilliseconds: 1 },
      });
    const receiptValues = [
      makeReceipt(firstRequest, fixture.asset, "one"),
      makeReceipt(firstRequest, fixture.asset, "two"),
      makeReceipt(secondRequest, secondAsset, "one"),
      makeReceipt(secondRequest, secondAsset, "two"),
    ];
    const receipts = sealCatalogHypothesisReceiptSet({
      status: "eligible",
      requestSetHash: requests.hash,
      receipts: reverse ? receiptValues.reverse() : receiptValues,
      missingRequestHashes: [],
      diagnostics: [],
    });
    const panel = buildCatalogHypothesisPanel({
      policy: DEFAULT_CATALOG_ADMISSION_POLICY,
      requests,
      receipts,
    });
    const embeddingImplementationHash = contentHash("visual-cluster-embedding-model");
    const embeddingValues = [
      sealCatalogVisualEmbeddingReceipt({
        sourceContentHash: fixture.asset.source.contentHash,
        renderEvidenceHash: firstRequest.renderEvidenceHash,
        embeddingImplementationHash,
        values: [100, 0, 0, 0, 0, 0, 0, 1],
      }),
      sealCatalogVisualEmbeddingReceipt({
        sourceContentHash: secondAsset.source.contentHash,
        renderEvidenceHash: secondRequest.renderEvidenceHash,
        embeddingImplementationHash,
        values: [0, 100, 0, 0, 0, 0, 0, 1],
      }),
    ];
    const embeddings = sealCatalogVisualEmbeddingSet({
      visualReviewIndexHash,
      embeddingImplementationHash,
      expectedSourceContentHashes: reverse
        ? [secondAsset.source.contentHash, fixture.asset.source.contentHash]
        : [fixture.asset.source.contentHash, secondAsset.source.contentHash],
      receipts: reverse ? embeddingValues.reverse() : embeddingValues,
    });
    return buildCatalogAdmissionCohorts({
      policy: DEFAULT_CATALOG_ADMISSION_POLICY,
      panel,
      measurements: measurementSet,
      visualEmbeddings: embeddings,
      styleProfileHandle: "neutral",
    });
  };

  const forward = run(false);
  const reversed = run(true);
  assert.equal(forward.cohorts.length, 2);
  assert.equal(forward.hash, reversed.hash);
  assert.equal(stableJson(forward), stableJson(reversed));
});

test("the tracked catalog commit is deterministic and self-contained for authority", async () => {
  const module = await loadSemanticRegistry();
  const fixture = await catalogFixture(module);
  const sourceManifest = {
    kind: "TrustedSourceManifest" as const,
    rightsNotice: "registry/rights-note.md",
    packages: [
      {
        packageId: "fixture_pack",
        archivePaths: [],
        assetRoots: ["registry/source-assets/fixture_pack"],
        sourceKind: "creator_owned" as const,
        licenseId: "fixture-license",
        commercialUsePermitted: true,
        redistributionPermitted: true,
        attribution: "Synthetic test fixture",
        files: [
          {
            relativePath: "registry/source-assets/fixture_pack/tree.glb",
            sha256: fixture.asset.source.contentHash,
            metersPerSourceUnit: 1,
          },
        ],
      },
    ],
  };
  const measurements = sealCatalogMeasurementSet({
    sourceManifestHash: contentHash(stableJson(sourceManifest)),
    assets: [fixture.asset],
    diagnostics: [],
  });
  const retainedMeasurements = {
    kind: "CatalogMeasurementSet",
    relativePath: `registry/evidence/${measurements.hash}.json`,
    artifactHash: measurements.hash,
    bytesHash: contentHash("committed-measurement-bytes"),
    bytes: 1,
  };
  const input = {
    sourceManifest,
    semanticModuleHash: module.snapshot.hash,
    semanticLexiconHash: contentHash("commit-lexicon"),
    measurementSetHash: measurements.hash,
    snapshot: fixture.snapshot,
    styleProfiles: [fixture.styleProfile].map(({ kind: _kind, hash: _hash, ...entry }) => entry),
    declarations: [fixture.declaration],
    assertions: [fixture.assertions],
    dispositions: [
      {
        sourceContentHash: fixture.asset.source.contentHash,
        status: "eligible" as const,
        usage: {
          kind: "entry_member" as const,
          entryHandle: fixture.declaration.handle,
          memberId: fixture.declaration.members[0]!.memberId,
        },
      },
    ],
    admissionPolicy: DEFAULT_CATALOG_ADMISSION_POLICY,
    cohortDecisions: [],
    audits: [],
    retainedEvidence: [retainedMeasurements],
  };
  const first = sealCatalogAuthorityCommit(input);
  const second = sealCatalogAuthorityCommit(input);
  assert.equal(first.hash, second.hash);
  assert.equal(first.snapshot.hash, fixture.snapshot.hash);
  assert.equal(first.sourcePayloadPolicy, "external_content_addressed");
  assert.equal(first.retainedEvidence[0]?.artifactHash, measurements.hash);
  assert.equal(stableJson(first.declarations), stableJson([fixture.declaration]));
  assert.throws(
    () => sealCatalogAuthorityCommit({ ...input, retainedEvidence: [] }),
    /measurement set must be retained/iu,
  );
});
