import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  ASSET_SEARCH_METADATA_REQUEST_SCHEMA,
  CATALOG_ADMISSION_POLICY_SCHEMA,
  CATALOG_EMBEDDING_MATRIX_SCHEMA,
  CATALOG_REVIEW_VIEWPOINTS,
  CATALOG_SEARCH_INDEX_SCHEMA,
  CATALOG_SEARCH_RESULT_SET_SCHEMA,
  CATALOG_SEARCH_SMOKE_FIXTURE_SCHEMA,
  CATALOG_SEARCH_METADATA_JSON_SCHEMA_HASH,
  CATALOG_SEARCH_METADATA_SCHEMA,
  CATALOG_SEARCH_TOKENIZER_IMPLEMENTATION_HASH,
  CATALOG_SOURCE_NAME_HINT_SET_SCHEMA,
  annotateCatalogSearchResults,
  assessConstructionEligibility,
  buildCatalogSearchIndex,
  contextReceiptMatchesRequest,
  createAssetContextCandidate,
  decodeCatalogEmbeddingMatrix,
  decideCatalogSearchOutcome,
  encodeCatalogEmbeddingMatrix,
  exactAcceptanceSampleSize,
  executeCatalogSearch,
  metadataReceiptMatchesExecution,
  sealAssetSearchMetadataReceipt,
  sealAssetSearchMetadataRequest,
  sealAssetContextHypothesisReceipt,
  sealAssetContextHypothesisRequest,
  sealCatalogAdmissionPolicy,
  sealCatalogAuthoredMetadataBatch,
  sealCatalogAuthoredMetadataSetManifest,
  sealCatalogAuthoredMetadataReview,
  sealCatalogAuthoredSearchMetadataSet,
  sealCatalogAcceptanceAudit,
  sealCatalogAuthorityCommit,
  sealCatalogCandidateDecisionPolicy,
  sealCatalogEmbeddingReceipt,
  sealCatalogEmbeddingSet,
  sealCatalogQueryEmbeddingReceipt,
  sealCatalogSearchMetadataSet,
  sealCatalogSearchPolicy,
  sealCatalogSearchQuery,
  sealCatalogSearchValidationRequest,
  sealCatalogValidationReceipt,
  tokenizeCatalogSearchText,
  validationReceiptMatchesExecution,
  type CatalogSearchMetadata,
} from "@basalt/catalog-authoring";
import {
  sealCatalogAssetArtifact,
  sealCatalogMeasurementSet,
  sourceAssetRelativePath,
} from "@basalt/catalog-model";
import { contentHash, quantizeQ32_32, stableJson } from "@basalt/contracts";
import { catalogFixture } from "./helpers/catalog-fixture.js";
import { loadSemanticRegistry } from "./helpers/semantic-registry.js";

const hash = (label: string): string => contentHash(label);
const modelCommitHash = hash("metadata-model-commit");

function admissionPolicy() {
  return sealCatalogAdmissionPolicy({
    policyId: "catalog_authority_test",
    riskTargets: [
      {
        riskId: "false_admission",
        stratumId: "all_admissions",
        defectDomain: "semantics",
        subjectKind: "asset",
        maximumDefectRateMillionths: 10_000,
        confidenceMillionths: 950_000,
        acceptanceNumber: 0,
      },
    ],
  });
}

function searchPolicy() {
  return sealCatalogSearchPolicy({
    policyId: "catalog_search_test",
    origin: "Deterministic catalog search regression fixture",
    fieldWeights: {
      alternateNouns: 3,
      caption: 3,
      colors: 2,
      environments: 1,
      materials: 2,
      primaryNoun: 4,
      sourceBasename: 1,
      styleTerms: 2,
      useCases: 1,
      visibleText: 2,
    },
    reciprocalRankConstant: 60,
    fusionNormalization: "per_document_available_channels",
    tokenizerImplementationHash: CATALOG_SEARCH_TOKENIZER_IMPLEMENTATION_HASH,
  });
}

const observed = <T>(value: T) => ({ status: "observed" as const, value });
const abstained = (reason: string) => ({ status: "abstained" as const, reason });

function treeMetadata(): CatalogSearchMetadata {
  return CATALOG_SEARCH_METADATA_SCHEMA.parse({
    caption: observed("A stylized green tree with a broad leafy crown."),
    primaryNoun: observed("Tree"),
    alternateNouns: observed(["tree", "woody plant", "tree"]),
    materials: observed(["bark", "leaves"]),
    colors: observed(["brown", "green"]),
    visibleText: abstained("No visible text."),
    useCases: observed(["forest scenery"]),
    environments: observed(["forest", "park"]),
    styleTerms: observed(["Low Poly", "stylized"]),
    visualComposition: observed("single_object"),
    sourceRoleHint: observed("standalone"),
    completeness: observed("complete"),
    visibleDamage: observed("intact"),
    issueNotes: abstained("No visible issue."),
  });
}

function metadataRequest(
  mode: "visual_and_name" | "visual_only",
  sourceContentHash = hash("metadata-source"),
  measurementHash = hash(`${sourceContentHash}:measurement`),
) {
  return sealAssetSearchMetadataRequest({
    sourceContentHash,
    measurementHash,
    renderEvidenceHash: hash(`${sourceContentHash}:render`),
    ...(mode === "visual_and_name"
      ? { sourceNameHintHash: hash(`${sourceContentHash}:name`) }
      : {}),
    evidenceMode: mode,
    metricSummary: metricSummary(sourceContentHash, measurementHash),
    viewSet: "canonical_twelve",
    promptTemplateHash: hash("metadata-prompt"),
    preprocessingImplementationHash: hash("metadata-preprocessor"),
    selectedRgbViews: CATALOG_REVIEW_VIEWPOINTS.map((view) => ({
      viewId: view.viewId,
      rgbHash: hash(`${sourceContentHash}:${view.viewId}:rgb`),
    })),
  });
}

function metadataReceipt(request = metadataRequest("visual_and_name")) {
  return sealAssetSearchMetadataReceipt({
    request,
    status: "eligible",
    adapterId: "test_vlm_adapter",
    adapterImplementationHash: hash("metadata-adapter"),
    workerImplementationHash: hash("metadata-worker"),
    runtimeImplementationHash: hash("metadata-runtime"),
    modelId: "qwen_test",
    modelCommitHash,
    promptHash: hash("rendered-metadata-prompt"),
    rawOutputHash: hash("metadata-raw-output"),
    metadata: treeMetadata(),
    diagnostics: [],
    resourceUsage: {
      inputImageCount: 12,
      inputPixels: 1_000_000,
      inputTokens: 100,
      outputTokens: 200,
      elapsedMilliseconds: 1_000,
      peakResidentBytes: 1024,
      gpuMilliseconds: 900,
    },
  });
}

