import { renderWorldDiagnostics } from "./diagnostic-render.js";
import {
  sealRefinementObservationExecution,
  type WorldDiagnosticCamera,
  type WorldObservationReport,
} from "./contracts.js";
import type { RefinementObservationResult } from "./controller.js";
import { verifyWorldBuild, type WorldVerifierExpectations } from "./verifiers.js";
import type { RefinementPolicy } from "./contracts.js";
import type { WorldBuild } from "@basalt/world-compiler";
import type { SpatialWorldPlan } from "@basalt/world-planning";

/** Run bounded diagnostic renders and geometric checks against one exact world state. */
export function observeWorldBuild(input: {
  readonly plan: SpatialWorldPlan;
  readonly worldBuild: WorldBuild;
  readonly policy: RefinementPolicy;
  readonly expectations: WorldVerifierExpectations;
  readonly cameras: readonly WorldDiagnosticCamera[];
  readonly affectedTaskIds: readonly string[];
  readonly previousObservation?: WorldObservationReport;
  readonly visualAssessment?: WorldObservationReport["visualAssessment"];
  readonly persistRender?: (contentHash: string, bytes: Uint8Array) => void;
}): RefinementObservationResult & { readonly renderPayloads: ReadonlyMap<string, Uint8Array> } {
  const rendered = renderWorldDiagnostics({
    worldBuild: input.worldBuild,
    cameras: input.cameras,
  });
  if (input.persistRender)
    for (const [hash, bytes] of rendered.payloads) input.persistRender(hash, bytes);
  const report = verifyWorldBuild({
    plan: input.plan,
    worldBuild: input.worldBuild,
    policy: input.policy,
    expectations: input.expectations,
    diagnosticRenders: rendered.renders,
    ...(input.visualAssessment ? { visualAssessment: input.visualAssessment } : {}),
  });
  const execution = sealRefinementObservationExecution({
    worldBuildHash: input.worldBuild.worldBuildHash,
    ...(input.previousObservation
      ? { previousObservationHash: input.previousObservation.hash }
      : {}),
    affectedTaskIds: [...input.affectedTaskIds],
    executedCheckIds: report.checks.map((entry) => entry.checkId),
    executedCameraIds: report.diagnosticRenders.map((entry) => entry.camera.cameraId),
    reportHash: report.hash,
  });
  return { report, execution, renderPayloads: rendered.payloads };
}
