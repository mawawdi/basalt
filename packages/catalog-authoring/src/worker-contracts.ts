import { z } from "zod";
import { HASH_SCHEMA, contentHash, stableJson } from "@basalt/contracts";
import { CATALOG_ASSET_ARTIFACT_SCHEMA } from "@basalt/catalog-model";
import { CATALOG_EMBEDDING_PURPOSE_SCHEMA, CATALOG_QUANTIZED_VECTOR_SCHEMA } from "./embeddings.js";
import {
  ASSET_SEARCH_METADATA_REQUEST_SCHEMA,
  ASSET_SEARCH_METADATA_RECEIPT_SCHEMA,
  CATALOG_SEARCH_METADATA_SCHEMA,
  CATALOG_SELECTED_RGB_VIEW_SCHEMA,
} from "./metadata.js";
import {
  CATALOG_VALIDATION_REQUEST_SCHEMA,
  CATALOG_VISUAL_VALIDATION_SCHEMA,
} from "./validation.js";
import {
  ASSET_CONTEXT_HYPOTHESIS_JSON_SCHEMA_HASH,
  ASSET_CONTEXT_HYPOTHESIS_OUTPUT_SCHEMA,
  ASSET_CONTEXT_HYPOTHESIS_REQUEST_SCHEMA,
} from "./context.js";
import { CATALOG_SOURCE_NAME_HINT_SCHEMA } from "./source-name-hints.js";
import { requireCanonicalValues, verifyArtifactHash } from "./artifact.js";

export const CATALOG_MODEL_CAPABILITIES = [
  "context_interpreter",
  "image_text_retrieval",
  "metadata_writer",
  "requirement_validator",
  "shape_similarity",
] as const;
export const CATALOG_MODEL_CAPABILITY_SCHEMA = z.enum(CATALOG_MODEL_CAPABILITIES);

export const CATALOG_MODEL_DECLARATION_SCHEMA = z
  .object({
    modelId: z.string().regex(/^[a-z][a-z0-9_]{2,127}$/u),
    source: z.literal("huggingface"),
    repository: z.string().trim().min(1).max(256),
    sourceCommitHash: z.string().regex(/^[a-f0-9]{40,64}$/u),
    capabilities: z.array(CATALOG_MODEL_CAPABILITY_SCHEMA).min(1).max(5),
    accelerator: z.enum(["A100-80GB", "L40S"]),
  })
  .strict()
  .superRefine((value, context) =>
    requireCanonicalValues(value.capabilities, String, "model capabilities", context),
  );
export type CatalogModelDeclaration = z.output<typeof CATALOG_MODEL_DECLARATION_SCHEMA>;

export const CATALOG_MODEL_DECLARATIONS_SCHEMA = z
  .object({
    kind: z.literal("CatalogModelDeclarations"),
    models: z.array(CATALOG_MODEL_DECLARATION_SCHEMA).min(4),
  })
  .strict()
  .superRefine((value, context) => {
    const ids = value.models.map((entry) => entry.modelId);
    if (new Set(ids).size !== ids.length)
      context.addIssue({
        code: "custom",
        path: ["models"],
        message: "Catalog model IDs must be unique",
      });
    for (const capability of CATALOG_MODEL_CAPABILITIES)
      if (!value.models.some((model) => model.capabilities.includes(capability)))
        context.addIssue({
          code: "custom",
          path: ["models"],
          message: `No model provides ${capability}`,
        });
  });
export type CatalogModelDeclarations = z.output<typeof CATALOG_MODEL_DECLARATIONS_SCHEMA>;

const JSON_SCHEMA_VALUE = z.record(z.string(), z.unknown());
const PROMPT_TEMPLATE_SCHEMA = z
  .string()
  .min(1)
  .max(32_768)
  .refine((value) => value.trim().length > 0, "Prompt template must contain non-whitespace text");
