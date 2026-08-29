import { z } from "zod";
import { contentHash, stableJson } from "../../contracts/src/index.js";
import { entityId, hashSchema } from "../../spatial-core/src/primitives.js";
import {
  QWEN_IMAGE_2512_PRODUCER,
  REFERENCE_IMAGE_PRODUCER_QUALIFICATION_SCHEMA,
  SAM3_PRODUCER,
  assertReferenceImageProducerQualificationIdentity,
  type ReferenceImageProducerQualification,
} from "./producers.js";
import {
  REFERENCE_IMAGE_WORKER_RECEIPT_SCHEMA,
  REFERENCE_IMAGE_WORKER_REQUEST_SCHEMA,
  assertReferenceImageWorkerReceiptIdentity,
  assertReferenceImageWorkerReceiptMatches,
  assertReferenceImageWorkerRequestIdentity,
} from "./execution.js";
import {
  REFERENCE_IMAGE_BINARY_ARTIFACT_SCHEMA,
  REFERENCE_IMAGE_JSON_ARTIFACT_SCHEMA,
} from "./references.js";

export {
  REFERENCE_IMAGE_BINARY_ARTIFACT_SCHEMA,
  REFERENCE_IMAGE_JSON_ARTIFACT_SCHEMA,
} from "./references.js";

export const REFERENCE_IMAGE_REQUEST_ABI = "basalt-reference-image-request@1" as const;
export const REFERENCE_IMAGE_ARTIFACT_ABI = "basalt-reference-image-artifact@4" as const;
export const REFERENCE_GENERATION_RECEIPT_ABI =
  "basalt-reference-image-generation-receipt@2" as const;
export const REFERENCE_SEGMENTATION_REQUEST_ABI =
  "basalt-reference-image-segmentation-request@1" as const;
export const REFERENCE_SEGMENTATION_RECEIPT_ABI =
  "basalt-reference-image-segmentation-receipt@2" as const;
export const REFERENCE_DECODER_EVIDENCE_ABI = "basalt-reference-image-decoder-evidence@1" as const;
export const REFERENCE_MASK_QUALITY_EVIDENCE_ABI =
  "basalt-reference-image-mask-quality-evidence@1" as const;

const pngArtifact = REFERENCE_IMAGE_BINARY_ARTIFACT_SCHEMA.safeExtend({
  mediaType: z.literal("image/png"),
}).strict();

const textArtifact = REFERENCE_IMAGE_BINARY_ARTIFACT_SCHEMA.safeExtend({
  mediaType: z.literal("text/plain"),
}).strict();

const compositionTarget = z
  .object({
    proposalHash: hashSchema,
    targetId: entityId,
    requirementHash: hashSchema,
    regionId: entityId,
    targetMaskHash: hashSchema,
    cameraHash: hashSchema,
  })
  .strict();

const requestMaterial = z
  .object({
    kind: z.literal("ReferenceImageRequest"),
    abi: z.literal(REFERENCE_IMAGE_REQUEST_ABI),
    producerQualificationHash: hashSchema,
    invocationHash: hashSchema,
    requirementHash: hashSchema,
    styleContractHash: hashSchema,
    prompt: z.string().trim().min(1).max(16_384),
    negativePrompt: z.string().max(8_192),
    creativeLatitude: z.number().finite().min(0).max(1),
    seedOrdinal: z.number().int().min(0).max(1_000_000),
    seed: z.number().int().min(0).max(2_147_483_647),
    canvas: z
      .object({
        width: z.number().int().min(256).max(2048).multipleOf(64),
        height: z.number().int().min(256).max(2048).multipleOf(64),
        colorSpace: z.literal("srgb"),
      })
      .strict(),
    subjectPolicy: z.literal("isolated_subject_clear_silhouette"),
    compositionTarget: compositionTarget.optional(),
    providerRequestArtifact: REFERENCE_IMAGE_JSON_ARTIFACT_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    const expectedSeed = deriveReferenceImageSeed(
      value.invocationHash,
      value.seedOrdinal,
      value.producerQualificationHash,
    );
    if (value.seed !== expectedSeed)
      context.addIssue({
        code: "custom",
        path: ["seed"],
        message: "Reference-image seed must derive from invocation, ordinal, and producer",
      });
    if (
      value.compositionTarget !== undefined &&
      value.compositionTarget.requirementHash !== value.requirementHash
    )
      context.addIssue({
        code: "custom",
        path: ["compositionTarget", "requirementHash"],
        message: "Composition target must bind the reference requirement",
      });
  });

