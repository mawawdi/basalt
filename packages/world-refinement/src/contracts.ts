import { z } from "zod";
import {
  COMPILATION_STATUS_SCHEMA,
  CONTENT_DESCRIPTOR_SCHEMA,
  HASH_SCHEMA,
  compareCanonicalStrings,
  contentHash,
  deepFreezeJson,
  stableJson,
} from "@basalt/contracts";
import {
  WORLD_ENTITY_ID_SCHEMA,
  WORLD_AABB_SCHEMA,
  WORLD_POLYGON_SCHEMA,
  WORLD_POINT2_SCHEMA,
  WORLD_VECTOR3_SCHEMA,
} from "@basalt/world-planning";

export const WORLD_OBSERVATION_CHECK_KINDS = [
  "containment",
  "ground_access",
  "line_of_sight",
  "opening_clearance",
  "occupancy_clearance",
  "protected_hash",
  "requested_dimensions",
  "style_consistency",
  "terrain_contact",
] as const;
export const WORLD_OBSERVATION_CHECK_KIND_SCHEMA = z.enum(WORLD_OBSERVATION_CHECK_KINDS);

export const WORLD_OBSERVATION_CHECK_SCHEMA = z
  .object({
    checkId: WORLD_ENTITY_ID_SCHEMA,
    kind: WORLD_OBSERVATION_CHECK_KIND_SCHEMA,
    subjectId: WORLD_ENTITY_ID_SCHEMA,
    status: COMPILATION_STATUS_SCHEMA,
    evidenceHash: HASH_SCHEMA,
    diagnostic: z.string().trim().min(1).max(1_024).optional(),
  })
  .strict();

export const WORLD_DIAGNOSTIC_CAMERA_SCHEMA = z
  .object({
    cameraId: WORLD_ENTITY_ID_SCHEMA,
    purpose: z.enum(["approach", "overview", "platform"]),
    positionMeters: WORLD_VECTOR3_SCHEMA,
    lookAtMeters: WORLD_VECTOR3_SCHEMA,
    up: WORLD_VECTOR3_SCHEMA,
    verticalFieldOfViewDegrees: z.number().finite().min(10).max(120),
    widthPixels: z.number().int().min(32).max(512),
    heightPixels: z.number().int().min(32).max(512),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.widthPixels * value.heightPixels > 262_144)
      context.addIssue({ code: "custom", message: "Diagnostic render exceeds its pixel budget" });
    if (
      Math.hypot(
        value.lookAtMeters.x - value.positionMeters.x,
        value.lookAtMeters.y - value.positionMeters.y,
        value.lookAtMeters.z - value.positionMeters.z,
      ) <= 1e-9
    )
      context.addIssue({ code: "custom", message: "Diagnostic camera cannot look at itself" });
    if (Math.hypot(value.up.x, value.up.y, value.up.z) <= 1e-9)
      context.addIssue({ code: "custom", message: "Diagnostic camera up cannot be zero" });
  });
export type WorldDiagnosticCamera = z.output<typeof WORLD_DIAGNOSTIC_CAMERA_SCHEMA>;

export const WORLD_DIAGNOSTIC_RENDER_SCHEMA = z
  .object({
    renderId: WORLD_ENTITY_ID_SCHEMA,
    worldBuildHash: HASH_SCHEMA,
    camera: WORLD_DIAGNOSTIC_CAMERA_SCHEMA,
    rendererImplementationHash: HASH_SCHEMA,
    geometryEvidenceHashes: z.array(HASH_SCHEMA).min(1).max(100_000),
    payload: CONTENT_DESCRIPTOR_SCHEMA.extend({
      kind: z.literal("diagnostic_render"),
      mediaType: z.literal("image/x-portable-pixmap"),
    }).strict(),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyHash(value, context);
    requireUniqueCanonical(
      value.geometryEvidenceHashes,
      "diagnostic render geometry hashes",
      context,
    );
  });
export type WorldDiagnosticRender = z.output<typeof WORLD_DIAGNOSTIC_RENDER_SCHEMA>;

