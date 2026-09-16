import {
  CATALOG_MODEL_DECLARATIONS_SCHEMA,
  CATALOG_MODEL_ROLE_POLICY_SCHEMA,
  CATALOG_QUALIFICATION_DEVELOPMENT_CANDIDATE_POOL_SCHEMA,
  CATALOG_QUALIFICATION_DEVELOPMENT_VALIDATOR_CASE_SET_SCHEMA,
  CATALOG_QUALIFICATION_DEVELOPMENT_VALIDATOR_DECISION_SCHEMA,
  CATALOG_QUALIFICATION_DEVELOPMENT_VALIDATOR_VERDICT_SET_SCHEMA,
  CATALOG_SEARCH_METADATA_REQUEST_SET_SCHEMA,
  CATALOG_SEARCH_METADATA_SET_SCHEMA,
  CATALOG_SEARCH_POLICY_SCHEMA,
  CATALOG_SOURCE_NAME_HINT_SET_SCHEMA,
  CATALOG_VISUAL_REVIEW_INDEX_SCHEMA,
  CATALOG_VISUAL_VALIDATION_JSON_SCHEMA_HASH,
  CATALOG_QUALIFICATION_POOLING_CHANNELS,
  buildCatalogSearchIndex,
  developmentPoolingQuery,
  encodeCatalogEmbeddingMatrix,
  executeCatalogSearch,
  requireCatalogQualificationDevelopmentCandidatePool,
  requireCatalogQualificationDevelopmentValidatorCaseSet,
  requireCatalogQualificationDevelopmentValidatorComparison,
  requireReviewedCatalogQualificationDevelopmentValidatorVerdictSet,
  sealCatalogEmbeddingSet,
  sealCatalogQualificationDevelopmentCandidatePool,
  sealCatalogQualificationDevelopmentValidatorComparison,
  validateCatalogModelRolePolicy,
  type CatalogQualificationDescriptionSet,
  type CatalogQualificationDevelopmentCandidatePool,
  type CatalogQualificationDevelopmentQuerySet,
  type CatalogQualificationDevelopmentRelevanceDecision,
  type CatalogQualificationDevelopmentValidatorCaseSet,
  type CatalogQualificationDevelopmentValidatorComparison,
  type CatalogQualificationDevelopmentValidatorDecision,
  type CatalogQualificationDevelopmentValidatorVerdictSet,
  type CatalogSearchMetadataRequestSet,
  type CatalogSearchMetadataSet,
  type CatalogSearchResultSet,
  type CatalogValidationReceipt,
} from "@basalt/catalog-authoring";
import { CATALOG_MEASUREMENT_SET_SCHEMA } from "@basalt/catalog-model";
import { contentHash, stableJson } from "@basalt/contracts";
import {
  CATALOG_QUALIFICATION_ROOT,
  fileHash,
  readTextExact,
  type CatalogCommandContext,
} from "./catalog-command-support.js";
import { CATALOG_METADATA_PREPROCESSOR_IMPLEMENTATION_HASH } from "./catalog-metadata.js";
import {
  executeValidationRequests,
  generateImageTextEmbeddings,
  generateQueryEmbeddings,
  retainMatrixBytes,
} from "./catalog-qualification-runner.js";
import { CATALOG_SEARCH_BUILD_IMPLEMENTATION_HASH } from "./catalog-search.js";

type Executor = "local" | "modal";

const DEVELOPMENT_ROOT = `${CATALOG_QUALIFICATION_ROOT}/development`;

