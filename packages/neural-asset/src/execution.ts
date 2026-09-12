import { z } from "zod";
import { contentHash, stableJson } from "../../contracts/src/index.js";
import { compareSpatialStrings, hashSchema } from "../../spatial-core/src/primitives.js";

export const NEURAL_WORKER_QUALIFICATION_ABI = "basalt-neural-worker-qualification@1" as const;
export const NEURAL_ROUTE_ADMISSION_ABI = "basalt-neural-route-admission@1" as const;
export const NEURAL_INPUT_REFERENCE_ABI = "basalt-neural-input-reference@1" as const;
export const NEURAL_EXECUTION_BUDGET_ABI = "basalt-neural-execution-budget@2" as const;
export const NEURAL_EXECUTION_BUDGET_CLAIM_ABI = "basalt-neural-execution-budget-claim@1" as const;
export const NEURAL_OUTPUT_HANDOFF_ABI = "basalt-neural-output-handoff@1" as const;

export const NEURAL_PROVIDER_IDS = ["trellis2", "pixal3d", "hunyuan3d_2_1"] as const;
export type NeuralProviderId = (typeof NEURAL_PROVIDER_IDS)[number];

const status = z.enum(["eligible", "rejected", "incomplete"]);
const timestamp = z.string().datetime({ offset: true });
const modalImageId = z.string().regex(/^im-[A-Za-z0-9]+$/u);
const artifact = z
  .object({
    locator: z.string().regex(/^binary-artifacts\/[a-f0-9]{64}\.bin$/u),
    artifactHash: hashSchema,
    bytes: z
      .number()
      .int()
      .positive()
      .max(2 * 1024 * 1024 * 1024),
    mediaType: z.string().trim().min(3).max(160),
  })
  .strict()
  .refine(
    (value) => value.locator === `binary-artifacts/${value.artifactHash}.bin`,
    "Neural input locator must identify its exact bytes",
  );

const workerQualificationMaterial = z
  .object({
    kind: z.literal("NeuralWorkerQualification"),
    abi: z.literal(NEURAL_WORKER_QUALIFICATION_ABI),
    provider: z.enum(NEURAL_PROVIDER_IDS),
    runtimeImageId: modalImageId,
    runtimeImageHash: hashSchema,
    sourceCommit: z.string().regex(/^[a-f0-9]{40}$/u),
    modelId: z.string().trim().min(1).max(512),
    modelRevision: z.string().regex(/^[a-f0-9]{40}$/u),
    volumeSnapshotHashes: z.array(hashSchema).min(1).max(16),
    dependencyInventoryHash: hashSchema,
    workerSourceHash: hashSchema,
    probeStatus: status,
    reasons: z.array(z.string().trim().min(1).max(256)).max(32),
    qualifiedAt: timestamp,
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.volumeSnapshotHashes).size !== value.volumeSnapshotHashes.length)
      context.addIssue({
        code: "custom",
        path: ["volumeSnapshotHashes"],
        message: "Neural worker volume snapshots must be unique",
      });
    const ordered = [...value.volumeSnapshotHashes].sort();
    if (stableJson(ordered) !== stableJson(value.volumeSnapshotHashes))
      context.addIssue({
        code: "custom",
        path: ["volumeSnapshotHashes"],
        message: "Neural worker volume snapshots must use canonical order",
      });
    if (value.probeStatus === "eligible" && value.reasons.length > 0)
      context.addIssue({
        code: "custom",
        path: ["reasons"],
        message: "Eligible neural workers cannot retain failure reasons",
      });
    if (value.probeStatus !== "eligible" && value.reasons.length === 0)
      context.addIssue({
        code: "custom",
        path: ["reasons"],
        message: "Non-eligible neural workers require a reason",
      });
  });

export const NEURAL_WORKER_QUALIFICATION_SCHEMA = workerQualificationMaterial.safeExtend({
  hash: hashSchema,
});
export type NeuralWorkerQualification = z.infer<typeof NEURAL_WORKER_QUALIFICATION_SCHEMA>;

export function sealNeuralWorkerQualification(
  input: z.input<typeof workerQualificationMaterial>,
): NeuralWorkerQualification {
  const material = workerQualificationMaterial.parse(input);
  return NEURAL_WORKER_QUALIFICATION_SCHEMA.parse({
    ...material,
    hash: contentHash(stableJson(material)),
  });
}

