import { z } from "zod";
import { contentHash, stableJson } from "../../contracts/src/index.js";
import { entityId, hashSchema } from "../../spatial-core/src/primitives.js";
import {
  FLUX2_KLEIN_4B_PRODUCER,
  LONGCAT_IMAGE_EDIT_PRODUCER,
  QWEN_IMAGE_2512_PRODUCER,
  QWEN_IMAGE_EDIT_2511_PRODUCER,
  REFERENCE_IMAGE_PRODUCER_QUALIFICATION_SCHEMA,
  REFERENCE_IMAGE_PRODUCER_SCHEMA,
  REFERENCE_IMAGE_RUNTIME_POLICY_HASH,
  SAM3_PRODUCER,
  assertReferenceImageProducerQualificationIdentity,
  referenceImageProducerIdentityHash,
  type ReferenceImageProducer,
  type ReferenceImageProducerQualification,
} from "./producers.js";
import { REFERENCE_IMAGE_BINARY_ARTIFACT_SCHEMA } from "./references.js";
import { REFERENCE_IMAGE_EXECUTION_CLASS, type ReferenceImageProductionRoute } from "./registry.js";

export const REFERENCE_IMAGE_WORKER_REQUEST_ABI =
  "basalt-reference-image-worker-request@5" as const;
export const REFERENCE_IMAGE_WORKER_RECEIPT_ABI =
  "basalt-reference-image-worker-receipt@5" as const;
export const REFERENCE_IMAGE_EVALUATION_SMOKE_AUTHORIZATION_ABI =
  "basalt-reference-image-evaluation-smoke-authorization@1" as const;
export const REFERENCE_IMAGE_RUNTIME_PROBE_ABI = "basalt-reference-image-runtime-probe@1" as const;
export const REFERENCE_IMAGE_EVALUATION_TECHNICAL_QUALIFICATION_ABI =
  "basalt-reference-image-evaluation-technical-qualification@1" as const;
export const REFERENCE_IMAGE_OUTPUT_VOLUME = "basalt-neural-output" as const;

const pngArtifact = REFERENCE_IMAGE_BINARY_ARTIFACT_SCHEMA.safeExtend({
  mediaType: z.literal("image/png"),
});
const gitRevision = z.string().regex(/^[a-f0-9]{40}$/u);

const canvas = z
  .object({
    width: z.number().int().min(256).max(2048).multipleOf(64),
    height: z.number().int().min(256).max(2048).multipleOf(64),
    colorSpace: z.literal("srgb"),
  })
  .strict();

const creativeParameters = {
  prompt: z.string().trim().min(1).max(16_384),
  negativePrompt: z.string().max(8_192),
  creativeLatitude: z.number().finite().min(0).max(1),
  seed: z.number().int().min(0).max(2_147_483_647),
  canvas,
};

const canonicalRequirementHashes = z
  .array(hashSchema)
  .min(1)
  .max(256)
  .refine(
    (value) =>
      new Set(value).size === value.length && stableJson(value) === stableJson([...value].sort()),
    "Composition requirement hashes must be unique and canonical",
  );

export const REFERENCE_IMAGE_WORKER_PAYLOAD_SCHEMA = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("isolated_reference"),
      referenceRequestHash: hashSchema,
      referenceRequestArtifactHash: hashSchema,
      requirementHash: hashSchema,
      styleContractHash: hashSchema,
      ...creativeParameters,
      subjectPolicy: z.literal("isolated_subject_clear_silhouette"),
      inputRightsEvidenceHashes: z.array(hashSchema).min(1).max(64),
    })
    .strict(),
  z
    .object({
      kind: z.literal("region_composition"),
      regionalPlanHash: hashSchema,
      regionFoundationHash: hashSchema,
      regionId: entityId,
      contextRender: pngArtifact,
      cameraCalibrationHash: hashSchema,
      protectedPixelMask: pngArtifact,
      requirementHashes: canonicalRequirementHashes,
      styleContractHash: hashSchema,
      compositionIndex: z.number().int().min(0).max(255),
      ...creativeParameters,
      inputRightsEvidenceHashes: z.array(hashSchema).min(1).max(64),
    })
    .strict(),
  z
    .object({
      kind: z.literal("prompted_segmentation"),
      segmentationRequestHash: hashSchema,
      segmentationRequestArtifactHash: hashSchema,
      referenceRequestHash: hashSchema,
      requirementHash: hashSchema,
      styleContractHash: hashSchema,
      inputImage: pngArtifact,
      width: z.number().int().min(256).max(2048),
      height: z.number().int().min(256).max(2048),
      segmentationPrompt: z.string().trim().min(1).max(4096),
      randomness: z.literal("disabled"),
    })
    .strict(),
]);
export type ReferenceImageWorkerPayload = z.infer<typeof REFERENCE_IMAGE_WORKER_PAYLOAD_SCHEMA>;