export const REFERENCE_IMAGE_REQUEST_SCHEMA = requestMaterial.safeExtend({ hash: hashSchema });
export type ReferenceImageRequest = z.infer<typeof REFERENCE_IMAGE_REQUEST_SCHEMA>;

export function deriveReferenceImageSeed(
  invocationHash: string,
  seedOrdinal: number,
  producerQualificationHash: string,
): number {
  hashSchema.parse(invocationHash);
  z.number().int().min(0).max(1_000_000).parse(seedOrdinal);
  hashSchema.parse(producerQualificationHash);
  const digest = contentHash(
    stableJson({
      abi: REFERENCE_IMAGE_REQUEST_ABI,
      invocationHash,
      producerQualificationHash,
      seedOrdinal,
    }),
  );
  return Number.parseInt(digest.slice(0, 8), 16) & 0x7fffffff;
}

export function sealReferenceImageRequest(
  input: Omit<z.input<typeof requestMaterial>, "seed"> & { readonly seed?: never },
): ReferenceImageRequest {
  const material = requestMaterial.parse({
    ...input,
    seed: deriveReferenceImageSeed(
      input.invocationHash,
      input.seedOrdinal,
      input.producerQualificationHash,
    ),
  });
  return REFERENCE_IMAGE_REQUEST_SCHEMA.parse({
    ...material,
    hash: contentHash(stableJson(material)),
  });
}

export function assertReferenceImageRequestIdentity(
  value: unknown,
): asserts value is ReferenceImageRequest {
  const request = REFERENCE_IMAGE_REQUEST_SCHEMA.parse(value);
  const { hash, ...material } = request;
  if (contentHash(stableJson(material)) !== hash)
    throw new Error("Reference-image request identity is invalid");
}

const generationReceiptMaterial = z
  .object({
    kind: z.literal("ReferenceImageGenerationReceipt"),
    abi: z.literal(REFERENCE_GENERATION_RECEIPT_ABI),
    producerQualificationHash: hashSchema,
    requestHash: hashSchema,
    requestArtifactHash: hashSchema,
    workerReceiptHash: hashSchema,
    originalImageArtifactHash: hashSchema,
    status: z.literal("eligible"),
  })
  .strict();

export const REFERENCE_GENERATION_RECEIPT_SCHEMA = generationReceiptMaterial.safeExtend({
  hash: hashSchema,
});
export type ReferenceGenerationReceipt = z.infer<typeof REFERENCE_GENERATION_RECEIPT_SCHEMA>;

export function sealReferenceGenerationReceipt(
  input: z.input<typeof generationReceiptMaterial>,
): ReferenceGenerationReceipt {
  return sealIdentity(generationReceiptMaterial, REFERENCE_GENERATION_RECEIPT_SCHEMA, input);
}

export function assertReferenceGenerationReceiptIdentity(
  value: unknown,
): asserts value is ReferenceGenerationReceipt {
  assertSealedIdentity(
    REFERENCE_GENERATION_RECEIPT_SCHEMA,
    value,
    "Reference-image generation receipt",
  );
}

const segmentationRequestMaterial = z
  .object({
    kind: z.literal("ReferenceImageSegmentationRequest"),
    abi: z.literal(REFERENCE_SEGMENTATION_REQUEST_ABI),
    segmentationQualificationHash: hashSchema,
    referenceRequestHash: hashSchema,
    requirementHash: hashSchema,
    styleContractHash: hashSchema,
    inputImageArtifactHash: hashSchema,
    segmentationPrompt: z.string().trim().min(1).max(4096),
  })
  .strict();

export const REFERENCE_SEGMENTATION_REQUEST_SCHEMA = segmentationRequestMaterial.safeExtend({
  hash: hashSchema,
});
export type ReferenceSegmentationRequest = z.infer<typeof REFERENCE_SEGMENTATION_REQUEST_SCHEMA>;

export function sealReferenceSegmentationRequest(
  input: z.input<typeof segmentationRequestMaterial>,
): ReferenceSegmentationRequest {
  return sealIdentity(segmentationRequestMaterial, REFERENCE_SEGMENTATION_REQUEST_SCHEMA, input);
}

export function assertReferenceSegmentationRequestIdentity(
  value: unknown,
): asserts value is ReferenceSegmentationRequest {
  assertSealedIdentity(
    REFERENCE_SEGMENTATION_REQUEST_SCHEMA,
    value,
    "Reference-image segmentation request",
  );
}