export function assertNeuralWorkerQualificationIdentity(
  value: unknown,
): asserts value is NeuralWorkerQualification {
  const qualification = NEURAL_WORKER_QUALIFICATION_SCHEMA.parse(value);
  const { hash, ...material } = qualification;
  if (hash !== contentHash(stableJson(material)))
    throw new Error("Neural worker qualification identity is invalid");
}

const routeAdmissionMaterial = z
  .object({
    kind: z.literal("NeuralRouteAdmission"),
    abi: z.literal(NEURAL_ROUTE_ADMISSION_ABI),
    workerQualificationHash: hashSchema,
    provider: z.enum(NEURAL_PROVIDER_IDS),
    capabilityClass: z.string().trim().min(1).max(256),
    usageScope: z.enum(["evaluation", "product"]),
    rightsEvidenceHash: hashSchema,
    pilotEvidenceHash: hashSchema.optional(),
    studioEvidenceHash: hashSchema.optional(),
    status,
    reasons: z.array(z.string().trim().min(1).max(256)).max(32),
    admittedAt: timestamp,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status === "eligible" && value.reasons.length > 0)
      context.addIssue({
        code: "custom",
        path: ["reasons"],
        message: "Eligible admission has reasons",
      });
    if (value.status !== "eligible" && value.reasons.length === 0)
      context.addIssue({
        code: "custom",
        path: ["reasons"],
        message: "Non-eligible admission requires a reason",
      });
    if (
      value.status === "eligible" &&
      value.usageScope === "product" &&
      (!value.pilotEvidenceHash || !value.studioEvidenceHash)
    )
      context.addIssue({
        code: "custom",
        path: ["usageScope"],
        message: "Product neural admission requires pilot and Studio evidence",
      });
  });

export const NEURAL_ROUTE_ADMISSION_SCHEMA = routeAdmissionMaterial.safeExtend({
  hash: hashSchema,
});
export type NeuralRouteAdmission = z.infer<typeof NEURAL_ROUTE_ADMISSION_SCHEMA>;

export function sealNeuralRouteAdmission(
  input: z.input<typeof routeAdmissionMaterial>,
): NeuralRouteAdmission {
  const material = routeAdmissionMaterial.parse(input);
  return NEURAL_ROUTE_ADMISSION_SCHEMA.parse({
    ...material,
    hash: contentHash(stableJson(material)),
  });
}

export function assertNeuralRouteAdmissionIdentity(
  value: unknown,
): asserts value is NeuralRouteAdmission {
  const admission = NEURAL_ROUTE_ADMISSION_SCHEMA.parse(value);
  const { hash, ...material } = admission;
  if (hash !== contentHash(stableJson(material)))
    throw new Error("Neural route admission identity is invalid");
}

const rights = z
  .object({
    usage: z.enum(["creator_owned", "commercial_use_permitted", "evaluation_only"]),
    evidenceHash: hashSchema,
  })
  .strict();

const referenceCommon = {
  abi: z.literal(NEURAL_INPUT_REFERENCE_ABI),
  rgba: artifact.safeExtend({ mediaType: z.literal("image/png") }),
  rights,
};

const creatorInputReferenceMaterial = z
  .object({
    kind: z.literal("NeuralInputReference"),
    origin: z.literal("creator_supplied"),
    ...referenceCommon,
    ingestReceiptHash: hashSchema,
    alphaQualityHash: hashSchema,
  })
  .strict();
const compositionInputReferenceMaterial = z
  .object({
    kind: z.literal("NeuralInputReference"),
    origin: z.literal("composition_crop"),
    ...referenceCommon,
    proposalHash: hashSchema,
    maskId: z.string().trim().min(1).max(512),
    cropSimilarityHash: hashSchema,
  })
  .strict();
const generatedInputReferenceMaterial = z
  .object({
    kind: z.literal("NeuralInputReference"),
    origin: z.literal("generated_isolated"),
    ...referenceCommon,
    referenceArtifactHash: hashSchema,
  })
  .strict();

const inputReferenceMaterial = z.discriminatedUnion("origin", [
  creatorInputReferenceMaterial,
  compositionInputReferenceMaterial,
  generatedInputReferenceMaterial,
]);