const executionBinding = z
  .object({
    modalImageId: z.string().regex(/^im-[A-Za-z0-9]+$/u),
    runtimeImageHash: hashSchema,
    workerSourceHash: hashSchema,
    modelVolumeSnapshotHash: hashSchema,
    dependencyInventoryHash: hashSchema,
    dependencyInventoryArtifactHash: hashSchema,
    sbomArtifactHash: hashSchema,
    importTraceArtifactHash: hashSchema,
    modelInventoryArtifactHash: hashSchema,
    runtimePolicyHash: z.literal(REFERENCE_IMAGE_RUNTIME_POLICY_HASH),
  })
  .strict();

const evaluationProducer = z.discriminatedUnion("id", [
  REFERENCE_IMAGE_PRODUCER_SCHEMA.options[1],
  REFERENCE_IMAGE_PRODUCER_SCHEMA.options[4],
]);

const runtimeProbeMaterial = z
  .object({
    kind: z.literal("ReferenceImageRuntimeProbe"),
    abi: z.literal(REFERENCE_IMAGE_RUNTIME_PROBE_ABI),
    status: z.literal("eligible"),
    producerId: z.enum([QWEN_IMAGE_EDIT_2511_PRODUCER.id, SAM3_PRODUCER.id]),
    modalImageId: z.string().regex(/^im-[A-Za-z0-9]+$/u),
    runtimeManifestHash: hashSchema,
    workerSha256: hashSchema,
    runtimeEvidence: z
      .object({
        dependencyInventoryHash: hashSchema,
        dependencyInventoryArtifactHash: hashSchema,
        sbomArtifactHash: hashSchema,
        importTraceArtifactHash: hashSchema,
      })
      .strict(),
    sourceSnapshotSealHash: hashSchema,
    modelSnapshotSealHash: hashSchema,
    modelInventoryArtifactHash: hashSchema,
    hardware: z
      .object({
        acceleratorModel: z.string().trim().min(1).max(256),
        vramGiB: z.number().finite().positive(),
        cudaBuild: z.string().trim().min(1).max(64),
      })
      .strict(),
    importProbe: z
      .object({
        requested: z.array(z.string().trim().min(1).max(512)).min(1).max(128),
        importedModules: z.array(z.string().trim().min(1).max(512)).max(65_536),
        forbiddenModules: z.array(z.string().trim().min(1).max(512)).length(0),
      })
      .strict(),
    modelWeightsLoaded: z.literal(false),
    gpuAllocated: z.literal(true),
    networkEgress: z.literal("denied"),
  })
  .strict();

export const REFERENCE_IMAGE_RUNTIME_PROBE_SCHEMA = runtimeProbeMaterial.safeExtend({
  hash: hashSchema,
});
export type ReferenceImageRuntimeProbe = z.infer<typeof REFERENCE_IMAGE_RUNTIME_PROBE_SCHEMA>;

const provisioningReceipt = z
  .object({
    kind: z.literal("BasaltNeuralProvisioningReceipt"),
    abi: z.literal("basalt-neural-provisioning-receipt@1"),
    artifactId: z.string().trim().min(3).max(64),
    revision: gitRevision,
    volumeName: z.string().regex(/^[a-z0-9][a-z0-9-]{2,63}$/u),
    snapshotPath: z.string().regex(/^\/mnt\/basalt-neural-input\/[a-z0-9-]+\/snapshot$/u),
    snapshotSealHash: hashSchema,
    qualificationStatus: z.literal("incomplete"),
    modelWasImported: z.literal(false),
    gpuWasAllocated: z.literal(false),
  })
  .strict();
export const REFERENCE_IMAGE_PROVISIONING_RECEIPT_SCHEMA = provisioningReceipt;
export type ReferenceImageProvisioningReceipt = z.infer<typeof provisioningReceipt>;

