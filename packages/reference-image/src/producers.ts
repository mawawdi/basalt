import { z } from "zod";
import { contentHash, stableJson } from "../../contracts/src/index.js";
import { hashSchema } from "../../spatial-core/src/primitives.js";

export const REFERENCE_IMAGE_PRODUCER_QUALIFICATION_ABI =
  "basalt-reference-image-producer-qualification@4" as const;

export const QWEN_IMAGE_SOURCE_REPOSITORY = "QwenLM/Qwen-Image" as const;
export const QWEN_IMAGE_SOURCE_COMMIT = "6b5e1f5cec987d404be5ac6657db3b9aacb56a89" as const;
export const QWEN_IMAGE_2512_MODEL_ID = "Qwen/Qwen-Image-2512" as const;
export const QWEN_IMAGE_2512_MODEL_REVISION = "25468b98e3276ca6700de15c6628e51b7de54a26" as const;
export const QWEN_IMAGE_EDIT_2511_MODEL_ID = "Qwen/Qwen-Image-Edit-2511" as const;
export const QWEN_IMAGE_EDIT_2511_MODEL_REVISION =
  "6f3ccc0b56e431dc6a0c2b2039706d7d26f22cb9" as const;

export const FLUX2_SOURCE_REPOSITORY = "black-forest-labs/flux2" as const;
export const FLUX2_SOURCE_COMMIT = "50fe5162777813d869182b139e83b10743caef15" as const;
export const FLUX2_KLEIN_4B_MODEL_ID = "black-forest-labs/FLUX.2-klein-4B" as const;
export const FLUX2_KLEIN_4B_MODEL_REVISION = "e7b7dc27f91deacad38e78976d1f2b499d76a294" as const;

export const LONGCAT_IMAGE_SOURCE_REPOSITORY = "meituan-longcat/LongCat-Image" as const;
export const LONGCAT_IMAGE_SOURCE_COMMIT = "f0e4c43c5ef74b011ff71570fbfc2bdffbc9ab06" as const;
export const LONGCAT_IMAGE_EDIT_MODEL_ID = "meituan-longcat/LongCat-Image-Edit" as const;
export const LONGCAT_IMAGE_EDIT_MODEL_REVISION =
  "7b54ef423aa7854be7861600024be5c56ab7875a" as const;

export const SAM3_SOURCE_REPOSITORY = "facebookresearch/sam3" as const;
export const SAM3_SOURCE_COMMIT = "660a5e9e1b8b4c02c0ad97229b88a09a6e4ff5b7" as const;
export const SAM3_MODEL_ID = "facebook/sam3" as const;
export const SAM3_MODEL_REVISION = "3c879f39826c281e95690f02c7821c4de09afae7" as const;

export const QWEN_IMAGE_2512_PRODUCER = Object.freeze({
  id: "qwen_image_2512",
  task: "isolated_reference_generation",
  sourceRepository: QWEN_IMAGE_SOURCE_REPOSITORY,
  sourceCommit: QWEN_IMAGE_SOURCE_COMMIT,
  modelId: QWEN_IMAGE_2512_MODEL_ID,
  modelRevision: QWEN_IMAGE_2512_MODEL_REVISION,
  licenseId: "Apache-2.0",
  licenseUrl: "https://huggingface.co/Qwen/Qwen-Image-2512",
} as const);

export const QWEN_IMAGE_EDIT_2511_PRODUCER = Object.freeze({
  id: "qwen_image_edit_2511",
  task: "regional_composition_generation",
  sourceRepository: QWEN_IMAGE_SOURCE_REPOSITORY,
  sourceCommit: QWEN_IMAGE_SOURCE_COMMIT,
  modelId: QWEN_IMAGE_EDIT_2511_MODEL_ID,
  modelRevision: QWEN_IMAGE_EDIT_2511_MODEL_REVISION,
  licenseId: "Apache-2.0",
  licenseUrl: "https://huggingface.co/Qwen/Qwen-Image-Edit-2511",
} as const);

