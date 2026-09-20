import { z } from "zod";
import {
  HASH_SCHEMA,
  compareCanonicalStrings,
  contentAddressedEntityId,
  contentHash,
  deepFreezeJson,
  stableJson,
} from "@basalt/contracts";
import { ASSET_FACTORY_REQUEST_SCHEMA } from "@basalt/asset-factory";
import { NEURAL_MESH_TENSOR_PAYLOAD_SCHEMA } from "./mesh-attribute-tensor.js";

export const NEURAL_PROVIDER_IDS = ["trellis2", "hunyuan3d_2_1", "pixal3d"] as const;
export const NEURAL_PROVIDER_ID_SCHEMA = z.enum(NEURAL_PROVIDER_IDS);
export type NeuralProviderId = z.output<typeof NEURAL_PROVIDER_ID_SCHEMA>;

export const NEURAL_PROVIDER_CAPABILITY_SCHEMA = z.enum(["image_to_3d", "material_restyle"]);
export type NeuralProviderCapability = z.output<typeof NEURAL_PROVIDER_CAPABILITY_SCHEMA>;

const externalRevision = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);

const canonicalHashes = z.array(HASH_SCHEMA).superRefine((values, context) => {
  if (
    new Set(values).size !== values.length ||
    stableJson([...values].sort(compareCanonicalStrings)) !== stableJson(values)
  )
    context.addIssue({ code: "custom", message: "Hashes must be unique and canonical" });
});

export const NEURAL_PROVIDER_DECLARATION_SCHEMA = z
  .object({
    kind: z.literal("NeuralProviderDeclaration"),
    providerId: NEURAL_PROVIDER_ID_SCHEMA,
    modelId: z.string().trim().min(1).max(512),
    sourceCommitHash: externalRevision,
    modelRevisionHash: externalRevision,
    capabilities: z.array(NEURAL_PROVIDER_CAPABILITY_SCHEMA).min(1).max(2),
    minimumGpuMemoryMiB: z
      .number()
      .int()
      .positive()
      .max(1024 * 1024)
      .optional(),
    usageScope: z.enum(["research", "production"]),
    status: z.enum(["eligible", "incomplete", "rejected"]),
    diagnostics: z.array(z.string().trim().min(1).max(1024)),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.status === "eligible") === value.diagnostics.length > 0)
      context.addIssue({
        code: "custom",
        path: ["diagnostics"],
        message: "Eligible providers have no diagnostics; unavailable providers require them",
      });
    const canonicalCapabilities = [...value.capabilities].sort(compareCanonicalStrings);
    if (
      new Set(canonicalCapabilities).size !== canonicalCapabilities.length ||
      stableJson(canonicalCapabilities) !== stableJson(value.capabilities)
    )
      context.addIssue({
        code: "custom",
        path: ["capabilities"],
        message: "Provider capabilities must be unique and canonical",
      });
    verifyHash(value, context);
  });
export type NeuralProviderDeclaration = z.output<typeof NEURAL_PROVIDER_DECLARATION_SCHEMA>;

export const NEURAL_WORKER_QUALIFICATION_SCHEMA = z
  .object({
    kind: z.literal("NeuralWorkerQualification"),
    providerId: NEURAL_PROVIDER_ID_SCHEMA,
    providerDeclarationHash: HASH_SCHEMA,
    workerImplementationHash: HASH_SCHEMA,
    runtimeEnvironmentHash: HASH_SCHEMA,
    sourceCommitHash: externalRevision,
    modelRevisionHash: externalRevision,
    hardwareEvidenceHash: HASH_SCHEMA,
    dependencyInventoryHash: HASH_SCHEMA,
    rightsEvidenceHash: HASH_SCHEMA,
    status: z.enum(["eligible", "incomplete", "rejected"]),
    diagnostics: z.array(z.string().trim().min(1).max(1024)),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.status === "eligible") === value.diagnostics.length > 0)
      context.addIssue({
        code: "custom",
        path: ["diagnostics"],
        message: "Eligible qualifications have no diagnostics; unavailable ones require them",
      });
    verifyHash(value, context);
  });