const evaluationTechnicalQualificationMaterial = z
  .object({
    kind: z.literal("ReferenceImageEvaluationTechnicalQualification"),
    abi: z.literal(REFERENCE_IMAGE_EVALUATION_TECHNICAL_QUALIFICATION_ABI),
    usageScope: z.literal("evaluation_smoke"),
    producer: evaluationProducer,
    producerIdentityHash: hashSchema,
    executionBinding,
    sourceVolumeSnapshotHash: hashSchema,
    evidence: z
      .object({
        runtimeProbeHash: hashSchema,
        sourceProvisioningReceiptHash: hashSchema,
        modelProvisioningReceiptHash: hashSchema,
      })
      .strict(),
    qualifiedAt: z.string().datetime({ offset: true }),
    technicalStatus: z.literal("eligible"),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.producerIdentityHash !== referenceImageProducerIdentityHash(value.producer))
      context.addIssue({
        code: "custom",
        path: ["producerIdentityHash"],
        message: "Evaluation producer identity differs from its exact pin",
      });
  });

export const REFERENCE_IMAGE_EVALUATION_TECHNICAL_QUALIFICATION_SCHEMA =
  evaluationTechnicalQualificationMaterial.safeExtend({ hash: hashSchema });
export type ReferenceImageEvaluationTechnicalQualification = z.infer<
  typeof REFERENCE_IMAGE_EVALUATION_TECHNICAL_QUALIFICATION_SCHEMA
>;

const evaluationArtifacts = {
  [QWEN_IMAGE_EDIT_2511_PRODUCER.id]: {
    source: {
      artifactId: "qwen_image.source",
      revision: QWEN_IMAGE_EDIT_2511_PRODUCER.sourceCommit,
      volumeName: `basalt-qwen-image-source-${QWEN_IMAGE_EDIT_2511_PRODUCER.sourceCommit.slice(0, 16)}`,
      snapshotPath: "/mnt/basalt-neural-input/qwen-image-source/snapshot",
    },
    model: {
      artifactId: "qwen_image_edit_2511.model",
      revision: QWEN_IMAGE_EDIT_2511_PRODUCER.modelRevision,
      volumeName: `basalt-qwen-image-edit-2511-model-${QWEN_IMAGE_EDIT_2511_PRODUCER.modelRevision.slice(0, 16)}`,
      snapshotPath: "/mnt/basalt-neural-input/qwen-image-edit-2511-model/snapshot",
    },
  },
  [SAM3_PRODUCER.id]: {
    source: {
      artifactId: "sam3.source",
      revision: SAM3_PRODUCER.sourceCommit,
      volumeName: `basalt-sam3-source-${SAM3_PRODUCER.sourceCommit.slice(0, 16)}`,
      snapshotPath: "/mnt/basalt-neural-input/sam3-source/snapshot",
    },
    model: {
      artifactId: "sam3.model",
      revision: SAM3_PRODUCER.modelRevision,
      volumeName: `basalt-sam3-model-${SAM3_PRODUCER.modelRevision.slice(0, 16)}`,
      snapshotPath: "/mnt/basalt-neural-input/sam3-model/snapshot",
    },
  },
} as const;

export function assertReferenceImageRuntimeProbeIdentity(
  value: unknown,
): asserts value is ReferenceImageRuntimeProbe {
  const probe = REFERENCE_IMAGE_RUNTIME_PROBE_SCHEMA.parse(value);
  const { hash, ...material } = probe;
  if (contentHash(stableJson(material)) !== hash)
    throw new Error("Reference-image runtime probe identity is invalid");
}