export const CATALOG_WORKER_IMAGE_LONG_EDGE_PIXELS = 384;

const EVIDENCE_SIZE_SCHEMA = z.number().int().positive().safe();
const CATALOG_WORKER_INPUT_BUDGET_SCHEMA = z
  .object({
    assetCount: z.number().int().positive().safe(),
    evidenceFileCount: z.number().int().positive().safe(),
    evidenceBytes: z.number().int().positive().safe(),
    preprocessedPixelCeiling: z.number().int().positive().safe(),
  })
  .strict();

const CATALOG_CONTEXT_WORKER_INPUT_BUDGET_SCHEMA = z
  .object({
    candidateCount: z.number().int().min(2).safe(),
    evidenceFileCount: z.number().int().min(2).safe(),
    evidenceBytes: z.number().int().positive().safe(),
    preprocessedPixelCeiling: z.number().int().positive().safe(),
  })
  .strict();

const RELATIVE_EVIDENCE_PATH_SCHEMA = z
  .string()
  .trim()
  .min(1)
  .max(4_096)
  .refine(
    (value) => !value.startsWith("/") && !value.split(/[\\/]/u).includes(".."),
    "Evidence path must be relative",
  );

const METADATA_WORKER_ITEM_SCHEMA = z
  .object({
    request: ASSET_SEARCH_METADATA_REQUEST_SCHEMA,
    sourceNameHint: CATALOG_SOURCE_NAME_HINT_SCHEMA.optional(),
    views: z
      .array(
        CATALOG_SELECTED_RGB_VIEW_SCHEMA.extend({
          rgbRelativePath: RELATIVE_EVIDENCE_PATH_SCHEMA,
          rgbSizeBytes: EVIDENCE_SIZE_SCHEMA,
        }).strict(),
      )
      .min(4)
      .max(12),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.request.evidenceMode === "visual_only" && value.sourceNameHint)
      context.addIssue({
        code: "custom",
        path: ["sourceNameHint"],
        message: "Visual-only metadata jobs cannot expose source names",
      });
    if (
      value.request.evidenceMode === "visual_and_name" &&
      (!value.sourceNameHint ||
        value.sourceNameHint.hash !== value.request.sourceNameHintHash ||
        value.sourceNameHint.sourceContentHash !== value.request.sourceContentHash)
    )
      context.addIssue({
        code: "custom",
        path: ["sourceNameHint"],
        message: "Visual-and-name metadata jobs require the exact sealed basename hint",
      });
    if (value.views.length !== value.request.selectedRgbViews.length)
      context.addIssue({
        code: "custom",
        path: ["views"],
        message: "Metadata worker views do not match the request view set",
      });
  });

export const CATALOG_METADATA_WORKER_JOB_SCHEMA = z
  .object({
    kind: z.literal("CatalogMetadataWorkerJob"),
    requestSetHash: HASH_SCHEMA,
    promptTemplate: PROMPT_TEMPLATE_SCHEMA,
    promptTemplateHash: HASH_SCHEMA,
    outputSchema: JSON_SCHEMA_VALUE,
    outputSchemaHash: HASH_SCHEMA,
    workerImplementationHash: HASH_SCHEMA,
    model: CATALOG_MODEL_DECLARATION_SCHEMA,
    items: z.array(METADATA_WORKER_ITEM_SCHEMA).min(1),
    inputBudget: CATALOG_WORKER_INPUT_BUDGET_SCHEMA,
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyArtifactHash(value, context);
    if (contentHash(value.promptTemplate) !== value.promptTemplateHash)
      context.addIssue({
        code: "custom",
        path: ["promptTemplateHash"],
        message: "Metadata worker prompt hash does not match its exact template",
      });
    requireCanonicalValues(
      value.items,
      (entry) => entry.request.hash,
      "metadata worker items",
      context,
    );
    validateInputBudget(value.items, value.inputBudget, context);
  });
