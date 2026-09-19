import { createHash } from "node:crypto";
import { resolve } from "node:path";
import {
  ImmutableBinaryArtifactStore,
  readBoundedWorkspaceBytes,
  writeCanonicalWorkspaceJson,
} from "@basalt/artifact-store";
import { contentHash } from "@basalt/contracts";
import { compilationTaskId } from "@basalt/world-compiler";
import { createRobloxImportManifest } from "@basalt/roblox";
import {
  createLocalRefinementCompiler,
  observeWorldBuild,
  runBoundedRefinement,
  sealRefinementPolicy,
  sealWorldChangeProposal,
} from "@basalt/world-refinement";
import { loadSemanticRegistry } from "../dist/test/helpers/semantic-registry.js";
import {
  TOWER_HEIGHT_PARAMETER_ID,
  TOWER_PROGRAM_ID,
  TOWER_WIDTH_PARAMETER_ID,
  observationTowerFixture,
  towerDiagnosticCameras,
  towerExpectations,
} from "../dist/test/helpers/observation-tower-fixture.js";

const repositoryRoot = resolve(".");
const outputRoot = ".basalt/evals/observation-tower";
const binaryStore = new ImmutableBinaryArtifactStore(resolve(repositoryRoot, ".basalt/cas"));
const semanticModule = await loadSemanticRegistry();
const fixture = await observationTowerFixture(semanticModule);
const compilerExecutions = [];
const observationExecutions = [];
const observations = [];
const renderPayloads = new Map();
let currentPlan = fixture.plan;
let baselineWorldBuild;

const baseCompiler = createLocalRefinementCompiler(fixture.compileInput);
const compiler = {
  async compile(input) {
    currentPlan = input.plan;
    const result = await baseCompiler.compile(input);
    baselineWorldBuild ??= result.worldBuild;
    compilerExecutions.push(result.execution);
    return result;
  },
};

const initial = await baseCompiler.compile({ plan: fixture.plan, requestedTaskIds: [] });
const protectedRegionTask = initial.worldBuild.tasks.find(
  (entry) => entry.taskId === compilationTaskId("region", "foundation", "MainRegion"),
);
if (!protectedRegionTask) throw new Error("Observation-tower fixture has no protected region task");

const policy = sealRefinementPolicy({
  maximumIterations: 2,
  constructionParameters: [
    {
      programId: TOWER_PROGRAM_ID,
      parameterId: TOWER_HEIGHT_PARAMETER_ID,
      minimum: 3,
      maximum: 8,
      maximumAbsoluteDeltaPerIteration: 3,
    },
    {
      programId: TOWER_PROGRAM_ID,
      parameterId: TOWER_WIDTH_PARAMETER_ID,
      minimum: 4,
      maximum: 8,
      maximumAbsoluteDeltaPerIteration: 3,
    },
  ],
  routeAlternatives: [],
  vegetation: [],
  terrainPaint: [],
  protectedIntentIds: [],
  protectedTaskHashes: [protectedRegionTask.taskHash],
  requiredCheckKinds: [
    "containment",
    "ground_access",
    "line_of_sight",
    "opening_clearance",
    "occupancy_clearance",
    "protected_hash",
    "requested_dimensions",
    "style_consistency",
    "terrain_contact",
  ],
});

const result = await runBoundedRefinement({
  initialPlan: fixture.plan,
  compiler,
  policy,
  provider: {
    async propose({ plan, worldBuild }) {
      return sealWorldChangeProposal({
        basePlanHash: plan.planHash,
        baseWorldBuildHash: worldBuild.worldBuildHash,
        changes: [
          {
            kind: "construction_parameter",
            programId: TOWER_PROGRAM_ID,
            parameterId: TOWER_HEIGHT_PARAMETER_ID,
            value: 6.5,
          },
          {
            kind: "construction_parameter",
            programId: TOWER_PROGRAM_ID,
            parameterId: TOWER_WIDTH_PARAMETER_ID,
            value: 6.5,
          },
        ],
        rationale: "Meet the requested tower silhouette while preserving access and clearance.",
        providerId: "deterministic_tower_fixture",
        providerImplementationHash: contentHash("deterministic-tower-proposal-provider"),
      });
    },
  },
  observe({ worldBuild, previousObservation, affectedTaskIds }) {
    const observed = observeWorldBuild({
      plan: currentPlan,
      worldBuild,
      policy,
      expectations: towerExpectations(worldBuild),
      cameras: towerDiagnosticCameras(currentPlan),
      affectedTaskIds,
      ...(previousObservation ? { previousObservation } : {}),
    });
    observations.push(observed.report);
    observationExecutions.push(observed.execution);
    for (const [hash, bytes] of observed.renderPayloads) renderPayloads.set(hash, bytes);
    return observed;
  },
});

if (!baselineWorldBuild) throw new Error("Observation-tower refinement did not compile a baseline");
if (result.run.status !== "eligible")
  throw new Error(`Observation-tower refinement ended as ${result.run.status}`);

for (const [hash, bytes] of renderPayloads) {
  const stored = await binaryStore.write(bytes, "image/x-portable-pixmap");
  if (stored.artifactHash !== hash) throw new Error("Diagnostic render CAS hash mismatch");
}

const robloxImport = createRobloxImportManifest(result.worldBuild);
if (robloxImport.loweringGaps.length > 0)
  throw new Error(
    `Observation-tower Roblox lowering is incomplete: ${robloxImport.loweringGaps.join("; ")}`,
  );

const executionEvidence = {
  kind: "ObservationTowerExecutionEvidence",
  baselineWorldBuildHash: baselineWorldBuild.worldBuildHash,
  refinedWorldBuildHash: result.worldBuild.worldBuildHash,
  compilerExecutions,
  observationExecutions,
  observationHashes: observations.map((entry) => entry.hash),
};

await Promise.all([
  writeGeneratedJson(`${outputRoot}/baseline-spatial-plan.json`, fixture.plan),
  writeGeneratedJson(`${outputRoot}/baseline-world-build.json`, baselineWorldBuild),
  writeGeneratedJson(`${outputRoot}/refined-spatial-plan.json`, result.plan),
  writeGeneratedJson(`${outputRoot}/refined-world-build.json`, result.worldBuild),
  writeGeneratedJson(`${outputRoot}/refinement-policy.json`, policy),
  writeGeneratedJson(`${outputRoot}/refinement-run.json`, result.run),
  writeGeneratedJson(`${outputRoot}/observation.json`, result.observation),
  writeGeneratedJson(`${outputRoot}/execution-evidence.json`, executionEvidence),
  writeGeneratedJson(`${outputRoot}/roblox-import.json`, robloxImport),
]);

process.stdout.write(
  `${JSON.stringify(
    {
      status: result.run.status,
      baselineWorldBuildHash: baselineWorldBuild.worldBuildHash,
      refinedWorldBuildHash: result.worldBuild.worldBuildHash,
      observations: observations.length,
      diagnosticRenders: renderPayloads.size,
      outputRoot,
      robloxImport: `${outputRoot}/roblox-import.json`,
    },
    null,
    2,
  )}\n`,
);

async function writeGeneratedJson(path, value) {
  let expectedExistingHash;
  try {
    const current = await readBoundedWorkspaceBytes(repositoryRoot, path);
    expectedExistingHash = createHash("sha256").update(current).digest("hex");
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("missing")) throw error;
  }
  return writeCanonicalWorkspaceJson(repositoryRoot, path, value, {
    maxBytes: 64 * 1024 * 1024,
    ...(expectedExistingHash ? { expectedExistingHash } : {}),
  });
}
