import assert from "node:assert/strict";
import test from "node:test";
import {
  ASSET_SEMANTIC_HYPOTHESIS_RECEIPT_SCHEMA,
  CATALOG_ADMISSION_POLICY_SCHEMA,
  CATALOG_FEATURE_SET_SCHEMA,
  CATALOG_RENDER_EVIDENCE_SCHEMA,
  CATALOG_REVIEW_VIEWPOINTS,
  exactAcceptanceSampleSize,
  sealAssetSemanticHypothesisReceipt,
  sealAssetSemanticHypothesisRequest,
  sealCatalogAdmissionPolicy,
  sealCatalogAuthorityCommit,
  sealCatalogFeatureReceipt,
  sealCatalogFeatureSet,
  sealCatalogHypothesisReceiptSet,
  sealCatalogHypothesisRequestSet,
  sealCatalogRenderEvidence,
} from "@basalt/catalog-authoring";
import { sealCatalogMeasurementSet, sourceAssetRelativePath } from "@basalt/catalog-model";
import { contentHash, stableJson } from "@basalt/contracts";
import { sealSemanticAssertionBundle } from "@basalt/semantic-kernel";
import { catalogFixture } from "./helpers/catalog-fixture.js";
import { loadSemanticRegistry } from "./helpers/semantic-registry.js";

function admissionPolicy() {
  return sealCatalogAdmissionPolicy({
    policyId: "catalog_qualification_test",
    pilot: {
      groupsPerRole: 2,
      selectionSeedHash: contentHash("pilot-selection"),
      requireStatic: true,
      requireSinglePart: true,
      requireSingleMaterial: true,
      requireBottomContact: true,
    },
    prediction: {
      requiredAssertionKinds: [
        "affordance",
        "denotation",
        "realization_form",
        "state",
        "surface_treatment",
      ],
      minimumDependencyGroups: 2,
      minimumCalibrationSamples: 50,
      calibrationConfidenceMillionths: 950_000,
      minimumPrecisionLowerBoundMillionths: 950_000,
      maximumPredictionSetSize: 4,
      noveltyThresholdMillionths: 700_000,
    },
    substitution: {
      requiredFeatureChannels: ["appearance", "shape"],
      minimumSimilarityMillionthsByChannel: {
        appearance: 880_000,
        semantics: 950_000,
        shape: 900_000,
      },
      maximumAxisRatioMillionths: 2_500_000,
    },
    riskTargets: [
      {
        riskId: "semantic_identity",
        stratumId: "semantic_boundary",
        defectDomain: "semantics",
        subjectKind: "asset",
        maximumDefectRateMillionths: 50_000,
        confidenceMillionths: 950_000,
        acceptanceNumber: 0,
      },
    ],
    automaticallyAdmissibleEntryKinds: ["substitution_set"],
  });
}

test("catalog render evidence requires the canonical multiview rig and every channel", () => {
  const evidence = sealCatalogRenderEvidence({
    sourceContentHash: contentHash("source"),
    rendererImplementationHash: contentHash("renderer"),
    cameraRigHash: contentHash("camera"),
    lightingHash: contentHash("lighting"),
    materialModeHash: contentHash("materials"),
    channelEncodingHash: contentHash("channel-encoding"),
    views: CATALOG_REVIEW_VIEWPOINTS.map((view) => ({
      ...view,
      rgbHash: contentHash(`${view.viewId}:rgb`),
      silhouetteHash: contentHash(`${view.viewId}:silhouette`),
      normalizedDepthHash: contentHash(`${view.viewId}:depth`),
      surfaceNormalHash: contentHash(`${view.viewId}:normal`),
      unlitBaseColorHash: contentHash(`${view.viewId}:base-color`),
    })),
  });

  assert.equal(evidence.views.length, 12);
  assert.equal(CATALOG_RENDER_EVIDENCE_SCHEMA.parse(evidence).hash, evidence.hash);
  assert.throws(
    () => CATALOG_RENDER_EVIDENCE_SCHEMA.parse({ ...evidence, views: evidence.views.slice(1) }),
    /12|length/iu,
  );
});

