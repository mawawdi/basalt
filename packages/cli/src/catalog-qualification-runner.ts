import { ImmutableBinaryArtifactStore } from "@basalt/artifact-store";
import { z } from "zod";
import {
  CATALOG_CANDIDATE_DECISION_POLICY_SCHEMA,
  CATALOG_LEAKAGE_ANALYSIS_SCHEMA,
  CATALOG_EMBEDDING_MATRIX_SCHEMA,
  CATALOG_EMBEDDING_SET_SCHEMA,
  CATALOG_EMBEDDING_WORKER_JOB_SCHEMA,
  CATALOG_EMBEDDING_WORKER_OUTPUT_SCHEMA,
  CATALOG_MODEL_DECLARATIONS_SCHEMA,
  CATALOG_MODEL_ROLE_POLICY_SCHEMA,
  CATALOG_QUERY_EMBEDDING_RECEIPT_SCHEMA,
  CATALOG_QUERY_EMBEDDING_WORKER_JOB_SCHEMA,
  CATALOG_QUERY_EMBEDDING_WORKER_OUTPUT_SCHEMA,
  CATALOG_QUALIFICATION_EVIDENCE_SCHEMA,
  CATALOG_QUALIFICATION_FIXTURE_SCHEMA,
  CATALOG_QUALIFICATION_POLICY_SCHEMA,
  CATALOG_QUALIFICATION_SELECTION_SCHEMA,
  requireCreatorReviewedQualificationFixture,
  CATALOG_SEARCH_INDEX_SCHEMA,
  CATALOG_SEARCH_METADATA_REQUEST_SET_SCHEMA,
  CATALOG_SEARCH_METADATA_JSON_SCHEMA_HASH,
  CATALOG_SEARCH_METADATA_SET_SCHEMA,
  CATALOG_SEARCH_POLICY_SCHEMA,
  CATALOG_SEARCH_RESULT_SET_SCHEMA,
  CATALOG_SEARCH_VALIDATION_REQUEST_SCHEMA,
  CATALOG_SOURCE_NAME_HINT_SET_SCHEMA,
  CATALOG_VALIDATION_RECEIPT_SCHEMA,
  CATALOG_CANDIDATE_DECISION_SCHEMA,
  CATALOG_VALIDATION_WORKER_JOB_SCHEMA,
  CATALOG_VALIDATION_WORKER_OUTPUT_SCHEMA,
  CATALOG_VISUAL_REVIEW_INDEX_SCHEMA,
  CATALOG_VISUAL_VALIDATION_JSON_SCHEMA,
  CATALOG_VISUAL_VALIDATION_JSON_SCHEMA_HASH,
  CATALOG_WORKER_IMAGE_LONG_EDGE_PIXELS,
  annotateCatalogSearchResults,
  buildCatalogSearchIndex,
  decideCatalogSearchOutcome,
  encodeCatalogEmbeddingMatrix,
  executeCatalogSearch,
  metadataViewIds,
  sealAssetMetricPromptSummary,
  sealCatalogEmbeddingReceipt,
  sealCatalogEmbeddingSet,
  sealCatalogQualificationEvidence,
  sealCatalogQueryEmbeddingReceipt,
  sealCatalogSearchMetadataSet,
  sealCatalogSearchQuery,
  sealCatalogSearchValidationRequest,
  sealCatalogValidationReceipt,
  type AssetSearchMetadataReceipt,
  type CatalogEmbeddingMatrix,
  type CatalogEmbeddingSet,
  type CatalogModelDeclaration,
  type CatalogQualificationAdjudicationDecision,
  type CatalogQualificationArtifacts,
  type CatalogQualificationEvidence,
  type CatalogQualificationFixture,
  type CatalogQualificationReviewPacket,
  type CatalogQualificationSelection,
  type CatalogQualificationSplit,
  type CatalogSearchIndex,
  type CatalogSearchMetadataSet,
  type CatalogSearchQuery,
  type CatalogSearchResultSet,
  type CatalogSearchValidationRequest,
  type CatalogValidationReceipt,
} from "@basalt/catalog-authoring";
import {
  CATALOG_MEASUREMENT_SET_SCHEMA,
  TRUSTED_SOURCE_MANIFEST_SCHEMA,
  type CatalogAssetArtifact,
} from "@basalt/catalog-model";
import { contentHash, stableJson } from "@basalt/contracts";
import { runCatalogMetadataCommand } from "./catalog-metadata.js";
import { CATALOG_METADATA_PREPROCESSOR_IMPLEMENTATION_HASH } from "./catalog-metadata.js";
import { CATALOG_SEARCH_BUILD_IMPLEMENTATION_HASH } from "./catalog-search.js";
import {
  CATALOG_CAS_ROOT,
  CATALOG_QUALIFICATION_ROOT,
  absolute,
  executeCachedCatalogWorker,
  fileHash,
  fileSize,
  readText,
  sealCliArtifact,
  type CatalogCommandContext,
} from "./catalog-command-support.js";

type Executor = "local" | "modal";
type Scenario = "mixed" | "uniform";
type Writer = CatalogQualificationFixture["writerConfigurations"][number];
type Validator = CatalogQualificationFixture["validatorConfigurations"][number];
type CatalogEmbeddingWorkerJob = z.output<typeof CATALOG_EMBEDDING_WORKER_JOB_SCHEMA>;

const ARTIFACT_DIRECTORIES = {
  metadataRequestSet: "metadata-request-set",
  metadataSet: "metadata-set",
  embeddingSet: "embedding-set",
  embeddingMatrix: "embedding-matrix",
  index: "index",
  queryEmbedding: "query-embedding",
  resultSet: "result-set",
  validationRequest: "validation-request",
  validationReceipt: "validation-receipt",
  decision: "decision",
} as const;

