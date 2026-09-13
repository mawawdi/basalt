import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { lstat, mkdir, readdir, unlink } from "node:fs/promises";
import { availableParallelism, homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { Worker } from "node:worker_threads";
import { z } from "zod";
import {
  acquireWorkspaceExclusiveLock,
  readBoundedWorkspaceBytes,
  readBoundedWorkspaceJson,
  writeCanonicalWorkspaceJson,
} from "@basalt/artifact-store";
import {
  CATALOG_HYPOTHESIS_RECEIPT_SET_SCHEMA,
  CATALOG_HYPOTHESIS_REQUEST_SET_SCHEMA,
  CATALOG_ADMISSION_COHORT_SET_SCHEMA,
  CATALOG_ADMISSION_POLICY_SCHEMA,
  CATALOG_AUTHORITY_COMMIT_SCHEMA,
  CATALOG_COHORT_AUDIT_SCHEMA,
  CATALOG_COHORT_DECISION_SCHEMA,
  CATALOG_HYPOTHESIS_PANEL_SCHEMA,
  CATALOG_REVIEW_PLAN_SCHEMA,
  CATALOG_VISUAL_EMBEDDING_SET_SCHEMA,
  CATALOG_VISUAL_REVIEW_INDEX_SCHEMA,
  applyCatalogAdmissionDecisions,
  buildCatalogAdmissionCohorts,
  buildCatalogHypothesisPanel,
  buildCatalogReviewPlan,
  sealCatalogAuthorityCommit,
  sealCatalogCohortAudit,
  sealCatalogCohortDecision,
  sealCatalogVisualEmbeddingSet,
  sealAssetSemanticHypothesisRequest,
  sealCatalogHypothesisReceiptSet,
  sealCatalogHypothesisRequestSet,
  type CatalogHypothesisReceiptSet,
  type CatalogHypothesisRequestSet,
  type RetainedCatalogEvidence,
} from "@basalt/catalog-authoring";
import {
  CATALOG_ASSET_ARTIFACT_SCHEMA,
  CATALOG_DISPOSITION_SCHEMA,
  CATALOG_ENTRY_DECLARATION_SCHEMA,
  CATALOG_MEASUREMENT_SET_SCHEMA,
  CATALOG_SNAPSHOT_SCHEMA,
  STYLE_PROFILE_DECLARATION_SCHEMA,
  TRUSTED_SOURCE_MANIFEST_SCHEMA,
  sealCatalogMeasurementSet,
  sealCatalogSnapshot,
  sealStyleProfile,
  type CatalogAssetArtifact,
} from "@basalt/catalog-model";
import { contentHash, stableJson } from "@basalt/contracts";
import { NEURAL_PROVIDER_WORKERS, RESTORED_NEURAL_PROVIDERS } from "@basalt/neural-asset";
import {
  AFFORDANCE_DEFINITION_SCHEMA,
  ANNOTATION_PREDICATE_DEFINITION_SCHEMA,
  CONCEPT_COMMITMENT_SCHEMA,
  REALIZATION_FORM_DEFINITION_SCHEMA,
  RELATION_DEFINITION_SCHEMA,
  ROLE_SCHEME_DEFINITION_SCHEMA,
  SEMANTIC_ADMITTED_ASSERTION_BUNDLE_SCHEMA,
  SEMANTIC_CONSTRAINT_SET_SCHEMA,
  SEMANTIC_KERNEL_SCHEMA,
  SEMANTIC_LEXICON_SNAPSHOT_SCHEMA,
  STATE_DIMENSION_DEFINITION_SCHEMA,
  SURFACE_TREATMENT_DEFINITION_SCHEMA,
  sealSemanticModule,
  type SemanticModule,
} from "@basalt/semantic-kernel";
import { compileBasaltWorld, WORLD_BUILD_SCHEMA } from "@basalt/world-compiler";
import { SPATIAL_WORLD_PLAN_SCHEMA } from "@basalt/world-planning";
import {
  RobloxImportBridge,
  ROBLOX_ASSET_BINDING_SCHEMA,
  createRobloxImportManifest,
  installRobloxCredential,
  readRobloxCredential,
} from "@basalt/roblox";
import type { CatalogMeasureTask } from "./catalog-measure-worker.js";

const repositoryRoot = resolve(".");
const args = process.argv.slice(2);
const execFile = promisify(execFileCallback);
const CATALOG_COMMIT_LOCK_PATH = ".basalt/locks/catalog-commit.lock";

async function main(): Promise<void> {
  const [command, subcommand, ...rest] = args;
  if (command === "semantics" && subcommand === "validate") return semanticsValidate();
  if (command === "semantics" && subcommand === "seal") return semanticsSeal(rest);
  if (command === "semantics" && subcommand === "explain") return semanticsExplain(rest);
  if (command === "catalog" && subcommand === "inventory") return catalogInventory(rest);
  if (command === "catalog" && subcommand === "providers") return catalogProviders();
  if (command === "catalog" && subcommand === "measure") return catalogMeasure(rest);
  if (command === "catalog" && subcommand === "render") return catalogRender(rest);
  if (command === "catalog" && subcommand === "hypothesize") return catalogHypothesize(rest);
  if (command === "catalog" && subcommand === "panel") return catalogPanel(rest);
  if (command === "catalog" && subcommand === "cluster") return catalogCluster(rest);
  if (command === "catalog" && subcommand === "review") return catalogReview(rest);
  if (command === "catalog" && subcommand === "decide") return catalogDecide(rest);
  if (command === "catalog" && subcommand === "audit") return catalogAudit(rest);
  if (command === "catalog" && subcommand === "admit") return catalogAdmit(rest);
  if (command === "catalog" && subcommand === "commit") return catalogCommit(rest);
  if (command === "catalog" && subcommand === "validate") return catalogValidate(rest);
  if (command === "catalog" && subcommand === "seal") return catalogSeal(rest);
  if (command === "world" && subcommand === "compile") return worldCompile(rest);
  if (command === "roblox" && subcommand === "install-plugin") return robloxInstallPlugin();
  if (command === "roblox" && subcommand === "import") return robloxImport(rest);
  if (command === undefined || command === "help" || command === "--help") return usage();
  failUsage(`Unknown command: ${[command, subcommand].filter(Boolean).join(" ")}`);
}

function catalogProviders(): void {
  print({
    status: RESTORED_NEURAL_PROVIDERS.every((provider) => provider.status === "eligible")
      ? "eligible"
      : "incomplete",
    admissionAuthority: false,
    providers: RESTORED_NEURAL_PROVIDERS.map((provider) => ({
      providerId: provider.providerId,
      modelId: provider.modelId,
      status: provider.status,
      capabilities: provider.capabilities,
      worker: NEURAL_PROVIDER_WORKERS[provider.providerId],
      diagnostics: provider.diagnostics,
    })),
  });
}

async function semanticsValidate(): Promise<void> {
  const module = await loadSemanticModule();
  const lexicon = SEMANTIC_LEXICON_SNAPSHOT_SCHEMA.parse(
    await readJson("registry/semantics/lexicon.json"),
  );
  print({
    status: "eligible",
    semanticModuleHash: module.snapshot.hash,
    kernelHash: module.kernel.hash,
    conceptCount: module.concepts.length,
    lexiconHash: lexicon.hash,
  });
}

async function semanticsSeal(values: string[]): Promise<void> {
  const options = parseOptions(values);
  const output = options.get("--output") ?? ".basalt/semantics/module.json";
  const module = await loadSemanticModule();
  await writeCanonicalJson(output, module.snapshot);
  print({ status: "eligible", output: absolute(output), hash: module.snapshot.hash });
}

async function semanticsExplain(values: string[]): Promise<void> {
  const conceptId = positional(values, 0, "concept ID");
  const module = await loadSemanticModule();
  const lexicon = SEMANTIC_LEXICON_SNAPSHOT_SCHEMA.parse(
    await readJson("registry/semantics/lexicon.json"),
  );
  const commitment = module.concepts.find((entry) => entry.conceptId === conceptId);
  if (!commitment) throw new Error(`Unknown semantic commitment ${conceptId}`);
  const authoring = lexicon.entries.find(
    (entry) => entry.subjectKind === "concept" && entry.subjectId === conceptId,
  );
  print({ commitment, lexicon: authoring ?? null });
}

async function catalogInventory(values: string[]): Promise<void> {
  const options = parseOptions(values);
  const source = options.get("--source") ?? "registry/source-manifest.json";
  const output = options.get("--output") ?? ".basalt/catalog/inventory.json";
  const manifest = TRUSTED_SOURCE_MANIFEST_SCHEMA.parse(await readJson(source));
  const identities = new Map<string, { bytes: number; pathCount: number; packages: Set<string> }>();
  for (const pack of manifest.packages)
    for (const file of pack.files) {
      const bytes = await readBoundedWorkspaceBytes(
        repositoryRoot,
        file.relativePath,
        512 * 1024 * 1024,
      );
      if (sha256(bytes) !== file.sha256)
        throw new Error(`Source hash changed: ${file.relativePath}`);
      const current = identities.get(file.sha256) ?? {
        bytes: bytes.byteLength,
        pathCount: 0,
        packages: new Set<string>(),
      };
      if (current.bytes !== bytes.byteLength)
        throw new Error(`Duplicate identity has inconsistent byte size: ${file.sha256}`);
      current.pathCount += 1;
      current.packages.add(pack.packageId);
      identities.set(file.sha256, current);
    }
  const records = [...identities]
    .sort(([left], [right]) => compare(left, right))
    .map(([sourceContentHash, value]) => ({
      sourceContentHash,
      bytes: value.bytes,
      pathCount: value.pathCount,
      packageIds: [...value.packages].sort(compare),
    }));
  const material = {
    kind: "CatalogSourceInventory" as const,
    sourceManifestHash: contentHash(stableJson(manifest)),
    identities: records,
  };
  const inventory = { ...material, hash: contentHash(stableJson(material)) };
  await writeCanonicalJson(output, inventory);
  print({
    status: "eligible",
    output: absolute(output),
    identities: records.length,
    paths: records.reduce((sum, entry) => sum + entry.pathCount, 0),
    hash: inventory.hash,
  });
}

async function catalogMeasure(values: string[]): Promise<void> {
  const options = parseOptions(values);
  const source = options.get("--source") ?? "registry/source-manifest.json";
  const output = options.get("--output") ?? ".basalt/catalog/measurements.json";
  const manifest = TRUSTED_SOURCE_MANIFEST_SCHEMA.parse(await readJson(source));
  const assets = new Map<string, CatalogAssetArtifact>();
  const diagnostics: Array<{ sourceContentHash: string; reason: string }> = [];
  const candidates = new Map<string, Omit<CatalogMeasureTask, "taskId">>();
  for (const pack of manifest.packages)
    for (const file of pack.files) {
      const task = {
        workspaceRoot: repositoryRoot,
        relativePath: file.relativePath,
        source: {
          contentHash: file.sha256,
          packageId: pack.packageId,
          licenseId: pack.licenseId,
          commercialUsePermitted: pack.commercialUsePermitted,
          redistributionPermitted: pack.redistributionPermitted,
          attribution: pack.attribution,
          metersPerSourceUnit: file.metersPerSourceUnit,
        },
      };
      const existing = candidates.get(file.sha256);
      if (!existing || compare(task.relativePath, existing.relativePath) < 0)
        candidates.set(file.sha256, task);
    }
  const tasks = [...candidates.values()]
    .sort((left, right) => compare(left.source.contentHash, right.source.contentHash))
    .map((entry, taskId) => ({ ...entry, taskId }));
  const requestedWorkers = Number(options.get("--workers") ?? Math.min(8, availableParallelism()));
  if (!Number.isSafeInteger(requestedWorkers) || requestedWorkers < 1 || requestedWorkers > 32)
    throw new Error("--workers must be an integer from 1 through 32");
  for (const outcome of await measureCatalogTasks(
    tasks,
    Math.min(requestedWorkers, tasks.length),
  )) {
    if (outcome.asset) assets.set(outcome.asset.source.contentHash, outcome.asset);
    else diagnostics.push({ sourceContentHash: outcome.sourceContentHash, reason: outcome.error! });
  }
  const measurements = sealCatalogMeasurementSet({
    sourceManifestHash: contentHash(stableJson(manifest)),
    assets: [...assets.values()],
    diagnostics,
  });
  await writeCanonicalJson(output, measurements);
  print({
    status: diagnostics.length === 0 ? "eligible" : "incomplete",
    measured: assets.size,
    refused: diagnostics.length,
    output: absolute(output),
    hash: measurements.hash,
  });
}

async function catalogRender(values: string[]): Promise<void> {
  const options = parseOptions(values);
  const workers = options.get("--workers");
  if (
    workers !== undefined &&
    (!Number.isSafeInteger(Number(workers)) || Number(workers) < 1 || Number(workers) > 8)
  )
    throw new Error("--workers must be an integer from 1 through 8");
  const { stdout, stderr } = await execFile(
    process.execPath,
    [resolve(repositoryRoot, "scripts/render-catalog-review.mjs")],
    {
      cwd: repositoryRoot,
      env: { ...process.env, ...(workers ? { BASALT_REVIEW_WORKERS: workers } : {}) },
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  if (stderr) process.stderr.write(stderr);
  process.stdout.write(stdout);
}

async function catalogHypothesize(values: string[]): Promise<void> {
  const options = parseOptions(values);
  const output = options.get("--output") ?? ".basalt/catalog/hypothesis-requests.json";
  const measured = CATALOG_MEASUREMENT_SET_SCHEMA.parse(
    await readJson(options.get("--measurements") ?? ".basalt/catalog/measurements.json"),
  );
  const visual = CATALOG_VISUAL_REVIEW_INDEX_SCHEMA.parse(
    await readJson(options.get("--renders") ?? ".basalt/catalog/review/index.json"),
  );
  const semanticModule = await loadSemanticModule();
  const lexicon = SEMANTIC_LEXICON_SNAPSHOT_SCHEMA.parse(
    await readJson("registry/semantics/lexicon.json"),
  );
  const renders = new Map(visual.items.map((item) => [item.sourceContentHash, item]));
  const requestedConceptIds = semanticModule.concepts
    .map((concept) => concept.conceptId)
    .sort(compare);
  const requests = measured.assets.flatMap((asset) => {
    const render = renders.get(asset.source.contentHash);
    return render
      ? [
          sealAssetSemanticHypothesisRequest({
            sourceContentHash: asset.source.contentHash,
            measurementHash: asset.hash,
            renderEvidenceHash: render.evidence.hash,
            semanticModuleHash: semanticModule.snapshot.hash,
            semanticLexiconHash: lexicon.hash,
            requestedConceptIds,
          }),
        ]
      : [];
  });
  const missingRenders = measured.assets.length - requests.length;
  const requestSet = sealCatalogHypothesisRequestSet({
    status: "incomplete",
    measurementSetHash: measured.hash,
    visualReviewIndexHash: visual.hash,
    semanticModuleHash: semanticModule.snapshot.hash,
    semanticLexiconHash: lexicon.hash,
    requests,
    diagnostics: [
      "Hypothesis requests have no compiler authority and await an external vision adapter",
      ...(missingRenders > 0
        ? [`${missingRenders} measured assets lack exact render evidence`]
        : []),
    ],
  });
  await writeCanonicalJson(output, requestSet);
  print({
    status: requestSet.status,
    output: absolute(output),
    requests: requests.length,
    hash: requestSet.hash,
  });
}

async function catalogPanel(values: string[]): Promise<void> {
  const options = parseOptions(values);
  const output = options.get("--output") ?? ".basalt/catalog/hypothesis-panel.json";
  const policy = await loadAdmissionPolicy(options.get("--policy"));
  const requests = CATALOG_HYPOTHESIS_REQUEST_SET_SCHEMA.parse(
    await readJson(options.get("--requests") ?? ".basalt/catalog/hypothesis-requests.json"),
  );
  const receipts = await loadOrCreateReceiptSet(
    options.get("--receipts") ?? ".basalt/catalog/hypothesis-receipts.json",
    requests,
  );
  const panel = buildCatalogHypothesisPanel({ policy, requests, receipts });
  await writeCanonicalJson(output, panel);
  print({
    status: panel.status,
    output: absolute(output),
    consensus: panel.items.filter((item) => item.outcome === "consensus").length,
    disputed: panel.items.filter((item) => item.outcome === "disputed").length,
    unresolved: panel.unresolvedSourceContentHashes.length,
    hash: panel.hash,
  });
}

async function catalogCluster(values: string[]): Promise<void> {
  const options = parseOptions(values);
  const output = options.get("--output") ?? ".basalt/catalog/admission-cohorts.json";
  const policy = await loadAdmissionPolicy(options.get("--policy"));
  const measured = CATALOG_MEASUREMENT_SET_SCHEMA.parse(
    await readJson(options.get("--measurements") ?? ".basalt/catalog/measurements.json"),
  );
  const panel = CATALOG_HYPOTHESIS_PANEL_SCHEMA.parse(
    await readJson(options.get("--panel") ?? ".basalt/catalog/hypothesis-panel.json"),
  );
  const visual = CATALOG_VISUAL_REVIEW_INDEX_SCHEMA.parse(
    await readJson(options.get("--renders") ?? ".basalt/catalog/review/index.json"),
  );
  const embeddings = await loadOrCreateVisualEmbeddingSet(
    options.get("--embeddings") ?? ".basalt/catalog/visual-embeddings.json",
    visual,
  );
  const cohorts = buildCatalogAdmissionCohorts({
    policy,
    panel,
    measurements: measured,
    visualEmbeddings: embeddings,
    styleProfileHandle: options.get("--style") ?? "neutral",
  });
  await writeCanonicalJson(output, cohorts);
  print({
    status: cohorts.status,
    output: absolute(output),
    cohorts: cohorts.cohorts.length,
    represented: cohorts.cohorts.reduce(
      (sum, cohort) => sum + cohort.sourceContentHashes.length,
      0,
    ),
    unresolved: cohorts.unresolvedSourceContentHashes.length,
    hash: cohorts.hash,
  });
}

async function catalogReview(values: string[]): Promise<void> {
  const options = parseOptions(values);
  const output = options.get("--output") ?? ".basalt/catalog/review-plan.json";
  const policy = await loadAdmissionPolicy(options.get("--policy"));
  const panel = CATALOG_HYPOTHESIS_PANEL_SCHEMA.parse(
    await readJson(options.get("--panel") ?? ".basalt/catalog/hypothesis-panel.json"),
  );
  const cohorts = CATALOG_ADMISSION_COHORT_SET_SCHEMA.parse(
    await readJson(options.get("--cohorts") ?? ".basalt/catalog/admission-cohorts.json"),
  );
  const measured = CATALOG_MEASUREMENT_SET_SCHEMA.parse(
    await readJson(options.get("--measurements") ?? ".basalt/catalog/measurements.json"),
  );
  const embeddings = CATALOG_VISUAL_EMBEDDING_SET_SCHEMA.parse(
    await readJson(options.get("--embeddings") ?? ".basalt/catalog/visual-embeddings.json"),
  );
  const plan = buildCatalogReviewPlan({
    policy,
    panel,
    cohorts,
    measurements: measured,
    visualEmbeddings: embeddings,
  });
  await writeCanonicalJson(output, plan);
  print({
    status: plan.status,
    output: absolute(output),
    selected: plan.selectedSourceCount,
    represented: plan.representedSourceCount,
    exceptions: plan.exceptionSourceContentHashes.length,
    hash: plan.hash,
  });
}

async function loadOrCreateReceiptSet(
  path: string,
  requestSet: CatalogHypothesisRequestSet,
): Promise<CatalogHypothesisReceiptSet> {
  const stored = await readOptionalJson(path);
  if (stored !== undefined) {
    const parsed = CATALOG_HYPOTHESIS_RECEIPT_SET_SCHEMA.parse(stored);
    if (parsed.requestSetHash !== requestSet.hash)
      throw new Error("Hypothesis receipt set binds a different request set");
    const requests = new Map(requestSet.requests.map((request) => [request.hash, request]));
    for (const receipt of parsed.receipts) {
      const request = requests.get(receipt.requestHash);
      if (
        !request ||
        request.sourceContentHash !== receipt.sourceContentHash ||
        request.measurementHash !== receipt.measurementHash ||
        request.renderEvidenceHash !== receipt.renderEvidenceHash ||
        request.semanticModuleHash !== receipt.semanticModuleHash ||
        request.semanticLexiconHash !== receipt.semanticLexiconHash
      )
        throw new Error(`Hypothesis receipt does not bind its exact request: ${receipt.hash}`);
    }
    return parsed;
  }
  const empty = sealCatalogHypothesisReceiptSet({
    status: "incomplete",
    requestSetHash: requestSet.hash,
    receipts: [],
    missingRequestHashes: requestSet.requests.map((request) => request.hash),
    diagnostics: ["External vision hypotheses have not been supplied"],
  });
  await writeCanonicalJson(path, empty);
  return empty;
}

async function loadOrCreateVisualEmbeddingSet(
  path: string,
  visual: z.output<typeof CATALOG_VISUAL_REVIEW_INDEX_SCHEMA>,
) {
  const stored = await readOptionalJson(path);
  if (stored !== undefined) {
    const parsed = CATALOG_VISUAL_EMBEDDING_SET_SCHEMA.parse(stored);
    if (parsed.visualReviewIndexHash !== visual.hash)
      throw new Error("Visual embeddings bind a different render index");
    const renders = new Map(
      visual.items.map((item) => [item.sourceContentHash, item.evidence.hash] as const),
    );
    for (const receipt of parsed.receipts)
      if (renders.get(receipt.sourceContentHash) !== receipt.renderEvidenceHash)
        throw new Error(`Visual embedding does not bind exact render evidence: ${receipt.hash}`);
    return parsed;
  }
  const empty = sealCatalogVisualEmbeddingSet({
    visualReviewIndexHash: visual.hash,
    embeddingImplementationHash: contentHash("visual-embedding-adapter-not-configured"),
    expectedSourceContentHashes: visual.items.map((item) => item.sourceContentHash),
    receipts: [],
  });
  await writeCanonicalJson(path, empty);
  return empty;
}

const reviewedSamplesSchema = z.array(
  z
    .object({
      sourceContentHash: z.string().regex(/^[a-f0-9]{64}$/u),
      finding: z.enum(["conforms", "does_not_conform", "uncertain"]),
      note: z.string().trim().min(1).max(2048),
    })
    .strict(),
);

async function catalogDecide(values: string[]): Promise<void> {
  const cohortId = positional(values, 0, "cohort ID");
  const options = parseOptions(values.slice(1));
  const policy = await loadAdmissionPolicy(options.get("--policy"));
  const cohorts = CATALOG_ADMISSION_COHORT_SET_SCHEMA.parse(
    await readJson(options.get("--cohorts") ?? ".basalt/catalog/admission-cohorts.json"),
  );
  const reviewPlan = CATALOG_REVIEW_PLAN_SCHEMA.parse(
    await readJson(options.get("--review-plan") ?? ".basalt/catalog/review-plan.json"),
  );
  const cohort = cohorts.cohorts.find((entry) => entry.cohortId === cohortId);
  if (!cohort) throw new Error(`Unknown admission cohort ${cohortId}`);
  const actionName = requiredOption(options, "--action");
  const reviewedSamples = options.has("--findings")
    ? reviewedSamplesSchema.parse(await readJson(options.get("--findings")!))
    : [];
  const action =
    actionName === "admit"
      ? {
          kind: "admit_substitution_set" as const,
          entryHandle: requiredOption(options, "--entry"),
          styleProfileHandle: options.get("--style") ?? cohort.styleProfileHandle,
          selectionWeight: parsePositiveInteger(options.get("--weight") ?? "1", "--weight"),
        }
      : actionName === "reject"
        ? { kind: "reject" as const, reason: requiredOption(options, "--reason") }
        : actionName === "incomplete"
          ? { kind: "remain_incomplete" as const, reason: requiredOption(options, "--reason") }
          : (() => {
              throw new Error("--action must be admit, reject, or incomplete");
            })();
  const decision = sealCatalogCohortDecision({
    policyHash: policy.hash,
    cohortId: cohort.cohortId,
    cohortHash: cohort.hash,
    reviewPlanHash: reviewPlan.hash,
    authorityId: requiredOption(options, "--authority"),
    reviewedSamples,
    action,
    rationale: requiredOption(options, "--rationale"),
  });
  const output = options.get("--output") ?? `registry/cohort-decisions/${cohort.cohortId}.json`;
  await writeCanonicalJson(output, decision);
  print({ status: "eligible", output: absolute(output), decisionHash: decision.hash });
}

const auditSamplesSchema = z.array(
  z
    .object({
      sourceContentHash: z.string().regex(/^[a-f0-9]{64}$/u),
      finding: z.enum(["conforms", "violation"]),
      diagnostic: z.string().trim().min(1).max(2048),
    })
    .strict(),
);

async function catalogAudit(values: string[]): Promise<void> {
  const cohortId = positional(values, 0, "cohort ID");
  const options = parseOptions(values.slice(1));
  const policy = await loadAdmissionPolicy(options.get("--policy"));
  const decisionPath = options.get("--decision") ?? `registry/cohort-decisions/${cohortId}.json`;
  const decision = CATALOG_COHORT_DECISION_SCHEMA.parse(await readJson(decisionPath));
  if (decision.cohortId !== cohortId) throw new Error("Audit decision binds another cohort");
  const audit = sealCatalogCohortAudit({
    policyHash: policy.hash,
    cohortHash: decision.cohortHash,
    decisionHash: decision.hash,
    auditorId: requiredOption(options, "--auditor"),
    samples: auditSamplesSchema.parse(await readJson(requiredOption(options, "--findings"))),
  });
  const output = options.get("--output") ?? `registry/audits/${cohortId}.json`;
  await writeCanonicalJson(output, audit);
  print({
    status: audit.outcome === "passed" ? "eligible" : "rejected",
    output: absolute(output),
    hash: audit.hash,
  });
}

async function catalogValidate(values: string[]): Promise<void> {
  const options = parseOptions(values);
  const authority = await loadCatalogAuthority(options);
  const snapshot = sealCatalogAuthoritySnapshot(authority);
  const committed = await verifyCatalogCommit(
    options.get("--commit") ?? "registry/catalog.json",
    authority,
    snapshot,
  );
  if (options.get("--require-commit") === "true" && !committed.current)
    throw new Error(`Catalog is not committed: ${committed.diagnostic}`);
  print({
    status: snapshot.status,
    hash: snapshot.hash,
    entries: snapshot.entries.length,
    sourceIdentities: snapshot.sourceIdentityCount,
    diagnostics: snapshot.diagnostics.length,
    committed: committed.current,
    commitDiagnostic: committed.diagnostic,
  });
}

async function catalogSeal(values: string[]): Promise<void> {
  const options = parseOptions(values);
  const output = options.get("--output") ?? ".basalt/catalog/catalog.json";
  const snapshot = sealCatalogAuthoritySnapshot(await loadCatalogAuthority(options));
  await writeCanonicalJson(output, snapshot);
  print({
    status: snapshot.status,
    output: absolute(output),
    hash: snapshot.hash,
    entries: snapshot.entries.length,
  });
}

async function catalogAdmit(values: string[]): Promise<void> {
  const options = parseOptions(values);
  const lock = await acquireWorkspaceExclusiveLock(repositoryRoot, CATALOG_COMMIT_LOCK_PATH);
  try {
    const policy = await loadAdmissionPolicy(options.get("--policy"));
    const authority = await loadCatalogAuthority(options);
    const receipts = CATALOG_HYPOTHESIS_RECEIPT_SET_SCHEMA.parse(
      await readJson(options.get("--receipts") ?? ".basalt/catalog/hypothesis-receipts.json"),
    );
    const panel = CATALOG_HYPOTHESIS_PANEL_SCHEMA.parse(
      await readJson(options.get("--panel") ?? ".basalt/catalog/hypothesis-panel.json"),
    );
    const cohorts = CATALOG_ADMISSION_COHORT_SET_SCHEMA.parse(
      await readJson(options.get("--cohorts") ?? ".basalt/catalog/admission-cohorts.json"),
    );
    const reviewPlan = CATALOG_REVIEW_PLAN_SCHEMA.parse(
      await readJson(options.get("--review-plan") ?? ".basalt/catalog/review-plan.json"),
    );
    const decisions = await readOptionalDirectoryJson(
      options.get("--decisions") ?? "registry/cohort-decisions",
      CATALOG_COHORT_DECISION_SCHEMA,
    );
    const audits = await readOptionalDirectoryJson(
      options.get("--audits") ?? "registry/audits",
      CATALOG_COHORT_AUDIT_SCHEMA,
    );
    const result = applyCatalogAdmissionDecisions({
      policy,
      module: authority.semanticModule,
      measurements: authority.measurements,
      receipts,
      panel,
      cohorts,
      reviewPlan,
      decisions,
      audits,
      existingDeclarations: authority.entryDeclarations,
      existingAssertions: authority.assertions,
      existingDispositions: authority.dispositions,
    });
    const entriesRoot = options.get("--entries") ?? "registry/entries";
    for (const declaration of result.declarations)
      await writeCanonicalJson(`${entriesRoot}/${declaration.handle}.json`, declaration);
    const assertionsRoot = options.get("--assertions") ?? "registry/assertions";
    for (const assertion of result.assertions)
      await writeCanonicalJson(`${assertionsRoot}/${assertionFileStem(assertion)}.json`, assertion);
    await writeCanonicalJson(
      options.get("--dispositions") ?? "registry/dispositions.json",
      result.dispositions,
    );
    const commit = await materializeCatalogCommit(options);
    const output = options.get("--output") ?? options.get("--commit") ?? "registry/catalog.json";
    await assertCatalogCommitIsGitReady(output, commit.retainedEvidence);
    print({
      status: result.status,
      appliedDecisions: result.appliedDecisionHashes.length,
      diagnostics: result.diagnostics,
      catalogCommit: absolute(output),
      catalogCommitHash: commit.hash,
      gitReady: true,
    });
  } finally {
    await lock.release();
  }
}

async function catalogCommit(values: string[]): Promise<void> {
  const options = parseOptions(values);
  const lock = await acquireWorkspaceExclusiveLock(repositoryRoot, CATALOG_COMMIT_LOCK_PATH);
  try {
    const commit = await materializeCatalogCommit(options);
    const output = options.get("--output") ?? options.get("--commit") ?? "registry/catalog.json";
    await assertCatalogCommitIsGitReady(output, commit.retainedEvidence);
    print({
      status: commit.status,
      output: absolute(output),
      hash: commit.hash,
      catalogHash: commit.snapshot.hash,
      entries: commit.snapshot.entries.length,
      retainedEvidence: commit.retainedEvidence.length,
      sourcePayloadPolicy: commit.sourcePayloadPolicy,
      gitReady: true,
    });
  } finally {
    await lock.release();
  }
}

async function worldCompile(values: string[]): Promise<void> {
  const planPath = positional(values, 0, "spatial plan");
  const options = parseOptions(values.slice(1));
  const catalogPath = requiredOption(options, "--catalog");
  const output = options.get("--output") ?? ".basalt/world/world-build.json";
  const semanticModule = await loadSemanticModule();
  const plan = SPATIAL_WORLD_PLAN_SCHEMA.parse(await readJson(planPath));
  const catalogCommit = CATALOG_AUTHORITY_COMMIT_SCHEMA.parse(await readJson(catalogPath));
  const retainedMeasurements = catalogCommit.retainedEvidence.find(
    (entry) =>
      entry.kind === "CatalogMeasurementSet" &&
      entry.artifactHash === catalogCommit.measurementSetHash,
  );
  if (!retainedMeasurements)
    throw new Error("Committed catalog does not retain its exact measurement set");
  const measurements = CATALOG_MEASUREMENT_SET_SCHEMA.parse(
    await readJson(retainedMeasurements.relativePath),
  );
  if (catalogCommit.measurementSetHash !== measurements.hash)
    throw new Error("Committed catalog binds a different measurement set");
  const worldBuild = compileBasaltWorld({
    semanticModule,
    catalogSnapshot: catalogCommit.snapshot,
    catalogAssets: measurements.assets,
    spatialPlan: plan,
  });
  await writeCanonicalJson(output, worldBuild);
  print({
    status: worldBuild.status,
    output: absolute(output),
    worldBuildHash: worldBuild.worldBuildHash,
    instances: worldBuild.instances.length,
  });
}

async function robloxInstallPlugin(): Promise<void> {
  const credential = await installRobloxCredential(repositoryRoot);
  const pluginDirectory = resolve(homedir(), "Documents/Roblox/Plugins");
  const output = resolve(pluginDirectory, "BasaltStudioPlugin.rbxmx");
  await mkdir(pluginDirectory, { recursive: true });
  await execFile(
    process.env.BASALT_ROJO ?? "rojo",
    ["build", "packages/roblox/plugin/default.project.json", "--output", output],
    { cwd: repositoryRoot, maxBuffer: 4 * 1024 * 1024 },
  );
  print({
    status: "eligible",
    credentialHash: credential.hash,
    plugin: output,
    connection: "automatic",
  });
}

async function robloxImport(values: string[]): Promise<void> {
  const worldPath = positional(values, 0, "world build");
  const worldBuild = WORLD_BUILD_SCHEMA.parse(await readJson(worldPath));
  const credential = await readRobloxCredential(repositoryRoot).catch((error: unknown) => {
    if (/missing|does not exist|not found/iu.test(String(error)))
      throw new Error("Roblox plugin is not installed; run `basalt roblox install-plugin`");
    throw error;
  });
  const bindings = await readOptionalJson(".basalt/roblox/asset-bindings.json");
  const manifest = createRobloxImportManifest(
    worldBuild,
    bindings === undefined ? [] : ROBLOX_ASSET_BINDING_SCHEMA.array().parse(bindings),
  );
  const bridge = new RobloxImportBridge({ workspaceRoot: repositoryRoot, manifest, credential });
  const port = await bridge.start();
  print({
    status: "pending",
    worldBuildHash: worldBuild.worldBuildHash,
    port,
    discovery: "automatic",
  });
  const shutdown = async () => {
    await bridge.stop();
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
  await new Promise<void>((resolveImport) => {
    const timer = setInterval(() => {
      if (bridge.state === "complete" || bridge.state === "incomplete") {
        clearInterval(timer);
        resolveImport();
      }
    }, 250);
  });
  await bridge.stop();
  print({ status: bridge.state, worldBuildHash: worldBuild.worldBuildHash });
  if (bridge.state !== "complete") process.exitCode = 1;
}

interface CatalogAuthorityInputs {
  readonly semanticModule: SemanticModule;
  readonly semanticLexiconHash: string;
  readonly manifest: z.output<typeof TRUSTED_SOURCE_MANIFEST_SCHEMA>;
  readonly measurements: z.output<typeof CATALOG_MEASUREMENT_SET_SCHEMA>;
  readonly styleDeclarations: z.output<typeof STYLE_PROFILE_DECLARATION_SCHEMA>[];
  readonly entryDeclarations: z.output<typeof CATALOG_ENTRY_DECLARATION_SCHEMA>[];
  readonly dispositions: z.output<typeof CATALOG_DISPOSITION_SCHEMA>[];
  readonly assertions: z.output<typeof SEMANTIC_ADMITTED_ASSERTION_BUNDLE_SCHEMA>[];
  readonly admissionPolicy: z.output<typeof CATALOG_ADMISSION_POLICY_SCHEMA>;
  readonly decisions: z.output<typeof CATALOG_COHORT_DECISION_SCHEMA>[];
  readonly audits: z.output<typeof CATALOG_COHORT_AUDIT_SCHEMA>[];
}

async function loadCatalogAuthority(
  options: ReadonlyMap<string, string>,
): Promise<CatalogAuthorityInputs> {
  const semanticModule = await loadSemanticModule();
  const lexicon = SEMANTIC_LEXICON_SNAPSHOT_SCHEMA.parse(
    await readJson(options.get("--lexicon") ?? "registry/semantics/lexicon.json"),
  );
  const manifest = TRUSTED_SOURCE_MANIFEST_SCHEMA.parse(
    await readJson(options.get("--source") ?? "registry/source-manifest.json"),
  );
  const measurements = CATALOG_MEASUREMENT_SET_SCHEMA.parse(
    await readJson(options.get("--measurements") ?? ".basalt/catalog/measurements.json"),
  );
  const styleDeclarations = STYLE_PROFILE_DECLARATION_SCHEMA.array().parse(
    await readJson(options.get("--styles") ?? "registry/style-profiles.json"),
  );
  const entryDeclarations = await readDirectoryJson(
    options.get("--entries") ?? "registry/entries",
    CATALOG_ENTRY_DECLARATION_SCHEMA,
  );
  const dispositions = CATALOG_DISPOSITION_SCHEMA.array().parse(
    await readJson(options.get("--dispositions") ?? "registry/dispositions.json"),
  );
  const assertions = await readDirectoryJson(
    options.get("--assertions") ?? "registry/assertions",
    SEMANTIC_ADMITTED_ASSERTION_BUNDLE_SCHEMA,
  );
  const admissionPolicy = await loadAdmissionPolicy(options.get("--policy"));
  const decisions = await readOptionalDirectoryJson(
    options.get("--decisions") ?? "registry/cohort-decisions",
    CATALOG_COHORT_DECISION_SCHEMA,
  );
  const audits = await readOptionalDirectoryJson(
    options.get("--audits") ?? "registry/audits",
    CATALOG_COHORT_AUDIT_SCHEMA,
  );
  return {
    semanticModule,
    semanticLexiconHash: lexicon.hash,
    manifest,
    measurements,
    styleDeclarations,
    entryDeclarations,
    dispositions,
    assertions,
    admissionPolicy,
    decisions,
    audits,
  };
}

function sealCatalogAuthoritySnapshot(authority: CatalogAuthorityInputs) {
  return sealCatalogSnapshot({
    semanticModule: authority.semanticModule,
    semanticAssertions: authority.assertions,
    styleProfiles: authority.styleDeclarations.map(sealStyleProfile),
    assets: authority.measurements.assets,
    declarations: authority.entryDeclarations,
    dispositions: authority.dispositions,
    sourceContentHashes: [
      ...new Set(
        authority.manifest.packages.flatMap((pack) => pack.files.map((file) => file.sha256)),
      ),
    ],
  });
}

async function materializeCatalogCommit(options: ReadonlyMap<string, string>) {
  const authority = await loadCatalogAuthority(options);
  const snapshot = sealCatalogAuthoritySnapshot(authority);
  const retainedEvidence = await retainCatalogEvidence(options);
  const commit = sealCatalogAuthorityCommit({
    sourceManifest: authority.manifest,
    semanticModuleHash: authority.semanticModule.snapshot.hash,
    semanticLexiconHash: authority.semanticLexiconHash,
    measurementSetHash: authority.measurements.hash,
    snapshot,
    styleProfiles: authority.styleDeclarations,
    declarations: authority.entryDeclarations,
    assertions: authority.assertions,
    dispositions: authority.dispositions,
    admissionPolicy: authority.admissionPolicy,
    cohortDecisions: authority.decisions,
    audits: authority.audits,
    retainedEvidence,
  });
  await writeCanonicalJson(
    options.get("--output") ?? options.get("--commit") ?? "registry/catalog.json",
    commit,
  );
  await pruneUnreferencedCatalogEvidence(commit.retainedEvidence);
  return commit;
}

async function retainCatalogEvidence(
  options: ReadonlyMap<string, string>,
): Promise<RetainedCatalogEvidence[]> {
  const candidates = [
    {
      path: options.get("--measurements") ?? ".basalt/catalog/measurements.json",
      schema: CATALOG_MEASUREMENT_SET_SCHEMA,
    },
    {
      path: options.get("--renders") ?? ".basalt/catalog/review/index.json",
      schema: CATALOG_VISUAL_REVIEW_INDEX_SCHEMA,
    },
    {
      path: options.get("--requests") ?? ".basalt/catalog/hypothesis-requests.json",
      schema: CATALOG_HYPOTHESIS_REQUEST_SET_SCHEMA,
    },
    {
      path: options.get("--receipts") ?? ".basalt/catalog/hypothesis-receipts.json",
      schema: CATALOG_HYPOTHESIS_RECEIPT_SET_SCHEMA,
    },
    {
      path: options.get("--panel") ?? ".basalt/catalog/hypothesis-panel.json",
      schema: CATALOG_HYPOTHESIS_PANEL_SCHEMA,
    },
    {
      path: options.get("--embeddings") ?? ".basalt/catalog/visual-embeddings.json",
      schema: CATALOG_VISUAL_EMBEDDING_SET_SCHEMA,
    },
    {
      path: options.get("--cohorts") ?? ".basalt/catalog/admission-cohorts.json",
      schema: CATALOG_ADMISSION_COHORT_SET_SCHEMA,
    },
    {
      path: options.get("--review-plan") ?? ".basalt/catalog/review-plan.json",
      schema: CATALOG_REVIEW_PLAN_SCHEMA,
    },
  ] as const;
  const retained: RetainedCatalogEvidence[] = [];
  for (const candidate of candidates) {
    const raw = await readOptionalJson(candidate.path);
    if (raw === undefined) continue;
    const artifact = candidate.schema.parse(raw);
    const relativePath = `registry/evidence/${artifact.hash}.json`;
    await writeCanonicalJson(relativePath, artifact);
    const bytes = await readBoundedWorkspaceBytes(
      repositoryRoot,
      absolute(relativePath),
      512 * 1024 * 1024,
    );
    retained.push({
      kind: artifact.kind,
      relativePath,
      artifactHash: artifact.hash,
      bytesHash: sha256(bytes),
      bytes: bytes.byteLength,
    });
  }
  return retained.sort((left, right) => compare(left.relativePath, right.relativePath));
}

async function pruneUnreferencedCatalogEvidence(
  retainedEvidence: readonly RetainedCatalogEvidence[],
): Promise<void> {
  const retained = new Set(retainedEvidence.map((entry) => entry.relativePath));
  const root = "registry/evidence";
  const rootInformation = await lstat(absolute(root));
  if (!rootInformation.isDirectory() || rootInformation.isSymbolicLink())
    throw new Error(`Refusing to prune unsafe catalog evidence root: ${root}`);
  for (const name of await readdir(absolute(root))) {
    if (!/^[a-f0-9]{64}\.json$/u.test(name)) continue;
    const path = `${root}/${name}`;
    if (retained.has(path)) continue;
    const information = await lstat(absolute(path));
    if (!information.isFile() || information.isSymbolicLink())
      throw new Error(`Refusing to prune non-regular catalog evidence: ${path}`);
    await unlink(absolute(path));
  }
}

async function verifyCatalogCommit(
  path: string,
  authority: CatalogAuthorityInputs,
  snapshot: z.output<typeof CATALOG_SNAPSHOT_SCHEMA>,
): Promise<{ current: boolean; diagnostic: string }> {
  const raw = await readOptionalJson(path);
  if (raw === undefined) return { current: false, diagnostic: "Run `basalt catalog commit`" };
  const committed = CATALOG_AUTHORITY_COMMIT_SCHEMA.parse(raw);
  for (const evidence of committed.retainedEvidence) {
    const bytes = await readBoundedWorkspaceBytes(
      repositoryRoot,
      absolute(evidence.relativePath),
      512 * 1024 * 1024,
    ).catch(() => undefined);
    if (!bytes || bytes.byteLength !== evidence.bytes || sha256(bytes) !== evidence.bytesHash)
      return {
        current: false,
        diagnostic: `Retained evidence is missing or changed: ${evidence.relativePath}`,
      };
  }
  const expected = sealCatalogAuthorityCommit({
    sourceManifest: authority.manifest,
    semanticModuleHash: authority.semanticModule.snapshot.hash,
    semanticLexiconHash: authority.semanticLexiconHash,
    measurementSetHash: authority.measurements.hash,
    snapshot,
    styleProfiles: authority.styleDeclarations,
    declarations: authority.entryDeclarations,
    assertions: authority.assertions,
    dispositions: authority.dispositions,
    admissionPolicy: authority.admissionPolicy,
    cohortDecisions: authority.decisions,
    audits: authority.audits,
    retainedEvidence: committed.retainedEvidence,
  });
  return expected.hash === committed.hash
    ? { current: true, diagnostic: "Tracked catalog root matches current authority and evidence" }
    : { current: false, diagnostic: "Tracked catalog root is stale; run `basalt catalog commit`" };
}

async function assertCatalogCommitIsGitReady(
  rootPath: string,
  retainedEvidence: readonly RetainedCatalogEvidence[],
): Promise<void> {
  const paths = [rootPath, ...retainedEvidence.map((entry) => entry.relativePath)];
  for (const path of paths) {
    const destination = absolute(path);
    const relation = destination.startsWith(`${repositoryRoot}/`)
      ? destination.slice(repositoryRoot.length + 1)
      : undefined;
    if (!relation)
      throw new Error(`Catalog authority must be written inside the Git worktree: ${destination}`);
    try {
      await execFile("git", ["check-ignore", "--quiet", "--", relation], {
        cwd: repositoryRoot,
        maxBuffer: 1024 * 1024,
      });
    } catch (error) {
      if ((error as { code?: number }).code === 1) continue;
      throw error;
    }
    throw new Error(`Catalog authority is ignored by Git and cannot be committed: ${relation}`);
  }
}

async function loadSemanticModule(): Promise<SemanticModule> {
  const root = "registry/semantics";
  const kernel = SEMANTIC_KERNEL_SCHEMA.parse(await readJson(`${root}/kernel.json`));
  const concepts = await readDirectoryJson(`${root}/concepts`, CONCEPT_COMMITMENT_SCHEMA);
  const affordances = AFFORDANCE_DEFINITION_SCHEMA.array().parse(
    await readJson(`${root}/affordances.json`),
  );
  const realizationForms = REALIZATION_FORM_DEFINITION_SCHEMA.array().parse(
    await readJson(`${root}/realization-forms.json`),
  );
  const stateDimensions = STATE_DIMENSION_DEFINITION_SCHEMA.array().parse(
    await readJson(`${root}/states.json`),
  );
  const surfaceTreatments = SURFACE_TREATMENT_DEFINITION_SCHEMA.array().parse(
    await readJson(`${root}/treatments.json`),
  );
  const roleSchemes = await readDirectoryJson(`${root}/roles`, ROLE_SCHEME_DEFINITION_SCHEMA);
  const relations = RELATION_DEFINITION_SCHEMA.array().parse(
    await readJson(`${root}/relations.json`),
  );
  const annotationPredicates = ANNOTATION_PREDICATE_DEFINITION_SCHEMA.array().parse(
    await readJson(`${root}/annotation-predicates.json`),
  );
  const constraints = SEMANTIC_CONSTRAINT_SET_SCHEMA.parse(
    await readJson(`${root}/constraints.json`),
  );
  return sealSemanticModule({
    kernel,
    concepts,
    affordances,
    realizationForms,
    stateDimensions,
    surfaceTreatments,
    roleSchemes,
    relations,
    annotationPredicates,
    constraints,
  });
}

interface CatalogMeasureOutcome {
  readonly sourceContentHash: string;
  readonly asset?: CatalogAssetArtifact;
  readonly error?: string;
}

async function measureCatalogTasks(
  tasks: readonly CatalogMeasureTask[],
  concurrency: number,
): Promise<CatalogMeasureOutcome[]> {
  if (tasks.length === 0) return [];
  let cursor = 0;
  const results: CatalogMeasureOutcome[] = [];
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      const worker = new Worker(new URL("./catalog-measure-worker.js", import.meta.url));
      try {
        for (;;) {
          const index = cursor;
          cursor += 1;
          const task = tasks[index];
          if (!task) break;
          const result = await requestMeasurement(worker, task);
          results.push({
            sourceContentHash: task.source.contentHash,
            ...(result.asset
              ? { asset: CATALOG_ASSET_ARTIFACT_SCHEMA.parse(result.asset) }
              : { error: result.error ?? "Measurement worker returned no result" }),
          });
        }
      } finally {
        await worker.terminate();
      }
    }),
  );
  return results.sort((left, right) => compare(left.sourceContentHash, right.sourceContentHash));
}

function requestMeasurement(
  worker: Worker,
  task: CatalogMeasureTask,
): Promise<{ readonly asset?: unknown; readonly error?: string }> {
  return new Promise((resolveTask, rejectTask) => {
    const onError = (error: Error) => {
      worker.off("message", onMessage);
      rejectTask(error);
    };
    const onMessage = (message: {
      readonly taskId: number;
      readonly asset?: unknown;
      readonly error?: string;
    }) => {
      if (message.taskId !== task.taskId) return;
      worker.off("error", onError);
      worker.off("message", onMessage);
      resolveTask(message);
    };
    worker.once("error", onError);
    worker.on("message", onMessage);
    worker.postMessage(task);
  });
}
async function readJson(path: string): Promise<unknown> {
  return readBoundedWorkspaceJson(repositoryRoot, absolute(path), 512 * 1024 * 1024);
}
async function readOptionalJson(path: string): Promise<unknown | undefined> {
  try {
    return await readJson(path);
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === "ENOENT" ||
      /missing|does not exist|not found/iu.test(String(error))
    )
      return undefined;
    throw error;
  }
}
async function readDirectoryJson<T>(
  path: string,
  schema: { parse(value: unknown): T },
): Promise<T[]> {
  const directory = absolute(path);
  const names = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort(compare);
  const result: T[] = [];
  for (const name of names) result.push(schema.parse(await readJson(join(path, name))));
  return result;
}
async function readOptionalDirectoryJson<T>(
  path: string,
  schema: { parse(value: unknown): T },
): Promise<T[]> {
  try {
    return await readDirectoryJson(path, schema);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
async function loadAdmissionPolicy(path = "registry/admission-policy.json") {
  return CATALOG_ADMISSION_POLICY_SCHEMA.parse(await readJson(path));
}
function assertionFileStem(
  assertion: z.output<typeof SEMANTIC_ADMITTED_ASSERTION_BUNDLE_SCHEMA>,
): string {
  const subjects = [
    ...new Set(
      assertion.assertions
        .filter((entry) => entry.subject.kind === "catalog_asset")
        .map((entry) => entry.subject.id),
    ),
  ];
  return subjects.length === 1 ? subjects[0]! : `assertions_${assertion.hash}`;
}
async function writeCanonicalJson(path: string, value: unknown): Promise<void> {
  const destination = absolute(path);
  let expectedExistingHash: string | undefined;
  try {
    const information = await lstat(destination);
    if (!information.isFile() || information.isSymbolicLink())
      throw new Error(`Workspace output is not a regular file: ${destination}`);
    expectedExistingHash = sha256(
      await readBoundedWorkspaceBytes(repositoryRoot, destination, 512 * 1024 * 1024),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await writeCanonicalWorkspaceJson(repositoryRoot, destination, value, {
    maxBytes: 512 * 1024 * 1024,
    ...(expectedExistingHash ? { expectedExistingHash } : {}),
  });
}
function parseOptions(values: readonly string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith("--") || !value || value.startsWith("--"))
      throw new Error(`Malformed option near ${key ?? "end of command"}`);
    if (result.has(key)) throw new Error(`Option is repeated: ${key}`);
    result.set(key, value);
  }
  return result;
}
function positional(values: readonly string[], index: number, label: string): string {
  const value = values[index];
  if (!value || value.startsWith("--")) throw new Error(`Missing ${label}`);
  return value;
}
function requiredOption(options: ReadonlyMap<string, string>, name: string): string {
  const value = options.get(name);
  if (!value) throw new Error(`Missing required option ${name}`);
  return value;
}
function parsePositiveInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0)
    throw new Error(`${label} must be a positive integer`);
  return parsed;
}
function absolute(path: string): string {
  return resolve(repositoryRoot, path);
}
function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
function failUsage(message: string): void {
  process.stderr.write(`${message}\n\n`);
  usage();
  process.exitCode = 2;
}
function usage(): void {
  process.stdout.write(
    [
      "Basalt — semantic world compiler",
      "",
      "  basalt semantics validate|seal|explain",
      "  basalt catalog inventory|providers|measure|render|hypothesize|panel|cluster|review",
      "  basalt catalog decide|audit|admit|validate|seal|commit",
      "  basalt world compile <plan> --catalog <committed-catalog>",
      "  basalt roblox install-plugin",
      "  basalt roblox import <world-build>",
      "",
    ].join("\n"),
  );
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
