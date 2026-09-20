import { lstat, readdir, unlink } from "node:fs/promises";
import { z } from "zod";
import {
  CATALOG_CANDIDATE_DECISION_POLICY_SCHEMA,
  CATALOG_AUTHORED_METADATA_BATCH_SCHEMA,
  CATALOG_AUTHORED_METADATA_REVIEW_SCHEMA,
  CATALOG_AUTHORED_METADATA_SET_MANIFEST_SCHEMA,
  CATALOG_METADATA_WORKER_JOB_SCHEMA,
  CATALOG_METADATA_WORKER_OUTPUT_SCHEMA,
  CATALOG_MODEL_DECLARATIONS_SCHEMA,
  CATALOG_MODEL_ROLE_POLICY_SCHEMA,
  CATALOG_QUALIFICATION_FIXTURE_SCHEMA,
  CATALOG_QUALIFICATION_ADJUDICATION_DECISION_SCHEMA,
  CATALOG_QUALIFICATION_DESCRIPTION_DECISION_SCHEMA,
  CATALOG_QUALIFICATION_DESCRIPTION_PROPOSAL_SCHEMA,
  CATALOG_QUALIFICATION_DESCRIPTION_SET_SCHEMA,
  CATALOG_QUALIFICATION_POLICY_SCHEMA,
  CATALOG_QUALIFICATION_REPORT_SCHEMA,
  CATALOG_QUALIFICATION_SELECTION_SCHEMA,
  CATALOG_QUALIFICATION_SPLIT_SCHEMA,
  CATALOG_QUALIFICATION_REVIEW_PACKET_SCHEMA,
  CATALOG_SEARCH_METADATA_JSON_SCHEMA,
  CATALOG_SEARCH_METADATA_JSON_SCHEMA_HASH,
  CATALOG_SEARCH_METADATA_REQUEST_SET_SCHEMA,
  CATALOG_SEARCH_METADATA_SET_SCHEMA,
  CATALOG_SEARCH_POLICY_SCHEMA,
  CATALOG_SEARCH_SMOKE_FIXTURE_SCHEMA,
  CATALOG_SOURCE_NAME_HINT_SET_SCHEMA,
  CATALOG_VISUAL_REVIEW_INDEX_SCHEMA,
  CATALOG_VISUAL_VALIDATION_JSON_SCHEMA_HASH,
  CATALOG_WORKER_IMAGE_LONG_EDGE_PIXELS,
  buildCatalogSearchMetadataShards,
  buildCatalogSourceNameHintSet,
  metadataViewIds,
  qualificationAuthorizesCorpus,
  requireCreatorReviewedCatalogQualificationDescriptions,
  requireCurrentCatalogAuthoredMetadataEvidence,
  requireCreatorReviewedQualificationFixture,
  sealAssetMetricPromptSummary,
  sealAssetSearchMetadataReceipt,
  sealAssetSearchMetadataRequest,
  sealCatalogAuthoredMetadataBatch,
  sealCatalogAuthoredMetadataSetManifest,
  sealCatalogAuthoredMetadataReview,
  sealCatalogAuthoredSearchMetadataSet,
  sealCatalogSearchMetadata,
  sealCatalogSearchMetadataRequestSet,
  sealCatalogSearchMetadataSet,
  sealCatalogSearchRegistry,
  validateCatalogModelRolePolicy,
  type AssetSearchMetadataRequest,
  type CatalogAuthoredSearchMetadataSet,
  type CatalogMetadataWorkerJob,
} from "@basalt/catalog-authoring";
import {
  CATALOG_MEASUREMENT_SET_SCHEMA,
  SOURCE_PROVENANCE_LEDGER_SCHEMA,
  TRUSTED_SOURCE_MANIFEST_SCHEMA,
  validateSourceAuthority,
} from "@basalt/catalog-model";
import { contentHash, stableJson } from "@basalt/contracts";
import {
  CATALOG_METADATA_ROOT,
  absolute,
  compare,
  executeCachedCatalogWorker,
  fileHash,
  fileSize,
  parseBoolean,
  parseOptions,
  readText,
  sealCliArtifact,
  splitList,
  type CatalogCommandContext,
} from "./catalog-command-support.js";

const PREPROCESSOR_IMPLEMENTATION_HASH = contentHash(
  stableJson({
    kind: "CatalogMetadataImagePreprocessor",
    channel: "rgb",
    interpolation: "lanczos",
    longEdgePixels: 384,
    preserveAspectRatio: true,
  }),
);

export type CatalogMetadataCliContext = CatalogCommandContext;

export async function runCatalogMetadataCommand(
  values: readonly string[],
  context: CatalogCommandContext,
): Promise<void> {
  const [stage, ...tail] = values;
  if (!stage || !["prepare", "generate", "import-descriptions", "ingest", "commit"].includes(stage))
    throw new Error(
      "catalog metadata stage must be prepare, generate, import-descriptions, ingest, or commit",
    );
  const options = parseOptions(tail);
  if (stage === "prepare") return prepareMetadata(options, context);
  if (stage === "generate") return generateMetadata(options, context);
  if (stage === "import-descriptions") return importReviewedDescriptions(options, context);
  if (stage === "ingest") return ingestAuthoredMetadata(options, context);
  return commitMetadata(options, context);
}