export const FLUX2_KLEIN_4B_PRODUCER = Object.freeze({
  id: "flux2_klein_4b",
  task: "regional_composition_generation",
  sourceRepository: FLUX2_SOURCE_REPOSITORY,
  sourceCommit: FLUX2_SOURCE_COMMIT,
  modelId: FLUX2_KLEIN_4B_MODEL_ID,
  modelRevision: FLUX2_KLEIN_4B_MODEL_REVISION,
  licenseId: "Apache-2.0",
  licenseUrl: "https://huggingface.co/black-forest-labs/FLUX.2-klein-4B",
} as const);

export const LONGCAT_IMAGE_EDIT_PRODUCER = Object.freeze({
  id: "longcat_image_edit",
  task: "regional_composition_generation",
  sourceRepository: LONGCAT_IMAGE_SOURCE_REPOSITORY,
  sourceCommit: LONGCAT_IMAGE_SOURCE_COMMIT,
  modelId: LONGCAT_IMAGE_EDIT_MODEL_ID,
  modelRevision: LONGCAT_IMAGE_EDIT_MODEL_REVISION,
  licenseId: "Apache-2.0",
  licenseUrl: "https://huggingface.co/meituan-longcat/LongCat-Image-Edit",
} as const);

export const SAM3_PRODUCER = Object.freeze({
  id: "sam3",
  task: "prompted_segmentation",
  sourceRepository: SAM3_SOURCE_REPOSITORY,
  sourceCommit: SAM3_SOURCE_COMMIT,
  modelId: SAM3_MODEL_ID,
  modelRevision: SAM3_MODEL_REVISION,
  licenseId: "SAM-3-License",
  licenseUrl: "https://huggingface.co/facebook/sam3",
} as const);

const qwenImage2512ProducerSchema = z
  .object({
    id: z.literal(QWEN_IMAGE_2512_PRODUCER.id),
    task: z.literal(QWEN_IMAGE_2512_PRODUCER.task),
    sourceRepository: z.literal(QWEN_IMAGE_2512_PRODUCER.sourceRepository),
    sourceCommit: z.literal(QWEN_IMAGE_2512_PRODUCER.sourceCommit),
    modelId: z.literal(QWEN_IMAGE_2512_PRODUCER.modelId),
    modelRevision: z.literal(QWEN_IMAGE_2512_PRODUCER.modelRevision),
    licenseId: z.literal(QWEN_IMAGE_2512_PRODUCER.licenseId),
    licenseUrl: z.literal(QWEN_IMAGE_2512_PRODUCER.licenseUrl),
  })
  .strict();

const qwenImageEdit2511ProducerSchema = z
  .object({
    id: z.literal(QWEN_IMAGE_EDIT_2511_PRODUCER.id),
    task: z.literal(QWEN_IMAGE_EDIT_2511_PRODUCER.task),
    sourceRepository: z.literal(QWEN_IMAGE_EDIT_2511_PRODUCER.sourceRepository),
    sourceCommit: z.literal(QWEN_IMAGE_EDIT_2511_PRODUCER.sourceCommit),
    modelId: z.literal(QWEN_IMAGE_EDIT_2511_PRODUCER.modelId),
    modelRevision: z.literal(QWEN_IMAGE_EDIT_2511_PRODUCER.modelRevision),
    licenseId: z.literal(QWEN_IMAGE_EDIT_2511_PRODUCER.licenseId),
    licenseUrl: z.literal(QWEN_IMAGE_EDIT_2511_PRODUCER.licenseUrl),
  })
  .strict();

const flux2Klein4bProducerSchema = z
  .object({
    id: z.literal(FLUX2_KLEIN_4B_PRODUCER.id),
    task: z.literal(FLUX2_KLEIN_4B_PRODUCER.task),
    sourceRepository: z.literal(FLUX2_KLEIN_4B_PRODUCER.sourceRepository),
    sourceCommit: z.literal(FLUX2_KLEIN_4B_PRODUCER.sourceCommit),
    modelId: z.literal(FLUX2_KLEIN_4B_PRODUCER.modelId),
    modelRevision: z.literal(FLUX2_KLEIN_4B_PRODUCER.modelRevision),
    licenseId: z.literal(FLUX2_KLEIN_4B_PRODUCER.licenseId),
    licenseUrl: z.literal(FLUX2_KLEIN_4B_PRODUCER.licenseUrl),
  })
  .strict();