test("metadata requests isolate names and bind every selected render", () => {
  const visual = metadataRequest("visual_only");
  const combined = metadataRequest("visual_and_name");
  const renamed = sealAssetSearchMetadataRequest({
    ...stripArtifact(combined),
    sourceNameHintHash: hash("another-name-hint"),
  });

  assert.equal(visual.sourceNameHintHash, undefined);
  assert.equal("semanticModuleHash" in visual, false);
  assert.equal("semanticLexiconHash" in visual, false);
  assert.notEqual(combined.hash, renamed.hash);
  assert.equal(combined.outputSchemaHash, CATALOG_SEARCH_METADATA_JSON_SCHEMA_HASH);
  assert.throws(
    () =>
      ASSET_SEARCH_METADATA_REQUEST_SCHEMA.parse({
        ...visual,
        sourceNameHintHash: hash("forbidden-name"),
      }),
    /Only visual-and-name|hash mismatch/iu,
  );
});

test("agent-authored metadata stays provenance-distinct while enriching search", async () => {
  const semantic = await loadSemanticRegistry();
  const fixture = await catalogFixture(semantic);
  const measurements = sealCatalogMeasurementSet({
    sourceManifestHash: hash("authored-source-manifest"),
    assets: [fixture.asset],
    diagnostics: [],
  });
  const batch = sealCatalogAuthoredMetadataBatch({
    batchId: "authored_search_test",
    sourceManifestHash: measurements.sourceManifestHash,
    measurementSetHash: measurements.hash,
    visualReviewIndexHash: hash("authored-review-index"),
    producer: { authority: "delegated_ai", actorId: "test-producer" },
    sourceArtifactHashes: [],
    entries: [
      {
        sourceContentHash: fixture.asset.source.contentHash,
        measurementHash: fixture.asset.hash,
        renderEvidenceHash: hash("authored-render"),
        authoringCertainty: { status: "concrete" },
        metadata: treeMetadata(),
      },
    ],
  });
  const review = sealCatalogAuthoredMetadataReview({
    batchHash: batch.hash,
    reviewer: { authority: "creator", actorId: "test-creator" },
    reviewCoverage: "complete",
    reviewMethod: "direct_metadata_review",
    reviewScope: "complete_metadata",
    reviewIndependence: "independent",
    reviewerStatement: "I independently reviewed the bound render and metadata evidence.",
    reviewedAt: "2026-09-16T00:00:00.000Z",
    decisions: [
      {
        sourceContentHash: fixture.asset.source.contentHash,
        action: "accept",
        note: "The description accurately matches the visible asset.",
      },
    ],
  });
  const authored = sealCatalogAuthoredSearchMetadataSet({ batch, review });
  assert.equal(authored.qualificationExecutionAuthorized, false);
  assert.equal(authored.records[0]?.review.status, "accepted");

  const normalizerImplementationHash = hash("authored-name-normalizer");
  const sourceName = seal({
    kind: "CatalogSourceNameHint" as const,
    sourceContentHash: fixture.asset.source.contentHash,
    normalizerImplementationHash,
    interpretation: "single_normalized_name" as const,
    observations: [
      {
        originalFilename: "Ambiguous.glb",
        normalizedStem: "ambiguous",
        tokens: ["ambiguous"],
      },
    ],
    diagnostics: [],
    compilerAuthority: false as const,
  });
  const sourceNames = CATALOG_SOURCE_NAME_HINT_SET_SCHEMA.parse(
    seal({
      kind: "CatalogSourceNameHintSet" as const,
      status: "eligible" as const,
      sourceManifestHash: measurements.sourceManifestHash,
      normalizerImplementationHash,
      items: [sourceName],
      diagnostics: [],
      compilerAuthority: false as const,
    }),
  );
  const policy = searchPolicy();
  const index = buildCatalogSearchIndex({
    measurements,
    authoredMetadata: [authored],
    sourceNames,
    policy,
    buildImplementationHash: hash("authored-search-builder"),
  });
  assert.equal(index.coverage.metadata, 1);
  assert.equal(index.coverage.workerMetadata, 0);
  assert.equal(index.coverage.authoredMetadata, 1);
  assert.equal(index.documents[0]?.metadataEvidence?.kind, "authored");
  const result = executeCatalogSearch({
    index,
    policy,
    query: sealCatalogSearchQuery({
      text: "broad leafy tree",
      rankingMode: "metadata_only",
      styleTerms: [],
      constraints: { commercialUseRequired: false, redistributionRequired: false },
      limit: 1,
      validationLimit: 0,
    }),
  });
  assert.equal(result.results[0]?.sourceContentHash, fixture.asset.source.contentHash);
  assert.equal(result.results[0]?.metadataEvidenceKind, "authored");
  assert.equal(result.results[0]?.metadataEvidenceHash, authored.records[0]?.hash);
});

test("authored metadata set manifests canonically bind additive bounded batches", () => {
  const manifest = sealCatalogAuthoredMetadataSetManifest({
    sets: [
      {
        relativePath: ".basalt/catalog/metadata/second-set.json",
        setHash: hash("second-authored-set"),
      },
      {
        relativePath: ".basalt/catalog/metadata/first-set.json",
        setHash: hash("first-authored-set"),
      },
    ],
  });
  assert.deepEqual(
    manifest.sets.map((entry) => entry.relativePath),
    [".basalt/catalog/metadata/first-set.json", ".basalt/catalog/metadata/second-set.json"],
  );
});

test("direct authored review can approve visible descriptions without approving all metadata", () => {
  const review = sealCatalogAuthoredMetadataReview({
    batchHash: hash("visible-description-batch"),
    reviewer: { authority: "creator", actorId: "creator" },
    reviewCoverage: "complete",
    reviewMethod: "direct_metadata_review",
    reviewScope: "visible_description_only",
    reviewIndependence: "independent",
    reviewerStatement:
      "I directly reviewed every visible description and approve only those captions.",
    reviewedAt: "2026-09-16T00:00:00.000Z",
    decisions: [
      {
        sourceContentHash: hash("visible-description-source"),
        action: "accept",
        note: "The visible description is accurate.",
      },
    ],
  });
  assert.equal(review.reviewScope, "visible_description_only");
  assert.equal(review.basisArtifactHash, undefined);
});