export function sealReferenceImageEvaluationTechnicalQualification(input: {
  readonly producer: typeof QWEN_IMAGE_EDIT_2511_PRODUCER | typeof SAM3_PRODUCER;
  readonly runtimeProbe: unknown;
  readonly sourceProvisioningReceipt: unknown;
  readonly modelProvisioningReceipt: unknown;
  readonly qualifiedAt: string;
}): ReferenceImageEvaluationTechnicalQualification {
  assertReferenceImageRuntimeProbeIdentity(input.runtimeProbe);
  const sourceReceipt = provisioningReceipt.parse(input.sourceProvisioningReceipt);
  const modelReceipt = provisioningReceipt.parse(input.modelProvisioningReceipt);
  const expected = evaluationArtifacts[input.producer.id];
  if (input.runtimeProbe.producerId !== input.producer.id)
    throw new Error("Reference-image runtime probe belongs to another producer");
  for (const [receipt, specification, label] of [
    [sourceReceipt, expected.source, "source"],
    [modelReceipt, expected.model, "model"],
  ] as const) {
    if (
      receipt.artifactId !== specification.artifactId ||
      receipt.revision !== specification.revision ||
      receipt.volumeName !== specification.volumeName ||
      receipt.snapshotPath !== specification.snapshotPath
    )
      throw new Error(`Reference-image ${label} provisioning receipt differs from its exact pin`);
  }
  if (
    sourceReceipt.snapshotSealHash !== input.runtimeProbe.sourceSnapshotSealHash ||
    modelReceipt.snapshotSealHash !== input.runtimeProbe.modelSnapshotSealHash
  )
    throw new Error("Reference-image runtime probe differs from provisioned snapshot receipts");
  const material = evaluationTechnicalQualificationMaterial.parse({
    kind: "ReferenceImageEvaluationTechnicalQualification",
    abi: REFERENCE_IMAGE_EVALUATION_TECHNICAL_QUALIFICATION_ABI,
    usageScope: "evaluation_smoke",
    producer: input.producer,
    producerIdentityHash: referenceImageProducerIdentityHash(input.producer),
    executionBinding: {
      modalImageId: input.runtimeProbe.modalImageId,
      runtimeImageHash: input.runtimeProbe.runtimeManifestHash,
      workerSourceHash: input.runtimeProbe.workerSha256,
      modelVolumeSnapshotHash: input.runtimeProbe.modelSnapshotSealHash,
      dependencyInventoryHash: input.runtimeProbe.runtimeEvidence.dependencyInventoryHash,
      dependencyInventoryArtifactHash:
        input.runtimeProbe.runtimeEvidence.dependencyInventoryArtifactHash,
      sbomArtifactHash: input.runtimeProbe.runtimeEvidence.sbomArtifactHash,
      importTraceArtifactHash: input.runtimeProbe.runtimeEvidence.importTraceArtifactHash,
      modelInventoryArtifactHash: input.runtimeProbe.modelInventoryArtifactHash,
      runtimePolicyHash: REFERENCE_IMAGE_RUNTIME_POLICY_HASH,
    },
    sourceVolumeSnapshotHash: input.runtimeProbe.sourceSnapshotSealHash,
    evidence: {
      runtimeProbeHash: input.runtimeProbe.hash,
      sourceProvisioningReceiptHash: contentHash(stableJson(sourceReceipt)),
      modelProvisioningReceiptHash: contentHash(stableJson(modelReceipt)),
    },
    qualifiedAt: input.qualifiedAt,
    technicalStatus: "eligible",
  });
  return REFERENCE_IMAGE_EVALUATION_TECHNICAL_QUALIFICATION_SCHEMA.parse({
    ...material,
    hash: contentHash(stableJson(material)),
  });
}

export function assertReferenceImageEvaluationTechnicalQualificationIdentity(
  value: unknown,
): asserts value is ReferenceImageEvaluationTechnicalQualification {
  const qualification = REFERENCE_IMAGE_EVALUATION_TECHNICAL_QUALIFICATION_SCHEMA.parse(value);
  const { hash, ...material } = qualification;
  if (contentHash(stableJson(material)) !== hash)
    throw new Error("Reference-image evaluation technical qualification identity is invalid");
}

const workerRequestMaterial = z
  .object({
    kind: z.literal("ReferenceImageWorkerRequest"),
    abi: z.literal(REFERENCE_IMAGE_WORKER_REQUEST_ABI),
    route: z.enum(["isolated_reference", "region_composition", "prompted_segmentation"]),
    executionClass: z.literal(REFERENCE_IMAGE_EXECUTION_CLASS),
    executionScope: z.enum(["evaluation_smoke", "product"]),
    producerId: z.enum([
      FLUX2_KLEIN_4B_PRODUCER.id,
      LONGCAT_IMAGE_EDIT_PRODUCER.id,
      QWEN_IMAGE_2512_PRODUCER.id,
      QWEN_IMAGE_EDIT_2511_PRODUCER.id,
      SAM3_PRODUCER.id,
    ]),
    sourceCommit: gitRevision,
    modelId: z.string().trim().min(1).max(512),
    modelRevision: gitRevision,
    producerQualificationHash: hashSchema,
    invocationHash: hashSchema,
    attemptId: hashSchema,
    executionBinding,
    payload: REFERENCE_IMAGE_WORKER_PAYLOAD_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.route !== value.payload.kind)
      context.addIssue({
        code: "custom",
        path: ["payload", "kind"],
        message: "Worker payload must match the exact production route",
      });
  });

export const REFERENCE_IMAGE_WORKER_REQUEST_SCHEMA = workerRequestMaterial.safeExtend({
  hash: hashSchema,
});
export type ReferenceImageWorkerRequest = z.infer<typeof REFERENCE_IMAGE_WORKER_REQUEST_SCHEMA>;

