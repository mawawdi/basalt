import { z } from "zod";
import { ImmutableBinaryArtifactStore } from "@basalt/artifact-store";
import {
  CATALOG_CANDIDATE_DECISION_POLICY_SCHEMA,
  CATALOG_EMBEDDING_MATRIX_SCHEMA,
  CATALOG_MODEL_DECLARATIONS_SCHEMA,
  CATALOG_MODEL_ROLE_POLICY_SCHEMA,
  CATALOG_QUERY_EMBEDDING_WORKER_JOB_SCHEMA,
  CATALOG_QUERY_EMBEDDING_WORKER_OUTPUT_SCHEMA,
  CATALOG_SEARCH_INDEX_SCHEMA,
  CATALOG_SEARCH_METADATA_SET_SCHEMA,
  CATALOG_SEARCH_POLICY_SCHEMA,
  CATALOG_SOURCE_NAME_HINT_SET_SCHEMA,
  CATALOG_VALIDATION_WORKER_JOB_SCHEMA,
  CATALOG_VALIDATION_WORKER_OUTPUT_SCHEMA,
  CATALOG_VISUAL_REVIEW_INDEX_SCHEMA,
  CATALOG_VISUAL_VALIDATION_JSON_SCHEMA,
  CATALOG_VISUAL_VALIDATION_JSON_SCHEMA_HASH,
  CATALOG_WORKER_IMAGE_LONG_EDGE_PIXELS,
  annotateCatalogSearchResults,
  buildCatalogSearchIndex,
  decideCatalogSearchOutcome,
  executeCatalogSearch,
  sealAssetMetricPromptSummary,
  sealCatalogQueryEmbeddingReceipt,
  sealCatalogSearchQuery,
  sealCatalogSearchValidationRequest,
  sealCatalogValidationReceipt,
  validateCatalogModelRolePolicy,
  type CatalogEmbeddingMatrix,
  type CatalogSearchQuery,
} from "@basalt/catalog-authoring";
import { CATALOG_MEASUREMENT_SET_SCHEMA } from "@basalt/catalog-model";
import { contentHash, quantizeQ32_32, stableJson } from "@basalt/contracts";
import {
  CATALOG_CAS_ROOT,
  CATALOG_METADATA_ROOT,
  CATALOG_SEARCH_ROOT,
  absolute,
  executeCachedCatalogWorker,
  fileHash,
  fileSize,
  parseBoolean,
  parseOptions,
  readText,
  requireInteger,
  sealCliArtifact,
  splitList,
  type CatalogCommandContext,
} from "./catalog-command-support.js";
import { CATALOG_METADATA_PREPROCESSOR_IMPLEMENTATION_HASH } from "./catalog-metadata.js";

const SEARCH_BUILD_IMPLEMENTATION_HASH = contentHash(
  stableJson({
    kind: "CatalogSearchIndexBuilder",
    algorithm: "progressive_field_bm25_normalized_rrf",
  }),
);

export async function runCatalogIndexCommand(
  values: readonly string[],
  context: CatalogCommandContext,
): Promise<void> {
  const options = parseOptions(values);
  const measurements = CATALOG_MEASUREMENT_SET_SCHEMA.parse(
    await context.readJson(options.get("--measurements") ?? ".basalt/catalog/measurements.json"),
  );
  const sourceNames = CATALOG_SOURCE_NAME_HINT_SET_SCHEMA.parse(
    await context.readJson(
      options.get("--source-names") ?? `${CATALOG_METADATA_ROOT}/source-name-hints.json`,
    ),
  );
  const renders = CATALOG_VISUAL_REVIEW_INDEX_SCHEMA.parse(
    await context.readJson(options.get("--renders") ?? ".basalt/catalog/review/index.json"),
  );
  const metadataRaw = await context.readOptionalJson(
    options.get("--metadata") ?? `${CATALOG_METADATA_ROOT}/set.json`,
  );
  const metadata = metadataRaw ? CATALOG_SEARCH_METADATA_SET_SCHEMA.parse(metadataRaw) : undefined;
  const imageTextMatrix = await readOptionalMatrix(options.get("--image-text-matrix"), context);
  const shapeMatrix = await readOptionalMatrix(options.get("--shape-matrix"), context);
  const policy = CATALOG_SEARCH_POLICY_SCHEMA.parse(
    await context.readJson(options.get("--policy") ?? "registry/search-policy.json"),
  );
  const index = buildCatalogSearchIndex({
    measurements,
    ...(metadata ? { metadata } : {}),
    sourceNames,
    renders,
    ...(imageTextMatrix ? { imageTextEmbeddings: imageTextMatrix } : {}),
    ...(shapeMatrix ? { shapeEmbeddings: shapeMatrix } : {}),
    policy,
    buildImplementationHash: SEARCH_BUILD_IMPLEMENTATION_HASH,
  });
  const output = options.get("--output") ?? `${CATALOG_SEARCH_ROOT}/index.json`;
  await context.writeJson(output, index);
  context.print({
    status: index.status,
    output: absolute(context.root, output),
    coverage: index.coverage,
    diagnostics: index.diagnostics,
    hash: index.hash,
  });
}

