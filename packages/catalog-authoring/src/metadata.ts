import { z } from "zod";
import { CATALOG_ASSET_ARTIFACT_SCHEMA, type CatalogAssetArtifact } from "@basalt/catalog-model";
import {
  COMPILATION_STATUS_SCHEMA,
  HASH_SCHEMA,
  compareCanonicalStrings,
  contentHash,
  dequantizeQ32_32,
  deepFreezeJson,
  stableJson,
} from "@basalt/contracts";
import {
  canonicalValues,
  requireCanonicalValues,
  sealArtifact,
  verifyArtifactHash,
} from "./artifact.js";
import { CATALOG_REVIEW_VIEW_ID_SCHEMA, CATALOG_REVIEW_VIEWPOINTS } from "./render.js";

export const CATALOG_METADATA_EVIDENCE_MODES = ["visual_and_name", "visual_only"] as const;
export const CATALOG_METADATA_EVIDENCE_MODE_SCHEMA = z.enum(CATALOG_METADATA_EVIDENCE_MODES);

export const CATALOG_METADATA_VIEW_SETS = ["canonical_twelve", "cardinal_four"] as const;
export const CATALOG_METADATA_VIEW_SET_SCHEMA = z.enum(CATALOG_METADATA_VIEW_SETS);

export const CATALOG_VISUAL_COMPOSITIONS = [
  "collision_proxy_like",
  "component_like",
  "multi_object_aggregate",
  "single_object",
] as const;
export const CATALOG_VISUAL_COMPOSITION_SCHEMA = z.enum(CATALOG_VISUAL_COMPOSITIONS);

export const CATALOG_SOURCE_ROLE_HINTS = [
  "assembly_component",
  "attachment",
  "environment_realizer",
  "route_component",
  "standalone",
] as const;
export const CATALOG_SOURCE_ROLE_HINT_SCHEMA = z.enum(CATALOG_SOURCE_ROLE_HINTS);

export const CATALOG_COMPLETENESS_HINTS = ["complete", "intentionally_partial"] as const;
export const CATALOG_COMPLETENESS_HINT_SCHEMA = z.enum(CATALOG_COMPLETENESS_HINTS);

export const CATALOG_VISIBLE_DAMAGE_HINTS = ["intact", "visibly_damaged"] as const;
export const CATALOG_VISIBLE_DAMAGE_HINT_SCHEMA = z.enum(CATALOG_VISIBLE_DAMAGE_HINTS);

const TERM_SCHEMA = z.string().trim().min(1).max(160);
const PROSE_SCHEMA = z.string().trim().min(1).max(2_048);
export const CATALOG_ABSTENTION_SCHEMA = z
  .object({ status: z.literal("abstained"), reason: z.string().trim().min(1).max(512) })
  .strict();

export function catalogObservation<T extends z.ZodType>(schema: T) {
  return z.discriminatedUnion("status", [
    z.object({ status: z.literal("observed"), value: schema }).strict(),
    CATALOG_ABSTENTION_SCHEMA,
  ]);
}

const TERM_SET_OBSERVATION_SCHEMA = catalogObservation(z.array(TERM_SCHEMA).max(64));
const TEXT_OBSERVATION_SCHEMA = catalogObservation(PROSE_SCHEMA);
const TERM_OBSERVATION_SCHEMA = catalogObservation(TERM_SCHEMA);

const METRIC_VECTOR_SCHEMA = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
    z: z.number().finite(),
  })
  .strict();
const NONNEGATIVE_METRIC_VECTOR_SCHEMA = METRIC_VECTOR_SCHEMA.refine(
  (value) => value.x >= 0 && value.y >= 0 && value.z >= 0,
  "Metric dimensions cannot be negative",
);

