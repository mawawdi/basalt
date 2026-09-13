import { z } from "zod";
import { ASCII_ID_SCHEMA, COMPILATION_STATUS_SCHEMA, HASH_SCHEMA } from "@basalt/contracts";
import {
  CONCEPT_ID_SCHEMA,
  SEMANTIC_HYPOTHESIS_ASSERTION_BUNDLE_SCHEMA,
} from "@basalt/semantic-kernel";
import {
  canonicalValues,
  requireCanonicalValues,
  sealArtifact,
  verifyArtifactHash,
} from "./artifact.js";
import { CATALOG_EVIDENCE_CHANNEL_SCHEMA } from "./evidence.js";
import { CATALOG_REVIEW_VIEW_ID_SCHEMA } from "./render.js";
import { CATALOG_PREDICTION_FACET_SCHEMA } from "./facets.js";

export const CATALOG_INFERENCE_ABLATIONS = ["combined", "name_only", "visual_only"] as const;
export const CATALOG_INFERENCE_ABLATION_SCHEMA = z.enum(CATALOG_INFERENCE_ABLATIONS);

const EVIDENCE_SELECTION_SCHEMA = z
  .object({
    channels: z.array(CATALOG_EVIDENCE_CHANNEL_SCHEMA).min(1).max(7),
    viewIds: z.array(CATALOG_REVIEW_VIEW_ID_SCHEMA).max(12),
    includeMeasurements: z.boolean(),
    includeSourceNameHint: z.boolean(),
    selectorImplementationHash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    requireCanonicalValues(value.channels, String, "selected evidence channels", context);
    requireCanonicalValues(value.viewIds, String, "selected evidence views", context);
  });

export const ASSET_SEMANTIC_HYPOTHESIS_REQUEST_SCHEMA = z
  .object({
    kind: z.literal("AssetSemanticHypothesisRequest"),
    sourceContentHash: HASH_SCHEMA,
    measurementHash: HASH_SCHEMA,
    renderEvidenceHash: HASH_SCHEMA,
    sourceNameHintHash: HASH_SCHEMA,
    semanticModuleHash: HASH_SCHEMA,
    semanticLexiconHash: HASH_SCHEMA,
    promptTemplateHash: HASH_SCHEMA,
    evidenceSelection: EVIDENCE_SELECTION_SCHEMA,
    ablation: CATALOG_INFERENCE_ABLATION_SCHEMA,
    requestedAssertionKinds: z.array(CATALOG_PREDICTION_FACET_SCHEMA).min(1).max(5),
    requestedConceptIds: z.array(CONCEPT_ID_SCHEMA).max(512),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyArtifactHash(value, context);
    requireCanonicalValues(
      value.requestedAssertionKinds,
      String,
      "requested assertion kinds",
      context,
    );
    requireCanonicalValues(value.requestedConceptIds, String, "requested concepts", context);
    if (value.ablation === "visual_only" && value.evidenceSelection.includeSourceNameHint)
      context.addIssue({
        code: "custom",
        path: ["evidenceSelection", "includeSourceNameHint"],
        message: "Visual-only requests cannot expose the source-name hint",
      });
    if (value.ablation === "name_only" && value.evidenceSelection.viewIds.length > 0)
      context.addIssue({
        code: "custom",
        path: ["evidenceSelection", "viewIds"],
        message: "Name-only requests cannot expose rendered views",
      });
  });
export type AssetSemanticHypothesisRequest = z.output<
  typeof ASSET_SEMANTIC_HYPOTHESIS_REQUEST_SCHEMA
>;

const INFERENCE_CONFIGURATION_SCHEMA = z
  .object({
    seed: z.number().int().nonnegative().max(0x7fff_ffff),
    scoreNormalization: z.enum([
      "softmax_per_facet",
      "lexical_similarity",
      "calibrated_probability",
    ]),
    maximumCandidatesPerFacet: z.number().int().positive().max(64),
  })
  .strict();

const FACET_SCORE_SCHEMA = z
  .object({
    assertionKind: CATALOG_PREDICTION_FACET_SCHEMA,
    valueKey: z.string().trim().min(1).max(256),
    scoreMillionths: z.number().int().min(0).max(1_000_000),
  })
  .strict();