export async function runCatalogSearchCommand(
  values: readonly string[],
  context: CatalogCommandContext,
): Promise<void> {
  const [text, ...tail] = values;
  if (!text || text.startsWith("--")) throw new Error("catalog search requires free text");
  const options = parseOptions(tail);
  const policy = CATALOG_SEARCH_POLICY_SCHEMA.parse(
    await context.readJson(options.get("--policy") ?? "registry/search-policy.json"),
  );
  const index = CATALOG_SEARCH_INDEX_SCHEMA.parse(
    await context.readJson(options.get("--index") ?? `${CATALOG_SEARCH_ROOT}/index.json`),
  );
  const reference = options.get("--reference");
  const query = sealCatalogSearchQuery({
    text,
    ...(reference ? { referenceSourceContentHash: reference } : {}),
    styleTerms: splitList(options.get("--style")),
    rankingMode: reference
      ? "shape_only"
      : z
          .enum(["automatic", "basename_only", "hybrid", "image_text_only", "metadata_only"])
          .parse(options.get("--mode") ?? "automatic"),
    constraints: {
      ...(options.get("--maximum-size")
        ? { maximumSizeMeters: parseMetricVector(options.get("--maximum-size")!) }
        : {}),
      ...(options.get("--maximum-triangles")
        ? {
            maximumTriangles: requireInteger(
              options.get("--maximum-triangles")!,
              "maximum triangles",
            ),
          }
        : {}),
      ...(options.get("--maximum-bytes")
        ? {
            maximumSourceBytes: requireInteger(
              options.get("--maximum-bytes")!,
              "maximum source bytes",
            ),
          }
        : {}),
      commercialUseRequired: parseBoolean(options.get("--commercial-use") ?? "false"),
      redistributionRequired: parseBoolean(options.get("--redistribution") ?? "false"),
    },
    limit: Math.min(
      policy.maximumResults,
      requireInteger(options.get("--limit") ?? "20", "result limit"),
    ),
    validationLimit: Math.min(
      policy.maximumValidationCandidates,
      requireInteger(options.get("--validate") ?? "0", "validation limit"),
    ),
  });
  const imageTextMatrix = await readOptionalMatrix(
    options.get("--image-text-matrix") ??
      (index.imageTextEmbeddingMatrixHash
        ? `${CATALOG_SEARCH_ROOT}/image-text-matrix.json`
        : undefined),
    context,
  );
  const shapeMatrix = await readOptionalMatrix(
    options.get("--shape-matrix") ??
      (index.shapeEmbeddingMatrixHash ? `${CATALOG_SEARCH_ROOT}/shape-matrix.json` : undefined),
    context,
  );
  const imageTextBytes = imageTextMatrix
    ? await readMatrixBytes(imageTextMatrix, context)
    : undefined;
  const shapeBytes = shapeMatrix ? await readMatrixBytes(shapeMatrix, context) : undefined;
  const queryEmbedding =
    !reference && imageTextMatrix
      ? await generateQueryEmbedding(query, imageTextMatrix, options, context)
      : undefined;
  let result = executeCatalogSearch({
    index,
    policy,
    query,
    ...(imageTextMatrix && imageTextBytes
      ? { imageTextMatrix, imageTextMatrixBytes: imageTextBytes }
      : {}),
    ...(shapeMatrix && shapeBytes ? { shapeMatrix, shapeMatrixBytes: shapeBytes } : {}),
    ...(queryEmbedding ? { queryEmbedding } : {}),
  });
  if (query.validationLimit > 0)
    result = await validateSearchResults(result, query, options, context);
  const decisionPolicy = CATALOG_CANDIDATE_DECISION_POLICY_SCHEMA.parse(
    await context.readJson(
      options.get("--decision-policy") ?? "registry/candidate-decision-policy.json",
    ),
  );
  const decision = decideCatalogSearchOutcome({ results: result, policy: decisionPolicy });
  const artifact = { resultSet: result, decision };
  if (options.get("--output")) await context.writeJson(options.get("--output")!, artifact);
  context.print(artifact);
}

