import { z } from "zod";
import {
  COMPILATION_STATUS_SCHEMA,
  HASH_SCHEMA,
  compareCanonicalStrings,
  stableJson,
} from "@basalt/contracts";
import {
  canonicalValues,
  requireCanonicalValues,
  sealArtifact,
  verifyArtifactHash,
} from "./artifact.js";

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

export const CATALOG_REVIEW_VIEW_ID_SCHEMA = z.string().regex(/^(?:low|high)_[0-9]{2}$/u);

const CATALOG_RENDER_VIEW_SCHEMA = z
  .object({
    viewId: CATALOG_REVIEW_VIEW_ID_SCHEMA,
    azimuthDegrees: z.number().finite().min(0).lt(360),
    elevationDegrees: z.number().finite().gt(0).lt(90),
    rgbHash: HASH_SCHEMA,
    silhouetteHash: HASH_SCHEMA,
    normalizedDepthHash: HASH_SCHEMA,
    surfaceNormalHash: HASH_SCHEMA,
    unlitBaseColorHash: HASH_SCHEMA,
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
    channelEncodingHash: HASH_SCHEMA,
    views: z.array(CATALOG_RENDER_VIEW_SCHEMA).length(12),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyArtifactHash(value, context);
    requireCanonicalValues(value.views, (view) => view.viewId, "render views", context);
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
    contactSheetRelativePath: z.string().trim().min(1).max(4096),
    viewArtifacts: z
      .array(
        z
          .object({
            viewId: CATALOG_REVIEW_VIEW_ID_SCHEMA,
            rgbRelativePath: z.string().trim().min(1).max(4096),
            silhouetteRelativePath: z.string().trim().min(1).max(4096),
            normalizedDepthRelativePath: z.string().trim().min(1).max(4096),
            surfaceNormalRelativePath: z.string().trim().min(1).max(4096),
            unlitBaseColorRelativePath: z.string().trim().min(1).max(4096),
          })
          .strict(),
      )
      .length(12),
    evidence: CATALOG_RENDER_EVIDENCE_SCHEMA,
  })
  .strict()
  .superRefine((value, context) =>
    requireCanonicalValues(value.viewArtifacts, (view) => view.viewId, "view artifacts", context),
  );

export const CATALOG_VISUAL_REVIEW_INDEX_SCHEMA = z
  .object({
    kind: z.literal("CatalogVisualReviewIndex"),
    status: COMPILATION_STATUS_SCHEMA,
    sourceManifestHash: HASH_SCHEMA,
    rendererImplementationHash: HASH_SCHEMA,
    cameraRigHash: HASH_SCHEMA,
    lightingHash: HASH_SCHEMA,
    materialModeHash: HASH_SCHEMA,
    channelEncodingHash: HASH_SCHEMA,
    items: z.array(CATALOG_VISUAL_REVIEW_ITEM_SCHEMA),
    diagnostics: z.array(z.string().trim().min(1).max(1024)),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyArtifactHash(value, context);
    const expectedStatus = value.diagnostics.length === 0 ? "eligible" : "incomplete";
    if (value.status !== expectedStatus)
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "Visual review status does not match its diagnostics",
      });
    requireCanonicalValues(
      value.items,
      (item) => item.sourceContentHash,
      "visual-review items",
      context,
    );
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
        item.evidence.materialModeHash !== value.materialModeHash ||
        item.evidence.channelEncodingHash !== value.channelEncodingHash
      )
        context.addIssue({
          code: "custom",
          path: ["items", index, "evidence"],
          message: "Render evidence does not match index policy",
        });
    }
  });
export type CatalogVisualReviewIndex = z.output<typeof CATALOG_VISUAL_REVIEW_INDEX_SCHEMA>;

export function sealCatalogRenderEvidence(
  input: Omit<CatalogRenderEvidence, "kind" | "hash">,
): CatalogRenderEvidence {
  return sealArtifact(CATALOG_RENDER_EVIDENCE_SCHEMA, {
    kind: "CatalogRenderEvidence" as const,
    ...input,
    views: canonicalValues(input.views, (view) => view.viewId, "render views"),
  });
}

export function sealCatalogVisualReviewIndex(
  input: Omit<CatalogVisualReviewIndex, "kind" | "hash">,
): CatalogVisualReviewIndex {
  return sealArtifact(CATALOG_VISUAL_REVIEW_INDEX_SCHEMA, {
    kind: "CatalogVisualReviewIndex" as const,
    ...input,
    items: canonicalValues(
      input.items.map((item) => ({
        ...item,
        viewArtifacts: canonicalValues(item.viewArtifacts, (view) => view.viewId, "view artifacts"),
      })),
      (item) => item.sourceContentHash,
      "visual-review items",
    ),
    diagnostics: canonicalValues(input.diagnostics, String, "visual-review diagnostics"),
  });
}
