import { compareCanonicalStrings } from "@basalt/contracts";
import {
  compileBasaltWorld,
  compileBasaltWorldIncremental,
  type CompileBasaltWorldInput,
} from "@basalt/world-compiler";
import {
  sealRefinementCompilationExecution,
  type RefinementCompilationExecution,
} from "./contracts.js";
import type { RefinementCompiler, RefinementCompilationResult } from "./controller.js";

/**
 * Local bounded executor. Unaffected task artifacts are reused byte-for-byte; the optional
 * hook exposes real execution for tests and operator diagnostics.
 */
export function createLocalRefinementCompiler(
  authority: Omit<CompileBasaltWorldInput, "spatialPlan">,
  options: { readonly onTaskExecute?: (taskId: string) => void } = {},
): RefinementCompiler {
  return {
    compile(input): RefinementCompilationResult {
      if (!input.previousWorldBuild) {
        const worldBuild = compileBasaltWorld({ ...authority, spatialPlan: input.plan });
        const executedTaskIds = worldBuild.tasks
          .map((entry) => entry.taskId)
          .sort(compareCanonicalStrings);
        for (const taskId of executedTaskIds) options.onTaskExecute?.(taskId);
        return {
          worldBuild,
          execution: sealRefinementCompilationExecution({
            inputPlanHash: input.plan.planHash,
            requestedTaskIds: [],
            affectedTaskIds: executedTaskIds,
            executedTaskIds,
            reusedTasks: [],
            outputWorldBuildHash: worldBuild.worldBuildHash,
          }),
        };
      }
      if (!input.affectedTaskIds || input.affectedTaskIds.length === 0)
        throw new Error("Incremental refinement requires a non-empty affected task closure");
      const result = compileBasaltWorldIncremental(
        { ...authority, spatialPlan: input.plan },
        {
          previousWorldBuild: input.previousWorldBuild,
          affectedTaskIds: input.affectedTaskIds,
          ...(options.onTaskExecute ? { onTaskExecute: options.onTaskExecute } : {}),
        },
      );
      const execution: RefinementCompilationExecution = sealRefinementCompilationExecution({
        inputPlanHash: input.plan.planHash,
        previousWorldBuildHash: input.previousWorldBuild.worldBuildHash,
        requestedTaskIds: [...input.requestedTaskIds],
        affectedTaskIds: [...input.affectedTaskIds],
        executedTaskIds: [...result.executedTaskIds],
        reusedTasks: [...result.reusedTasks],
        outputWorldBuildHash: result.worldBuild.worldBuildHash,
      });
      return { worldBuild: result.worldBuild, execution };
    },
  };
}