export const NEURAL_INPUT_REFERENCE_SCHEMA = z.discriminatedUnion("origin", [
  creatorInputReferenceMaterial.safeExtend({ hash: hashSchema }),
  compositionInputReferenceMaterial.safeExtend({ hash: hashSchema }),
  generatedInputReferenceMaterial.safeExtend({ hash: hashSchema }),
]);
export type NeuralInputReference = z.infer<typeof NEURAL_INPUT_REFERENCE_SCHEMA>;

export function sealNeuralInputReference(
  input: z.input<typeof inputReferenceMaterial>,
): NeuralInputReference {
  const material = inputReferenceMaterial.parse(input);
  return NEURAL_INPUT_REFERENCE_SCHEMA.parse({
    ...material,
    hash: contentHash(stableJson(material)),
  });
}

export function assertNeuralInputReferenceIdentity(
  value: unknown,
): asserts value is NeuralInputReference {
  const reference = NEURAL_INPUT_REFERENCE_SCHEMA.parse(value);
  const { hash, ...material } = reference;
  if (hash !== contentHash(stableJson(material)))
    throw new Error("Neural input reference identity is invalid");
}

const executionBudgetClaimMaterial = z
  .object({
    kind: z.literal("NeuralExecutionBudgetClaim"),
    abi: z.literal(NEURAL_EXECUTION_BUDGET_CLAIM_ABI),
    requestHash: hashSchema,
    provider: z.enum(NEURAL_PROVIDER_IDS),
    phase: z.enum(["smoke", "pilot", "production"]),
    estimatedCostMicrousd: z.number().int().positive().max(10_000_000_000),
    reservedGpuSeconds: z
      .number()
      .int()
      .positive()
      .max(7 * 24 * 60 * 60),
    budgetHashBefore: hashSchema,
    claimedAt: timestamp,
  })
  .strict();

export const NEURAL_EXECUTION_BUDGET_CLAIM_SCHEMA = executionBudgetClaimMaterial.safeExtend({
  hash: hashSchema,
});
export type NeuralExecutionBudgetClaim = z.infer<typeof NEURAL_EXECUTION_BUDGET_CLAIM_SCHEMA>;

export function sealNeuralExecutionBudgetClaim(
  input: z.input<typeof executionBudgetClaimMaterial>,
): NeuralExecutionBudgetClaim {
  const material = executionBudgetClaimMaterial.parse(input);
  return NEURAL_EXECUTION_BUDGET_CLAIM_SCHEMA.parse({
    ...material,
    hash: contentHash(stableJson(material)),
  });
}

export function assertNeuralExecutionBudgetClaimIdentity(
  value: unknown,
): asserts value is NeuralExecutionBudgetClaim {
  const claim = NEURAL_EXECUTION_BUDGET_CLAIM_SCHEMA.parse(value);
  const { hash, ...material } = claim;
  if (hash !== contentHash(stableJson(material)))
    throw new Error("Neural execution budget-claim identity is invalid");
}

const executionBudgetMaterial = z
  .object({
    kind: z.literal("NeuralExecutionBudget"),
    abi: z.literal(NEURAL_EXECUTION_BUDGET_ABI),
    maximumCostMicrousd: z.number().int().positive().max(10_000_000_000),
    maximumGpuSeconds: z
      .number()
      .int()
      .positive()
      .max(7 * 24 * 60 * 60),
    maximumPaidAttempts: z.number().int().positive().max(1_000),
    claims: z.array(NEURAL_EXECUTION_BUDGET_CLAIM_SCHEMA).max(1_000),
  })
  .strict()
  .superRefine((value, context) => {
    const requestHashes = value.claims.map(({ requestHash }) => requestHash);
    const canonical = [...new Set(requestHashes)].sort();
    if (
      stableJson(canonical) !== stableJson(requestHashes) ||
      value.claims.some((claim, index) => claim.requestHash !== canonical[index])
    )
      context.addIssue({
        code: "custom",
        path: ["claims"],
        message: "Neural execution claims must be unique and canonical by request hash",
      });
    if (value.claims.length > value.maximumPaidAttempts)
      context.addIssue({
        code: "custom",
        path: ["claims"],
        message: "Neural execution claims exceed the paid-attempt ceiling",
      });
    const cost = value.claims.reduce((total, claim) => total + claim.estimatedCostMicrousd, 0);
    if (cost > value.maximumCostMicrousd)
      context.addIssue({
        code: "custom",
        path: ["claims"],
        message: "Neural execution claims exceed the cost ceiling",
      });
    const gpuSeconds = value.claims.reduce((total, claim) => total + claim.reservedGpuSeconds, 0);
    if (gpuSeconds > value.maximumGpuSeconds)
      context.addIssue({
        code: "custom",
        path: ["claims"],
        message: "Neural execution claims exceed the GPU-time ceiling",
      });
    for (const [index, claim] of value.claims.entries()) {
      try {
        assertNeuralExecutionBudgetClaimIdentity(claim);
      } catch {
        context.addIssue({
          code: "custom",
          path: ["claims", index],
          message: "Neural execution claim identity is invalid",
        });
      }
    }
  });