export const ASSET_METRIC_PROMPT_SUMMARY_SCHEMA = z
  .object({
    kind: z.literal("AssetMetricPromptSummary"),
    sourceContentHash: HASH_SCHEMA,
    measurementHash: HASH_SCHEMA,
    coordinateSystem: z.literal("right_handed_y_up_meters"),
    boundsMeters: z.object({ min: METRIC_VECTOR_SCHEMA, max: METRIC_VECTOR_SCHEMA }).strict(),
    sizeMeters: NONNEGATIVE_METRIC_VECTOR_SCHEMA,
    sourceFrame: z
      .object({
        handedness: z.enum(["right_handed", "left_handed"]),
        up: z.enum(["+X", "-X", "+Y", "-Y", "+Z", "-Z"]),
        forward: z.enum(["+X", "-X", "+Y", "-Y", "+Z", "-Z"]),
        unitsToMeters: z.number().finite().positive(),
      })
      .strict(),
    partCounts: z
      .object({
        total: z.number().int().nonnegative(),
        renderable: z.number().int().nonnegative(),
        collision: z.number().int().nonnegative(),
      })
      .strict(),
    triangleCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    support: z
      .object({
        primaryContact: z.enum(["bottom", "lateral_wall", "top_ceiling", "socket_only", "unknown"]),
        contactAreaSquareMeters: z.number().finite().nonnegative(),
        measurementMethod: z.enum(["planar_patch_fit", "lower_extrema", "refused"]),
      })
      .strict(),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyArtifactHash(value, context);
    for (const axis of ["x", "y", "z"] as const) {
      const expected = value.boundsMeters.max[axis] - value.boundsMeters.min[axis];
      if (Math.abs(expected - value.sizeMeters[axis]) > 1e-9)
        context.addIssue({
          code: "custom",
          path: ["sizeMeters", axis],
          message: "Metric size does not match bounds",
        });
    }
    if (value.partCounts.renderable + value.partCounts.collision !== value.partCounts.total)
      context.addIssue({
        code: "custom",
        path: ["partCounts"],
        message: "Metric part counts do not add up",
      });
  });
export type AssetMetricPromptSummary = z.output<typeof ASSET_METRIC_PROMPT_SUMMARY_SCHEMA>;

export const CATALOG_SEARCH_METADATA_SCHEMA = z
  .object({
    caption: TEXT_OBSERVATION_SCHEMA,
    primaryNoun: TERM_OBSERVATION_SCHEMA,
    alternateNouns: TERM_SET_OBSERVATION_SCHEMA,
    materials: TERM_SET_OBSERVATION_SCHEMA,
    colors: TERM_SET_OBSERVATION_SCHEMA,
    visibleText: TERM_SET_OBSERVATION_SCHEMA,
    useCases: TERM_SET_OBSERVATION_SCHEMA,
    environments: TERM_SET_OBSERVATION_SCHEMA,
    styleTerms: TERM_SET_OBSERVATION_SCHEMA,
    visualComposition: catalogObservation(CATALOG_VISUAL_COMPOSITION_SCHEMA),
    sourceRoleHint: catalogObservation(CATALOG_SOURCE_ROLE_HINT_SCHEMA),
    completeness: catalogObservation(CATALOG_COMPLETENESS_HINT_SCHEMA),
    visibleDamage: catalogObservation(CATALOG_VISIBLE_DAMAGE_HINT_SCHEMA),
    issueNotes: TERM_SET_OBSERVATION_SCHEMA,
  })
  .strict();
export type CatalogSearchMetadata = z.output<typeof CATALOG_SEARCH_METADATA_SCHEMA>;

export const CATALOG_SELECTED_RGB_VIEW_SCHEMA = z
  .object({ viewId: CATALOG_REVIEW_VIEW_ID_SCHEMA, rgbHash: HASH_SCHEMA })
  .strict();

