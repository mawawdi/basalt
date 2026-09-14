import assert from "node:assert/strict";
import test from "node:test";
import {
  CATALOG_METADATA_WORKER_JOB_SCHEMA,
  CATALOG_METADATA_WORKER_OUTPUT_SCHEMA,
  CATALOG_QUERY_EMBEDDING_WORKER_JOB_SCHEMA,
  CATALOG_QUERY_EMBEDDING_WORKER_OUTPUT_SCHEMA,
  CATALOG_REVIEW_VIEWPOINTS,
  CATALOG_SEARCH_METADATA_JSON_SCHEMA,
  CATALOG_SEARCH_METADATA_JSON_SCHEMA_HASH,
  CATALOG_WORKER_IMAGE_LONG_EDGE_PIXELS,
  CATALOG_WORKER_MAX_ASSETS_PER_SHARD,
  CATALOG_WORKER_MAX_EVIDENCE_BYTES_PER_SHARD,
  CATALOG_WORKER_MAX_EVIDENCE_FILES_PER_SHARD,
  MAX_LOCAL_CATALOG_WORKERS,
  catalogWorkerResultHashMatches,
  catalogWorkerOutputIsComplete,
  requireLocalCatalogWorkerCount,
  sealAssetSearchMetadataRequest,
} from "@basalt/catalog-authoring";
import { contentHash, stableJson } from "@basalt/contracts";

test("local catalog concurrency has one hard four-worker ceiling", () => {
  assert.equal(MAX_LOCAL_CATALOG_WORKERS, 4);
  assert.equal(requireLocalCatalogWorkerCount(4), 4);
  assert.throws(() => requireLocalCatalogWorkerCount(5), /1 through 4/u);
  assert.throws(() => requireLocalCatalogWorkerCount(0), /1 through 4/u);
});

test("partial worker checkpoints are never reusable as complete shards", () => {
  const model = {
    modelId: "siglip_test",
    source: "huggingface" as const,
    repository: "google/siglip2-so400m-patch14-384",
    sourceCommitHash: contentHash("query-model"),
    capabilities: ["image_text_retrieval"] as const,
    accelerator: "L40S" as const,
  };
  const jobMaterial = {
    kind: "CatalogQueryEmbeddingWorkerJob" as const,
    workerImplementationHash: contentHash("query-worker"),
    model,
    queries: [
      { queryHash: contentHash("query-a"), text: "tree" },
      { queryHash: contentHash("query-b"), text: "chair" },
    ].sort((left, right) => (left.queryHash < right.queryHash ? -1 : 1)),
  };
  const job = CATALOG_QUERY_EMBEDDING_WORKER_JOB_SCHEMA.parse({
    ...jobMaterial,
    hash: contentHash(stableJson(jobMaterial)),
  });
  const result = (items: readonly { queryHash: string; vector: object }[]) => {
    const material = {
      kind: "CatalogQueryEmbeddingWorkerOutput" as const,
      jobHash: job.hash,
      modelImplementationHash: contentHash("query-model-implementation"),
      preprocessingImplementationHash: contentHash("query-preprocessor"),
      items,
    };
    return CATALOG_QUERY_EMBEDDING_WORKER_OUTPUT_SCHEMA.parse({
      ...material,
      resultHash: contentHash(stableJson(material)),
    });
  };
  const vector = { scaleMillionths: 1, values: [1, 2, 3, 4, 5, 6, 7, 8] };
  const partial = result([{ queryHash: job.queries[0]!.queryHash, vector }]);
  const complete = result(job.queries.map((query) => ({ queryHash: query.queryHash, vector })));

  assert.equal(catalogWorkerOutputIsComplete(job, partial), false);
  assert.equal(catalogWorkerOutputIsComplete(job, complete), true);
});