test("admission policy is sealed, deterministic, and requires every feature threshold", () => {
  const first = admissionPolicy();
  const second = admissionPolicy();
  assert.equal(first.hash, second.hash);
  assert.equal(CATALOG_ADMISSION_POLICY_SCHEMA.parse(first).hash, first.hash);
  assert.throws(
    () =>
      CATALOG_ADMISSION_POLICY_SCHEMA.parse({
        ...first,
        substitution: {
          ...first.substitution,
          minimumSimilarityMillionthsByChannel: {
            appearance: 880_000,
            semantics: 950_000,
          },
        },
      }),
    /shape|threshold/iu,
  );
});

test("inference receipts are deterministic hypotheses and never compiler authority", () => {
  const promptTemplateHash = contentHash("hypothesis-prompt-template");
  const request = sealAssetSemanticHypothesisRequest({
    sourceContentHash: contentHash("hypothesis-source"),
    measurementHash: contentHash("hypothesis-measurement"),
    renderEvidenceHash: contentHash("hypothesis-render"),
    sourceNameHintHash: contentHash("hypothesis-source-name-hint"),
    semanticModuleHash: contentHash("hypothesis-module"),
    semanticLexiconHash: contentHash("hypothesis-lexicon"),
    promptTemplateHash,
    evidenceSelection: {
      channels: ["appearance", "semantics"],
      viewIds: CATALOG_REVIEW_VIEWPOINTS.map((view) => view.viewId),
      includeMeasurements: true,
      includeSourceNameHint: true,
      selectorImplementationHash: contentHash("hypothesis-evidence-selector"),
    },
    ablation: "combined",
    requestedAssertionKinds: [
      "affordance",
      "denotation",
      "realization_form",
      "state",
      "surface_treatment",
    ],
    requestedConceptIds: ["bsc_000003"],
  });
  const requests = sealCatalogHypothesisRequestSet({
    status: "eligible",
    measurementSetHash: contentHash("hypothesis-measurement-set"),
    visualReviewIndexHash: contentHash("hypothesis-review-index"),
    sourceNameHintSetHash: contentHash("hypothesis-source-name-hint-set"),
    semanticModuleHash: request.semanticModuleHash,
    semanticLexiconHash: request.semanticLexiconHash,
    promptTemplateHash,
    requests: [request],
    diagnostics: [],
  });
  const assertions = sealSemanticAssertionBundle({
    authority: "hypothesis",
    hypothesisSourceHash: request.hash,
    assertions: [],
    abstentions: ["Insufficient evidence"],
  });
  const input = {
    requestHash: request.hash,
    sourceContentHash: request.sourceContentHash,
    measurementHash: request.measurementHash,
    renderEvidenceHash: request.renderEvidenceHash,
    sourceNameHintHash: request.sourceNameHintHash,
    semanticModuleHash: request.semanticModuleHash,
    semanticLexiconHash: request.semanticLexiconHash,
    ablation: request.ablation,
    adapterId: "test_vision_adapter",
    adapterImplementationHash: contentHash("vision-adapter"),
    modelImplementationHash: contentHash("vision-model"),
    dependencyGroupId: "test_visual_model",
    promptHash: promptTemplateHash,
    rawOutputHash: contentHash("vision-output"),
    normalizationImplementationHash: contentHash("vision-normalizer"),
    inference: {
      seed: 0,
      scoreNormalization: "softmax_per_facet" as const,
      maximumCandidatesPerFacet: 4,
    },
    assertions,
    facetScores: [],
    noveltyScoreMillionths: 1_000_000,
    diagnostics: [],
    workload: { inputArtifactCount: 12, renderedViewCount: 12, candidateValueCount: 0 },
  };
  const first = sealAssetSemanticHypothesisReceipt(input);
  const second = sealAssetSemanticHypothesisReceipt(input);
  const receiptSet = sealCatalogHypothesisReceiptSet({
    status: "eligible",
    requestSetHash: requests.hash,
    receipts: [first],
    missingRequestHashes: [],
    diagnostics: [],
  });

  assert.equal(first.hash, second.hash);
  assert.equal(first.compilerAuthority, false);
  assert.equal(receiptSet.status, "eligible");
  assert.equal("timestamp" in first, false);
  assert.throws(
    () =>
      ASSET_SEMANTIC_HYPOTHESIS_RECEIPT_SCHEMA.parse({
        ...first,
        assertions: sealSemanticAssertionBundle({
          authority: "hypothesis",
          hypothesisSourceHash: contentHash("another-request"),
          assertions: [],
          abstentions: [],
        }),
      }),
    /exact request|hash mismatch/iu,
  );
});