async function generateQueryEmbedding(
  query: CatalogSearchQuery,
  matrix: CatalogEmbeddingMatrix,
  options: ReadonlyMap<string, string>,
  context: CatalogCommandContext,
) {
  const declarations = CATALOG_MODEL_DECLARATIONS_SCHEMA.parse(
    await context.readJson(options.get("--models") ?? "registry/catalog-models.json"),
  );
  const model = declarations.models.find((entry) =>
    entry.capabilities.includes("image_text_retrieval"),
  );
  if (!model) throw new Error("No image-text retrieval model is declared");
  const workerImplementationHash = await fileHash(
    context.root,
    "workers/catalog-metadata/worker.py",
  );
  const job = sealCliArtifact(CATALOG_QUERY_EMBEDDING_WORKER_JOB_SCHEMA, {
    kind: "CatalogQueryEmbeddingWorkerJob" as const,
    workerImplementationHash,
    model,
    queries: [{ queryHash: query.hash, text: query.text }],
  });
  const output = await executeCachedCatalogWorker({
    job,
    outputSchema: CATALOG_QUERY_EMBEDDING_WORKER_OUTPUT_SCHEMA,
    executor: z.enum(["local", "modal"]).parse(options.get("--executor") ?? "modal"),
    force: false,
    context,
  });
  if (output.modelImplementationHash !== matrix.modelImplementationHash)
    throw new Error("Query embedding execution differs from the indexed SigLIP model");
  const item = output.items.find((entry) => entry.queryHash === query.hash);
  if (!item) throw new Error("Query embedding worker omitted the query");
  return sealCatalogQueryEmbeddingReceipt({
    queryHash: query.hash,
    modelImplementationHash: output.modelImplementationHash,
    preprocessingImplementationHash: output.preprocessingImplementationHash,
    workerOutputHash: output.resultHash,
    batchGpuMilliseconds: output.gpuMilliseconds,
    vector: item.vector,
  });
}