export const ASSET_SEARCH_METADATA_REQUEST_SCHEMA = z
  .object({
    kind: z.literal("AssetSearchMetadataRequest"),
    sourceContentHash: HASH_SCHEMA,
    measurementHash: HASH_SCHEMA,
    renderEvidenceHash: HASH_SCHEMA,
    sourceNameHintHash: HASH_SCHEMA.optional(),
    evidenceMode: CATALOG_METADATA_EVIDENCE_MODE_SCHEMA,
    metricSummary: ASSET_METRIC_PROMPT_SUMMARY_SCHEMA,
    viewSet: CATALOG_METADATA_VIEW_SET_SCHEMA,
    promptTemplateHash: HASH_SCHEMA,
    outputSchemaHash: HASH_SCHEMA,
    preprocessingImplementationHash: HASH_SCHEMA,
    selectedRgbViews: z.array(CATALOG_SELECTED_RGB_VIEW_SCHEMA).min(4).max(12),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyArtifactHash(value, context);
    requireCanonicalValues(
      value.selectedRgbViews,
      (entry) => entry.viewId,
      "metadata RGB views",
      context,
    );
    const expectedViewIds = metadataViewIds(value.viewSet);
    const actualViewIds = value.selectedRgbViews.map((entry) => entry.viewId);
    if (stableJson(actualViewIds) !== stableJson(expectedViewIds))
      context.addIssue({
        code: "custom",
        path: ["selectedRgbViews"],
        message: "Metadata request views do not match the selected view set",
      });
    if (
      value.metricSummary.sourceContentHash !== value.sourceContentHash ||
      value.metricSummary.measurementHash !== value.measurementHash
    )
      context.addIssue({
        code: "custom",
        path: ["metricSummary"],
        message: "Metric summary does not bind the request source and measurement",
      });
    if ((value.evidenceMode === "visual_and_name") !== (value.sourceNameHintHash !== undefined))
      context.addIssue({
        code: "custom",
        path: ["sourceNameHintHash"],
        message: "Only visual-and-name requests bind a source-name hint",
      });
    if (value.outputSchemaHash !== CATALOG_SEARCH_METADATA_JSON_SCHEMA_HASH)
      context.addIssue({
        code: "custom",
        path: ["outputSchemaHash"],
        message: "Metadata request binds a different output schema",
      });
  });
export type AssetSearchMetadataRequest = z.output<typeof ASSET_SEARCH_METADATA_REQUEST_SCHEMA>;

export const CATALOG_SEARCH_METADATA_REQUEST_SET_SCHEMA = z
  .object({
    kind: z.literal("CatalogSearchMetadataRequestSet"),
    status: COMPILATION_STATUS_SCHEMA,
    scope: z.enum(["corpus", "qualification", "smoke"]),
    sourceManifestHash: HASH_SCHEMA,
    measurementSetHash: HASH_SCHEMA,
    visualReviewIndexHash: HASH_SCHEMA,
    sourceNameHintSetHash: HASH_SCHEMA,
    promptTemplateHash: HASH_SCHEMA,
    preprocessingImplementationHash: HASH_SCHEMA,
    requests: z.array(ASSET_SEARCH_METADATA_REQUEST_SCHEMA).max(200_000),
    diagnostics: z.array(z.string().trim().min(1).max(2_048)).max(100_000),
    compilerAuthority: z.literal(false),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyArtifactHash(value, context);
    requireCanonicalValues(value.requests, (entry) => entry.hash, "metadata requests", context);
    requireCanonicalValues(value.diagnostics, String, "metadata request diagnostics", context);
    const expected = value.diagnostics.length === 0 ? "eligible" : "incomplete";
    if (value.status !== expected)
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "Metadata request-set status mismatch",
      });
    for (const [index, request] of value.requests.entries())
      if (
        request.promptTemplateHash !== value.promptTemplateHash ||
        request.preprocessingImplementationHash !== value.preprocessingImplementationHash
      )
        context.addIssue({
          code: "custom",
          path: ["requests", index],
          message: "Metadata request uses different prompt or preprocessing evidence",
        });
  });
export type CatalogSearchMetadataRequestSet = z.output<
  typeof CATALOG_SEARCH_METADATA_REQUEST_SET_SCHEMA