export async function executeQualificationSplit(input: {
  readonly split: CatalogQualificationSplit;
  readonly executor: Executor;
  readonly fixture: CatalogQualificationFixture;
  readonly proposalFixture: CatalogQualificationFixture;
  readonly reviewPacket: CatalogQualificationReviewPacket;
  readonly adjudicationDecision: CatalogQualificationAdjudicationDecision;
  readonly frozenSelection?: CatalogQualificationSelection;
  readonly context: CatalogCommandContext;
}): Promise<CatalogQualificationEvidence> {
  const fixture = CATALOG_QUALIFICATION_FIXTURE_SCHEMA.parse(input.fixture);
  requireCreatorReviewedQualificationFixture({
    fixture,
    proposal: input.proposalFixture,
    reviewPacket: input.reviewPacket,
    decision: input.adjudicationDecision,
  });
  const selection = input.frozenSelection
    ? CATALOG_QUALIFICATION_SELECTION_SCHEMA.parse(input.frozenSelection)
    : undefined;
  const runtime = await loadRuntimeInputs(fixture, input.context);
  const writers = selection
    ? [requireWriter(fixture, selection.selectedWriterModelId, selection.selectedWriterViewSet)]
    : fixture.writerConfigurations;
  const validators = selection
    ? [requireValidator(fixture, selection.selectedValidatorModelId)]
    : fixture.validatorConfigurations;
  if (input.split === "holdout") {
    if (!selection) throw new Error("Holdout execution requires the frozen model selection");
    if (
      selection.fixtureHash !== fixture.hash ||
      selection.workerImplementationHash !== runtime.workerImplementationHash
    )
      throw new Error("Frozen holdout selection is stale for the fixture or worker implementation");
    await establishHoldoutAttempt(input.context, fixture, selection, input.executor);
  } else if (selection) {
    throw new Error("Only holdout execution may consume a frozen selection");
  }

  const splitRoot = `${CATALOG_QUALIFICATION_ROOT}/${input.split}`;
  const quietContext = { ...input.context, print: (_value: unknown) => undefined };
  const requestSetPath = `${splitRoot}/metadata-requests.json`;
  await runCatalogMetadataCommand(
    [
      "prepare",
      "--scope",
      "qualification",
      "--split",
      input.split,
      "--fixture",
      "registry/catalog-qualification.json",
      "--view-set",
      [...new Set(writers.map((entry) => entry.viewSet))].sort().join(","),
      "--output",
      requestSetPath,
    ],
    quietContext,
  );
  const requestSet = CATALOG_SEARCH_METADATA_REQUEST_SET_SCHEMA.parse(
    await input.context.readJson(requestSetPath),
  );
  await writeQualificationArtifact(
    input.context,
    input.split,
    ARTIFACT_DIRECTORIES.metadataRequestSet,
    requestSet,
  );

  const metadataRuns: CatalogQualificationEvidence["metadataRuns"] = [];
  const metadataByConfiguration = new Map<string, CatalogSearchMetadataSet>();
  for (const writer of writers) {
    const uniformPath = `${splitRoot}/metadata/${writerIdentity(writer)}-uniform.json`;
    await runCatalogMetadataCommand(
      [
        "generate",
        "--requests",
        requestSetPath,
        "--model",
        writer.modelId,
        "--view-set",
        writer.viewSet,
        "--executor",
        input.executor,
        "--output",
        uniformPath,
      ],
      quietContext,
    );
    const uniform = CATALOG_SEARCH_METADATA_SET_SCHEMA.parse(
      await input.context.readJson(uniformPath),
    );
    if (uniform.status !== "eligible")
      throw new Error(`Metadata run ${writerIdentity(writer)} did not complete`);
    for (const scenario of ["mixed", "uniform"] as const) {
      const expectedSources = enrichedSources(
        candidatePool(fixture, input.split, scenario),
        "metadata",
      );
      const receipts = uniform.receipts.filter((entry) =>
        expectedSources.includes(entry.sourceContentHash),
      );
      const set = sealCatalogSearchMetadataSet({
        requestSetHash: requestSet.hash,
        requestedHashes: receipts.map((entry) => entry.requestHash),
        receipts,
      });
      if (set.status !== "eligible" || set.receipts.length !== expectedSources.length)
        throw new Error(`Metadata run ${writerIdentity(writer)} lacks ${scenario} coverage`);
      await writeQualificationArtifact(
        input.context,
        input.split,
        ARTIFACT_DIRECTORIES.metadataSet,
        set,
      );
      metadataByConfiguration.set(`${writerIdentity(writer)}:${scenario}`, set);
      metadataRuns.push({
        writerModelId: writer.modelId,
        writerModelCommitHash: writer.modelCommitHash,
        writerViewSet: writer.viewSet,
        coverageScenario: scenario,
        requestSetHash: requestSet.hash,
        metadataSetHash: set.hash,
      });
    }
  }

  const embedding = await generateImageTextEmbeddings({
    executor: input.executor,
    sourceContentHashes: candidatePool(fixture, input.split, "uniform").assets.map(
      (entry) => entry.sourceContentHash,
    ),
    sourceManifestHash: fixture.sourceManifestHash,
    visualReviewIndexHash: fixture.visualReviewIndexHash,
    model: runtime.imageTextModel,
    renders: runtime.renders,
    workerImplementationHash: runtime.workerImplementationHash,
    context: input.context,
  });
  const embeddingRuns: CatalogQualificationEvidence["embeddingRuns"] = [];
  for (const scenario of ["mixed", "uniform"] as const) {
    const sources = enrichedSources(candidatePool(fixture, input.split, scenario), "image_text");
    const receipts = embedding.receipts.filter((entry) =>
      sources.includes(entry.sourceContentHash),
    );
    const set = sealCatalogEmbeddingSet({
      sourceManifestHash: fixture.sourceManifestHash,
      visualReviewIndexHash: fixture.visualReviewIndexHash,
      expected: sources.map((sourceContentHash) => ({
        sourceContentHash,
        purpose: "image_text_retrieval" as const,
      })),
      receipts,
    });
    if (set.status !== "eligible")
      throw new Error(`Image-text embedding run lacks ${scenario} coverage`);
    const encoded = encodeCatalogEmbeddingMatrix({
      sourceManifestHash: fixture.sourceManifestHash,
      embeddingSet: set,
      purpose: "image_text_retrieval",
    });
    await retainMatrixBytes(input.context, encoded.matrix, encoded.bytes);
    await writeQualificationArtifact(
      input.context,
      input.split,
      ARTIFACT_DIRECTORIES.embeddingSet,
      set,
    );
    await writeQualificationArtifact(
      input.context,
      input.split,
      ARTIFACT_DIRECTORIES.embeddingMatrix,
      encoded.matrix,
    );
    embedding.sets.set(scenario, set);
    embedding.matrices.set(scenario, encoded.matrix);
    embedding.bytes.set(scenario, encoded.bytes);
    embeddingRuns.push({
      coverageScenario: scenario,
      modelId: runtime.imageTextModel.modelId,
      modelCommitHash: runtime.imageTextModel.sourceCommitHash,
      embeddingSetHash: set.hash,
      embeddingMatrixHash: encoded.matrix.hash,
    });
  }

  const indexRuns: CatalogQualificationEvidence["indexRuns"] = [];
  const indexes = new Map<string, CatalogSearchIndex>();
  for (const writer of writers)
    for (const scenario of ["mixed", "uniform"] as const) {
      const pool = candidatePool(fixture, input.split, scenario);
      const index = buildCatalogSearchIndex({
        measurements: runtime.measurements,
        metadata: metadataByConfiguration.get(`${writerIdentity(writer)}:${scenario}`)!,
        sourceNames: runtime.sourceNames,
        renders: runtime.renders,
        imageTextEmbeddings: embedding.matrices.get(scenario)!,
        candidateSourceContentHashes: pool.assets.map((entry) => entry.sourceContentHash),
        policy: runtime.searchPolicy,
        buildImplementationHash: CATALOG_SEARCH_BUILD_IMPLEMENTATION_HASH,
      });
      if (index.status !== "eligible") throw new Error("Qualification index is incomplete");
      await writeQualificationArtifact(
        input.context,
        input.split,
        ARTIFACT_DIRECTORIES.index,
        index,
      );
      indexes.set(`${writerIdentity(writer)}:${scenario}`, index);
      indexRuns.push({
        writerModelId: writer.modelId,
        writerViewSet: writer.viewSet,
        coverageScenario: scenario,
        candidatePoolHash: pool.hash,
        indexHash: index.hash,
      });
    }

  const splitQueries = fixture.queries.filter((entry) => entry.split === input.split);
  const queryEmbeddings = await generateQueryEmbeddings({
    queries: splitQueries.flatMap((entry) => [
      qualificationQuery(entry.query, "image_text_only", 0),
      qualificationQuery(entry.query, "hybrid", 0),
      qualificationQuery(entry.query, "hybrid", entry.query.validationLimit),
    ]),
    model: runtime.imageTextModel,
    workerImplementationHash: runtime.workerImplementationHash,
    executor: input.executor,
    split: input.split,
    context: input.context,
  });

  const retrievalRuns: CatalogQualificationEvidence["retrievalRuns"] = [];
  for (const writer of writers)
    for (const fixtureQuery of splitQueries)
      for (const { scenario, channel } of [
        ...(["basename_only", "hybrid", "image_text_only", "metadata_only"] as const).map(
          (channel) => ({ scenario: "uniform" as const, channel }),
        ),
        { scenario: "mixed" as const, channel: "hybrid" as const },
      ]) {
        const query = qualificationQuery(fixtureQuery.query, channel, 0);
        const queryEmbedding =
          channel === "hybrid" || channel === "image_text_only"
            ? queryEmbeddings.get(query.hash)
            : undefined;
        const result = executeCatalogSearch({
          index: indexes.get(`${writerIdentity(writer)}:${scenario}`)!,
          policy: runtime.searchPolicy,
          query,
          ...(queryEmbedding
            ? {
                imageTextMatrix: embedding.matrices.get(scenario)!,
                imageTextMatrixBytes: embedding.bytes.get(scenario)!,
                queryEmbedding,
              }
            : {}),
        });
        await writeQualificationArtifact(
          input.context,
          input.split,
          ARTIFACT_DIRECTORIES.resultSet,
          result,
        );
        retrievalRuns.push({
          queryId: fixtureQuery.queryId,
          writerModelId: writer.modelId,
          writerViewSet: writer.viewSet,
          channel,
          coverageScenario: scenario,
          queryHash: query.hash,
          ...(queryEmbedding ? { queryEmbeddingReceiptHash: queryEmbedding.hash } : {}),
          resultSetHash: result.hash,
        });
      }

  const independentValidationRuns: CatalogQualificationEvidence["independentValidationRuns"] = [];
  const validationReceipts: CatalogValidationReceipt[] = [];
  for (const fixtureCase of fixture.validationCases.filter((entry) => entry.split === input.split))
    await writeQualificationArtifact(
      input.context,
      input.split,
      ARTIFACT_DIRECTORIES.validationRequest,
      fixtureCase.request,
    );
  for (const validator of validators) {
    const cases = fixture.validationCases.filter((entry) => entry.split === input.split);
    const receipts = await executeValidationRequests({
      requests: cases.map((entry) => entry.request),
      model: runtime.models.get(validator.modelId)!,
      metadata: new Map(),
      measurements: runtime.measurementBySource,
      renders: runtime.renderBySource,
      prompt: runtime.validationPrompt,
      workerImplementationHash: runtime.workerImplementationHash,
      executor: input.executor,
      split: input.split,
      context: input.context,
    });
    validationReceipts.push(...receipts);
    for (const [index, fixtureCase] of cases.entries()) {
      const receipt = receipts[index]!;
      independentValidationRuns.push({
        caseId: fixtureCase.caseId,
        validatorModelId: validator.modelId,
        validatorModelCommitHash: validator.modelCommitHash,
        requestHash: fixtureCase.request.hash,
        receiptHash: receipt.hash,
      });
    }
  }

  const decisionRuns: CatalogQualificationEvidence["decisionRuns"] = [];
  for (const writer of writers) {
    const index = indexes.get(`${writerIdentity(writer)}:mixed`)!;
    const metadata = metadataByConfiguration.get(`${writerIdentity(writer)}:mixed`)!;
    const metadataBySource = new Map(
      metadata.receipts.map((entry) => [entry.sourceContentHash, entry] as const),
    );
    const baseResults = splitQueries.map((fixtureQuery) => {
      const query = qualificationQuery(
        fixtureQuery.query,
        "hybrid",
        fixtureQuery.query.validationLimit,
      );
      return {
        fixtureQuery,
        result: executeCatalogSearch({
          index,
          policy: runtime.searchPolicy,
          query,
          imageTextMatrix: embedding.matrices.get("mixed")!,
          imageTextMatrixBytes: embedding.bytes.get("mixed")!,
          queryEmbedding: queryEmbeddings.get(query.hash)!,
        }),
      };
    });
    for (const validator of validators) {
      const requestsByResult = new Map<string, CatalogSearchValidationRequest[]>();
      const requests: CatalogSearchValidationRequest[] = [];
      for (const { result } of baseResults) {
        const pending = result.results.filter((entry) => entry.validation === "pending");
        const current = pending.map((candidate) =>
          createValidationRequest({
            query: result.query,
            candidate,
            metadata: metadataBySource.get(candidate.sourceContentHash),
            measurement: runtime.measurementBySource.get(candidate.sourceContentHash)!,
            render: runtime.renderBySource.get(candidate.sourceContentHash)!,
            validationPromptTemplateHash: fixture.validationPromptTemplateHash,
          }),
        );
        requestsByResult.set(result.hash, current);
        requests.push(...current);
      }
      for (const request of requests)
        await writeQualificationArtifact(
          input.context,
          input.split,
          ARTIFACT_DIRECTORIES.validationRequest,
          request,
        );
      const receipts = await executeValidationRequests({
        requests,
        model: runtime.models.get(validator.modelId)!,
        metadata: metadataBySource,
        measurements: runtime.measurementBySource,
        renders: runtime.renderBySource,
        prompt: runtime.validationPrompt,
        workerImplementationHash: runtime.workerImplementationHash,
        executor: input.executor,
        split: input.split,
        context: input.context,
      });
      validationReceipts.push(...receipts);
      const receiptByRequest = new Map(
        receipts.map((entry) => [entry.requestHash, entry] as const),
      );
      for (const { fixtureQuery, result } of baseResults) {
        const requestsForResult = requestsByResult.get(result.hash)!;
        const resultReceipts = requestsForResult.map((entry) => receiptByRequest.get(entry.hash)!);
        const annotated = annotateCatalogSearchResults({
          results: result,
          receipts: resultReceipts,
        });
        const decision = decideCatalogSearchOutcome({
          results: annotated,
          policy: runtime.decisionPolicy,
        });
        await writeQualificationArtifact(
          input.context,
          input.split,
          ARTIFACT_DIRECTORIES.resultSet,
          annotated,
        );
        await writeQualificationArtifact(
          input.context,
          input.split,
          ARTIFACT_DIRECTORIES.decision,
          decision,
        );
        decisionRuns.push({
          queryId: fixtureQuery.queryId,
          writerModelId: writer.modelId,
          writerViewSet: writer.viewSet,
          validatorModelId: validator.modelId,
          coverageScenario: "mixed",
          resultSetHash: annotated.hash,
          validations: requestsForResult.map((request) => ({
            requestHash: request.hash,
            receiptHash: receiptByRequest.get(request.hash)!.hash,
          })),
          decisionHash: decision.hash,
        });
      }
    }
  }

  const evidence = sealCatalogQualificationEvidence({
    split: input.split,
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
    workerImplementationHash: runtime.workerImplementationHash,
    ...(selection ? { frozenSelectionHash: selection.hash } : {}),
    metadataRuns,
    embeddingRuns,
    indexRuns,
    retrievalRuns,
    independentValidationRuns,
    decisionRuns,
  });
  await input.context.writeJson(`${splitRoot}/evidence.json`, evidence);
  return evidence;
}