async function importReviewedDescriptions(
  options: ReadonlyMap<string, string>,
  context: CatalogCommandContext,
): Promise<void> {
  const producerId = options.get("--producer-id");
  if (!producerId) throw new Error("import-descriptions requires --producer-id");
  const producerAuthority = z
    .enum(["creator", "delegated_ai"])
    .parse(options.get("--producer-authority") ?? "delegated_ai");
  const proposal = CATALOG_QUALIFICATION_DESCRIPTION_PROPOSAL_SCHEMA.parse(
    await context.readJson(
      options.get("--description-proposal") ??
        "registry/qualifications/catalog-description-proposal.json",
    ),
  );
  const decision = CATALOG_QUALIFICATION_DESCRIPTION_DECISION_SCHEMA.parse(
    await context.readJson(
      options.get("--description-decision") ??
        "registry/qualifications/catalog-description-decision.json",
    ),
  );
  const descriptions = CATALOG_QUALIFICATION_DESCRIPTION_SET_SCHEMA.parse(
    await context.readJson(
      options.get("--description-set") ?? "registry/qualifications/catalog-description-set.json",
    ),
  );
  requireCreatorReviewedCatalogQualificationDescriptions({ proposal, decision, descriptions });
  const measurements = CATALOG_MEASUREMENT_SET_SCHEMA.parse(
    await context.readJson(options.get("--measurements") ?? ".basalt/catalog/measurements.json"),
  );
  const renders = CATALOG_VISUAL_REVIEW_INDEX_SCHEMA.parse(
    await context.readJson(options.get("--renders") ?? ".basalt/catalog/review/index.json"),
  );
  const proposalBySource = new Map(
    proposal.assets.map((entry) => [entry.sourceContentHash, entry] as const),
  );
  const entries = descriptions.assets.flatMap((entry) => {
    const description = entry.visibleDescription;
    if (
      entry.evidenceUsability.status !== "usable" ||
      description.status === "unreviewable" ||
      description.text === null
    )
      return [];
    const proposed = proposalBySource.get(entry.sourceContentHash);
    if (!proposed)
      throw new Error(
        `Reviewed description lacks bound proposal evidence: ${entry.sourceContentHash}`,
      );
    const notEstablished = "Not established by the reviewed visible description.";
    const abstained = { status: "abstained" as const, reason: notEstablished };
    return [
      {
        sourceContentHash: entry.sourceContentHash,
        measurementHash: proposed.evidence.metricSummary.measurementHash,
        renderEvidenceHash: proposed.evidence.renderEvidenceHash,
        authoringCertainty:
          description.status === "uncertain"
            ? {
                status: "uncertain" as const,
                reason: description.uncertaintyReason!,
              }
            : { status: "concrete" as const },
        metadata: sealCatalogSearchMetadata({
          caption: { status: "observed", value: description.text },
          primaryNoun: abstained,
          alternateNouns: abstained,
          materials: abstained,
          colors: abstained,
          visibleText: abstained,
          useCases: abstained,
          environments: abstained,
          styleTerms: abstained,
          visualComposition: abstained,
          sourceRoleHint: abstained,
          completeness: abstained,
          visibleDamage: abstained,
          issueNotes:
            description.status === "uncertain"
              ? { status: "observed", value: ["visible identity uncertain"] }
              : { status: "observed", value: [] },
        }),
      },
    ];
  });
  const producer = { authority: producerAuthority, actorId: producerId } as const;
  const batch = sealCatalogAuthoredMetadataBatch({
    batchId: options.get("--batch-id") ?? "reviewed-description-pilot",
    sourceManifestHash: proposal.sourceManifestHash,
    measurementSetHash: proposal.measurementSetHash,
    visualReviewIndexHash: proposal.visualReviewIndexHash,
    producer,
    sourceArtifactHashes: [proposal.hash, decision.hash, descriptions.hash],
    entries,
  });
  requireCurrentCatalogAuthoredMetadataEvidence({ batch, measurements, renders });
  const sameActor =
    producer.authority === decision.reviewer.authority &&
    producer.actorId === decision.reviewer.reviewerId;
  const review = sealCatalogAuthoredMetadataReview({
    batchHash: batch.hash,
    reviewer: {
      authority: decision.reviewer.authority,
      actorId: decision.reviewer.reviewerId,
    },
    reviewCoverage: "complete",
    reviewMethod: "imported_visible_description_review",
    reviewScope: "visible_description_only",
    reviewIndependence: sameActor ? "same_actor" : "independent",
    basisArtifactHash: decision.hash,
    reviewerStatement: decision.reviewerStatement,
    reviewedAt: decision.reviewedAt,
    decisions: entries.map((entry) => ({
      sourceContentHash: entry.sourceContentHash,
      action: "accept" as const,
      note: "Creator accepted the exact visible description and its recorded uncertainty.",
    })),
  });
  const set = sealCatalogAuthoredSearchMetadataSet({ batch, review });
  const batchOutput =
    options.get("--batch-output") ?? `${CATALOG_METADATA_ROOT}/authored-batch.json`;
  const reviewOutput =
    options.get("--review-output") ?? `${CATALOG_METADATA_ROOT}/authored-review.json`;
  const output = options.get("--output") ?? `${CATALOG_METADATA_ROOT}/authored-set.json`;
  await context.writeJson(batchOutput, batch);
  await context.writeJson(reviewOutput, review);
  await context.writeJson(output, set);
  const manifest = await registerAuthoredMetadataSet(output, set, options, context);
  context.print({
    status: set.status,
    records: set.records.length,
    producer: set.producer,
    reviewCoverage: set.reviewCoverage,
    batchOutput: absolute(context.root, batchOutput),
    reviewOutput: absolute(context.root, reviewOutput),
    output: absolute(context.root, output),
    manifestHash: manifest.hash,
    hash: set.hash,
    qualificationExecutionAuthorized: false,
  });
}