export type NeuralWorkerQualification = z.output<typeof NEURAL_WORKER_QUALIFICATION_SCHEMA>;

const binaryArtifact = z
  .object({
    artifactHash: HASH_SCHEMA,
    bytes: z
      .number()
      .int()
      .positive()
      .max(2 * 1024 * 1024 * 1024),
    mediaType: z.string().regex(/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/u),
  })
  .strict();

export const NEURAL_INPUT_REFERENCE_SCHEMA = z
  .object({
    kind: z.literal("NeuralInputReference"),
    origin: z.enum(["creator_supplied", "composition_crop", "generated_isolated"]),
    artifact: binaryArtifact.extend({ mediaType: z.literal("image/png") }).strict(),
    rightsEvidenceHash: HASH_SCHEMA,
    preparationEvidenceHashes: canonicalHashes,
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => verifyHash(value, context));
export type NeuralInputReference = z.output<typeof NEURAL_INPUT_REFERENCE_SCHEMA>;

export const NEURAL_ASSET_GENERATION_REQUEST_SCHEMA = z
  .object({
    kind: z.literal("NeuralAssetGenerationRequest"),
    requestId: z.string().regex(/^NeuralAssetGenerationRequest_[a-f0-9]{35}$/u),
    factoryRequest: ASSET_FACTORY_REQUEST_SCHEMA,
    providerId: NEURAL_PROVIDER_ID_SCHEMA,
    providerDeclarationHash: HASH_SCHEMA,
    qualificationHash: HASH_SCHEMA,
    operation: z.enum(["generate_geometry_and_materials", "restyle_materials"]),
    reference: NEURAL_INPUT_REFERENCE_SCHEMA,
    sourceGeometryArtifact: binaryArtifact
      .extend({ mediaType: z.literal("model/gltf-binary") })
      .strict()
      .optional(),
    seed: z.number().int().nonnegative().max(0xffff_ffff),
    requestHash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.factoryRequest.job.operation !== value.operation)
      context.addIssue({
        code: "custom",
        path: ["operation"],
        message: "Generation operation must match the factory job",
      });
    if (
      value.factoryRequest.job.referenceImageArtifactHash !== value.reference.artifact.artifactHash
    )
      context.addIssue({
        code: "custom",
        path: ["reference"],
        message: "Generation reference must match the factory job",
      });
    if ((value.operation === "restyle_materials") !== (value.sourceGeometryArtifact !== undefined))
      context.addIssue({
        code: "custom",
        path: ["sourceGeometryArtifact"],
        message: "Only material restyling receives exact source geometry",
      });
    const { requestId: _requestId, requestHash: _requestHash, ...material } = value;
    if (contentAddressedEntityId("NeuralAssetGenerationRequest", material) !== value.requestId)
      context.addIssue({ code: "custom", path: ["requestId"], message: "Request ID mismatch" });
    if (contentHash(stableJson(material)) !== value.requestHash)
      context.addIssue({ code: "custom", path: ["requestHash"], message: "Request hash mismatch" });
  });
export type NeuralAssetGenerationRequest = z.output<typeof NEURAL_ASSET_GENERATION_REQUEST_SCHEMA>;