export type CatalogMetadataWorkerJob = z.output<typeof CATALOG_METADATA_WORKER_JOB_SCHEMA>;

const CONTEXT_WORKER_CANDIDATE_EVIDENCE_SCHEMA = z
  .object({
    sourceContentHash: HASH_SCHEMA,
    sourceNameHint: CATALOG_SOURCE_NAME_HINT_SCHEMA.optional(),
    contactSheetRelativePath: RELATIVE_EVIDENCE_PATH_SCHEMA,
    contactSheetContentHash: HASH_SCHEMA,
    contactSheetSizeBytes: EVIDENCE_SIZE_SCHEMA,
  })
  .strict();

export const CATALOG_CONTEXT_WORKER_JOB_SCHEMA = z
  .object({
    kind: z.literal("CatalogContextWorkerJob"),
    promptTemplate: PROMPT_TEMPLATE_SCHEMA,
    promptTemplateHash: HASH_SCHEMA,
    outputSchema: JSON_SCHEMA_VALUE,
    outputSchemaHash: HASH_SCHEMA,
    workerImplementationHash: HASH_SCHEMA,
    model: CATALOG_MODEL_DECLARATION_SCHEMA,
    request: ASSET_CONTEXT_HYPOTHESIS_REQUEST_SCHEMA,
    candidateEvidence: z.array(CONTEXT_WORKER_CANDIDATE_EVIDENCE_SCHEMA).min(2),
    inputBudget: CATALOG_CONTEXT_WORKER_INPUT_BUDGET_SCHEMA,
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyArtifactHash(value, context);
    if (contentHash(value.promptTemplate) !== value.promptTemplateHash)
      context.addIssue({
        code: "custom",
        path: ["promptTemplateHash"],
        message: "Context worker prompt hash does not match its exact template",
      });
    requireCanonicalValues(
      value.candidateEvidence,
      (entry) => entry.sourceContentHash,
      "context worker candidate evidence",
      context,
    );
    if (value.promptTemplateHash !== value.request.promptTemplateHash)
      context.addIssue({
        code: "custom",
        path: ["promptTemplateHash"],
        message: "Context worker prompt differs from its request",
      });
    if (
      value.outputSchemaHash !== ASSET_CONTEXT_HYPOTHESIS_JSON_SCHEMA_HASH ||
      value.outputSchemaHash !== value.request.outputSchemaHash
    )
      context.addIssue({
        code: "custom",
        path: ["outputSchemaHash"],
        message: "Context worker output schema differs from the canonical request schema",
      });
    const expectedCandidates = value.request.candidates.map((entry) => ({
      sourceContentHash: entry.sourceContentHash,
      contactSheetContentHash: entry.contactSheetContentHash,
    }));
    const actualCandidates = value.candidateEvidence.map((entry) => ({
      sourceContentHash: entry.sourceContentHash,
      contactSheetContentHash: entry.contactSheetContentHash,
    }));
    if (stableJson(expectedCandidates) !== stableJson(actualCandidates))
      context.addIssue({
        code: "custom",
        path: ["candidateEvidence"],
        message: "Context worker evidence differs from the bounded request group",
      });
    for (const [index, candidate] of value.request.candidates.entries()) {
      const hint = value.candidateEvidence[index]?.sourceNameHint;
      if (
        (candidate.sourceNameHintHash === undefined) !== (hint === undefined) ||
        (hint &&
          (hint.hash !== candidate.sourceNameHintHash ||
            hint.sourceContentHash !== candidate.sourceContentHash))
      )
        context.addIssue({
          code: "custom",
          path: ["candidateEvidence", index, "sourceNameHint"],
          message: "Context worker candidate does not bind its exact basename hint",
        });
    }
    const expectedBudget = {
      candidateCount: value.candidateEvidence.length,
      evidenceFileCount: value.candidateEvidence.length,
      evidenceBytes: value.candidateEvidence.reduce(
        (sum, entry) => sum + entry.contactSheetSizeBytes,
        0,
      ),
      preprocessedPixelCeiling:
        value.candidateEvidence.length *
        CATALOG_WORKER_IMAGE_LONG_EDGE_PIXELS *
        CATALOG_WORKER_IMAGE_LONG_EDGE_PIXELS,
    };
    if (stableJson(value.inputBudget) !== stableJson(expectedBudget))
      context.addIssue({
        code: "custom",
        path: ["inputBudget"],
        message: "Context worker input budget differs from its sealed evidence",
      });
  });