export function sealReferenceImageWorkerRequest(input: {
  readonly qualification:
    ReferenceImageProducerQualification | ReferenceImageEvaluationTechnicalQualification;
  readonly invocationHash: string;
  readonly attemptId: string;
  readonly executionScope: "evaluation_smoke" | "product";
  readonly payload: ReferenceImageWorkerPayload;
}): ReferenceImageWorkerRequest {
  if (input.executionScope === "product") {
    assertReferenceImageProducerQualificationIdentity(input.qualification);
    if (input.qualification.localStatus !== "eligible")
      throw new Error("Reference-image product execution requires an eligible qualification");
  } else {
    assertReferenceImageEvaluationTechnicalQualificationIdentity(input.qualification);
  }
  const route = routeForProducer(input.qualification.producer);
  if (input.payload.kind !== route)
    throw new Error("Reference-image payload does not match its qualified producer");
  const producer = input.qualification.producer;
  const binding =
    input.qualification.kind === "ReferenceImageProducerQualification"
      ? {
          modalImageId: input.qualification.runtime.modalImageId,
          runtimeImageHash: input.qualification.runtime.runtimeImageHash,
          workerSourceHash: input.qualification.runtime.workerSourceHash,
          modelVolumeSnapshotHash: input.qualification.runtime.modelVolumeSnapshotHash,
          dependencyInventoryHash: input.qualification.runtime.dependencyInventoryHash,
          dependencyInventoryArtifactHash:
            input.qualification.runtime.dependencyInventoryArtifact.artifactHash,
          sbomArtifactHash: input.qualification.runtime.sbomArtifact.artifactHash,
          importTraceArtifactHash: input.qualification.runtime.importTraceArtifact.artifactHash,
          modelInventoryArtifactHash:
            input.qualification.runtime.modelInventoryArtifact.artifactHash,
          runtimePolicyHash: input.qualification.runtime.runtimePolicyHash,
        }
      : input.qualification.executionBinding;
  const material = workerRequestMaterial.parse({
    kind: "ReferenceImageWorkerRequest",
    abi: REFERENCE_IMAGE_WORKER_REQUEST_ABI,
    route,
    executionClass: REFERENCE_IMAGE_EXECUTION_CLASS,
    executionScope: input.executionScope,
    producerId: producer.id,
    sourceCommit: producer.sourceCommit,
    modelId: producer.modelId,
    modelRevision: producer.modelRevision,
    producerQualificationHash: input.qualification.hash,
    invocationHash: input.invocationHash,
    attemptId: input.attemptId,
    executionBinding: binding,
    payload: input.payload,
  });
  return REFERENCE_IMAGE_WORKER_REQUEST_SCHEMA.parse({
    ...material,
    hash: contentHash(stableJson(material)),
  });
}

const evaluationSmokeAuthorizationMaterial = z
  .object({
    kind: z.literal("ReferenceImageEvaluationSmokeAuthorization"),
    abi: z.literal(REFERENCE_IMAGE_EVALUATION_SMOKE_AUTHORIZATION_ABI),
    executionScope: z.literal("evaluation_smoke"),
    requestHash: hashSchema,
    producerQualificationHash: hashSchema,
    producerId: z.enum([QWEN_IMAGE_EDIT_2511_PRODUCER.id, SAM3_PRODUCER.id]),
    route: z.enum(["region_composition", "prompted_segmentation"]),
    attemptId: hashSchema,
    oneShot: z.literal(true),
    outputVolume: z.literal(REFERENCE_IMAGE_OUTPUT_VOLUME),
    maximumOutputPixels: z
      .number()
      .int()
      .min(256 * 256)
      .max(2048 * 2048),
    maximumGpuSeconds: z.number().int().min(1).max(900),
    maximumEstimatedCostUsd: z.number().finite().positive().max(2),
    issuerIdentityHash: hashSchema,
    nonce: hashSchema,
    issuedAt: z.string().datetime({ offset: true }),
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((value, context) => {
    if (Date.parse(value.expiresAt) <= Date.parse(value.issuedAt))
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "Evaluation-smoke authorization must expire after it is issued",
      });
    const expectedRoute =
      value.producerId === QWEN_IMAGE_EDIT_2511_PRODUCER.id
        ? "region_composition"
        : "prompted_segmentation";
    if (value.route !== expectedRoute)
      context.addIssue({
        code: "custom",
        path: ["route"],
        message: "Evaluation-smoke authorization route differs from its producer",
      });
  });

export const REFERENCE_IMAGE_EVALUATION_SMOKE_AUTHORIZATION_SCHEMA =
  evaluationSmokeAuthorizationMaterial.safeExtend({ hash: hashSchema });
export type ReferenceImageEvaluationSmokeAuthorization = z.infer<
  typeof REFERENCE_IMAGE_EVALUATION_SMOKE_AUTHORIZATION_SCHEMA
>;

