import { z } from "zod";
import {
  ASCII_ID_SCHEMA,
  HASH_SCHEMA,
  Q32_32_SCHEMA,
  compareCanonicalStrings,
  contentAddressedEntityId,
  contentHash,
  deepFreezeJson,
  parseQ32_32,
  stableJson,
  type Diagnostic,
  type GateResult,
} from "@basalt/contracts";
import {
  CATALOG_REQUIREMENT_SCHEMA,
  CATALOG_RESOLUTION_PLAN_SCHEMA,
  ENTRY_HANDLE_SCHEMA,
  RESOLVED_CATALOG_BINDING_SCHEMA,
  SEALED_STYLE_PROFILE_SCHEMA,
  type CatalogRequirement,
  type CatalogResolutionPlan,
  type CatalogSnapshot,
  type SealedStyleProfile,
} from "@basalt/catalog-model";

const positiveMeters = Q32_32_SCHEMA.refine((value) => parseQ32_32(value) > 0n, {
  message: "Expected bounds must be positive meters",
});

export const ASSET_FULFILLMENT_OPERATION_SCHEMA = z.enum([
  "generate_geometry_and_materials",
  "restyle_materials",
]);
export type AssetFulfillmentOperation = z.output<typeof ASSET_FULFILLMENT_OPERATION_SCHEMA>;

export const ASSET_FULFILLMENT_JOB_SCHEMA = z
  .object({
    kind: z.literal("AssetFulfillmentJob"),
    jobId: z.string().regex(/^AssetFulfillmentJob_[a-f0-9]{44}$/u),
    operation: ASSET_FULFILLMENT_OPERATION_SCHEMA,
    memberId: z.string().regex(/^[a-z][a-z0-9_]{0,127}$/u),
    semanticDependencyClosureHash: HASH_SCHEMA,
    styleProfileHash: HASH_SCHEMA,
    referenceImageArtifactHash: HASH_SCHEMA,
    sourceAssetHash: HASH_SCHEMA.optional(),
    expectedBoundsMeters: z
      .object({ x: positiveMeters, y: positiveMeters, z: positiveMeters })
      .strict(),
    seed: z.number().int().nonnegative().max(0xffff_ffff),
    jobHash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.operation === "restyle_materials" && !value.sourceAssetHash)
      context.addIssue({
        code: "custom",
        path: ["sourceAssetHash"],
        message: "Material restyling requires exact source geometry",
      });
    if (value.operation === "generate_geometry_and_materials" && value.sourceAssetHash)
      context.addIssue({
        code: "custom",
        path: ["sourceAssetHash"],
        message: "Full generation cannot retain unowned source geometry",
      });
    const { jobId: _jobId, jobHash: _jobHash, ...material } = value;
    if (contentAddressedEntityId("AssetFulfillmentJob", material) !== value.jobId)
      context.addIssue({ code: "custom", path: ["jobId"], message: "Job ID mismatch" });
    if (contentHash(stableJson(material)) !== value.jobHash)
      context.addIssue({ code: "custom", path: ["jobHash"], message: "Job hash mismatch" });
  });
export type AssetFulfillmentJob = z.output<typeof ASSET_FULFILLMENT_JOB_SCHEMA>;

const reuseOutcome = z
  .object({
    strategy: z.literal("reuse_binding"),
    binding: RESOLVED_CATALOG_BINDING_SCHEMA,
    bindingHash: HASH_SCHEMA,
  })
  .strict();
const restyleOutcome = z
  .object({
    strategy: z.literal("restyle_asset"),
    sourceEntryHandle: ENTRY_HANDLE_SCHEMA,
    sourceEntryHash: HASH_SCHEMA,
    targetEntryHandle: ENTRY_HANDLE_SCHEMA,
    jobs: z.array(ASSET_FULFILLMENT_JOB_SCHEMA).min(1),
  })
  .strict();
const extendOutcome = z
  .object({
    strategy: z.literal("extend_substitution_set"),
    targetEntryHandle: ENTRY_HANDLE_SCHEMA,
    targetEntryHash: HASH_SCHEMA,
    jobs: z.array(ASSET_FULFILLMENT_JOB_SCHEMA).min(1),
  })
  .strict();