export async function executeDevelopmentCandidatePooling(input: {
  readonly queries: CatalogQualificationDevelopmentQuerySet;
  readonly descriptions: CatalogQualificationDescriptionSet;
  readonly metadataRequestSet: CatalogSearchMetadataRequestSet;
  readonly metadata: CatalogSearchMetadataSet;
  readonly executor: Executor;
  readonly context: CatalogCommandContext;
}): Promise<CatalogQualificationDevelopmentCandidatePool> {
  const requestSet = CATALOG_SEARCH_METADATA_REQUEST_SET_SCHEMA.parse(input.metadataRequestSet);
  const metadata = CATALOG_SEARCH_METADATA_SET_SCHEMA.parse(input.metadata);
  requireExactDevelopmentMetadata(input.descriptions, requestSet, metadata);

  const measurements = CATALOG_MEASUREMENT_SET_SCHEMA.parse(
    await input.context.readJson(".basalt/catalog/measurements.json"),
  );
  const renders = CATALOG_VISUAL_REVIEW_INDEX_SCHEMA.parse(
    await input.context.readJson(".basalt/catalog/review/index.json"),
  );
  const sourceNames = CATALOG_SOURCE_NAME_HINT_SET_SCHEMA.parse(
    await input.context.readJson(".basalt/catalog/metadata/source-name-hints.json"),
  );
  const searchPolicy = CATALOG_SEARCH_POLICY_SCHEMA.parse(
    await input.context.readJson("registry/search-policy.json"),
  );
  const declarations = CATALOG_MODEL_DECLARATIONS_SCHEMA.parse(
    await input.context.readJson("registry/catalog-models.json"),
  );
  if (
    measurements.hash !== input.queries.measurementSetHash ||
    renders.hash !== input.queries.visualReviewIndexHash ||
    measurements.sourceManifestHash !== requestSet.sourceManifestHash ||
    renders.sourceManifestHash !== requestSet.sourceManifestHash ||
    sourceNames.sourceManifestHash !== requestSet.sourceManifestHash
  )
    throw new Error("Development pooling evidence lineage is stale");

  const imageTextModel = declarations.models.find((entry) =>
    entry.capabilities.includes("image_text_retrieval"),
  );
  if (!imageTextModel) throw new Error("Development pooling requires an image-text model");
  const workerImplementationHash = await fileHash(
    input.context.root,
    "workers/catalog-metadata/worker.py",
  );
  const cohortSources = input.descriptions.assets.map((entry) => entry.sourceContentHash);
  const embedding = await generateImageTextEmbeddings({
    executor: input.executor,
    sourceContentHashes: cohortSources,
    sourceManifestHash: requestSet.sourceManifestHash,
    visualReviewIndexHash: renders.hash,
    model: imageTextModel,
    renders,
    workerImplementationHash,
    context: input.context,
  });
  const embeddingSet = sealCatalogEmbeddingSet({
    sourceManifestHash: requestSet.sourceManifestHash,
    visualReviewIndexHash: renders.hash,
    expected: cohortSources.map((sourceContentHash) => ({
      sourceContentHash,
      purpose: "image_text_retrieval" as const,
    })),
    receipts: embedding.receipts,
  });
  if (embeddingSet.status !== "eligible")
    throw new Error("Development image-text embeddings are incomplete");
  const encoded = encodeCatalogEmbeddingMatrix({
    sourceManifestHash: requestSet.sourceManifestHash,
    embeddingSet,
    purpose: "image_text_retrieval",
  });
  await retainMatrixBytes(input.context, encoded.matrix, encoded.bytes);
  await writeDevelopmentArtifact(input.context, "embedding-set", embeddingSet);
  await writeDevelopmentArtifact(input.context, "embedding-matrix", encoded.matrix);

  const index = buildCatalogSearchIndex({
    measurements,
    metadata,
    sourceNames,
    renders,
    imageTextEmbeddings: encoded.matrix,
    policy: searchPolicy,
    buildImplementationHash: CATALOG_SEARCH_BUILD_IMPLEMENTATION_HASH,
  });
  const expectedSearchableSources = measurements.assets.filter(
    (asset) =>
      !(asset.parts.length > 0 && asset.parts.every((part) => part.role === "collision_proxy")),
  ).length;
  if (
    index.status !== "eligible" ||
    index.coverage.searchableSources !== expectedSearchableSources ||
    index.coverage.excludedNonRenderableCollisionCompanions !==
      measurements.assets.length - expectedSearchableSources ||
    index.coverage.metadata !== cohortSources.length ||
    index.coverage.imageTextEmbedding !== cohortSources.length
  )
    throw new Error("Development pooling index does not have the required mixed coverage");
  await writeDevelopmentArtifact(input.context, "index", index);

  const resultDepth = input.queries.poolingPlan.resultDepthPerChannel;
  const executedQueries = input.queries.queries.flatMap((entry) =>
    CATALOG_QUALIFICATION_POOLING_CHANNELS.map((channel) => ({
      queryId: entry.queryId,
      channel,
      query: developmentPoolingQuery(entry.request, channel, resultDepth),
    })),
  );
  const embeddingQueries = executedQueries
    .filter((entry) => entry.channel === "hybrid" || entry.channel === "image_text_only")
    .map((entry) => entry.query);
  const queryEmbeddings = await generateQueryEmbeddings({
    queries: embeddingQueries,
    model: imageTextModel,
    workerImplementationHash,
    executor: input.executor,
    split: "development",
    context: input.context,
  });

  const resultSets: CatalogSearchResultSet[] = [];
  const retrievalsByQuery = new Map<
    string,
    Array<{
      channel: (typeof CATALOG_QUALIFICATION_POOLING_CHANNELS)[number];
      executedQueryHash: string;
      resultSetHash: string;
      rankedSourceContentHashes: string[];
    }>
  >();
  for (const entry of executedQueries) {
    const queryEmbedding = queryEmbeddings.get(entry.query.hash);
    const usesEmbedding = entry.channel === "hybrid" || entry.channel === "image_text_only";
    if (usesEmbedding !== (queryEmbedding !== undefined))
      throw new Error(`Development query embedding coverage is inconsistent for ${entry.queryId}`);
    const result = executeCatalogSearch({
      index,
      policy: searchPolicy,
      query: entry.query,
      ...(queryEmbedding
        ? {
            imageTextMatrix: encoded.matrix,
            imageTextMatrixBytes: encoded.bytes,
            queryEmbedding,
          }
        : {}),
    });
    if (result.status !== "eligible")
      throw new Error(`Development retrieval ${entry.queryId}/${entry.channel} is incomplete`);
    resultSets.push(result);
    await writeDevelopmentArtifact(input.context, "result-set", result);
    const retrievals = retrievalsByQuery.get(entry.queryId) ?? [];
    retrievals.push({
      channel: entry.channel,
      executedQueryHash: entry.query.hash,
      resultSetHash: result.hash,
      rankedSourceContentHashes: result.results.map((candidate) => candidate.sourceContentHash),
    });
    retrievalsByQuery.set(entry.queryId, retrievals);
  }

  const documentBySource = new Map(
    index.documents.map((entry) => [entry.sourceContentHash, entry] as const),
  );
  const cohort = new Set(cohortSources);
  const pool = sealCatalogQualificationDevelopmentCandidatePool({
    querySetHash: input.queries.hash,
    descriptionSetHash: input.descriptions.hash,
    sourceManifestHash: requestSet.sourceManifestHash,
    measurementSetHash: measurements.hash,
    visualReviewIndexHash: renders.hash,
    sourceNameHintSetHash: sourceNames.hash,
    searchPolicyHash: searchPolicy.hash,
    metadataWriter: metadataWriterIdentity(metadata, requestSet),
    imageTextRetriever: {
      modelId: imageTextModel.modelId,
      modelCommitHash: imageTextModel.sourceCommitHash,
      embeddingSetHash: embeddingSet.hash,
      embeddingMatrixHash: encoded.matrix.hash,
    },
    indexHash: index.hash,
    resultDepthPerChannel: resultDepth,
    queryPools: input.queries.queries.map((authored) => {
      const retrievals = retrievalsByQuery.get(authored.queryId);
      if (!retrievals) throw new Error(`Development retrieval omitted ${authored.queryId}`);
      const appearances = new Map<
        string,
        Array<{
          channel: (typeof CATALOG_QUALIFICATION_POOLING_CHANNELS)[number];
          rank: number;
          resultSetHash: string;
        }>
      >();
      for (const retrieval of retrievals)
        retrieval.rankedSourceContentHashes.forEach((sourceContentHash, indexValue) => {
          const current = appearances.get(sourceContentHash) ?? [];
          current.push({
            channel: retrieval.channel,
            rank: indexValue + 1,
            resultSetHash: retrieval.resultSetHash,
          });
          appearances.set(sourceContentHash, current);
        });
      return {
        queryId: authored.queryId,
        requestHash: authored.request.hash,
        retrievals,
        manualRecallSeeds: [],
        candidates: [...appearances].map(([sourceContentHash, retrievedBy]) => {
          const document = documentBySource.get(sourceContentHash);
          if (!document?.renderEvidenceHash)
            throw new Error(`Pooled source ${sourceContentHash} lacks review evidence`);
          return {
            sourceContentHash,
            population: cohort.has(sourceContentHash)
              ? ("reviewed_cohort" as const)
              : ("background" as const),
            measurementHash: document.measurementHash,
            renderEvidenceHash: document.renderEvidenceHash,
            retrievedBy,
            includedByManualRecallSeed: false,
          };
        }),
      };
    }),
  });
  requireCatalogQualificationDevelopmentCandidatePool({
    queries: input.queries,
    pool,
    resultSets,
  });
  const parsed = CATALOG_QUALIFICATION_DEVELOPMENT_CANDIDATE_POOL_SCHEMA.parse(pool);
  await input.context.writeJson(`${DEVELOPMENT_ROOT}/candidate-pool.json`, parsed);
  return parsed;
}

