import assert from "node:assert/strict";
import test from "node:test";
import { contentHash } from "@basalt/contracts";
import { compilationTaskId } from "@basalt/world-compiler";
import { createRobloxImportManifest, verifyRobloxReadback } from "@basalt/roblox";
import {
  createLocalRefinementCompiler,
  observeWorldBuild,
  runBoundedRefinement,
  sealRefinementPolicy,
  sealWorldChangeProposal,
  type RefinementCompilationExecution,
} from "@basalt/world-refinement";
import { loadSemanticRegistry } from "./helpers/semantic-registry.js";
import {
  TOWER_HEIGHT_PARAMETER_ID,
  TOWER_AUTHORED_CONSTRUCTION_HASH,
  TOWER_PROGRAM_ID,
  TOWER_WIDTH_PARAMETER_ID,
  observationTowerFixture,
  towerDiagnosticCameras,
  towerExpectations,
} from "./helpers/observation-tower-fixture.js";
import { TEST_DIAGNOSTIC_RENDER_EXECUTION_POLICY } from "./helpers/execution-policy.js";

test("observation tower refines through parameters and the affected dependency closure", async () => {
  const semanticModule = await loadSemanticRegistry();
  const fixture = await observationTowerFixture(semanticModule);
  const executions: RefinementCompilationExecution[] = [];
  const compiler = createLocalRefinementCompiler(fixture.compileInput);
  let currentPlan = fixture.plan;
  const tracedCompiler = {
    async compile(input: Parameters<typeof compiler.compile>[0]) {
      currentPlan = input.plan;
      const result = await compiler.compile(input);
      executions.push(result.execution);
      return result;
    },
  };
  const initial = await tracedCompiler.compile({ plan: fixture.plan, requestedTaskIds: [] });
  const protectedRegionTask = initial.worldBuild.tasks.find(
    (entry) => entry.taskId === compilationTaskId("region", "foundation", "MainRegion"),
  );
  assert.ok(protectedRegionTask);
  executions.length = 0;
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
  let proposalCount = 0;
  const result = await runBoundedRefinement({
    initialPlan: fixture.plan,
    compiler: tracedCompiler,
    policy,
    provider: {
      async propose({ plan, worldBuild }) {
        proposalCount += 1;
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
      const requiredViews = towerDiagnosticCameras(currentPlan);
      const coverageViews = requiredViews.map((camera, index) => ({
        ...camera,
        cameraId: `TowerCoverageCamera_${index}`,
        positionMeters: {
          x: camera.positionMeters.x + (index + 1) * 0.75,
          y: camera.positionMeters.y + 0.5,
          z: camera.positionMeters.z - (index + 1) * 0.5,
        },
      }));
      return observeWorldBuild({
        plan: currentPlan,
        worldBuild,
        policy,
        expectations: towerExpectations(worldBuild),
        cameras: [...requiredViews, ...coverageViews],
        diagnosticRenderExecutionPolicy: TEST_DIAGNOSTIC_RENDER_EXECUTION_POLICY,
        affectedTaskIds,
        ...(previousObservation ? { previousObservation } : {}),
      });
    },
  });

  assert.equal(proposalCount, 1);
  assert.equal(result.run.status, "eligible");
  assert.equal(result.run.iterations.length, 1);
  assert.equal(result.observation.visualAssessment.status, "unassessed");
  assert.equal(result.observation.diagnosticRenders.length, 6);
  assert.ok(result.observation.checks.every((entry) => entry.status === "eligible"));
  assert.equal(
    result.observation.checks.find((entry) => entry.kind === "terrain_contact")?.status,
    "eligible",
  );
  const parameters = result.plan.constructionPrograms[0]!.parameters;
  assert.equal(
    parameters.find((entry) => entry.parameterId === TOWER_HEIGHT_PARAMETER_ID)?.value,
    6.5,
  );
  assert.equal(
    parameters.find((entry) => entry.parameterId === TOWER_WIDTH_PARAMETER_ID)?.value,
    6.5,
  );
  assert.ok(
    result.worldBuild.meso.constructedStructures[0]!.evidenceHashes.includes(
      TOWER_AUTHORED_CONSTRUCTION_HASH,
    ),
  );
  const structure = result.worldBuild.meso.constructedStructures[0]!;
  assert.ok(Math.abs(structure.resolvedAnchorMeters.y - 0.5) <= 1e-9);
  assert.equal(
    structure.placementEvidenceHash,
    result.worldBuild.foundation.terrainFields[0]!.hash,
  );
  const route = result.worldBuild.foundation.routeConstructions[0]!;
  assert.ok(route.travelSegments.length >= 7);
  const roadStart = route.travelSegments[0]!.vertices[0]!.positionMeters;
  const roadEnd = route.travelSegments.at(-1)!.vertices[2]!.positionMeters;
  assert.ok(Math.abs(roadEnd.x - roadStart.x) < 1e-9);
  assert.ok(roadEnd.z > roadStart.z);
  const incrementalExecution = executions.at(-1)!;
  assert.ok(incrementalExecution.executedTaskIds.length > 0);
  assert.ok(incrementalExecution.reusedTasks.length > 0);
  assert.equal(incrementalExecution.executedTaskIds.includes(protectedRegionTask.taskId), false);
  assert.ok(
    incrementalExecution.affectedTaskIds.includes(
      compilationTaskId("structure", "meso", TOWER_PROGRAM_ID),
    ),
  );
  assert.ok(
    result.worldBuild.tasks.some(
      (entry) =>
        entry.taskId === protectedRegionTask.taskId &&
        entry.taskHash === protectedRegionTask.taskHash,
    ),
  );
  const roblox = createRobloxImportManifest(result.worldBuild);
  assert.equal(roblox.loweringGaps.length, 0);
  assert.equal(
    roblox.transactions.find((entry) => entry.stage === "meso")?.meso?.constructedStructures.length,
    1,
  );
  const readbackTransaction = roblox.transactions.find((entry) => entry.stage === "readback")!;
  const observedOpening = readbackTransaction.expectedConstructedOpenings[0]!;
  const openingWidthMicrometers =
    observedOpening.clearanceBoundsMicrometers.max.x -
    observedOpening.clearanceBoundsMicrometers.min.x;
  assert.ok(openingWidthMicrometers >= 1_599_998 && openingWidthMicrometers <= 1_600_002);
  assert.deepEqual(observedOpening.blockingPartIds, []);
  const exactReadback = {
    kind: "RobloxReadback" as const,
    sessionHash: roblox.sessionHash,
    worldBuildHash: roblox.worldBuildHash,
    transactionId: readbackTransaction.transactionId,
    status: "complete" as const,
    instances: readbackTransaction.expectedInstanceHashes.map((entry) => ({
      instanceId: entry.instanceId,
      realizedHash: entry.hash,
    })),
    artifacts: readbackTransaction.expectedArtifactHashes,
    constructedElements: readbackTransaction.expectedConstructedElements,
    constructedOpenings: readbackTransaction.expectedConstructedOpenings,
    traceEvents: [],
    diagnostics: [],
  };
  assert.deepEqual(verifyRobloxReadback(readbackTransaction, exactReadback), []);
  const firstElement = exactReadback.constructedElements[0]!;
  assert.ok(
    verifyRobloxReadback(readbackTransaction, {
      ...exactReadback,
      constructedElements: [
        {
          ...firstElement,
          centerMicrometers: {
            ...firstElement.centerMicrometers,
            x: firstElement.centerMicrometers.x + 1,
          },
        },
        ...exactReadback.constructedElements.slice(1),
      ],
    }).some((entry) => entry.includes("geometry or properties drifted")),
  );
  const firstOpening = exactReadback.constructedOpenings[0]!;
  assert.ok(
    verifyRobloxReadback(readbackTransaction, {
      ...exactReadback,
      constructedOpenings: [
        { ...firstOpening, blockingPartIds: ["Workspace.BasaltWorld.Blocker"] },
        ...exactReadback.constructedOpenings.slice(1),
      ],
    }).some((entry) => entry.includes("blocked by actual geometry")),
  );
});