const synthesizeOutcome = z
  .object({
    strategy: z.literal("synthesize_substitution_set"),
    targetEntryHandle: ENTRY_HANDLE_SCHEMA,
    targetEntryKind: z.literal("substitution_set"),
    jobs: z.array(ASSET_FULFILLMENT_JOB_SCHEMA).min(1),
  })
  .strict();

export const CATALOG_FULFILLMENT_OUTCOME_SCHEMA = z.discriminatedUnion("strategy", [
  reuseOutcome,
  restyleOutcome,
  extendOutcome,
  synthesizeOutcome,
]);
export type CatalogFulfillmentOutcome = z.output<typeof CATALOG_FULFILLMENT_OUTCOME_SCHEMA>;

export const CATALOG_FULFILLMENT_PLAN_SCHEMA = z
  .object({
    kind: z.literal("CatalogFulfillmentPlan"),
    planId: z.string().regex(/^CatalogFulfillmentPlan_[a-f0-9]{41}$/u),
    requirementHash: HASH_SCHEMA,
    catalogSnapshotHash: HASH_SCHEMA,
    semanticDependencyClosureHash: HASH_SCHEMA,
    styleProfileHash: HASH_SCHEMA,
    outcome: CATALOG_FULFILLMENT_OUTCOME_SCHEMA,
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    const { planId: _planId, hash: _hash, ...material } = value;
    if (contentAddressedEntityId("CatalogFulfillmentPlan", material) !== value.planId)
      context.addIssue({ code: "custom", path: ["planId"], message: "Plan ID mismatch" });
    if (contentHash(stableJson(material)) !== value.hash)
      context.addIssue({ code: "custom", path: ["hash"], message: "Plan hash mismatch" });
    if (
      value.outcome.strategy !== "reuse_binding" &&
      value.outcome.jobs.some(
        (job) =>
          job.semanticDependencyClosureHash !== value.semanticDependencyClosureHash ||
          job.styleProfileHash !== value.styleProfileHash,
      )
    )
      context.addIssue({
        code: "custom",
        path: ["outcome", "jobs"],
        message: "Every fulfillment job must bind the plan semantics and style",
      });
  });
export type CatalogFulfillmentPlan = z.output<typeof CATALOG_FULFILLMENT_PLAN_SCHEMA>;

export interface PlanCatalogFulfillmentInput {
  readonly requirement: CatalogRequirement;
  readonly resolution: CatalogResolutionPlan;
  readonly snapshot: CatalogSnapshot;
  readonly styleProfile: SealedStyleProfile;
  readonly targetEntryHandle: string;
  readonly referenceImageArtifactHash: string;
  readonly expectedBoundsMeters: { readonly x: string; readonly y: string; readonly z: string };
  readonly desiredMemberCount: number;
}

/**
 * Turn one exact resolver outcome into an offline catalog-acquisition plan.
 * Semantic and evidence gaps are never hidden by generation: they require an
 * authoring decision before a provider can be selected.
 */