async function ingestAuthoredMetadata(
  options: ReadonlyMap<string, string>,
  context: CatalogCommandContext,
): Promise<void> {
  const batchPath = options.get("--batch");
  if (!batchPath) throw new Error("catalog metadata ingest requires --batch");
  const batch = CATALOG_AUTHORED_METADATA_BATCH_SCHEMA.parse(await context.readJson(batchPath));
  const reviewPath = options.get("--review");
  const review = reviewPath
    ? CATALOG_AUTHORED_METADATA_REVIEW_SCHEMA.parse(await context.readJson(reviewPath))
    : undefined;
  const measurements = CATALOG_MEASUREMENT_SET_SCHEMA.parse(
    await context.readJson(options.get("--measurements") ?? ".basalt/catalog/measurements.json"),
  );
  const renders = CATALOG_VISUAL_REVIEW_INDEX_SCHEMA.parse(
    await context.readJson(options.get("--renders") ?? ".basalt/catalog/review/index.json"),
  );
  requireCurrentCatalogAuthoredMetadataEvidence({ batch, measurements, renders });
  const set = sealCatalogAuthoredSearchMetadataSet({ batch, ...(review ? { review } : {}) });
  const output = options.get("--output") ?? `${CATALOG_METADATA_ROOT}/authored-set.json`;
  await context.writeJson(output, set);
  const manifest = await registerAuthoredMetadataSet(output, set, options, context);
  context.print({
    status: set.status,
    records: set.records.length,
    rejected: set.rejectedSourceContentHashes.length,
    reviewCoverage: set.reviewCoverage,
    output: absolute(context.root, output),
    manifestHash: manifest.hash,
    hash: set.hash,
    qualificationExecutionAuthorized: false,
  });
}

async function registerAuthoredMetadataSet(
  relativePath: string,
  set: CatalogAuthoredSearchMetadataSet,
  options: ReadonlyMap<string, string>,
  context: CatalogCommandContext,
) {
  const manifestPath = options.get("--manifest") ?? `${CATALOG_METADATA_ROOT}/authored-sets.json`;
  if (relativePath === manifestPath)
    throw new Error("Authored metadata set output cannot replace its set manifest");
  const existingRaw = await context.readOptionalJson(manifestPath);
  const existing = existingRaw
    ? CATALOG_AUTHORED_METADATA_SET_MANIFEST_SCHEMA.parse(existingRaw)
    : sealCatalogAuthoredMetadataSetManifest({ sets: [] });
  const manifest = sealCatalogAuthoredMetadataSetManifest({
    sets: [
      ...existing.sets.filter((entry) => entry.relativePath !== relativePath),
      { relativePath, setHash: set.hash },
    ],
  });
  await context.writeJson(manifestPath, manifest);
  return manifest;
}

