import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";
import {
  CATALOG_EMBEDDING_WORKER_JOB_SCHEMA,
  CATALOG_EMBEDDING_WORKER_OUTPUT_SCHEMA,
  CATALOG_METADATA_WORKER_JOB_SCHEMA,
  CATALOG_METADATA_WORKER_OUTPUT_SCHEMA,
  CATALOG_QUERY_EMBEDDING_WORKER_JOB_SCHEMA,
  CATALOG_QUERY_EMBEDDING_WORKER_OUTPUT_SCHEMA,
  CATALOG_REVIEW_VIEWPOINTS,
  CATALOG_SEARCH_METADATA_JSON_SCHEMA,
  CATALOG_SEARCH_METADATA_JSON_SCHEMA_HASH,
  CATALOG_WORKER_IMAGE_LONG_EDGE_PIXELS,
  MAX_LOCAL_CATALOG_WORKERS,
  catalogWorkerResultHashMatches,
  catalogWorkerOutputIsComplete,
  requireLocalCatalogWorkerCount,
  sealAssetSearchMetadataRequest,
} from "@basalt/catalog-authoring";
import { contentHash, stableJson } from "@basalt/contracts";

const executeFile = promisify(execFile);

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
      gpuMilliseconds: 1,
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

test("metadata checkpoints bind exact evidence without corpus cardinality ceilings", async () => {
  const workerPath = "workers/catalog-metadata/worker.py";
  const workerImplementationHash = createHash("sha256")
    .update(await readFile(workerPath))
    .digest("hex");
  const sourceContentHash = contentHash("worker-source");
  const measurementHash = contentHash("worker-measurement");
  const metricMaterial = {
    kind: "AssetMetricPromptSummary" as const,
    sourceContentHash,
    measurementHash,
    coordinateSystem: "right_handed_y_up_meters" as const,
    boundsMeters: {
      min: { x: -7.636845111846924e-8, y: 0, z: -0.5 },
      max: { x: 6.405995922163129, y: 2, z: 0.00000981776975095272 },
    },
    sizeMeters: { x: 6.40599599853158, y: 2, z: 0.500009817769751 },
    sourceFrame: {
      handedness: "right_handed" as const,
      up: "+Y" as const,
      forward: "-Z" as const,
      unitsToMeters: 1,
    },
    partCounts: { total: 1, renderable: 1, collision: 0 },
    triangleCount: 12,
    support: {
      primaryContact: "bottom" as const,
      contactAreaSquareMeters: 1,
      measurementMethod: "planar_patch_fit" as const,
    },
  };
  const metricSummary = {
    ...metricMaterial,
    hash: contentHash(stableJson(metricMaterial)),
  };
  const promptTemplate = "Describe visible evidence.";
  const request = sealAssetSearchMetadataRequest({
    sourceContentHash,
    measurementHash,
    renderEvidenceHash: contentHash("worker-render"),
    evidenceMode: "visual_only",
    metricSummary,
    viewSet: "canonical_twelve",
    promptTemplateHash: contentHash(promptTemplate),
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
    promptTemplate,
    promptTemplateHash: request.promptTemplateHash,
    outputSchema: CATALOG_SEARCH_METADATA_JSON_SCHEMA,
    outputSchemaHash: CATALOG_SEARCH_METADATA_JSON_SCHEMA_HASH,
    workerImplementationHash,
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
  const largeEvidenceItems = items.map((item) => ({
    ...item,
    views: item.views.map((view) => ({ ...view, rgbSizeBytes: 6 * 1024 * 1024 })),
  }));
  const largeEvidenceMaterial = {
    ...material,
    items: largeEvidenceItems,
    inputBudget: {
      assetCount: 1,
      evidenceFileCount: 12,
      evidenceBytes: 72 * 1024 * 1024,
      preprocessedPixelCeiling: 12 * CATALOG_WORKER_IMAGE_LONG_EDGE_PIXELS ** 2,
    },
  };
  assert.doesNotThrow(() =>
    CATALOG_METADATA_WORKER_JOB_SCHEMA.parse({
      ...largeEvidenceMaterial,
      hash: contentHash(stableJson(largeEvidenceMaterial)),
    }),
  );

  const temporaryRoot = `.basalt/test-metadata-worker-hash-${process.pid}`;
  await mkdir(temporaryRoot, { recursive: false });
  try {
    const path = `${temporaryRoot}/job.json`;
    await writeFile(path, `${stableJson(job)}\n`, { flag: "wx" });
    const { stdout } = await executeFile("python3", [workerPath, "--job", path, "--validate-job"], {
      cwd: process.cwd(),
    });
    const result = JSON.parse(stdout) as {
      readonly status: string;
      readonly kind: string;
      readonly jobHash: string;
      readonly purposes: readonly string[];
    };
    assert.deepEqual(result, {
      status: "eligible",
      kind: "CatalogMetadataWorkerJob",
      jobHash: job.hash,
      purposes: [],
    });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: false });
  }
});