test("feature evidence is canonical and missing channels remain incomplete", () => {
  const sourceContentHash = contentHash("feature-source");
  const renderEvidenceHash = contentHash("feature-render");
  const feature = (channel: "appearance" | "shape") =>
    sealCatalogFeatureReceipt({
      sourceContentHash,
      renderEvidenceHash,
      channel,
      modelImplementationHash: contentHash(`${channel}:model`),
      preprocessingImplementationHash: contentHash(`${channel}:preprocess`),
      aggregationImplementationHash: contentHash(`${channel}:aggregate`),
      perView: CATALOG_REVIEW_VIEWPOINTS.map((view, index) => ({
        viewId: view.viewId,
        feature: { scaleMillionths: 1, values: [index + 1, 1, 1, 1, 1, 1, 1, 1] },
      })),
      aggregate: { scaleMillionths: 1, values: [1, 1, 1, 1, 1, 1, 1, 1] },
      maximumViewDisagreementMillionths: 1_000,
    });
  const appearance = feature("appearance");
  const shape = feature("shape");
  const expected = ["appearance", "shape"].map((channel) => ({
    sourceContentHash,
    channel: channel as "appearance" | "shape",
  }));
  const complete = sealCatalogFeatureSet({
    pilotPlanHash: contentHash("feature-plan"),
    visualReviewIndexHash: contentHash("feature-review"),
    expected,
    receipts: [shape, appearance],
  });
  const incomplete = sealCatalogFeatureSet({
    pilotPlanHash: complete.pilotPlanHash,
    visualReviewIndexHash: complete.visualReviewIndexHash,
    expected,
    receipts: [appearance],
  });

  assert.equal(complete.status, "eligible");
  assert.deepEqual(
    complete.receipts.map((entry) => entry.channel),
    ["appearance", "shape"],
  );
  assert.equal(CATALOG_FEATURE_SET_SCHEMA.parse(complete).hash, complete.hash);
  assert.equal(incomplete.status, "incomplete");
  assert.deepEqual(incomplete.missing, [{ sourceContentHash, channel: "shape" }]);
});

test("finite-population acceptance sampling is exact and deterministic", () => {
  const first = exactAcceptanceSampleSize({
    populationCount: 100,
    designDefectCount: 5,
    acceptanceNumber: 0,
    confidenceMillionths: 950_000,
  });
  const second = exactAcceptanceSampleSize({
    populationCount: 100,
    designDefectCount: 5,
    acceptanceNumber: 0,
    confidenceMillionths: 950_000,
  });
  assert.deepEqual(first, second);
  assert.ok(first.sampleCount > 0 && first.sampleCount <= 100);
  assert.ok(first.acceptanceProbabilityMillionths <= 50_000);
});

test("the tracked catalog root retains exact evidence and qualification receipts", async () => {
  const module = await loadSemanticRegistry();
  const fixture = await catalogFixture(module);
  const provenanceHash = contentHash("fixture-source-provenance");
  const sourceManifest = {
    kind: "TrustedSourceManifest" as const,
    rightsNotice: "registry/rights-note.md",
    assetRoot: "registry/source-assets/sha256" as const,
    assets: [
      {
        contentHash: fixture.asset.source.contentHash,
        relativePath: sourceAssetRelativePath(fixture.asset.source.contentHash),
        metersPerSourceUnit: 1,
        rights: {
          licenseId: "fixture-license",
          commercialUsePermitted: true,
          redistributionPermitted: true,
          attribution: "Synthetic test fixture",
          evidenceHash: provenanceHash,
        },
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
    admissionPolicy: admissionPolicy(),
    qualificationReceipts: [],
    retainedEvidence: [retainedMeasurements],
  };
  const first = sealCatalogAuthorityCommit(input);
  const second = sealCatalogAuthorityCommit(input);

  assert.equal(first.hash, second.hash);
  assert.equal(first.snapshot.hash, fixture.snapshot.hash);
  assert.equal(first.sourcePayloadPolicy, "external_content_addressed");
  assert.throws(
    () => sealCatalogAuthorityCommit({ ...input, retainedEvidence: [] }),
    /measurement set must be retained/iu,
  );
});
