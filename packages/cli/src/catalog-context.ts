import { z } from "zod";
import {
  ASSET_CONTEXT_HYPOTHESIS_JSON_SCHEMA,
  ASSET_CONTEXT_HYPOTHESIS_JSON_SCHEMA_HASH,
  ATTRIBUTED_ASSEMBLY_CONTEXT_EVIDENCE_SCHEMA,
  CATALOG_CONTEXT_RECEIPT_SET_SCHEMA,
  CATALOG_CONTEXT_REQUEST_SET_SCHEMA,
  CATALOG_CONTEXT_WORKER_JOB_SCHEMA,
  CATALOG_CONTEXT_WORKER_OUTPUT_SCHEMA,
  CATALOG_MODEL_DECLARATIONS_SCHEMA,
  CATALOG_MODEL_ROLE_POLICY_SCHEMA,
  CATALOG_SEARCH_METADATA_SET_SCHEMA,
  CATALOG_SOURCE_NAME_HINT_SET_SCHEMA,
  CATALOG_VISUAL_REVIEW_INDEX_SCHEMA,
  assessConstructionEligibility,
  createAssetContextCandidate,
  contextReceiptMatchesRequest,
  proposeAssetContextGroups,
  sealAssetContextHypothesisReceipt,
  sealAssetContextHypothesisRequest,
  sealCatalogContextReceiptSet,
  sealCatalogContextRequestSet,
  sealConstructionEligibilitySet,
  type CatalogContextWorkerJob,
} from "@basalt/catalog-authoring";
import { CATALOG_MEASUREMENT_SET_SCHEMA } from "@basalt/catalog-model";
import { contentHash } from "@basalt/contracts";
import {
  CATALOG_CONTEXT_ROOT,
  CATALOG_METADATA_ROOT,
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

export async function runCatalogContextCommand(
  values: readonly string[],
  context: CatalogCommandContext,
): Promise<void> {
  const [stage, ...tail] = values;
  if (!stage || !["prepare", "generate", "review"].includes(stage))
    throw new Error("catalog context stage must be prepare, generate, or review");
  const options = parseOptions(tail);
  if (stage === "prepare") return prepareContext(options, context);
  if (stage === "generate") return generateContext(options, context);
  return reviewContext(options, context);
}

async function prepareContext(
  options: ReadonlyMap<string, string>,
  context: CatalogCommandContext,
): Promise<void> {
  const measurements = CATALOG_MEASUREMENT_SET_SCHEMA.parse(
    await context.readJson(options.get("--measurements") ?? ".basalt/catalog/measurements.json"),
  );
  const renders = CATALOG_VISUAL_REVIEW_INDEX_SCHEMA.parse(
    await context.readJson(options.get("--renders") ?? ".basalt/catalog/review/index.json"),
  );
  const sourceNames = CATALOG_SOURCE_NAME_HINT_SET_SCHEMA.parse(
    await context.readJson(
      options.get("--source-names") ?? `${CATALOG_METADATA_ROOT}/source-name-hints.json`,
    ),
  );
  const metadataRaw = await context.readOptionalJson(
    options.get("--metadata") ?? `${CATALOG_METADATA_ROOT}/set.json`,
  );
  const metadata = metadataRaw ? CATALOG_SEARCH_METADATA_SET_SCHEMA.parse(metadataRaw) : undefined;
  const attributedRaw = options.get("--assembly-evidence")
    ? await context.readJson(options.get("--assembly-evidence")!)
    : [];
  const attributed = z
    .array(ATTRIBUTED_ASSEMBLY_CONTEXT_EVIDENCE_SCHEMA)
    .max(100_000)
    .parse(attributedRaw);
  const metadataBySource = firstMetadataBySource(metadata?.receipts ?? []);
  const renderBySource = new Map(
    renders.items.map((entry) => [entry.sourceContentHash, entry] as const),
  );
  const candidates = await Promise.all(
    measurements.assets.map(async (asset) => {
      const render = renderBySource.get(asset.source.contentHash);
      if (!render) return undefined;
      const sourceNameHintHash = sourceNames.items.find(
        (entry) => entry.sourceContentHash === asset.source.contentHash,
      )?.hash;
      const metadataReceiptHash = metadataBySource.get(asset.source.contentHash)?.hash;
      return createAssetContextCandidate({
        asset,
        renderEvidenceHash: render.evidence.hash,
        contactSheetContentHash: await fileHash(context.root, render.contactSheetRelativePath),
        selectedRgbViews: render.evidence.views.map((entry) => ({
          viewId: entry.viewId,
          rgbHash: entry.rgbHash,
        })),
        ...(sourceNameHintHash ? { sourceNameHintHash } : {}),
        ...(metadataReceiptHash ? { metadataReceiptHash } : {}),
      });
    }),
  ).then((entries) => entries.filter((entry) => entry !== undefined));
  const explicitSources = splitList(options.get("--sources"));
  const groups =
    explicitSources.length > 0
      ? [
          {
            groupId: contentHash(JSON.stringify([...explicitSources].sort())),
            groupingEvidence: ["basename_stem" as const],
            sourceContentHashes: [...explicitSources].sort(),
          },
        ]
      : proposeAssetContextGroups({ candidates, sourceNames });
  const limit = Math.min(
    groups.length,
    requireInteger(options.get("--limit") ?? String(groups.length), "context group limit"),
  );
  const candidateBySource = new Map(
    candidates.map((entry) => [entry.sourceContentHash, entry] as const),
  );
  const prompt = await readText(
    context.root,
    options.get("--prompt") ?? "registry/prompts/catalog-context.txt",
  );
  const promptTemplateHash = contentHash(prompt);
  const diagnostics: string[] = [];
  const requests = groups.slice(0, limit).flatMap((group) => {
    const selected = group.sourceContentHashes.flatMap((entry) => {
      const candidate = candidateBySource.get(entry);
      if (!candidate) {
        diagnostics.push(`Context group ${group.groupId} lacks evidence for ${entry}`);
        return [];
      }
      return [candidate];
    });
    if (selected.length < 2) return [];
    const candidateSet = new Set(selected.map((entry) => entry.sourceContentHash));
    const groupAssemblyEvidence = attributed.filter((entry) =>
      entry.members.every((member) => candidateSet.has(member.sourceContentHash)),
    );
    const groupingEvidence = [
      ...group.groupingEvidence,
      ...(groupAssemblyEvidence.length > 0 ? (["attributed_assembly"] as const) : []),
    ];
    return [
      sealAssetContextHypothesisRequest({
        groupingEvidence,
        candidates: selected,
        attributedAssemblyEvidence: groupAssemblyEvidence,
        promptTemplateHash,
      }),
    ];
  });
  const requestSet = sealCatalogContextRequestSet({
    measurementSetHash: measurements.hash,
    visualReviewIndexHash: renders.hash,
    sourceNameHintSetHash: sourceNames.hash,
    promptTemplateHash,
    requests,
    diagnostics,
  });
  const output = options.get("--output") ?? `${CATALOG_CONTEXT_ROOT}/requests.json`;
  await context.writeJson(output, requestSet);
  context.print({
    status: requestSet.status,
    groups: requestSet.requests.length,
    output: absolute(context.root, output),
    hash: requestSet.hash,
  });
}

async function generateContext(
  options: ReadonlyMap<string, string>,
  context: CatalogCommandContext,
): Promise<void> {
  const requestSet = CATALOG_CONTEXT_REQUEST_SET_SCHEMA.parse(
    await context.readJson(options.get("--requests") ?? `${CATALOG_CONTEXT_ROOT}/requests.json`),
  );
  if (requestSet.status !== "eligible")
    throw new Error("Cannot execute an incomplete context request set");
  const declarations = CATALOG_MODEL_DECLARATIONS_SCHEMA.parse(
    await context.readJson(options.get("--models") ?? "registry/catalog-models.json"),
  );
  const rolePolicy = CATALOG_MODEL_ROLE_POLICY_SCHEMA.parse(
    await context.readJson(options.get("--model-policy") ?? "registry/catalog-model-policy.json"),
  );
  const modelId = options.get("--model") ?? rolePolicy.metadataWriter.modelId;
  const model = declarations.models.find((entry) => entry.modelId === modelId);
  if (!model?.capabilities.includes("context_interpreter"))
    throw new Error(`Model ${modelId} is not a declared context interpreter`);
  const prompt = await readText(
    context.root,
    options.get("--prompt") ?? "registry/prompts/catalog-context.txt",
  );
  if (contentHash(prompt) !== requestSet.promptTemplateHash)
    throw new Error("Context prompt differs from the prepared request set");
  const workerImplementationHash = await fileHash(
    context.root,
    "workers/catalog-metadata/worker.py",
  );
  const renders = CATALOG_VISUAL_REVIEW_INDEX_SCHEMA.parse(
    await context.readJson(options.get("--renders") ?? ".basalt/catalog/review/index.json"),
  );
  const sourceNames = CATALOG_SOURCE_NAME_HINT_SET_SCHEMA.parse(
    await context.readJson(
      options.get("--source-names") ?? `${CATALOG_METADATA_ROOT}/source-name-hints.json`,
    ),
  );
  const renderBySource = new Map(
    renders.items.map((entry) => [entry.sourceContentHash, entry] as const),
  );
  const hintBySource = new Map(
    sourceNames.items.map((entry) => [entry.sourceContentHash, entry] as const),
  );
  const receipts = [];
  for (const request of requestSet.requests) {
    const candidateEvidence = await Promise.all(
      request.candidates.map(async (candidate) => {
        const render = renderBySource.get(candidate.sourceContentHash);
        if (!render)
          throw new Error(`Missing context contact sheet ${candidate.sourceContentHash}`);
        const sourceNameHint = hintBySource.get(candidate.sourceContentHash);
        return {
          sourceContentHash: candidate.sourceContentHash,
          ...(sourceNameHint ? { sourceNameHint } : {}),
          contactSheetRelativePath: render.contactSheetRelativePath,
          contactSheetContentHash: candidate.contactSheetContentHash,
          contactSheetSizeBytes: await fileSize(context.root, render.contactSheetRelativePath),
        };
      }),
    );
    const job = sealCliArtifact(CATALOG_CONTEXT_WORKER_JOB_SCHEMA, {
      kind: "CatalogContextWorkerJob" as const,
      promptTemplate: prompt,
      promptTemplateHash: requestSet.promptTemplateHash,
      outputSchema: ASSET_CONTEXT_HYPOTHESIS_JSON_SCHEMA,
      outputSchemaHash: ASSET_CONTEXT_HYPOTHESIS_JSON_SCHEMA_HASH,
      workerImplementationHash,
      model,
      request,
      candidateEvidence,
      inputBudget: {
        candidateCount: candidateEvidence.length,
        evidenceFileCount: candidateEvidence.length,
        evidenceBytes: candidateEvidence.reduce(
          (sum, entry) => sum + entry.contactSheetSizeBytes,
          0,
        ),
        preprocessedPixelCeiling: candidateEvidence.length * 384 * 384,
      },
    }) as CatalogContextWorkerJob;
    const output = await executeCachedCatalogWorker({
      job,
      outputSchema: CATALOG_CONTEXT_WORKER_OUTPUT_SCHEMA,
      executor: z.enum(["local", "modal"]).parse(options.get("--executor") ?? "local"),
      force: parseBoolean(options.get("--force") ?? "false"),
      context,
    });
    receipts.push(
      sealAssetContextHypothesisReceipt({
        status: output.status,
        requestHash: request.hash,
        adapterId: "catalog-metadata-worker",
        adapterImplementationHash: output.runtime.adapterImplementationHash,
        workerImplementationHash: output.runtime.workerImplementationHash,
        runtimeImplementationHash: output.runtime.runtimeImplementationHash,
        modelId: output.runtime.modelId,
        modelCommitHash: output.runtime.modelCommitHash,
        promptHash: output.promptHash,
        ...(output.rawOutputHash ? { rawOutputHash: output.rawOutputHash } : {}),
        ...(output.hypothesis ? { hypothesis: output.hypothesis } : {}),
        diagnostics: output.diagnostics,
        resourceUsage: output.resourceUsage,
      }),
    );
  }
  const set = sealCatalogContextReceiptSet({ requestSet, receipts });
  const output = options.get("--output") ?? `${CATALOG_CONTEXT_ROOT}/receipts.json`;
  await context.writeJson(output, set);
  context.print({
    status: set.status,
    receipts: set.receipts.length,
    output: absolute(context.root, output),
    hash: set.hash,
  });
}

async function reviewContext(
  options: ReadonlyMap<string, string>,
  context: CatalogCommandContext,
): Promise<void> {
  const measurements = CATALOG_MEASUREMENT_SET_SCHEMA.parse(
    await context.readJson(options.get("--measurements") ?? ".basalt/catalog/measurements.json"),
  );
  const metadataRaw = await context.readOptionalJson(
    options.get("--metadata") ?? `${CATALOG_METADATA_ROOT}/set.json`,
  );
  const metadata = metadataRaw ? CATALOG_SEARCH_METADATA_SET_SCHEMA.parse(metadataRaw) : undefined;
  const contextSetRaw = await context.readOptionalJson(
    options.get("--context") ?? `${CATALOG_CONTEXT_ROOT}/receipts.json`,
  );
  const contextSet = contextSetRaw
    ? CATALOG_CONTEXT_RECEIPT_SET_SCHEMA.parse(contextSetRaw)
    : undefined;
  if (contextSet) {
    const requestSet = CATALOG_CONTEXT_REQUEST_SET_SCHEMA.parse(
      await context.readJson(options.get("--requests") ?? `${CATALOG_CONTEXT_ROOT}/requests.json`),
    );
    if (contextSet.requestSetHash !== requestSet.hash)
      throw new Error("Context receipts bind a different request set");
    const requestByHash = new Map(requestSet.requests.map((entry) => [entry.hash, entry] as const));
    for (const receipt of contextSet.receipts) {
      const request = requestByHash.get(receipt.requestHash);
      if (
        !request ||
        (receipt.status === "eligible" && !contextReceiptMatchesRequest(request, receipt))
      )
        throw new Error(`Context receipt evidence is invalid for ${receipt.requestHash}`);
    }
  }
  const metadataBySource = firstMetadataBySource(metadata?.receipts ?? []);
  const contextBySource = new Map(
    (contextSet?.receipts ?? []).flatMap((receipt) =>
      (receipt.hypothesis?.assets ?? []).map(
        (asset) => [asset.sourceContentHash, receipt] as const,
      ),
    ),
  );
  const assessments = measurements.assets.map((asset) =>
    assessConstructionEligibility({
      asset,
      ...(metadataBySource.get(asset.source.contentHash)
        ? { metadata: metadataBySource.get(asset.source.contentHash)! }
        : {}),
      ...(contextBySource.get(asset.source.contentHash)
        ? { context: contextBySource.get(asset.source.contentHash)! }
        : {}),
    }),
  );
  const result = sealConstructionEligibilitySet({
    measurementSetHash: measurements.hash,
    ...(metadata ? { metadataSetHash: metadata.hash } : {}),
    ...(contextSet ? { contextReceiptSetHash: contextSet.hash } : {}),
    assessments,
  });
  const output = options.get("--output") ?? `${CATALOG_CONTEXT_ROOT}/review.json`;
  await context.writeJson(output, result);
  context.print({
    status: result.status,
    eligible: result.assessments.filter((entry) => entry.status === "eligible").length,
    incomplete: result.assessments.filter((entry) => entry.status === "incomplete").length,
    rejected: result.assessments.filter((entry) => entry.status === "rejected").length,
    output: absolute(context.root, output),
    hash: result.hash,
  });
}

function firstMetadataBySource<
  T extends { readonly sourceContentHash: string; readonly hash: string },
>(values: readonly T[]): Map<string, T> {
  return new Map(
    [...values]
      .sort((left, right) => (left.hash < right.hash ? -1 : left.hash > right.hash ? 1 : 0))
      .map((entry) => [entry.sourceContentHash, entry] as const),
  );
}