export async function loadQualificationArtifacts(input: {
  readonly split: CatalogQualificationSplit;
  readonly fixture: CatalogQualificationFixture;
  readonly evidence: CatalogQualificationEvidence;
  readonly context: CatalogCommandContext;
}): Promise<CatalogQualificationArtifacts> {
  const evidence = CATALOG_QUALIFICATION_EVIDENCE_SCHEMA.parse(input.evidence);
  if (evidence.split !== input.split) throw new Error("Qualification evidence split mismatch");
  const metadataRequestSets = await readArtifacts(
    input.context,
    input.split,
    ARTIFACT_DIRECTORIES.metadataRequestSet,
    unique(evidence.metadataRuns.map((entry) => entry.requestSetHash)),
    CATALOG_SEARCH_METADATA_REQUEST_SET_SCHEMA,
  );
  const metadataSets = await readArtifacts(
    input.context,
    input.split,
    ARTIFACT_DIRECTORIES.metadataSet,
    unique(evidence.metadataRuns.map((entry) => entry.metadataSetHash)),
    CATALOG_SEARCH_METADATA_SET_SCHEMA,
  );
  const embeddingSets = await readArtifacts(
    input.context,
    input.split,
    ARTIFACT_DIRECTORIES.embeddingSet,
    unique(evidence.embeddingRuns.map((entry) => entry.embeddingSetHash)),
    CATALOG_EMBEDDING_SET_SCHEMA,
  );
  const embeddingMatrices = await readArtifacts(
    input.context,
    input.split,
    ARTIFACT_DIRECTORIES.embeddingMatrix,
    unique(evidence.embeddingRuns.map((entry) => entry.embeddingMatrixHash)),
    CATALOG_EMBEDDING_MATRIX_SCHEMA,
  );
  const indexes = await readArtifacts(
    input.context,
    input.split,
    ARTIFACT_DIRECTORIES.index,
    unique(evidence.indexRuns.map((entry) => entry.indexHash)),
    CATALOG_SEARCH_INDEX_SCHEMA,
  );
  const resultSets = await readArtifacts(
    input.context,
    input.split,
    ARTIFACT_DIRECTORIES.resultSet,
    unique([
      ...evidence.retrievalRuns.map((entry) => entry.resultSetHash),
      ...evidence.decisionRuns.map((entry) => entry.resultSetHash),
    ]),
    CATALOG_SEARCH_RESULT_SET_SCHEMA,
  );
  const queryEmbeddingReceipts = await readArtifacts(
    input.context,
    input.split,
    ARTIFACT_DIRECTORIES.queryEmbedding,
    unique(
      resultSets.flatMap((entry) =>
        entry.queryEmbeddingReceiptHash ? [entry.queryEmbeddingReceiptHash] : [],
      ),
    ),
    CATALOG_QUERY_EMBEDDING_RECEIPT_SCHEMA,
  );
  const validationPairs = [
    ...evidence.independentValidationRuns.map((entry) => ({
      requestHash: entry.requestHash,
      receiptHash: entry.receiptHash,
    })),
    ...evidence.decisionRuns.flatMap((entry) => entry.validations),
  ];
  const validationRequests = await readArtifacts(
    input.context,
    input.split,
    ARTIFACT_DIRECTORIES.validationRequest,
    unique(validationPairs.map((entry) => entry.requestHash)),
    CATALOG_SEARCH_VALIDATION_REQUEST_SCHEMA,
  );
  const validationReceipts = await readArtifacts(
    input.context,
    input.split,
    ARTIFACT_DIRECTORIES.validationReceipt,
    unique(validationPairs.map((entry) => entry.receiptHash)),
    CATALOG_VALIDATION_RECEIPT_SCHEMA,
  );
  const decisions = await readArtifacts(
    input.context,
    input.split,
    ARTIFACT_DIRECTORIES.decision,
    unique(evidence.decisionRuns.map((entry) => entry.decisionHash)),
    CATALOG_CANDIDATE_DECISION_SCHEMA,
  );
  return {
    metadataRequestSets,
    metadataSets,
    embeddingSets,
    embeddingMatrices,
    indexes,
    queryEmbeddingReceipts,
    resultSets,
    validationRequests,
    validationReceipts,
    decisions,
  };
}