export async function executeDevelopmentValidatorComparison(input: {
  readonly queries: CatalogQualificationDevelopmentQuerySet;
  readonly pool: CatalogQualificationDevelopmentCandidatePool;
  readonly relevanceDecision: CatalogQualificationDevelopmentRelevanceDecision;
  readonly caseSet: CatalogQualificationDevelopmentValidatorCaseSet;
  readonly validatorDecision: CatalogQualificationDevelopmentValidatorDecision;
  readonly verdictSet: CatalogQualificationDevelopmentValidatorVerdictSet;
  readonly executor: Executor;
  readonly context: CatalogCommandContext;
}): Promise<CatalogQualificationDevelopmentValidatorComparison> {
  const caseSet = CATALOG_QUALIFICATION_DEVELOPMENT_VALIDATOR_CASE_SET_SCHEMA.parse(input.caseSet);
  const validatorDecision = CATALOG_QUALIFICATION_DEVELOPMENT_VALIDATOR_DECISION_SCHEMA.parse(
    input.validatorDecision,
  );
  const verdictSet = CATALOG_QUALIFICATION_DEVELOPMENT_VALIDATOR_VERDICT_SET_SCHEMA.parse(
    input.verdictSet,
  );
  requireCatalogQualificationDevelopmentValidatorCaseSet({
    queries: input.queries,
    pool: input.pool,
    relevanceDecision: input.relevanceDecision,
    caseSet,
  });
  requireReviewedCatalogQualificationDevelopmentValidatorVerdictSet({
    caseSet,
    decision: validatorDecision,
    verdictSet,
  });

  const measurements = CATALOG_MEASUREMENT_SET_SCHEMA.parse(
    await input.context.readJson(".basalt/catalog/measurements.json"),
  );
  const renders = CATALOG_VISUAL_REVIEW_INDEX_SCHEMA.parse(
    await input.context.readJson(".basalt/catalog/review/index.json"),
  );
  const declarations = CATALOG_MODEL_DECLARATIONS_SCHEMA.parse(
    await input.context.readJson("registry/catalog-models.json"),
  );
  const rolePolicy = CATALOG_MODEL_ROLE_POLICY_SCHEMA.parse(
    await input.context.readJson("registry/catalog-model-policy.json"),
  );
  validateCatalogModelRolePolicy(rolePolicy, declarations);
  const validationPrompt = await readTextExact(
    input.context.root,
    "registry/prompts/catalog-search-validation.txt",
  );
  const workerImplementationHash = await fileHash(
    input.context.root,
    "workers/catalog-metadata/worker.py",
  );
  if (
    measurements.hash !== caseSet.measurementSetHash ||
    renders.hash !== caseSet.visualReviewIndexHash ||
    contentHash(validationPrompt) !== caseSet.validationPromptTemplateHash ||
    CATALOG_VISUAL_VALIDATION_JSON_SCHEMA_HASH !== caseSet.validationSchemaHash ||
    CATALOG_METADATA_PREPROCESSOR_IMPLEMENTATION_HASH !== caseSet.preprocessingImplementationHash
  )
    throw new Error("Development validator execution evidence has drifted from its reviewed cases");

  const declaredById = new Map(declarations.models.map((entry) => [entry.modelId, entry] as const));
  const validatorIds = [
    rolePolicy.requirementValidator.modelId,
    ...rolePolicy.challengers
      .filter((entry) => entry.role === "requirement_validator")
      .map((entry) => entry.modelId),
  ];
  const models = [...new Set(validatorIds)].sort().map((modelId) => {
    const model = declaredById.get(modelId);
    if (!model || !model.capabilities.includes("requirement_validator"))
      throw new Error(`Development validator model is unavailable: ${modelId}`);
    return model;
  });
  if (models.length < 2)
    throw new Error("Development validator comparison requires a baseline and challenger");
  const measurementBySource = new Map(
    measurements.assets.map((entry) => [entry.source.contentHash, entry] as const),
  );
  const renderBySource = new Map(
    renders.items.map((entry) => [entry.sourceContentHash, entry] as const),
  );
  const requests = caseSet.cases
    .map((entry) => entry.validationRequest)
    .sort((left, right) => left.hash.localeCompare(right.hash));
  const receipts: CatalogValidationReceipt[] = [];
  for (const model of models)
    receipts.push(
      ...(await executeValidationRequests({
        requests,
        model,
        metadata: new Map(),
        measurements: measurementBySource,
        renders: renderBySource,
        prompt: validationPrompt,
        workerImplementationHash,
        executor: input.executor,
        split: "development",
        context: input.context,
      })),
    );

  const comparison = sealCatalogQualificationDevelopmentValidatorComparison({
    caseSet,
    verdictSet,
    modelDeclarationsHash: contentHash(stableJson(declarations)),
    modelRolePolicyHash: rolePolicy.hash,
    workerImplementationHash,
    models: models.map((entry) => ({
      modelId: entry.modelId,
      modelCommitHash: entry.sourceCommitHash,
    })),
    receipts,
  });
  requireCatalogQualificationDevelopmentValidatorComparison({
    caseSet,
    verdictSet,
    comparison,
    receipts,
  });
  await input.context.writeJson(`${DEVELOPMENT_ROOT}/validator-comparison.json`, comparison);
  return comparison;
}