test("open-vocabulary metadata normalizes set-like terms and remains non-authoritative", () => {
  const receipt = metadataReceipt();
  assert.equal(receipt.compilerAuthority, false);
  assert.equal(receipt.metadata?.primaryNoun.status, "observed");
  assert.deepEqual(
    receipt.metadata?.alternateNouns.status === "observed"
      ? receipt.metadata.alternateNouns.value
      : [],
    ["tree", "woody plant"],
  );
  assert.deepEqual(
    receipt.metadata?.styleTerms.status === "observed" ? receipt.metadata.styleTerms.value : [],
    ["low poly", "stylized"],
  );
  assert.equal("confidence" in receipt, false);
  assert.equal("timestamp" in receipt, false);
  assert.throws(
    () => CATALOG_SEARCH_METADATA_SCHEMA.parse({ primaryNoun: observed("tree") }),
    /invalid_type/iu,
  );
  const ruinComponent = CATALOG_SEARCH_METADATA_SCHEMA.parse({
    ...treeMetadata(),
    completeness: observed("intentionally_partial"),
    visibleDamage: observed("visibly_damaged"),
  });
  assert.equal(ruinComponent.completeness.status, "observed");
  assert.equal(ruinComponent.visibleDamage.status, "observed");
});

test("metadata receipt reuse binds the exact model and worker implementation", () => {
  const receipt = metadataReceipt();
  const execution = {
    modelId: receipt.modelId,
    modelCommitHash: receipt.modelCommitHash,
    workerImplementationHash: receipt.workerImplementationHash,
  };

  assert.equal(metadataReceiptMatchesExecution(receipt, execution), true);
  assert.equal(
    metadataReceiptMatchesExecution(receipt, {
      ...execution,
      workerImplementationHash: hash("changed-metadata-worker"),
    }),
    false,
  );
  assert.equal(
    metadataReceiptMatchesExecution(receipt, {
      ...execution,
      modelCommitHash: hash("changed-model-commit"),
    }),
    false,
  );
});

test("validation receipt reuse binds the exact model and worker implementation", async () => {
  const semantic = await loadSemanticRegistry();
  const fixture = await catalogFixture(semantic);
  const query = sealCatalogSearchQuery({
    text: "tree",
    rankingMode: "automatic",
    styleTerms: [],
    constraints: { commercialUseRequired: false, redistributionRequired: false },
    limit: 1,
    validationLimit: 1,
  });
  const request = sealCatalogSearchValidationRequest({
    query,
    candidate: {
      sourceContentHash: fixture.asset.source.contentHash,
      metadataReceiptHash: metadataReceipt().hash,
      measurementHash: fixture.asset.hash,
      renderEvidenceHash: hash("validation-cache-render"),
      metricSummary: metricSummary(fixture.asset.source.contentHash, fixture.asset.hash),
      selectedRgbViews: CATALOG_REVIEW_VIEWPOINTS.map((view) => ({
        viewId: view.viewId,
        rgbHash: hash(`validation-cache:${view.viewId}`),
      })),
    },
    promptTemplateHash: hash("validation-cache-prompt"),
    preprocessingImplementationHash: hash("validation-cache-preprocessor"),
  });
  const receipt = sealCatalogValidationReceipt({
    request,
    status: "eligible",
    adapterId: "test_validation_adapter",
    adapterImplementationHash: hash("validation-adapter"),
    workerImplementationHash: hash("validation-worker"),
    runtimeImplementationHash: hash("validation-runtime"),
    modelId: "qwen_test",
    modelCommitHash,
    promptHash: hash("validation-rendered-prompt"),
    rawOutputHash: hash("validation-raw-output"),
    validation: {
      verdict: "match",
      observedObjectType: observed("tree"),
      reasons: [
        "Visible tree geometry matches the request.",
        "Visible tree geometry matches the request.",
      ],
      mismatchedConstraints: [],
      visibleLimitations: [],
    },
    diagnostics: [],
    resourceUsage: {
      inputImageCount: 12,
      inputPixels: 1_000_000,
      inputTokens: 100,
      outputTokens: 50,
      elapsedMilliseconds: 500,
      peakResidentBytes: 1024,
      gpuMilliseconds: 400,
    },
  });
  const execution = {
    modelId: receipt.modelId,
    modelCommitHash: receipt.modelCommitHash,
    workerImplementationHash: receipt.workerImplementationHash,
  };

  assert.deepEqual(receipt.validation?.reasons, ["Visible tree geometry matches the request."]);
  assert.equal(validationReceiptMatchesExecution(receipt, execution), true);
  assert.equal(
    validationReceiptMatchesExecution(receipt, {
      ...execution,
      workerImplementationHash: hash("changed-validation-worker"),
    }),
    false,
  );
});

test("retrieval embeddings are deterministic int16 little-endian evidence", () => {
  const receipt = metadataReceipt();
  const image = sealCatalogEmbeddingReceipt({
    sourceContentHash: receipt.sourceContentHash,
    renderEvidenceHash: receipt.renderEvidenceHash,
    purpose: "image_text_retrieval",
    modelId: "siglip_test",
    modelCommitHash,
    modelImplementationHash: hash("siglip-implementation"),
    preprocessingImplementationHash: hash("siglip-preprocessing"),
    aggregationImplementationHash: hash("embedding-aggregation"),
    perViewEvidenceHash: hash("siglip-views"),
    aggregate: { scaleMillionths: 10, values: [1, 2, 3, 4, 5, 6, 7, 8] },
    maximumViewDisagreementMillionths: 10_000,
    gpuMilliseconds: 1,
  });
  const shape = sealCatalogEmbeddingReceipt({
    ...stripArtifact(image),
    purpose: "shape_similarity",
    modelId: "dinov3_test",
    modelImplementationHash: hash("dinov3-implementation"),
    preprocessingImplementationHash: hash("dinov3-preprocessing"),
    perViewEvidenceHash: hash("dinov3-views"),
  });
  const set = sealCatalogEmbeddingSet({
    sourceManifestHash: hash("source-manifest"),
    visualReviewIndexHash: hash("review-index"),
    expected: [
      { sourceContentHash: receipt.sourceContentHash, purpose: "shape_similarity" },
      { sourceContentHash: receipt.sourceContentHash, purpose: "image_text_retrieval" },
    ],
    receipts: [shape, image],
  });
  const encoded = encodeCatalogEmbeddingMatrix({
    sourceManifestHash: set.sourceManifestHash,
    embeddingSet: set,
    purpose: "image_text_retrieval",
  });

  assert.equal(set.status, "eligible");
  assert.equal(encoded.bytes[0], 1);
  assert.equal(encoded.bytes[1], 0);
  assert.deepEqual(
    decodeCatalogEmbeddingMatrix(encoded.matrix, encoded.bytes).get(receipt.sourceContentHash),
    image.aggregate,
  );
  assert.equal(CATALOG_EMBEDDING_MATRIX_SCHEMA.parse(encoded.matrix).compilerAuthority, false);
  const tampered = encoded.bytes.slice();
  tampered[0] = 2;
  assert.throws(() => decodeCatalogEmbeddingMatrix(encoded.matrix, tampered), /descriptor/iu);
});