const WORLD_VISUAL_ASSESSMENT_SCHEMA = z
  .object({
    status: z.enum(["unassessed", "eligible", "incomplete", "rejected"]),
    assessor: z.enum(["creator", "model", "none"]),
    evidenceHashes: z.array(HASH_SCHEMA).max(256),
    diagnostics: z.array(z.string().trim().min(1).max(1_024)).max(256),
  })
  .strict()
  .superRefine((value, context) => {
    requireUniqueCanonical(value.evidenceHashes, "visual assessment evidence", context);
    requireUniqueCanonical(value.diagnostics, "visual assessment diagnostics", context);
    if (
      (value.status === "unassessed") !==
      (value.assessor === "none" && value.evidenceHashes.length === 0)
    )
      context.addIssue({
        code: "custom",
        message: "Unassessed visuals require no assessor or claimed evidence",
      });
    if (value.status !== "unassessed" && value.evidenceHashes.length === 0)
      context.addIssue({ code: "custom", message: "Visual assessments require exact evidence" });
  });

export const WORLD_OBSERVATION_REPORT_SCHEMA = z
  .object({
    kind: z.literal("WorldObservationReport"),
    worldBuildHash: HASH_SCHEMA,
    geometricStatus: COMPILATION_STATUS_SCHEMA,
    checks: z.array(WORLD_OBSERVATION_CHECK_SCHEMA).min(1).max(65_536),
    diagnosticRenders: z.array(WORLD_DIAGNOSTIC_RENDER_SCHEMA).max(8),
    visualAssessment: WORLD_VISUAL_ASSESSMENT_SCHEMA,
    diagnostics: z.array(z.string().trim().min(1).max(1_024)).max(65_536),
    compilerAuthority: z.literal(false),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyHash(value, context);
    requireUniqueCanonical(
      value.checks.map((entry) => entry.checkId),
      "observation checks",
      context,
    );
    requireUniqueCanonical(value.diagnostics, "observation diagnostics", context);
    requireUniqueCanonical(
      value.diagnosticRenders.map((entry) => entry.renderId),
      "diagnostic renders",
      context,
    );
    if (value.diagnosticRenders.some((entry) => entry.worldBuildHash !== value.worldBuildHash))
      context.addIssue({ code: "custom", message: "Diagnostic render binds another world state" });
    const expected = aggregateStatus(value.checks.map((entry) => entry.status));
    if (value.geometricStatus !== expected)
      context.addIssue({
        code: "custom",
        path: ["geometricStatus"],
        message: "Observation status mismatch",
      });
  });
export type WorldObservationReport = z.output<typeof WORLD_OBSERVATION_REPORT_SCHEMA>;

export const WORLD_CHANGE_SCHEMA = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("vegetation_density"),
      intentId: WORLD_ENTITY_ID_SCHEMA,
      candidateDensityPerSquareMeter: z.number().finite().positive(),
      maximumCount: z.number().int().positive().max(65_536),
    })
    .strict(),
  z
    .object({
      kind: z.literal("vegetation_clearings"),
      intentId: WORLD_ENTITY_ID_SCHEMA,
      clearings: z
        .array(
          z
            .object({
              boundsMeters: WORLD_AABB_SCHEMA,
              falloffMeters: z.number().finite().nonnegative().max(64),
            })
            .strict(),
        )
        .max(32),
    })
    .strict(),
  z
    .object({
      kind: z.literal("terrain_paint"),
      terrainPlanId: WORLD_ENTITY_ID_SCHEMA,
      operationIndex: z.number().int().nonnegative().max(65_535),
      materialId: WORLD_ENTITY_ID_SCHEMA,
      polygon: WORLD_POLYGON_SCHEMA,
    })
    .strict(),
  z
    .object({
      kind: z.literal("construction_parameter"),
      programId: WORLD_ENTITY_ID_SCHEMA,
      parameterId: WORLD_ENTITY_ID_SCHEMA,
      value: z.number().finite(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("route_alternative"),
      routeId: WORLD_ENTITY_ID_SCHEMA,
      alternativeId: WORLD_ENTITY_ID_SCHEMA,
    })
    .strict(),
]);
export type WorldChange = z.output<typeof WORLD_CHANGE_SCHEMA>;

export const WORLD_CHANGE_PROPOSAL_SCHEMA = z
  .object({
    kind: z.literal("WorldChangeProposal"),
    basePlanHash: HASH_SCHEMA,
    baseWorldBuildHash: HASH_SCHEMA,
    changes: z.array(WORLD_CHANGE_SCHEMA).min(1).max(32),
    rationale: z.string().trim().min(1).max(2_048),
    providerId: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u),
    providerImplementationHash: HASH_SCHEMA,
    compilerAuthority: z.literal(false),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyHash(value, context);
    requireUniqueCanonical(value.changes.map(changeIdentity), "proposal changes", context);
  });
