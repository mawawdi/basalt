import { z } from "zod";
import { COMPILATION_STATUS_SCHEMA, HASH_SCHEMA } from "@basalt/contracts";
import {
  canonicalValues,
  requireCanonicalValues,
  sealArtifact,
  verifyArtifactHash,
} from "./artifact.js";
import { CATALOG_REVIEW_VIEW_ID_SCHEMA } from "./render.js";

export const CATALOG_FEATURE_CHANNELS = ["appearance", "semantics", "shape"] as const;
export const CATALOG_FEATURE_CHANNEL_SCHEMA = z.enum(CATALOG_FEATURE_CHANNELS);

export const CATALOG_QUANTIZED_FEATURE_VECTOR_SCHEMA = z
  .object({
    scaleMillionths: z.number().int().positive().max(1_000_000_000),
    values: z.array(z.number().int().min(-32_767).max(32_767)).min(8).max(4096),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.values.every((entry) => entry === 0))
      context.addIssue({
        code: "custom",
        path: ["values"],
        message: "Feature vector cannot be zero",
      });
  });

export const CATALOG_PER_VIEW_FEATURE_SCHEMA = z
  .object({
    viewId: CATALOG_REVIEW_VIEW_ID_SCHEMA,
    feature: CATALOG_QUANTIZED_FEATURE_VECTOR_SCHEMA,
  })
  .strict();

export const CATALOG_FEATURE_RECEIPT_SCHEMA = z
  .object({
    kind: z.literal("CatalogFeatureReceipt"),
    sourceContentHash: HASH_SCHEMA,
    renderEvidenceHash: HASH_SCHEMA,
    channel: CATALOG_FEATURE_CHANNEL_SCHEMA,
    modelImplementationHash: HASH_SCHEMA,
    preprocessingImplementationHash: HASH_SCHEMA,
    aggregationImplementationHash: HASH_SCHEMA,
    perView: z.array(CATALOG_PER_VIEW_FEATURE_SCHEMA).length(12),
    aggregate: CATALOG_QUANTIZED_FEATURE_VECTOR_SCHEMA,
    maximumViewDisagreementMillionths: z.number().int().min(0).max(2_000_000),
    compilerAuthority: z.literal(false),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyArtifactHash(value, context);
    requireCanonicalValues(value.perView, (entry) => entry.viewId, "per-view features", context);
    const length = value.aggregate.values.length;
    for (const [index, view] of value.perView.entries())
      if (view.feature.values.length !== length)
        context.addIssue({
          code: "custom",
          path: ["perView", index, "feature", "values"],
          message: "Every per-view vector must match the aggregate dimension",
        });
  });
export type CatalogFeatureReceipt = z.output<typeof CATALOG_FEATURE_RECEIPT_SCHEMA>;

export const CATALOG_FEATURE_SET_SCHEMA = z
  .object({
    kind: z.literal("CatalogFeatureSet"),
    status: COMPILATION_STATUS_SCHEMA,
    pilotPlanHash: HASH_SCHEMA,
    visualReviewIndexHash: HASH_SCHEMA,
    receipts: z.array(CATALOG_FEATURE_RECEIPT_SCHEMA).max(500_000),
    missing: z
      .array(
        z
          .object({ sourceContentHash: HASH_SCHEMA, channel: CATALOG_FEATURE_CHANNEL_SCHEMA })
          .strict(),
      )
      .max(500_000),
    diagnostics: z.array(z.string().trim().min(1).max(1024)).max(100_000),
    compilerAuthority: z.literal(false),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyArtifactHash(value, context);
    requireCanonicalValues(value.receipts, featureIdentity, "feature receipts", context);
    requireCanonicalValues(
      value.missing,
      (entry) => `${entry.sourceContentHash}:${entry.channel}`,
      "missing feature receipts",
      context,
    );
    requireCanonicalValues(value.diagnostics, String, "feature diagnostics", context);
    const expected = value.missing.length === 0 ? "eligible" : "incomplete";
    if (value.status !== expected)
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "Feature-set status mismatch",
      });
  });
export type CatalogFeatureSet = z.output<typeof CATALOG_FEATURE_SET_SCHEMA>;

export function sealCatalogFeatureReceipt(
  input: Omit<CatalogFeatureReceipt, "kind" | "compilerAuthority" | "hash">,
): CatalogFeatureReceipt {
  return sealArtifact(CATALOG_FEATURE_RECEIPT_SCHEMA, {
    kind: "CatalogFeatureReceipt" as const,
    ...input,
    perView: canonicalValues(input.perView, (entry) => entry.viewId, "per-view features"),
    compilerAuthority: false as const,
  });
}

export function sealCatalogFeatureSet(input: {
  readonly pilotPlanHash: string;
  readonly visualReviewIndexHash: string;
  readonly expected: readonly {
    sourceContentHash: string;
    channel: z.output<typeof CATALOG_FEATURE_CHANNEL_SCHEMA>;
  }[];
  readonly receipts: readonly CatalogFeatureReceipt[];
  readonly diagnostics?: readonly string[];
}): CatalogFeatureSet {
  const receipts = canonicalValues(input.receipts, featureIdentity, "feature receipts");
  const present = new Set(receipts.map(featureIdentity));
  const missing = canonicalValues(
    input.expected.filter((entry) => !present.has(`${entry.sourceContentHash}:${entry.channel}`)),
    (entry) => `${entry.sourceContentHash}:${entry.channel}`,
    "missing feature receipts",
  );
  return sealArtifact(CATALOG_FEATURE_SET_SCHEMA, {
    kind: "CatalogFeatureSet" as const,
    status: missing.length === 0 ? ("eligible" as const) : ("incomplete" as const),
    pilotPlanHash: input.pilotPlanHash,
    visualReviewIndexHash: input.visualReviewIndexHash,
    receipts,
    missing,
    diagnostics: canonicalValues(
      [
        ...(input.diagnostics ?? []),
        ...(missing.length > 0 ? [`${missing.length} feature receipts are missing`] : []),
      ],
      String,
      "feature diagnostics",
    ),
    compilerAuthority: false as const,
  });
}

function featureIdentity(receipt: CatalogFeatureReceipt): string {
  return `${receipt.sourceContentHash}:${receipt.channel}`;
}
