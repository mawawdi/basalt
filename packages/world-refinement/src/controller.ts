import { compareCanonicalStrings } from "@basalt/contracts";
import {
  affectedCompilationTaskClosure,
  compilationTaskId,
  type WorldBuild,
} from "@basalt/world-compiler";
import {
  replaceConstructionParameters,
  sealSpatialWorldPlan,
  type SpatialWorldPlan,
} from "@basalt/world-planning";
import {
  REFINEMENT_COMPILATION_EXECUTION_SCHEMA,
  REFINEMENT_OBSERVATION_EXECUTION_SCHEMA,
  REFINEMENT_POLICY_SCHEMA,
  WORLD_CHANGE_PROPOSAL_SCHEMA,
  WORLD_OBSERVATION_REPORT_SCHEMA,
  sealRefinementRun,
  type RefinementCompilationExecution,
  type RefinementObservationExecution,
  type RefinementPolicy,
  type RefinementRun,
  type WorldChangeProposal,
  type WorldObservationReport,
} from "./contracts.js";

export interface RefinementProposalProvider {
  propose(input: {
    readonly plan: SpatialWorldPlan;
    readonly worldBuild: WorldBuild;
    readonly observation: WorldObservationReport;
    readonly policy: RefinementPolicy;
  }): Promise<WorldChangeProposal>;
}

export interface RefinementCompilationResult {
  readonly worldBuild: WorldBuild;
  readonly execution: RefinementCompilationExecution;
}

/** The compiler must report the exact logical tasks it executed and reused. */
export interface RefinementCompiler {
  compile(input: {
    readonly plan: SpatialWorldPlan;
    readonly previousWorldBuild?: WorldBuild;
    readonly requestedTaskIds: readonly string[];
    readonly affectedTaskIds?: readonly string[];
  }): Promise<RefinementCompilationResult> | RefinementCompilationResult;
}

export interface RefinementObservationResult {
  readonly report: WorldObservationReport;
  readonly execution: RefinementObservationExecution;
}

export async function runBoundedRefinement(input: {
  readonly initialPlan: SpatialWorldPlan;
  readonly compiler: RefinementCompiler;
  readonly provider: RefinementProposalProvider;
  readonly observe: (input: {
    readonly worldBuild: WorldBuild;
    readonly previousObservation?: WorldObservationReport;
    readonly affectedTaskIds: readonly string[];
  }) => Promise<RefinementObservationResult> | RefinementObservationResult;
  readonly policy: RefinementPolicy;
}): Promise<{
  readonly run: RefinementRun;
  readonly plan: SpatialWorldPlan;
  readonly worldBuild: WorldBuild;
  readonly observation: WorldObservationReport;
}> {
  const policy = REFINEMENT_POLICY_SCHEMA.parse(input.policy);
  let plan = input.initialPlan;
  const initialCompilation = await input.compiler.compile({
    plan,
    requestedTaskIds: [],
  });
  let worldBuild = initialCompilation.worldBuild;
  verifyCompilationExecution({
    plan,
    current: worldBuild,
    execution: initialCompilation.execution,
  });
  const initialWorldBuildHash = worldBuild.worldBuildHash;
  const initialObservationResult = await input.observe({
    worldBuild,
    affectedTaskIds: worldBuild.tasks.map((entry) => entry.taskId),
  });
  let observation = verifyObservationExecution(initialObservationResult, worldBuild);
  const initialPlanHash = plan.planHash;
  const iterations: RefinementRun["iterations"] = [];
  const diagnostics: string[] = [];
  let terminal: "eligible" | "incomplete" | "rejected" = observation.geometricStatus;

  for (
    let index = 0;
    observation.geometricStatus === "incomplete" && index < policy.maximumIterations;
    index += 1
  ) {
    try {
      const proposal = WORLD_CHANGE_PROPOSAL_SCHEMA.parse(
        await input.provider.propose({ plan, worldBuild, observation, policy }),
      );
      if (
        proposal.basePlanHash !== plan.planHash ||
        proposal.baseWorldBuildHash !== worldBuild.worldBuildHash
      )
        throw new Error("Refinement proposal binds stale inputs");
      const nextPlan = applyWorldChangeProposal(plan, proposal, policy);
      const seedTaskIds = refinementSeedTasks(worldBuild, proposal);
      const affectedTaskIds = affectedCompilationTaskClosure(worldBuild.tasks, seedTaskIds);
      enforceProtectedClosure(worldBuild, affectedTaskIds, policy);
      const compilation = await input.compiler.compile({
        plan: nextPlan,
        previousWorldBuild: worldBuild,
        requestedTaskIds: seedTaskIds,
        affectedTaskIds,
      });
      const nextWorldBuild = compilation.worldBuild;
      verifyCompilationExecution({
        plan: nextPlan,
        previous: worldBuild,
        current: nextWorldBuild,
        requestedTaskIds: seedTaskIds,
        affectedTaskIds,
        execution: compilation.execution,
      });
      enforceProtectedTasks(worldBuild, nextWorldBuild, policy);
      const nextObservationResult = await input.observe({
        worldBuild: nextWorldBuild,
        previousObservation: observation,
        affectedTaskIds,
      });
      const nextObservation = verifyObservationExecution(
        nextObservationResult,
        nextWorldBuild,
        observation,
        affectedTaskIds,
      );
      const beforeById = new Map(worldBuild.tasks.map((entry) => [entry.taskId, entry] as const));
      const changedTaskHashes = nextWorldBuild.tasks
        .filter((entry) => beforeById.get(entry.taskId)?.taskHash !== entry.taskHash)
        .map((entry) => entry.taskHash)
        .sort(compareCanonicalStrings);
      iterations.push({
        index,
        beforeWorldBuildHash: worldBuild.worldBuildHash,
        proposalHash: proposal.hash,
        afterWorldBuildHash: nextWorldBuild.worldBuildHash,
        seedTaskIds: [...seedTaskIds],
        affectedTaskIds: [...affectedTaskIds],
        changedTaskHashes,
        compilationExecutionHash: compilation.execution.hash,
        observationHash: nextObservation.hash,
        observationExecutionHash: nextObservationResult.execution.hash,
      });
      plan = nextPlan;
      worldBuild = nextWorldBuild;
      observation = nextObservation;
      terminal = observation.geometricStatus;
    } catch (error) {
      terminal = "rejected";
      diagnostics.push(error instanceof Error ? error.message : String(error));
      break;
    }
  }
  if (terminal === "incomplete" && iterations.length >= policy.maximumIterations)
    diagnostics.push("Refinement iteration budget exhausted");
  const run = sealRefinementRun({
    status: terminal,
    initialPlanHash,
    initialWorldBuildHash,
    finalPlanHash: plan.planHash,
    finalWorldBuildHash: worldBuild.worldBuildHash,
    policyHash: policy.policyHash,
    iterations,
    finalObservationHash: observation.hash,
    diagnostics,
  });
  return { run, plan, worldBuild, observation };
}

