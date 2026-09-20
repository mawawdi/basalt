import { z } from "zod";
import {
  HASH_SCHEMA,
  Q32_32_SCHEMA,
  compareCanonicalStrings,
  contentHash,
  deepFreezeJson,
  stableJson,
} from "@basalt/contracts";
import {
  NEURAL_ASSET_GENERATION_REQUEST_SCHEMA,
  NEURAL_INPUT_REFERENCE_SCHEMA,
  NEURAL_PROVIDER_DECLARATION_SCHEMA,
  NEURAL_WORKER_QUALIFICATION_SCHEMA,
  sealNeuralAssetGenerationReceipt,
  type NeuralAssetGenerationRequest,
  type NeuralAssetGenerationReceipt,
  type NeuralInputReference,
  type NeuralProviderDeclaration,
  type NeuralWorkerQualification,
} from "./execution.js";
import { sealNeuralMeshTensorPayload } from "./mesh-attribute-tensor.js";

export const TRELLIS2_SOURCE_COMMIT = "75fbf0183001ed9876c8dbb35de6b68552ee08bd";
export const TRELLIS2_MODEL_ID = "microsoft/TRELLIS.2-4B";
export const TRELLIS2_MODEL_REVISION = "af44b45f2e35a493886929c6d786e563ec68364d";

const modalImageId = z.string().regex(/^im-[A-Za-z0-9]+$/u);
const canonicalHashes = z
  .array(HASH_SCHEMA)
  .min(3)
  .superRefine((values, context) => {
    if (
      new Set(values).size !== values.length ||
      stableJson([...values].sort(compareCanonicalStrings)) !== stableJson(values)
    )
      context.addIssue({ code: "custom", message: "Snapshot hashes must be unique and canonical" });
  });