test("hybrid search keeps deterministic rank and annotates uncertain validation", async () => {
  const module = await loadSemanticRegistry();
  const fixture = await catalogFixture(module);
  const collisionSourceHash = hash("catalog-collision-only-source");
  const collisionAsset = sealCatalogAssetArtifact({
    source: {
      ...fixture.asset.source,
      contentHash: collisionSourceHash,
      sourceArtifact: {
        artifactHash: hash("catalog-collision-only-bytes"),
        bytes: fixture.asset.source.sourceArtifact!.bytes,
        mediaType: fixture.asset.source.sourceArtifact!.mediaType,
      },
    },
    geometryHash: hash("catalog-collision-only-geometry"),
    deformation: fixture.asset.deformation,
    coordinateFrame: fixture.asset.coordinateFrame,
    bounds: fixture.asset.bounds,
    parts: fixture.asset.parts.map((part) => ({
      ...part,
      partId: "collision_proxy",
      geometryHash: hash("catalog-collision-only-part"),
      role: "collision_proxy" as const,
      materialHashes: [],
    })),
    materials: [],
    support: fixture.asset.support,
    collision: fixture.asset.collision,
    sockets: fixture.asset.sockets,
    socketMeasurementRefusal: fixture.asset.socketMeasurementRefusal,
    measurementEvidenceHashes: fixture.asset.measurementEvidenceHashes,
  });
  const request = metadataRequest(
    "visual_and_name",
    fixture.asset.source.contentHash,
    fixture.asset.hash,
  );
  const receipt = metadataReceipt(request);
  const metadata = sealCatalogSearchMetadataSet({
    requestSetHash: hash("metadata-requests"),
    requestedHashes: [request.hash],
    receipts: [receipt],
  });
  const measurements = sealCatalogMeasurementSet({
    sourceManifestHash: hash("source-manifest"),
    assets: [fixture.asset, collisionAsset],
    diagnostics: [],
  });
  const sourceNameNormalizerHash = hash("source-name-normalizer");
  const treeSourceName = seal({
    kind: "CatalogSourceNameHint" as const,
    sourceContentHash: fixture.asset.source.contentHash,
    normalizerImplementationHash: sourceNameNormalizerHash,
    interpretation: "single_normalized_name" as const,
    observations: [
      {
        originalFilename: "StylizedTree.glb",
        normalizedStem: "stylized tree",
        tokens: ["stylized", "tree"],
      },
    ],
    diagnostics: [],
    compilerAuthority: false as const,
  });
  const collisionSourceName = seal({
    kind: "CatalogSourceNameHint" as const,
    sourceContentHash: collisionSourceHash,
    normalizerImplementationHash: sourceNameNormalizerHash,
    interpretation: "single_normalized_name" as const,
    observations: [
      {
        originalFilename: "StylizedTree_Collision.glb",
        normalizedStem: "stylized tree collision",
        tokens: ["stylized", "tree", "collision"],
      },
    ],
    diagnostics: [],
    compilerAuthority: false as const,
  });
  const sourceNames = seal({
    kind: "CatalogSourceNameHintSet" as const,
    status: "eligible" as const,
    sourceManifestHash: measurements.sourceManifestHash,
    normalizerImplementationHash: sourceNameNormalizerHash,
    items: [treeSourceName, collisionSourceName].sort((left, right) =>
      left.sourceContentHash < right.sourceContentHash ? -1 : 1,
    ),
    diagnostics: [],
    compilerAuthority: false as const,
  });
  const embedding = sealCatalogEmbeddingReceipt({
    sourceContentHash: fixture.asset.source.contentHash,
    renderEvidenceHash: receipt.renderEvidenceHash,
    purpose: "image_text_retrieval",
    modelId: "siglip_test",
    modelCommitHash,
    modelImplementationHash: hash("siglip-implementation"),
    preprocessingImplementationHash: hash("siglip-image-preprocessing"),
    aggregationImplementationHash: hash("embedding-aggregation"),
    aggregate: { scaleMillionths: 10, values: [8, 7, 6, 5, 4, 3, 2, 1] },
    maximumViewDisagreementMillionths: 1_000,
    gpuMilliseconds: 1,
  });
  const shapeEmbedding = sealCatalogEmbeddingReceipt({
    sourceContentHash: fixture.asset.source.contentHash,
    renderEvidenceHash: receipt.renderEvidenceHash,
    purpose: "shape_similarity",
    modelId: "dinov3_test",
    modelCommitHash,
    modelImplementationHash: hash("dinov3-implementation"),
    preprocessingImplementationHash: hash("dinov3-image-preprocessing"),
    aggregationImplementationHash: hash("embedding-aggregation"),
    aggregate: { scaleMillionths: 10, values: [1, 2, 3, 4, 5, 6, 7, 8] },
    maximumViewDisagreementMillionths: 1_000,
    gpuMilliseconds: 1,
  });
  const embeddingSet = sealCatalogEmbeddingSet({
    sourceManifestHash: measurements.sourceManifestHash,
    visualReviewIndexHash: hash("review-index"),
    expected: [
      { sourceContentHash: fixture.asset.source.contentHash, purpose: "image_text_retrieval" },
      { sourceContentHash: fixture.asset.source.contentHash, purpose: "shape_similarity" },
    ],
    receipts: [embedding, shapeEmbedding],
  });
  const encoded = encodeCatalogEmbeddingMatrix({
    sourceManifestHash: measurements.sourceManifestHash,
    embeddingSet,
    purpose: "image_text_retrieval",
  });
  const shapeEncoded = encodeCatalogEmbeddingMatrix({
    sourceManifestHash: measurements.sourceManifestHash,
    embeddingSet,
    purpose: "shape_similarity",
  });
  const policy = searchPolicy();
  const index = buildCatalogSearchIndex({
    measurements,
    metadata,
    sourceNames: CATALOG_SOURCE_NAME_HINT_SET_SCHEMA.parse(sourceNames),
    imageTextEmbeddings: encoded.matrix,
    shapeEmbeddings: shapeEncoded.matrix,
    policy,
    buildImplementationHash: hash("search-builder"),
  });
  assert.equal(index.coverage.searchableSources, 1);
  assert.equal(index.coverage.excludedNonRenderableCollisionCompanions, 1);
  assert.deepEqual(index.excludedSources, [
    {
      sourceContentHash: collisionSourceHash,
      measurementHash: collisionAsset.hash,
      reason: "non_renderable_collision_companion",
    },
  ]);
  assert.equal(
    index.documents.some((entry) => entry.sourceContentHash === collisionSourceHash),
    false,
  );
  const query = sealCatalogSearchQuery({
    text: "stylized forest tree",
    rankingMode: "automatic",
    styleTerms: ["low poly"],
    constraints: { commercialUseRequired: true, redistributionRequired: true },
    limit: 1,
    validationLimit: 1,
  });
  const queryEmbedding = sealCatalogQueryEmbeddingReceipt({
    queryHash: query.hash,
    modelImplementationHash: encoded.matrix.modelImplementationHash,
    preprocessingImplementationHash: hash("siglip-text-preprocessing"),
    workerOutputHash: hash("siglip-query-output"),
    batchGpuMilliseconds: 1,
    vector: { scaleMillionths: 10, values: [8, 7, 6, 5, 4, 3, 2, 1] },
  });
  const base = executeCatalogSearch({
    index,
    policy,
    query,
    imageTextMatrix: encoded.matrix,
    imageTextMatrixBytes: encoded.bytes,
    shapeMatrix: shapeEncoded.matrix,
    shapeMatrixBytes: shapeEncoded.bytes,
    queryEmbedding,
  });
  const referenceQuery = sealCatalogSearchQuery({
    text: "similar silhouette",
    rankingMode: "shape_only",
    referenceSourceContentHash: fixture.asset.source.contentHash,
    styleTerms: [],
    constraints: { commercialUseRequired: false, redistributionRequired: false },
    limit: 1,
    validationLimit: 0,
  });
  const referenceResult = executeCatalogSearch({
    index,
    policy,
    query: referenceQuery,
    imageTextMatrix: encoded.matrix,
    imageTextMatrixBytes: encoded.bytes,
    shapeMatrix: shapeEncoded.matrix,
    shapeMatrixBytes: shapeEncoded.bytes,
  });
  const validationRequest = sealCatalogSearchValidationRequest({
    query,
    candidate: {
      sourceContentHash: fixture.asset.source.contentHash,
      metadataReceiptHash: receipt.hash,
      measurementHash: fixture.asset.hash,
      renderEvidenceHash: receipt.renderEvidenceHash,
      metricSummary: request.metricSummary,
      selectedRgbViews: request.selectedRgbViews,
    },
    promptTemplateHash: hash("validation-prompt"),
    preprocessingImplementationHash: hash("validation-preprocessor"),
  });
  const validation = sealCatalogValidationReceipt({
    request: validationRequest,
    status: "eligible",
    adapterId: "test_validation_adapter",
    adapterImplementationHash: hash("validation-adapter"),
    workerImplementationHash: hash("validation-worker"),
    runtimeImplementationHash: hash("validation-runtime"),
    modelId: "qwen_test",
    modelCommitHash,
    promptHash: hash("rendered-validation-prompt"),
    validation: {
      verdict: "uncertain",
      observedObjectType: observed("tree"),
      reasons: ["The visible tree identity matches, but hidden constraints are not observable."],
      mismatchedConstraints: [],
      visibleLimitations: ["Sockets are not visible."],
    },
    diagnostics: [],
    resourceUsage: {
      inputImageCount: 12,
      inputPixels: 1_000_000,
      inputTokens: 100,
      outputTokens: 100,
      elapsedMilliseconds: 500,
      peakResidentBytes: 1024,
      gpuMilliseconds: 450,
    },
  });
  const annotated = annotateCatalogSearchResults({ results: base, receipts: [validation] });

  assert.equal(index.status, "eligible");
  assert.equal(base.results[0]?.sourceContentHash, fixture.asset.source.contentHash);
  assert.equal(referenceResult.status, "eligible");
  assert.equal(referenceResult.results[0]?.channelRanks.shapeSimilarity, 1);
  assert.equal(base.results[0]?.channelRanks.basenameLexical, 1);
  assert.equal(base.results[0]?.channelRanks.imageTextRetrieval, 1);
  assert.equal(annotated.results[0]?.fusedRank, 1);
  assert.equal(annotated.results[0]?.validation, "uncertain");
  assert.equal(annotated.results[0]?.validationReceiptHash, validation.hash);
  assert.equal(annotated.compilerAuthority, false);
});