export type CatalogContextWorkerJob = z.output<typeof CATALOG_CONTEXT_WORKER_JOB_SCHEMA>;

const WORKER_RUNTIME_SCHEMA = z
  .object({
    adapterImplementationHash: HASH_SCHEMA,
    workerImplementationHash: HASH_SCHEMA,
    runtimeImplementationHash: HASH_SCHEMA,
    modelImplementationHash: HASH_SCHEMA,
    modelId: z.string().trim().min(1).max(256),
    modelCommitHash: z.string().regex(/^[a-f0-9]{40,64}$/u),
  })
  .strict();

const WORKER_USAGE_SCHEMA = z
  .object({
    inputImageCount: z.number().int().nonnegative().safe(),
    inputPixels: z.number().int().nonnegative().safe(),
    inputTokens: z.number().int().nonnegative().safe(),
    outputTokens: z.number().int().nonnegative().safe(),
    elapsedMilliseconds: z.number().int().nonnegative().safe(),
    peakResidentBytes: z.number().int().nonnegative().safe(),
    gpuMilliseconds: z.number().int().nonnegative().safe(),
  })
  .strict();

const CONTEXT_WORKER_USAGE_SCHEMA = WORKER_USAGE_SCHEMA.extend({
  inputImageCount: z.number().int().nonnegative().safe(),
}).strict();

export const CATALOG_METADATA_WORKER_OUTPUT_SCHEMA = z
  .object({
    kind: z.literal("CatalogMetadataWorkerOutput"),
    jobHash: HASH_SCHEMA,
    runtime: WORKER_RUNTIME_SCHEMA,
    items: z
      .array(
        z
          .object({
            requestHash: HASH_SCHEMA,
            status: z.enum(["eligible", "incomplete"]),
            promptHash: HASH_SCHEMA,
            rawOutputHash: HASH_SCHEMA.optional(),
            metadata: CATALOG_SEARCH_METADATA_SCHEMA.optional(),
            diagnostics: z.array(z.string().trim().min(1).max(2_048)),
            resourceUsage: WORKER_USAGE_SCHEMA,
          })
          .strict(),
      )
      .min(1),
    resultHash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    requireCanonicalValues(
      value.items,
      (entry) => entry.requestHash,
      "metadata worker outputs",
      context,
    );
  });

export const CATALOG_CONTEXT_WORKER_OUTPUT_SCHEMA = z
  .object({
    kind: z.literal("CatalogContextWorkerOutput"),
    jobHash: HASH_SCHEMA,
    runtime: WORKER_RUNTIME_SCHEMA,
    requestHash: HASH_SCHEMA,
    status: z.enum(["eligible", "incomplete"]),
    promptHash: HASH_SCHEMA,
    rawOutputHash: HASH_SCHEMA.optional(),
    hypothesis: ASSET_CONTEXT_HYPOTHESIS_OUTPUT_SCHEMA.optional(),
    diagnostics: z.array(z.string().trim().min(1).max(2_048)),
    resourceUsage: CONTEXT_WORKER_USAGE_SCHEMA,
    resultHash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    const eligible = value.status === "eligible";
    if (eligible !== (value.hypothesis !== undefined && value.diagnostics.length === 0))
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "Context worker status does not match its output evidence",
      });
  });