async function loadRuntimeInputs(
  fixture: CatalogQualificationFixture,
  context: CatalogCommandContext,
) {
  const sourceManifest = TRUSTED_SOURCE_MANIFEST_SCHEMA.parse(
    await context.readJson("registry/source-manifest.json"),
  );
  const measurements = CATALOG_MEASUREMENT_SET_SCHEMA.parse(
    await context.readJson(".basalt/catalog/measurements.json"),
  );
  const renders = CATALOG_VISUAL_REVIEW_INDEX_SCHEMA.parse(
    await context.readJson(".basalt/catalog/review/index.json"),
  );
  const sourceNames = CATALOG_SOURCE_NAME_HINT_SET_SCHEMA.parse(
    await context.readJson(".basalt/catalog/metadata/source-name-hints.json"),
  );
  const declarations = CATALOG_MODEL_DECLARATIONS_SCHEMA.parse(
    await context.readJson("registry/catalog-models.json"),
  );
  const rolePolicy = CATALOG_MODEL_ROLE_POLICY_SCHEMA.parse(
    await context.readJson("registry/catalog-model-policy.json"),
  );
  const qualificationPolicy = CATALOG_QUALIFICATION_POLICY_SCHEMA.parse(
    await context.readJson("registry/qualification-policy.json"),
  );
  const leakage = CATALOG_LEAKAGE_ANALYSIS_SCHEMA.parse(
    await context.readJson("registry/leakage-analysis.json"),
  );
  const searchPolicy = CATALOG_SEARCH_POLICY_SCHEMA.parse(
    await context.readJson("registry/search-policy.json"),
  );
  const decisionPolicy = CATALOG_CANDIDATE_DECISION_POLICY_SCHEMA.parse(
    await context.readJson("registry/candidate-decision-policy.json"),
  );
  const metadataPrompt = await readText(
    context.root,
    "registry/prompts/catalog-search-metadata.txt",
  );
  const validationPrompt = await readText(
    context.root,
    "registry/prompts/catalog-search-validation.txt",
  );
  const workerImplementationHash = await fileHash(
    context.root,
    "workers/catalog-metadata/worker.py",
  );
  const lineages = [
    ["source manifest", contentHash(stableJson(sourceManifest)), fixture.sourceManifestHash],
    ["measurement set", measurements.hash, fixture.measurementSetHash],
    ["visual review index", renders.hash, fixture.visualReviewIndexHash],
    ["search policy", searchPolicy.hash, fixture.searchPolicyHash],
    ["candidate-decision policy", decisionPolicy.hash, fixture.candidateDecisionPolicyHash],
    ["qualification policy", qualificationPolicy.hash, fixture.qualificationPolicyHash],
    ["leakage analysis", leakage.hash, fixture.leakageAnalysisHash],
    ["model declarations", contentHash(stableJson(declarations)), fixture.modelDeclarationsHash],
    ["model-role policy", rolePolicy.hash, fixture.modelRolePolicyHash],
    ["metadata prompt", contentHash(metadataPrompt), fixture.metadataPromptTemplateHash],
    ["validation prompt", contentHash(validationPrompt), fixture.validationPromptTemplateHash],
    ["metadata schema", CATALOG_SEARCH_METADATA_JSON_SCHEMA_HASH, fixture.metadataSchemaHash],
    ["validation schema", CATALOG_VISUAL_VALIDATION_JSON_SCHEMA_HASH, fixture.validationSchemaHash],
  ] as const;
  for (const [name, actual, expected] of lineages)
    if (actual !== expected) throw new Error(`Qualification fixture binds stale ${name}`);
  if (sourceNames.sourceManifestHash !== fixture.sourceManifestHash)
    throw new Error("Qualification basename evidence binds another source manifest");
  const models = new Map(declarations.models.map((entry) => [entry.modelId, entry] as const));
  for (const writer of fixture.writerConfigurations) {
    const model = models.get(writer.modelId);
    if (
      !model ||
      model.sourceCommitHash !== writer.modelCommitHash ||
      !model.capabilities.includes("metadata_writer")
    )
      throw new Error(`Qualification writer ${writerIdentity(writer)} is stale or unavailable`);
  }
  for (const validator of fixture.validatorConfigurations) {
    const model = models.get(validator.modelId);
    if (
      !model ||
      model.sourceCommitHash !== validator.modelCommitHash ||
      !model.capabilities.includes("requirement_validator")
    )
      throw new Error(`Qualification validator ${validator.modelId} is stale or unavailable`);
  }
  const imageTextModel = declarations.models.find((entry) =>
    entry.capabilities.includes("image_text_retrieval"),
  );
  if (!imageTextModel) throw new Error("No image-text retrieval model is declared");
  return {
    measurements,
    renders,
    sourceNames,
    searchPolicy,
    decisionPolicy,
    validationPrompt,
    workerImplementationHash,
    imageTextModel,
    models,
    measurementBySource: new Map(
      measurements.assets.map((entry) => [entry.source.contentHash, entry] as const),
    ),
    renderBySource: new Map(
      renders.items.map((entry) => [entry.sourceContentHash, entry] as const),
    ),
  };
}