test("progressive search works from basename evidence and fails closed for missing shape evidence", () => {
  const policy = searchPolicy();
  const palmHash = "1".repeat(64);
  const chairHash = "2".repeat(64);
  const index = manualSearchIndex(policy, [
    manualSearchDocument(palmHash, ["palm", "tree"]),
    manualSearchDocument(chairHash, ["chair", "office"]),
  ]);
  const textQuery = sealCatalogSearchQuery({
    text: "stylized palm tree",
    rankingMode: "automatic",
    styleTerms: [],
    constraints: { commercialUseRequired: false, redistributionRequired: false },
    limit: 2,
    validationLimit: 0,
  });
  const textResult = executeCatalogSearch({ index, policy, query: textQuery });
  assert.equal(textResult.status, "eligible");
  assert.equal(textResult.results[0]?.sourceContentHash, palmHash);
  assert.deepEqual(textResult.results[0]?.rankingChannels, ["basename_lexical"]);
  assert.deepEqual(textResult.results[0]?.missingEvidence, [
    "image_text_embedding",
    "metadata",
    "shape_embedding",
  ]);

  const referenceQuery = sealCatalogSearchQuery({
    text: "similar silhouette",
    referenceSourceContentHash: palmHash,
    rankingMode: "shape_only",
    styleTerms: [],
    constraints: { commercialUseRequired: false, redistributionRequired: false },
    limit: 2,
    validationLimit: 0,
  });
  const referenceResult = executeCatalogSearch({ index, policy, query: referenceQuery });
  assert.equal(referenceResult.status, "incomplete");
  assert.equal(referenceResult.results.length, 0);
  assert.ok(referenceResult.diagnostics.some((entry) => entry.includes("no shape embedding")));
});

