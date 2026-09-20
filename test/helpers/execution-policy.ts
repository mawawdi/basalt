import type { CompileBasaltWorldInput, VegetationExecutionPolicy } from "@basalt/world-compiler";
import type { DiagnosticRenderExecutionPolicy } from "@basalt/world-refinement";

/** Explicit test-run allocation. It is execution evidence, never a semantic world limit. */
export const TEST_VEGETATION_EXECUTION_POLICY: VegetationExecutionPolicy = Object.freeze({
  policyId: "TestVegetationExecution",
  origin: "Explicit deterministic test-run allocation with resumable candidate checkpoints",
  candidateBatchSize: 1_024,
  mergeFanIn: 8,
  candidateRunDirectory: ".basalt/test-runtime/vegetation-runs",
  maximumCandidateEvaluations: 2_000_000,
});

export const TEST_WORLD_EXECUTION_POLICY: NonNullable<CompileBasaltWorldInput["executionPolicy"]> =
  Object.freeze({
    construction: Object.freeze({
      policyId: "TestConstructionExecution",
      origin: "Explicit deterministic test-run allocation",
      maximumConstructedElements: 100_000,
    }),
    vegetation: TEST_VEGETATION_EXECUTION_POLICY,
    population: Object.freeze({
      policyId: "TestPopulationExecution",
      origin: "Explicit deterministic test-run candidate allocation",
      minimumCandidateAttempts: 4_096,
      candidateAttemptsPerTarget: 64,
      pointPlacementCandidateAttempts: 256,
    }),
    assembly: Object.freeze({
      policyId: "TestAssemblyExecution",
      origin: "Explicit deterministic test-run constraint-solver allocation",
      maximumDecisions: 1_000_000,
      maximumBacktracks: 1_000_000,
    }),
  });

export const TEST_DIAGNOSTIC_RENDER_EXECUTION_POLICY: DiagnosticRenderExecutionPolicy =
  Object.freeze({
    policyId: "TestDiagnosticRenderExecution",
    origin: "Explicit deterministic test-run allocation",
    maximumPixelsPerCamera: 262_144,
    maximumTerrainTrianglesPerField: 16_384,
  });