export function sealReferenceImageEvaluationSmokeAuthorization(
  input: z.input<typeof evaluationSmokeAuthorizationMaterial>,
): ReferenceImageEvaluationSmokeAuthorization {
  const material = evaluationSmokeAuthorizationMaterial.parse(input);
  return REFERENCE_IMAGE_EVALUATION_SMOKE_AUTHORIZATION_SCHEMA.parse({
    ...material,
    hash: contentHash(stableJson(material)),
  });
}

export function assertReferenceImageEvaluationSmokeAuthorizationIdentity(
  value: unknown,
): asserts value is ReferenceImageEvaluationSmokeAuthorization {
  const authorization = REFERENCE_IMAGE_EVALUATION_SMOKE_AUTHORIZATION_SCHEMA.parse(value);
  const { hash, ...material } = authorization;
  if (contentHash(stableJson(material)) !== hash)
    throw new Error("Reference-image evaluation-smoke authorization identity is invalid");
}

export function assertReferenceImageEvaluationSmokeAuthorizationMatches(
  authorizationValue: unknown,
  requestValue: unknown,
  now: Date = new Date(),
  enforceExpiry = true,
): asserts authorizationValue is ReferenceImageEvaluationSmokeAuthorization {
  assertReferenceImageEvaluationSmokeAuthorizationIdentity(authorizationValue);
  assertReferenceImageWorkerRequestIdentity(requestValue);
  const authorization = authorizationValue;
  const request = requestValue;
  if (
    request.executionScope !== "evaluation_smoke" ||
    authorization.requestHash !== request.hash ||
    authorization.producerQualificationHash !== request.producerQualificationHash ||
    authorization.producerId !== request.producerId ||
    authorization.route !== request.route ||
    authorization.attemptId !== request.attemptId
  )
    throw new Error("Reference-image evaluation-smoke authorization does not match its request");
  const payload = request.payload;
  const pixels =
    payload.kind === "prompted_segmentation"
      ? payload.width * payload.height
      : payload.canvas.width * payload.canvas.height;
  if (pixels > authorization.maximumOutputPixels)
    throw new Error("Reference-image evaluation-smoke request exceeds its pixel authorization");
  if (enforceExpiry && now.getTime() > Date.parse(authorization.expiresAt))
    throw new Error("Reference-image evaluation-smoke authorization has expired");
}

export function assertReferenceImageWorkerRequestIdentity(
  value: unknown,
): asserts value is ReferenceImageWorkerRequest {
  const request = REFERENCE_IMAGE_WORKER_REQUEST_SCHEMA.parse(value);
  const { hash, ...material } = request;
  if (contentHash(stableJson(material)) !== hash)
    throw new Error("Reference-image worker request identity is invalid");
}

const workerOutput = z
  .object({
    role: z.enum(["original_image", "composition_image", "alpha_mask"]),
    mediaType: z.literal("image/png"),
    sha256: hashSchema,
    bytes: z
      .number()
      .int()
      .positive()
      .max(256 * 1024 * 1024),
    width: z.number().int().min(256).max(2048),
    height: z.number().int().min(256).max(2048),
    channels: z.union([z.literal(1), z.literal(3), z.literal(4)]),
    colorSpace: z.enum(["srgb", "linear"]),
  })
  .strict();