const EMBEDDING_VIEW_SCHEMA = z
  .object({
    viewId: z.string().regex(/^(?:low|high)_[0-9]{2}$/u),
    rgbRelativePath: RELATIVE_EVIDENCE_PATH_SCHEMA.optional(),
    rgbHash: HASH_SCHEMA.optional(),
    rgbSizeBytes: EVIDENCE_SIZE_SCHEMA.optional(),
    normalizedDepthRelativePath: RELATIVE_EVIDENCE_PATH_SCHEMA.optional(),
    normalizedDepthHash: HASH_SCHEMA.optional(),
    normalizedDepthSizeBytes: EVIDENCE_SIZE_SCHEMA.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const rgbFields = [value.rgbRelativePath, value.rgbHash, value.rgbSizeBytes];
    const depthFields = [
      value.normalizedDepthRelativePath,
      value.normalizedDepthHash,
      value.normalizedDepthSizeBytes,
    ];
    if (!allOrNone(rgbFields))
      context.addIssue({
        code: "custom",
        path: ["rgbRelativePath"],
        message: "Embedding RGB evidence must include path, hash, and byte size together",
      });
    if (!allOrNone(depthFields))
      context.addIssue({
        code: "custom",
        path: ["normalizedDepthRelativePath"],
        message: "Embedding depth evidence must include path, hash, and byte size together",
      });
  });

export const CATALOG_EMBEDDING_WORKER_JOB_SCHEMA = z
  .object({
    kind: z.literal("CatalogEmbeddingWorkerJob"),
    sourceManifestHash: HASH_SCHEMA,
    visualReviewIndexHash: HASH_SCHEMA,
    workerImplementationHash: HASH_SCHEMA,
    purposes: z.array(CATALOG_EMBEDDING_PURPOSE_SCHEMA).min(1).max(2),
    models: z.array(CATALOG_MODEL_DECLARATION_SCHEMA).min(1).max(2),
    items: z
      .array(
        z
          .object({
            sourceContentHash: HASH_SCHEMA,
            renderEvidenceHash: HASH_SCHEMA,
            views: z.array(EMBEDDING_VIEW_SCHEMA).length(12),
          })
          .strict(),
      )
      .min(1),
    inputBudget: CATALOG_WORKER_INPUT_BUDGET_SCHEMA,
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyArtifactHash(value, context);
    requireCanonicalValues(value.purposes, String, "embedding purposes", context);
    requireCanonicalValues(
      value.models,
      (entry) => entry.modelId,
      "embedding worker models",
      context,
    );
    requireCanonicalValues(
      value.items,
      (entry) => entry.sourceContentHash,
      "embedding worker items",
      context,
    );
    const purposesByModel = value.models.map(modelEmbeddingPurposes);
    const modelPurposes = purposesByModel.flat();
    if (
      purposesByModel.some((purposes) => purposes.length !== 1) ||
      value.models.length !== value.purposes.length ||
      stableJson([...modelPurposes].sort()) !== stableJson(value.purposes)
    )
      context.addIssue({
        code: "custom",
        path: ["models"],
        message: "Embedding jobs require exactly one model for every requested purpose",
      });
    for (const [itemIndex, item] of value.items.entries())
      for (const [viewIndex, view] of item.views.entries()) {
        const hasRgb = view.rgbRelativePath !== undefined;
        const hasDepth = view.normalizedDepthRelativePath !== undefined;
        if (hasRgb !== value.purposes.includes("image_text_retrieval"))
          context.addIssue({
            code: "custom",
            path: ["items", itemIndex, "views", viewIndex, "rgbRelativePath"],
            message: "RGB evidence must be present exactly when image-text retrieval is requested",
          });
        if (hasDepth !== value.purposes.includes("shape_similarity"))
          context.addIssue({
            code: "custom",
            path: ["items", itemIndex, "views", viewIndex, "normalizedDepthRelativePath"],
            message: "Depth evidence must be present exactly when shape similarity is requested",
          });
      }
    validateInputBudget(value.items, value.inputBudget, context);
  });