export async function generateImageTextEmbeddings(input: {
  readonly executor: Executor;
  readonly sourceContentHashes: readonly string[];
  readonly sourceManifestHash: string;
  readonly visualReviewIndexHash: string;
  readonly model: CatalogModelDeclaration;
  readonly renders: ReturnType<typeof CATALOG_VISUAL_REVIEW_INDEX_SCHEMA.parse>;
  readonly workerImplementationHash: string;
  readonly context: CatalogCommandContext;
}) {
  const sources = [...input.sourceContentHashes];
  const renderBySource = new Map(
    input.renders.items.map((entry) => [entry.sourceContentHash, entry] as const),
  );
  const workerItems: CatalogEmbeddingWorkerJob["items"] = [];
  for (const sourceContentHash of sources) {
    const render = renderBySource.get(sourceContentHash);
    if (!render) throw new Error(`Missing render evidence for ${sourceContentHash}`);
    const evidenceByView = new Map(
      render.evidence.views.map((entry) => [entry.viewId, entry] as const),
    );
    const artifactsByView = new Map(
      render.viewArtifacts.map((entry) => [entry.viewId, entry] as const),
    );
    const views = await Promise.all(
      metadataViewIds("canonical_twelve").map(async (viewId) => {
        const evidence = evidenceByView.get(viewId);
        const artifact = artifactsByView.get(viewId);
        if (!evidence || !artifact) throw new Error(`Render ${sourceContentHash} lacks ${viewId}`);
        return {
          viewId,
          rgbRelativePath: artifact.rgbRelativePath,
          rgbHash: evidence.rgbHash,
          rgbSizeBytes: await fileSize(input.context.root, artifact.rgbRelativePath),
        };
      }),
    );
    workerItems.push({
      sourceContentHash,
      renderEvidenceHash: render.evidence.hash,
      views,
    });
  }
  const receipts = [];
  for (let start = 0; start < workerItems.length; start += 8) {
    const items = workerItems.slice(start, start + 8);
    const sizes = items.flatMap((entry) => entry.views.map((view) => view.rgbSizeBytes!));
    const job = sealCliArtifact(CATALOG_EMBEDDING_WORKER_JOB_SCHEMA, {
      kind: "CatalogEmbeddingWorkerJob" as const,
      sourceManifestHash: input.sourceManifestHash,
      visualReviewIndexHash: input.visualReviewIndexHash,
      workerImplementationHash: input.workerImplementationHash,
      purposes: ["image_text_retrieval"] as const,
      models: [input.model],
      items,
      inputBudget: {
        assetCount: items.length,
        evidenceFileCount: sizes.length,
        evidenceBytes: sizes.reduce((sum, value) => sum + value, 0),
        preprocessedPixelCeiling:
          sizes.length *
          CATALOG_WORKER_IMAGE_LONG_EDGE_PIXELS *
          CATALOG_WORKER_IMAGE_LONG_EDGE_PIXELS,
      },
    }) as CatalogEmbeddingWorkerJob;
    const output = await executeCachedCatalogWorker({
      job,
      outputSchema: CATALOG_EMBEDDING_WORKER_OUTPUT_SCHEMA,
      executor: input.executor,
      force: false,
      context: input.context,
    });
    receipts.push(
      ...output.receipts.map((entry) =>
        sealCatalogEmbeddingReceipt({
          sourceContentHash: entry.sourceContentHash,
          renderEvidenceHash: entry.renderEvidenceHash,
          purpose: entry.purpose,
          modelId: entry.modelId,
          modelCommitHash: entry.modelCommitHash,
          modelImplementationHash: entry.modelImplementationHash,
          preprocessingImplementationHash: entry.preprocessingImplementationHash,
          aggregationImplementationHash: entry.aggregationImplementationHash,
          perViewEvidenceHash: entry.perViewEvidenceHash,
          aggregate: entry.aggregate,
          maximumViewDisagreementMillionths: entry.maximumViewDisagreementMillionths,
          gpuMilliseconds: entry.gpuMilliseconds,
        }),
      ),
    );
  }
  return {
    receipts,
    sets: new Map<Scenario, CatalogEmbeddingSet>(),
    matrices: new Map<Scenario, CatalogEmbeddingMatrix>(),
    bytes: new Map<Scenario, Uint8Array>(),
  };
}