export const NEURAL_ASSET_GENERATION_RECEIPT_SCHEMA = z
  .object({
    kind: z.literal("NeuralAssetGenerationReceipt"),
    requestHash: HASH_SCHEMA,
    providerId: NEURAL_PROVIDER_ID_SCHEMA,
    providerDeclarationHash: HASH_SCHEMA,
    qualificationHash: HASH_SCHEMA,
    workerImplementationHash: HASH_SCHEMA,
    modelRevisionHash: externalRevision,
    status: z.enum(["eligible", "incomplete", "rejected"]),
    meshPayload: NEURAL_MESH_TENSOR_PAYLOAD_SCHEMA.optional(),
    materialArtifact: binaryArtifact.optional(),
    lineageEvidenceHashes: canonicalHashes,
    resourceUse: z
      .object({
        computeMilliseconds: z.number().int().nonnegative(),
        gpuMilliseconds: z.number().int().nonnegative(),
        peakGpuMemoryMiB: z.number().int().nonnegative(),
        costMicrousd: z.number().int().nonnegative(),
      })
      .strict(),
    diagnostics: z.array(z.string().trim().min(1).max(1024)),
    admissionAuthority: z.literal("finishing_measurement_and_catalog_admission_required"),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    const hasOutput = value.meshPayload !== undefined || value.materialArtifact !== undefined;
    if ((value.status === "eligible") !== hasOutput)
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "Only eligible generation receipts contain output",
      });
    if ((value.status === "eligible") === value.diagnostics.length > 0)
      context.addIssue({
        code: "custom",
        path: ["diagnostics"],
        message: "Eligible receipts have no diagnostics; unavailable receipts require them",
      });
    verifyHash(value, context);
  });
export type NeuralAssetGenerationReceipt = z.output<typeof NEURAL_ASSET_GENERATION_RECEIPT_SCHEMA>;