export const CATALOG_EMBEDDING_WORKER_OUTPUT_SCHEMA = z
  .object({
    kind: z.literal("CatalogEmbeddingWorkerOutput"),
    jobHash: HASH_SCHEMA,
    receipts: z
      .array(
        z
          .object({
            sourceContentHash: HASH_SCHEMA,
            renderEvidenceHash: HASH_SCHEMA,
            purpose: z.enum(["image_text_retrieval", "shape_similarity"]),
            modelId: z.string().trim().min(1).max(256),
            modelCommitHash: z.string().regex(/^[a-f0-9]{40,64}$/u),
            modelImplementationHash: HASH_SCHEMA,
            preprocessingImplementationHash: HASH_SCHEMA,
            aggregationImplementationHash: HASH_SCHEMA,
            perViewEvidenceHash: HASH_SCHEMA,
            aggregate: CATALOG_QUANTIZED_VECTOR_SCHEMA,
            maximumViewDisagreementMillionths: z.number().int().min(0).max(2_000_000),
            gpuMilliseconds: z.number().int().nonnegative().max(86_400_000),
          })
          .strict(),
      )
      .min(1),
    resultHash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    requireCanonicalValues(
      value.receipts,
      (entry) => `${entry.sourceContentHash}:${entry.purpose}`,
      "embedding worker outputs",
      context,
    );
  });

export const CATALOG_QUERY_EMBEDDING_WORKER_JOB_SCHEMA = z
  .object({
    kind: z.literal("CatalogQueryEmbeddingWorkerJob"),
    workerImplementationHash: HASH_SCHEMA,
    model: CATALOG_MODEL_DECLARATION_SCHEMA,
    queries: z
      .array(
        z.object({ queryHash: HASH_SCHEMA, text: z.string().trim().min(1).max(2_048) }).strict(),
      )
      .min(1),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyArtifactHash(value, context);
    requireCanonicalValues(
      value.queries,
      (entry) => entry.queryHash,
      "query embedding items",
      context,
    );
  });

export const CATALOG_QUERY_EMBEDDING_WORKER_OUTPUT_SCHEMA = z
  .object({
    kind: z.literal("CatalogQueryEmbeddingWorkerOutput"),
    jobHash: HASH_SCHEMA,
    modelImplementationHash: HASH_SCHEMA,
    preprocessingImplementationHash: HASH_SCHEMA,
    gpuMilliseconds: z.number().int().nonnegative().max(86_400_000),
    items: z
      .array(z.object({ queryHash: HASH_SCHEMA, vector: CATALOG_QUANTIZED_VECTOR_SCHEMA }).strict())
      .min(1),
    resultHash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    requireCanonicalValues(
      value.items,
      (entry) => entry.queryHash,
      "query embedding outputs",
      context,
    );
  });