test("catalog retrieval returns the requested result count beyond the former policy ceiling", () => {
  const policy = searchPolicy();
  const documents = Array.from({ length: 128 }, (_, index) =>
    manualSearchDocument((index + 1).toString(16).padStart(64, "0"), ["tree"]),
  );
  const index = manualSearchIndex(policy, documents);
  const query = sealCatalogSearchQuery({
    text: "tree",
    rankingMode: "basename_only",
    styleTerms: [],
    constraints: { commercialUseRequired: false, redistributionRequired: false },
    limit: documents.length,
    validationLimit: 0,
  });
  const result = executeCatalogSearch({ index, policy, query });
  assert.equal(result.status, "eligible");
  assert.equal(result.results.length, documents.length);
});

test("mixed enrichment cannot gain an additive channel-count advantage", () => {
  const policy = searchPolicy();
  const minimalHash = "3".repeat(64);
  const enrichedHash = "4".repeat(64);
  const index = manualSearchIndex(policy, [
    manualSearchDocument(minimalHash, ["palm"]),
    manualSearchDocument(enrichedHash, ["palm"], palmSearchMetadata()),
  ]);
  const query = sealCatalogSearchQuery({
    text: "palm",
    rankingMode: "automatic",
    styleTerms: [],
    constraints: { commercialUseRequired: false, redistributionRequired: false },
    limit: 2,
    validationLimit: 0,
  });
  const result = executeCatalogSearch({ index, policy, query });
  assert.equal(result.results.length, 2);
  const maximumSingleChannelScore = Math.round(
    (1 / (policy.reciprocalRankConstant + 1)) * 1_000_000_000,
  );
  assert.ok(
    result.results.every((entry) => entry.fusedScoreBillionths <= maximumSingleChannelScore),
  );
  assert.equal(
    result.results.find((entry) => entry.sourceContentHash === enrichedHash)?.rankingChannels
      .length,
    2,
  );
});

test("only conclusive requirement validation can decide that no suitable match exists", () => {
  const policy = searchPolicy();
  const index = manualSearchIndex(
    policy,
    ["5", "6", "7"].map((prefix) => manualSearchDocument(prefix.repeat(64), ["tree"])),
  );
  const query = sealCatalogSearchQuery({
    text: "tree",
    rankingMode: "basename_only",
    styleTerms: [],
    constraints: { commercialUseRequired: false, redistributionRequired: false },
    limit: 3,
    validationLimit: 3,
  });
  const base = executeCatalogSearch({ index, policy, query });
  const decisionPolicy = sealCatalogCandidateDecisionPolicy({
    policyId: "catalog_candidate_decision_test",
    minimumValidatedCandidates: 3,
    minimumMatchCount: 1,
    uncertainOutcome: "evidence_insufficient",
    allMismatchOutcome: "no_suitable_match",
  });
  const withVerdicts = (verdicts: readonly ("match" | "mismatch" | "uncertain")[]) => {
    const parsed = CATALOG_SEARCH_RESULT_SET_SCHEMA.safeParse(
      seal({
        kind: "CatalogSearchResultSet" as const,
        ...stripArtifact(base),
        results: base.results.map((entry, index) => ({
          ...entry,
          validation: verdicts[index]!,
          validationReceiptHash: hash(`validation:${index}:${verdicts[index]}`),
        })),
      }),
    );
    if (!parsed.success) throw new Error(JSON.stringify(parsed.error.issues));
    return parsed.data;
  };
  assert.equal(
    decideCatalogSearchOutcome({
      results: withVerdicts(["mismatch", "mismatch", "mismatch"]),
      policy: decisionPolicy,
    }).outcome,
    "no_suitable_match",
  );
  assert.equal(
    decideCatalogSearchOutcome({
      results: withVerdicts(["mismatch", "uncertain", "mismatch"]),
      policy: decisionPolicy,
    }).outcome,
    "evidence_insufficient",
  );
  assert.equal(
    decideCatalogSearchOutcome({
      results: withVerdicts(["mismatch", "match", "mismatch"]),
      policy: decisionPolicy,
    }).outcome,
    "suitable_match",
  );
});