>;

const MODEL_COMMIT_SCHEMA = z.string().regex(/^[a-f0-9]{40,64}$/u);
const RECEIPT_DIAGNOSTIC_SCHEMA = z.string().trim().min(1).max(2_048);

export const ASSET_SEARCH_METADATA_RECEIPT_SCHEMA = z
  .object({
    kind: z.literal("AssetSearchMetadataReceipt"),
    status: COMPILATION_STATUS_SCHEMA,
    requestHash: HASH_SCHEMA,
    sourceContentHash: HASH_SCHEMA,
    measurementHash: HASH_SCHEMA,
    renderEvidenceHash: HASH_SCHEMA,
    sourceNameHintHash: HASH_SCHEMA.optional(),
    evidenceMode: CATALOG_METADATA_EVIDENCE_MODE_SCHEMA,
    adapterId: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u),
    adapterImplementationHash: HASH_SCHEMA,
    workerImplementationHash: HASH_SCHEMA,
    runtimeImplementationHash: HASH_SCHEMA,
    modelId: z.string().trim().min(1).max(256),
    modelCommitHash: MODEL_COMMIT_SCHEMA,
    promptHash: HASH_SCHEMA,
    rawOutputHash: HASH_SCHEMA.optional(),
    metadata: CATALOG_SEARCH_METADATA_SCHEMA.optional(),
    diagnostics: z.array(RECEIPT_DIAGNOSTIC_SCHEMA).max(256),
    resourceUsage: z
      .object({
        inputImageCount: z.number().int().nonnegative().max(12),
        inputPixels: z.number().int().nonnegative().max(100_000_000),
        inputTokens: z.number().int().nonnegative().max(10_000_000),
        outputTokens: z.number().int().nonnegative().max(10_000_000),
        elapsedMilliseconds: z.number().int().nonnegative().max(86_400_000),
        peakResidentBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        gpuMilliseconds: z.number().int().nonnegative().max(86_400_000),
      })
      .strict(),
    compilerAuthority: z.literal(false),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyArtifactHash(value, context);
    requireCanonicalValues(value.diagnostics, String, "metadata receipt diagnostics", context);
    if (value.status === "eligible" && (!value.metadata || value.diagnostics.length > 0))
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "Eligible metadata receipts require metadata and no diagnostics",
      });
    if (value.status !== "eligible" && (value.metadata || value.diagnostics.length === 0))
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "Failed metadata receipts require diagnostics and cannot expose metadata",
      });
    if (value.metadata) requireCanonicalMetadata(value.metadata, context);
  });
export type AssetSearchMetadataReceipt = z.output<typeof ASSET_SEARCH_METADATA_RECEIPT_SCHEMA>;

export const CATALOG_SEARCH_METADATA_SET_SCHEMA = z
  .object({
    kind: z.literal("CatalogSearchMetadataSet"),
    status: COMPILATION_STATUS_SCHEMA,
    requestSetHash: HASH_SCHEMA,
    requestedHashes: z.array(HASH_SCHEMA).max(100_000),
    receipts: z.array(ASSET_SEARCH_METADATA_RECEIPT_SCHEMA).max(100_000),
    missingRequestHashes: z.array(HASH_SCHEMA).max(100_000),
    diagnostics: z.array(RECEIPT_DIAGNOSTIC_SCHEMA).max(100_000),
    compilerAuthority: z.literal(false),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyArtifactHash(value, context);
    requireCanonicalValues(value.requestedHashes, String, "metadata requested hashes", context);
    requireCanonicalValues(
      value.receipts,
      (entry) => entry.requestHash,
      "metadata receipts",
      context,
    );
    requireCanonicalValues(
      value.missingRequestHashes,
      String,
      "missing metadata requests",
      context,
    );
    requireCanonicalValues(value.diagnostics, String, "metadata set diagnostics", context);
    const expected = metadataSetStatus(value.receipts, value.missingRequestHashes);
    if (value.status !== expected)
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "Metadata set status mismatch",
      });
    const requested = new Set(value.requestedHashes);
    for (const receipt of value.receipts)
      if (!requested.has(receipt.requestHash))
        context.addIssue({
          code: "custom",
          path: ["receipts"],
          message: `Metadata receipt ${receipt.requestHash} was not requested`,
        });
  });