export function planCatalogFulfillment(
  rawInput: PlanCatalogFulfillmentInput,
): GateResult<CatalogFulfillmentPlan> {
  const requirement = CATALOG_REQUIREMENT_SCHEMA.parse(rawInput.requirement);
  const resolution = CATALOG_RESOLUTION_PLAN_SCHEMA.parse(rawInput.resolution);
  const styleProfile = SEALED_STYLE_PROFILE_SCHEMA.parse(rawInput.styleProfile);
  const targetEntryHandle = ENTRY_HANDLE_SCHEMA.parse(rawInput.targetEntryHandle);
  const referenceImageArtifactHash = HASH_SCHEMA.parse(rawInput.referenceImageArtifactHash);
  const expectedBoundsMeters = z
    .object({ x: positiveMeters, y: positiveMeters, z: positiveMeters })
    .strict()
    .parse(rawInput.expectedBoundsMeters);
  if (
    !Number.isSafeInteger(rawInput.desiredMemberCount) ||
    rawInput.desiredMemberCount < 1 ||
    rawInput.desiredMemberCount > 4096
  )
    throw new Error("Desired member count must be an integer from 1 through 4096");
  const requirementHash = contentHash(stableJson(requirement));
  if (
    resolution.catalogSnapshotHash !== rawInput.snapshot.hash ||
    resolution.requirementsHash !== contentHash(stableJson([requirement]))
  )
    return incomplete(
      "fulfillment_input_mismatch",
      "Fulfillment inputs do not bind one catalog resolution graph",
    );
  if (
    requirement.styleProfileHandles.length > 0 &&
    !requirement.styleProfileHandles.includes(styleProfile.handle)
  )
    return incomplete(
      "style_profile_not_requested",
      "The fulfillment style profile is outside the exact catalog requirement",
    );

  const binding = resolution.bindings.find(
    (candidate) => candidate.requirementId === requirement.requirementId,
  );
  if (binding) {
    return eligible(
      sealCatalogFulfillmentPlan({
        requirementHash,
        catalogSnapshotHash: rawInput.snapshot.hash,
        semanticDependencyClosureHash: requirement.semantic.dependencyClosureHash,
        styleProfileHash: styleProfile.hash,
        outcome: {
          strategy: "reuse_binding",
          binding,
          bindingHash: contentHash(stableJson(binding)),
        },
      }),
    );
  }

  const gap = resolution.gaps.find(
    (candidate) => candidate.requirementId === requirement.requirementId,
  );
  if (!gap)
    return incomplete("resolution_outcome_missing", "The requirement has no binding or typed gap");
  if (gap.kind === "semantic_gap")
    return incomplete(
      "semantic_authority_required",
      "Neural generation cannot repair an invalid or unknown semantic commitment",
    );
  if (gap.kind === "evidence_gap")
    return incomplete(
      "evidence_required",
      "Existing evidence must be adjudicated before generating replacement geometry",
    );

  const entries = new Map(rawInput.snapshot.entries.map((entry) => [entry.handle, entry] as const));
  const rejected = [...gap.rejectedCandidates].sort((left, right) =>
    compareCanonicalStrings(left.entryHandle, right.entryHandle),
  );
  const styleCandidate = rejected.find(
    (candidate) =>
      candidate.reasons.length > 0 &&
      candidate.reasons.every((reason) => reason === "style_profile"),
  );
  if (styleCandidate) {
    const entry = entries.get(styleCandidate.entryHandle);
    if (entry && entry.kind !== "collection" && entry.memberAssets.length > 0) {
      const sources = entry.memberAssets
        .sort((left, right) => compareCanonicalStrings(left.memberId, right.memberId))
        .slice(0, rawInput.desiredMemberCount);
      const jobs = sources.map((source, ordinal) =>
        createJob({
          operation: "restyle_materials",
          memberId: memberId(ordinal),
          semanticDependencyClosureHash: requirement.semantic.dependencyClosureHash,
          styleProfileHash: styleProfile.hash,
          referenceImageArtifactHash,
          sourceAssetHash: source.assetHash,
          expectedBoundsMeters,
          seedMaterial: {
            requirementHash,
            targetEntryHandle,
            sourceAssetHash: source.assetHash,
          },
        }),
      );
      jobs.push(...generationJobs(rawInput.desiredMemberCount - sources.length, sources.length));
      return eligible(
        sealCatalogFulfillmentPlan({
          requirementHash,
          catalogSnapshotHash: rawInput.snapshot.hash,
          semanticDependencyClosureHash: requirement.semantic.dependencyClosureHash,
          styleProfileHash: styleProfile.hash,
          outcome: {
            strategy: "restyle_asset",
            sourceEntryHandle: entry.handle,
            sourceEntryHash: entry.entryHash,
            targetEntryHandle,
            jobs,
          },
        }),
      );
    }
  }

  const extendCandidate = rejected.find((candidate) =>
    candidate.reasons.every((reason) =>
      [
        "member_constraints",
        "metric_bounds",
        "commercial_rights",
        "redistribution_rights",
        "triangle_budget",
        "source_byte_budget",
      ].includes(reason),
    ),
  );
  if (extendCandidate) {
    const entry = entries.get(extendCandidate.entryHandle);
    if (entry?.kind === "substitution_set")
      return eligible(
        sealCatalogFulfillmentPlan({
          requirementHash,
          catalogSnapshotHash: rawInput.snapshot.hash,
          semanticDependencyClosureHash: requirement.semantic.dependencyClosureHash,
          styleProfileHash: styleProfile.hash,
          outcome: {
            strategy: "extend_substitution_set",
            targetEntryHandle: entry.handle,
            targetEntryHash: entry.entryHash,
            jobs: generationJobs(rawInput.desiredMemberCount),
          },
        }),
      );
  }

  if (!requirement.acceptedEntryKinds.includes("substitution_set"))
    return incomplete(
      "authored_entry_contract_required",
      "Only independent whole-object substitution sets can be synthesized without authored attachment, assembly, route, or environment semantics",
    );
  return eligible(
    sealCatalogFulfillmentPlan({
      requirementHash,
      catalogSnapshotHash: rawInput.snapshot.hash,
      semanticDependencyClosureHash: requirement.semantic.dependencyClosureHash,
      styleProfileHash: styleProfile.hash,
      outcome: {
        strategy: "synthesize_substitution_set",
        targetEntryHandle,
        targetEntryKind: "substitution_set",
        jobs: generationJobs(rawInput.desiredMemberCount),
      },
    }),
  );

  function generationJobs(count: number, startOrdinal = 0): AssetFulfillmentJob[] {
    return Array.from({ length: count }, (_, ordinal) =>
      createJob({
        operation: "generate_geometry_and_materials",
        memberId: memberId(startOrdinal + ordinal),
        semanticDependencyClosureHash: requirement.semantic.dependencyClosureHash,
        styleProfileHash: styleProfile.hash,
        referenceImageArtifactHash,
        expectedBoundsMeters,
        seedMaterial: { requirementHash, targetEntryHandle, ordinal: startOrdinal + ordinal },
      }),
    );
  }
}

