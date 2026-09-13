import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { planCatalogFulfillment, sealAssetFactoryRequest } from "@basalt/asset-factory";
import {
  resolveCatalogRequirements,
  sealStyleProfile,
  type CatalogRequirement,
} from "@basalt/catalog-model";
import { contentHash, quantizeQ32_32, stableJson } from "@basalt/contracts";
import {
  RESTORED_NEURAL_PROVIDERS,
  claimNeuralExecutionBudget,
  createNeuralAssetBatch,
  sealNeuralExecutionBudget,
  sealNeuralInputReference,
  sealNeuralProviderDeclaration,
  sealNeuralWorkerQualification,
  sealTrellis2RuntimeQualification,
  sealTrellis2WorkerReference,
  sealTrellis2WorkerRequest,
} from "@basalt/neural-asset";
import { createSemanticDependencyClosure } from "@basalt/semantic-kernel";
import { catalogFixture } from "./helpers/catalog-fixture.js";
import { loadSemanticRegistry } from "./helpers/semantic-registry.js";

const hash = (value: string) => contentHash(value);
const meters = (value: number) => quantizeQ32_32(value);
const expectedBoundsMeters = { x: meters(2), y: meters(3), z: meters(2) };
const execFile = promisify(execFileCallback);

test("catalog fulfillment reuses an exact coherent binding", async () => {
  const module = await loadSemanticRegistry();
  const fixture = await catalogFixture(module);
  const resolution = resolveCatalogRequirements({
    semanticModule: module,
    snapshot: fixture.snapshot,
    requirements: [fixture.requirement],
  });
  const result = planCatalogFulfillment({
    requirement: fixture.requirement,
    resolution,
    snapshot: fixture.snapshot,
    styleProfile: fixture.styleProfile,
    targetEntryHandle: "tree_whole_ground",
    referenceImageArtifactHash: hash("tree-reference"),
    expectedBoundsMeters,
    desiredMemberCount: 3,
  });
  assert.equal(result.status, "eligible");
  if (result.status !== "eligible") return;
  assert.equal(result.value.outcome.strategy, "reuse_binding");
});

test("a style-only rejection becomes a material-restyling plan", async () => {
  const module = await loadSemanticRegistry();
  const fixture = await catalogFixture(module);
  const { kind: _kind, hash: _hash, ...neutral } = fixture.styleProfile;
  const stylized = sealStyleProfile({ ...neutral, handle: "stylized_low_poly" });
  const requirement: CatalogRequirement = {
    ...fixture.requirement,
    styleProfileHandles: [stylized.handle],
  };
  const resolution = resolveCatalogRequirements({
    semanticModule: module,
    snapshot: fixture.snapshot,
    requirements: [requirement],
  });
  const result = planCatalogFulfillment({
    requirement,
    resolution,
    snapshot: fixture.snapshot,
    styleProfile: stylized,
    targetEntryHandle: "tree_whole_ground_stylized",
    referenceImageArtifactHash: hash("stylized-reference"),
    expectedBoundsMeters,
    desiredMemberCount: 3,
  });
  assert.equal(result.status, "eligible");
  if (result.status !== "eligible") return;
  assert.equal(result.value.outcome.strategy, "restyle_asset");
  if (result.value.outcome.strategy !== "restyle_asset") return;
  const restyleJob = result.value.outcome.jobs.find((job) => job.operation === "restyle_materials");
  assert.equal(restyleJob?.sourceAssetHash, fixture.asset.hash);
  assert.equal(result.value.outcome.jobs.length, 3);
  assert.equal(
    result.value.outcome.jobs.filter((job) => job.operation === "generate_geometry_and_materials")
      .length,
    2,
  );
});