export const NEURAL_EXECUTION_BUDGET_CLAIM_SCHEMA = z
  .object({
    kind: z.literal("NeuralExecutionBudgetClaim"),
    requestHash: HASH_SCHEMA,
    providerId: NEURAL_PROVIDER_ID_SCHEMA,
    estimatedCostMicrousd: z.number().int().positive().safe(),
    reservedGpuMilliseconds: z.number().int().positive().safe(),
    budgetHashBefore: HASH_SCHEMA,
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => verifyHash(value, context));
export type NeuralExecutionBudgetClaim = z.output<typeof NEURAL_EXECUTION_BUDGET_CLAIM_SCHEMA>;

export const NEURAL_EXECUTION_BUDGET_SCHEMA = z
  .object({
    kind: z.literal("NeuralExecutionBudget"),
    maximumCostMicrousd: z.number().int().positive().safe(),
    maximumGpuMilliseconds: z.number().int().positive().safe(),
    maximumPaidAttempts: z.number().int().positive().safe(),
    claims: z.array(NEURAL_EXECUTION_BUDGET_CLAIM_SCHEMA),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    const keys = value.claims.map((claim) => claim.requestHash);
    if (
      new Set(keys).size !== keys.length ||
      stableJson([...keys].sort(compareCanonicalStrings)) !== stableJson(keys)
    )
      context.addIssue({
        code: "custom",
        path: ["claims"],
        message: "Budget claims must be unique and canonical by request hash",
      });
    if (value.claims.length > value.maximumPaidAttempts)
      context.addIssue({
        code: "custom",
        path: ["claims"],
        message: "Paid-attempt limit exceeded",
      });
    if (
      value.claims.reduce((sum, claim) => sum + claim.estimatedCostMicrousd, 0) >
      value.maximumCostMicrousd
    )
      context.addIssue({ code: "custom", path: ["claims"], message: "Cost budget exceeded" });
    if (
      value.claims.reduce((sum, claim) => sum + claim.reservedGpuMilliseconds, 0) >
      value.maximumGpuMilliseconds
    )
      context.addIssue({ code: "custom", path: ["claims"], message: "GPU-time budget exceeded" });
    verifyHash(value, context);
  });
export type NeuralExecutionBudget = z.output<typeof NEURAL_EXECUTION_BUDGET_SCHEMA>;

export type NeuralExecutionBudgetClaimResult =
  | {
      readonly status: "claimed" | "already_claimed";
      readonly budget: NeuralExecutionBudget;
      readonly claim: NeuralExecutionBudgetClaim;
    }
  | {
      readonly status: "incomplete";
      readonly budget: NeuralExecutionBudget;
      readonly reason: "paid_attempt_limit" | "cost_limit" | "gpu_time_limit";
    };

export interface NeuralGenerationAdapter {
  readonly provider: NeuralProviderDeclaration;
  readonly qualification: NeuralWorkerQualification;
  generate(
    request: NeuralAssetGenerationRequest,
    signal?: AbortSignal,
  ): Promise<NeuralAssetGenerationReceipt>;
}

export function sealNeuralProviderDeclaration(
  input: Omit<NeuralProviderDeclaration, "kind" | "hash">,
): NeuralProviderDeclaration {
  return seal(NEURAL_PROVIDER_DECLARATION_SCHEMA, {
    kind: "NeuralProviderDeclaration" as const,
    ...input,
    capabilities: [...input.capabilities].sort(compareCanonicalStrings),
    diagnostics: [...input.diagnostics].sort(compareCanonicalStrings),
  });
}

export function sealNeuralWorkerQualification(
  input: Omit<NeuralWorkerQualification, "kind" | "hash">,
): NeuralWorkerQualification {
  return seal(NEURAL_WORKER_QUALIFICATION_SCHEMA, {
    kind: "NeuralWorkerQualification" as const,
    ...input,
    diagnostics: [...input.diagnostics].sort(compareCanonicalStrings),
  });
}

export function sealNeuralInputReference(
  input: Omit<NeuralInputReference, "kind" | "hash">,
): NeuralInputReference {
  return seal(NEURAL_INPUT_REFERENCE_SCHEMA, {
    kind: "NeuralInputReference" as const,
    ...input,
    preparationEvidenceHashes: [...input.preparationEvidenceHashes].sort(compareCanonicalStrings),
  });
}

export function sealNeuralAssetGenerationRequest(
  input: Omit<NeuralAssetGenerationRequest, "kind" | "requestId" | "requestHash">,
): NeuralAssetGenerationRequest {
  const material = { kind: "NeuralAssetGenerationRequest" as const, ...input };
  return deepFreezeJson(
    NEURAL_ASSET_GENERATION_REQUEST_SCHEMA.parse({
      ...material,
      requestId: contentAddressedEntityId("NeuralAssetGenerationRequest", material),
      requestHash: contentHash(stableJson(material)),
    }),
  ) as NeuralAssetGenerationRequest;
}

export function sealNeuralAssetGenerationReceipt(
  input: Omit<NeuralAssetGenerationReceipt, "kind" | "admissionAuthority" | "hash">,
): NeuralAssetGenerationReceipt {
  return seal(NEURAL_ASSET_GENERATION_RECEIPT_SCHEMA, {
    kind: "NeuralAssetGenerationReceipt" as const,
    ...input,
    lineageEvidenceHashes: [...input.lineageEvidenceHashes].sort(compareCanonicalStrings),
    diagnostics: [...input.diagnostics].sort(compareCanonicalStrings),
    admissionAuthority: "finishing_measurement_and_catalog_admission_required" as const,
  });
}

export function sealNeuralExecutionBudget(
  input: Omit<NeuralExecutionBudget, "kind" | "hash">,
): NeuralExecutionBudget {
  return seal(NEURAL_EXECUTION_BUDGET_SCHEMA, {
    kind: "NeuralExecutionBudget" as const,
    ...input,
    claims: [...input.claims].sort((left, right) =>
      compareCanonicalStrings(left.requestHash, right.requestHash),
    ),
  });
}

export function claimNeuralExecutionBudget(
  budget: NeuralExecutionBudget,
  input: {
    readonly requestHash: string;
    readonly providerId: NeuralProviderId;
    readonly estimatedCostMicrousd: number;
    readonly reservedGpuMilliseconds: number;
  },
): NeuralExecutionBudgetClaimResult {
  const parsed = NEURAL_EXECUTION_BUDGET_SCHEMA.parse(budget);
  const requestHash = HASH_SCHEMA.parse(input.requestHash);
  const existing = parsed.claims.find((claim) => claim.requestHash === requestHash);
  if (existing) {
    if (
      existing.providerId !== input.providerId ||
      existing.estimatedCostMicrousd !== input.estimatedCostMicrousd ||
      existing.reservedGpuMilliseconds !== input.reservedGpuMilliseconds
    )
      throw new Error("A neural request cannot be rebound to a different budget claim");
    return { status: "already_claimed", budget: parsed, claim: existing };
  }
  if (parsed.claims.length >= parsed.maximumPaidAttempts)
    return { status: "incomplete", budget: parsed, reason: "paid_attempt_limit" };
  if (
    parsed.claims.reduce((sum, claim) => sum + claim.estimatedCostMicrousd, 0) +
      input.estimatedCostMicrousd >
    parsed.maximumCostMicrousd
  )
    return { status: "incomplete", budget: parsed, reason: "cost_limit" };
  if (
    parsed.claims.reduce((sum, claim) => sum + claim.reservedGpuMilliseconds, 0) +
      input.reservedGpuMilliseconds >
    parsed.maximumGpuMilliseconds
  )
    return { status: "incomplete", budget: parsed, reason: "gpu_time_limit" };
  const claim = seal(NEURAL_EXECUTION_BUDGET_CLAIM_SCHEMA, {
    kind: "NeuralExecutionBudgetClaim" as const,
    requestHash,
    providerId: input.providerId,
    estimatedCostMicrousd: input.estimatedCostMicrousd,
    reservedGpuMilliseconds: input.reservedGpuMilliseconds,
    budgetHashBefore: parsed.hash,
  });
  const {
    kind: _kind,
    hash: _hash,
    claims: _claims,
    maximumCostMicrousd,
    maximumGpuMilliseconds,
    maximumPaidAttempts,
  } = parsed;
  return {
    status: "claimed",
    claim,
    budget: sealNeuralExecutionBudget({
      maximumCostMicrousd,
      maximumGpuMilliseconds,
      maximumPaidAttempts,
      claims: [...parsed.claims, claim],
    }),
  };
}

export async function executeNeuralGeneration(input: {
  readonly adapter: NeuralGenerationAdapter;
  readonly request: NeuralAssetGenerationRequest;
  readonly signal?: AbortSignal;
}): Promise<NeuralAssetGenerationReceipt> {
  const request = NEURAL_ASSET_GENERATION_REQUEST_SCHEMA.parse(input.request);
  const provider = NEURAL_PROVIDER_DECLARATION_SCHEMA.parse(input.adapter.provider);
  const qualification = NEURAL_WORKER_QUALIFICATION_SCHEMA.parse(input.adapter.qualification);
  if (
    provider.status !== "eligible" ||
    qualification.status !== "eligible" ||
    qualification.providerDeclarationHash !== provider.hash ||
    qualification.providerId !== provider.providerId
  )
    throw new Error("Neural provider is not exactly qualified for execution");
  if (
    request.providerId !== provider.providerId ||
    request.providerDeclarationHash !== provider.hash ||
    request.qualificationHash !== qualification.hash
  )
    throw new Error("Neural request does not bind the executing provider qualification");
  const requiredCapability =
    request.operation === "restyle_materials" ? "material_restyle" : "image_to_3d";
  if (!provider.capabilities.includes(requiredCapability))
    throw new Error(`Provider ${provider.providerId} lacks ${requiredCapability}`);
  const receipt = NEURAL_ASSET_GENERATION_RECEIPT_SCHEMA.parse(
    await input.adapter.generate(request, input.signal),
  );
  if (
    receipt.requestHash !== request.requestHash ||
    receipt.providerId !== provider.providerId ||
    receipt.providerDeclarationHash !== provider.hash ||
    receipt.qualificationHash !== qualification.hash ||
    receipt.workerImplementationHash !== qualification.workerImplementationHash ||
    receipt.modelRevisionHash !== qualification.modelRevisionHash
  )
    throw new Error("Neural receipt does not bind the exact execution request");
  return receipt;
}

function seal<T extends z.ZodTypeAny>(schema: T, material: object): z.output<T> {
  return deepFreezeJson(
    schema.parse({ ...material, hash: contentHash(stableJson(material)) }),
  ) as z.output<T>;
}

function verifyHash(value: Record<string, unknown>, context: z.RefinementCtx): void {
  const material = { ...value };
  delete material.hash;
  if (contentHash(stableJson(material)) !== value.hash)
    context.addIssue({ code: "custom", path: ["hash"], message: "Artifact hash mismatch" });
}