test("TypeScript embedding jobs dispatch independently through the Python boundary", async () => {
  const workerPath = "workers/catalog-metadata/worker.py";
  const workerImplementationHash = createHash("sha256")
    .update(await readFile(workerPath))
    .digest("hex");
  const sourceContentHash = contentHash("embedding-worker-source");
  const renderEvidenceHash = contentHash("embedding-worker-render");
  const viewIds = CATALOG_REVIEW_VIEWPOINTS.map((view) => view.viewId);
  const siglipModel = {
    modelId: "siglip_boundary",
    source: "huggingface" as const,
    repository: "google/siglip2-so400m-patch14-384",
    sourceCommitHash: contentHash("siglip-boundary-commit"),
    capabilities: ["image_text_retrieval"] as const,
    accelerator: "L40S" as const,
  };
  const dinoModel = {
    modelId: "dino_boundary",
    source: "huggingface" as const,
    repository: "facebook/dinov3-vitl16-pretrain-lvd1689m",
    sourceCommitHash: contentHash("dino-boundary-commit"),
    capabilities: ["shape_similarity"] as const,
    accelerator: "L40S" as const,
  };
  const makeJob = (purpose: "image_text_retrieval" | "shape_similarity") => {
    const rgb = purpose === "image_text_retrieval";
    const material = {
      kind: "CatalogEmbeddingWorkerJob" as const,
      sourceManifestHash: contentHash("embedding-worker-manifest"),
      visualReviewIndexHash: contentHash("embedding-worker-review"),
      workerImplementationHash,
      purposes: [purpose],
      models: [rgb ? siglipModel : dinoModel],
      items: [
        {
          sourceContentHash,
          renderEvidenceHash,
          views: viewIds.map((viewId) => ({
            viewId,
            ...(rgb
              ? {
                  rgbRelativePath: `.basalt/catalog/review/${viewId}-rgb.png`,
                  rgbHash: contentHash(`${viewId}:rgb`),
                  rgbSizeBytes: 100,
                }
              : {
                  normalizedDepthRelativePath: `.basalt/catalog/review/${viewId}-depth.png`,
                  normalizedDepthHash: contentHash(`${viewId}:depth`),
                  normalizedDepthSizeBytes: 80,
                }),
          })),
        },
      ],
      inputBudget: {
        assetCount: 1,
        evidenceFileCount: 12,
        evidenceBytes: rgb ? 1_200 : 960,
        preprocessedPixelCeiling: 12 * CATALOG_WORKER_IMAGE_LONG_EDGE_PIXELS ** 2,
      },
    };
    return CATALOG_EMBEDDING_WORKER_JOB_SCHEMA.parse({
      ...material,
      hash: contentHash(stableJson(material)),
    });
  };
  const jobs = [makeJob("image_text_retrieval"), makeJob("shape_similarity")];
  const temporaryRoot = `.basalt/test-worker-contract-${process.pid}`;
  await mkdir(temporaryRoot, { recursive: false });
  try {
    for (const job of jobs) {
      const path = `${temporaryRoot}/${job.purposes[0]}.json`;
      await writeFile(path, `${stableJson(job)}\n`, { flag: "wx" });
      const { stdout } = await executeFile(
        "python3",
        [workerPath, "--job", path, "--validate-job"],
        { cwd: process.cwd() },
      );
      const result = JSON.parse(stdout) as {
        readonly status: string;
        readonly kind: string;
        readonly purposes: readonly string[];
      };
      assert.deepEqual(result, {
        status: "eligible",
        kind: "CatalogEmbeddingWorkerJob",
        jobHash: job.hash,
        purposes: job.purposes,
      });
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: false });
  }

  const siglipJob = jobs[0]!;
  const receiptMaterial = {
    sourceContentHash,
    renderEvidenceHash,
    purpose: "image_text_retrieval" as const,
    modelId: siglipModel.modelId,
    modelCommitHash: siglipModel.sourceCommitHash,
    modelImplementationHash: contentHash("siglip-implementation"),
    preprocessingImplementationHash: contentHash("siglip-preprocessing"),
    aggregationImplementationHash: contentHash("siglip-aggregation"),
    perViewEvidenceHash: contentHash("siglip-per-view"),
    aggregate: { scaleMillionths: 1, values: [1, 2, 3, 4, 5, 6, 7, 8] },
    maximumViewDisagreementMillionths: 0,
    gpuMilliseconds: 1,
  };
  const outputMaterial = {
    kind: "CatalogEmbeddingWorkerOutput" as const,
    jobHash: siglipJob.hash,
    receipts: [receiptMaterial],
  };
  const output = CATALOG_EMBEDDING_WORKER_OUTPUT_SCHEMA.parse({
    ...outputMaterial,
    resultHash: contentHash(stableJson(outputMaterial)),
  });
  assert.equal(catalogWorkerOutputIsComplete(siglipJob, output), true);

  const invalidMaterial = {
    ...siglipJob,
    models: [dinoModel],
  };
  const { hash: _oldHash, ...invalidWithoutHash } = invalidMaterial;
  assert.throws(
    () =>
      CATALOG_EMBEDDING_WORKER_JOB_SCHEMA.parse({
        ...invalidWithoutHash,
        hash: contentHash(stableJson(invalidWithoutHash)),
      }),
    /requested purpose/iu,
  );
});