test("an absent semantic match synthesizes a new substitution set", async () => {
  const module = await loadSemanticRegistry();
  const fixture = await catalogFixture(module);
  const concept = module.concepts.find((entry) => entry.conceptId === "bsc_000050")!;
  const closure = createSemanticDependencyClosure({
    module,
    conceptIds: [concept.conceptId],
    definitionIds: ["whole"],
  });
  const requirement: CatalogRequirement = {
    ...fixture.requirement,
    requirementId: "Benches",
    semantic: {
      ...fixture.requirement.semantic,
      denotation: {
        conceptId: concept.conceptId,
        commitmentHash: concept.commitmentHash,
        matchMode: "exact",
      },
      dependencyClosureHash: closure.hash,
    },
  };
  const resolution = resolveCatalogRequirements({
    semanticModule: module,
    snapshot: fixture.snapshot,
    requirements: [requirement],
  });
  const result = planCatalogFulfillment({
    requirement,
    resolution,
    snapshot: fixture.snapshot,
    styleProfile: fixture.styleProfile,
    targetEntryHandle: "bench_whole_ground",
    referenceImageArtifactHash: hash("bench-reference"),
    expectedBoundsMeters,
    desiredMemberCount: 3,
  });
  assert.equal(result.status, "eligible");
  if (result.status !== "eligible") return;
  assert.equal(result.value.outcome.strategy, "synthesize_substitution_set");
  if (result.value.outcome.strategy !== "synthesize_substitution_set") return;
  assert.equal(result.value.outcome.jobs.length, 3);
  assert.equal(new Set(result.value.outcome.jobs.map((job) => job.seed)).size, 3);
});

test("restored providers remain fail-closed until requalified", () => {
  assert.deepEqual(
    RESTORED_NEURAL_PROVIDERS.map((provider) => provider.providerId),
    ["trellis2", "hunyuan3d_2_1", "pixal3d"],
  );
  assert.ok(RESTORED_NEURAL_PROVIDERS.every((provider) => provider.status === "incomplete"));
});