async function prepareMetadata(
  options: ReadonlyMap<string, string>,
  context: CatalogCommandContext,
): Promise<void> {
  const scope = z
    .enum(["corpus", "qualification", "smoke"])
    .parse(options.get("--scope") ?? "smoke");
  const sourceManifest = TRUSTED_SOURCE_MANIFEST_SCHEMA.parse(
    await context.readJson(options.get("--source") ?? "registry/source-manifest.json"),
  );
  const provenance = SOURCE_PROVENANCE_LEDGER_SCHEMA.parse(
    await context.readJson(options.get("--provenance") ?? "registry/source-provenance.json"),
  );
  if (validateSourceAuthority({ manifest: sourceManifest, provenance }).status !== "eligible")
    throw new Error("Metadata preparation requires eligible source authority");
  const sourceManifestHash = contentHash(stableJson(sourceManifest));
  const measurements = CATALOG_MEASUREMENT_SET_SCHEMA.parse(
    await context.readJson(options.get("--measurements") ?? ".basalt/catalog/measurements.json"),
  );
  const renders = CATALOG_VISUAL_REVIEW_INDEX_SCHEMA.parse(
    await context.readJson(options.get("--renders") ?? ".basalt/catalog/review/index.json"),
  );
  if (
    measurements.sourceManifestHash !== sourceManifestHash ||
    renders.sourceManifestHash !== sourceManifestHash
  )
    throw new Error("Metadata evidence binds a different source manifest");
  if (scope === "corpus") await requireEligibleQualification(options, context);

  const sourceNames = buildCatalogSourceNameHintSet({ sourceManifest, provenance });
  if (sourceNames.status !== "eligible")
    throw new Error("Metadata preparation requires complete basename evidence");
  await context.writeJson(`${CATALOG_METADATA_ROOT}/source-name-hints.json`, sourceNames);

  const selectedSources = await metadataScopeSources(
    scope,
    options,
    context,
    sourceManifest.assets.map((entry) => entry.contentHash),
  );
  const requestedViewSets = splitList(options.get("--view-set"));
  const viewSets = (requestedViewSets.length > 0 ? requestedViewSets : ["canonical_twelve"]).map(
    (entry) => z.enum(["canonical_twelve", "cardinal_four"]).parse(entry),
  );
  const requestedModes = splitList(options.get("--evidence-mode"));
  const evidenceModes = (requestedModes.length > 0 ? requestedModes : ["visual_and_name"]).map(
    (entry) => z.enum(["visual_and_name", "visual_only"]).parse(entry),
  );
  const prompt = await readText(
    context.root,
    options.get("--prompt") ?? "registry/prompts/catalog-search-metadata.txt",
  );
  const promptTemplateHash = contentHash(prompt);
  const assets = new Map(
    measurements.assets.map((entry) => [entry.source.contentHash, entry] as const),
  );
  const rendered = new Map(renders.items.map((entry) => [entry.sourceContentHash, entry] as const));
  const hints = new Map(
    sourceNames.items.map((entry) => [entry.sourceContentHash, entry] as const),
  );
  const diagnostics: string[] = [];
  const requests: AssetSearchMetadataRequest[] = [];
  for (const sourceContentHash of selectedSources) {
    const asset = assets.get(sourceContentHash);
    const render = rendered.get(sourceContentHash);
    const hint = hints.get(sourceContentHash);
    if (!asset || !render || !hint) {
      diagnostics.push(
        `Source ${sourceContentHash} lacks measurement, render, or basename evidence`,
      );
      continue;
    }
    const viewsById = new Map(render.evidence.views.map((entry) => [entry.viewId, entry] as const));
    for (const viewSet of viewSets)
      for (const evidenceMode of evidenceModes) {
        const selectedRgbViews = metadataViewIds(viewSet).map((viewId) => {
          const view = viewsById.get(viewId);
          if (!view) throw new Error(`Render ${sourceContentHash} lacks ${viewId}`);
          return { viewId, rgbHash: view.rgbHash };
        });
        requests.push(
          sealAssetSearchMetadataRequest({
            sourceContentHash,
            measurementHash: asset.hash,
            renderEvidenceHash: render.evidence.hash,
            ...(evidenceMode === "visual_and_name" ? { sourceNameHintHash: hint.hash } : {}),
            evidenceMode,
            metricSummary: sealAssetMetricPromptSummary(asset),
            viewSet,
            promptTemplateHash,
            preprocessingImplementationHash: PREPROCESSOR_IMPLEMENTATION_HASH,
            selectedRgbViews,
          }),
        );
      }
  }
  const requestSet = sealCatalogSearchMetadataRequestSet({
    scope,
    sourceManifestHash,
    measurementSetHash: measurements.hash,
    visualReviewIndexHash: renders.hash,
    sourceNameHintSetHash: sourceNames.hash,
    promptTemplateHash,
    preprocessingImplementationHash: PREPROCESSOR_IMPLEMENTATION_HASH,
    requests,
    diagnostics,
  });
  const output = options.get("--output") ?? `${CATALOG_METADATA_ROOT}/requests.json`;
  await context.writeJson(output, requestSet);
  context.print({
    status: requestSet.status,
    scope,
    sources: selectedSources.length,
    requests: requestSet.requests.length,
    output: absolute(context.root, output),
    hash: requestSet.hash,
  });
}