async function validateSearchResults(
  result: ReturnType<typeof executeCatalogSearch>,
  query: CatalogSearchQuery,
  options: ReadonlyMap<string, string>,
  context: CatalogCommandContext,
) {
  const pending = result.results.filter((entry) => entry.validation === "pending");
  if (pending.length === 0) return result;
  const metadataRaw = await context.readOptionalJson(
    options.get("--metadata") ?? `${CATALOG_METADATA_ROOT}/set.json`,
  );
  const metadata = metadataRaw ? CATALOG_SEARCH_METADATA_SET_SCHEMA.parse(metadataRaw) : undefined;
  const measurements = CATALOG_MEASUREMENT_SET_SCHEMA.parse(
    await context.readJson(options.get("--measurements") ?? ".basalt/catalog/measurements.json"),
  );
  const renders = CATALOG_VISUAL_REVIEW_INDEX_SCHEMA.parse(
    await context.readJson(options.get("--renders") ?? ".basalt/catalog/review/index.json"),
  );
  const declarations = CATALOG_MODEL_DECLARATIONS_SCHEMA.parse(
    await context.readJson(options.get("--models") ?? "registry/catalog-models.json"),
  );
  const rolePolicy = CATALOG_MODEL_ROLE_POLICY_SCHEMA.parse(
    await context.readJson(options.get("--model-policy") ?? "registry/catalog-model-policy.json"),
  );
  validateCatalogModelRolePolicy(rolePolicy, declarations);
  const model = declarations.models.find(
    (entry) => entry.modelId === rolePolicy.requirementValidator.modelId,
  );
  if (!model) throw new Error("Configured requirement validator is unavailable");
  const prompt = await readText(
    context.root,
    options.get("--validation-prompt") ?? "registry/prompts/catalog-search-validation.txt",
  );
  const promptTemplateHash = contentHash(prompt);
  const workerImplementationHash = await fileHash(
    context.root,
    "workers/catalog-metadata/worker.py",
  );
  const metadataBySource = new Map(
    (metadata?.receipts ?? []).map((entry) => [entry.sourceContentHash, entry] as const),
  );
  const measurementBySource = new Map(
    measurements.assets.map((entry) => [entry.source.contentHash, entry] as const),
  );
  const renderBySource = new Map(
    renders.items.map((entry) => [entry.sourceContentHash, entry] as const),
  );
  const inputs = [];
  for (const candidate of pending) {
    const measurement = measurementBySource.get(candidate.sourceContentHash);
    const render = renderBySource.get(candidate.sourceContentHash);
    const metadataReceipt = metadataBySource.get(candidate.sourceContentHash);
    if (!measurement || !render)
      throw new Error(`Validation evidence is incomplete for ${candidate.sourceContentHash}`);
    const views = await Promise.all(
      render.viewArtifacts.map(async (view) => ({
        viewId: view.viewId,
        rgbHash: render.evidence.views.find((entry) => entry.viewId === view.viewId)!.rgbHash,
        rgbRelativePath: view.rgbRelativePath,
        rgbSizeBytes: await fileSize(context.root, view.rgbRelativePath),
      })),
    );
    inputs.push({
      request: sealCatalogSearchValidationRequest({
        query,
        candidate: {
          sourceContentHash: candidate.sourceContentHash,
          ...(metadataReceipt ? { metadataReceiptHash: metadataReceipt.hash } : {}),
          measurementHash: measurement.hash,
          renderEvidenceHash: render.evidence.hash,
          metricSummary: sealAssetMetricPromptSummary(measurement),
          selectedRgbViews: views.map(({ viewId, rgbHash }) => ({ viewId, rgbHash })),
        },
        promptTemplateHash,
        preprocessingImplementationHash: CATALOG_METADATA_PREPROCESSOR_IMPLEMENTATION_HASH,
      }),
      ...(metadataReceipt ? { metadataReceipt } : {}),
      measurement,
      views,
    });
  }
  const receipts = [];
  for (let start = 0; start < inputs.length; start += 8) {
    const items = inputs.slice(start, start + 8);
    const sizes = items.flatMap((entry) => entry.views.map((view) => view.rgbSizeBytes));
    const job = sealCliArtifact(CATALOG_VALIDATION_WORKER_JOB_SCHEMA, {
      kind: "CatalogValidationWorkerJob" as const,
      promptTemplate: prompt,
      promptTemplateHash,
      outputSchema: CATALOG_VISUAL_VALIDATION_JSON_SCHEMA,
      outputSchemaHash: CATALOG_VISUAL_VALIDATION_JSON_SCHEMA_HASH,
      workerImplementationHash,
      model,
      items,
      inputBudget: {
        assetCount: items.length,
        evidenceFileCount: sizes.length,
        evidenceBytes: sizes.reduce((sum, entry) => sum + entry, 0),
        preprocessedPixelCeiling:
          sizes.length *
          CATALOG_WORKER_IMAGE_LONG_EDGE_PIXELS *
          CATALOG_WORKER_IMAGE_LONG_EDGE_PIXELS,
      },
    }) as z.output<typeof CATALOG_VALIDATION_WORKER_JOB_SCHEMA>;
    const output = await executeCachedCatalogWorker({
      job,
      outputSchema: CATALOG_VALIDATION_WORKER_OUTPUT_SCHEMA,
      executor: z.enum(["local", "modal"]).parse(options.get("--executor") ?? "modal"),
      force: false,
      context,
    });
    const requests = new Map(items.map((entry) => [entry.request.hash, entry.request] as const));
    for (const item of output.items) {
      const request = requests.get(item.requestHash);
      if (!request) throw new Error("Validator returned an unrequested candidate");
      receipts.push(
        sealCatalogValidationReceipt({
          request,
          status: item.status,
          adapterId: "catalog-metadata-worker",
          adapterImplementationHash: output.runtime.adapterImplementationHash,
          workerImplementationHash: output.runtime.workerImplementationHash,
          runtimeImplementationHash: output.runtime.runtimeImplementationHash,
          modelId: output.runtime.modelId,
          modelCommitHash: output.runtime.modelCommitHash,
          promptHash: item.promptHash,
          ...(item.rawOutputHash ? { rawOutputHash: item.rawOutputHash } : {}),
          ...(item.validation ? { validation: item.validation } : {}),
          diagnostics: item.diagnostics,
          resourceUsage: item.resourceUsage,
        }),
      );
    }
  }
  return annotateCatalogSearchResults({ results: result, receipts });
}

async function readOptionalMatrix(
  path: string | undefined,
  context: CatalogCommandContext,
): Promise<CatalogEmbeddingMatrix | undefined> {
  if (!path) return undefined;
  const raw = await context.readOptionalJson(path);
  return raw ? CATALOG_EMBEDDING_MATRIX_SCHEMA.parse(raw) : undefined;
}

async function readMatrixBytes(
  matrix: CatalogEmbeddingMatrix,
  context: CatalogCommandContext,
): Promise<Uint8Array> {
  const store = new ImmutableBinaryArtifactStore(absolute(context.root, CATALOG_CAS_ROOT), {
    maxBytes: 512 * 1024 * 1024,
  });
  return store.read({
    locator: `binary-artifacts/${matrix.blob.contentHash}.bin`,
    artifactHash: matrix.blob.contentHash,
    bytes: matrix.blob.sizeBytes,
    mediaType: matrix.blob.mediaType,
  });
}

function parseMetricVector(value: string) {
  const components = value.split(",").map(Number);
  if (components.length !== 3 || components.some((entry) => !Number.isFinite(entry) || entry < 0))
    throw new Error("Maximum size must be three nonnegative comma-separated meter values");
  return {
    x: quantizeQ32_32(components[0]!),
    y: quantizeQ32_32(components[1]!),
    z: quantizeQ32_32(components[2]!),
  };
}

export { SEARCH_BUILD_IMPLEMENTATION_HASH as CATALOG_SEARCH_BUILD_IMPLEMENTATION_HASH };