export const CATALOG_VALIDATION_WORKER_JOB_SCHEMA = z
  .object({
    kind: z.literal("CatalogValidationWorkerJob"),
    promptTemplate: PROMPT_TEMPLATE_SCHEMA,
    promptTemplateHash: HASH_SCHEMA,
    outputSchema: JSON_SCHEMA_VALUE,
    outputSchemaHash: HASH_SCHEMA,
    workerImplementationHash: HASH_SCHEMA,
    model: CATALOG_MODEL_DECLARATION_SCHEMA,
    items: z
      .array(
        z
          .object({
            request: CATALOG_VALIDATION_REQUEST_SCHEMA,
            metadataReceipt: ASSET_SEARCH_METADATA_RECEIPT_SCHEMA.optional(),
            measurement: CATALOG_ASSET_ARTIFACT_SCHEMA,
            views: z
              .array(
                CATALOG_SELECTED_RGB_VIEW_SCHEMA.extend({
                  rgbRelativePath: RELATIVE_EVIDENCE_PATH_SCHEMA,
                  rgbSizeBytes: EVIDENCE_SIZE_SCHEMA,
                }).strict(),
              )
              .length(12),
          })
          .strict()
          .superRefine((value, context) => {
            if (
              value.measurement.source.contentHash !== value.request.candidate.sourceContentHash ||
              value.measurement.hash !== value.request.candidate.measurementHash ||
              (value.metadataReceipt !== undefined &&
                (value.metadataReceipt.sourceContentHash !==
                  value.request.candidate.sourceContentHash ||
                  value.metadataReceipt.hash !== value.request.candidate.metadataReceiptHash)) ||
              (value.metadataReceipt === undefined &&
                value.request.candidate.metadataReceiptHash !== undefined)
            )
              context.addIssue({
                code: "custom",
                path: ["measurement"],
                message: "Validation worker measurement binds another candidate",
              });
          }),
      )
      .min(1),
    inputBudget: CATALOG_WORKER_INPUT_BUDGET_SCHEMA,
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyArtifactHash(value, context);
    if (contentHash(value.promptTemplate) !== value.promptTemplateHash)
      context.addIssue({
        code: "custom",
        path: ["promptTemplateHash"],
        message: "Validation worker prompt hash does not match its exact template",
      });
    requireCanonicalValues(
      value.items,
      (entry) => entry.request.hash,
      "validation worker items",
      context,
    );
    validateInputBudget(value.items, value.inputBudget, context);
  });

export const CATALOG_VALIDATION_WORKER_OUTPUT_SCHEMA = z
  .object({
    kind: z.literal("CatalogValidationWorkerOutput"),
    jobHash: HASH_SCHEMA,
    runtime: WORKER_RUNTIME_SCHEMA,
    items: z
      .array(
        z
          .object({
            requestHash: HASH_SCHEMA,
            status: z.enum(["eligible", "incomplete"]),
            promptHash: HASH_SCHEMA,
            rawOutputHash: HASH_SCHEMA.optional(),
            validation: CATALOG_VISUAL_VALIDATION_SCHEMA.optional(),
            diagnostics: z.array(z.string().trim().min(1).max(2_048)),
            resourceUsage: WORKER_USAGE_SCHEMA,
          })
          .strict(),
      )
      .min(1),
    resultHash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    requireCanonicalValues(
      value.items,
      (entry) => entry.requestHash,
      "validation worker outputs",
      context,
    );
  });

export type CatalogWorkerJob =
  | z.output<typeof CATALOG_METADATA_WORKER_JOB_SCHEMA>
  | z.output<typeof CATALOG_CONTEXT_WORKER_JOB_SCHEMA>
  | z.output<typeof CATALOG_EMBEDDING_WORKER_JOB_SCHEMA>
  | z.output<typeof CATALOG_QUERY_EMBEDDING_WORKER_JOB_SCHEMA>
  | z.output<typeof CATALOG_VALIDATION_WORKER_JOB_SCHEMA>;

export type CatalogWorkerOutput =
  | z.output<typeof CATALOG_METADATA_WORKER_OUTPUT_SCHEMA>
  | z.output<typeof CATALOG_CONTEXT_WORKER_OUTPUT_SCHEMA>
  | z.output<typeof CATALOG_EMBEDDING_WORKER_OUTPUT_SCHEMA>
  | z.output<typeof CATALOG_QUERY_EMBEDDING_WORKER_OUTPUT_SCHEMA>
  | z.output<typeof CATALOG_VALIDATION_WORKER_OUTPUT_SCHEMA>;