export type CatalogSearchMetadataSet = z.output<typeof CATALOG_SEARCH_METADATA_SET_SCHEMA>;

export const CATALOG_SEARCH_METADATA_JSON_SCHEMA = deepFreezeJson(
  z.toJSONSchema(CATALOG_SEARCH_METADATA_SCHEMA, { target: "draft-7" }),
);
export const CATALOG_SEARCH_METADATA_JSON_SCHEMA_HASH = contentHash(
  stableJson(CATALOG_SEARCH_METADATA_JSON_SCHEMA),
);

export function normalizeSearchTerm(value: string): string {
  const normalized = value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
  return TERM_SCHEMA.parse(normalized);
}

export function sealCatalogSearchMetadata(
  input: z.input<typeof CATALOG_SEARCH_METADATA_SCHEMA>,
): CatalogSearchMetadata {
  return deepFreezeJson(CATALOG_SEARCH_METADATA_SCHEMA.parse(canonicalMetadata(input)));
}

export function sealAssetSearchMetadataRequest(
  input: Omit<AssetSearchMetadataRequest, "kind" | "outputSchemaHash" | "hash">,
): AssetSearchMetadataRequest {
  return sealArtifact(ASSET_SEARCH_METADATA_REQUEST_SCHEMA, {
    kind: "AssetSearchMetadataRequest" as const,
    ...input,
    outputSchemaHash: CATALOG_SEARCH_METADATA_JSON_SCHEMA_HASH,
    selectedRgbViews: canonicalValues(
      input.selectedRgbViews,
      (entry) => entry.viewId,
      "metadata RGB views",
    ),
  });
}

export function sealAssetMetricPromptSummary(
  assetInput: CatalogAssetArtifact,
): AssetMetricPromptSummary {
  const asset = CATALOG_ASSET_ARTIFACT_SCHEMA.parse(assetInput);
  const min = metricVectorFromFixed(asset.bounds.min);
  const max = metricVectorFromFixed(asset.bounds.max);
  const renderable = asset.parts.filter((part) => part.role !== "collision_proxy").length;
  const collision = asset.parts.length - renderable;
  return sealArtifact(ASSET_METRIC_PROMPT_SUMMARY_SCHEMA, {
    kind: "AssetMetricPromptSummary" as const,
    sourceContentHash: asset.source.contentHash,
    measurementHash: asset.hash,
    coordinateSystem: "right_handed_y_up_meters" as const,
    boundsMeters: { min, max },
    sizeMeters: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
    sourceFrame: {
      handedness: asset.coordinateFrame.handedness,
      up: asset.coordinateFrame.up,
      forward: asset.coordinateFrame.forward,
      unitsToMeters: dequantizeQ32_32(asset.coordinateFrame.unitsToMeters),
    },
    partCounts: { total: asset.parts.length, renderable, collision },
    triangleCount: asset.parts.reduce((sum, part) => sum + part.triangleCount, 0),
    support: {
      primaryContact: asset.support.primaryContact,
      contactAreaSquareMeters: dequantizeQ32_32(asset.support.contactAreaSquareMeters),
      measurementMethod: asset.support.measurementMethod,
    },
  });
}

export function metricVectorFromFixed(value: {
  readonly x: string;
  readonly y: string;
  readonly z: string;
}): { readonly x: number; readonly y: number; readonly z: number } {
  return {
    x: dequantizeQ32_32(value.x),
    y: dequantizeQ32_32(value.y),
    z: dequantizeQ32_32(value.z),
  };
}