export const ASSET_SEMANTIC_HYPOTHESIS_RECEIPT_SCHEMA = z
  .object({
    kind: z.literal("AssetSemanticHypothesisReceipt"),
    requestHash: HASH_SCHEMA,
    sourceContentHash: HASH_SCHEMA,
    measurementHash: HASH_SCHEMA,
    renderEvidenceHash: HASH_SCHEMA,
    sourceNameHintHash: HASH_SCHEMA,
    semanticModuleHash: HASH_SCHEMA,
    semanticLexiconHash: HASH_SCHEMA,
    ablation: CATALOG_INFERENCE_ABLATION_SCHEMA,
    adapterId: ASCII_ID_SCHEMA,
    adapterImplementationHash: HASH_SCHEMA,
    modelImplementationHash: HASH_SCHEMA,
    dependencyGroupId: ASCII_ID_SCHEMA,
    promptHash: HASH_SCHEMA,
    rawOutputHash: HASH_SCHEMA,
    normalizationImplementationHash: HASH_SCHEMA,
    inference: INFERENCE_CONFIGURATION_SCHEMA,
    assertions: SEMANTIC_HYPOTHESIS_ASSERTION_BUNDLE_SCHEMA,
    facetScores: z.array(FACET_SCORE_SCHEMA).max(4096),
    noveltyScoreMillionths: z.number().int().min(0).max(1_000_000),
    diagnostics: z.array(z.string().trim().min(1).max(1024)).max(4096),
    workload: z
      .object({
        inputArtifactCount: z.number().int().nonnegative(),
        renderedViewCount: z.number().int().nonnegative().max(12),
        candidateValueCount: z.number().int().nonnegative().max(100_000),
      })
      .strict(),
    compilerAuthority: z.literal(false),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyArtifactHash(value, context);
    requireCanonicalValues(
      value.facetScores,
      (entry) => `${entry.assertionKind}:${entry.valueKey}`,
      "facet scores",
      context,
    );
    requireCanonicalValues(value.diagnostics, String, "hypothesis diagnostics", context);
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

const AUTHORING_STATUS_FIELDS = {
  status: COMPILATION_STATUS_SCHEMA,
  diagnostics: z.array(z.string().trim().min(1).max(1024)).max(100_000),
};

export const CATALOG_HYPOTHESIS_REQUEST_SET_SCHEMA = z
  .object({
    kind: z.literal("CatalogHypothesisRequestSet"),
    ...AUTHORING_STATUS_FIELDS,
    measurementSetHash: HASH_SCHEMA,
    visualReviewIndexHash: HASH_SCHEMA,
    sourceNameHintSetHash: HASH_SCHEMA,
    semanticModuleHash: HASH_SCHEMA,
    semanticLexiconHash: HASH_SCHEMA,
    promptTemplateHash: HASH_SCHEMA,
    requests: z.array(ASSET_SEMANTIC_HYPOTHESIS_REQUEST_SCHEMA).max(500_000),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyArtifactHash(value, context);
    requireCanonicalValues(value.requests, requestIdentity, "hypothesis requests", context);
    requireCanonicalValues(value.diagnostics, String, "request-set diagnostics", context);
    for (const [index, request] of value.requests.entries())
      if (
        request.semanticModuleHash !== value.semanticModuleHash ||
        request.semanticLexiconHash !== value.semanticLexiconHash ||
        request.promptTemplateHash !== value.promptTemplateHash
      )
        context.addIssue({
          code: "custom",
          path: ["requests", index],
          message: "Hypothesis request does not bind the request set's semantic inputs",
        });
  });
export type CatalogHypothesisRequestSet = z.output<typeof CATALOG_HYPOTHESIS_REQUEST_SET_SCHEMA>;

export const CATALOG_HYPOTHESIS_RECEIPT_SET_SCHEMA = z
  .object({
    kind: z.literal("CatalogHypothesisReceiptSet"),
    ...AUTHORING_STATUS_FIELDS,
    requestSetHash: HASH_SCHEMA,
    receipts: z.array(ASSET_SEMANTIC_HYPOTHESIS_RECEIPT_SCHEMA).max(1_000_000),
    missingRequestHashes: z.array(HASH_SCHEMA).max(500_000),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyArtifactHash(value, context);
    requireCanonicalValues(value.receipts, receiptIdentity, "hypothesis receipts", context);
    requireCanonicalValues(value.missingRequestHashes, String, "missing request hashes", context);
    requireCanonicalValues(value.diagnostics, String, "receipt-set diagnostics", context);
    const expected = value.missingRequestHashes.length === 0 ? "eligible" : "incomplete";
    if (value.status !== expected)
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "Receipt-set status mismatch",
      });
  });