export type WorldChangeProposal = z.output<typeof WORLD_CHANGE_PROPOSAL_SCHEMA>;

const CONSTRUCTION_PARAMETER_POLICY_SCHEMA = z
  .object({
    programId: WORLD_ENTITY_ID_SCHEMA,
    parameterId: WORLD_ENTITY_ID_SCHEMA,
    minimum: z.number().finite(),
    maximum: z.number().finite(),
    maximumAbsoluteDeltaPerIteration: z.number().finite().positive(),
  })
  .strict()
  .refine((value) => value.minimum <= value.maximum, "Refinement parameter range is inverted");

const ROUTE_ALTERNATIVE_POLICY_SCHEMA = z
  .object({
    routeId: WORLD_ENTITY_ID_SCHEMA,
    alternatives: z
      .array(
        z
          .object({
            alternativeId: WORLD_ENTITY_ID_SCHEMA,
            alignmentMeters: z.array(WORLD_POINT2_SCHEMA).min(2).max(65_536),
          })
          .strict(),
      )
      .min(1)
      .max(32),
  })
  .strict()
  .superRefine((value, context) =>
    requireUniqueCanonical(
      value.alternatives.map((entry) => entry.alternativeId),
      "route alternatives",
      context,
    ),
  );

export const REFINEMENT_POLICY_SCHEMA = z
  .object({
    kind: z.literal("RefinementPolicy"),
    maximumIterations: z.number().int().positive().max(16),
    constructionParameters: z.array(CONSTRUCTION_PARAMETER_POLICY_SCHEMA).max(256),
    routeAlternatives: z.array(ROUTE_ALTERNATIVE_POLICY_SCHEMA).max(256),
    vegetation: z
      .array(
        z
          .object({
            intentId: WORLD_ENTITY_ID_SCHEMA,
            minimumDensity: z.number().finite().nonnegative(),
            maximumDensity: z.number().finite().positive(),
            maximumCount: z.number().int().nonnegative().max(65_536),
            clearingBounds: WORLD_AABB_SCHEMA,
          })
          .strict()
          .refine(
            (v) => v.minimumDensity <= v.maximumDensity,
            "Vegetation density range is inverted",
          ),
      )
      .max(256),
    terrainPaint: z
      .array(
        z
          .object({
            terrainPlanId: WORLD_ENTITY_ID_SCHEMA,
            operationIndex: z.number().int().nonnegative().max(65_535),
            allowedMaterialIds: z.array(WORLD_ENTITY_ID_SCHEMA).min(1).max(32),
            bounds: WORLD_AABB_SCHEMA,
          })
          .strict(),
      )
      .max(256),
    protectedIntentIds: z.array(WORLD_ENTITY_ID_SCHEMA).max(65_536),
    protectedTaskHashes: z.array(HASH_SCHEMA).max(65_536),
    requiredCheckKinds: z.array(WORLD_OBSERVATION_CHECK_KIND_SCHEMA).min(1),
    policyHash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    const material = { ...value };
    delete (material as Partial<RefinementPolicy>).policyHash;
    if (contentHash(stableJson(material)) !== value.policyHash)
      context.addIssue({
        code: "custom",
        path: ["policyHash"],
        message: "Refinement policy hash mismatch",
      });
    requireUniqueCanonical(
      value.constructionParameters.map((entry) => `${entry.programId}:${entry.parameterId}`),
      "refinement parameters",
      context,
    );
    requireUniqueCanonical(
      value.routeAlternatives.map((entry) => entry.routeId),
      "refinement routes",
      context,
    );
    requireUniqueCanonical(value.protectedTaskHashes, "protected task hashes", context);
    requireUniqueCanonical(
      value.vegetation.map((v) => v.intentId),
      "vegetation policy",
      context,
    );
    requireUniqueCanonical(
      value.terrainPaint.map((v) => `${v.terrainPlanId}:${v.operationIndex}`),
      "terrain paint policy",
      context,
    );
    requireUniqueCanonical(value.protectedIntentIds, "protected intent IDs", context);
    requireUniqueCanonical(value.requiredCheckKinds, "required check kinds", context);
  });
export type RefinementPolicy = z.output<typeof REFINEMENT_POLICY_SCHEMA>;