const longCatImageEditProducerSchema = z
  .object({
    id: z.literal(LONGCAT_IMAGE_EDIT_PRODUCER.id),
    task: z.literal(LONGCAT_IMAGE_EDIT_PRODUCER.task),
    sourceRepository: z.literal(LONGCAT_IMAGE_EDIT_PRODUCER.sourceRepository),
    sourceCommit: z.literal(LONGCAT_IMAGE_EDIT_PRODUCER.sourceCommit),
    modelId: z.literal(LONGCAT_IMAGE_EDIT_PRODUCER.modelId),
    modelRevision: z.literal(LONGCAT_IMAGE_EDIT_PRODUCER.modelRevision),
    licenseId: z.literal(LONGCAT_IMAGE_EDIT_PRODUCER.licenseId),
    licenseUrl: z.literal(LONGCAT_IMAGE_EDIT_PRODUCER.licenseUrl),
  })
  .strict();

const sam3ProducerSchema = z
  .object({
    id: z.literal(SAM3_PRODUCER.id),
    task: z.literal(SAM3_PRODUCER.task),
    sourceRepository: z.literal(SAM3_PRODUCER.sourceRepository),
    sourceCommit: z.literal(SAM3_PRODUCER.sourceCommit),
    modelId: z.literal(SAM3_PRODUCER.modelId),
    modelRevision: z.literal(SAM3_PRODUCER.modelRevision),
    licenseId: z.literal(SAM3_PRODUCER.licenseId),
    licenseUrl: z.literal(SAM3_PRODUCER.licenseUrl),
  })
  .strict();

export const REFERENCE_IMAGE_PRODUCER_SCHEMA = z.discriminatedUnion("id", [
  qwenImage2512ProducerSchema,
  qwenImageEdit2511ProducerSchema,
  flux2Klein4bProducerSchema,
  longCatImageEditProducerSchema,
  sam3ProducerSchema,
]);
export type ReferenceImageProducer = z.infer<typeof REFERENCE_IMAGE_PRODUCER_SCHEMA>;

export const REFERENCE_IMAGE_RUNTIME_POLICY = Object.freeze({
  runtimeEgress: "denied",
  runtimeDownloads: "denied",
  trustRemoteCode: false,
  weightProvisioning: "preloaded_immutable",
  outputRetention: "content_addressed",
} as const);

export const REFERENCE_IMAGE_RUNTIME_POLICY_SCHEMA = z
  .object({
    runtimeEgress: z.literal(REFERENCE_IMAGE_RUNTIME_POLICY.runtimeEgress),
    runtimeDownloads: z.literal(REFERENCE_IMAGE_RUNTIME_POLICY.runtimeDownloads),
    trustRemoteCode: z.literal(REFERENCE_IMAGE_RUNTIME_POLICY.trustRemoteCode),
    weightProvisioning: z.literal(REFERENCE_IMAGE_RUNTIME_POLICY.weightProvisioning),
    outputRetention: z.literal(REFERENCE_IMAGE_RUNTIME_POLICY.outputRetention),
  })
  .strict();

export const REFERENCE_IMAGE_RUNTIME_POLICY_HASH = contentHash(
  stableJson(REFERENCE_IMAGE_RUNTIME_POLICY),
);

const jsonArtifact = z
  .object({
    locator: z.string().regex(/^artifacts\/[a-f0-9]{64}\.json$/u),
    artifactHash: hashSchema,
    bytes: z
      .number()
      .int()
      .positive()
      .max(32 * 1024 * 1024),
  })
  .strict()
  .refine(
    (value) => value.locator === `artifacts/${value.artifactHash}.json`,
    "JSON artifact locator must identify its exact bytes",
  );

