import { createHash } from "node:crypto";
import { execFile as execFileCallback, spawn as spawnChild } from "node:child_process";
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
  CATALOG_ACCEPTANCE_AUDIT_PLAN_SCHEMA,
  CATALOG_ACCEPTANCE_AUDIT_RECEIPT_SCHEMA,
  CATALOG_ADAPTER_CALIBRATION_SET_SCHEMA,
  CATALOG_ADMISSION_RUBRIC_SCHEMA,
  CATALOG_ADMISSION_POLICY_SCHEMA,
  CATALOG_CALIBRATED_PREDICTION_SET_SCHEMA,
  CATALOG_CALIBRATION_SPLIT_SCHEMA,
  CATALOG_AUTHORITY_COMMIT_SCHEMA,
  CATALOG_DISCOVERY_REVIEW_PLAN_SCHEMA,
  CATALOG_FEATURE_SET_SCHEMA,
  CATALOG_FACET_VALUE_SCHEMA,
  CATALOG_HYPOTHESIS_RECEIPT_SET_SCHEMA,
  CATALOG_HYPOTHESIS_REQUEST_SET_SCHEMA,
  CATALOG_LEAKAGE_ANALYSIS_SCHEMA,
  CATALOG_LEAKAGE_GROUPING_POLICY_SCHEMA,
  CATALOG_NEAR_DUPLICATE_SEARCH_SCHEMA,
  CATALOG_PILOT_WORKER_OUTPUT_SCHEMA,
  CATALOG_QUALIFICATION_PILOT_PLAN_SCHEMA,
  CATALOG_QUALIFICATION_RECEIPT_SCHEMA,
  CATALOG_REFERENCE_JUDGMENT_SET_SCHEMA,
  CATALOG_SOURCE_NAME_HINT_SET_SCHEMA,
  CATALOG_SUBSTITUTION_PROPOSAL_SET_SCHEMA,
  CATALOG_VISUAL_REVIEW_INDEX_SCHEMA,
  CATALOG_REVIEW_VIEWPOINTS,
  MAX_LOCAL_CATALOG_WORKERS,
  requireLocalCatalogWorkerCount,
  analyzeCatalogLeakage,
  assignCatalogCalibrationGroups,
  buildCatalogLeakageGroups,
  buildCatalogAcceptanceAuditPlan,
  buildCatalogCalibratedPredictionSet,
  buildCatalogDiscoveryReviewPlan,
  buildCatalogQualificationPilotPlan,
  buildCatalogQualificationReceipt,
  buildCatalogSubstitutionProposalSet,
  buildCatalogSourceNameHintSet,
  calibrateCatalogAdapter,
  facetValueKey,
  materializeCatalogPilotInference,
  sealCatalogAuthorityCommit,
  sealCatalogCalibrationSplit,
  sealCatalogAdapterCalibrationSet,
  sealCatalogNearDuplicateSearch,
  sealCatalogReferenceJudgmentSet,
  validateCatalogCalibrationSplit,
  sealAssetSemanticHypothesisRequest,
  sealCatalogHypothesisRequestSet,
  type RetainedCatalogEvidence,
} from "@basalt/catalog-authoring";
import {
  CATALOG_ASSET_ARTIFACT_SCHEMA,
  CATALOG_DISPOSITION_SCHEMA,
  CATALOG_ENTRY_DECLARATION_SCHEMA,
  CATALOG_MEASUREMENT_SET_SCHEMA,
  CATALOG_SNAPSHOT_SCHEMA,
  SOURCE_PROVENANCE_LEDGER_SCHEMA,
  STYLE_PROFILE_DECLARATION_SCHEMA,
  TRUSTED_SOURCE_MANIFEST_SCHEMA,
  sealCatalogMeasurementSet,
  sealCatalogSnapshot,
  sealStyleProfile,
  validateSourceAuthority,
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
const CATALOG_NEAR_DUPLICATE_WORKER = "workers/catalog-review/near_duplicate.py";
const CATALOG_PILOT_WORKER = "workers/catalog-admission/pilot.py";
const CATALOG_PILOT_SELECTOR_HASH =
  "f4295f8589c8f99391c7c8f6b1b7b6a5a6626dbffb861a6bd4871ec2032503b3";
const CATALOG_PILOT_NORMALIZER_HASH =
  "7103ef00d11fbef7f2a62c00c8f1452ba3989ad6e710d86382aeda10465b4938";
const CATALOG_PILOT_AUDIT_RANDOMIZATION_HASH =
  "46f2271933df1fa2703943efba30971206890262adb772fe939d992fbb1eee64";

const CATALOG_INFERENCE_MODEL_DECLARATIONS_SCHEMA = z
  .object({
    kind: z.literal("CatalogInferenceModelDeclarations"),
    models: z
      .array(
        z
          .object({
            modelId: z.string().regex(/^[a-z][a-z0-9_]{2,127}$/u),
            source: z.enum(["huggingface", "basalt"]),
            repository: z.string().trim().min(1).max(256),
            revision: z.string().regex(/^[a-f0-9]{40,64}$/u),
            purpose: z.enum([
              "multiview_semantics_and_appearance",
              "multiview_shape",
              "source_name_hint",
            ]),
          })
          .strict(),
      )
      .length(3),
  })
  .strict()
  .superRefine((value, context) => {
    const ids = value.models.map((model) => model.modelId);
    const purposes = value.models.map((model) => model.purpose);
    if (new Set(ids).size !== ids.length)
      context.addIssue({ code: "custom", path: ["models"], message: "Model IDs must be unique" });
    if (new Set(purposes).size !== purposes.length)
      context.addIssue({
        code: "custom",
        path: ["models"],
        message: "Every pilot inference purpose must have exactly one model",
      });
  });

const CATALOG_NEAR_DUPLICATE_WORKER_OUTPUT_SCHEMA = z
  .object({
    kind: z.literal("CatalogNearDuplicateWorkerOutput"),
    algorithmId: z.literal("multiview_shape_dhash_ahash_8x8"),
    runtime: z
      .object({
        python: z.string().trim().min(1).max(64),
        pillow: z.string().trim().min(1).max(64),
      })
      .strict(),
    descriptorSetHash: z.string().regex(/^[a-f0-9]{64}$/u),
    searchedSourceContentHashes: z.array(z.string().regex(/^[a-f0-9]{64}$/u)).max(100_000),
    comparedPairCount: z.number().int().nonnegative().max(5_000_000_000),
    relations: z
      .array(
        z
          .object({
            leftSourceContentHash: z.string().regex(/^[a-f0-9]{64}$/u),
            rightSourceContentHash: z.string().regex(/^[a-f0-9]{64}$/u),
            leftDescriptorHash: z.string().regex(/^[a-f0-9]{64}$/u),
            rightDescriptorHash: z.string().regex(/^[a-f0-9]{64}$/u),
            distanceBits: z.number().int().nonnegative(),
            totalBits: z.number().int().positive(),
          })
          .strict(),
      )
      .max(1_000_000),
    diagnostics: z.array(z.string().trim().min(1).max(2048)).max(100_000),
  })
  .strict();

async function main(): Promise<void> {
  const [command, subcommand, ...rest] = args;
  if (command === "semantics" && subcommand === "validate") return semanticsValidate();
  if (command === "semantics" && subcommand === "seal") return semanticsSeal(rest);
  if (command === "semantics" && subcommand === "explain") return semanticsExplain(rest);
  if (command === "catalog" && subcommand === "inventory") return catalogInventory(rest);
  if (command === "catalog" && subcommand === "calibration") return catalogCalibration(rest);
  if (command === "catalog" && subcommand === "providers") return catalogProviders();
  if (command === "catalog" && subcommand === "measure") return catalogMeasure(rest);
  if (command === "catalog" && subcommand === "render") return catalogRender(rest);
  if (command === "catalog" && subcommand === "pilot") return catalogPilot(rest);
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
  await requireSourceProvenance(manifest, options.get("--provenance"));
  const records = [];
  for (const asset of manifest.assets) {
    const bytes = await readBoundedWorkspaceBytes(
      repositoryRoot,
      asset.relativePath,
      512 * 1024 * 1024,
    );
    if (sha256(bytes) !== asset.contentHash)
      throw new Error(`Source hash changed: ${asset.relativePath}`);
    records.push({ sourceContentHash: asset.contentHash, bytes: bytes.byteLength });
  }
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
    paths: records.length,
    hash: inventory.hash,
  });
}