const REFINEMENT_ITERATION_SCHEMA = z
  .object({
    index: z.number().int().nonnegative().max(15),
    beforeWorldBuildHash: HASH_SCHEMA,
    proposalHash: HASH_SCHEMA,
    afterWorldBuildHash: HASH_SCHEMA,
    seedTaskIds: z.array(WORLD_ENTITY_ID_SCHEMA).max(65_536),
    affectedTaskIds: z.array(WORLD_ENTITY_ID_SCHEMA).max(65_536),
    changedTaskHashes: z.array(HASH_SCHEMA).max(65_536),
    compilationExecutionHash: HASH_SCHEMA,
    observationHash: HASH_SCHEMA,
    observationExecutionHash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    requireUniqueCanonical(value.seedTaskIds, "refinement seed tasks", context);
    requireUniqueCanonical(value.affectedTaskIds, "refinement affected tasks", context);
    requireUniqueCanonical(value.changedTaskHashes, "refinement changed tasks", context);
    if (value.seedTaskIds.some((entry) => !value.affectedTaskIds.includes(entry)))
      context.addIssue({
        code: "custom",
        message: "Every refinement seed must be in its affected closure",
      });
  });

const REUSED_TASK_SCHEMA = z
  .object({ taskId: WORLD_ENTITY_ID_SCHEMA, taskHash: HASH_SCHEMA })
  .strict();

export const REFINEMENT_COMPILATION_EXECUTION_SCHEMA = z
  .object({
    kind: z.literal("RefinementCompilationExecution"),
    inputPlanHash: HASH_SCHEMA,
    previousWorldBuildHash: HASH_SCHEMA.optional(),
    requestedTaskIds: z.array(WORLD_ENTITY_ID_SCHEMA).max(65_536),
    affectedTaskIds: z.array(WORLD_ENTITY_ID_SCHEMA).min(1).max(65_536),
    executedTaskIds: z.array(WORLD_ENTITY_ID_SCHEMA).min(1).max(65_536),
    reusedTasks: z.array(REUSED_TASK_SCHEMA).max(1_000_000),
    outputWorldBuildHash: HASH_SCHEMA,
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyHash(value, context);
    requireUniqueCanonical(value.requestedTaskIds, "requested compilation tasks", context);
    requireUniqueCanonical(value.affectedTaskIds, "affected compilation tasks", context);
    requireUniqueCanonical(value.executedTaskIds, "executed compilation tasks", context);
    requireUniqueCanonical(
      value.reusedTasks.map((entry) => entry.taskId),
      "reused compilation tasks",
      context,
    );
    if (stableJson(value.executedTaskIds) !== stableJson(value.affectedTaskIds))
      context.addIssue({
        code: "custom",
        message: "The executor must report exactly the affected task closure",
      });
    if (value.requestedTaskIds.some((entry) => !value.affectedTaskIds.includes(entry)))
      context.addIssue({
        code: "custom",
        message: "Requested tasks must belong to the affected closure",
      });
    if (value.reusedTasks.some((entry) => value.executedTaskIds.includes(entry.taskId)))
      context.addIssue({ code: "custom", message: "A task cannot be both executed and reused" });
    if ((value.previousWorldBuildHash === undefined) !== (value.requestedTaskIds.length === 0))
      context.addIssue({
        code: "custom",
        message: "Only the initial compile omits a prior build and requested invalidation seeds",
      });
  });
export type RefinementCompilationExecution = z.output<
  typeof REFINEMENT_COMPILATION_EXECUTION_SCHEMA
>;

export const REFINEMENT_OBSERVATION_EXECUTION_SCHEMA = z
  .object({
    kind: z.literal("RefinementObservationExecution"),
    worldBuildHash: HASH_SCHEMA,
    previousObservationHash: HASH_SCHEMA.optional(),
    affectedTaskIds: z.array(WORLD_ENTITY_ID_SCHEMA).min(1).max(65_536),
    executedCheckIds: z.array(WORLD_ENTITY_ID_SCHEMA).min(1).max(65_536),
    executedCameraIds: z.array(WORLD_ENTITY_ID_SCHEMA).max(8),
    reportHash: HASH_SCHEMA,
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyHash(value, context);
    requireUniqueCanonical(value.affectedTaskIds, "observed affected tasks", context);
    requireUniqueCanonical(value.executedCheckIds, "executed observation checks", context);
    requireUniqueCanonical(value.executedCameraIds, "executed diagnostic cameras", context);
  });
export type RefinementObservationExecution = z.output<
  typeof REFINEMENT_OBSERVATION_EXECUTION_SCHEMA
>;