test("qualified providers receive exact factory jobs and paid runs are claimed once", async () => {
  const module = await loadSemanticRegistry();
  const fixture = await catalogFixture(module);
  const concept = module.concepts.find((entry) => entry.conceptId === "bsc_000050")!;
  const closure = createSemanticDependencyClosure({
    module,
    conceptIds: [concept.conceptId],
    definitionIds: ["whole"],
  });
  const requirement: CatalogRequirement = {
    ...fixture.requirement,
    requirementId: "Benches",
    semantic: {
      ...fixture.requirement.semantic,
      denotation: {
        conceptId: concept.conceptId,
        commitmentHash: concept.commitmentHash,
        matchMode: "exact",
      },
      dependencyClosureHash: closure.hash,
    },
  };
  const resolution = resolveCatalogRequirements({
    semanticModule: module,
    snapshot: fixture.snapshot,
    requirements: [requirement],
  });
  const planned = planCatalogFulfillment({
    requirement,
    resolution,
    snapshot: fixture.snapshot,
    styleProfile: fixture.styleProfile,
    targetEntryHandle: "bench_whole_ground",
    referenceImageArtifactHash: hash("bench-reference"),
    expectedBoundsMeters,
    desiredMemberCount: 1,
  });
  assert.equal(planned.status, "eligible");
  if (planned.status !== "eligible" || planned.value.outcome.strategy === "reuse_binding") return;
  const job = planned.value.outcome.jobs[0]!;
  const factoryRequest = sealAssetFactoryRequest({
    fulfillmentPlanHash: planned.value.hash,
    job,
    requirement,
    styleProfile: fixture.styleProfile,
    measurableConstraints: {
      maximumTriangles: requirement.budget.maximumTriangles,
      maximumSourceBytes: requirement.budget.maximumSourceBytes,
      outputMediaType: "model/gltf-binary",
      requireSupportEvidence: true,
      requireCollisionEvidence: true,
      requiredSocketCount: 0,
    },
  });
  const restored = RESTORED_NEURAL_PROVIDERS[0]!;
  const {
    kind: _kind,
    hash: _providerHash,
    status: _status,
    diagnostics: _diagnostics,
    ...base
  } = restored;
  const provider = sealNeuralProviderDeclaration({ ...base, status: "eligible", diagnostics: [] });
  const qualification = sealNeuralWorkerQualification({
    providerId: provider.providerId,
    providerDeclarationHash: provider.hash,
    workerImplementationHash: hash("worker"),
    runtimeEnvironmentHash: hash("runtime"),
    sourceCommitHash: provider.sourceCommitHash,
    modelRevisionHash: provider.modelRevisionHash,
    hardwareEvidenceHash: hash("hardware"),
    dependencyInventoryHash: hash("dependencies"),
    rightsEvidenceHash: hash("rights"),
    status: "eligible",
    diagnostics: [],
  });
  const reference = sealNeuralInputReference({
    origin: "generated_isolated",
    artifact: {
      artifactHash: job.referenceImageArtifactHash,
      bytes: 1024,
      mediaType: "image/png",
    },
    rightsEvidenceHash: hash("reference-rights"),
    preparationEvidenceHashes: [hash("alpha")],
  });
  const batch = createNeuralAssetBatch({
    fulfillmentPlan: planned.value,
    factoryRequests: [factoryRequest],
    references: new Map([[reference.artifact.artifactHash, reference]]),
    providers: [{ declaration: provider, qualification }],
    providerPreference: ["trellis2", "hunyuan3d_2_1", "pixal3d"],
  });
  assert.equal(batch.status, "eligible");
  if (batch.status !== "eligible") return;
  assert.equal(batch.value.requests[0]?.providerId, "trellis2");
  assert.equal(batch.value.requests[0]?.factoryRequest.hash, factoryRequest.hash);

  const runtimeQualification = sealTrellis2RuntimeQualification({
    provider,
    qualification,
    modalImageId: "im-TestRuntime",
    volumeSnapshotHashes: [hash("dino-volume"), hash("model-volume"), hash("sparse-volume")],
    dinoV3TermsSnapshotHash: hash("dino-terms"),
    modelTermsSnapshotHash: hash("model-terms"),
  });
  const workerReference = sealTrellis2WorkerReference({
    reference,
    width: 2,
    height: 2,
    alphaMode: "straight",
    decoderIdentityHash: hash("png-decoder"),
    decoderEvidenceHash: hash("png-decoding"),
    alphaStatistics: { transparentPixels: 1, translucentPixels: 0, opaquePixels: 3 },
    rights: {
      usage: "creator_owned",
      sourceLabel: "test fixture",
      licenseId: "creator-owned",
      attribution: "",
    },
  });
  const generationRequest = batch.value.requests[0]!;
  const workerRequest = sealTrellis2WorkerRequest({
    request: generationRequest,
    provider,
    qualification,
    runtimeQualification,
    reference: workerReference,
  });
  assert.equal(workerRequest.neuralRequestHash, generationRequest.requestHash);
  assert.deepEqual(workerRequest.delivery.expectedBoundsMeters, expectedBoundsMeters);

  const temporary = await realpath(await mkdtemp(join(tmpdir(), "basalt-trellis2-contract-")));
  try {
    const requestPath = join(temporary, "request.json");
    const outputPath = join(temporary, "dry-run.json");
    await writeFile(requestPath, `${stableJson(workerRequest)}\n`, { mode: 0o600, flag: "wx" });
    await execFile(
      "python3",
      [resolve("workers/trellis2/worker.py"), "--dry-run", requestPath, outputPath],
      { cwd: resolve("."), maxBuffer: 1024 * 1024 },
    );
    const dryRun = JSON.parse(await readFile(outputPath, "utf8")) as Record<string, unknown>;
    assert.equal(dryRun.neuralRequestHash, generationRequest.requestHash);
    assert.equal(dryRun.requestHash, workerRequest.hash);
    assert.equal(dryRun.modelWillRun, false);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }

  const budget = sealNeuralExecutionBudget({
    maximumCostMicrousd: 1_000_000,
    maximumGpuMilliseconds: 120_000,
    maximumPaidAttempts: 1,
    claims: [],
  });
  const first = claimNeuralExecutionBudget(budget, {
    requestHash: batch.value.requests[0]!.requestHash,
    providerId: "trellis2",
    estimatedCostMicrousd: 100_000,
    reservedGpuMilliseconds: 60_000,
  });
  assert.equal(first.status, "claimed");
  if (first.status !== "claimed") return;
  const repeated = claimNeuralExecutionBudget(first.budget, {
    requestHash: batch.value.requests[0]!.requestHash,
    providerId: "trellis2",
    estimatedCostMicrousd: 100_000,
    reservedGpuMilliseconds: 60_000,
  });
  assert.equal(repeated.status, "already_claimed");
});