async function catalogCalibration(values: string[]): Promise<void> {
  const prepare = values[0] === "prepare";
  const options = parseOptions(prepare ? values.slice(1) : values);
  const semanticModule = await loadSemanticModule();
  const sourceManifest = TRUSTED_SOURCE_MANIFEST_SCHEMA.parse(
    await readJson(options.get("--source") ?? "registry/source-manifest.json"),
  );
  await requireSourceProvenance(sourceManifest, options.get("--provenance"));
  const rubric = CATALOG_ADMISSION_RUBRIC_SCHEMA.parse(
    await readJson(options.get("--rubric") ?? "registry/admission-rubric.json"),
  );
  if (rubric.semanticModuleHash !== semanticModule.snapshot.hash)
    throw new Error("Admission rubric does not bind the current semantic module");
  const groupingPolicy = CATALOG_LEAKAGE_GROUPING_POLICY_SCHEMA.parse(
    await readJson(options.get("--grouping-policy") ?? "registry/leakage-grouping-policy.json"),
  );
  const analysisPath = options.get("--analysis") ?? "registry/leakage-analysis.json";
  const splitPath = options.get("--split") ?? "registry/calibration-split.json";
  if (prepare) {
    const measurements = CATALOG_MEASUREMENT_SET_SCHEMA.parse(
      await readJson(options.get("--measurements") ?? ".basalt/catalog/measurements.json"),
    );
    const visualReview = CATALOG_VISUAL_REVIEW_INDEX_SCHEMA.parse(
      await readJson(options.get("--renders") ?? ".basalt/catalog/review/index.json"),
    );
    const nearDuplicateSearch = await runCatalogNearDuplicateSearch({
      sourceManifest,
      visualReview,
      groupingPolicy,
      outputPath: options.get("--near-duplicates") ?? "registry/near-duplicate-search.json",
      workerOutputPath:
        options.get("--near-duplicate-worker-output") ??
        ".basalt/catalog/near-duplicate-worker-output.json",
    });
    const analysis = analyzeCatalogLeakage({
      sourceManifest,
      measurements,
      groupingPolicy,
      nearDuplicateSearch,
    });
    const groups = buildCatalogLeakageGroups(sourceManifest, analysis, groupingPolicy);
    const targets = [
      { role: "calibration" as const, targetPermille: 200 },
      { role: "development" as const, targetPermille: 600 },
      { role: "evaluation" as const, targetPermille: 200 },
    ];
    const split = sealCatalogCalibrationSplit({
      sourceManifest,
      groupingPolicy,
      leakageAnalysis: analysis,
      assignments: assignCatalogCalibrationGroups(groups, targets),
      targets,
    });
    await writeCanonicalJson(analysisPath, analysis);
    await writeCanonicalJson(splitPath, split);
  }
  const nearDuplicateSearch = CATALOG_NEAR_DUPLICATE_SEARCH_SCHEMA.parse(
    await readJson(options.get("--near-duplicates") ?? "registry/near-duplicate-search.json"),
  );
  const analysis = CATALOG_LEAKAGE_ANALYSIS_SCHEMA.parse(await readJson(analysisPath));
  const split = CATALOG_CALIBRATION_SPLIT_SCHEMA.parse(await readJson(splitPath));
  if (
    analysis.nearDuplicateSearchHash !== nearDuplicateSearch.hash ||
    nearDuplicateSearch.sourceManifestHash !== contentHash(stableJson(sourceManifest)) ||
    stableJson(nearDuplicateSearch.similarityThreshold) !==
      stableJson(groupingPolicy.nearDuplicateSimilarity)
  )
    throw new Error("Leakage analysis does not bind the current near-duplicate search");
  const result = validateCatalogCalibrationSplit({
    split,
    sourceManifest,
    groupingPolicy,
    leakageAnalysis: analysis,
  });
  print({
    status: result.status,
    rubricHash: rubric.hash,
    groupingPolicyHash: groupingPolicy.hash,
    leakageAnalysisHash: analysis.hash,
    leakageAnalysisStatus: analysis.status,
    splitHash: split.hash,
    sourceIdentities: sourceManifest.assets.length,
    leakageGroups: split.groups.length,
    assignments: split.assignments.length,
    diagnostics: result.diagnostics,
  });
  if (result.status === "rejected") process.exitCode = 1;
}

