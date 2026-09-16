import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { lstat, mkdir, readdir, unlink } from "node:fs/promises";
import { availableParallelism, homedir } from "node:os";
import { basename, join, resolve } from "node:path";
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
  CATALOG_ADMISSION_RUBRIC_SCHEMA,
  CATALOG_ADMISSION_POLICY_SCHEMA,
  CATALOG_ACCEPTANCE_AUDIT_SCHEMA,
  CATALOG_CREATOR_REVIEW_DECISION_SCHEMA,
  CATALOG_CREATOR_REVIEW_PACKET_SCHEMA,
  CATALOG_CALIBRATION_SPLIT_SCHEMA,
  CATALOG_AUTHORITY_COMMIT_SCHEMA,
  CATALOG_LEAKAGE_ANALYSIS_SCHEMA,
  CATALOG_LEAKAGE_GROUPING_POLICY_SCHEMA,
  CATALOG_NEAR_DUPLICATE_SEARCH_SCHEMA,
  CATALOG_VISUAL_REVIEW_INDEX_SCHEMA,
  MAX_LOCAL_CATALOG_WORKERS,
  requireLocalCatalogWorkerCount,
  analyzeCatalogLeakage,
  assignCatalogCalibrationGroups,
  buildCatalogLeakageGroups,
  sealCatalogAuthorityCommit,
  sealCatalogCalibrationSplit,
  sealCatalogNearDuplicateSearch,
  sourceFilenameObservationsIdentifyCollisionCompanion,
  validateCatalogCalibrationSplit,
  type RetainedCatalogEvidence,
  type CatalogAcceptanceAudit,
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
  ROBLOX_IMPORT_REPORT_PATH,
  createRobloxImportManifest,
  installRobloxCredential,
  readRobloxCredential,
} from "@basalt/roblox";
import type { CatalogMeasureTask } from "./catalog-measure-worker.js";
import { runCatalogMetadataCommand } from "./catalog-metadata.js";
import { runCatalogIndexCommand, runCatalogSearchCommand } from "./catalog-search.js";
import { runCatalogContextCommand } from "./catalog-context.js";
import { runCatalogQualifyCommand } from "./catalog-qualify.js";

const repositoryRoot = resolve(".");
const args = process.argv.slice(2);
const execFile = promisify(execFileCallback);
const CATALOG_COMMIT_LOCK_PATH = ".basalt/locks/catalog-commit.lock";
const CATALOG_NEAR_DUPLICATE_WORKER = "workers/catalog-review/near_duplicate.py";

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
  if (command === "catalog" && subcommand === "metadata")
    return runCatalogMetadataCommand(rest, catalogMetadataContext());
  if (command === "catalog" && subcommand === "index")
    return runCatalogIndexCommand(rest, catalogMetadataContext());
  if (command === "catalog" && subcommand === "search")
    return runCatalogSearchCommand(rest, catalogMetadataContext());
  if (command === "catalog" && subcommand === "context")
    return runCatalogContextCommand(rest, catalogMetadataContext());
  if (command === "catalog" && subcommand === "qualify")
    return runCatalogQualifyCommand(rest, catalogMetadataContext());
  if (command === "catalog" && subcommand === "commit") return catalogCommit(rest);
  if (command === "catalog" && subcommand === "validate") return catalogValidate(rest);
  if (command === "catalog" && subcommand === "seal") return catalogSeal(rest);
  if (command === "world" && subcommand === "compile") return worldCompile(rest);
  if (command === "roblox" && subcommand === "install-plugin") return robloxInstallPlugin();
  if (command === "roblox" && subcommand === "import") return robloxImport(rest);
  if (command === undefined || command === "help" || command === "--help") return usage();
  failUsage(`Unknown command: ${[command, subcommand].filter(Boolean).join(" ")}`);
}