export type CatalogHypothesisReceiptSet = z.output<typeof CATALOG_HYPOTHESIS_RECEIPT_SET_SCHEMA>;

export function sealAssetSemanticHypothesisRequest(
  input: Omit<AssetSemanticHypothesisRequest, "kind" | "hash">,
): AssetSemanticHypothesisRequest {
  return sealArtifact(ASSET_SEMANTIC_HYPOTHESIS_REQUEST_SCHEMA, {
    kind: "AssetSemanticHypothesisRequest" as const,
    ...input,
    evidenceSelection: {
      ...input.evidenceSelection,
      channels: canonicalValues(
        input.evidenceSelection.channels,
        String,
        "selected evidence channels",
      ),
      viewIds: canonicalValues(input.evidenceSelection.viewIds, String, "selected evidence views"),
    },
    requestedAssertionKinds: canonicalValues(
      input.requestedAssertionKinds,
      String,
      "requested assertion kinds",
    ),
    requestedConceptIds: canonicalValues(input.requestedConceptIds, String, "requested concepts"),
  });
}

export function sealAssetSemanticHypothesisReceipt(
  input: Omit<AssetSemanticHypothesisReceipt, "kind" | "compilerAuthority" | "hash">,
): AssetSemanticHypothesisReceipt {
  return sealArtifact(ASSET_SEMANTIC_HYPOTHESIS_RECEIPT_SCHEMA, {
    kind: "AssetSemanticHypothesisReceipt" as const,
    ...input,
    facetScores: canonicalValues(
      input.facetScores,
      (entry) => `${entry.assertionKind}:${entry.valueKey}`,
      "facet scores",
    ),
    diagnostics: canonicalValues(input.diagnostics, String, "hypothesis diagnostics"),
    compilerAuthority: false as const,
  });
}

export function sealCatalogHypothesisRequestSet(
  input: Omit<CatalogHypothesisRequestSet, "kind" | "hash">,
): CatalogHypothesisRequestSet {
  return sealArtifact(CATALOG_HYPOTHESIS_REQUEST_SET_SCHEMA, {
    kind: "CatalogHypothesisRequestSet" as const,
    ...input,
    requests: canonicalValues(input.requests, requestIdentity, "hypothesis requests"),
    diagnostics: canonicalValues(input.diagnostics, String, "request-set diagnostics"),
  });
}

export function sealCatalogHypothesisReceiptSet(
  input: Omit<CatalogHypothesisReceiptSet, "kind" | "hash">,
): CatalogHypothesisReceiptSet {
  return sealArtifact(CATALOG_HYPOTHESIS_RECEIPT_SET_SCHEMA, {
    kind: "CatalogHypothesisReceiptSet" as const,
    ...input,
    receipts: canonicalValues(input.receipts, receiptIdentity, "hypothesis receipts"),
    missingRequestHashes: canonicalValues(
      input.missingRequestHashes,
      String,
      "missing request hashes",
    ),
    diagnostics: canonicalValues(input.diagnostics, String, "receipt-set diagnostics"),
  });
}

function requestIdentity(request: AssetSemanticHypothesisRequest): string {
  return `${request.sourceContentHash}:${request.ablation}`;
}

function receiptIdentity(receipt: AssetSemanticHypothesisReceipt): string {
  return `${receipt.requestHash}:${receipt.adapterImplementationHash}:${receipt.modelImplementationHash}`;
}