async function runCatalogNearDuplicateSearch(input: {
  readonly sourceManifest: z.output<typeof TRUSTED_SOURCE_MANIFEST_SCHEMA>;
  readonly visualReview: z.output<typeof CATALOG_VISUAL_REVIEW_INDEX_SCHEMA>;
  readonly groupingPolicy: z.output<typeof CATALOG_LEAKAGE_GROUPING_POLICY_SCHEMA>;
  readonly outputPath: string;
  readonly workerOutputPath: string;
}) {
  const sourceManifestHash = contentHash(stableJson(input.sourceManifest));
  if (input.visualReview.sourceManifestHash !== sourceManifestHash)
    throw new Error("Visual evidence does not bind the canonical source manifest");
  const workerPath = absolute(CATALOG_NEAR_DUPLICATE_WORKER);
  const workerSourceHash = sha256(
    await readBoundedWorkspaceBytes(repositoryRoot, workerPath, 4 * 1024 * 1024),
  );
  const workerOutputPath = absolute(input.workerOutputPath);
  const jobPath = ".basalt/catalog/near-duplicate-job.json";
  const job = {
    kind: "CatalogNearDuplicateSearchJob",
    workspaceRoot: repositoryRoot,
    sourceManifestHash,
    visualReviewIndexHash: input.visualReview.hash,
    similarityThreshold: input.groupingPolicy.nearDuplicateSimilarity,
    outputPath: workerOutputPath,
    items: input.visualReview.items.map((item) => {
      const artifacts = new Map(item.viewArtifacts.map((view) => [view.viewId, view]));
      return {
        sourceContentHash: item.sourceContentHash,
        views: item.evidence.views.map((evidence) => {
          const artifact = artifacts.get(evidence.viewId);
          if (!artifact) throw new Error(`Missing rendered shape channel ${evidence.viewId}`);
          return {
            viewId: evidence.viewId,
            silhouettePath: absolute(artifact.silhouetteRelativePath),
            silhouetteHash: evidence.silhouetteHash,
            normalizedDepthPath: absolute(artifact.normalizedDepthRelativePath),
            normalizedDepthHash: evidence.normalizedDepthHash,
            surfaceNormalPath: absolute(artifact.surfaceNormalRelativePath),
            surfaceNormalHash: evidence.surfaceNormalHash,
          };
        }),
      };
    }),
  };
  await writeCanonicalJson(jobPath, job);
  const { stdout, stderr } = await execFile("python3", [workerPath, "--job", absolute(jobPath)], {
    cwd: repositoryRoot,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    maxBuffer: 1024 * 1024,
  });
  if (stderr) process.stderr.write(stderr);
  if (stdout) process.stderr.write(stdout);
  const output = CATALOG_NEAR_DUPLICATE_WORKER_OUTPUT_SCHEMA.parse(
    await readJson(input.workerOutputPath),
  );
  const denominator = input.groupingPolicy.nearDuplicateSimilarity.denominator;
  const numerator = input.groupingPolicy.nearDuplicateSimilarity.numerator;
  const relations = output.relations.map((relation) => {
    if (
      relation.leftSourceContentHash >= relation.rightSourceContentHash ||
      relation.distanceBits * denominator > relation.totalBits * (denominator - numerator)
    )
      throw new Error("Near-duplicate worker emitted a relation outside its sealed threshold");
    return {
      leftSourceContentHash: relation.leftSourceContentHash,
      rightSourceContentHash: relation.rightSourceContentHash,
      relationKind: "near_duplicate_shape" as const,
      evidenceHash: contentHash(
        stableJson({
          kind: "NearDuplicateShapeEvidence",
          implementationSourceHash: workerSourceHash,
          similarityThreshold: input.groupingPolicy.nearDuplicateSimilarity,
          ...relation,
        }),
      ),
    };
  });
  const renderedSources = new Set(input.visualReview.items.map((item) => item.sourceContentHash));
  const missingSources = input.sourceManifest.assets
    .map((asset) => asset.contentHash)
    .filter((hash) => !renderedSources.has(hash));
  const diagnostics = [
    ...output.diagnostics.map((message) => ({
      code: "near_duplicate_worker_diagnostic",
      message,
      gateStatus: "incomplete" as const,
      path: ["descriptorSetHash"],
      evidenceHashes: [output.descriptorSetHash],
    })),
    ...(input.visualReview.status === "eligible"
      ? []
      : [
          {
            code: "visual_evidence_incomplete",
            message: "Near-duplicate search requires complete canonical render evidence",
            gateStatus: "incomplete" as const,
            path: ["visualReviewIndexHash"],
            evidenceHashes: [input.visualReview.hash],
          },
        ]),
    ...(missingSources.length === 0
      ? []
      : [
          {
            code: "near_duplicate_sources_missing",
            message: `${missingSources.length} source identities lack render shape descriptors`,
            gateStatus: "incomplete" as const,
            path: ["searchedSourceContentHashes"],
            evidenceHashes: missingSources.slice(0, 256),
          },
        ]),
  ];
  const search = sealCatalogNearDuplicateSearch({
    sourceManifestHash,
    visualReviewIndexHash: input.visualReview.hash,
    implementationHash: contentHash(
      stableJson({
        algorithmId: output.algorithmId,
        workerSourceHash,
        runtime: output.runtime,
      }),
    ),
    descriptorSetHash: output.descriptorSetHash,
    similarityThreshold: input.groupingPolicy.nearDuplicateSimilarity,
    searchedSourceContentHashes: output.searchedSourceContentHashes,
    comparedPairCount: output.comparedPairCount,
    relations,
    diagnostics,
  });
  await writeCanonicalJson(input.outputPath, search);
  return CATALOG_NEAR_DUPLICATE_SEARCH_SCHEMA.parse(search);
}