const workerReceiptMaterial = z
  .object({
    kind: z.literal("ReferenceImageWorkerReceipt"),
    abi: z.literal(REFERENCE_IMAGE_WORKER_RECEIPT_ABI),
    status: z.enum(["eligible", "evaluation_complete"]),
    route: z.enum(["isolated_reference", "region_composition", "prompted_segmentation"]),
    executionScope: z.enum(["evaluation_smoke", "product"]),
    evaluationAuthorizationHash: hashSchema.nullable(),
    requestHash: hashSchema,
    producerQualificationHash: hashSchema,
    invocationHash: hashSchema,
    attemptId: hashSchema,
    executionBinding,
    output: workerOutput,
    inference: z
      .object({
        seed: z.number().int().min(0).max(2_147_483_647).nullable(),
        steps: z.number().int().min(0).max(100),
        scoreThreshold: z.number().finite().min(0).max(1).nullable(),
        instanceCount: z.number().int().nonnegative().max(4096),
        modelOutputSha256: hashSchema,
        postprocess: z.enum([
          "isolated_generation",
          "protected_pixel_composite",
          "best_instance_mask",
        ]),
        protectedPixelCount: z.number().int().nonnegative(),
        protectedPixelMismatchCount: z.number().int().nonnegative(),
        elapsedMilliseconds: z.number().int().nonnegative(),
        gpuSeconds: z.number().finite().nonnegative(),
      })
      .strict(),
    runtime: z
      .object({
        runtimeEgress: z.literal("denied"),
        networkAttempted: z.literal(false),
        runtimeDownloads: z.literal(false),
        trustRemoteCode: z.literal(false),
        modelRoot: z.string().regex(/^\/mnt\/basalt-neural-input\/[a-z0-9-]+-model$/u),
        sourceRoot: z.string().regex(/^\/mnt\/basalt-neural-input\/[a-z0-9-]+-source$/u),
        runtimeManifestHash: hashSchema,
        modelSnapshotSealHash: hashSchema,
        sourceSnapshotSealHash: hashSchema,
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.executionScope === "evaluation_smoke" &&
        (value.status !== "evaluation_complete" || value.evaluationAuthorizationHash === null)) ||
      (value.executionScope === "product" &&
        (value.status !== "eligible" || value.evaluationAuthorizationHash !== null))
    )
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "Worker receipt status and authorization must match its execution scope",
      });
    const expectedRole =
      value.route === "isolated_reference"
        ? "original_image"
        : value.route === "region_composition"
          ? "composition_image"
          : "alpha_mask";
    if (value.output.role !== expectedRole)
      context.addIssue({
        code: "custom",
        path: ["output", "role"],
        message: "Worker output role does not match its exact route",
      });
    if (
      value.route === "prompted_segmentation" &&
      (value.output.channels !== 1 || value.output.colorSpace !== "linear")
    )
      context.addIssue({
        code: "custom",
        path: ["output"],
        message: "Segmentation must return a one-channel linear alpha mask",
      });
    if (
      value.route !== "prompted_segmentation" &&
      (value.output.channels !== 3 || value.output.colorSpace !== "srgb")
    )
      context.addIssue({
        code: "custom",
        path: ["output"],
        message: "Image generation must return a three-channel sRGB PNG",
      });
    if (
      value.route === "region_composition" &&
      (value.inference.postprocess !== "protected_pixel_composite" ||
        value.inference.protectedPixelMismatchCount !== 0 ||
        value.inference.seed === null ||
        value.inference.steps !== 40 ||
        value.inference.scoreThreshold !== null ||
        value.inference.instanceCount !== 0)
    )
      context.addIssue({
        code: "custom",
        path: ["inference"],
        message: "Composition inference must retain exact protected-pixel postprocessing evidence",
      });
    if (
      value.route === "isolated_reference" &&
      (value.inference.postprocess !== "isolated_generation" ||
        value.inference.seed === null ||
        value.inference.scoreThreshold !== null ||
        value.inference.instanceCount !== 0 ||
        value.inference.protectedPixelCount !== 0 ||
        value.inference.protectedPixelMismatchCount !== 0)
    )
      context.addIssue({
        code: "custom",
        path: ["inference"],
        message: "Isolated generation inference evidence differs",
      });
    if (
      value.route === "prompted_segmentation" &&
      (value.inference.postprocess !== "best_instance_mask" ||
        value.inference.seed !== null ||
        value.inference.steps !== 0 ||
        value.inference.scoreThreshold !== 0.05 ||
        value.inference.protectedPixelCount !== 0 ||
        value.inference.protectedPixelMismatchCount !== 0)
    )
      context.addIssue({
        code: "custom",
        path: ["inference"],
        message: "Segmentation inference must retain exact union-mask evidence",
      });
  });

export const REFERENCE_IMAGE_WORKER_RECEIPT_SCHEMA = workerReceiptMaterial.safeExtend({
  hash: hashSchema,
});
export type ReferenceImageWorkerReceipt = z.infer<typeof REFERENCE_IMAGE_WORKER_RECEIPT_SCHEMA>;

export function sealReferenceImageWorkerReceipt(
  input: z.input<typeof workerReceiptMaterial>,
): ReferenceImageWorkerReceipt {
  const material = workerReceiptMaterial.parse(input);
  return REFERENCE_IMAGE_WORKER_RECEIPT_SCHEMA.parse({
    ...material,
    hash: contentHash(stableJson(material)),
  });
}

export function assertReferenceImageWorkerReceiptIdentity(
  value: unknown,
): asserts value is ReferenceImageWorkerReceipt {
  const receipt = REFERENCE_IMAGE_WORKER_RECEIPT_SCHEMA.parse(value);
  const { hash, ...material } = receipt;
  if (contentHash(stableJson(material)) !== hash)
    throw new Error("Reference-image worker receipt identity is invalid");
}