function catalogMetadataContext() {
  return {
    root: repositoryRoot,
    readJson,
    readOptionalJson,
    writeJson: writeCanonicalJson,
    print,
  };
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
      measurements,
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
  readonly measurements: z.output<typeof CATALOG_MEASUREMENT_SET_SCHEMA>;
  readonly visualReview: z.output<typeof CATALOG_VISUAL_REVIEW_INDEX_SCHEMA>;
  readonly groupingPolicy: z.output<typeof CATALOG_LEAKAGE_GROUPING_POLICY_SCHEMA>;
  readonly outputPath: string;
  readonly workerOutputPath: string;
}) {
  const sourceManifestHash = contentHash(stableJson(input.sourceManifest));
  if (input.measurements.sourceManifestHash !== sourceManifestHash)
    throw new Error("Measurements do not bind the canonical source manifest");
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
  const collisionOnlySources = new Set(
    input.measurements.assets
      .filter(
        (asset) =>
          asset.parts.length > 0 && asset.parts.every((part) => part.role === "collision_proxy"),
      )
      .map((asset) => asset.source.contentHash),
  );
  const expectedAppearanceSources = new Set(
    input.sourceManifest.assets
      .map((asset) => asset.contentHash)
      .filter((hash) => !collisionOnlySources.has(hash)),
  );
  const searchedSources = new Set(output.searchedSourceContentHashes);
  const renderedSources = new Set(input.visualReview.items.map((item) => item.sourceContentHash));
  const missingSources = [...expectedAppearanceSources].filter(
    (hash) => !searchedSources.has(hash),
  );
  const unexpectedSources = output.searchedSourceContentHashes.filter(
    (hash) => !expectedAppearanceSources.has(hash),
  );
  const missingRenderedSources = [...expectedAppearanceSources].filter(
    (hash) => !renderedSources.has(hash),
  );
  const unexpectedRenderedSources = input.visualReview.items
    .map((item) => item.sourceContentHash)
    .filter((hash) => !expectedAppearanceSources.has(hash));
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
    ...(missingRenderedSources.length === 0 && unexpectedRenderedSources.length === 0
      ? []
      : [
          {
            code: "appearance_render_coverage_mismatch",
            message: `Appearance evidence is missing ${missingRenderedSources.length} renderable sources and includes ${unexpectedRenderedSources.length} collision-only or unknown sources`,
            gateStatus: "rejected" as const,
            path: ["visualReviewIndexHash"],
            evidenceHashes: [...missingRenderedSources, ...unexpectedRenderedSources].slice(0, 256),
          },
        ]),
    ...(missingSources.length === 0
      ? []
      : [
          {
            code: "near_duplicate_sources_missing",
            message: `${missingSources.length} renderable source identities lack shape descriptors`,
            gateStatus: "incomplete" as const,
            path: ["searchedSourceContentHashes"],
            evidenceHashes: missingSources.slice(0, 256),
          },
        ]),
    ...(unexpectedSources.length === 0
      ? []
      : [
          {
            code: "near_duplicate_unexpected_sources",
            message: `${unexpectedSources.length} collision-only or unknown sources received appearance shape descriptors`,
            gateStatus: "rejected" as const,
            path: ["searchedSourceContentHashes"],
            evidenceHashes: unexpectedSources.slice(0, 256),
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
  const provenance = await requireSourceProvenance(manifest, options.get("--provenance"));
  const filenamesBySource = new Map<string, string[]>();
  for (const record of provenance.records)
    filenamesBySource.set(record.sourceContentHash, [
      ...(filenamesBySource.get(record.sourceContentHash) ?? []),
      basename(record.originalPath),
    ]);
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
        sourcePurpose: sourceFilenameObservationsIdentifyCollisionCompanion(
          filenamesBySource.get(asset.contentHash) ?? [],
        )
          ? ("collision_companion" as const)
          : ("renderable" as const),
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
  print({
    status: bridge.state,
    worldBuildHash: worldBuild.worldBuildHash,
    diagnostics: bridge.diagnostics,
    report: resolve(repositoryRoot, ROBLOX_IMPORT_REPORT_PATH),
  });
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
  readonly acceptanceAudits: CatalogAcceptanceAudit[];
  readonly admissionPolicy: z.output<typeof CATALOG_ADMISSION_POLICY_SCHEMA>;
}

async function requireSourceProvenance(
  manifest: z.output<typeof TRUSTED_SOURCE_MANIFEST_SCHEMA>,
  path = "registry/source-provenance.json",
): Promise<z.output<typeof SOURCE_PROVENANCE_LEDGER_SCHEMA>> {
  const provenance = SOURCE_PROVENANCE_LEDGER_SCHEMA.parse(await readJson(path));
  const result = validateSourceAuthority({ manifest, provenance });
  if (result.status !== "eligible")
    throw new Error(`Source authority is ${result.status}: ${stableJson(result.diagnostics)}`);
  return provenance;
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
  const acceptanceAudits = await readDirectoryJson(
    options.get("--acceptance-audits") ?? "registry/acceptance-audits",
    CATALOG_ACCEPTANCE_AUDIT_SCHEMA,
  );
  const admissionPolicy = await loadAdmissionPolicy(options.get("--policy"));
  return {
    semanticModule,
    semanticLexiconHash: lexicon.hash,
    manifest,
    measurements,
    styleDeclarations,
    entryDeclarations,
    dispositions,
    assertions,
    acceptanceAudits,
    admissionPolicy,
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
  const retainedEvidence = await retainCatalogEvidence(options, authority.acceptanceAudits);
  const commit = sealCatalogAuthorityCommit({
    sourceManifest: authority.manifest,
    semanticModuleHash: authority.semanticModule.snapshot.hash,
    semanticLexiconHash: authority.semanticLexiconHash,
    measurementSetHash: authority.measurements.hash,
    snapshot,
    styleProfiles: authority.styleDeclarations,
    declarations: authority.entryDeclarations,
    assertions: authority.assertions,
    acceptanceAudits: authority.acceptanceAudits,
    dispositions: authority.dispositions,
    admissionPolicy: authority.admissionPolicy,
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
  acceptanceAudits: readonly CatalogAcceptanceAudit[],
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
  const reviewedArtifacts = [
    ...new Set(
      acceptanceAudits.flatMap((audit) => [audit.reviewPacketHash, audit.reviewDecisionHash]),
    ),
  ].sort(compare);
  for (const artifactHash of reviewedArtifacts) {
    const relativePath = `registry/evidence/${artifactHash}.json`;
    const raw = (await readJson(relativePath)) as { readonly kind?: unknown };
    const artifact =
      raw?.kind === "CatalogCreatorReviewPacket"
        ? CATALOG_CREATOR_REVIEW_PACKET_SCHEMA.parse(raw)
        : raw?.kind === "CatalogCreatorReviewDecision"
          ? CATALOG_CREATOR_REVIEW_DECISION_SCHEMA.parse(raw)
          : undefined;
    if (!artifact || artifact.hash !== artifactHash)
      throw new Error(`Acceptance audit references invalid retained evidence ${artifactHash}`);
    const bytes = await readBoundedWorkspaceBytes(
      repositoryRoot,
      absolute(relativePath),
      512 * 1024 * 1024,
    );
    retained.push({
      kind: artifact.kind,
      relativePath,
      artifactHash,
      bytesHash: sha256(bytes),
      bytes: bytes.byteLength,
    });
  }
  if (new Set(retained.map((entry) => entry.relativePath)).size !== retained.length)
    throw new Error("Catalog retained evidence paths must be unique");
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
    acceptanceAudits: authority.acceptanceAudits,
    dispositions: authority.dispositions,
    admissionPolicy: authority.admissionPolicy,
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
      "  basalt catalog metadata prepare|generate|import-descriptions|ingest|commit",
      "  basalt catalog index",
      "  basalt catalog search <query>",
      "  basalt catalog context prepare|generate|review",
      "  basalt catalog qualify prepare|pool|validate|run|evaluate",
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