async function catalogMeasure(values: string[]): Promise<void> {
  const options = parseOptions(values);
  const source = options.get("--source") ?? "registry/source-manifest.json";
  const output = options.get("--output") ?? ".basalt/catalog/measurements.json";
  const manifest = TRUSTED_SOURCE_MANIFEST_SCHEMA.parse(await readJson(source));
  await requireSourceProvenance(manifest, options.get("--provenance"));
  const assets = new Map<string, CatalogAssetArtifact>();
  const diagnostics: Array<{ sourceContentHash: string; reason: string }> = [];
  const tasks = manifest.assets
    .map((asset) => ({
      workspaceRoot: repositoryRoot,
      relativePath: asset.relativePath,
      source: {
        contentHash: asset.contentHash,
        rights: asset.rights,
        metersPerSourceUnit: asset.metersPerSourceUnit,
      },
    }))
    .sort((left, right) => compare(left.source.contentHash, right.source.contentHash))
    .map((entry, taskId) => ({ ...entry, taskId }));
  const requestedWorkers = requireLocalCatalogWorkerCount(
    Number(options.get("--workers") ?? Math.min(MAX_LOCAL_CATALOG_WORKERS, availableParallelism())),
  );
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
  if (workers !== undefined) requireLocalCatalogWorkerCount(Number(workers));
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

async function catalogPilot(values: string[]): Promise<void> {
  const requestedStage = values[0] && !values[0].startsWith("--") ? values[0] : "run";
  if (!["prepare", "infer", "evaluate", "run"].includes(requestedStage))
    throw new Error("catalog pilot stage must be prepare, infer, evaluate, or run");
  const options = parseOptions(
    requestedStage === "run" && values[0]?.startsWith("--") ? values : values.slice(1),
  );
  const outputRoot = options.get("--output-root") ?? ".basalt/catalog/pilot";
  const paths = {
    plan: `${outputRoot}/plan.json`,
    requests: `${outputRoot}/hypothesis-requests.json`,
    job: `${outputRoot}/worker-job.json`,
    workerOutput: `${outputRoot}/worker-output.json`,
    receipts: `${outputRoot}/hypothesis-receipts.json`,
    features: `${outputRoot}/features.json`,
    references: options.get("--references") ?? `${outputRoot}/reference-judgments.json`,
    calibrations: `${outputRoot}/calibrations.json`,
    predictions: `${outputRoot}/predictions.json`,
    substitutions: `${outputRoot}/substitution-proposals.json`,
    discovery: `${outputRoot}/discovery-review.json`,
    auditPlan: `${outputRoot}/acceptance-audit-plan.json`,
    qualification: `${outputRoot}/qualification.json`,
    report: `${outputRoot}/report.json`,
  };
  const policy = await loadAdmissionPolicy(options.get("--policy"));
  const rubric = CATALOG_ADMISSION_RUBRIC_SCHEMA.parse(
    await readJson(options.get("--rubric") ?? "registry/admission-rubric.json"),
  );
  const semanticModule = await loadSemanticModule();
  const lexicon = SEMANTIC_LEXICON_SNAPSHOT_SCHEMA.parse(
    await readJson(options.get("--lexicon") ?? "registry/semantics/lexicon.json"),
  );
  if (rubric.semanticModuleHash !== semanticModule.snapshot.hash)
    throw new Error("Admission rubric does not bind the current semantic module");
  const manifest = TRUSTED_SOURCE_MANIFEST_SCHEMA.parse(
    await readJson(options.get("--source") ?? "registry/source-manifest.json"),
  );
  await requireSourceProvenance(manifest, options.get("--provenance"));
  const measurements = CATALOG_MEASUREMENT_SET_SCHEMA.parse(
    await readJson(options.get("--measurements") ?? ".basalt/catalog/measurements.json"),
  );
  const visual = CATALOG_VISUAL_REVIEW_INDEX_SCHEMA.parse(
    await readJson(options.get("--renders") ?? ".basalt/catalog/review/index.json"),
  );
  const split = CATALOG_CALIBRATION_SPLIT_SCHEMA.parse(
    await readJson(options.get("--split") ?? "registry/calibration-split.json"),
  );
  const plan = buildCatalogQualificationPilotPlan({
    policy,
    rubricHash: rubric.hash,
    semanticModuleHash: semanticModule.snapshot.hash,
    semanticLexiconHash: lexicon.hash,
    measurements,
    visualReview: visual,
    calibrationSplit: split,
  });
  if (plan.status !== "eligible")
    throw new Error(`Qualification pilot cannot start: ${plan.diagnostics.join("; ")}`);
  const provenance = SOURCE_PROVENANCE_LEDGER_SCHEMA.parse(
    await readJson(options.get("--provenance") ?? "registry/source-provenance.json"),
  );
  const sourceNameHints = buildCatalogSourceNameHintSet({ sourceManifest: manifest, provenance });
  await writeCanonicalJson(`${outputRoot}/source-name-hints.json`, sourceNameHints);
  const requestSet = buildPilotRequestSet({
    plan,
    policy,
    semanticModule,
    lexicon,
    measurements,
    visual,
    sourceNameHints,
  });
  const job = buildPilotWorkerJob({
    plan,
    semanticModule,
    lexicon,
    visual,
    sourceNameHints,
    modelDeclarations: CATALOG_INFERENCE_MODEL_DECLARATIONS_SCHEMA.parse(
      await readJson(options.get("--models") ?? "registry/catalog-inference-models.json"),
    ),
    promptTemplateHash: requestSet.promptTemplateHash,
  });
  await writeCanonicalJson(paths.plan, plan);
  await writeCanonicalJson(paths.requests, requestSet);
  await writeCanonicalJson(paths.job, job);
  if (requestedStage === "prepare") {
    print({
      status: "eligible",
      stage: "prepared",
      groups: plan.groups.length,
      sources: plan.selectedSourceContentHashes.length,
      requests: requestSet.requests.length,
      output: absolute(outputRoot),
      planHash: plan.hash,
    });
    return;
  }

  const executor = options.get("--executor") ?? "modal";
  if (options.get("--smoke") === "true") {
    if (requestedStage !== "infer")
      throw new Error("catalog pilot --smoke is only valid with the infer stage");
    const { hash: _jobHash, ...fullJobMaterial } = job;
    const smokeMaterial = { ...fullJobMaterial, items: job.items.slice(0, 1) };
    const smokeJob = { ...smokeMaterial, hash: contentHash(stableJson(smokeMaterial)) };
    const smokeJobPath = `${outputRoot}/smoke-worker-job.json`;
    const smokeOutputPath = `${outputRoot}/smoke-worker-output.json`;
    await writeCanonicalJson(smokeJobPath, smokeJob);
    await executeCatalogPilotWorker(executor, smokeJobPath, smokeOutputPath);
    const smokeOutput = CATALOG_PILOT_WORKER_OUTPUT_SCHEMA.parse(await readJson(smokeOutputPath));
    if (smokeOutput.jobHash !== smokeJob.hash || smokeOutput.items.length !== 1)
      throw new Error("Catalog pilot smoke result does not bind its exact single-source job");
    print({
      status: "eligible",
      stage: "smoke_complete",
      executor: smokeOutput.execution.executor,
      accelerator: smokeOutput.execution.accelerator,
      elapsedMilliseconds: smokeOutput.execution.elapsedMilliseconds,
      peakResidentBytes: smokeOutput.execution.peakResidentBytes,
      resultHash: smokeOutput.resultHash,
    });
    return;
  }

  let workerOutput = await readOptionalJson(paths.workerOutput)
    .then((value) =>
      value === undefined ? undefined : CATALOG_PILOT_WORKER_OUTPUT_SCHEMA.parse(value),
    )
    .catch(() => undefined);
  const force = options.get("--force") === "true";
  if (requestedStage !== "evaluate" && (force || workerOutput?.jobHash !== job.hash)) {
    await executeCatalogPilotWorker(executor, paths.job, paths.workerOutput);
    workerOutput = CATALOG_PILOT_WORKER_OUTPUT_SCHEMA.parse(await readJson(paths.workerOutput));
  }
  if (!workerOutput || workerOutput.jobHash !== job.hash)
    throw new Error("No current pilot inference output exists; run `basalt catalog pilot infer`");
  const inference = materializeCatalogPilotInference({ plan, requests: requestSet, workerOutput });
  await writeCanonicalJson(paths.receipts, inference.receipts);
  await writeCanonicalJson(paths.features, inference.features);
  if (requestedStage === "infer") {
    print({
      status: inference.receipts.status,
      stage: "inferred",
      sources: workerOutput.items.length,
      receipts: inference.receipts.receipts.length,
      features: inference.features.receipts.length,
      elapsedMilliseconds: workerOutput.execution.elapsedMilliseconds,
      peakResidentBytes: workerOutput.execution.peakResidentBytes,
      output: absolute(outputRoot),
      resultHash: workerOutput.resultHash,
    });
    return;
  }

  const references = await loadOrCreatePilotReferences(paths.references, plan, rubric.hash);
  const calibrationIdentities = new Map(
    inference.receipts.receipts.map(
      (receipt) =>
        [
          `${receipt.adapterImplementationHash}:${receipt.modelImplementationHash}:${receipt.ablation}`,
          receipt,
        ] as const,
    ),
  );
  const calibrationReceipts = [...calibrationIdentities.values()].map((receipt) =>
    calibrateCatalogAdapter({
      policy,
      pilotPlanHash: plan.hash,
      requests: requestSet,
      receipts: inference.receipts,
      judgments: references,
      adapterImplementationHash: receipt.adapterImplementationHash,
      modelImplementationHash: receipt.modelImplementationHash,
      ablation: receipt.ablation,
    }),
  );
  const calibrations = sealCatalogAdapterCalibrationSet({
    policyHash: policy.hash,
    pilotPlanHash: plan.hash,
    requestSetHash: requestSet.hash,
    receiptSetHash: inference.receipts.hash,
    referenceJudgmentSetHash: references.hash,
    receipts: calibrationReceipts,
  });
  const predictions = buildCatalogCalibratedPredictionSet({
    policy,
    pilotPlanHash: plan.hash,
    requests: requestSet,
    receipts: inference.receipts,
    calibrations: calibrations.receipts,
    semanticModule,
  });
  const substitutions = buildCatalogSubstitutionProposalSet({
    policy,
    pilotPlanHash: plan.hash,
    predictions,
    features: inference.features,
    measurements,
  });
  const discovery = buildCatalogDiscoveryReviewPlan({
    pilotPlanHash: plan.hash,
    policy,
    rubric,
    predictions,
    features: inference.features,
    substitutions,
  });
  const assetPopulation = substitutions.proposals.flatMap((proposal) =>
    proposal.sourceContentHashes.map((subjectId) => ({ subjectKind: "asset" as const, subjectId })),
  );
  const pairPopulation = substitutions.compatibilityReceipts
    .filter((receipt) => receipt.outcome === "compatible")
    .map((receipt) => ({
      subjectKind: "pair" as const,
      subjectId: `${receipt.leftSourceContentHash}:${receipt.rightSourceContentHash}`,
    }));
  const populations = Object.fromEntries(
    policy.riskTargets.map((target) => [
      target.riskId,
      target.subjectKind === "asset" ? assetPopulation : pairPopulation,
    ]),
  );
  const auditPlan = buildCatalogAcceptanceAuditPlan({
    pilotPlanHash: plan.hash,
    policy,
    rubric,
    randomizationHash: CATALOG_PILOT_AUDIT_RANDOMIZATION_HASH,
    populations,
  });
  const auditReceipts = await readOptionalDirectoryJson(
    options.get("--audit-receipts") ?? "registry/acceptance-audits",
    CATALOG_ACCEPTANCE_AUDIT_RECEIPT_SCHEMA,
  );
  const qualification = buildCatalogQualificationReceipt({
    policy,
    pilotPlanHash: plan.hash,
    rubricHash: rubric.hash,
    receipts: inference.receipts,
    references,
    calibrations: calibrations.receipts,
    predictions,
    substitutions,
    auditPlan,
    auditReceipts,
  });
  const report = buildPilotReport({ plan, workerOutput, references, qualification });
  await Promise.all([
    writeCanonicalJson(paths.references, references),
    writeCanonicalJson(paths.calibrations, calibrations),
    writeCanonicalJson(paths.predictions, predictions),
    writeCanonicalJson(paths.substitutions, substitutions),
    writeCanonicalJson(paths.discovery, discovery),
    writeCanonicalJson(paths.auditPlan, auditPlan),
    writeCanonicalJson(paths.qualification, qualification),
    writeCanonicalJson(paths.report, report),
  ]);
  print({
    status: qualification.status,
    stage: "evaluated",
    groups: plan.groups.length,
    sources: plan.selectedSourceContentHashes.length,
    referenceJudgments: references.judgments.length,
    visualNameAgreementMillionths: report.visualNameAgreementMillionths,
    discoveryItems: discovery.items.length,
    qualificationDiagnostics: qualification.diagnostics,
    output: absolute(outputRoot),
    qualificationHash: qualification.hash,
  });
}

function buildPilotRequestSet(input: {
  readonly plan: z.output<typeof CATALOG_QUALIFICATION_PILOT_PLAN_SCHEMA>;
  readonly policy: z.output<typeof CATALOG_ADMISSION_POLICY_SCHEMA>;
  readonly semanticModule: SemanticModule;
  readonly lexicon: z.output<typeof SEMANTIC_LEXICON_SNAPSHOT_SCHEMA>;
  readonly measurements: z.output<typeof CATALOG_MEASUREMENT_SET_SCHEMA>;
  readonly visual: z.output<typeof CATALOG_VISUAL_REVIEW_INDEX_SCHEMA>;
  readonly sourceNameHints: z.output<typeof CATALOG_SOURCE_NAME_HINT_SET_SCHEMA>;
}) {
  const promptTemplateHash = contentHash(
    stableJson({
      template: "3d_asset_identity_with_definition_positive_and_counterexamples",
      semanticModuleHash: input.semanticModule.snapshot.hash,
      semanticLexiconHash: input.lexicon.hash,
    }),
  );
  const assets = new Map(
    input.measurements.assets.map((entry) => [entry.source.contentHash, entry]),
  );
  const renders = new Map(input.visual.items.map((entry) => [entry.sourceContentHash, entry]));
  const hints = new Map(
    input.sourceNameHints.items.map((entry) => [entry.sourceContentHash, entry]),
  );
  const requestedConceptIds = input.semanticModule.concepts
    .map((entry) => entry.conceptId)
    .sort(compare);
  const requests = input.plan.selectedSourceContentHashes.flatMap((sourceContentHash) => {
    const asset = assets.get(sourceContentHash);
    const render = renders.get(sourceContentHash);
    const hint = hints.get(sourceContentHash);
    if (!asset || !render || !hint)
      throw new Error(`Pilot source lacks exact evidence: ${sourceContentHash}`);
    return (["combined", "name_only", "visual_only"] as const).map((ablation) =>
      sealAssetSemanticHypothesisRequest({
        sourceContentHash,
        measurementHash: asset.hash,
        renderEvidenceHash: render.evidence.hash,
        sourceNameHintHash: hint.hash,
        semanticModuleHash: input.semanticModule.snapshot.hash,
        semanticLexiconHash: input.lexicon.hash,
        promptTemplateHash,
        evidenceSelection: {
          channels: ablation === "name_only" ? ["semantics"] : ["appearance", "semantics", "shape"],
          viewIds:
            ablation === "name_only" ? [] : CATALOG_REVIEW_VIEWPOINTS.map((entry) => entry.viewId),
          includeMeasurements: false,
          includeSourceNameHint: ablation !== "visual_only",
          selectorImplementationHash: CATALOG_PILOT_SELECTOR_HASH,
        },
        ablation,
        requestedAssertionKinds: input.policy.prediction.requiredAssertionKinds,
        requestedConceptIds,
      }),
    );
  });
  return sealCatalogHypothesisRequestSet({
    status: "eligible",
    measurementSetHash: input.measurements.hash,
    visualReviewIndexHash: input.visual.hash,
    sourceNameHintSetHash: input.sourceNameHints.hash,
    semanticModuleHash: input.semanticModule.snapshot.hash,
    semanticLexiconHash: input.lexicon.hash,
    promptTemplateHash,
    requests,
    diagnostics: [],
  });
}

function buildPilotWorkerJob(input: {
  readonly plan: z.output<typeof CATALOG_QUALIFICATION_PILOT_PLAN_SCHEMA>;
  readonly semanticModule: SemanticModule;
  readonly lexicon: z.output<typeof SEMANTIC_LEXICON_SNAPSHOT_SCHEMA>;
  readonly visual: z.output<typeof CATALOG_VISUAL_REVIEW_INDEX_SCHEMA>;
  readonly sourceNameHints: z.output<typeof CATALOG_SOURCE_NAME_HINT_SET_SCHEMA>;
  readonly modelDeclarations: z.output<typeof CATALOG_INFERENCE_MODEL_DECLARATIONS_SCHEMA>;
  readonly promptTemplateHash: string;
}) {
  const lexicon = new Map<string, (typeof input.lexicon.entries)[number]>(
    input.lexicon.entries.map(
      (entry) => [`${entry.subjectKind}:${entry.subjectId}`, entry] as const,
    ),
  );
  const prompt = (subjectKind: string, subjectId: string, definition: string) => {
    const entry = lexicon.get(`${subjectKind}:${subjectId}`);
    const label = entry?.preferredLabels.en ?? subjectId;
    const examples = entry?.examples.length ? ` Examples: ${entry.examples.join("; ")}.` : "";
    const counterexamples = entry?.counterexamples.length
      ? ` Not: ${entry.counterexamples.join("; ")}.`
      : "";
    return {
      label,
      labelTokens: normalizedLabelTokens(label),
      prompt: `A 3D asset whose primary identity is ${label}. ${definition}${examples}${counterexamples}`,
    };
  };
  const candidates: Array<{
    assertionKind: z.output<typeof CATALOG_FACET_VALUE_SCHEMA>["assertionKind"];
    valueKey: string;
    value: z.output<typeof CATALOG_FACET_VALUE_SCHEMA>;
    labelTokens: string[];
    prompt: string;
  }> = [];
  for (const concept of input.semanticModule.concepts) {
    const value = {
      assertionKind: "denotation" as const,
      concept: { conceptId: concept.conceptId, commitmentHash: concept.commitmentHash },
    };
    candidates.push({
      assertionKind: "denotation",
      valueKey: facetValueKey(value),
      value,
      ...prompt("concept", concept.conceptId, concept.normativeDefinition),
    });
  }
  for (const definition of input.semanticModule.realizationForms) {
    const value = {
      assertionKind: "realization_form" as const,
      realizationForm: definition.realizationForm,
    };
    candidates.push({
      assertionKind: "realization_form",
      valueKey: facetValueKey(value),
      value,
      ...prompt("realization_form", definition.realizationForm, definition.normativeDefinition),
    });
  }
  for (const definition of input.semanticModule.affordances) {
    const value = { assertionKind: "affordance" as const, affordanceId: definition.affordanceId };
    candidates.push({
      assertionKind: "affordance",
      valueKey: facetValueKey(value),
      value,
      ...prompt("affordance", definition.affordanceId, definition.normativeDefinition),
    });
  }
  for (const dimension of input.semanticModule.stateDimensions)
    for (const definition of dimension.values) {
      const value = {
        assertionKind: "state" as const,
        stateDimensionId: dimension.stateDimensionId,
        stateValueId: definition.stateValueId,
      };
      candidates.push({
        assertionKind: "state",
        valueKey: facetValueKey(value),
        value,
        ...prompt(
          "state_value",
          definition.stateValueId,
          `${dimension.normativeDefinition} ${definition.normativeDefinition}`,
        ),
      });
    }
  for (const definition of input.semanticModule.surfaceTreatments) {
    const value = {
      assertionKind: "surface_treatment" as const,
      surfaceTreatmentId: definition.surfaceTreatmentId,
    };
    candidates.push({
      assertionKind: "surface_treatment",
      valueKey: facetValueKey(value),
      value,
      ...prompt("surface_treatment", definition.surfaceTreatmentId, definition.normativeDefinition),
    });
  }
  candidates.sort((left, right) => compare(left.valueKey, right.valueKey));
  const renders = new Map(input.visual.items.map((entry) => [entry.sourceContentHash, entry]));
  const hints = new Map(
    input.sourceNameHints.items.map((entry) => [entry.sourceContentHash, entry]),
  );
  const items = input.plan.selectedSourceContentHashes.map((sourceContentHash) => {
    const render = renders.get(sourceContentHash);
    const hint = hints.get(sourceContentHash);
    if (!render || !hint)
      throw new Error(`Pilot source lacks worker evidence: ${sourceContentHash}`);
    const viewEvidence = new Map(render.evidence.views.map((view) => [view.viewId, view] as const));
    return {
      sourceContentHash,
      renderEvidenceHash: render.evidence.hash,
      sourceNames: hint.observations.map((entry) => entry.originalFilename).sort(compare),
      views: render.viewArtifacts.map((view) => {
        const evidence = viewEvidence.get(view.viewId);
        if (!evidence) throw new Error(`Pilot render lacks evidence for ${view.viewId}`);
        return {
          viewId: view.viewId,
          rgbRelativePath: view.rgbRelativePath,
          rgbHash: evidence.rgbHash,
          normalizedDepthRelativePath: view.normalizedDepthRelativePath,
          normalizedDepthHash: evidence.normalizedDepthHash,
        };
      }),
    };
  });
  const material = {
    kind: "CatalogPilotWorkerJob" as const,
    pilotPlanHash: input.plan.hash,
    promptTemplateHash: input.promptTemplateHash,
    normalizerImplementationHash: CATALOG_PILOT_NORMALIZER_HASH,
    models: input.modelDeclarations.models,
    candidates,
    items,
  };
  return { ...material, hash: contentHash(stableJson(material)) };
}

async function loadOrCreatePilotReferences(
  path: string,
  plan: z.output<typeof CATALOG_QUALIFICATION_PILOT_PLAN_SCHEMA>,
  rubricHash: string,
) {
  const existing = await readOptionalJson(path);
  if (existing !== undefined) {
    const parsed = CATALOG_REFERENCE_JUDGMENT_SET_SCHEMA.parse(existing);
    if (parsed.pilotPlanHash !== plan.hash || parsed.rubricHash !== rubricHash)
      throw new Error("Reference judgments bind another pilot plan or rubric");
    return parsed;
  }
  return sealCatalogReferenceJudgmentSet({
    pilotPlanHash: plan.hash,
    rubricHash,
    referenceAuthority: "human_curator",
    reviewerId: "unassigned_curator",
    judgments: [],
    missingSourceContentHashes: plan.selectedSourceContentHashes,
    diagnostics: ["The locked pilot requires independent human-curator judgments"],
  });
}

function buildPilotReport(input: {
  readonly plan: z.output<typeof CATALOG_QUALIFICATION_PILOT_PLAN_SCHEMA>;
  readonly workerOutput: z.output<typeof CATALOG_PILOT_WORKER_OUTPUT_SCHEMA>;
  readonly references: z.output<typeof CATALOG_REFERENCE_JUDGMENT_SET_SCHEMA>;
  readonly qualification: z.output<typeof CATALOG_QUALIFICATION_RECEIPT_SCHEMA>;
}) {
  let compared = 0;
  let agreement = 0;
  const topConceptCounts = new Map<string, number>();
  for (const item of input.workerOutput.items) {
    const name = topDenotation(item.hypotheses.find((entry) => entry.evidenceSource === "name"));
    const visual = topDenotation(
      item.hypotheses.find((entry) => entry.evidenceSource === "visual"),
    );
    if (visual) topConceptCounts.set(visual, (topConceptCounts.get(visual) ?? 0) + 1);
    if (name && visual) {
      compared += 1;
      if (name === visual) agreement += 1;
    }
  }
  const material = {
    kind: "CatalogQualificationPilotReport" as const,
    status: input.qualification.status,
    pilotPlanHash: input.plan.hash,
    workerResultHash: input.workerOutput.resultHash,
    qualificationHash: input.qualification.hash,
    groupCount: input.plan.groups.length,
    sourceCount: input.plan.selectedSourceContentHashes.length,
    humanReferenceCount: input.references.judgments.length,
    visualNameComparedCount: compared,
    visualNameAgreementMillionths:
      compared === 0 ? 0 : Math.round((agreement / compared) * 1_000_000),
    topVisualDenotations: [...topConceptCounts.entries()]
      .sort((left, right) => right[1] - left[1] || compare(left[0], right[0]))
      .slice(0, 20)
      .map(([conceptId, count]) => ({ conceptId, count })),
    execution: input.workerOutput.execution,
    diagnostics: input.qualification.diagnostics,
  };
  return { ...material, hash: contentHash(stableJson(material)) };
}

function topDenotation(
  hypothesis:
    | z.output<typeof CATALOG_PILOT_WORKER_OUTPUT_SCHEMA>["items"][number]["hypotheses"][number]
    | undefined,
): string | undefined {
  if (!hypothesis) return undefined;
  const candidates = hypothesis.facetScores
    .filter((entry) => entry.value.assertionKind === "denotation")
    .sort(
      (left, right) =>
        right.scoreMillionths - left.scoreMillionths ||
        compare(facetValueKey(left.value), facetValueKey(right.value)),
    );
  const value = candidates[0]?.value;
  return value?.assertionKind === "denotation" ? value.concept.conceptId : undefined;
}

function normalizedLabelTokens(value: string): string[] {
  return [
    ...new Set(
      value
        .toLowerCase()
        .replace(/[^a-z0-9]+/gu, " ")
        .trim()
        .split(/\s+/u)
        .filter(Boolean),
    ),
  ].sort(compare);
}

function runStreaming(
  command: string,
  values: readonly string[],
  environment: Readonly<Record<string, string>> = {},
): Promise<void> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawnChild(command, [...values], {
      cwd: repositoryRoot,
      env: { ...process.env, ...environment, PYTHONDONTWRITEBYTECODE: "1" },
      stdio: "inherit",
    });
    child.once("error", rejectRun);
    child.once("exit", (code) =>
      code === 0 ? resolveRun() : rejectRun(new Error(`${command} exited with status ${code}`)),
    );
  });
}