const textArtifact = z
  .object({
    locator: z.string().regex(/^binary-artifacts\/[a-f0-9]{64}\.bin$/u),
    artifactHash: hashSchema,
    bytes: z
      .number()
      .int()
      .positive()
      .max(32 * 1024 * 1024),
    mediaType: z.literal("text/plain"),
  })
  .strict()
  .refine(
    (value) => value.locator === `binary-artifacts/${value.artifactHash}.bin`,
    "Text artifact locator must identify its exact bytes",
  );

const status = z.enum(["eligible", "rejected", "incomplete"]);
const timestamp = z.string().datetime({ offset: true });
const modalImageId = z.string().regex(/^im-[A-Za-z0-9]+$/u);

export const REFERENCE_IMAGE_WORKER_CHECK_IDS = [
  "dependency_inventory",
  "immutable_source",
  "immutable_weights",
  "network_denial",
  "output_contract",
  "trust_remote_code_disabled",
] as const;

const review = z
  .object({
    status,
    reviewerIdentityHash: hashSchema,
    reviewedAt: timestamp.nullable(),
    evidenceArtifact: jsonArtifact,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status !== "incomplete" && value.reviewedAt === null)
      context.addIssue({
        code: "custom",
        path: ["reviewedAt"],
        message: "A completed producer review requires its retained timestamp",
      });
  });

const workerProbe = z
  .object({
    status,
    observedAt: timestamp.nullable(),
    checks: z
      .array(
        z
          .object({
            id: z.enum(REFERENCE_IMAGE_WORKER_CHECK_IDS),
            status,
            evidenceHash: hashSchema,
          })
          .strict(),
      )
      .length(REFERENCE_IMAGE_WORKER_CHECK_IDS.length),
    evidenceArtifact: jsonArtifact,
  })
  .strict()
  .superRefine((value, context) => {
    const ids = value.checks.map(({ id }) => id).sort();
    if (stableJson(ids) !== stableJson([...REFERENCE_IMAGE_WORKER_CHECK_IDS].sort()))
      context.addIssue({
        code: "custom",
        path: ["checks"],
        message: "Worker probe must retain every exact check once",
      });
    const derived = value.checks.some(({ status: checkStatus }) => checkStatus === "rejected")
      ? "rejected"
      : value.checks.some(({ status: checkStatus }) => checkStatus === "incomplete")
        ? "incomplete"
        : "eligible";
    if (value.status !== derived)
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "Worker probe status must be derived from its exact checks",
      });
    if (value.status !== "incomplete" && value.observedAt === null)
      context.addIssue({
        code: "custom",
        path: ["observedAt"],
        message: "A completed worker probe requires its retained timestamp",
      });
  });

const qualificationMaterial = z
  .object({
    kind: z.literal("ReferenceImageProducerQualification"),
    abi: z.literal(REFERENCE_IMAGE_PRODUCER_QUALIFICATION_ABI),
    producer: REFERENCE_IMAGE_PRODUCER_SCHEMA,
    producerIdentityHash: hashSchema,
    usageScope: z.literal("commercial"),
    runtime: z
      .object({
        modalImageId,
        runtimeImageHash: hashSchema,
        workerSourceHash: hashSchema,
        modelVolumeSnapshotHash: hashSchema,
        dependencyInventoryHash: hashSchema,
        dependencyInventoryArtifact: jsonArtifact,
        sbomArtifact: jsonArtifact,
        importTraceArtifact: jsonArtifact,
        modelInventoryArtifact: jsonArtifact,
        runtimePolicy: REFERENCE_IMAGE_RUNTIME_POLICY_SCHEMA,
        runtimePolicyHash: z.literal(REFERENCE_IMAGE_RUNTIME_POLICY_HASH),
      })
      .strict()
      .superRefine((value, context) => {
        if (value.dependencyInventoryHash !== value.dependencyInventoryArtifact.artifactHash)
          context.addIssue({
            code: "custom",
            path: ["dependencyInventoryHash"],
            message: "Dependency inventory hash must identify the retained inventory bytes",
          });
      }),
    terms: z
      .object({
        sourceLicenseArtifact: textArtifact,
        modelTermsArtifact: textArtifact,
        attribution: z.string().trim().min(1).max(4096),
        commercialReview: review,
      })
      .strict(),
    dependencyReview: review.safeExtend({
      forbiddenRuntimeImports: z.array(z.string().trim().min(1).max(256)).max(64),
    }),
    workerProbe,
    qualifiedAt: timestamp,
    localStatus: status,
    reasons: z.array(z.string().trim().min(1).max(256)).max(32),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.producerIdentityHash !== referenceImageProducerIdentityHash(value.producer))
      context.addIssue({
        code: "custom",
        path: ["producerIdentityHash"],
        message: "Producer identity must bind its exact pinned source and model",
      });
    const derived = deriveQualificationStatus(value);
    if (
      value.localStatus !== derived.localStatus ||
      stableJson(value.reasons) !== stableJson(derived.reasons)
    )
      context.addIssue({
        code: "custom",
        path: ["localStatus"],
        message: "Producer qualification status must be derived from retained evidence",
      });
  });