export const REFINEMENT_RUN_SCHEMA = z
  .object({
    kind: z.literal("RefinementRun"),
    status: COMPILATION_STATUS_SCHEMA,
    initialPlanHash: HASH_SCHEMA,
    initialWorldBuildHash: HASH_SCHEMA,
    finalPlanHash: HASH_SCHEMA,
    finalWorldBuildHash: HASH_SCHEMA,
    policyHash: HASH_SCHEMA,
    iterations: z.array(REFINEMENT_ITERATION_SCHEMA).max(16),
    finalObservationHash: HASH_SCHEMA,
    diagnostics: z.array(z.string().trim().min(1).max(1_024)).max(256),
    compilerAuthority: z.literal(false),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyHash(value, context);
    requireUniqueCanonical(value.diagnostics, "refinement diagnostics", context);
    if (value.iterations.some((entry, index) => entry.index !== index))
      context.addIssue({
        code: "custom",
        path: ["iterations"],
        message: "Refinement iteration indices must be contiguous",
      });
  });
export type RefinementRun = z.output<typeof REFINEMENT_RUN_SCHEMA>;

export function sealWorldObservationReport(
  input: Omit<WorldObservationReport, "kind" | "geometricStatus" | "compilerAuthority" | "hash">,
): WorldObservationReport {
  const checks = [...input.checks].sort((left, right) =>
    compareCanonicalStrings(left.checkId, right.checkId),
  );
  const material = {
    kind: "WorldObservationReport" as const,
    ...input,
    geometricStatus: aggregateStatus(checks.map((entry) => entry.status)),
    checks,
    diagnosticRenders: [...input.diagnosticRenders].sort((left, right) =>
      compareCanonicalStrings(left.renderId, right.renderId),
    ),
    visualAssessment: {
      ...input.visualAssessment,
      evidenceHashes: [...new Set(input.visualAssessment.evidenceHashes)].sort(
        compareCanonicalStrings,
      ),
      diagnostics: [...new Set(input.visualAssessment.diagnostics)].sort(compareCanonicalStrings),
    },
    diagnostics: [...new Set(input.diagnostics)].sort(compareCanonicalStrings),
    compilerAuthority: false as const,
  };
  return deepFreezeJson(
    WORLD_OBSERVATION_REPORT_SCHEMA.parse({ ...material, hash: contentHash(stableJson(material)) }),
  );
}

export function sealWorldDiagnosticRender(
  input: Omit<WorldDiagnosticRender, "renderId" | "hash">,
): WorldDiagnosticRender {
  const canonical = {
    ...input,
    geometryEvidenceHashes: [...new Set(input.geometryEvidenceHashes)].sort(
      compareCanonicalStrings,
    ),
  };
  const renderId = `Render_${contentHash(stableJson(canonical)).slice(0, 40)}`;
  const material = { renderId, ...canonical };
  return deepFreezeJson(
    WORLD_DIAGNOSTIC_RENDER_SCHEMA.parse({
      ...material,
      hash: contentHash(stableJson(material)),
    }),
  );
}

export function sealWorldChangeProposal(
  input: Omit<WorldChangeProposal, "kind" | "compilerAuthority" | "hash">,
): WorldChangeProposal {
  const material = {
    kind: "WorldChangeProposal" as const,
    ...input,
    changes: [...input.changes].sort((left, right) =>
      compareCanonicalStrings(changeIdentity(left), changeIdentity(right)),
    ),
    compilerAuthority: false as const,
  };
  return deepFreezeJson(
    WORLD_CHANGE_PROPOSAL_SCHEMA.parse({ ...material, hash: contentHash(stableJson(material)) }),
  );
}

export function sealRefinementPolicy(
  input: Omit<RefinementPolicy, "kind" | "policyHash">,
): RefinementPolicy {
  const material = {
    kind: "RefinementPolicy" as const,
    ...input,
    constructionParameters: [...input.constructionParameters].sort((left, right) =>
      compareCanonicalStrings(
        `${left.programId}:${left.parameterId}`,
        `${right.programId}:${right.parameterId}`,
      ),
    ),
    vegetation: [...input.vegetation].sort((a, b) =>
      compareCanonicalStrings(a.intentId, b.intentId),
    ),
    terrainPaint: input.terrainPaint
      .map((v) => ({
        ...v,
        allowedMaterialIds: [...new Set(v.allowedMaterialIds)].sort(compareCanonicalStrings),
      }))
      .sort((a, b) =>
        compareCanonicalStrings(
          `${a.terrainPlanId}:${a.operationIndex}`,
          `${b.terrainPlanId}:${b.operationIndex}`,
        ),
      ),
    protectedIntentIds: [...new Set(input.protectedIntentIds)].sort(compareCanonicalStrings),
    routeAlternatives: input.routeAlternatives
      .map((entry) => ({
        ...entry,
        alternatives: [...entry.alternatives].sort((left, right) =>
          compareCanonicalStrings(left.alternativeId, right.alternativeId),
        ),
      }))
      .sort((left, right) => compareCanonicalStrings(left.routeId, right.routeId)),
    protectedTaskHashes: [...new Set(input.protectedTaskHashes)].sort(compareCanonicalStrings),
    requiredCheckKinds: [...new Set(input.requiredCheckKinds)].sort(compareCanonicalStrings),
  };
  return deepFreezeJson(
    REFINEMENT_POLICY_SCHEMA.parse({
      ...material,
      policyHash: contentHash(stableJson(material)),
    }),
  );
}