async function executeCatalogPilotWorker(
  executor: string,
  jobPath: string,
  outputPath: string,
): Promise<void> {
  if (executor === "modal") {
    await runStreaming(
      "modal",
      [
        "run",
        "--quiet",
        "workers/catalog-admission/modal_app.py",
        "--job",
        jobPath,
        "--output",
        outputPath,
      ],
      await catalogExecutionEnvironment(),
    );
    return;
  }
  if (executor === "local") {
    await runStreaming(
      "python3",
      [CATALOG_PILOT_WORKER, "--job", jobPath, "--output", outputPath],
      { ...(await catalogExecutionEnvironment()), BASALT_EXECUTION_ADAPTER: "local" },
    );
    return;
  }
  throw new Error("catalog pilot --executor must be modal or local");
}

async function catalogExecutionEnvironment(): Promise<Record<string, string>> {
  const required = ["HUGGINGFACE_TOKEN", "MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET"] as const;
  const parsed = new Map<string, string>();
  const bytes = await readBoundedWorkspaceBytes(
    repositoryRoot,
    absolute(".env"),
    1024 * 1024,
  ).catch(() => undefined);
  if (bytes)
    for (const line of Buffer.from(bytes).toString("utf8").split(/\r?\n/u)) {
      const match = /^(?:export\s+)?([A-Z][A-Z0-9_]*)=(.*)$/u.exec(line.trim());
      if (!match) continue;
      let value = match[2]!.trim();
      if (
        value.length >= 2 &&
        ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'")))
      )
        value = value.slice(1, -1);
      parsed.set(match[1]!, value);
    }
  const environment: Record<string, string> = {};
  for (const key of required) {
    const value = process.env[key] ?? parsed.get(key);
    if (!value) throw new Error(`Catalog pilot execution credential ${key} is not configured`);
    environment[key] = value;
  }
  environment.HF_TOKEN = environment.HUGGINGFACE_TOKEN!;
  environment.BASALT_EXECUTION_ADAPTER = "modal";
  environment.BASALT_GPU_KIND = "L40S";
  return environment;
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
  readonly qualificationReceipts: z.output<typeof CATALOG_QUALIFICATION_RECEIPT_SCHEMA>[];
}