test("worker result hashes verify the raw envelope before schema normalization", () => {
  const material = {
    kind: "CatalogMetadataWorkerOutput" as const,
    jobHash: contentHash("raw-result-job"),
    runtime: {
      adapterImplementationHash: contentHash("raw-result-adapter"),
      workerImplementationHash: contentHash("raw-result-worker"),
      runtimeImplementationHash: contentHash("raw-result-runtime"),
      modelImplementationHash: contentHash("raw-result-model-implementation"),
      modelId: "raw_result_model",
      modelCommitHash: contentHash("raw-result-model-commit"),
    },
    items: [
      {
        requestHash: contentHash("raw-result-request"),
        status: "incomplete" as const,
        promptHash: contentHash("raw-result-prompt"),
        diagnostics: [" trailing whitespace is normalized later "],
        resourceUsage: {
          inputImageCount: 0,
          inputPixels: 0,
          inputTokens: 0,
          outputTokens: 0,
          elapsedMilliseconds: 1,
          peakResidentBytes: 1,
          gpuMilliseconds: 0,
        },
      },
    ],
  };
  const raw = { ...material, resultHash: contentHash(stableJson(material)) };

  assert.equal(catalogWorkerResultHashMatches(raw), true);
  assert.equal(
    CATALOG_METADATA_WORKER_OUTPUT_SCHEMA.parse(raw).items[0]?.diagnostics[0],
    "trailing whitespace is normalized later",
  );
  assert.equal(
    catalogWorkerResultHashMatches({
      ...raw,
      items: [{ ...raw.items[0], diagnostics: ["tampered"] }],
    }),
    false,
  );
});

test("metadata shards bind exact count, file, byte, and pixel budgets", () => {
  const sourceContentHash = contentHash("worker-source");
  const measurementHash = contentHash("worker-measurement");
  const metricMaterial = {
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
    triangleCount: 12,
    support: { primaryContact: "bottom" as const, contactAreaSquareMeters: 1 },
  };
  const metricSummary = {
    ...metricMaterial,
    hash: contentHash(stableJson(metricMaterial)),
  };
  const request = sealAssetSearchMetadataRequest({
    sourceContentHash,
    measurementHash,
    renderEvidenceHash: contentHash("worker-render"),
    evidenceMode: "visual_only",
    metricSummary,
    viewSet: "canonical_twelve",
    promptTemplateHash: contentHash("worker-prompt"),
    preprocessingImplementationHash: contentHash("worker-preprocessor"),
    selectedRgbViews: CATALOG_REVIEW_VIEWPOINTS.map((view) => ({
      viewId: view.viewId,
      rgbHash: contentHash(`${view.viewId}:rgb`),
    })),
  });
  const items = [
    {
      request,
      views: request.selectedRgbViews.map((view) => ({
        ...view,
        rgbRelativePath: `.basalt/catalog/review/${view.viewId}.png`,
        rgbSizeBytes: 100,
      })),
    },
  ];
  const material = {
    kind: "CatalogMetadataWorkerJob" as const,
    requestSetHash: contentHash("worker-request-set"),
    promptTemplate: "Describe visible evidence.",
    promptTemplateHash: request.promptTemplateHash,
    outputSchema: CATALOG_SEARCH_METADATA_JSON_SCHEMA,
    outputSchemaHash: CATALOG_SEARCH_METADATA_JSON_SCHEMA_HASH,
    workerImplementationHash: contentHash("worker-implementation"),
    model: {
      modelId: "metadata_baseline",
      source: "huggingface" as const,
      repository: "Qwen/Qwen3-VL-8B-Instruct",
      sourceCommitHash: contentHash("worker-model"),
      capabilities: ["metadata_writer"] as const,
      accelerator: "L40S" as const,
    },
    items,
    inputBudget: {
      assetCount: 1,
      evidenceFileCount: 12,
      evidenceBytes: 1_200,
      preprocessedPixelCeiling: 12 * CATALOG_WORKER_IMAGE_LONG_EDGE_PIXELS ** 2,
    },
  };
  const job = { ...material, hash: contentHash(stableJson(material)) };

  assert.equal(CATALOG_METADATA_WORKER_JOB_SCHEMA.parse(job).hash, job.hash);
  const wrongBudgetMaterial = {
    ...material,
    inputBudget: { ...material.inputBudget, evidenceBytes: 1_201 },
  };
  assert.throws(
    () =>
      CATALOG_METADATA_WORKER_JOB_SCHEMA.parse({
        ...wrongBudgetMaterial,
        hash: contentHash(stableJson(wrongBudgetMaterial)),
      }),
    /budget evidenceBytes/iu,
  );
  assert.equal(CATALOG_WORKER_MAX_ASSETS_PER_SHARD, 8);
  assert.equal(CATALOG_WORKER_MAX_EVIDENCE_FILES_PER_SHARD, 192);
  assert.equal(CATALOG_WORKER_MAX_EVIDENCE_BYTES_PER_SHARD, 64 * 1024 * 1024);
});