function requireExactDevelopmentMetadata(
  descriptions: CatalogQualificationDescriptionSet,
  requestSet: CatalogSearchMetadataRequestSet,
  metadata: CatalogSearchMetadataSet,
): void {
  if (
    requestSet.status !== "eligible" ||
    requestSet.scope !== "qualification" ||
    metadata.status !== "eligible" ||
    metadata.requestSetHash !== requestSet.hash ||
    metadata.missingRequestHashes.length !== 0
  )
    throw new Error("Development pooling requires a complete qualification metadata run");
  const requestByHash = new Map(requestSet.requests.map((entry) => [entry.hash, entry] as const));
  const expectedSources = [...descriptions.assets.map((entry) => entry.sourceContentHash)].sort();
  const actualSources = metadata.receipts.map((entry) => entry.sourceContentHash).sort();
  if (stableJson(actualSources) !== stableJson(expectedSources))
    throw new Error("Development metadata does not cover the exact reviewed source cohort");
  for (const receipt of metadata.receipts) {
    const request = requestByHash.get(receipt.requestHash);
    if (
      receipt.status !== "eligible" ||
      !receipt.metadata ||
      !request ||
      request.sourceContentHash !== receipt.sourceContentHash ||
      request.measurementHash !== receipt.measurementHash ||
      request.renderEvidenceHash !== receipt.renderEvidenceHash ||
      request.viewSet !== "canonical_twelve" ||
      request.evidenceMode !== "visual_only"
    )
      throw new Error(`Development metadata receipt ${receipt.hash} is outside the sealed pilot`);
  }
}

function metadataWriterIdentity(
  metadata: CatalogSearchMetadataSet,
  requestSet: CatalogSearchMetadataRequestSet,
) {
  const modelIds = new Set(metadata.receipts.map((entry) => entry.modelId));
  const modelCommits = new Set(metadata.receipts.map((entry) => entry.modelCommitHash));
  if (modelIds.size !== 1 || modelCommits.size !== 1)
    throw new Error("Development metadata set mixes writer identities");
  return {
    modelId: [...modelIds][0]!,
    modelCommitHash: [...modelCommits][0]!,
    viewSet: "canonical_twelve" as const,
    evidenceMode: "visual_only" as const,
    requestSetHash: requestSet.hash,
    metadataSetHash: metadata.hash,
  };
}

async function writeDevelopmentArtifact(
  context: CatalogCommandContext,
  directory: "embedding-matrix" | "embedding-set" | "index" | "result-set",
  artifact: { readonly hash: string },
): Promise<void> {
  await context.writeJson(
    `${DEVELOPMENT_ROOT}/artifacts/${directory}/${artifact.hash}.json`,
    artifact,
  );
}