export const NEURAL_EXECUTION_BUDGET_SCHEMA = executionBudgetMaterial.safeExtend({
  hash: hashSchema,
});
export type NeuralExecutionBudget = z.infer<typeof NEURAL_EXECUTION_BUDGET_SCHEMA>;

export function sealNeuralExecutionBudget(
  input: z.input<typeof executionBudgetMaterial>,
): NeuralExecutionBudget {
  const material = executionBudgetMaterial.parse(input);
  return NEURAL_EXECUTION_BUDGET_SCHEMA.parse({
    ...material,
    hash: contentHash(stableJson(material)),
  });
}

export function assertNeuralExecutionBudgetIdentity(
  value: unknown,
): asserts value is NeuralExecutionBudget {
  const budget = NEURAL_EXECUTION_BUDGET_SCHEMA.parse(value);
  const { hash, ...material } = budget;
  if (hash !== contentHash(stableJson(material)))
    throw new Error("Neural execution budget identity is invalid");
}

export type NeuralExecutionBudgetClaimResult =
  | {
      readonly status: "claimed" | "already_claimed";
      readonly budget: NeuralExecutionBudget;
      readonly claim: NeuralExecutionBudgetClaim;
    }
  | {
      readonly status: "incomplete";
      readonly budget: NeuralExecutionBudget;
      readonly code: "paid_attempt_limit" | "cost_limit" | "gpu_time_limit";
    };

/**
 * Reserve one paid attempt before contacting a provider. The returned budget
 * is a new immutable identity. Callers must durably retain both it and the
 * claim before invoking Modal; an already-claimed request is never retried.
 */
export function claimNeuralExecutionBudget(
  budget: NeuralExecutionBudget,
  input: {
    readonly requestHash: string;
    readonly provider: NeuralProviderId;
    readonly phase: "smoke" | "pilot" | "production";
    readonly estimatedCostMicrousd: number;
    readonly reservedGpuSeconds: number;
    readonly claimedAt: string;
  },
): NeuralExecutionBudgetClaimResult {
  assertNeuralExecutionBudgetIdentity(budget);
  const requestHash = hashSchema.parse(input.requestHash);
  const existing = budget.claims.find((claim) => claim.requestHash === requestHash);
  if (existing) {
    if (
      existing.provider !== input.provider ||
      existing.phase !== input.phase ||
      existing.estimatedCostMicrousd !== input.estimatedCostMicrousd ||
      existing.reservedGpuSeconds !== input.reservedGpuSeconds
    )
      throw new Error("A neural request cannot be rebound to a different budget claim");
    return { status: "already_claimed", budget, claim: existing };
  }

  if (budget.claims.length >= budget.maximumPaidAttempts)
    return { status: "incomplete", budget, code: "paid_attempt_limit" };
  const consumedCost = budget.claims.reduce(
    (total, claim) => total + claim.estimatedCostMicrousd,
    0,
  );
  if (consumedCost + input.estimatedCostMicrousd > budget.maximumCostMicrousd)
    return { status: "incomplete", budget, code: "cost_limit" };
  const consumedGpuSeconds = budget.claims.reduce(
    (total, claim) => total + claim.reservedGpuSeconds,
    0,
  );
  if (consumedGpuSeconds + input.reservedGpuSeconds > budget.maximumGpuSeconds)
    return { status: "incomplete", budget, code: "gpu_time_limit" };

  const claim = sealNeuralExecutionBudgetClaim({
    kind: "NeuralExecutionBudgetClaim",
    abi: NEURAL_EXECUTION_BUDGET_CLAIM_ABI,
    requestHash,
    provider: input.provider,
    phase: input.phase,
    estimatedCostMicrousd: input.estimatedCostMicrousd,
    reservedGpuSeconds: input.reservedGpuSeconds,
    budgetHashBefore: budget.hash,
    claimedAt: input.claimedAt,
  });
  const next = sealNeuralExecutionBudget({
    kind: "NeuralExecutionBudget",
    abi: NEURAL_EXECUTION_BUDGET_ABI,
    maximumCostMicrousd: budget.maximumCostMicrousd,
    maximumGpuSeconds: budget.maximumGpuSeconds,
    maximumPaidAttempts: budget.maximumPaidAttempts,
    claims: [...budget.claims, claim].sort((left, right) =>
      compareSpatialStrings(left.requestHash, right.requestHash),
    ),
  });
  return { status: "claimed", budget: next, claim };
}