async function generateMetadata(
  options: ReadonlyMap<string, string>,
  context: CatalogCommandContext,
): Promise<void> {
  const requests = CATALOG_SEARCH_METADATA_REQUEST_SET_SCHEMA.parse(
    await context.readJson(options.get("--requests") ?? `${CATALOG_METADATA_ROOT}/requests.json`),
  );
  if (requests.status !== "eligible")
    throw new Error("Cannot execute an incomplete metadata request set");
  const authorization =
    requests.scope === "corpus" ? await requireEligibleQualification(options, context) : undefined;
  const declarations = CATALOG_MODEL_DECLARATIONS_SCHEMA.parse(
    await context.readJson(options.get("--models") ?? "registry/catalog-models.json"),
  );
  const rolePolicy = CATALOG_MODEL_ROLE_POLICY_SCHEMA.parse(
    await context.readJson(
      options.get("--model-policy") ??
        (requests.scope === "corpus"
          ? ".basalt/catalog/qualification/model-policy.json"
          : "registry/catalog-model-policy.json"),
    ),
  );
  validateCatalogModelRolePolicy(rolePolicy, declarations);
  const modelId = options.get("--model") ?? rolePolicy.metadataWriter.modelId;
  const model = declarations.models.find((entry) => entry.modelId === modelId);
  if (!model?.capabilities.includes("metadata_writer"))
    throw new Error(`Model ${modelId} is not a declared metadata writer`);
  const viewSet = options.get("--view-set") ?? rolePolicy.metadataWriter.viewSet;
  if (
    authorization &&
    (rolePolicy.qualificationReportHash !== authorization.report.hash ||
      modelId !== authorization.selection.selectedWriterModelId ||
      model.sourceCommitHash !== authorization.selection.selectedWriterModelCommitHash ||
      viewSet !== authorization.selection.selectedWriterViewSet ||
      requests.sourceManifestHash !== authorization.fixture.sourceManifestHash ||
      requests.measurementSetHash !== authorization.fixture.measurementSetHash ||
      requests.visualReviewIndexHash !== authorization.fixture.visualReviewIndexHash)
  )
    throw new Error("Corpus metadata generation differs from the frozen qualification selection");
  const evidenceMode = options.get("--evidence-mode") ?? "visual_and_name";
  const selected = requests.requests.filter(
    (entry) => entry.viewSet === viewSet && entry.evidenceMode === evidenceMode,
  );
  if (selected.length === 0)
    throw new Error("No prepared metadata requests match the selected model mode");
  const prompt = await readText(
    context.root,
    options.get("--prompt") ?? "registry/prompts/catalog-search-metadata.txt",
  );
  if (contentHash(prompt) !== requests.promptTemplateHash)
    throw new Error("Metadata prompt differs from the prepared request set");
  const workerImplementationHash = await fileHash(
    context.root,
    "workers/catalog-metadata/worker.py",
  );
  const sourceNames = CATALOG_SOURCE_NAME_HINT_SET_SCHEMA.parse(
    await context.readJson(`${CATALOG_METADATA_ROOT}/source-name-hints.json`),
  );
  if (sourceNames.hash !== requests.sourceNameHintSetHash)
    throw new Error("Metadata basename evidence differs from the request set");
  const renders = CATALOG_VISUAL_REVIEW_INDEX_SCHEMA.parse(
    await context.readJson(options.get("--renders") ?? ".basalt/catalog/review/index.json"),
  );
  const hints = new Map(
    sourceNames.items.map((entry) => [entry.sourceContentHash, entry] as const),
  );
  const renderBySource = new Map(
    renders.items.map((entry) => [entry.sourceContentHash, entry] as const),
  );
  const workerItems: MetadataWorkerItem[] = [];
  for (const request of selected) {
    const render = renderBySource.get(request.sourceContentHash);
    if (!render || render.evidence.hash !== request.renderEvidenceHash)
      throw new Error(`Metadata render evidence is stale for ${request.sourceContentHash}`);
    const artifacts = new Map(render.viewArtifacts.map((entry) => [entry.viewId, entry] as const));
    const sourceNameHint = hints.get(request.sourceContentHash);
    if (request.evidenceMode === "visual_and_name" && !sourceNameHint)
      throw new Error(`Missing exact basename hint for ${request.sourceContentHash}`);
    workerItems.push({
      request,
      ...(sourceNameHint && request.evidenceMode === "visual_and_name" ? { sourceNameHint } : {}),
      views: await Promise.all(
        request.selectedRgbViews.map(async (selectedView) => {
          const artifact = artifacts.get(selectedView.viewId);
          if (!artifact) throw new Error(`Missing RGB path ${selectedView.viewId}`);
          return {
            ...selectedView,
            rgbRelativePath: artifact.rgbRelativePath,
            rgbSizeBytes: await fileSize(context.root, artifact.rgbRelativePath),
          };
        }),
      ),
    });
  }
  const executor = z.enum(["local", "modal"]).parse(options.get("--executor") ?? "local");
  const force = parseBoolean(options.get("--force") ?? "false");
  const outputs = [];
  // Each content-addressed asset is an independent durable checkpoint. Corpus size only
  // creates more checkpoints; it never changes the worker contract or truncates the set.
  for (const items of workerItems.map((item) => [item])) {
    const material = {
      kind: "CatalogMetadataWorkerJob" as const,
      requestSetHash: requests.hash,
      promptTemplate: prompt,
      promptTemplateHash: requests.promptTemplateHash,
      outputSchema: CATALOG_SEARCH_METADATA_JSON_SCHEMA,
      outputSchemaHash: CATALOG_SEARCH_METADATA_JSON_SCHEMA_HASH,
      workerImplementationHash,
      model,
      items,
      inputBudget: metadataBudget(items),
    };
    const job = sealCliArtifact(
      CATALOG_METADATA_WORKER_JOB_SCHEMA,
      material,
    ) as CatalogMetadataWorkerJob;
    outputs.push(
      await executeCachedCatalogWorker({
        job,
        outputSchema: CATALOG_METADATA_WORKER_OUTPUT_SCHEMA,
        executor,
        force,
        context,
      }),
    );
  }
  const requestByHash = new Map(selected.map((entry) => [entry.hash, entry] as const));
  const receipts = outputs.flatMap((output) =>
    output.items.map((item) => {
      const request = requestByHash.get(item.requestHash);
      if (!request) throw new Error(`Metadata worker returned unrequested ${item.requestHash}`);
      return sealAssetSearchMetadataReceipt({
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
        ...(item.metadata ? { metadata: item.metadata } : {}),
        diagnostics: item.diagnostics,
        resourceUsage: item.resourceUsage,
      });
    }),
  );
  await Promise.all(
    receipts.map((receipt) =>
      context.writeJson(`${CATALOG_METADATA_ROOT}/receipts/${receipt.hash}.json`, receipt),
    ),
  );
  const set = sealCatalogSearchMetadataSet({
    requestSetHash: requests.hash,
    requestedHashes: selected.map((entry) => entry.hash),
    receipts,
  });
  const output = options.get("--output") ?? `${CATALOG_METADATA_ROOT}/set.json`;
  await context.writeJson(output, set);
  context.print({
    status: set.status,
    modelId,
    viewSet,
    evidenceMode,
    receipts: set.receipts.length,
    missing: set.missingRequestHashes.length,
    output: absolute(context.root, output),
    hash: set.hash,
  });
}