export async function generateQueryEmbeddings(input: {
  readonly queries: readonly CatalogSearchQuery[];
  readonly model: CatalogModelDeclaration;
  readonly workerImplementationHash: string;
  readonly executor: Executor;
  readonly split: CatalogQualificationSplit;
  readonly context: CatalogCommandContext;
}): Promise<Map<string, ReturnType<typeof sealCatalogQueryEmbeddingReceipt>>> {
  const uniqueQueries = new Map(input.queries.map((entry) => [entry.hash, entry] as const));
  const receipts = new Map<string, ReturnType<typeof sealCatalogQueryEmbeddingReceipt>>();
  const ordered = [...uniqueQueries.values()].sort((left, right) =>
    left.hash.localeCompare(right.hash),
  );
  for (let start = 0; start < ordered.length; start += 256) {
    const queries = ordered.slice(start, start + 256);
    const job = sealCliArtifact(CATALOG_QUERY_EMBEDDING_WORKER_JOB_SCHEMA, {
      kind: "CatalogQueryEmbeddingWorkerJob" as const,
      workerImplementationHash: input.workerImplementationHash,
      model: input.model,
      queries: queries.map((entry) => ({ queryHash: entry.hash, text: entry.text })),
    });
    const output = await executeCachedCatalogWorker({
      job,
      outputSchema: CATALOG_QUERY_EMBEDDING_WORKER_OUTPUT_SCHEMA,
      executor: input.executor,
      force: false,
      context: input.context,
    });
    for (const item of output.items) {
      const receipt = sealCatalogQueryEmbeddingReceipt({
        queryHash: item.queryHash,
        modelImplementationHash: output.modelImplementationHash,
        preprocessingImplementationHash: output.preprocessingImplementationHash,
        workerOutputHash: output.resultHash,
        batchGpuMilliseconds: output.gpuMilliseconds,
        vector: item.vector,
      });
      receipts.set(receipt.queryHash, receipt);
      await writeQualificationArtifact(
        input.context,
        input.split,
        ARTIFACT_DIRECTORIES.queryEmbedding,
        receipt,
      );
    }
  }
  if (receipts.size !== uniqueQueries.size)
    throw new Error("Query embedding worker did not cover every qualification query");
  return receipts;
}