/** A partial checkpoint is evidence; exact output coverage makes it reusable. */
export function catalogWorkerOutputIsComplete(
  job: CatalogWorkerJob,
  output: CatalogWorkerOutput,
): boolean {
  if (job.kind === "CatalogContextWorkerJob") {
    return output.kind === "CatalogContextWorkerOutput" && output.requestHash === job.request.hash;
  }
  if (job.kind === "CatalogMetadataWorkerJob") {
    if (output.kind !== "CatalogMetadataWorkerOutput") return false;
    return sameIdentities(
      job.items.map((entry) => entry.request.hash),
      output.items.map((entry) => entry.requestHash),
    );
  }
  if (job.kind === "CatalogValidationWorkerJob") {
    if (output.kind !== "CatalogValidationWorkerOutput") return false;
    return sameIdentities(
      job.items.map((entry) => entry.request.hash),
      output.items.map((entry) => entry.requestHash),
    );
  }
  if (job.kind === "CatalogEmbeddingWorkerJob") {
    if (output.kind !== "CatalogEmbeddingWorkerOutput") return false;
    return sameIdentities(
      job.items.flatMap((item) =>
        job.purposes.map((purpose) => `${item.sourceContentHash}:${purpose}`),
      ),
      output.receipts.map((entry) => `${entry.sourceContentHash}:${entry.purpose}`),
    );
  }
  if (output.kind !== "CatalogQueryEmbeddingWorkerOutput") return false;
  return sameIdentities(
    job.queries.map((entry) => entry.queryHash),
    output.items.map((entry) => entry.queryHash),
  );
}

/** Verify the raw JSON envelope before Zod applies string normalization. */
export function catalogWorkerResultHashMatches(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.resultHash !== "string") return false;
  const { resultHash, ...material } = record;
  return contentHash(stableJson(material)) === resultHash;
}

function sameIdentities(expected: readonly string[], actual: readonly string[]): boolean {
  return stableJson([...expected].sort()) === stableJson([...actual].sort());
}

function validateInputBudget(
  items: readonly {
    readonly views: readonly {
      readonly rgbSizeBytes?: number | undefined;
      readonly normalizedDepthSizeBytes?: number | undefined;
    }[];
  }[],
  budget: z.output<typeof CATALOG_WORKER_INPUT_BUDGET_SCHEMA>,
  context: z.RefinementCtx,
): void {
  const evidenceFileCount = items.reduce(
    (count, item) =>
      count +
      item.views.reduce(
        (viewCount, view) =>
          viewCount +
          (view.rgbSizeBytes === undefined ? 0 : 1) +
          (view.normalizedDepthSizeBytes === undefined ? 0 : 1),
        0,
      ),
    0,
  );
  const evidenceBytes = items.reduce(
    (total, item) =>
      total +
      item.views.reduce(
        (viewTotal, view) =>
          viewTotal + (view.rgbSizeBytes ?? 0) + (view.normalizedDepthSizeBytes ?? 0),
        0,
      ),
    0,
  );
  const preprocessedPixelCeiling =
    evidenceFileCount *
    CATALOG_WORKER_IMAGE_LONG_EDGE_PIXELS *
    CATALOG_WORKER_IMAGE_LONG_EDGE_PIXELS;
  const expected = {
    assetCount: items.length,
    evidenceFileCount,
    evidenceBytes,
    preprocessedPixelCeiling,
  };
  for (const [field, value] of Object.entries(expected))
    if (budget[field as keyof typeof expected] !== value)
      context.addIssue({
        code: "custom",
        path: ["inputBudget", field],
        message: `Worker input budget ${field} does not match the sealed evidence`,
      });
}

function modelEmbeddingPurposes(
  model: z.output<typeof CATALOG_MODEL_DECLARATION_SCHEMA>,
): Array<"image_text_retrieval" | "shape_similarity"> {
  return model.capabilities.filter(
    (capability): capability is "image_text_retrieval" | "shape_similarity" =>
      capability === "image_text_retrieval" || capability === "shape_similarity",
  );
}

function allOrNone(values: readonly unknown[]): boolean {
  const present = values.filter((value) => value !== undefined).length;
  return present === 0 || present === values.length;
}
