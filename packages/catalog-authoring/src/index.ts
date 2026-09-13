import { z } from "zod";
import {
  COMPILATION_STATUS_SCHEMA,
  HASH_SCHEMA,
  compareCanonicalStrings,
  contentHash,
  deepFreezeJson,
  stableJson,
} from "@basalt/contracts";
import {
  CONCEPT_ID_SCHEMA,
  SEMANTIC_HYPOTHESIS_ASSERTION_BUNDLE_SCHEMA,
} from "@basalt/semantic-kernel";

const canonical = <T>(values: readonly T[], key: (value: T) => string): T[] => {
  const result = [...values].sort((left, right) => compareCanonicalStrings(key(left), key(right)));
  if (new Set(result.map(key)).size !== result.length)
    throw new Error("Review values must be unique");
  return result;
};

const REVIEW_HINTS_SCHEMA = z
  .object({
    relativePath: z.string().trim().min(1).max(4096).optional(),
    filenameStem: z.string().trim().min(1).max(256).optional(),
    vendorDirectory: z.string().trim().min(1).max(4096).optional(),
    authority: z.literal("review_hint_only"),
  })
  .strict();

const AUTHORING_STATUS_FIELDS = {
  status: COMPILATION_STATUS_SCHEMA,
  diagnostics: z.array(z.string().trim().min(1).max(1024)).max(100_000),
};

export const CATALOG_REVIEW_VIEWPOINTS = Object.freeze(
  [
    ...Array.from({ length: 8 }, (_, index) => ({
      viewId: `low_${String(index).padStart(2, "0")}`,
      azimuthDegrees: index * 45,
      elevationDegrees: 25,
    })),
    ...Array.from({ length: 4 }, (_, index) => ({
      viewId: `high_${String(index).padStart(2, "0")}`,
      azimuthDegrees: 22.5 + index * 90,
      elevationDegrees: 55,
    })),
  ].sort((left, right) => compareCanonicalStrings(left.viewId, right.viewId)),
);

const CATALOG_RENDER_VIEW_SCHEMA = z
  .object({
    viewId: z.string().regex(/^(?:low|high)_[0-9]{2}$/u),
    azimuthDegrees: z.number().finite().min(0).lt(360),
    elevationDegrees: z.number().finite().gt(0).lt(90),
    rgbHash: HASH_SCHEMA,
    silhouetteHash: HASH_SCHEMA,
    normalizedDepthHash: HASH_SCHEMA,
  })
  .strict();

export const CATALOG_RENDER_EVIDENCE_SCHEMA = z
  .object({
    kind: z.literal("CatalogRenderEvidence"),
    sourceContentHash: HASH_SCHEMA,
    rendererImplementationHash: HASH_SCHEMA,
    cameraRigHash: HASH_SCHEMA,
    lightingHash: HASH_SCHEMA,
    materialModeHash: HASH_SCHEMA,
    views: z.array(CATALOG_RENDER_VIEW_SCHEMA).length(12),
    contactSheetHash: HASH_SCHEMA,
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyHash(value, context);
    const expected = stableJson(CATALOG_REVIEW_VIEWPOINTS);
    const actual = stableJson(
      value.views.map(({ viewId, azimuthDegrees, elevationDegrees }) => ({
        viewId,
        azimuthDegrees,
        elevationDegrees,
      })),
    );
    if (actual !== expected)
      context.addIssue({
        code: "custom",
        path: ["views"],
        message: "Render evidence requires the canonical 12-view camera rig",
      });
  });
export type CatalogRenderEvidence = z.output<typeof CATALOG_RENDER_EVIDENCE_SCHEMA>;

const CATALOG_VISUAL_REVIEW_ITEM_SCHEMA = z
  .object({
    sourceContentHash: HASH_SCHEMA,
    packageId: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,127}$/u),
    reviewHints: REVIEW_HINTS_SCHEMA,
    contactSheetRelativePath: z.string().trim().min(1).max(4096),
    viewArtifacts: z
      .array(
        z
          .object({
            viewId: z.string().regex(/^(?:low|high)_[0-9]{2}$/u),
            rgbRelativePath: z.string().trim().min(1).max(4096),
            silhouetteRelativePath: z.string().trim().min(1).max(4096),
            normalizedDepthRelativePath: z.string().trim().min(1).max(4096),
          })
          .strict(),
      )
      .length(12),
    evidence: CATALOG_RENDER_EVIDENCE_SCHEMA,
  })
  .strict();