export async function executeValidationRequests(input: {
  readonly requests: readonly CatalogSearchValidationRequest[];
  readonly model: CatalogModelDeclaration;
  readonly metadata: ReadonlyMap<string, AssetSearchMetadataReceipt>;
  readonly measurements: ReadonlyMap<string, CatalogAssetArtifact>;
  readonly renders: ReadonlyMap<
    string,
    ReturnType<typeof CATALOG_VISUAL_REVIEW_INDEX_SCHEMA.parse>["items"][number]
  >;
  readonly prompt: string;
  readonly workerImplementationHash: string;
  readonly executor: Executor;
  readonly split: CatalogQualificationSplit;
  readonly context: CatalogCommandContext;
}): Promise<CatalogValidationReceipt[]> {
  if (input.requests.length === 0) return [];
  const promptTemplateHash = contentHash(input.prompt);
  for (const request of input.requests)
    if (request.promptTemplateHash !== promptTemplateHash)
      throw new Error(`Validation request binds a stale prompt template: ${request.hash}`);
  if (input.requests.length > 8) {
    const shards = Array.from({ length: Math.ceil(input.requests.length / 8) }, (_value, index) =>
      input.requests.slice(index * 8, index * 8 + 8),
    );
    const completed = new Array<CatalogValidationReceipt[]>(shards.length);
    let nextShard = 0;
    await Promise.all(
      Array.from({ length: Math.min(2, shards.length) }, async () => {
        while (nextShard < shards.length) {
          const index = nextShard;
          nextShard += 1;
          completed[index] = await executeValidationRequests({
            ...input,
            requests: shards[index]!,
          });
        }
      }),
    );
    const byRequest = new Map(completed.flat().map((entry) => [entry.requestHash, entry] as const));
    return input.requests.map((entry) => {
      const receipt = byRequest.get(entry.hash);
      if (!receipt) throw new Error(`Validator omitted qualification request ${entry.hash}`);
      return receipt;
    });
  }
  const receipts: CatalogValidationReceipt[] = [];
  for (let start = 0; start < input.requests.length; start += 8) {
    const requests = input.requests.slice(start, start + 8);
    const items = [];
    for (const request of requests) {
      const source = request.candidate.sourceContentHash;
      const measurement = input.measurements.get(source);
      const render = input.renders.get(source);
      const metadata = input.metadata.get(source);
      if (!measurement || !render)
        throw new Error(`Validation evidence is incomplete for ${source}`);
      if ((request.candidate.metadataReceiptHash !== undefined) !== (metadata !== undefined))
        throw new Error(`Validation metadata binding is inconsistent for ${source}`);
      const evidenceByView = new Map(
        render.evidence.views.map((entry) => [entry.viewId, entry] as const),
      );
      const artifactByView = new Map(
        render.viewArtifacts.map((entry) => [entry.viewId, entry] as const),
      );
      const views = await Promise.all(
        metadataViewIds("canonical_twelve").map(async (viewId) => {
          const evidence = evidenceByView.get(viewId);
          const artifact = artifactByView.get(viewId);
          if (!evidence || !artifact) throw new Error(`Render ${source} lacks ${viewId}`);
          return {
            viewId,
            rgbHash: evidence.rgbHash,
            rgbRelativePath: artifact.rgbRelativePath,
            rgbSizeBytes: await fileSize(input.context.root, artifact.rgbRelativePath),
          };
        }),
      );
      items.push({
        request,
        ...(metadata ? { metadataReceipt: metadata } : {}),
        measurement,
        views,
      });
    }
    const sizes = items.flatMap((entry) => entry.views.map((view) => view.rgbSizeBytes));
    const job = sealCliArtifact(CATALOG_VALIDATION_WORKER_JOB_SCHEMA, {
      kind: "CatalogValidationWorkerJob" as const,
      promptTemplate: input.prompt,
      promptTemplateHash,
      outputSchema: CATALOG_VISUAL_VALIDATION_JSON_SCHEMA,
      outputSchemaHash: CATALOG_VISUAL_VALIDATION_JSON_SCHEMA_HASH,
      workerImplementationHash: input.workerImplementationHash,
      model: input.model,
      items,
      inputBudget: {
        assetCount: items.length,
        evidenceFileCount: sizes.length,
        evidenceBytes: sizes.reduce((sum, value) => sum + value, 0),
        preprocessedPixelCeiling:
          sizes.length *
          CATALOG_WORKER_IMAGE_LONG_EDGE_PIXELS *
          CATALOG_WORKER_IMAGE_LONG_EDGE_PIXELS,
      },
    });
    const output = await executeCachedCatalogWorker({
      job,
      outputSchema: CATALOG_VALIDATION_WORKER_OUTPUT_SCHEMA,
      executor: input.executor,
      force: false,
      context: input.context,
    });
    const requestByHash = new Map(requests.map((entry) => [entry.hash, entry] as const));
    for (const item of output.items) {
      const request = requestByHash.get(item.requestHash);
      if (!request) throw new Error("Validator returned an unrequested qualification case");
      const receipt = sealCatalogValidationReceipt({
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
      });
      await writeQualificationArtifact(
        input.context,
        input.split,
        ARTIFACT_DIRECTORIES.validationReceipt,
        receipt,
      );
      if (receipt.status !== "eligible")
        throw new Error(`Validator did not complete qualification request ${request.hash}`);
      receipts.push(receipt);
    }
  }
  const byRequest = new Map(receipts.map((entry) => [entry.requestHash, entry] as const));
  return input.requests.map((entry) => {
    const receipt = byRequest.get(entry.hash);
    if (!receipt) throw new Error(`Validator omitted qualification request ${entry.hash}`);
    return receipt;
  });
}