test("attributed source assembly context can resolve an ambiguity isolated renders cannot", async () => {
  const module = await loadSemanticRegistry();
  const fixture = await catalogFixture(module);
  const secondSourceHash = hash("context-parent-source");
  const {
    kind: _kind,
    assetId: _assetId,
    hash: _assetHash,
    source: originalSource,
    ...assetMaterial
  } = fixture.asset;
  const parentAsset = sealCatalogAssetArtifact({
    ...assetMaterial,
    source: {
      ...originalSource,
      contentHash: secondSourceHash,
      sourceArtifact: {
        artifactHash: hash("context-parent-bytes"),
        bytes: originalSource.sourceArtifact!.bytes,
        mediaType: originalSource.sourceArtifact!.mediaType,
      },
    },
  });
  const selectedRgbViews = CATALOG_REVIEW_VIEWPOINTS.map((view) => ({
    viewId: view.viewId,
    rgbHash: hash(`context:${view.viewId}`),
  }));
  const candidates = [fixture.asset, parentAsset]
    .map((asset) =>
      createAssetContextCandidate({
        asset,
        renderEvidenceHash: hash(`context-render:${asset.source.contentHash}`),
        contactSheetContentHash: hash(`context-sheet:${asset.source.contentHash}`),
        selectedRgbViews,
      }),
    )
    .sort((left, right) =>
      left.sourceContentHash < right.sourceContentHash
        ? -1
        : left.sourceContentHash > right.sourceContentHash
          ? 1
          : 0,
    );
  const isolatedRequest = sealAssetContextHypothesisRequest({
    groupingEvidence: ["bounded_retrieval"],
    candidates,
    attributedAssemblyEvidence: [],
    promptTemplateHash: hash("context-prompt"),
  });
  const abstainedAsset = (sourceContentHash: string) => ({
    sourceContentHash,
    sourceRole: abstained("Isolated views do not establish installation semantics."),
    componentRoleTerms: abstained("No demonstrated assembly is available."),
    likelyMateSourceHashes: abstained("Mates are not observable in isolation."),
    notes: abstained("Assembly role remains unresolved."),
    supportingEvidenceHashes: [],
  });
  const isolatedReceipt = contextReceipt(isolatedRequest.hash, {
    assets: candidates.map((entry) => abstainedAsset(entry.sourceContentHash)),
    relations: [],
    groupNotes: abstained("Grouped isolated renders remain ambiguous."),
  });
  assert.equal(contextReceiptMatchesRequest(isolatedRequest, isolatedReceipt), true);
  assert.equal(
    assessConstructionEligibility({ asset: fixture.asset, context: isolatedReceipt }).status,
    "incomplete",
  );

  const assemblyEvidenceHash = hash("authored-observation-tower-prefab");
  const attributedRequest = sealAssetContextHypothesisRequest({
    groupingEvidence: ["attributed_assembly", "bounded_retrieval"],
    candidates,
    attributedAssemblyEvidence: [
      {
        evidenceId: "TowerPrefabEvidence",
        evidenceKind: "source_prefab",
        evidenceHash: assemblyEvidenceHash,
        attribution: {
          sourceKind: "source_manifest",
          sourceIdentityHash: hash("authored-prefab-source"),
        },
        members: candidates.map((entry) => ({
          sourceContentHash: entry.sourceContentHash,
          authoredRoleTerms:
            entry.sourceContentHash === fixture.asset.source.contentHash
              ? ["support post"]
              : ["assembled tower"],
          ...(entry.sourceContentHash === fixture.asset.source.contentHash
            ? {
                parentSourceContentHash: parentAsset.source.contentHash,
                transformMeters: {
                  positionMeters: { x: 1, y: 0, z: 1 },
                  rotation: [0, 0, 0, 1] as [number, number, number, number],
                  scale: 1,
                },
              }
            : {}),
        })),
      },
    ],
    promptTemplateHash: hash("context-prompt"),
  });
  const contextualAssets = candidates
    .map((entry) =>
      entry.sourceContentHash === fixture.asset.source.contentHash
        ? {
            sourceContentHash: entry.sourceContentHash,
            sourceRole: observed("assembly_component" as const),
            componentRoleTerms: observed(["support post"]),
            likelyMateSourceHashes: observed([parentAsset.source.contentHash]),
            notes: abstained("No additional role is claimed."),
            supportingEvidenceHashes: [assemblyEvidenceHash],
          }
        : abstainedAsset(entry.sourceContentHash),
    )
    .sort((left, right) =>
      left.sourceContentHash < right.sourceContentHash
        ? -1
        : left.sourceContentHash > right.sourceContentHash
          ? 1
          : 0,
    );
  const attributedReceipt = contextReceipt(attributedRequest.hash, {
    assets: contextualAssets,
    relations: [
      {
        kind: "part_of" as const,
        subjectSourceContentHash: fixture.asset.source.contentHash,
        objectSourceContentHash: parentAsset.source.contentHash,
        rationale: "The source prefab places the post beneath the assembled tower root.",
        supportingEvidenceHashes: [assemblyEvidenceHash],
      },
    ],
    groupNotes: observed(["Source-prefab transforms disambiguate the support post."]),
  });
  assert.equal(contextReceiptMatchesRequest(attributedRequest, attributedReceipt), true);
  assert.equal(
    assessConstructionEligibility({ asset: fixture.asset, context: attributedReceipt })
      .candidateKind,
    "component_candidate",
  );
  assert.equal(contextReceiptMatchesRequest(isolatedRequest, attributedReceipt), false);
});

test("admission policy disables automatic authority and sampling remains exact", () => {
  const policy = admissionPolicy();
  assert.equal(policy.automaticAdmissionEnabled, false);
  assert.deepEqual(policy.automaticallyAdmissibleEntryKinds, []);
  assert.equal(CATALOG_ADMISSION_POLICY_SCHEMA.parse(policy).hash, policy.hash);
  const sample = exactAcceptanceSampleSize({
    populationCount: 100,
    designDefectCount: 5,
    acceptanceNumber: 0,
    confidenceMillionths: 950_000,
  });
  assert.ok(sample.sampleCount > 0 && sample.sampleCount <= 100);
  assert.ok(sample.acceptanceProbabilityMillionths <= 50_000);
});

test("the tracked catalog root excludes learned search evidence", async () => {
  const module = await loadSemanticRegistry();
  const fixture = await catalogFixture(module);
  const provenanceHash = hash("fixture-source-provenance");
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
    bytesHash: hash("committed-measurement-bytes"),
    bytes: 1,
  };
  const policy = admissionPolicy();
  const reviewPacketHash = hash("catalog-review-packet");
  const reviewDecisionHash = hash("catalog-review-decision");
  const visualReviewIndexHash = hash("catalog-visual-review-index");
  const acceptanceAudit = sealCatalogAcceptanceAudit({
    batchId: "catalog_authority_test",
    reviewPacketHash,
    reviewDecisionHash,
    reviewer: { authority: "creator", reviewerId: "test-creator" },
    admissionPolicyHash: policy.hash,
    admissionRubricHash: hash("catalog-admission-rubric"),
    semanticModuleHash: module.snapshot.hash,
    measurementSetHash: measurements.hash,
    visualReviewIndexHash,
    sourceContentHash: fixture.asset.source.contentHash,
    assetHash: fixture.asset.hash,
    renderEvidenceHash: hash("catalog-render-evidence"),
    assertionBundleHash: fixture.assertions.hash,
    entryHandle: fixture.declaration.handle,
    memberId: fixture.declaration.members[0]!.memberId,
    entryDeclarationHash: contentHash(stableJson(fixture.declaration)),
    styleProfileHandle: fixture.declaration.styleProfileHandle,
    criteria: [
      {
        criterionId: "semantic_identity",
        outcome: "pass",
        evidenceHashes: [fixture.asset.hash],
        note: "The creator accepted the synthetic fixture's semantic identity.",
      },
    ],
  });
  const retainedReviewEvidence = [
    ["CatalogCreatorReviewPacket", reviewPacketHash],
    ["CatalogCreatorReviewDecision", reviewDecisionHash],
    ["CatalogVisualReviewIndex", visualReviewIndexHash],
  ].map(([kind, artifactHash]) => ({
    kind: kind!,
    relativePath: `registry/evidence/${artifactHash}.json`,
    artifactHash: artifactHash!,
    bytesHash: hash(`${kind}-bytes`),
    bytes: 1,
  }));
  const input = {
    sourceManifest,
    semanticModuleHash: module.snapshot.hash,
    semanticLexiconHash: hash("commit-lexicon"),
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
    acceptanceAudits: [acceptanceAudit],
    admissionPolicy: policy,
    retainedEvidence: [retainedMeasurements, ...retainedReviewEvidence].sort((left, right) =>
      left.relativePath.localeCompare(right.relativePath),
    ),
  };
  const commit = sealCatalogAuthorityCommit(input);

  assert.equal(commit.sourcePayloadPolicy, "external_content_addressed");
  assert.equal("metadata" in commit, false);
  assert.equal("embedding" in commit, false);
  assert.equal(commit.acceptanceAudits[0]?.reviewDecisionHash, reviewDecisionHash);
  assert.throws(
    () => sealCatalogAuthorityCommit({ ...input, acceptanceAudits: [] }),
    /requires exactly one authored acceptance audit/iu,
  );
  assert.throws(
    () => sealCatalogAuthorityCommit({ ...input, retainedEvidence: [] }),
    /measurement set must be retained/iu,
  );
});