const segmentationReceiptMaterial = z
  .object({
    kind: z.literal("ReferenceImageSegmentationReceipt"),
    abi: z.literal(REFERENCE_SEGMENTATION_RECEIPT_ABI),
    segmentationQualificationHash: hashSchema,
    requestHash: hashSchema,
    requestArtifactHash: hashSchema,
    inputImageArtifactHash: hashSchema,
    workerReceiptHash: hashSchema,
    alphaMaskArtifactHash: hashSchema,
    rgbaImageArtifactHash: hashSchema,
    decoderEvidenceArtifactHash: hashSchema,
    maskQualityEvidenceArtifactHash: hashSchema,
    status: z.literal("eligible"),
  })
  .strict();

export const REFERENCE_SEGMENTATION_RECEIPT_SCHEMA = segmentationReceiptMaterial.safeExtend({
  hash: hashSchema,
});
export type ReferenceSegmentationReceipt = z.infer<typeof REFERENCE_SEGMENTATION_RECEIPT_SCHEMA>;

export function sealReferenceSegmentationReceipt(
  input: z.input<typeof segmentationReceiptMaterial>,
): ReferenceSegmentationReceipt {
  return sealIdentity(segmentationReceiptMaterial, REFERENCE_SEGMENTATION_RECEIPT_SCHEMA, input);
}

export function assertReferenceSegmentationReceiptIdentity(
  value: unknown,
): asserts value is ReferenceSegmentationReceipt {
  assertSealedIdentity(
    REFERENCE_SEGMENTATION_RECEIPT_SCHEMA,
    value,
    "Reference-image segmentation receipt",
  );
}