function createValidationRequest(input: {
  readonly query: CatalogSearchQuery;
  readonly candidate: CatalogSearchResultSet["results"][number];
  readonly metadata: AssetSearchMetadataReceipt | undefined;
  readonly measurement: CatalogAssetArtifact;
  readonly render: ReturnType<typeof CATALOG_VISUAL_REVIEW_INDEX_SCHEMA.parse>["items"][number];
  readonly validationPromptTemplateHash: string;
}): CatalogSearchValidationRequest {
  const evidenceByView = new Map(
    input.render.evidence.views.map((entry) => [entry.viewId, entry] as const),
  );
  return sealCatalogSearchValidationRequest({
    query: input.query,
    candidate: {
      sourceContentHash: input.candidate.sourceContentHash,
      ...(input.metadata ? { metadataReceiptHash: input.metadata.hash } : {}),
      measurementHash: input.measurement.hash,
      renderEvidenceHash: input.render.evidence.hash,
      metricSummary: sealAssetMetricPromptSummary(input.measurement),
      selectedRgbViews: metadataViewIds("canonical_twelve").map((viewId) => ({
        viewId,
        rgbHash: evidenceByView.get(viewId)!.rgbHash,
      })),
    },
    promptTemplateHash: input.validationPromptTemplateHash,
    preprocessingImplementationHash: CATALOG_METADATA_PREPROCESSOR_IMPLEMENTATION_HASH,
  });
}

function qualificationQuery(
  query: CatalogSearchQuery,
  rankingMode: "basename_only" | "hybrid" | "image_text_only" | "metadata_only",
  validationLimit: number,
): CatalogSearchQuery {
  return sealCatalogSearchQuery({
    text: query.text,
    styleTerms: query.styleTerms,
    rankingMode,
    constraints: query.constraints,
    limit: query.limit,
    validationLimit,
  });
}

export async function retainMatrixBytes(
  context: CatalogCommandContext,
  matrix: CatalogEmbeddingMatrix,
  bytes: Uint8Array,
): Promise<void> {
  if (bytes.byteLength !== matrix.blob.sizeBytes)
    throw new Error("Embedding matrix bytes differ from the sealed size descriptor");
  const store = new ImmutableBinaryArtifactStore(absolute(context.root, CATALOG_CAS_ROOT), {
    maxBytes: Math.max(1, bytes.byteLength),
  });
  const reference = await store.write(bytes, matrix.blob.mediaType);
  if (
    reference.artifactHash !== matrix.blob.contentHash ||
    reference.bytes !== matrix.blob.sizeBytes
  )
    throw new Error("Retained embedding bytes differ from the sealed matrix descriptor");
}

async function writeQualificationArtifact(
  context: CatalogCommandContext,
  split: CatalogQualificationSplit,
  directory: (typeof ARTIFACT_DIRECTORIES)[keyof typeof ARTIFACT_DIRECTORIES],
  artifact: { readonly hash: string },
): Promise<void> {
  await context.writeJson(qualificationArtifactPath(split, directory, artifact.hash), artifact);
}

async function readArtifacts<T>(
  context: CatalogCommandContext,
  split: CatalogQualificationSplit,
  directory: (typeof ARTIFACT_DIRECTORIES)[keyof typeof ARTIFACT_DIRECTORIES],
  hashes: readonly string[],
  schema: { parse(value: unknown): T },
): Promise<T[]> {
  return Promise.all(
    hashes.map(async (hash) =>
      schema.parse(await context.readJson(qualificationArtifactPath(split, directory, hash))),
    ),
  );
}

function qualificationArtifactPath(
  split: CatalogQualificationSplit,
  directory: (typeof ARTIFACT_DIRECTORIES)[keyof typeof ARTIFACT_DIRECTORIES],
  hash: string,
): string {
  return `${CATALOG_QUALIFICATION_ROOT}/${split}/artifacts/${directory}/${hash}.json`;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function candidatePool(
  fixture: CatalogQualificationFixture,
  split: CatalogQualificationSplit,
  scenario: Scenario,
) {
  const pool = fixture.candidatePools.find(
    (entry) => entry.split === split && entry.coverageScenario === scenario,
  );
  if (!pool) throw new Error(`Qualification fixture lacks ${split} ${scenario} candidate pool`);
  return pool;
}

function enrichedSources(
  pool: ReturnType<typeof candidatePool>,
  purpose: "image_text" | "metadata",
): string[] {
  return pool.assets
    .filter((entry) => {
      if (purpose === "metadata")
        return ["basename_and_metadata", "fully_enriched"].includes(entry.enrichmentProfile);
      return ["basename_and_image_text", "fully_enriched"].includes(entry.enrichmentProfile);
    })
    .map((entry) => entry.sourceContentHash);
}

function writerIdentity(writer: Writer): string {
  return `${writer.modelId}-${writer.viewSet}`;
}

function requireWriter(
  fixture: CatalogQualificationFixture,
  modelId: string,
  viewSet: "cardinal_four" | "canonical_twelve",
): Writer {
  const writer = fixture.writerConfigurations.find(
    (entry) => entry.modelId === modelId && entry.viewSet === viewSet,
  );
  if (!writer) throw new Error(`Frozen writer ${modelId}:${viewSet} is not in the fixture`);
  return writer;
}

function requireValidator(fixture: CatalogQualificationFixture, modelId: string): Validator {
  const validator = fixture.validatorConfigurations.find((entry) => entry.modelId === modelId);
  if (!validator) throw new Error(`Frozen validator ${modelId} is not in the fixture`);
  return validator;
}

async function establishHoldoutAttempt(
  context: CatalogCommandContext,
  fixture: CatalogQualificationFixture,
  selection: CatalogQualificationSelection,
  executor: Executor,
): Promise<void> {
  const path = `${CATALOG_QUALIFICATION_ROOT}/holdout/attempt.json`;
  const existing = await context.readOptionalJson(path);
  const material = {
    kind: "CatalogQualificationHoldoutAttempt" as const,
    fixtureHash: fixture.hash,
    frozenSelectionHash: selection.hash,
    executor,
  };
  const attempt = { ...material, hash: contentHash(stableJson(material)) };
  if (existing && stableJson(existing) !== stableJson(attempt))
    throw new Error("Holdout was already exposed under another configuration or executor");
  if (!existing) await context.writeJson(path, attempt);
}