export function applyWorldChangeProposal(
  plan: SpatialWorldPlan,
  proposal: WorldChangeProposal,
  policy: RefinementPolicy,
): SpatialWorldPlan {
  const changedPrograms = new Map<string, Array<{ parameterId: string; value: number }>>();
  const changedRoutes = new Map<string, string>();
  for (const change of proposal.changes) {
    if (change.kind === "construction_parameter") {
      const rule = policy.constructionParameters.find(
        (entry) => entry.programId === change.programId && entry.parameterId === change.parameterId,
      );
      const program = plan.constructionPrograms.find(
        (entry) => entry.programId === change.programId,
      );
      const parameter = program?.parameters.find(
        (entry) => entry.parameterId === change.parameterId,
      );
      if (!rule || !parameter) throw new Error("Construction parameter change is not whitelisted");
      if (
        change.value < rule.minimum ||
        change.value > rule.maximum ||
        Math.abs(change.value - parameter.value) > rule.maximumAbsoluteDeltaPerIteration
      )
        throw new Error("Construction parameter change exceeds its policy bound");
      changedPrograms.set(change.programId, [
        ...(changedPrograms.get(change.programId) ?? []),
        { parameterId: change.parameterId, value: change.value },
      ]);
    } else {
      const rule = policy.routeAlternatives.find((entry) => entry.routeId === change.routeId);
      if (!rule?.alternatives.some((entry) => entry.alternativeId === change.alternativeId))
        throw new Error("Route alternative is not whitelisted");
      changedRoutes.set(change.routeId, change.alternativeId);
    }
  }
  const {
    kind: _kind,
    coordinateSystem: _coordinateSystem,
    planHash: _planHash,
    constructionPrograms: _constructionPrograms,
    routes: _routes,
    ...unchangedPlan
  } = plan;
  return sealSpatialWorldPlan({
    ...unchangedPlan,
    constructionPrograms: plan.constructionPrograms.map((program) => {
      const changes = changedPrograms.get(program.programId);
      return changes ? replaceConstructionParameters(program, changes) : program;
    }),
    routes: plan.routes.map((route) => {
      const alternativeId = changedRoutes.get(route.routeId);
      if (!alternativeId) return route;
      const alignmentMeters = policy.routeAlternatives
        .find((entry) => entry.routeId === route.routeId)!
        .alternatives.find((entry) => entry.alternativeId === alternativeId)!.alignmentMeters;
      return { ...route, alignmentMeters };
    }),
  });
}

function refinementSeedTasks(
  worldBuild: WorldBuild,
  proposal: WorldChangeProposal,
): readonly string[] {
  const seeds = proposal.changes.map((change) =>
    change.kind === "construction_parameter"
      ? compilationTaskId("structure", "meso", change.programId)
      : compilationTaskId("route", "route_construction", change.routeId),
  );
  const known = new Set(worldBuild.tasks.map((entry) => entry.taskId));
  for (const seed of seeds)
    if (!known.has(seed)) throw new Error(`Refinement target has no compilation task: ${seed}`);
  return [...new Set(seeds)].sort(compareCanonicalStrings);
}