const rightsEvidence = z
  .object({
    status: z.literal("eligible"),
    usage: z.literal("commercial_use_permitted"),
    basis: z.literal("qualified_generated_output"),
    sourceLabel: z.string().trim().min(1).max(256),
    licenseId: z.string().trim().min(1).max(256),
    attribution: z.string().max(4096),
    producerQualificationHash: hashSchema,
    segmentationQualificationHash: hashSchema,
    producerTermsSnapshotHash: hashSchema,
    segmentationTermsSnapshotHash: hashSchema,
    inputRightsEvidenceHashes: z.array(hashSchema).min(1).max(64),
    evidenceArtifact: textArtifact,
    reviewArtifact: REFERENCE_IMAGE_JSON_ARTIFACT_SCHEMA,
    reviewerIdentityHash: hashSchema,
    reviewedAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((value, context) => {
    const canonical = [...value.inputRightsEvidenceHashes].sort();
    if (stableJson(canonical) !== stableJson(value.inputRightsEvidenceHashes))
      context.addIssue({
        code: "custom",
        path: ["inputRightsEvidenceHashes"],
        message: "Input-rights evidence hashes must be canonical",
      });
    if (new Set(value.inputRightsEvidenceHashes).size !== value.inputRightsEvidenceHashes.length)
      context.addIssue({
        code: "custom",
        path: ["inputRightsEvidenceHashes"],
        message: "Input-rights evidence hashes must be unique",
      });
  });

const maskQualityClaims = z
  .object({
    status: z.literal("eligible"),
    foregroundPixels: z.number().int().positive(),
    backgroundPixels: z.number().int().positive(),
    translucentBoundaryPixels: z.number().int().nonnegative(),
    connectedComponents: z.number().int().positive(),
    largestComponentPixels: z.number().int().positive(),
    borderForegroundPixels: z.number().int().nonnegative(),
    enclosedBackgroundComponents: z.number().int().nonnegative(),
    meanBoundaryConfidence: z.number().finite().min(0).max(1),
    segmentationPrompt: z.string().trim().min(1).max(4096),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.largestComponentPixels > value.foregroundPixels)
      context.addIssue({
        code: "custom",
        path: ["largestComponentPixels"],
        message: "Largest mask component cannot exceed foreground coverage",
      });
    if (value.borderForegroundPixels > value.foregroundPixels)
      context.addIssue({
        code: "custom",
        path: ["borderForegroundPixels"],
        message: "Border mask coverage cannot exceed foreground coverage",
      });
  });

const maskQuality = maskQualityClaims.safeExtend({
  reportArtifact: REFERENCE_IMAGE_JSON_ARTIFACT_SCHEMA,
});

const decoderEvidenceMaterial = z
  .object({
    kind: z.literal("ReferenceImageDecoderEvidence"),
    abi: z.literal(REFERENCE_DECODER_EVIDENCE_ABI),
    originalImageArtifactHash: hashSchema,
    alphaMaskArtifactHash: hashSchema,
    rgbaImageArtifactHash: hashSchema,
    width: z.number().int().min(256).max(2048),
    height: z.number().int().min(256).max(2048),
    originalChannels: z.union([z.literal(3), z.literal(4)]),
    maskChannels: z.literal(1),
    rgbaChannels: z.literal(4),
    alphaMode: z.literal("straight"),
    colorSpace: z.literal("srgb"),
    decoderIdentityHash: hashSchema,
    compositorIdentityHash: hashSchema,
    status: z.literal("eligible"),
  })
  .strict();

export const REFERENCE_DECODER_EVIDENCE_SCHEMA = decoderEvidenceMaterial.safeExtend({
  hash: hashSchema,
});
export type ReferenceDecoderEvidence = z.infer<typeof REFERENCE_DECODER_EVIDENCE_SCHEMA>;

export function sealReferenceDecoderEvidence(
  input: z.input<typeof decoderEvidenceMaterial>,
): ReferenceDecoderEvidence {
  return sealIdentity(decoderEvidenceMaterial, REFERENCE_DECODER_EVIDENCE_SCHEMA, input);
}

export function assertReferenceDecoderEvidenceIdentity(
  value: unknown,
): asserts value is ReferenceDecoderEvidence {
  assertSealedIdentity(
    REFERENCE_DECODER_EVIDENCE_SCHEMA,
    value,
    "Reference-image decoder evidence",
  );
}

const maskQualityEvidenceMaterial = z
  .object({
    kind: z.literal("ReferenceImageMaskQualityEvidence"),
    abi: z.literal(REFERENCE_MASK_QUALITY_EVIDENCE_ABI),
    alphaMaskArtifactHash: hashSchema,
    rgbaImageArtifactHash: hashSchema,
    width: z.number().int().min(256).max(2048),
    height: z.number().int().min(256).max(2048),
    maskQuality: maskQualityClaims,
  })
  .strict();

export const REFERENCE_MASK_QUALITY_EVIDENCE_SCHEMA = maskQualityEvidenceMaterial.safeExtend({
  hash: hashSchema,
});
export type ReferenceMaskQualityEvidence = z.infer<typeof REFERENCE_MASK_QUALITY_EVIDENCE_SCHEMA>;

export function sealReferenceMaskQualityEvidence(
  input: z.input<typeof maskQualityEvidenceMaterial>,
): ReferenceMaskQualityEvidence {
  return sealIdentity(maskQualityEvidenceMaterial, REFERENCE_MASK_QUALITY_EVIDENCE_SCHEMA, input);
}

export function assertReferenceMaskQualityEvidenceIdentity(
  value: unknown,
): asserts value is ReferenceMaskQualityEvidence {
  assertSealedIdentity(
    REFERENCE_MASK_QUALITY_EVIDENCE_SCHEMA,
    value,
    "Reference-image mask-quality evidence",
  );
}

const artifactMaterial = z
  .object({
    kind: z.literal("ReferenceImageArtifact"),
    abi: z.literal(REFERENCE_IMAGE_ARTIFACT_ABI),
    request: REFERENCE_IMAGE_REQUEST_SCHEMA,
    producerQualification: REFERENCE_IMAGE_PRODUCER_QUALIFICATION_SCHEMA,
    segmentationQualification: REFERENCE_IMAGE_PRODUCER_QUALIFICATION_SCHEMA,
    images: z
      .object({
        original: pngArtifact,
        alphaMask: pngArtifact,
        rgba: pngArtifact,
        width: z.number().int().min(256).max(2048),
        height: z.number().int().min(256).max(2048),
        originalChannels: z.union([z.literal(3), z.literal(4)]),
        maskChannels: z.literal(1),
        rgbaChannels: z.literal(4),
        alphaMode: z.literal("straight"),
        colorSpace: z.literal("srgb"),
        decoderIdentityHash: hashSchema,
        decoderReportArtifact: REFERENCE_IMAGE_JSON_ARTIFACT_SCHEMA,
        compositorIdentityHash: hashSchema,
        compositorReportArtifact: REFERENCE_IMAGE_JSON_ARTIFACT_SCHEMA,
      })
      .strict(),
    maskQuality,
    rights: rightsEvidence,
    lineage: z
      .object({
        producerQualificationArtifact: REFERENCE_IMAGE_JSON_ARTIFACT_SCHEMA,
        segmentationQualificationArtifact: REFERENCE_IMAGE_JSON_ARTIFACT_SCHEMA,
        generationRequestArtifact: REFERENCE_IMAGE_JSON_ARTIFACT_SCHEMA,
        generationWorkerRequest: REFERENCE_IMAGE_WORKER_REQUEST_SCHEMA,
        generationWorkerRequestArtifact: REFERENCE_IMAGE_JSON_ARTIFACT_SCHEMA,
        generationWorkerReceipt: REFERENCE_IMAGE_WORKER_RECEIPT_SCHEMA,
        generationWorkerReceiptArtifact: REFERENCE_IMAGE_JSON_ARTIFACT_SCHEMA,
        generationReceipt: REFERENCE_GENERATION_RECEIPT_SCHEMA,
        generationReceiptArtifact: REFERENCE_IMAGE_JSON_ARTIFACT_SCHEMA,
        segmentationRequest: REFERENCE_SEGMENTATION_REQUEST_SCHEMA,
        segmentationRequestArtifact: REFERENCE_IMAGE_JSON_ARTIFACT_SCHEMA,
        segmentationWorkerRequest: REFERENCE_IMAGE_WORKER_REQUEST_SCHEMA,
        segmentationWorkerRequestArtifact: REFERENCE_IMAGE_JSON_ARTIFACT_SCHEMA,
        segmentationWorkerReceipt: REFERENCE_IMAGE_WORKER_RECEIPT_SCHEMA,
        segmentationWorkerReceiptArtifact: REFERENCE_IMAGE_JSON_ARTIFACT_SCHEMA,
        segmentationReceipt: REFERENCE_SEGMENTATION_RECEIPT_SCHEMA,
        segmentationReceiptArtifact: REFERENCE_IMAGE_JSON_ARTIFACT_SCHEMA,
        decoderEvidence: REFERENCE_DECODER_EVIDENCE_SCHEMA,
        maskQualityEvidence: REFERENCE_MASK_QUALITY_EVIDENCE_SCHEMA,
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    validateArtifactBindings(value, context);
  });

export const REFERENCE_IMAGE_ARTIFACT_SCHEMA = artifactMaterial.safeExtend({ hash: hashSchema });
export type ReferenceImageArtifact = z.infer<typeof REFERENCE_IMAGE_ARTIFACT_SCHEMA>;

export function sealReferenceImageArtifact(
  input: z.input<typeof artifactMaterial>,
): ReferenceImageArtifact {
  assertReferenceImageRequestIdentity(input.request);
  assertReferenceImageProducerQualificationIdentity(input.producerQualification);
  assertReferenceImageProducerQualificationIdentity(input.segmentationQualification);
  assertLineageIdentities(input);
  const material = artifactMaterial.parse(input);
  return REFERENCE_IMAGE_ARTIFACT_SCHEMA.parse({
    ...material,
    hash: contentHash(stableJson(material)),
  });
}

export function assertReferenceImageArtifactIdentity(
  value: unknown,
): asserts value is ReferenceImageArtifact {
  const artifact = REFERENCE_IMAGE_ARTIFACT_SCHEMA.parse(value);
  assertReferenceImageRequestIdentity(artifact.request);
  assertReferenceImageProducerQualificationIdentity(artifact.producerQualification);
  assertReferenceImageProducerQualificationIdentity(artifact.segmentationQualification);
  assertLineageIdentities(artifact);
  const { hash, ...material } = artifact;
  if (contentHash(stableJson(material)) !== hash)
    throw new Error("Reference-image artifact identity is invalid");
}

function validateArtifactBindings(
  value: z.infer<typeof artifactMaterial>,
  context: z.RefinementCtx,
): void {
  const producer = value.producerQualification;
  const segmentation = value.segmentationQualification;
  if (producer.producer.id !== QWEN_IMAGE_2512_PRODUCER.id)
    context.addIssue({
      code: "custom",
      path: ["producerQualification", "producer", "id"],
      message: "Asset reference generation requires the pinned Qwen-Image-2512 producer",
    });
  if (segmentation.producer.id !== SAM3_PRODUCER.id)
    context.addIssue({
      code: "custom",
      path: ["segmentationQualification", "producer", "id"],
      message: "Asset reference masks require the pinned SAM 3 producer",
    });
  if (producer.localStatus !== "eligible")
    context.addIssue({
      code: "custom",
      path: ["producerQualification", "localStatus"],
      message: "Reference-image producer is not eligible",
    });
  if (segmentation.localStatus !== "eligible")
    context.addIssue({
      code: "custom",
      path: ["segmentationQualification", "localStatus"],
      message: "Segmentation producer is not eligible",
    });
  if (value.request.producerQualificationHash !== producer.hash)
    context.addIssue({
      code: "custom",
      path: ["request", "producerQualificationHash"],
      message: "Reference request must bind its exact producer qualification",
    });
  if (!jsonArtifactRetains(value.lineage.producerQualificationArtifact, producer))
    context.addIssue({
      code: "custom",
      path: ["lineage", "producerQualificationArtifact"],
      message: "Producer qualification artifact must retain the nested qualification exactly",
    });
  if (!jsonArtifactRetains(value.lineage.segmentationQualificationArtifact, segmentation))
    context.addIssue({
      code: "custom",
      path: ["lineage", "segmentationQualificationArtifact"],
      message: "Segmentation qualification artifact must retain the nested qualification exactly",
    });
  if (!jsonArtifactRetains(value.lineage.generationRequestArtifact, value.request))
    context.addIssue({
      code: "custom",
      path: ["lineage", "generationRequestArtifact"],
      message: "Generation request artifact must retain the nested request exactly",
    });
  if (
    value.images.width !== value.request.canvas.width ||
    value.images.height !== value.request.canvas.height
  )
    context.addIssue({
      code: "custom",
      path: ["images"],
      message: "Decoded reference dimensions must match the exact request canvas",
    });
  const pixelCount = value.images.width * value.images.height;
  if (value.maskQuality.foregroundPixels + value.maskQuality.backgroundPixels !== pixelCount)
    context.addIssue({
      code: "custom",
      path: ["maskQuality"],
      message: "Mask foreground and background counts must cover every pixel",
    });
  if (
    value.maskQuality.translucentBoundaryPixels >= value.maskQuality.foregroundPixels ||
    value.maskQuality.translucentBoundaryPixels > pixelCount
  )
    context.addIssue({
      code: "custom",
      path: ["maskQuality", "translucentBoundaryPixels"],
      message: "Translucent boundary coverage must leave opaque foreground pixels",
    });
  if (value.rights.producerQualificationHash !== producer.hash)
    context.addIssue({
      code: "custom",
      path: ["rights", "producerQualificationHash"],
      message: "Rights evidence must bind the exact image-producer qualification",
    });
  if (value.rights.segmentationQualificationHash !== segmentation.hash)
    context.addIssue({
      code: "custom",
      path: ["rights", "segmentationQualificationHash"],
      message: "Rights evidence must bind the exact segmentation qualification",
    });
  if (value.rights.producerTermsSnapshotHash !== producer.terms.modelTermsArtifact.artifactHash)
    context.addIssue({
      code: "custom",
      path: ["rights", "producerTermsSnapshotHash"],
      message: "Rights evidence must bind the retained image-model terms",
    });
  if (
    value.rights.segmentationTermsSnapshotHash !==
    segmentation.terms.modelTermsArtifact.artifactHash
  )
    context.addIssue({
      code: "custom",
      path: ["rights", "segmentationTermsSnapshotHash"],
      message: "Rights evidence must bind the retained segmentation-model terms",
    });
  const generationReceipt = value.lineage.generationReceipt;
  if (
    generationReceipt.producerQualificationHash !== producer.hash ||
    generationReceipt.requestHash !== value.request.hash ||
    generationReceipt.requestArtifactHash !==
      value.lineage.generationRequestArtifact.artifactHash ||
    generationReceipt.workerReceiptHash !== value.lineage.generationWorkerReceipt.hash ||
    generationReceipt.originalImageArtifactHash !== value.images.original.artifactHash ||
    value.lineage.generationWorkerRequest.payload.kind !== "isolated_reference" ||
    value.lineage.generationWorkerRequest.payload.referenceRequestHash !== value.request.hash ||
    value.lineage.generationWorkerRequest.payload.referenceRequestArtifactHash !==
      value.lineage.generationRequestArtifact.artifactHash ||
    value.lineage.generationWorkerRequest.payload.requirementHash !==
      value.request.requirementHash ||
    value.lineage.generationWorkerRequest.payload.styleContractHash !==
      value.request.styleContractHash ||
    value.lineage.generationWorkerRequest.payload.prompt !== value.request.prompt ||
    value.lineage.generationWorkerRequest.payload.negativePrompt !== value.request.negativePrompt ||
    value.lineage.generationWorkerRequest.payload.creativeLatitude !==
      value.request.creativeLatitude ||
    value.lineage.generationWorkerRequest.payload.seed !== value.request.seed ||
    stableJson(value.lineage.generationWorkerRequest.payload.canvas) !==
      stableJson(value.request.canvas) ||
    value.lineage.generationWorkerRequest.payload.subjectPolicy !== value.request.subjectPolicy ||
    value.lineage.generationWorkerReceipt.output.sha256 !== value.images.original.artifactHash ||
    !jsonArtifactRetains(
      value.lineage.generationWorkerRequestArtifact,
      value.lineage.generationWorkerRequest,
    ) ||
    !jsonArtifactRetains(
      value.lineage.generationWorkerReceiptArtifact,
      value.lineage.generationWorkerReceipt,
    ) ||
    !jsonArtifactRetains(value.lineage.generationReceiptArtifact, generationReceipt)
  )
    context.addIssue({
      code: "custom",
      path: ["lineage", "generationReceipt"],
      message: "Generation receipt must bind the exact request, producer, and original image",
    });
  const segmentationRequest = value.lineage.segmentationRequest;
  if (
    segmentationRequest.segmentationQualificationHash !== segmentation.hash ||
    segmentationRequest.referenceRequestHash !== value.request.hash ||
    segmentationRequest.requirementHash !== value.request.requirementHash ||
    segmentationRequest.styleContractHash !== value.request.styleContractHash ||
    segmentationRequest.inputImageArtifactHash !== value.images.original.artifactHash ||
    segmentationRequest.segmentationPrompt !== value.maskQuality.segmentationPrompt ||
    !jsonArtifactRetains(value.lineage.segmentationRequestArtifact, segmentationRequest)
  )
    context.addIssue({
      code: "custom",
      path: ["lineage", "segmentationRequest"],
      message: "Segmentation request must bind the exact reference request and source image",
    });
  const segmentationReceipt = value.lineage.segmentationReceipt;
  if (
    segmentationReceipt.segmentationQualificationHash !== segmentation.hash ||
    segmentationReceipt.requestHash !== segmentationRequest.hash ||
    segmentationReceipt.requestArtifactHash !==
      value.lineage.segmentationRequestArtifact.artifactHash ||
    segmentationReceipt.inputImageArtifactHash !== value.images.original.artifactHash ||
    segmentationReceipt.workerReceiptHash !== value.lineage.segmentationWorkerReceipt.hash ||
    segmentationReceipt.alphaMaskArtifactHash !== value.images.alphaMask.artifactHash ||
    segmentationReceipt.rgbaImageArtifactHash !== value.images.rgba.artifactHash ||
    segmentationReceipt.decoderEvidenceArtifactHash !==
      value.images.decoderReportArtifact.artifactHash ||
    segmentationReceipt.maskQualityEvidenceArtifactHash !==
      value.maskQuality.reportArtifact.artifactHash ||
    value.lineage.segmentationWorkerRequest.payload.kind !== "prompted_segmentation" ||
    value.lineage.segmentationWorkerRequest.payload.segmentationRequestHash !==
      segmentationRequest.hash ||
    value.lineage.segmentationWorkerRequest.payload.segmentationRequestArtifactHash !==
      value.lineage.segmentationRequestArtifact.artifactHash ||
    value.lineage.segmentationWorkerRequest.payload.referenceRequestHash !== value.request.hash ||
    value.lineage.segmentationWorkerRequest.payload.requirementHash !==
      value.request.requirementHash ||
    value.lineage.segmentationWorkerRequest.payload.styleContractHash !==
      value.request.styleContractHash ||
    value.lineage.segmentationWorkerRequest.payload.inputImage.artifactHash !==
      value.images.original.artifactHash ||
    value.lineage.segmentationWorkerRequest.payload.width !== value.images.width ||
    value.lineage.segmentationWorkerRequest.payload.height !== value.images.height ||
    value.lineage.segmentationWorkerRequest.payload.segmentationPrompt !==
      segmentationRequest.segmentationPrompt ||
    value.lineage.segmentationWorkerReceipt.output.sha256 !== value.images.alphaMask.artifactHash ||
    !jsonArtifactRetains(
      value.lineage.segmentationWorkerRequestArtifact,
      value.lineage.segmentationWorkerRequest,
    ) ||
    !jsonArtifactRetains(
      value.lineage.segmentationWorkerReceiptArtifact,
      value.lineage.segmentationWorkerReceipt,
    ) ||
    !jsonArtifactRetains(value.lineage.segmentationReceiptArtifact, segmentationReceipt)
  )
    context.addIssue({
      code: "custom",
      path: ["lineage", "segmentationReceipt"],
      message: "Segmentation receipt must bind the exact mask, RGBA image, and evidence",
    });
  const decoder = value.lineage.decoderEvidence;
  if (
    decoder.originalImageArtifactHash !== value.images.original.artifactHash ||
    decoder.alphaMaskArtifactHash !== value.images.alphaMask.artifactHash ||
    decoder.rgbaImageArtifactHash !== value.images.rgba.artifactHash ||
    decoder.width !== value.images.width ||
    decoder.height !== value.images.height ||
    decoder.originalChannels !== value.images.originalChannels ||
    decoder.maskChannels !== value.images.maskChannels ||
    decoder.rgbaChannels !== value.images.rgbaChannels ||
    decoder.alphaMode !== value.images.alphaMode ||
    decoder.colorSpace !== value.images.colorSpace ||
    decoder.decoderIdentityHash !== value.images.decoderIdentityHash ||
    decoder.compositorIdentityHash !== value.images.compositorIdentityHash ||
    !jsonArtifactRetains(value.images.decoderReportArtifact, decoder)
  )
    context.addIssue({
      code: "custom",
      path: ["lineage", "decoderEvidence"],
      message: "Decoder evidence must bind the exact retained image set",
    });
  const mask = value.lineage.maskQualityEvidence;
  const { reportArtifact: _maskReportArtifact, ...retainedMaskClaims } = value.maskQuality;
  if (
    mask.alphaMaskArtifactHash !== value.images.alphaMask.artifactHash ||
    mask.rgbaImageArtifactHash !== value.images.rgba.artifactHash ||
    mask.width !== value.images.width ||
    mask.height !== value.images.height ||
    stableJson(mask.maskQuality) !== stableJson(retainedMaskClaims) ||
    !jsonArtifactRetains(value.maskQuality.reportArtifact, mask)
  )
    context.addIssue({
      code: "custom",
      path: ["lineage", "maskQualityEvidence"],
      message: "Mask-quality evidence must bind the exact retained mask claims",
    });
}

export function assertEligibleReferenceImageArtifact(
  value: unknown,
): asserts value is ReferenceImageArtifact {
  assertReferenceImageArtifactIdentity(value);
}

export function referenceImageQualificationHashes(artifact: ReferenceImageArtifact): {
  readonly producerQualificationHash: string;
  readonly segmentationQualificationHash: string;
} {
  assertReferenceImageArtifactIdentity(artifact);
  return {
    producerQualificationHash: artifact.producerQualification.hash,
    segmentationQualificationHash: artifact.segmentationQualification.hash,
  };
}

export type { ReferenceImageProducerQualification };

function assertLineageIdentities(value: z.infer<typeof artifactMaterial>): void {
  assertReferenceImageWorkerRequestIdentity(value.lineage.generationWorkerRequest);
  assertReferenceImageWorkerReceiptIdentity(value.lineage.generationWorkerReceipt);
  assertReferenceImageWorkerReceiptMatches(
    value.lineage.generationWorkerReceipt,
    value.lineage.generationWorkerRequest,
    value.producerQualification,
  );
  assertReferenceGenerationReceiptIdentity(value.lineage.generationReceipt);
  assertReferenceSegmentationRequestIdentity(value.lineage.segmentationRequest);
  assertReferenceImageWorkerRequestIdentity(value.lineage.segmentationWorkerRequest);
  assertReferenceImageWorkerReceiptIdentity(value.lineage.segmentationWorkerReceipt);
  assertReferenceImageWorkerReceiptMatches(
    value.lineage.segmentationWorkerReceipt,
    value.lineage.segmentationWorkerRequest,
    value.segmentationQualification,
  );
  assertReferenceSegmentationReceiptIdentity(value.lineage.segmentationReceipt);
  assertReferenceDecoderEvidenceIdentity(value.lineage.decoderEvidence);
  assertReferenceMaskQualityEvidenceIdentity(value.lineage.maskQualityEvidence);
}

function jsonArtifactRetains(
  reference: { readonly artifactHash: string },
  value: unknown,
): boolean {
  return reference.artifactHash === contentHash(`${stableJson(value)}\n`);
}

function sealIdentity<MaterialSchema extends z.ZodType, IdentitySchema extends z.ZodType>(
  materialSchema: MaterialSchema,
  identitySchema: IdentitySchema,
  input: z.input<MaterialSchema>,
): z.output<IdentitySchema> {
  const material = materialSchema.parse(input) as Record<string, unknown>;
  return identitySchema.parse({ ...material, hash: contentHash(stableJson(material)) });
}

function assertSealedIdentity<IdentitySchema extends z.ZodType>(
  schema: IdentitySchema,
  value: unknown,
  label: string,
): void {
  const identity = schema.parse(value) as Record<string, unknown>;
  const { hash, ...material } = identity;
  if (typeof hash !== "string" || contentHash(stableJson(material)) !== hash)
    throw new Error(`${label} identity is invalid`);
}