export function metadataViewIds(
  viewSet: z.input<typeof CATALOG_METADATA_VIEW_SET_SCHEMA>,
): readonly string[] {
  return viewSet === "cardinal_four"
    ? ["low_00", "low_02", "low_04", "low_06"]
    : CATALOG_REVIEW_VIEWPOINTS.map((entry) => entry.viewId);
}

export function sealCatalogSearchMetadataRequestSet(
  input: Omit<
    CatalogSearchMetadataRequestSet,
    "kind" | "status" | "diagnostics" | "compilerAuthority" | "hash"
  > & { readonly diagnostics?: readonly string[] },
): CatalogSearchMetadataRequestSet {
  const diagnostics = canonicalValues(
    input.diagnostics ?? [],
    String,
    "metadata request diagnostics",
  );
  return sealArtifact(CATALOG_SEARCH_METADATA_REQUEST_SET_SCHEMA, {
    kind: "CatalogSearchMetadataRequestSet" as const,
    status: diagnostics.length === 0 ? ("eligible" as const) : ("incomplete" as const),
    ...input,
    requests: canonicalValues(input.requests, (entry) => entry.hash, "metadata requests"),
    diagnostics,
    compilerAuthority: false as const,
  });
}

export function sealAssetSearchMetadataReceipt(input: {
  readonly request: AssetSearchMetadataRequest;
  readonly status: "eligible" | "incomplete" | "rejected";
  readonly adapterId: string;
  readonly adapterImplementationHash: string;
  readonly workerImplementationHash: string;
  readonly runtimeImplementationHash: string;
  readonly modelId: string;
  readonly modelCommitHash: string;
  readonly promptHash: string;
  readonly rawOutputHash?: string;
  readonly metadata?: z.input<typeof CATALOG_SEARCH_METADATA_SCHEMA>;
  readonly diagnostics: readonly string[];
  readonly resourceUsage: AssetSearchMetadataReceipt["resourceUsage"];
}): AssetSearchMetadataReceipt {
  const request = ASSET_SEARCH_METADATA_REQUEST_SCHEMA.parse(input.request);
  return sealArtifact(ASSET_SEARCH_METADATA_RECEIPT_SCHEMA, {
    kind: "AssetSearchMetadataReceipt" as const,
    status: input.status,
    requestHash: request.hash,
    sourceContentHash: request.sourceContentHash,
    measurementHash: request.measurementHash,
    renderEvidenceHash: request.renderEvidenceHash,
    ...(request.sourceNameHintHash ? { sourceNameHintHash: request.sourceNameHintHash } : {}),
    evidenceMode: request.evidenceMode,
    adapterId: input.adapterId,
    adapterImplementationHash: input.adapterImplementationHash,
    workerImplementationHash: input.workerImplementationHash,
    runtimeImplementationHash: input.runtimeImplementationHash,
    modelId: input.modelId,
    modelCommitHash: input.modelCommitHash,
    promptHash: input.promptHash,
    ...(input.rawOutputHash ? { rawOutputHash: input.rawOutputHash } : {}),
    ...(input.metadata ? { metadata: sealCatalogSearchMetadata(input.metadata) } : {}),
    diagnostics: canonicalValues(input.diagnostics, String, "metadata receipt diagnostics"),
    resourceUsage: input.resourceUsage,
    compilerAuthority: false as const,
  });
}