export const CATALOG_VISUAL_REVIEW_INDEX_SCHEMA = z
  .object({
    kind: z.literal("CatalogVisualReviewIndex"),
    status: COMPILATION_STATUS_SCHEMA,
    sourceManifestHash: HASH_SCHEMA,
    rendererImplementationHash: HASH_SCHEMA,
    cameraRigHash: HASH_SCHEMA,
    lightingHash: HASH_SCHEMA,
    materialModeHash: HASH_SCHEMA,
    items: z.array(CATALOG_VISUAL_REVIEW_ITEM_SCHEMA).max(100_000),
    diagnostics: z.array(z.string().trim().min(1).max(1024)).max(100_000),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyHash(value, context);
    const expectedStatus = value.diagnostics.length === 0 ? "eligible" : "incomplete";
    if (value.status !== expectedStatus)
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "Visual review status does not match its diagnostics",
      });
    canonicalIssue(value.items, (item) => item.sourceContentHash, "visual-review items", context);
    for (const [index, item] of value.items.entries()) {
      if (item.evidence.sourceContentHash !== item.sourceContentHash)
        context.addIssue({
          code: "custom",
          path: ["items", index, "evidence"],
          message: "Render evidence binds another source",
        });
      if (
        item.evidence.rendererImplementationHash !== value.rendererImplementationHash ||
        item.evidence.cameraRigHash !== value.cameraRigHash ||
        item.evidence.lightingHash !== value.lightingHash ||
        item.evidence.materialModeHash !== value.materialModeHash
      )
        context.addIssue({
          code: "custom",
          path: ["items", index, "evidence"],
          message: "Render evidence does not match index policy",
        });
    }
  });
export type CatalogVisualReviewIndex = z.output<typeof CATALOG_VISUAL_REVIEW_INDEX_SCHEMA>;