async function commitMetadata(
  options: ReadonlyMap<string, string>,
  context: CatalogCommandContext,
): Promise<void> {
  const requestSet = CATALOG_SEARCH_METADATA_REQUEST_SET_SCHEMA.parse(
    await context.readJson(options.get("--requests") ?? `${CATALOG_METADATA_ROOT}/requests.json`),
  );
  if (requestSet.scope !== "corpus")
    throw new Error("Only a complete corpus metadata run can be committed");
  const metadata = CATALOG_SEARCH_METADATA_SET_SCHEMA.parse(
    await context.readJson(options.get("--metadata") ?? `${CATALOG_METADATA_ROOT}/set.json`),
  );
  const authorization = await requireEligibleQualification(options, context);
  const report = authorization.report;
  if (metadata.status !== "eligible")
    throw new Error(
      "Metadata commit requires eligible production qualification and complete corpus evidence",
    );
  const rolePolicy = CATALOG_MODEL_ROLE_POLICY_SCHEMA.parse(
    await context.readJson(
      options.get("--model-policy") ?? ".basalt/catalog/qualification/model-policy.json",
    ),
  );
  if (
    rolePolicy.qualificationReportHash !== report.hash ||
    rolePolicy.metadataWriter.modelId !== authorization.selection.selectedWriterModelId ||
    rolePolicy.metadataWriter.viewSet !== authorization.selection.selectedWriterViewSet
  )
    throw new Error("Selected model-role policy does not bind the qualification report");
  const requestByHash = new Map(requestSet.requests.map((entry) => [entry.hash, entry] as const));
  const selectedReceipts = metadata.receipts.filter((receipt) => {
    const request = requestByHash.get(receipt.requestHash);
    return (
      request?.viewSet === report.selectedWriterViewSet &&
      request.evidenceMode === "visual_and_name" &&
      receipt.modelId === report.selectedWriterModelId &&
      receipt.modelCommitHash === report.selectedWriterModelCommitHash
    );
  });
  const selectedSet = sealCatalogSearchMetadataSet({
    requestSetHash: requestSet.hash,
    requestedHashes: selectedReceipts.map((entry) => entry.requestHash),
    receipts: selectedReceipts,
  });
  if (selectedSet.status !== "eligible" || selectedSet.receipts.length === 0)
    throw new Error("Corpus metadata lacks complete evidence for the selected writer");
  const first = selectedSet.receipts[0]!;
  const shards = buildCatalogSearchMetadataShards({
    metadata: selectedSet,
    modelId: first.modelId,
    modelCommitHash: first.modelCommitHash,
  });
  const descriptors = [];
  for (const shard of shards) {
    const relativePath = `registry/evidence/catalog-search-metadata/${shard.prefix}.json`;
    await context.writeJson(relativePath, shard);
    descriptors.push({
      prefix: shard.prefix,
      relativePath,
      artifactHash: shard.hash,
      bytesHash: await fileHash(context.root, relativePath),
      bytes: await fileSize(context.root, relativePath),
      recordCount: shard.records.length,
    });
  }
  await pruneMetadataShards(context.root, new Set(descriptors.map((entry) => entry.relativePath)));
  const registry = sealCatalogSearchRegistry({
    sourceManifestHash: requestSet.sourceManifestHash,
    metadata: selectedSet,
    qualification: report,
    modelRolePolicyHash: rolePolicy.hash,
    promptTemplateHash: requestSet.promptTemplateHash,
    metadataSchemaHash: CATALOG_SEARCH_METADATA_JSON_SCHEMA_HASH,
    writerModelId: first.modelId,
    writerModelCommitHash: first.modelCommitHash,
    writerViewSet: report.selectedWriterViewSet,
    shards: descriptors,
  });
  const output = options.get("--output") ?? "registry/catalog-search.json";
  await context.writeJson(output, registry);
  context.print({
    status: "eligible",
    output: absolute(context.root, output),
    records: registry.recordCount,
    hash: registry.hash,
  });
}