function verifyCompilationExecution(input: {
  readonly plan: SpatialWorldPlan;
  readonly previous?: WorldBuild;
  readonly current: WorldBuild;
  readonly requestedTaskIds?: readonly string[];
  readonly affectedTaskIds?: readonly string[];
  readonly execution: RefinementCompilationExecution;
}): void {
  const execution = REFINEMENT_COMPILATION_EXECUTION_SCHEMA.parse(input.execution);
  if (
    execution.inputPlanHash !== input.plan.planHash ||
    execution.outputWorldBuildHash !== input.current.worldBuildHash ||
    execution.previousWorldBuildHash !== input.previous?.worldBuildHash
  )
    throw new Error("Compilation execution trace binds different inputs or output");
  const currentById = new Map(input.current.tasks.map((entry) => [entry.taskId, entry] as const));
  if (!input.previous) {
    const allTaskIds = [...currentById.keys()].sort(compareCanonicalStrings);
    if (
      execution.reusedTasks.length > 0 ||
      stableList(execution.executedTaskIds) !== stableList(allTaskIds)
    )
      throw new Error("Initial compilation must execute every materialized task");
    return;
  }
  const previousById = new Map(input.previous.tasks.map((entry) => [entry.taskId, entry] as const));
  if (stableList([...previousById.keys()]) !== stableList([...currentById.keys()]))
    throw new Error("A bounded refinement cannot change the logical task set");
  if (
    stableList(execution.requestedTaskIds) !== stableList(input.requestedTaskIds ?? []) ||
    stableList(execution.affectedTaskIds) !== stableList(input.affectedTaskIds ?? [])
  )
    throw new Error("Compilation execution trace does not match the requested dependency closure");
  const expectedReusedIds = [...currentById.keys()]
    .filter((entry) => !execution.affectedTaskIds.includes(entry))
    .sort(compareCanonicalStrings);
  if (
    stableList(execution.reusedTasks.map((entry) => entry.taskId)) !== stableList(expectedReusedIds)
  )
    throw new Error("Compilation execution trace does not account for every unaffected task");
  for (const reused of execution.reusedTasks) {
    const before = previousById.get(reused.taskId);
    const after = currentById.get(reused.taskId);
    if (
      !before ||
      !after ||
      before.taskHash !== reused.taskHash ||
      after.taskHash !== reused.taskHash
    )
      throw new Error(`Reused task ${reused.taskId} did not preserve its exact result hash`);
  }
}

function verifyObservationExecution(
  result: RefinementObservationResult,
  worldBuild: WorldBuild,
  previous?: WorldObservationReport,
  affectedTaskIds?: readonly string[],
): WorldObservationReport {
  const report = WORLD_OBSERVATION_REPORT_SCHEMA.parse(result.report);
  const execution = REFINEMENT_OBSERVATION_EXECUTION_SCHEMA.parse(result.execution);
  if (
    report.worldBuildHash !== worldBuild.worldBuildHash ||
    execution.worldBuildHash !== worldBuild.worldBuildHash ||
    execution.reportHash !== report.hash ||
    execution.previousObservationHash !== previous?.hash
  )
    throw new Error("Observation execution trace binds different inputs or output");
  const expectedAffected = affectedTaskIds ?? worldBuild.tasks.map((entry) => entry.taskId);
  if (stableList(execution.affectedTaskIds) !== stableList(expectedAffected))
    throw new Error("Observation execution does not bind the affected compilation closure");
  if (
    stableList(execution.executedCheckIds) !==
    stableList(report.checks.map((entry) => entry.checkId))
  )
    throw new Error("Observation execution does not prove that every reported check ran");
  if (
    stableList(execution.executedCameraIds) !==
    stableList(report.diagnosticRenders.map((entry) => entry.camera.cameraId))
  )
    throw new Error("Observation execution does not prove that every diagnostic camera rendered");
  return report;
}

function enforceProtectedClosure(
  before: WorldBuild,
  affectedTaskIds: readonly string[],
  policy: RefinementPolicy,
): void {
  const protectedIds = new Set(
    before.tasks
      .filter((entry) => policy.protectedTaskHashes.includes(entry.taskHash))
      .map((entry) => entry.taskId),
  );
  for (const taskId of affectedTaskIds)
    if (protectedIds.has(taskId))
      throw new Error(`Refinement dependency closure reaches protected task ${taskId}`);
}

function enforceProtectedTasks(
  before: WorldBuild,
  after: WorldBuild,
  policy: RefinementPolicy,
): void {
  const beforeByHash = new Map(
    before.tasks.map((entry) => [entry.taskHash, entry.taskId] as const),
  );
  const afterHashes = new Set(after.tasks.map((entry) => entry.taskHash));
  for (const hash of policy.protectedTaskHashes)
    if (!beforeByHash.has(hash) || !afterHashes.has(hash))
      throw new Error(`Protected task hash changed or is missing: ${hash}`);
}

function stableList(values: readonly string[]): string {
  return JSON.stringify([...values].sort(compareCanonicalStrings));
}