export function sealRefinementRun(
  input: Omit<RefinementRun, "kind" | "compilerAuthority" | "hash">,
): RefinementRun {
  const material = {
    kind: "RefinementRun" as const,
    ...input,
    diagnostics: [...new Set(input.diagnostics)].sort(compareCanonicalStrings),
    compilerAuthority: false as const,
  };
  return deepFreezeJson(
    REFINEMENT_RUN_SCHEMA.parse({ ...material, hash: contentHash(stableJson(material)) }),
  );
}

export function sealRefinementCompilationExecution(
  input: Omit<RefinementCompilationExecution, "kind" | "hash">,
): RefinementCompilationExecution {
  const material = {
    kind: "RefinementCompilationExecution" as const,
    ...input,
    requestedTaskIds: [...new Set(input.requestedTaskIds)].sort(compareCanonicalStrings),
    affectedTaskIds: [...new Set(input.affectedTaskIds)].sort(compareCanonicalStrings),
    executedTaskIds: [...new Set(input.executedTaskIds)].sort(compareCanonicalStrings),
    reusedTasks: [...input.reusedTasks].sort((left, right) =>
      compareCanonicalStrings(left.taskId, right.taskId),
    ),
  };
  return deepFreezeJson(
    REFINEMENT_COMPILATION_EXECUTION_SCHEMA.parse({
      ...material,
      hash: contentHash(stableJson(material)),
    }),
  );
}

export function sealRefinementObservationExecution(
  input: Omit<RefinementObservationExecution, "kind" | "hash">,
): RefinementObservationExecution {
  const material = {
    kind: "RefinementObservationExecution" as const,
    ...input,
    affectedTaskIds: [...new Set(input.affectedTaskIds)].sort(compareCanonicalStrings),
    executedCheckIds: [...new Set(input.executedCheckIds)].sort(compareCanonicalStrings),
    executedCameraIds: [...new Set(input.executedCameraIds)].sort(compareCanonicalStrings),
  };
  return deepFreezeJson(
    REFINEMENT_OBSERVATION_EXECUTION_SCHEMA.parse({
      ...material,
      hash: contentHash(stableJson(material)),
    }),
  );
}

function aggregateStatus(statuses: readonly ("eligible" | "incomplete" | "rejected")[]) {
  return statuses.includes("rejected")
    ? ("rejected" as const)
    : statuses.includes("incomplete")
      ? ("incomplete" as const)
      : ("eligible" as const);
}

function changeIdentity(value: WorldChange): string {
  switch (value.kind) {
    case "construction_parameter":
      return `construction:${value.programId}:${value.parameterId}`;
    case "route_alternative":
      return `route:${value.routeId}`;
    case "vegetation_density":
      return `density:${value.intentId}`;
    case "vegetation_clearings":
      return `clearings:${value.intentId}`;
    case "terrain_paint":
      return `paint:${value.terrainPlanId}:${value.operationIndex}`;
  }
}

function verifyHash(value: Record<string, unknown>, context: z.RefinementCtx): void {
  const material = { ...value };
  delete material.hash;
  if (contentHash(stableJson(material)) !== value.hash)
    context.addIssue({ code: "custom", path: ["hash"], message: "Artifact hash mismatch" });
}

function requireUniqueCanonical(
  values: readonly string[],
  label: string,
  context: z.RefinementCtx,
): void {
  if (
    new Set(values).size !== values.length ||
    stableJson([...values].sort(compareCanonicalStrings)) !== stableJson(values)
  )
    context.addIssue({ code: "custom", message: `${label} must be unique and canonical` });
}