async function metadataScopeSources(
  scope: "corpus" | "qualification" | "smoke",
  options: ReadonlyMap<string, string>,
  context: CatalogCommandContext,
  corpus: readonly string[],
): Promise<string[]> {
  if (scope === "corpus") return [...corpus].sort(compare);
  if (scope === "smoke") {
    const fixture = CATALOG_SEARCH_SMOKE_FIXTURE_SCHEMA.parse(
      await context.readJson(options.get("--fixture") ?? "registry/catalog-search-smoke.json"),
    );
    return fixture.assets.map((entry) => entry.sourceContentHash);
  }
  if (!options.has("--fixture")) {
    const split = CATALOG_QUALIFICATION_SPLIT_SCHEMA.parse(options.get("--split") ?? "development");
    if (split !== "development")
      throw new Error(
        "Pre-fixture qualification metadata preparation is available only for development authoring",
      );
    const proposal = CATALOG_QUALIFICATION_DESCRIPTION_PROPOSAL_SCHEMA.parse(
      await context.readJson(
        options.get("--description-proposal") ??
          "registry/qualifications/catalog-description-proposal.json",
      ),
    );
    const decision = CATALOG_QUALIFICATION_DESCRIPTION_DECISION_SCHEMA.parse(
      await context.readJson(
        options.get("--description-decision") ??
          "registry/qualifications/catalog-description-decision.json",
      ),
    );
    const descriptions = CATALOG_QUALIFICATION_DESCRIPTION_SET_SCHEMA.parse(
      await context.readJson(
        options.get("--description-set") ?? "registry/qualifications/catalog-description-set.json",
      ),
    );
    requireCreatorReviewedCatalogQualificationDescriptions({
      proposal,
      decision,
      descriptions,
    });
    return descriptions.assets.map((entry) => entry.sourceContentHash);
  }
  const fixture = CATALOG_QUALIFICATION_FIXTURE_SCHEMA.parse(
    await context.readJson(options.get("--fixture")!),
  );
  const split = CATALOG_QUALIFICATION_SPLIT_SCHEMA.parse(options.get("--split") ?? "development");
  return fixture.assets
    .filter((entry) => entry.split === split && entry.population === "cohort")
    .map((entry) => entry.sourceContentHash);
}