export function assertReferenceImageWorkerReceiptMatches(
  receiptValue: unknown,
  requestValue: unknown,
  qualificationValue: unknown,
  evaluationAuthorizationValue?: unknown,
): asserts receiptValue is ReferenceImageWorkerReceipt {
  assertReferenceImageWorkerReceiptIdentity(receiptValue);
  assertReferenceImageWorkerRequestIdentity(requestValue);
  const receipt = receiptValue;
  const request = requestValue;
  const qualification =
    request.executionScope === "evaluation_smoke"
      ? (() => {
          assertReferenceImageEvaluationTechnicalQualificationIdentity(qualificationValue);
          return qualificationValue;
        })()
      : (() => {
          assertReferenceImageProducerQualificationIdentity(qualificationValue);
          return REFERENCE_IMAGE_PRODUCER_QUALIFICATION_SCHEMA.parse(qualificationValue);
        })();
  if (
    receipt.requestHash !== request.hash ||
    receipt.route !== request.route ||
    receipt.executionScope !== request.executionScope ||
    receipt.producerQualificationHash !== qualification.hash ||
    receipt.invocationHash !== request.invocationHash ||
    receipt.attemptId !== request.attemptId ||
    stableJson(receipt.executionBinding) !== stableJson(request.executionBinding)
  )
    throw new Error("Reference-image worker receipt does not match its request and qualification");
  if (request.executionScope === "evaluation_smoke") {
    if (evaluationAuthorizationValue === undefined)
      throw new Error("Reference-image evaluation receipt requires its authorization");
    assertReferenceImageEvaluationSmokeAuthorizationMatches(
      evaluationAuthorizationValue,
      request,
      new Date(0),
      false,
    );
    if (receipt.evaluationAuthorizationHash !== evaluationAuthorizationValue.hash)
      throw new Error("Reference-image worker receipt does not bind its evaluation authorization");
  } else if (evaluationAuthorizationValue !== undefined)
    throw new Error("Reference-image product receipt cannot bind an evaluation authorization");
  const payload = request.payload;
  const expectedWidth =
    payload.kind === "prompted_segmentation" ? payload.width : payload.canvas.width;
  const expectedHeight =
    payload.kind === "prompted_segmentation" ? payload.height : payload.canvas.height;
  if (receipt.output.width !== expectedWidth || receipt.output.height !== expectedHeight)
    throw new Error("Reference-image worker output dimensions differ from its request");
  const expectedRoots = runtimeRoots(request.producerId);
  if (
    receipt.runtime.modelRoot !== expectedRoots.modelRoot ||
    receipt.runtime.sourceRoot !== expectedRoots.sourceRoot
  )
    throw new Error("Reference-image worker runtime roots differ from its pinned route");
}

function routeForProducer(producer: ReferenceImageProducer): ReferenceImageProductionRoute {
  switch (producer.id) {
    case QWEN_IMAGE_2512_PRODUCER.id:
      return "isolated_reference";
    case QWEN_IMAGE_EDIT_2511_PRODUCER.id:
    case FLUX2_KLEIN_4B_PRODUCER.id:
    case LONGCAT_IMAGE_EDIT_PRODUCER.id:
      return "region_composition";
    case SAM3_PRODUCER.id:
      return "prompted_segmentation";
  }
}

function runtimeRoots(producerId: ReferenceImageWorkerRequest["producerId"]): {
  readonly modelRoot: string;
  readonly sourceRoot: string;
} {
  switch (producerId) {
    case QWEN_IMAGE_2512_PRODUCER.id:
      return {
        modelRoot: "/mnt/basalt-neural-input/qwen-image-2512-model",
        sourceRoot: "/mnt/basalt-neural-input/qwen-image-source",
      };
    case QWEN_IMAGE_EDIT_2511_PRODUCER.id:
      return {
        modelRoot: "/mnt/basalt-neural-input/qwen-image-edit-2511-model",
        sourceRoot: "/mnt/basalt-neural-input/qwen-image-source",
      };
    case FLUX2_KLEIN_4B_PRODUCER.id:
      return {
        modelRoot: "/mnt/basalt-neural-input/flux2-klein-4b-model",
        sourceRoot: "/mnt/basalt-neural-input/flux2-source",
      };
    case LONGCAT_IMAGE_EDIT_PRODUCER.id:
      return {
        modelRoot: "/mnt/basalt-neural-input/longcat-image-edit-model",
        sourceRoot: "/mnt/basalt-neural-input/longcat-image-source",
      };
    case SAM3_PRODUCER.id:
      return {
        modelRoot: "/mnt/basalt-neural-input/sam3-model",
        sourceRoot: "/mnt/basalt-neural-input/sam3-source",
      };
  }
}