export const TRELLIS2_RUNTIME_QUALIFICATION_SCHEMA = z
  .object({
    kind: z.literal("Trellis2RuntimeQualification"),
    contract: z.literal("basalt-trellis2-runtime-qualification"),
    neuralQualificationHash: HASH_SCHEMA,
    providerDeclarationHash: HASH_SCHEMA,
    modalImageId,
    runtimeImageHash: HASH_SCHEMA,
    workerImplementationHash: HASH_SCHEMA,
    volumeSnapshotHashes: canonicalHashes,
    dependencyInventoryHash: HASH_SCHEMA,
    hardwareEvidenceHash: HASH_SCHEMA,
    rightsEvidenceHash: HASH_SCHEMA,
    dinoV3TermsSnapshotHash: HASH_SCHEMA,
    modelTermsSnapshotHash: HASH_SCHEMA,
    modelIdentityHash: HASH_SCHEMA,
    egressPolicyHash: HASH_SCHEMA,
    inputPolicyHash: HASH_SCHEMA,
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => verifyHash(value, context));
export type Trellis2RuntimeQualification = z.output<typeof TRELLIS2_RUNTIME_QUALIFICATION_SCHEMA>;

const referenceArtifact = z
  .object({
    artifactHash: HASH_SCHEMA,
    bytes: z.number().int().positive(),
    mediaType: z.literal("image/png"),
  })
  .strict();
const alphaStatistics = z
  .object({
    transparentPixels: z.number().int().nonnegative(),
    translucentPixels: z.number().int().nonnegative(),
    opaquePixels: z.number().int().positive(),
  })
  .strict();

export const TRELLIS2_WORKER_REFERENCE_SCHEMA = z
  .object({
    kind: z.literal("Trellis2WorkerReference"),
    contract: z.literal("basalt-trellis2-reference-image"),
    neuralInputReferenceHash: HASH_SCHEMA,
    artifact: referenceArtifact,
    decoding: z
      .object({
        width: z.number().int().positive().max(16_384),
        height: z.number().int().positive().max(16_384),
        bitDepth: z.literal(8),
        colorType: z.literal("rgba"),
        channelCount: z.literal(4),
        alphaMode: z.enum(["straight", "premultiplied"]),
        decoderIdentityHash: HASH_SCHEMA,
        decoderEvidenceHash: HASH_SCHEMA,
      })
      .strict(),
    alphaStatistics,
    rights: z
      .object({
        usage: z.enum(["creator_owned", "commercial_use_permitted", "evaluation_only"]),
        sourceLabel: z.string().trim().min(1).max(512),
        licenseId: z.string().trim().min(1).max(256),
        attribution: z.string().max(2048),
        evidenceHash: HASH_SCHEMA,
      })
      .strict(),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    const decodedPixels = value.decoding.width * value.decoding.height;
    const classifiedPixels =
      value.alphaStatistics.transparentPixels +
      value.alphaStatistics.translucentPixels +
      value.alphaStatistics.opaquePixels;
    if (decodedPixels !== classifiedPixels)
      context.addIssue({
        code: "custom",
        path: ["alphaStatistics"],
        message: "Alpha inventory differs from decoded dimensions",
      });
    if (value.alphaStatistics.transparentPixels + value.alphaStatistics.translucentPixels === 0)
      context.addIssue({
        code: "custom",
        path: ["alphaStatistics"],
        message: "TRELLIS.2 requires an explicit alpha mask",
      });
    verifyHash(value, context);
  });
export type Trellis2WorkerReference = z.output<typeof TRELLIS2_WORKER_REFERENCE_SCHEMA>;

export const TRELLIS2_PROFILE = deepFreezeJson({
  id: "trellis2-1024-cascade-12-step",
  pipeline: "1024_cascade",
  resolution: 1024,
  sparseStructure: { steps: 12, guidance: 7.5, rescale: 0.7, rescaleT: 5 },
  shape: { steps: 12, guidance: 7.5, rescale: 0.5, rescaleT: 3 },
  texture: { steps: 12, guidance: 1, rescale: 0, rescaleT: 3 },
});

const TRELLIS2_STAGE_SEQUENCE = [
  "model_load_started",
  "model_load_complete",
  "sparse_structure_complete",
  "shape_cascade_complete",
  "texture_cascade_complete",
  "mesh_decode_complete",
] as const;

const trellis2ProfileSchema = z
  .object({
    id: z.literal("trellis2-1024-cascade-12-step"),
    pipeline: z.literal("1024_cascade"),
    resolution: z.literal(1024),
    sparseStructure: z
      .object({
        steps: z.literal(12),
        guidance: z.literal(7.5),
        rescale: z.literal(0.7),
        rescaleT: z.literal(5),
      })
      .strict(),
    shape: z
      .object({
        steps: z.literal(12),
        guidance: z.literal(7.5),
        rescale: z.literal(0.5),
        rescaleT: z.literal(3),
      })
      .strict(),
    texture: z
      .object({
        steps: z.literal(12),
        guidance: z.literal(1),
        rescale: z.literal(0),
        rescaleT: z.literal(3),
      })
      .strict(),
  })
  .strict();

const runtimeBinding = z
  .object({
    modalImageId,
    runtimeImageHash: HASH_SCHEMA,
    workerImplementationHash: HASH_SCHEMA,
    dependencyInventoryHash: HASH_SCHEMA,
    dinoV3TermsSnapshotHash: HASH_SCHEMA,
    modelIdentityHash: HASH_SCHEMA,
    termsSnapshotHash: HASH_SCHEMA,
    egressPolicyHash: HASH_SCHEMA,
    inputPolicyHash: HASH_SCHEMA,
  })
  .strict();

export const TRELLIS2_WORKER_REQUEST_SCHEMA = z
  .object({
    kind: z.literal("Trellis2WorkerRequest"),
    contract: z.literal("basalt-trellis2-worker-request"),
    neuralRequestHash: HASH_SCHEMA,
    providerDeclarationHash: HASH_SCHEMA,
    neuralQualificationHash: HASH_SCHEMA,
    runtimeQualificationHash: HASH_SCHEMA,
    sourceCommit: z.literal(TRELLIS2_SOURCE_COMMIT),
    modelId: z.literal(TRELLIS2_MODEL_ID),
    modelRevision: z.literal(TRELLIS2_MODEL_REVISION),
    runtimeBinding,
    reference: TRELLIS2_WORKER_REFERENCE_SCHEMA,
    seed: z.number().int().nonnegative().max(0xffff_ffff),
    profile: trellis2ProfileSchema,
    delivery: z
      .object({
        expectedBoundsMeters: z
          .object({ x: Q32_32_SCHEMA, y: Q32_32_SCHEMA, z: Q32_32_SCHEMA })
          .strict(),
        maximumTriangles: z.number().int().positive().max(18_000),
        maximumTextureEdge: z.number().int().positive().max(2048),
        maximumMeshes: z.literal(1),
        requiredTextureChannels: z.tuple([
          z.literal("base_color"),
          z.literal("metallic"),
          z.literal("normals"),
          z.literal("opacity"),
          z.literal("roughness"),
        ]),
        transparency: z.literal("opaque_only"),
      })
      .strict(),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => verifyHash(value, context));
export type Trellis2WorkerRequest = z.output<typeof TRELLIS2_WORKER_REQUEST_SCHEMA>;

const tensorDescriptor = z
  .object({
    name: z.enum([
      "positions",
      "triangle_indices",
      "base_color",
      "roughness",
      "metallic",
      "opacity",
      "normals",
    ]),
    dtype: z.enum(["F32", "I32"]),
    shape: z.tuple([z.number().int().positive(), z.number().int().positive()]),
    valueRange: z.tuple([z.number().finite(), z.number().finite()]),
  })
  .strict();

export const TRELLIS2_WORKER_RESULT_SCHEMA = z
  .object({
    kind: z.literal("Trellis2WorkerResult"),
    contract: z.literal("basalt-trellis2-worker-result"),
    status: z.literal("candidate"),
    requestHash: HASH_SCHEMA,
    workerRequestHash: HASH_SCHEMA,
    neuralQualificationHash: HASH_SCHEMA,
    runtimeQualificationHash: HASH_SCHEMA,
    sourceCommit: z.literal(TRELLIS2_SOURCE_COMMIT),
    modelId: z.literal(TRELLIS2_MODEL_ID),
    modelRevision: z.literal(TRELLIS2_MODEL_REVISION),
    profileHash: HASH_SCHEMA,
    seed: z.number().int().nonnegative().max(0xffff_ffff),
    executionBinding: runtimeBinding
      .pick({
        modalImageId: true,
        runtimeImageHash: true,
        workerImplementationHash: true,
        dependencyInventoryHash: true,
        dinoV3TermsSnapshotHash: true,
      })
      .extend({ referenceArtifactHash: HASH_SCHEMA })
      .strict(),
    output: z
      .object({
        mediaType: z.literal("application/x-safetensors"),
        sha256: HASH_SCHEMA,
        bytes: z
          .number()
          .int()
          .positive()
          .max(2 * 1024 * 1024 * 1024),
        vertexCount: z.number().int().min(3),
        triangleCount: z.number().int().positive(),
        tensors: z.array(tensorDescriptor).length(7),
        transformOwnership: z
          .object({
            kind: z.literal("source_frame_unbaked"),
            sourceFrame: z.literal("trellis2-o-voxel-x-right-y-forward-z-up"),
            sourceToCanonicalMatrixColumnMajor: z.tuple([
              z.literal(1),
              z.literal(0),
              z.literal(0),
              z.literal(0),
              z.literal(0),
              z.literal(0),
              z.literal(-1),
              z.literal(0),
              z.literal(0),
              z.literal(1),
              z.literal(0),
              z.literal(0),
              z.literal(0),
              z.literal(0),
              z.literal(0),
              z.literal(1),
            ]),
          })
          .strict(),
        topology: z
          .object({
            connectedComponents: z.number().int().positive(),
            boundaryEdges: z.number().int().nonnegative(),
            nonManifoldEdges: z.number().int().nonnegative(),
          })
          .strict(),
      })
      .strict(),
    hardware: z
      .object({
        acceleratorVendor: z.literal("nvidia"),
        acceleratorModel: z.string().min(1),
        vramGiB: z.number().positive(),
        cudaVersion: z.string().min(1),
        driverVersion: z.string().min(1),
      })
      .strict(),
    runtime: z
      .object({
        networkNamespace: z.literal("denied"),
        networkAttempted: z.literal(false),
        downloads: z.literal(false),
        trustRemoteCode: z.literal(false),
        backgroundRemovalInstantiated: z.literal(false),
        officialExporterLoaded: z.literal(false),
        forbiddenRuntimeModules: z.array(z.string()).length(0),
      })
      .strict(),
    stages: z
      .array(
        z
          .object({
            stage: z.string(),
            at: z.string().datetime({ offset: true }),
            elapsedMs: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .length(6),
    startedAt: z.string().datetime({ offset: true }),
    endedAt: z.string().datetime({ offset: true }),
    elapsedMs: z.number().int().nonnegative(),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.profileHash !== contentHash(stableJson(TRELLIS2_PROFILE)))
      context.addIssue({
        code: "custom",
        path: ["profileHash"],
        message: "Result profile does not bind the sealed TRELLIS.2 profile",
      });
    if (stableJson(value.stages.map(({ stage }) => stage)) !== stableJson(TRELLIS2_STAGE_SEQUENCE))
      context.addIssue({
        code: "custom",
        path: ["stages"],
        message: "TRELLIS.2 stages are missing or out of order",
      });
    for (let index = 1; index < value.stages.length; index += 1) {
      if (value.stages[index]!.elapsedMs < value.stages[index - 1]!.elapsedMs)
        context.addIssue({
          code: "custom",
          path: ["stages", index, "elapsedMs"],
          message: "TRELLIS.2 stage elapsed time must be monotonic",
        });
    }
    verifyHash(value, context);
  });
export type Trellis2WorkerResult = z.output<typeof TRELLIS2_WORKER_RESULT_SCHEMA>;

export function sealTrellis2RuntimeQualification(input: {
  readonly provider: NeuralProviderDeclaration;
  readonly qualification: NeuralWorkerQualification;
  readonly modalImageId: string;
  readonly volumeSnapshotHashes: readonly string[];
  readonly dinoV3TermsSnapshotHash: string;
  readonly modelTermsSnapshotHash: string;
}): Trellis2RuntimeQualification {
  const provider = NEURAL_PROVIDER_DECLARATION_SCHEMA.parse(input.provider);
  const qualification = NEURAL_WORKER_QUALIFICATION_SCHEMA.parse(input.qualification);
  if (
    provider.providerId !== "trellis2" ||
    provider.status !== "eligible" ||
    qualification.status !== "eligible" ||
    qualification.providerId !== provider.providerId ||
    qualification.providerDeclarationHash !== provider.hash ||
    qualification.sourceCommitHash !== TRELLIS2_SOURCE_COMMIT ||
    qualification.modelRevisionHash !== TRELLIS2_MODEL_REVISION
  )
    throw new Error("TRELLIS.2 runtime qualification does not bind the eligible provider");
  return seal(TRELLIS2_RUNTIME_QUALIFICATION_SCHEMA, {
    kind: "Trellis2RuntimeQualification" as const,
    contract: "basalt-trellis2-runtime-qualification" as const,
    neuralQualificationHash: qualification.hash,
    providerDeclarationHash: provider.hash,
    modalImageId: input.modalImageId,
    runtimeImageHash: qualification.runtimeEnvironmentHash,
    workerImplementationHash: qualification.workerImplementationHash,
    volumeSnapshotHashes: [...input.volumeSnapshotHashes].sort(compareCanonicalStrings),
    dependencyInventoryHash: qualification.dependencyInventoryHash,
    hardwareEvidenceHash: qualification.hardwareEvidenceHash,
    rightsEvidenceHash: qualification.rightsEvidenceHash,
    dinoV3TermsSnapshotHash: input.dinoV3TermsSnapshotHash,
    modelTermsSnapshotHash: input.modelTermsSnapshotHash,
    modelIdentityHash: contentHash(
      stableJson({ modelId: TRELLIS2_MODEL_ID, modelRevision: TRELLIS2_MODEL_REVISION }),
    ),
    egressPolicyHash: contentHash(
      stableJson({ runtimeDownloads: "denied", runtimeEgress: "denied" }),
    ),
    inputPolicyHash: contentHash(
      stableJson({
        backgroundRemoval: "caller_supplied_alpha_only",
        inputPolicy: "single_rights_bound_rgba_png",
      }),
    ),
  });
}

export function sealTrellis2WorkerReference(input: {
  readonly reference: NeuralInputReference;
  readonly width: number;
  readonly height: number;
  readonly alphaMode: "straight" | "premultiplied";
  readonly decoderIdentityHash: string;
  readonly decoderEvidenceHash: string;
  readonly alphaStatistics: z.input<typeof alphaStatistics>;
  readonly rights: Omit<z.input<typeof TRELLIS2_WORKER_REFERENCE_SCHEMA>["rights"], "evidenceHash">;
}): Trellis2WorkerReference {
  const reference = NEURAL_INPUT_REFERENCE_SCHEMA.parse(input.reference);
  const material = {
    kind: "Trellis2WorkerReference" as const,
    contract: "basalt-trellis2-reference-image" as const,
    neuralInputReferenceHash: reference.hash,
    artifact: reference.artifact,
    decoding: {
      width: input.width,
      height: input.height,
      bitDepth: 8 as const,
      colorType: "rgba" as const,
      channelCount: 4 as const,
      alphaMode: input.alphaMode,
      decoderIdentityHash: input.decoderIdentityHash,
      decoderEvidenceHash: input.decoderEvidenceHash,
    },
    alphaStatistics: input.alphaStatistics,
    rights: { ...input.rights, evidenceHash: reference.rightsEvidenceHash },
  };
  return seal(TRELLIS2_WORKER_REFERENCE_SCHEMA, material);
}

export function sealTrellis2WorkerRequest(input: {
  readonly request: NeuralAssetGenerationRequest;
  readonly provider: NeuralProviderDeclaration;
  readonly qualification: NeuralWorkerQualification;
  readonly runtimeQualification: Trellis2RuntimeQualification;
  readonly reference: Trellis2WorkerReference;
  readonly maximumTextureEdge?: number;
}): Trellis2WorkerRequest {
  const request = NEURAL_ASSET_GENERATION_REQUEST_SCHEMA.parse(input.request);
  const provider = NEURAL_PROVIDER_DECLARATION_SCHEMA.parse(input.provider);
  const qualification = NEURAL_WORKER_QUALIFICATION_SCHEMA.parse(input.qualification);
  const runtime = TRELLIS2_RUNTIME_QUALIFICATION_SCHEMA.parse(input.runtimeQualification);
  const reference = TRELLIS2_WORKER_REFERENCE_SCHEMA.parse(input.reference);
  if (
    request.providerId !== "trellis2" ||
    request.operation !== "generate_geometry_and_materials" ||
    request.providerDeclarationHash !== provider.hash ||
    request.qualificationHash !== qualification.hash ||
    runtime.providerDeclarationHash !== provider.hash ||
    runtime.neuralQualificationHash !== qualification.hash ||
    reference.neuralInputReferenceHash !== request.reference.hash ||
    reference.artifact.artifactHash !== request.reference.artifact.artifactHash
  )
    throw new Error("TRELLIS.2 worker inputs do not bind one neural request");
  const material = {
    kind: "Trellis2WorkerRequest" as const,
    contract: "basalt-trellis2-worker-request" as const,
    neuralRequestHash: request.requestHash,
    providerDeclarationHash: provider.hash,
    neuralQualificationHash: qualification.hash,
    runtimeQualificationHash: runtime.hash,
    sourceCommit: TRELLIS2_SOURCE_COMMIT,
    modelId: TRELLIS2_MODEL_ID,
    modelRevision: TRELLIS2_MODEL_REVISION,
    runtimeBinding: {
      modalImageId: runtime.modalImageId,
      runtimeImageHash: runtime.runtimeImageHash,
      workerImplementationHash: runtime.workerImplementationHash,
      dependencyInventoryHash: runtime.dependencyInventoryHash,
      dinoV3TermsSnapshotHash: runtime.dinoV3TermsSnapshotHash,
      modelIdentityHash: runtime.modelIdentityHash,
      termsSnapshotHash: runtime.modelTermsSnapshotHash,
      egressPolicyHash: runtime.egressPolicyHash,
      inputPolicyHash: runtime.inputPolicyHash,
    },
    reference,
    seed: request.seed,
    profile: TRELLIS2_PROFILE,
    delivery: {
      expectedBoundsMeters: request.factoryRequest.job.expectedBoundsMeters,
      maximumTriangles: Math.min(
        request.factoryRequest.measurableConstraints.maximumTriangles,
        18_000,
      ),
      maximumTextureEdge: input.maximumTextureEdge ?? 2048,
      maximumMeshes: 1 as const,
      requiredTextureChannels: [
        "base_color",
        "metallic",
        "normals",
        "opacity",
        "roughness",
      ] as const,
      transparency: "opaque_only" as const,
    },
  };
  return seal(TRELLIS2_WORKER_REQUEST_SCHEMA, material);
}

export function retainTrellis2WorkerResult(input: {
  readonly request: NeuralAssetGenerationRequest;
  readonly workerRequest: Trellis2WorkerRequest;
  readonly runtimeQualification: Trellis2RuntimeQualification;
  readonly result: Trellis2WorkerResult;
  readonly costMicrousd: number;
  readonly peakGpuMemoryMiB: number;
}): NeuralAssetGenerationReceipt {
  const request = NEURAL_ASSET_GENERATION_REQUEST_SCHEMA.parse(input.request);
  const workerRequest = TRELLIS2_WORKER_REQUEST_SCHEMA.parse(input.workerRequest);
  const runtime = TRELLIS2_RUNTIME_QUALIFICATION_SCHEMA.parse(input.runtimeQualification);
  const result = TRELLIS2_WORKER_RESULT_SCHEMA.parse(input.result);
  if (
    result.requestHash !== request.requestHash ||
    result.workerRequestHash !== workerRequest.hash ||
    result.runtimeQualificationHash !== runtime.hash ||
    result.executionBinding.workerImplementationHash !== runtime.workerImplementationHash ||
    result.output.sha256.length !== 64
  )
    throw new Error("TRELLIS.2 worker result does not bind the retained execution");
  const meshPayload = sealNeuralMeshTensorPayload({
    artifact: {
      artifactHash: result.output.sha256,
      bytes: result.output.bytes,
      mediaType: "application/x-safetensors",
    },
    sourceCoordinateFrame: {
      name: result.output.transformOwnership.sourceFrame,
      handedness: "right_handed",
      up: "+Z",
      forward: "+Y",
      positionUnits: "provider_normalized",
      sourceToCanonicalMatrixColumnMajor:
        result.output.transformOwnership.sourceToCanonicalMatrixColumnMajor,
      transformsBaked: false,
    },
    vertexCount: result.output.vertexCount,
    triangleCount: result.output.triangleCount,
    tensors: result.output.tensors,
    topology: result.output.topology,
  });
  return sealNeuralAssetGenerationReceipt({
    requestHash: request.requestHash,
    providerId: "trellis2",
    providerDeclarationHash: request.providerDeclarationHash,
    qualificationHash: request.qualificationHash,
    workerImplementationHash: runtime.workerImplementationHash,
    modelRevisionHash: TRELLIS2_MODEL_REVISION,
    status: "eligible",
    meshPayload,
    lineageEvidenceHashes: [result.hash, runtime.hash, workerRequest.hash],
    resourceUse: {
      computeMilliseconds: result.elapsedMs,
      gpuMilliseconds: result.elapsedMs,
      peakGpuMemoryMiB: input.peakGpuMemoryMiB,
      costMicrousd: input.costMicrousd,
    },
    diagnostics: [],
  });
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