export function sealCatalogSearchMetadataSet(input: {
  readonly requestSetHash: string;
  readonly requestedHashes: readonly string[];
  readonly receipts: readonly AssetSearchMetadataReceipt[];
  readonly diagnostics?: readonly string[];
}): CatalogSearchMetadataSet {
  const requestedHashes = canonicalValues(
    input.requestedHashes,
    String,
    "metadata requested hashes",
  );
  const receipts = canonicalValues(
    input.receipts,
    (entry) => entry.requestHash,
    "metadata receipts",
  );
  const present = new Set(receipts.map((entry) => entry.requestHash));
  const missingRequestHashes = requestedHashes.filter((hash) => !present.has(hash));
  const diagnostics = canonicalValues(
    [
      ...(input.diagnostics ?? []),
      ...(missingRequestHashes.length > 0
        ? [`${missingRequestHashes.length} metadata requests have no receipt`]
        : []),
    ],
    String,
    "metadata set diagnostics",
  );
  return sealArtifact(CATALOG_SEARCH_METADATA_SET_SCHEMA, {
    kind: "CatalogSearchMetadataSet" as const,
    status: metadataSetStatus(receipts, missingRequestHashes),
    requestSetHash: input.requestSetHash,
    requestedHashes,
    receipts,
    missingRequestHashes,
    diagnostics,
    compilerAuthority: false as const,
  });
}

function canonicalMetadata(input: z.input<typeof CATALOG_SEARCH_METADATA_SCHEMA>) {
  const value = CATALOG_SEARCH_METADATA_SCHEMA.parse(input);
  return {
    ...value,
    primaryNoun: canonicalTermObservation(value.primaryNoun),
    alternateNouns: canonicalTermSetObservation(value.alternateNouns),
    materials: canonicalTermSetObservation(value.materials),
    colors: canonicalTermSetObservation(value.colors),
    visibleText: canonicalTermSetObservation(value.visibleText),
    useCases: canonicalTermSetObservation(value.useCases),
    environments: canonicalTermSetObservation(value.environments),
    styleTerms: canonicalTermSetObservation(value.styleTerms),
    issueNotes: canonicalTermSetObservation(value.issueNotes),
  };
}

function canonicalTermObservation<T extends { status: string; value?: string }>(value: T): T {
  return value.status === "observed"
    ? ({ ...value, value: normalizeSearchTerm(value.value ?? "") } as T)
    : value;
}

function canonicalTermSetObservation<T extends { status: string; value?: string[] }>(value: T): T {
  return value.status === "observed"
    ? ({
        ...value,
        value: canonicalValues(
          [...new Set((value.value ?? []).map(normalizeSearchTerm))],
          String,
          "metadata terms",
        ),
      } as T)
    : value;
}

function requireCanonicalMetadata(value: CatalogSearchMetadata, context: z.RefinementCtx): void {
  const observations = [
    value.alternateNouns,
    value.materials,
    value.colors,
    value.visibleText,
    value.useCases,
    value.environments,
    value.styleTerms,
    value.issueNotes,
  ];
  for (const observation of observations)
    if (observation.status === "observed")
      requireCanonicalValues(observation.value, String, "metadata terms", context);
  if (
    value.primaryNoun.status === "observed" &&
    value.primaryNoun.value !== normalizeSearchTerm(value.primaryNoun.value)
  )
    context.addIssue({
      code: "custom",
      path: ["metadata", "primaryNoun"],
      message: "Primary noun must use canonical search normalization",
    });
}

function metadataSetStatus(
  receipts: readonly AssetSearchMetadataReceipt[],
  missing: readonly string[],
): "eligible" | "incomplete" | "rejected" {
  if (receipts.some((entry) => entry.status === "rejected")) return "rejected";
  if (missing.length > 0 || receipts.some((entry) => entry.status === "incomplete"))
    return "incomplete";
  return "eligible";
}

export function compareMetadataReceiptIdentity(
  left: AssetSearchMetadataReceipt,
  right: AssetSearchMetadataReceipt,
): number {
  return compareCanonicalStrings(left.requestHash, right.requestHash);
}

/** A cached hypothesis is reusable only under the exact execution identity that produced it. */
export function metadataReceiptMatchesExecution(
  receipt: AssetSearchMetadataReceipt,
  execution: {
    readonly modelId: string;
    readonly modelCommitHash: string;
    readonly workerImplementationHash: string;
  },
): boolean {
  return (
    receipt.modelId === execution.modelId &&
    receipt.modelCommitHash === execution.modelCommitHash &&
    receipt.workerImplementationHash === execution.workerImplementationHash
  );
}