async function requireEligibleQualification(
  options: ReadonlyMap<string, string>,
  context: CatalogCommandContext,
): Promise<{
  readonly report: z.output<typeof CATALOG_QUALIFICATION_REPORT_SCHEMA>;
  readonly selection: z.output<typeof CATALOG_QUALIFICATION_SELECTION_SCHEMA>;
  readonly fixture: z.output<typeof CATALOG_QUALIFICATION_FIXTURE_SCHEMA>;
}> {
  const report = CATALOG_QUALIFICATION_REPORT_SCHEMA.parse(
    await context.readJson(
      options.get("--qualification") ?? ".basalt/catalog/qualification/report.json",
    ),
  );
  const selection = CATALOG_QUALIFICATION_SELECTION_SCHEMA.parse(
    await context.readJson(
      options.get("--selection") ?? ".basalt/catalog/qualification/selection.json",
    ),
  );
  const fixture = CATALOG_QUALIFICATION_FIXTURE_SCHEMA.parse(
    await context.readJson(options.get("--fixture") ?? "registry/catalog-qualification.json"),
  );
  const proposalFixture = CATALOG_QUALIFICATION_FIXTURE_SCHEMA.parse(
    await context.readJson(
      options.get("--proposal-fixture") ??
        "registry/qualifications/catalog-qualification-proposal.json",
    ),
  );
  const reviewPacket = CATALOG_QUALIFICATION_REVIEW_PACKET_SCHEMA.parse(
    await context.readJson(
      options.get("--review-packet") ??
        "registry/qualifications/catalog-adjudication-review-packet.json",
    ),
  );
  const adjudicationDecision = CATALOG_QUALIFICATION_ADJUDICATION_DECISION_SCHEMA.parse(
    await context.readJson(
      options.get("--adjudication-decision") ??
        "registry/qualifications/catalog-adjudication-decision.json",
    ),
  );
  requireCreatorReviewedQualificationFixture({
    fixture,
    proposal: proposalFixture,
    reviewPacket,
    decision: adjudicationDecision,
  });
  if (
    !qualificationAuthorizesCorpus(
      report,
      selection,
      fixture,
      proposalFixture,
      reviewPacket,
      adjudicationDecision,
    )
  )
    throw new Error(
      "Full-corpus metadata remains blocked until production qualification is eligible",
    );
  if (report.fixtureHash !== fixture.hash)
    throw new Error("Qualification report binds another production fixture");
  const qualificationPolicy = CATALOG_QUALIFICATION_POLICY_SCHEMA.parse(
    await context.readJson(
      options.get("--qualification-policy") ?? "registry/qualification-policy.json",
    ),
  );
  const searchPolicy = CATALOG_SEARCH_POLICY_SCHEMA.parse(
    await context.readJson(options.get("--search-policy") ?? "registry/search-policy.json"),
  );
  const decisionPolicy = CATALOG_CANDIDATE_DECISION_POLICY_SCHEMA.parse(
    await context.readJson(
      options.get("--decision-policy") ?? "registry/candidate-decision-policy.json",
    ),
  );
  const declarations = CATALOG_MODEL_DECLARATIONS_SCHEMA.parse(
    await context.readJson(options.get("--models") ?? "registry/catalog-models.json"),
  );
  const initialRolePolicy = CATALOG_MODEL_ROLE_POLICY_SCHEMA.parse(
    await context.readJson(
      options.get("--qualification-model-policy") ?? "registry/catalog-model-policy.json",
    ),
  );
  const metadataPrompt = await readText(
    context.root,
    options.get("--prompt") ?? "registry/prompts/catalog-search-metadata.txt",
  );
  const validationPrompt = await readText(
    context.root,
    options.get("--validation-prompt") ?? "registry/prompts/catalog-search-validation.txt",
  );
  const workerImplementationHash = await fileHash(
    context.root,
    "workers/catalog-metadata/worker.py",
  );
  for (const [name, actual, expected] of [
    ["qualification policy", qualificationPolicy.hash, fixture.qualificationPolicyHash],
    ["search policy", searchPolicy.hash, fixture.searchPolicyHash],
    ["candidate-decision policy", decisionPolicy.hash, fixture.candidateDecisionPolicyHash],
    ["model declarations", contentHash(stableJson(declarations)), fixture.modelDeclarationsHash],
    ["model-role policy", initialRolePolicy.hash, fixture.modelRolePolicyHash],
    ["metadata prompt", contentHash(metadataPrompt), fixture.metadataPromptTemplateHash],
    ["validation prompt", contentHash(validationPrompt), fixture.validationPromptTemplateHash],
    ["metadata schema", CATALOG_SEARCH_METADATA_JSON_SCHEMA_HASH, fixture.metadataSchemaHash],
    ["validation schema", CATALOG_VISUAL_VALIDATION_JSON_SCHEMA_HASH, fixture.validationSchemaHash],
    ["worker implementation", workerImplementationHash, selection.workerImplementationHash],
  ] as const)
    if (actual !== expected) throw new Error(`Corpus metadata authorization has stale ${name}`);
  return { report, selection, fixture };
}

type MetadataWorkerItem = z.output<typeof CATALOG_METADATA_WORKER_JOB_SCHEMA>["items"][number];

function metadataBudget(items: readonly MetadataWorkerItem[]) {
  const sizes = items.flatMap((entry) => entry.views.map((view) => view.rgbSizeBytes));
  return {
    assetCount: items.length,
    evidenceFileCount: sizes.length,
    evidenceBytes: sizes.reduce((sum, entry) => sum + entry, 0),
    preprocessedPixelCeiling:
      sizes.length * CATALOG_WORKER_IMAGE_LONG_EDGE_PIXELS * CATALOG_WORKER_IMAGE_LONG_EDGE_PIXELS,
  };
}

async function pruneMetadataShards(root: string, retained: ReadonlySet<string>): Promise<void> {
  const directory = "registry/evidence/catalog-search-metadata";
  const names = await readdir(absolute(root, directory)).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  for (const name of names) {
    if (!/^[a-f0-9]{2}\.json$/u.test(name)) continue;
    const path = `${directory}/${name}`;
    if (retained.has(path)) continue;
    const information = await lstat(absolute(root, path));
    if (!information.isFile() || information.isSymbolicLink())
      throw new Error(`Refusing to delete unsafe metadata shard ${path}`);
    await unlink(absolute(root, path));
  }
}

export { PREPROCESSOR_IMPLEMENTATION_HASH as CATALOG_METADATA_PREPROCESSOR_IMPLEMENTATION_HASH };