export const ASSET_SEMANTIC_HYPOTHESIS_REQUEST_SCHEMA = z
  .object({
    kind: z.literal("AssetSemanticHypothesisRequest"),
    sourceContentHash: HASH_SCHEMA,
    measurementHash: HASH_SCHEMA,
    renderEvidenceHash: HASH_SCHEMA,
    semanticModuleHash: HASH_SCHEMA,
    semanticLexiconHash: HASH_SCHEMA,
    requestedConceptIds: z.array(CONCEPT_ID_SCHEMA).max(512),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => verifyHash(value, context));
export type AssetSemanticHypothesisRequest = z.output<
  typeof ASSET_SEMANTIC_HYPOTHESIS_REQUEST_SCHEMA
>;

export const ASSET_SEMANTIC_HYPOTHESIS_RECEIPT_SCHEMA = z
  .object({
    kind: z.literal("AssetSemanticHypothesisReceipt"),
    requestHash: HASH_SCHEMA,
    sourceContentHash: HASH_SCHEMA,
    measurementHash: HASH_SCHEMA,
    renderEvidenceHash: HASH_SCHEMA,
    semanticModuleHash: HASH_SCHEMA,
    semanticLexiconHash: HASH_SCHEMA,
    adapterHash: HASH_SCHEMA,
    modelImplementationHash: HASH_SCHEMA,
    assertions: SEMANTIC_HYPOTHESIS_ASSERTION_BUNDLE_SCHEMA,
    diagnostics: z.array(z.string().trim().min(1).max(1024)).max(4096),
    resourceUse: z
      .object({
        inputTokens: z.number().int().nonnegative(),
        outputTokens: z.number().int().nonnegative(),
        computeMilliseconds: z.number().int().nonnegative(),
      })
      .strict(),
    compilerAuthority: z.literal(false),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyHash(value, context);
    if (value.assertions.hypothesisSourceHash !== value.requestHash)
      context.addIssue({
        code: "custom",
        path: ["assertions", "hypothesisSourceHash"],
        message: "Hypothesis assertions must bind the exact request",
      });
  });
export type AssetSemanticHypothesisReceipt = z.output<
  typeof ASSET_SEMANTIC_HYPOTHESIS_RECEIPT_SCHEMA
>;

export const CATALOG_HYPOTHESIS_REQUEST_SET_SCHEMA = z
  .object({
    kind: z.literal("CatalogHypothesisRequestSet"),
    ...AUTHORING_STATUS_FIELDS,
    measurementSetHash: HASH_SCHEMA,
    visualReviewIndexHash: HASH_SCHEMA,
    semanticModuleHash: HASH_SCHEMA,
    semanticLexiconHash: HASH_SCHEMA,
    requests: z.array(ASSET_SEMANTIC_HYPOTHESIS_REQUEST_SCHEMA).max(100_000),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyHash(value, context);
    canonicalIssue(
      value.requests,
      (request) => request.sourceContentHash,
      "hypothesis requests",
      context,
    );
  });
export type CatalogHypothesisRequestSet = z.output<typeof CATALOG_HYPOTHESIS_REQUEST_SET_SCHEMA>;

export const CATALOG_HYPOTHESIS_RECEIPT_SET_SCHEMA = z
  .object({
    kind: z.literal("CatalogHypothesisReceiptSet"),
    ...AUTHORING_STATUS_FIELDS,
    requestSetHash: HASH_SCHEMA,
    receipts: z.array(ASSET_SEMANTIC_HYPOTHESIS_RECEIPT_SCHEMA).max(100_000),
    missingRequestHashes: z.array(HASH_SCHEMA).max(100_000),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyHash(value, context);
    canonicalIssue(value.receipts, receiptIdentity, "hypothesis receipts", context);
    canonicalIssue(value.missingRequestHashes, String, "missing request hashes", context);
  });
export type CatalogHypothesisReceiptSet = z.output<typeof CATALOG_HYPOTHESIS_RECEIPT_SET_SCHEMA>;

export function sealAssetSemanticHypothesisRequest(
  input: Omit<AssetSemanticHypothesisRequest, "kind" | "hash">,
): AssetSemanticHypothesisRequest {
  const material = {
    kind: "AssetSemanticHypothesisRequest" as const,
    ...input,
    requestedConceptIds: canonical(input.requestedConceptIds, String),
  };
  return seal(ASSET_SEMANTIC_HYPOTHESIS_REQUEST_SCHEMA, material);
}

export function sealCatalogRenderEvidence(
  input: Omit<CatalogRenderEvidence, "kind" | "hash">,
): CatalogRenderEvidence {
  const material = {
    kind: "CatalogRenderEvidence" as const,
    ...input,
    views: canonical(input.views, (view) => view.viewId),
  };
  return seal(CATALOG_RENDER_EVIDENCE_SCHEMA, material);
}

export function sealCatalogVisualReviewIndex(
  input: Omit<CatalogVisualReviewIndex, "kind" | "hash">,
): CatalogVisualReviewIndex {
  return seal(CATALOG_VISUAL_REVIEW_INDEX_SCHEMA, {
    kind: "CatalogVisualReviewIndex" as const,
    ...input,
    items: canonical(input.items, (item) => item.sourceContentHash),
    diagnostics: canonical(input.diagnostics, String),
  });
}

export function sealAssetSemanticHypothesisReceipt(
  input: Omit<AssetSemanticHypothesisReceipt, "kind" | "compilerAuthority" | "hash">,
): AssetSemanticHypothesisReceipt {
  const material = {
    kind: "AssetSemanticHypothesisReceipt" as const,
    ...input,
    diagnostics: canonical(input.diagnostics, String),
    compilerAuthority: false as const,
  };
  return seal(ASSET_SEMANTIC_HYPOTHESIS_RECEIPT_SCHEMA, material);
}

export function sealCatalogHypothesisRequestSet(
  input: Omit<CatalogHypothesisRequestSet, "kind" | "hash">,
): CatalogHypothesisRequestSet {
  return seal(CATALOG_HYPOTHESIS_REQUEST_SET_SCHEMA, {
    kind: "CatalogHypothesisRequestSet" as const,
    ...input,
    requests: canonical(input.requests, (request) => request.sourceContentHash),
    diagnostics: canonical(input.diagnostics, String),
  });
}

export function sealCatalogHypothesisReceiptSet(
  input: Omit<CatalogHypothesisReceiptSet, "kind" | "hash">,
): CatalogHypothesisReceiptSet {
  return seal(CATALOG_HYPOTHESIS_RECEIPT_SET_SCHEMA, {
    kind: "CatalogHypothesisReceiptSet" as const,
    ...input,
    receipts: canonical(input.receipts, receiptIdentity),
    missingRequestHashes: canonical(input.missingRequestHashes, String),
    diagnostics: canonical(input.diagnostics, String),
  });
}

/** One semantic source may be evaluated by several independent transports/models. */
function receiptIdentity(receipt: AssetSemanticHypothesisReceipt): string {
  return `${receipt.requestHash}:${receipt.adapterHash}:${receipt.modelImplementationHash}`;
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

function canonicalIssue<T>(
  values: readonly T[],
  key: (value: T) => string,
  label: string,
  context: z.RefinementCtx,
): void {
  const keys = values.map(key);
  if (
    new Set(keys).size !== keys.length ||
    stableJson([...keys].sort(compareCanonicalStrings)) !== stableJson(keys)
  )
    context.addIssue({ code: "custom", message: `${label} must be unique and canonical` });
}

export * from "./triage.js";
export * from "./admission.js";
export * from "./commit.js";