export function assertNeuralExecutionClaimsAuthorized(
  retainedBudget: NeuralExecutionBudget,
  claims: readonly NeuralExecutionBudgetClaim[],
): void {
  assertNeuralExecutionBudgetIdentity(retainedBudget);
  const retainedByRequest = new Map(
    retainedBudget.claims.map((claim) => [claim.requestHash, claim] as const),
  );
  const seen = new Set<string>();
  for (const claim of claims) {
    assertNeuralExecutionBudgetClaimIdentity(claim);
    if (seen.has(claim.requestHash))
      throw new Error("A neural execution batch cannot repeat a paid request");
    seen.add(claim.requestHash);
    const retained = retainedByRequest.get(claim.requestHash);
    if (!retained || retained.hash !== claim.hash)
      throw new Error("Neural execution requires an exact durably retained budget claim");
  }
}

const outputHandoffMaterial = z
  .object({
    kind: z.literal("NeuralOutputHandoff"),
    abi: z.literal(NEURAL_OUTPUT_HANDOFF_ABI),
    provider: z.enum(NEURAL_PROVIDER_IDS),
    requestHash: hashSchema,
    outputVolumeName: z.string().regex(/^basalt-neural-output$/u),
    remotePath: z.string().regex(/^[a-f0-9]{64}\/(candidate\.safetensors|worker-result\.json)$/u),
    sha256: hashSchema,
    bytes: z
      .number()
      .int()
      .positive()
      .max(2 * 1024 * 1024 * 1024),
    workerReportHash: hashSchema,
    runtimeImageId: modalImageId,
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.remotePath.startsWith(`${value.requestHash}/`))
      context.addIssue({
        code: "custom",
        path: ["remotePath"],
        message: "Neural output path must be scoped by the exact request hash",
      });
  });

export const NEURAL_OUTPUT_HANDOFF_SCHEMA = outputHandoffMaterial.safeExtend({ hash: hashSchema });
export type NeuralOutputHandoff = z.infer<typeof NEURAL_OUTPUT_HANDOFF_SCHEMA>;

export function sealNeuralOutputHandoff(
  input: z.input<typeof outputHandoffMaterial>,
): NeuralOutputHandoff {
  const material = outputHandoffMaterial.parse(input);
  return NEURAL_OUTPUT_HANDOFF_SCHEMA.parse({
    ...material,
    hash: contentHash(stableJson(material)),
  });
}

export function assertNeuralOutputHandoffIdentity(
  value: unknown,
): asserts value is NeuralOutputHandoff {
  const handoff = NEURAL_OUTPUT_HANDOFF_SCHEMA.parse(value);
  const { hash, ...material } = handoff;
  if (hash !== contentHash(stableJson(material)))
    throw new Error("Neural output handoff identity is invalid");
}

export type NeuralExecutionOutcome<Receipt> =
  | {
      readonly status: "eligible";
      readonly handoff: NeuralOutputHandoff;
      readonly receipt: Receipt;
    }
  | { readonly status: "rejected" | "incomplete"; readonly code: string };

export interface NeuralExecutionTransport<Request, Receipt> {
  findCompleted(requestHash: string): Promise<NeuralExecutionOutcome<Receipt> | undefined>;
  executeClaimedBatch(
    requests: readonly {
      readonly request: Request;
      readonly requestHash: string;
      readonly claim: NeuralExecutionBudgetClaim;
    }[],
    retainedBudget: NeuralExecutionBudget,
  ): Promise<readonly NeuralExecutionOutcome<Receipt>[]>;
}