export function sealAssetFulfillmentJob(
  input: Omit<AssetFulfillmentJob, "kind" | "jobId" | "jobHash">,
): AssetFulfillmentJob {
  const material = { kind: "AssetFulfillmentJob" as const, ...input };
  return deepFreezeJson(
    ASSET_FULFILLMENT_JOB_SCHEMA.parse({
      ...material,
      jobId: contentAddressedEntityId("AssetFulfillmentJob", material),
      jobHash: contentHash(stableJson(material)),
    }),
  ) as AssetFulfillmentJob;
}

export function sealCatalogFulfillmentPlan(
  input: Omit<CatalogFulfillmentPlan, "kind" | "planId" | "hash">,
): CatalogFulfillmentPlan {
  const outcome =
    input.outcome.strategy === "reuse_binding"
      ? input.outcome
      : {
          ...input.outcome,
          jobs: [...input.outcome.jobs].sort((left, right) =>
            compareCanonicalStrings(left.jobId, right.jobId),
          ),
        };
  const material = { kind: "CatalogFulfillmentPlan" as const, ...input, outcome };
  return deepFreezeJson(
    CATALOG_FULFILLMENT_PLAN_SCHEMA.parse({
      ...material,
      planId: contentAddressedEntityId("CatalogFulfillmentPlan", material),
      hash: contentHash(stableJson(material)),
    }),
  ) as CatalogFulfillmentPlan;
}

function createJob(input: {
  readonly operation: AssetFulfillmentOperation;
  readonly memberId: string;
  readonly semanticDependencyClosureHash: string;
  readonly styleProfileHash: string;
  readonly referenceImageArtifactHash: string;
  readonly sourceAssetHash?: string;
  readonly expectedBoundsMeters: { readonly x: string; readonly y: string; readonly z: string };
  readonly seedMaterial: unknown;
}): AssetFulfillmentJob {
  return sealAssetFulfillmentJob({
    operation: input.operation,
    memberId: input.memberId,
    semanticDependencyClosureHash: input.semanticDependencyClosureHash,
    styleProfileHash: input.styleProfileHash,
    referenceImageArtifactHash: input.referenceImageArtifactHash,
    ...(input.sourceAssetHash ? { sourceAssetHash: input.sourceAssetHash } : {}),
    expectedBoundsMeters: input.expectedBoundsMeters,
    seed: Number.parseInt(contentHash(stableJson(input.seedMaterial)).slice(0, 8), 16),
  });
}

function memberId(ordinal: number): string {
  return `generated_${String(ordinal + 1).padStart(4, "0")}`;
}

function diagnostic(code: string, message: string): Diagnostic {
  return { code: ASCII_ID_SCHEMA.parse(code), message, path: [], evidenceHashes: [] };
}

function incomplete(code: string, message: string): GateResult<never> {
  return { status: "incomplete", diagnostics: [diagnostic(code, message)] };
}

function eligible<T>(value: T): GateResult<T> {
  return { status: "eligible", value, diagnostics: [] };
}