async function requireSourceProvenance(
  manifest: z.output<typeof TRUSTED_SOURCE_MANIFEST_SCHEMA>,
  path = "registry/source-provenance.json",
): Promise<void> {
  const provenance = SOURCE_PROVENANCE_LEDGER_SCHEMA.parse(await readJson(path));
  const result = validateSourceAuthority({ manifest, provenance });
  if (result.status !== "eligible")
    throw new Error(`Source authority is ${result.status}: ${stableJson(result.diagnostics)}`);
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
  await requireSourceProvenance(manifest, options.get("--provenance"));
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
  const qualificationReceipts = await readOptionalDirectoryJson(
    options.get("--qualifications") ?? "registry/qualifications",
    CATALOG_QUALIFICATION_RECEIPT_SCHEMA,
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
    qualificationReceipts,
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
    sourceContentHashes: authority.manifest.assets.map((asset) => asset.contentHash),
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
    qualificationReceipts: authority.qualificationReceipts,
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
      path: options.get("--pilot-plan") ?? ".basalt/catalog/pilot/plan.json",
      schema: CATALOG_QUALIFICATION_PILOT_PLAN_SCHEMA,
    },
    {
      path: options.get("--requests") ?? ".basalt/catalog/pilot/hypothesis-requests.json",
      schema: CATALOG_HYPOTHESIS_REQUEST_SET_SCHEMA,
    },
    {
      path: options.get("--name-hints") ?? ".basalt/catalog/pilot/source-name-hints.json",
      schema: CATALOG_SOURCE_NAME_HINT_SET_SCHEMA,
    },
    {
      path: options.get("--receipts") ?? ".basalt/catalog/pilot/hypothesis-receipts.json",
      schema: CATALOG_HYPOTHESIS_RECEIPT_SET_SCHEMA,
    },
    {
      path: options.get("--features") ?? ".basalt/catalog/pilot/features.json",
      schema: CATALOG_FEATURE_SET_SCHEMA,
    },
    {
      path: options.get("--references") ?? ".basalt/catalog/pilot/reference-judgments.json",
      schema: CATALOG_REFERENCE_JUDGMENT_SET_SCHEMA,
    },
    {
      path: options.get("--calibrations") ?? ".basalt/catalog/pilot/calibrations.json",
      schema: CATALOG_ADAPTER_CALIBRATION_SET_SCHEMA,
    },
    {
      path: options.get("--predictions") ?? ".basalt/catalog/pilot/predictions.json",
      schema: CATALOG_CALIBRATED_PREDICTION_SET_SCHEMA,
    },
    {
      path: options.get("--substitutions") ?? ".basalt/catalog/pilot/substitution-proposals.json",
      schema: CATALOG_SUBSTITUTION_PROPOSAL_SET_SCHEMA,
    },
    {
      path: options.get("--discovery") ?? ".basalt/catalog/pilot/discovery-review.json",
      schema: CATALOG_DISCOVERY_REVIEW_PLAN_SCHEMA,
    },
    {
      path: options.get("--audit-plan") ?? ".basalt/catalog/pilot/acceptance-audit-plan.json",
      schema: CATALOG_ACCEPTANCE_AUDIT_PLAN_SCHEMA,
    },
    {
      path: options.get("--qualification") ?? ".basalt/catalog/pilot/qualification.json",
      schema: CATALOG_QUALIFICATION_RECEIPT_SCHEMA,
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
    qualificationReceipts: authority.qualificationReceipts,
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
      "  basalt catalog inventory|calibration|providers|measure|render",
      "  basalt catalog pilot prepare|infer|evaluate|run",
      "  basalt catalog validate|seal|commit",
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