test("the tracked smoke fixture is sealed, balanced, and cannot authorize corpus work", async () => {
  const benchmark = CATALOG_SEARCH_SMOKE_FIXTURE_SCHEMA.parse(
    JSON.parse(await readFile("registry/catalog-search-smoke.json", "utf8")),
  );
  assert.equal(benchmark.assets.length, 32);
  assert.equal(benchmark.authority, "smoke_only");
  assert.equal(new Set(benchmark.assets.map((asset) => asset.leakageGroupHash)).size, 32);
});

function palmSearchMetadata(): CatalogSearchMetadata {
  return CATALOG_SEARCH_METADATA_SCHEMA.parse({
    ...treeMetadata(),
    caption: observed("A stylized palm tree."),
    primaryNoun: observed("palm tree"),
    alternateNouns: observed(["palm"]),
  });
}

const searchFields = [
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

function manualSearchDocument(
  sourceContentHash: string,
  basenameTokens: readonly string[],
  metadata?: CatalogSearchMetadata,
) {
  const observationTokens = (field: (typeof searchFields)[number]): string[] => {
    if (field === "sourceBasename") return [...basenameTokens].sort();
    if (!metadata) return [];
    const value = metadata[field];
    if (value.status !== "observed") return [];
    return tokenizeCatalogSearchText(
      Array.isArray(value.value) ? value.value.join(" ") : value.value,
    );
  };
  return {
    sourceContentHash,
    measurementHash: hash(`measurement:${sourceContentHash}`),
    fields: searchFields.map((field) => ({ field, tokens: observationTokens(field) })),
    ...(metadata
      ? {
          metadataEvidence: {
            kind: "worker" as const,
            evidenceHash: hash(`metadata:${sourceContentHash}`),
            renderEvidenceHash: hash(`render:${sourceContentHash}`),
            metadata,
          },
        }
      : {}),
    metric: {
      sizeMeters: {
        x: quantizeQ32_32(1),
        y: quantizeQ32_32(2),
        z: quantizeQ32_32(1),
      },
      triangleCount: 128,
      sourceBytes: 1024,
    },
    rights: { commercialUsePermitted: true, redistributionPermitted: true },
    missingEvidence: [
      "image_text_embedding" as const,
      ...(metadata ? [] : (["metadata"] as const)),
      "shape_embedding" as const,
    ],
  };
}

function manualSearchIndex(
  policy: ReturnType<typeof searchPolicy>,
  documentsInput: readonly ReturnType<typeof manualSearchDocument>[],
) {
  const documents = [...documentsInput].sort((left, right) =>
    left.sourceContentHash < right.sourceContentHash
      ? -1
      : left.sourceContentHash > right.sourceContentHash
        ? 1
        : 0,
  );
  return CATALOG_SEARCH_INDEX_SCHEMA.parse(
    seal({
      kind: "CatalogSearchIndex" as const,
      status: "eligible" as const,
      sourceManifestHash: hash("manual-search-source-manifest"),
      measurementSetHash: hash("manual-search-measurements"),
      sourceNameHintSetHash: hash("manual-search-source-names"),
      authoredMetadataSetHashes: [],
      searchPolicyHash: policy.hash,
      tokenizerImplementationHash: CATALOG_SEARCH_TOKENIZER_IMPLEMENTATION_HASH,
      buildImplementationHash: hash("manual-search-builder"),
      coverage: {
        searchableSources: documents.length,
        excludedNonRenderableCollisionCompanions: 0,
        metadata: documents.filter((entry) => entry.metadataEvidence !== undefined).length,
        workerMetadata: documents.filter((entry) => entry.metadataEvidence?.kind === "worker")
          .length,
        authoredMetadata: 0,
        imageTextEmbedding: 0,
        shapeEmbedding: 0,
      },
      documents,
      excludedSources: [],
      diagnostics: [],
      compilerAuthority: false as const,
    }),
  );
}

function contextReceipt(
  requestHash: string,
  hypothesis: NonNullable<Parameters<typeof sealAssetContextHypothesisReceipt>[0]["hypothesis"]>,
) {
  return sealAssetContextHypothesisReceipt({
    status: "eligible",
    requestHash,
    adapterId: "test_context_adapter",
    adapterImplementationHash: hash("context-adapter"),
    workerImplementationHash: hash("context-worker"),
    runtimeImplementationHash: hash("context-runtime"),
    modelId: "qwen_context_test",
    modelCommitHash,
    promptHash: hash("rendered-context-prompt"),
    rawOutputHash: hash(`context-output:${requestHash}`),
    hypothesis,
    diagnostics: [],
    resourceUsage: {
      inputImageCount: 2,
      inputPixels: 200_000,
      inputTokens: 100,
      outputTokens: 100,
      elapsedMilliseconds: 500,
      peakResidentBytes: 1024,
      gpuMilliseconds: 450,
    },
  });
}

function seal<T extends object>(material: T): T & { readonly hash: string } {
  return { ...material, hash: contentHash(stableJson(material)) };
}

function stripArtifact<T extends { readonly kind: string; readonly hash: string }>(
  value: T,
): Omit<T, "kind" | "hash"> {
  const { kind: _kind, hash: _hash, ...material } = value;
  return material;
}

function metricSummary(sourceContentHash: string, measurementHash: string) {
  const material = {
    kind: "AssetMetricPromptSummary" as const,
    sourceContentHash,
    measurementHash,
    coordinateSystem: "right_handed_y_up_meters" as const,
    boundsMeters: {
      min: { x: -0.5, y: 0, z: -0.5 },
      max: { x: 0.5, y: 2, z: 0.5 },
    },
    sizeMeters: { x: 1, y: 2, z: 1 },
    sourceFrame: {
      handedness: "right_handed" as const,
      up: "+Y" as const,
      forward: "-Z" as const,
      unitsToMeters: 1,
    },
    partCounts: { total: 1, renderable: 1, collision: 0 },
    triangleCount: 128,
    support: {
      primaryContact: "bottom" as const,
      contactAreaSquareMeters: 1,
      measurementMethod: "planar_patch_fit" as const,
    },
  };
  return { ...material, hash: contentHash(stableJson(material)) };
}