export const REFERENCE_IMAGE_PRODUCER_QUALIFICATION_SCHEMA = qualificationMaterial.safeExtend({
  hash: hashSchema,
});
export type ReferenceImageProducerQualification = z.infer<
  typeof REFERENCE_IMAGE_PRODUCER_QUALIFICATION_SCHEMA
>;

type QualificationMaterial = z.input<typeof qualificationMaterial>;

export function referenceImageProducerIdentityHash(producer: ReferenceImageProducer): string {
  return contentHash(stableJson(REFERENCE_IMAGE_PRODUCER_SCHEMA.parse(producer)));
}

export function sealReferenceImageProducerQualification(
  input: Omit<QualificationMaterial, "producerIdentityHash" | "localStatus" | "reasons">,
): ReferenceImageProducerQualification {
  const producer = REFERENCE_IMAGE_PRODUCER_SCHEMA.parse(input.producer);
  const withIdentity = {
    ...input,
    producer,
    producerIdentityHash: referenceImageProducerIdentityHash(producer),
  };
  const derived = deriveQualificationStatus({
    ...withIdentity,
    localStatus: "incomplete",
    reasons: [],
  });
  const material = qualificationMaterial.parse({ ...withIdentity, ...derived });
  return REFERENCE_IMAGE_PRODUCER_QUALIFICATION_SCHEMA.parse({
    ...material,
    hash: contentHash(stableJson(material)),
  });
}

export function assertReferenceImageProducerQualificationIdentity(
  value: unknown,
): asserts value is ReferenceImageProducerQualification {
  const qualification = REFERENCE_IMAGE_PRODUCER_QUALIFICATION_SCHEMA.parse(value);
  const { hash, ...material } = qualification;
  if (contentHash(stableJson(material)) !== hash)
    throw new Error("Reference-image producer qualification identity is invalid");
}

function deriveQualificationStatus(value: QualificationMaterial): {
  readonly localStatus: "eligible" | "rejected" | "incomplete";
  readonly reasons: string[];
} {
  const reasons: string[] = [];
  if (value.terms.commercialReview.status !== "eligible")
    reasons.push(`commercial_terms:${value.terms.commercialReview.status}`);
  if (value.dependencyReview.status !== "eligible")
    reasons.push(`dependency_review:${value.dependencyReview.status}`);
  if (value.dependencyReview.forbiddenRuntimeImports.length > 0)
    reasons.push("dependency_review:forbidden_runtime_import");
  if (value.workerProbe.status !== "eligible")
    reasons.push(`worker_probe:${value.workerProbe.status}`);
  reasons.sort();

  if (
    value.terms.commercialReview.status === "rejected" ||
    value.dependencyReview.status === "rejected" ||
    value.dependencyReview.forbiddenRuntimeImports.length > 0 ||
    value.workerProbe.status === "rejected"
  )
    return { localStatus: "rejected", reasons };
  return {
    localStatus: reasons.length === 0 ? "eligible" : "incomplete",
    reasons,
  };
}
