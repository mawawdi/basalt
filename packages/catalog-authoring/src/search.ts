import { z } from "zod";
import {
  CATALOG_MEASUREMENT_SET_SCHEMA,
  CATALOG_VECTOR3_FIXED_SCHEMA,
  type CatalogAssetArtifact,
  type CatalogMeasurementSet,
} from "@basalt/catalog-model";
import {
  COMPILATION_STATUS_SCHEMA,
  HASH_SCHEMA,
  compareCanonicalStrings,
  contentHash,
  stableJson,
} from "@basalt/contracts";
import {
  CATALOG_EMBEDDING_MATRIX_SCHEMA,
  CATALOG_QUERY_EMBEDDING_RECEIPT_SCHEMA,
  decodeCatalogEmbeddingMatrix,
  quantizedSimilarityNumerator,
  type CatalogEmbeddingMatrix,
  type CatalogQueryEmbeddingReceipt,
  type CatalogQuantizedVector,
} from "./embeddings.js";
import {
  CATALOG_SEARCH_METADATA_SCHEMA,
  CATALOG_SEARCH_METADATA_SET_SCHEMA,
  normalizeSearchTerm,
  type CatalogSearchMetadata,
  type CatalogSearchMetadataSet,
} from "./metadata.js";
import {
  CATALOG_AUTHORED_SEARCH_METADATA_SET_SCHEMA,
  type CatalogAuthoredSearchMetadataRecord,
  type CatalogAuthoredSearchMetadataSet,
} from "./authored-metadata.js";
import {
  CATALOG_SEARCH_FIELD_NAMES,
  CATALOG_SEARCH_POLICY_SCHEMA,
  type CatalogSearchPolicy,
} from "./policy.js";
import {
  CATALOG_SOURCE_NAME_HINT_SET_SCHEMA,
  type CatalogSourceNameHintSet,
} from "./source-name-hints.js";
import { CATALOG_VISUAL_REVIEW_INDEX_SCHEMA, type CatalogVisualReviewIndex } from "./render.js";
import {
  canonicalValues,
  requireCanonicalValues,
  sealArtifact,
  verifyArtifactHash,
} from "./artifact.js";

const TOKENIZER_POLICY = Object.freeze({
  unicodeNormalization: "NFKC",
  caseNormalization: "unicode_default_lowercase",
  tokenAlphabet: "unicode_letter_or_number",
  stemming: false,
  stopWords: false,
});
export const CATALOG_SEARCH_TOKENIZER_IMPLEMENTATION_HASH = contentHash(
  stableJson(TOKENIZER_POLICY),
);

const SEARCH_TOKEN_SCHEMA = z.string().trim().min(1).max(160);
const SEARCH_FIELD_TOKEN_SCHEMA = z
  .object({
    field: z.enum(CATALOG_SEARCH_FIELD_NAMES),
    tokens: z.array(SEARCH_TOKEN_SCHEMA).max(512),
  })
  .strict();

const DOCUMENT_METRIC_SCHEMA = z
  .object({
    sizeMeters: CATALOG_VECTOR3_FIXED_SCHEMA,
    triangleCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    sourceBytes: z
      .number()
      .int()
      .nonnegative()
      .max(512 * 1024 * 1024),
  })
  .strict();

const DOCUMENT_RIGHTS_SCHEMA = z
  .object({ commercialUsePermitted: z.boolean(), redistributionPermitted: z.boolean() })
  .strict();

export const CATALOG_SEARCH_DOCUMENT_SCHEMA = z
  .object({
    sourceContentHash: HASH_SCHEMA,
    measurementHash: HASH_SCHEMA,
    renderEvidenceHash: HASH_SCHEMA.optional(),
    fields: z.array(SEARCH_FIELD_TOKEN_SCHEMA).length(CATALOG_SEARCH_FIELD_NAMES.length),
    metadataEvidence: z
      .discriminatedUnion("kind", [
        z
          .object({
            kind: z.literal("worker"),
            evidenceHash: HASH_SCHEMA,
            renderEvidenceHash: HASH_SCHEMA,
            metadata: CATALOG_SEARCH_METADATA_SCHEMA,
          })
          .strict(),
        z
          .object({
            kind: z.literal("authored"),
            evidenceHash: HASH_SCHEMA,
            batchHash: HASH_SCHEMA,
            producer: z
              .object({
                authority: z.enum(["creator", "delegated_ai"]),
                actorId: z.string().trim().min(1).max(160),
              })
              .strict(),
            authoringCertainty: z.discriminatedUnion("status", [
              z.object({ status: z.literal("concrete") }).strict(),
              z
                .object({
                  status: z.literal("uncertain"),
                  reason: z.string().trim().min(16).max(2_048),
                })
                .strict(),
            ]),
            reviewStatus: z.enum(["accepted", "revised", "uncertain", "unreviewed"]),
            reviewScope: z.enum(["complete_metadata", "visible_description_only"]).optional(),
            renderEvidenceHash: HASH_SCHEMA,
            metadata: CATALOG_SEARCH_METADATA_SCHEMA,
          })
          .strict(),
      ])
      .optional(),
    metric: DOCUMENT_METRIC_SCHEMA,
    rights: DOCUMENT_RIGHTS_SCHEMA,
    imageTextEmbeddingRow: z.number().int().nonnegative().max(100_000).optional(),
    shapeEmbeddingRow: z.number().int().nonnegative().max(100_000).optional(),
    missingEvidence: z
      .array(z.enum(["image_text_embedding", "metadata", "shape_embedding"]))
      .max(3),
  })
  .strict()
  .superRefine((value, context) => {
    requireCanonicalValues(value.fields, (entry) => entry.field, "search document fields", context);
    for (const field of value.fields)
      requireCanonicalValues(field.tokens, String, `search tokens for ${field.field}`, context);
    requireCanonicalValues(value.missingEvidence, String, "missing search evidence", context);
    const expectedMissing = [
      ...(value.metadataEvidence ? [] : ["metadata"]),
      ...(value.imageTextEmbeddingRow === undefined ? ["image_text_embedding"] : []),
      ...(value.shapeEmbeddingRow === undefined ? ["shape_embedding"] : []),
    ].sort(compareCanonicalStrings);
    if (stableJson(value.missingEvidence) !== stableJson(expectedMissing))
      context.addIssue({
        code: "custom",
        path: ["missingEvidence"],
        message: "Search document evidence gaps are inconsistent",
      });
    if (
      value.metadataEvidence?.kind === "authored" &&
      (value.metadataEvidence.reviewStatus === "unreviewed") !==
        (value.metadataEvidence.reviewScope === undefined)
    )
      context.addIssue({
        code: "custom",
        path: ["metadataEvidence", "reviewScope"],
        message: "Authored metadata review scope must be present exactly when review occurred",
      });
  });
export type CatalogSearchDocument = z.output<typeof CATALOG_SEARCH_DOCUMENT_SCHEMA>;

const CATALOG_SEARCH_EXCLUDED_SOURCE_SCHEMA = z
  .object({
    sourceContentHash: HASH_SCHEMA,
    measurementHash: HASH_SCHEMA,
    reason: z.literal("non_renderable_collision_companion"),
  })
  .strict();

export const CATALOG_SEARCH_INDEX_SCHEMA = z
  .object({
    kind: z.literal("CatalogSearchIndex"),
    status: COMPILATION_STATUS_SCHEMA,
    sourceManifestHash: HASH_SCHEMA,
    measurementSetHash: HASH_SCHEMA,
    visualReviewIndexHash: HASH_SCHEMA.optional(),
    sourceNameHintSetHash: HASH_SCHEMA,
    metadataSetHash: HASH_SCHEMA.optional(),
    authoredMetadataSetHashes: z.array(HASH_SCHEMA).max(10_000),
    imageTextEmbeddingMatrixHash: HASH_SCHEMA.optional(),
    shapeEmbeddingMatrixHash: HASH_SCHEMA.optional(),
    searchPolicyHash: HASH_SCHEMA,
    tokenizerImplementationHash: HASH_SCHEMA,
    buildImplementationHash: HASH_SCHEMA,
    coverage: z
      .object({
        searchableSources: z.number().int().nonnegative(),
        excludedNonRenderableCollisionCompanions: z.number().int().nonnegative(),
        metadata: z.number().int().nonnegative(),
        workerMetadata: z.number().int().nonnegative(),
        authoredMetadata: z.number().int().nonnegative(),
        imageTextEmbedding: z.number().int().nonnegative(),
        shapeEmbedding: z.number().int().nonnegative(),
      })
      .strict(),
    documents: z.array(CATALOG_SEARCH_DOCUMENT_SCHEMA).max(100_000),
    excludedSources: z.array(CATALOG_SEARCH_EXCLUDED_SOURCE_SCHEMA).max(100_000),
    diagnostics: z.array(z.string().trim().min(1).max(2_048)).max(100_000),
    compilerAuthority: z.literal(false),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyArtifactHash(value, context);
    requireCanonicalValues(
      value.documents,
      (entry) => entry.sourceContentHash,
      "search documents",
      context,
    );
    requireCanonicalValues(
      value.excludedSources,
      (entry) => entry.sourceContentHash,
      "excluded search sources",
      context,
    );
    requireCanonicalValues(value.diagnostics, String, "search index diagnostics", context);
    requireCanonicalValues(
      value.authoredMetadataSetHashes,
      String,
      "authored metadata set hashes",
      context,
    );
    const documentSources = new Set(value.documents.map((entry) => entry.sourceContentHash));
    if (value.excludedSources.some((entry) => documentSources.has(entry.sourceContentHash)))
      context.addIssue({
        code: "custom",
        path: ["excludedSources"],
        message: "A source cannot be both searchable and excluded",
      });
    const expected = value.diagnostics.length === 0 ? "eligible" : "incomplete";
    if (value.status !== expected)
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "Search index status mismatch",
      });
    if (value.tokenizerImplementationHash !== CATALOG_SEARCH_TOKENIZER_IMPLEMENTATION_HASH)
      context.addIssue({
        code: "custom",
        path: ["tokenizerImplementationHash"],
        message: "Search index binds a different tokenizer",
      });
    const actualCoverage = {
      searchableSources: value.documents.length,
      excludedNonRenderableCollisionCompanions: value.excludedSources.length,
      metadata: value.documents.filter((entry) => entry.metadataEvidence !== undefined).length,
      workerMetadata: value.documents.filter((entry) => entry.metadataEvidence?.kind === "worker")
        .length,
      authoredMetadata: value.documents.filter(
        (entry) => entry.metadataEvidence?.kind === "authored",
      ).length,
      imageTextEmbedding: value.documents.filter(
        (entry) => entry.imageTextEmbeddingRow !== undefined,
      ).length,
      shapeEmbedding: value.documents.filter((entry) => entry.shapeEmbeddingRow !== undefined)
        .length,
    };
    if (stableJson(value.coverage) !== stableJson(actualCoverage))
      context.addIssue({ code: "custom", path: ["coverage"], message: "Coverage mismatch" });
  });
export type CatalogSearchIndex = z.output<typeof CATALOG_SEARCH_INDEX_SCHEMA>;

const SEARCH_CONSTRAINTS_SCHEMA = z
  .object({
    maximumSizeMeters: CATALOG_VECTOR3_FIXED_SCHEMA.optional(),
    maximumTriangles: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    maximumSourceBytes: z
      .number()
      .int()
      .nonnegative()
      .max(512 * 1024 * 1024)
      .optional(),
    commercialUseRequired: z.boolean(),
    redistributionRequired: z.boolean(),
  })
  .strict();

export const CATALOG_SEARCH_QUERY_SCHEMA = z
  .object({
    kind: z.literal("CatalogSearchQuery"),
    text: z.string().trim().min(1).max(2_048),
    referenceSourceContentHash: HASH_SCHEMA.optional(),
    styleTerms: z.array(SEARCH_TOKEN_SCHEMA).max(32),
    rankingMode: z.enum([
      "automatic",
      "basename_only",
      "hybrid",
      "image_text_only",
      "metadata_only",
      "shape_only",
    ]),
    constraints: SEARCH_CONSTRAINTS_SCHEMA,
    limit: z.number().int().positive().max(100),
    validationLimit: z.number().int().nonnegative().max(8),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyArtifactHash(value, context);
    requireCanonicalValues(value.styleTerms, String, "query style terms", context);
    if (value.validationLimit > value.limit)
      context.addIssue({
        code: "custom",
        path: ["validationLimit"],
        message: "Validation limit cannot exceed the result limit",
      });
    if ((value.rankingMode === "shape_only") !== (value.referenceSourceContentHash !== undefined))
      context.addIssue({
        code: "custom",
        path: ["rankingMode"],
        message: "Shape-only search requires exactly one reference asset",
      });
  });
export type CatalogSearchQuery = z.output<typeof CATALOG_SEARCH_QUERY_SCHEMA>;

const FILTERED_CANDIDATE_SCHEMA = z
  .object({
    sourceContentHash: HASH_SCHEMA,
    reasons: z.array(z.string().min(1).max(128)).min(1).max(8),
  })
  .strict();

export const CATALOG_SEARCH_VALIDATION_STATES = [
  "match",
  "mismatch",
  "not_requested",
  "pending",
  "uncertain",
] as const;
export const CATALOG_SEARCH_VALIDATION_STATE_SCHEMA = z.enum(CATALOG_SEARCH_VALIDATION_STATES);

const SEARCH_RESULT_SCHEMA = z
  .object({
    sourceContentHash: HASH_SCHEMA,
    measurementHash: HASH_SCHEMA,
    metadataEvidenceHash: HASH_SCHEMA.optional(),
    metadataEvidenceKind: z.enum(["authored", "worker"]).optional(),
    renderEvidenceHash: HASH_SCHEMA.optional(),
    channelRanks: z
      .object({
        basenameLexical: z.number().int().positive().max(100_000).optional(),
        imageTextRetrieval: z.number().int().positive().max(100_000).optional(),
        metadataLexical: z.number().int().positive().max(100_000).optional(),
        shapeSimilarity: z.number().int().positive().max(100_000).optional(),
      })
      .strict(),
    fusedScoreBillionths: z.number().int().positive().max(1_000_000_000),
    fusedRank: z.number().int().positive().max(100),
    rankingChannels: z
      .array(
        z.enum([
          "basename_lexical",
          "image_text_retrieval",
          "metadata_lexical",
          "shape_similarity",
        ]),
      )
      .min(1)
      .max(4),
    missingEvidence: z
      .array(z.enum(["image_text_embedding", "metadata", "shape_embedding"]))
      .max(3),
    validation: CATALOG_SEARCH_VALIDATION_STATE_SCHEMA,
    validationReceiptHash: HASH_SCHEMA.optional(),
    metadata: CATALOG_SEARCH_METADATA_SCHEMA.optional(),
    metric: DOCUMENT_METRIC_SCHEMA,
    rights: DOCUMENT_RIGHTS_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    requireCanonicalValues(value.rankingChannels, String, "result ranking channels", context);
    requireCanonicalValues(value.missingEvidence, String, "result missing evidence", context);
    const expectedChannels = [
      ...(value.channelRanks.basenameLexical ? ["basename_lexical"] : []),
      ...(value.channelRanks.imageTextRetrieval ? ["image_text_retrieval"] : []),
      ...(value.channelRanks.metadataLexical ? ["metadata_lexical"] : []),
      ...(value.channelRanks.shapeSimilarity ? ["shape_similarity"] : []),
    ].sort(compareCanonicalStrings);
    if (stableJson(expectedChannels) !== stableJson(value.rankingChannels))
      context.addIssue({ code: "custom", message: "Ranking channels do not match channel ranks" });
    if (
      (value.validationReceiptHash !== undefined) !==
      ["match", "mismatch", "uncertain"].includes(value.validation)
    )
      context.addIssue({
        code: "custom",
        path: ["validationReceiptHash"],
        message: "Completed validation requires its exact receipt",
      });
    if (
      (value.metadata !== undefined) !== (value.metadataEvidenceHash !== undefined) ||
      (value.metadata !== undefined) !== (value.metadataEvidenceKind !== undefined)
    )
      context.addIssue({
        code: "custom",
        path: ["metadataEvidenceHash"],
        message: "Search-result metadata must bind its exact evidence kind and hash",
      });
  });

export const CATALOG_SEARCH_RESULT_SET_SCHEMA = z
  .object({
    kind: z.literal("CatalogSearchResultSet"),
    status: COMPILATION_STATUS_SCHEMA,
    query: CATALOG_SEARCH_QUERY_SCHEMA,
    indexHash: HASH_SCHEMA,
    queryEmbeddingReceiptHash: HASH_SCHEMA.optional(),
    results: z.array(SEARCH_RESULT_SCHEMA).max(100),
    filteredCandidates: z.array(FILTERED_CANDIDATE_SCHEMA).max(100_000),
    diagnostics: z.array(z.string().trim().min(1).max(2_048)).max(100_000),
    compilerAuthority: z.literal(false),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyArtifactHash(value, context);
    requireCanonicalValues(
      value.results,
      (entry) => String(entry.fusedRank).padStart(3, "0"),
      "search results",
      context,
    );
    requireCanonicalValues(
      value.filteredCandidates,
      (entry) => entry.sourceContentHash,
      "filtered candidates",
      context,
    );
    requireCanonicalValues(value.diagnostics, String, "search diagnostics", context);
    if (value.results.some((entry, index) => entry.fusedRank !== index + 1))
      context.addIssue({
        code: "custom",
        path: ["results"],
        message: "Search result ranks must be contiguous",
      });
    const expected = value.diagnostics.length === 0 ? "eligible" : "incomplete";
    if (value.status !== expected)
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "Search result status mismatch",
      });
  });
export type CatalogSearchResultSet = z.output<typeof CATALOG_SEARCH_RESULT_SET_SCHEMA>;

export function tokenizeCatalogSearchText(value: string): string[] {
  return canonicalValues(
    [
      ...new Set(
        value
          .normalize("NFKC")
          .toLowerCase()
          .match(/[\p{L}\p{N}]+/gu) ?? [],
      ),
    ],
    String,
    "search tokens",
  );
}

export function sealCatalogSearchQuery(
  input: Omit<CatalogSearchQuery, "kind" | "hash">,
): CatalogSearchQuery {
  return sealArtifact(CATALOG_SEARCH_QUERY_SCHEMA, {
    kind: "CatalogSearchQuery" as const,
    ...input,
    styleTerms: canonicalValues(
      input.styleTerms.map(normalizeSearchTerm),
      String,
      "query style terms",
    ),
  });
}

export function buildCatalogSearchIndex(input: {
  readonly measurements: CatalogMeasurementSet;
  readonly metadata?: CatalogSearchMetadataSet;
  readonly authoredMetadata?: readonly CatalogAuthoredSearchMetadataSet[];
  readonly sourceNames: CatalogSourceNameHintSet;
  readonly renders?: CatalogVisualReviewIndex;
  readonly imageTextEmbeddings?: CatalogEmbeddingMatrix;
  readonly shapeEmbeddings?: CatalogEmbeddingMatrix;
  readonly candidateSourceContentHashes?: readonly string[];
  readonly policy: CatalogSearchPolicy;
  readonly buildImplementationHash: string;
}): CatalogSearchIndex {
  const measurements = CATALOG_MEASUREMENT_SET_SCHEMA.parse(input.measurements);
  const metadata = input.metadata
    ? CATALOG_SEARCH_METADATA_SET_SCHEMA.parse(input.metadata)
    : undefined;
  const authoredMetadata = (input.authoredMetadata ?? []).map((entry) =>
    CATALOG_AUTHORED_SEARCH_METADATA_SET_SCHEMA.parse(entry),
  );
  const sourceNames = CATALOG_SOURCE_NAME_HINT_SET_SCHEMA.parse(input.sourceNames);
  const renders = input.renders
    ? CATALOG_VISUAL_REVIEW_INDEX_SCHEMA.parse(input.renders)
    : undefined;
  const imageTextMatrix = input.imageTextEmbeddings
    ? CATALOG_EMBEDDING_MATRIX_SCHEMA.parse(input.imageTextEmbeddings)
    : undefined;
  const shapeMatrix = input.shapeEmbeddings
    ? CATALOG_EMBEDDING_MATRIX_SCHEMA.parse(input.shapeEmbeddings)
    : undefined;
  const policy = CATALOG_SEARCH_POLICY_SCHEMA.parse(input.policy);
  if (sourceNames.status !== "eligible")
    throw new Error("Search indexing requires complete source-name evidence");
  if (imageTextMatrix && imageTextMatrix.purpose !== "image_text_retrieval")
    throw new Error("Search requires an image-text embedding matrix");
  if (shapeMatrix && shapeMatrix.purpose !== "shape_similarity")
    throw new Error("Search requires a shape-similarity embedding matrix");
  if (
    measurements.sourceManifestHash !== sourceNames.sourceManifestHash ||
    (renders && measurements.sourceManifestHash !== renders.sourceManifestHash) ||
    authoredMetadata.some(
      (entry) =>
        entry.sourceManifestHash !== measurements.sourceManifestHash ||
        entry.measurementSetHash !== measurements.hash ||
        (renders && entry.visualReviewIndexHash !== renders.hash),
    ) ||
    (imageTextMatrix && measurements.sourceManifestHash !== imageTextMatrix.sourceManifestHash) ||
    (shapeMatrix && measurements.sourceManifestHash !== shapeMatrix.sourceManifestHash)
  )
    throw new Error("Search inputs bind different source manifests");
  if (policy.tokenizerImplementationHash !== CATALOG_SEARCH_TOKENIZER_IMPLEMENTATION_HASH)
    throw new Error("Search policy binds a different tokenizer");
  const metadataBySource = new Map(
    (metadata?.receipts ?? [])
      .filter((entry) => entry.status === "eligible" && entry.metadata)
      .map((entry) => [entry.sourceContentHash, entry] as const),
  );
  const authoredMetadataBySource = new Map<string, CatalogAuthoredSearchMetadataRecord>();
  for (const set of authoredMetadata)
    for (const record of set.records) {
      if (metadataBySource.has(record.sourceContentHash))
        throw new Error(
          `Source ${record.sourceContentHash} has both worker and authored metadata; select one evidence source`,
        );
      if (authoredMetadataBySource.has(record.sourceContentHash))
        throw new Error(
          `Source ${record.sourceContentHash} appears in multiple authored metadata sets`,
        );
      authoredMetadataBySource.set(record.sourceContentHash, record);
    }
  const namesBySource = new Map(
    sourceNames.items.map((entry) => [entry.sourceContentHash, entry] as const),
  );
  const renderBySource = new Map(
    (renders?.items ?? []).map((entry) => [entry.sourceContentHash, entry] as const),
  );
  const imageTextRowBySource = new Map(
    (imageTextMatrix?.rows ?? []).map((entry, index) => [entry.sourceContentHash, index] as const),
  );
  const shapeRowBySource = new Map(
    (shapeMatrix?.rows ?? []).map((entry, index) => [entry.sourceContentHash, index] as const),
  );
  const diagnostics: string[] = [];
  const documents: CatalogSearchDocument[] = [];
  const excludedSources: z.output<typeof CATALOG_SEARCH_EXCLUDED_SOURCE_SCHEMA>[] = [];
  const candidates = input.candidateSourceContentHashes
    ? new Set(
        canonicalValues(input.candidateSourceContentHashes, String, "search candidate sources"),
      )
    : undefined;
  if (
    candidates &&
    [...candidates].some(
      (sourceContentHash) =>
        !measurements.assets.some((asset) => asset.source.contentHash === sourceContentHash),
    )
  )
    throw new Error("Search candidate universe contains an unmeasured source");
  for (const asset of measurements.assets) {
    const sourceHash = asset.source.contentHash;
    if (candidates && !candidates.has(sourceHash)) continue;
    if (asset.parts.length > 0 && asset.parts.every((part) => part.role === "collision_proxy")) {
      excludedSources.push({
        sourceContentHash: sourceHash,
        measurementHash: asset.hash,
        reason: "non_renderable_collision_companion",
      });
      continue;
    }
    const receipt = metadataBySource.get(sourceHash);
    const authoredRecord = authoredMetadataBySource.get(sourceHash);
    const sourceName = namesBySource.get(sourceHash);
    const render = renderBySource.get(sourceHash);
    const imageTextEmbeddingRow = imageTextRowBySource.get(sourceHash);
    const shapeEmbeddingRow = shapeRowBySource.get(sourceHash);
    if (!sourceName) {
      diagnostics.push(`Source ${sourceHash} lacks required source-name evidence`);
      continue;
    }
    if (receipt && receipt.measurementHash !== asset.hash)
      throw new Error(`Search metadata binds a stale measurement for ${sourceHash}`);
    if (receipt && render && receipt.renderEvidenceHash !== render.evidence.hash)
      throw new Error(`Search metadata binds stale render evidence for ${sourceHash}`);
    if (authoredRecord && authoredRecord.measurementHash !== asset.hash)
      throw new Error(`Authored search metadata binds a stale measurement for ${sourceHash}`);
    if (authoredRecord && render && authoredRecord.renderEvidenceHash !== render.evidence.hash)
      throw new Error(`Authored search metadata binds stale render evidence for ${sourceHash}`);
    const sourceTokens = sourceName.observations.flatMap((entry) => entry.tokens);
    const selectedMetadata = receipt?.metadata ?? authoredRecord?.metadata;
    const fields = documentFields(selectedMetadata, sourceTokens);
    const missingEvidence = [
      ...(selectedMetadata ? [] : ["metadata" as const]),
      ...(imageTextEmbeddingRow === undefined ? ["image_text_embedding" as const] : []),
      ...(shapeEmbeddingRow === undefined ? ["shape_embedding" as const] : []),
    ].sort(compareCanonicalStrings);
    documents.push({
      sourceContentHash: sourceHash,
      measurementHash: asset.hash,
      ...(render || receipt || authoredRecord
        ? {
            renderEvidenceHash:
              render?.evidence.hash ??
              receipt?.renderEvidenceHash ??
              authoredRecord!.renderEvidenceHash,
          }
        : {}),
      fields,
      ...(receipt?.metadata
        ? {
            metadataEvidence: {
              kind: "worker" as const,
              evidenceHash: receipt.hash,
              renderEvidenceHash: receipt.renderEvidenceHash,
              metadata: receipt.metadata,
            },
          }
        : authoredRecord
          ? {
              metadataEvidence: {
                kind: "authored" as const,
                evidenceHash: authoredRecord.hash,
                batchHash: authoredRecord.batchHash,
                producer: authoredRecord.producer,
                authoringCertainty: authoredRecord.authoringCertainty,
                reviewStatus: authoredRecord.review.status,
                ...(authoredRecord.review.status === "unreviewed"
                  ? {}
                  : { reviewScope: authoredRecord.review.reviewScope }),
                renderEvidenceHash: authoredRecord.renderEvidenceHash,
                metadata: authoredRecord.metadata,
              },
            }
          : {}),
      metric: measurementMetric(asset),
      rights: {
        commercialUsePermitted: asset.source.rights.commercialUsePermitted,
        redistributionPermitted: asset.source.rights.redistributionPermitted,
      },
      ...(imageTextEmbeddingRow === undefined ? {} : { imageTextEmbeddingRow }),
      ...(shapeEmbeddingRow === undefined ? {} : { shapeEmbeddingRow }),
      missingEvidence,
    });
  }
  const canonicalDocuments = canonicalValues(
    documents,
    (entry) => entry.sourceContentHash,
    "search documents",
  );
  const canonicalExcludedSources = canonicalValues(
    excludedSources,
    (entry) => entry.sourceContentHash,
    "excluded search sources",
  );
  return sealArtifact(CATALOG_SEARCH_INDEX_SCHEMA, {
    kind: "CatalogSearchIndex" as const,
    status: diagnostics.length === 0 ? ("eligible" as const) : ("incomplete" as const),
    sourceManifestHash: measurements.sourceManifestHash,
    measurementSetHash: measurements.hash,
    ...(renders ? { visualReviewIndexHash: renders.hash } : {}),
    sourceNameHintSetHash: sourceNames.hash,
    ...(metadata ? { metadataSetHash: metadata.hash } : {}),
    authoredMetadataSetHashes: canonicalValues(
      authoredMetadata.map((entry) => entry.hash),
      String,
      "authored metadata set hashes",
    ),
    ...(imageTextMatrix ? { imageTextEmbeddingMatrixHash: imageTextMatrix.hash } : {}),
    ...(shapeMatrix ? { shapeEmbeddingMatrixHash: shapeMatrix.hash } : {}),
    searchPolicyHash: policy.hash,
    tokenizerImplementationHash: CATALOG_SEARCH_TOKENIZER_IMPLEMENTATION_HASH,
    buildImplementationHash: input.buildImplementationHash,
    coverage: {
      searchableSources: canonicalDocuments.length,
      excludedNonRenderableCollisionCompanions: canonicalExcludedSources.length,
      metadata: canonicalDocuments.filter((entry) => entry.metadataEvidence !== undefined).length,
      workerMetadata: canonicalDocuments.filter(
        (entry) => entry.metadataEvidence?.kind === "worker",
      ).length,
      authoredMetadata: canonicalDocuments.filter(
        (entry) => entry.metadataEvidence?.kind === "authored",
      ).length,
      imageTextEmbedding: canonicalDocuments.filter(
        (entry) => entry.imageTextEmbeddingRow !== undefined,
      ).length,
      shapeEmbedding: canonicalDocuments.filter((entry) => entry.shapeEmbeddingRow !== undefined)
        .length,
    },
    documents: canonicalDocuments,
    excludedSources: canonicalExcludedSources,
    diagnostics: canonicalValues(diagnostics, String, "search index diagnostics"),
    compilerAuthority: false as const,
  });
}

export function executeCatalogSearch(input: {
  readonly index: CatalogSearchIndex;
  readonly policy: CatalogSearchPolicy;
  readonly query: CatalogSearchQuery;
  readonly imageTextMatrix?: CatalogEmbeddingMatrix;
  readonly imageTextMatrixBytes?: Uint8Array;
  readonly shapeMatrix?: CatalogEmbeddingMatrix;
  readonly shapeMatrixBytes?: Uint8Array;
  readonly queryEmbedding?: CatalogQueryEmbeddingReceipt;
}): CatalogSearchResultSet {
  const index = CATALOG_SEARCH_INDEX_SCHEMA.parse(input.index);
  const policy = CATALOG_SEARCH_POLICY_SCHEMA.parse(input.policy);
  const query = CATALOG_SEARCH_QUERY_SCHEMA.parse(input.query);
  if (index.searchPolicyHash !== policy.hash) throw new Error("Search policy does not bind index");
  const imageTextMatrix = input.imageTextMatrix
    ? CATALOG_EMBEDDING_MATRIX_SCHEMA.parse(input.imageTextMatrix)
    : undefined;
  const shapeMatrix = input.shapeMatrix
    ? CATALOG_EMBEDDING_MATRIX_SCHEMA.parse(input.shapeMatrix)
    : undefined;
  if ((imageTextMatrix !== undefined) !== (input.imageTextMatrixBytes !== undefined))
    throw new Error("Image-text matrix metadata and bytes must be supplied together");
  if ((shapeMatrix !== undefined) !== (input.shapeMatrixBytes !== undefined))
    throw new Error("Shape matrix metadata and bytes must be supplied together");
  if (imageTextMatrix) {
    if (imageTextMatrix.purpose !== "image_text_retrieval")
      throw new Error("Image-text matrix has the wrong retrieval purpose");
    if (index.imageTextEmbeddingMatrixHash !== imageTextMatrix.hash)
      throw new Error("Image-text matrix does not bind the index");
  }
  if (shapeMatrix) {
    if (shapeMatrix.purpose !== "shape_similarity")
      throw new Error("Shape matrix has the wrong retrieval purpose");
    if (index.shapeEmbeddingMatrixHash !== shapeMatrix.hash)
      throw new Error("Shape matrix does not bind the index");
  }
  const imageTextVectors = imageTextMatrix
    ? decodeCatalogEmbeddingMatrix(imageTextMatrix, input.imageTextMatrixBytes!)
    : new Map<string, CatalogQuantizedVector>();
  const shapeVectors = shapeMatrix
    ? decodeCatalogEmbeddingMatrix(shapeMatrix, input.shapeMatrixBytes!)
    : new Map<string, CatalogQuantizedVector>();
  const filteredCandidates: z.output<typeof FILTERED_CANDIDATE_SCHEMA>[] = [];
  const eligibleDocuments = index.documents.filter((document) => {
    const reasons = filterReasons(document, query);
    if (reasons.length > 0)
      filteredCandidates.push({ sourceContentHash: document.sourceContentHash, reasons });
    return reasons.length === 0;
  });
  const useBasenames = ["automatic", "basename_only", "hybrid"].includes(query.rankingMode);
  const useMetadata = ["automatic", "hybrid", "metadata_only"].includes(query.rankingMode);
  const useImageText = ["automatic", "hybrid", "image_text_only"].includes(query.rankingMode);
  const useShape = query.rankingMode === "shape_only";
  const basenameRanking = useBasenames
    ? rankLexical(eligibleDocuments, policy, query, { useBasenames: true, useMetadata: false })
    : [];
  const metadataRanking = useMetadata
    ? rankLexical(eligibleDocuments, policy, query, { useBasenames: false, useMetadata: true })
    : [];
  let queryVector: CatalogQuantizedVector | undefined;
  let queryEmbeddingReceiptHash: string | undefined;
  let candidateVectors: ReadonlyMap<string, CatalogQuantizedVector> = new Map();
  if (useShape && query.referenceSourceContentHash) {
    queryVector = shapeVectors.get(query.referenceSourceContentHash);
    candidateVectors = shapeVectors;
  } else if (useImageText && input.queryEmbedding && imageTextMatrix) {
    const receipt = CATALOG_QUERY_EMBEDDING_RECEIPT_SCHEMA.parse(input.queryEmbedding);
    if (receipt.queryHash !== query.hash) throw new Error("Query embedding binds another query");
    if (receipt.modelImplementationHash !== imageTextMatrix.modelImplementationHash)
      throw new Error("Query embedding and search matrix use different model implementations");
    queryVector = receipt.vector;
    queryEmbeddingReceiptHash = receipt.hash;
    candidateVectors = imageTextVectors;
  }
  const diagnostics: string[] = [];
  if (useShape && !queryVector)
    diagnostics.push(
      `Reference asset ${query.referenceSourceContentHash ?? "missing"} has no shape embedding`,
    );
  if (useImageText && !queryVector && ["hybrid", "image_text_only"].includes(query.rankingMode))
    diagnostics.push("Requested image-text ranking has no SigLIP query embedding receipt");
  if (query.rankingMode === "metadata_only" && index.coverage.metadata === 0)
    diagnostics.push("Requested metadata ranking has no metadata evidence");
  const embeddingRanking = queryVector
    ? rankEmbedding(eligibleDocuments, candidateVectors, queryVector)
    : [];
  const basenameRank = rankMap(basenameRanking);
  const metadataRank = rankMap(metadataRanking);
  const imageTextRank = !useShape ? rankMap(embeddingRanking) : new Map<string, number>();
  const shapeRank = useShape ? rankMap(embeddingRanking) : new Map<string, number>();
  const fused = new Map<string, number>();
  const documentsBySource = new Map(
    eligibleDocuments.map((entry) => [entry.sourceContentHash, entry] as const),
  );
  for (const document of eligibleDocuments) {
    const channels = [
      ...(useBasenames
        ? [
            {
              rank: basenameRank.get(document.sourceContentHash),
              limit: policy.lexicalCandidateLimit,
            },
          ]
        : []),
      ...(useMetadata && document.metadataEvidence
        ? [
            {
              rank: metadataRank.get(document.sourceContentHash),
              limit: policy.lexicalCandidateLimit,
            },
          ]
        : []),
      ...(useImageText && imageTextVectors.has(document.sourceContentHash) && queryVector
        ? [
            {
              rank: imageTextRank.get(document.sourceContentHash),
              limit: policy.embeddingCandidateLimit,
            },
          ]
        : []),
      ...(useShape && shapeVectors.has(document.sourceContentHash) && queryVector
        ? [
            {
              rank: shapeRank.get(document.sourceContentHash),
              limit: policy.embeddingCandidateLimit,
            },
          ]
        : []),
    ];
    if (channels.length === 0) continue;
    const score =
      channels.reduce(
        (sum, channel) =>
          sum +
          (channel.rank !== undefined && channel.rank <= channel.limit
            ? 1 / (policy.reciprocalRankConstant + channel.rank)
            : 0),
        0,
      ) / channels.length;
    if (score > 0) fused.set(document.sourceContentHash, score);
  }
  const ordered = [...fused]
    .sort(
      ([leftHash, leftScore], [rightHash, rightScore]) =>
        rightScore - leftScore || compareCanonicalStrings(leftHash, rightHash),
    )
    .slice(0, Math.min(query.limit, policy.maximumResults));
  const results = ordered.map(([sourceHash, fusedScore], indexValue) => {
    const document = documentsBySource.get(sourceHash)!;
    const basenameLexical = boundedRank(basenameRank.get(sourceHash), policy.lexicalCandidateLimit);
    const metadataLexical = boundedRank(metadataRank.get(sourceHash), policy.lexicalCandidateLimit);
    const imageTextRetrieval = boundedRank(
      imageTextRank.get(sourceHash),
      policy.embeddingCandidateLimit,
    );
    const shapeSimilarity = boundedRank(shapeRank.get(sourceHash), policy.embeddingCandidateLimit);
    const metadataEvidence = document.metadataEvidence;
    const rankingChannels = [
      ...(basenameLexical ? ["basename_lexical" as const] : []),
      ...(imageTextRetrieval ? ["image_text_retrieval" as const] : []),
      ...(metadataLexical ? ["metadata_lexical" as const] : []),
      ...(shapeSimilarity ? ["shape_similarity" as const] : []),
    ].sort(compareCanonicalStrings);
    const validationRequested = indexValue < query.validationLimit;
    if (validationRequested && !document.renderEvidenceHash)
      diagnostics.push(`Candidate ${sourceHash} lacks render-linked evidence for validation`);
    return {
      sourceContentHash: sourceHash,
      measurementHash: document.measurementHash,
      ...(metadataEvidence
        ? {
            metadataEvidenceHash: metadataEvidence.evidenceHash,
            metadataEvidenceKind: metadataEvidence.kind,
            metadata: metadataEvidence.metadata,
          }
        : {}),
      ...(document.renderEvidenceHash ? { renderEvidenceHash: document.renderEvidenceHash } : {}),
      channelRanks: {
        ...(basenameLexical ? { basenameLexical } : {}),
        ...(imageTextRetrieval ? { imageTextRetrieval } : {}),
        ...(metadataLexical ? { metadataLexical } : {}),
        ...(shapeSimilarity ? { shapeSimilarity } : {}),
      },
      fusedScoreBillionths: Math.max(1, Math.round(fusedScore * 1_000_000_000)),
      fusedRank: indexValue + 1,
      rankingChannels,
      missingEvidence: document.missingEvidence,
      validation:
        validationRequested && document.renderEvidenceHash
          ? ("pending" as const)
          : ("not_requested" as const),
      metric: document.metric,
      rights: document.rights,
    };
  });
  return sealArtifact(CATALOG_SEARCH_RESULT_SET_SCHEMA, {
    kind: "CatalogSearchResultSet" as const,
    status: diagnostics.length === 0 ? ("eligible" as const) : ("incomplete" as const),
    query,
    indexHash: index.hash,
    ...(queryEmbeddingReceiptHash ? { queryEmbeddingReceiptHash } : {}),
    results,
    filteredCandidates: canonicalValues(
      filteredCandidates,
      (entry) => entry.sourceContentHash,
      "filtered candidates",
    ),
    diagnostics: canonicalValues(diagnostics, String, "search diagnostics"),
    compilerAuthority: false as const,
  });
}

function rankMap(ranking: readonly { readonly sourceContentHash: string }[]): Map<string, number> {
  return new Map(ranking.map((entry, index) => [entry.sourceContentHash, index + 1]));
}

function boundedRank(rank: number | undefined, limit: number): number | undefined {
  return rank !== undefined && rank <= limit ? rank : undefined;
}

function documentFields(
  metadata: CatalogSearchMetadata | undefined,
  sourceTokens: readonly string[],
) {
  const fields: Array<z.output<typeof SEARCH_FIELD_TOKEN_SCHEMA>> = [
    {
      field: "alternateNouns",
      tokens: metadata ? tokensFromSetObservation(metadata.alternateNouns) : [],
    },
    { field: "caption", tokens: metadata ? tokensFromTextObservation(metadata.caption) : [] },
    { field: "colors", tokens: metadata ? tokensFromSetObservation(metadata.colors) : [] },
    {
      field: "environments",
      tokens: metadata ? tokensFromSetObservation(metadata.environments) : [],
    },
    { field: "materials", tokens: metadata ? tokensFromSetObservation(metadata.materials) : [] },
    {
      field: "primaryNoun",
      tokens: metadata ? tokensFromTextObservation(metadata.primaryNoun) : [],
    },
    {
      field: "sourceBasename",
      tokens: canonicalValues([...new Set(sourceTokens)], String, "source basename tokens"),
    },
    {
      field: "styleTerms",
      tokens: metadata ? tokensFromSetObservation(metadata.styleTerms) : [],
    },
    { field: "useCases", tokens: metadata ? tokensFromSetObservation(metadata.useCases) : [] },
    {
      field: "visibleText",
      tokens: metadata ? tokensFromSetObservation(metadata.visibleText) : [],
    },
  ];
  return canonicalValues(fields, (entry) => entry.field, "search document fields");
}

function tokensFromTextObservation(value: { status: string; value?: string }): string[] {
  return value.status === "observed" ? tokenizeCatalogSearchText(value.value ?? "") : [];
}

function tokensFromSetObservation(value: { status: string; value?: readonly string[] }): string[] {
  return value.status === "observed"
    ? canonicalValues(
        [...new Set((value.value ?? []).flatMap(tokenizeCatalogSearchText))],
        String,
        "metadata search tokens",
      )
    : [];
}

function measurementMetric(asset: CatalogAssetArtifact) {
  const dimension = (axis: "x" | "y" | "z") =>
    (BigInt(asset.bounds.max[axis]) - BigInt(asset.bounds.min[axis])).toString();
  return {
    sizeMeters: { x: dimension("x"), y: dimension("y"), z: dimension("z") },
    triangleCount: asset.parts.reduce((sum, part) => sum + part.triangleCount, 0),
    sourceBytes: asset.source.sourceArtifact?.bytes ?? 0,
  };
}

function selectedWeightedTokens(
  document: CatalogSearchDocument,
  policy: CatalogSearchPolicy,
  channels: { readonly useBasenames: boolean; readonly useMetadata: boolean },
): string[] {
  return document.fields
    .filter((field) =>
      field.field === "sourceBasename" ? channels.useBasenames : channels.useMetadata,
    )
    .flatMap((field) =>
      Array.from({ length: policy.fieldWeights[field.field] }, () => field.tokens).flat(),
    );
}

function rankLexical(
  documents: readonly CatalogSearchDocument[],
  policy: CatalogSearchPolicy,
  query: CatalogSearchQuery,
  channels: { readonly useBasenames: boolean; readonly useMetadata: boolean },
) {
  const queryTokens = tokenizeCatalogSearchText(`${query.text} ${query.styleTerms.join(" ")}`);
  const selectedTokens = new Map(
    documents.map(
      (document) =>
        [document.sourceContentHash, selectedWeightedTokens(document, policy, channels)] as const,
    ),
  );
  const frequencies = new Map<string, number>();
  for (const tokens of selectedTokens.values())
    for (const token of new Set(tokens)) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
  const lengths = [...selectedTokens.values()].map((tokens) => tokens.length);
  const averageLength = Math.max(
    1,
    lengths.length === 0 ? 1 : lengths.reduce((sum, value) => sum + value, 0) / lengths.length,
  );
  const population = Math.max(1, documents.length);
  return documents
    .map((document) => {
      const tokens = selectedTokens.get(document.sourceContentHash) ?? [];
      const termFrequency = new Map<string, number>();
      for (const token of tokens) termFrequency.set(token, (termFrequency.get(token) ?? 0) + 1);
      let score = 0;
      for (const token of queryTokens) {
        const frequency = termFrequency.get(token) ?? 0;
        if (frequency === 0) continue;
        const documentFrequency = frequencies.get(token) ?? 0;
        const inverseDocumentFrequency = Math.log(
          1 + (population - documentFrequency + 0.5) / (documentFrequency + 0.5),
        );
        const denominator = frequency + 1.2 * (1 - 0.75 + 0.75 * (tokens.length / averageLength));
        score += inverseDocumentFrequency * ((frequency * 2.2) / denominator);
      }
      return { sourceContentHash: document.sourceContentHash, score };
    })
    .filter((entry) => entry.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        compareCanonicalStrings(left.sourceContentHash, right.sourceContentHash),
    );
}

function rankEmbedding(
  documents: readonly CatalogSearchDocument[],
  vectors: ReadonlyMap<string, CatalogQuantizedVector>,
  queryVector: CatalogQuantizedVector,
) {
  return documents
    .flatMap((document) => {
      const vector = vectors.get(document.sourceContentHash);
      return vector
        ? [
            {
              sourceContentHash: document.sourceContentHash,
              score: quantizedSimilarityNumerator(vector, queryVector),
            },
          ]
        : [];
    })
    .sort(
      (left, right) =>
        (left.score === right.score ? 0 : left.score > right.score ? -1 : 1) ||
        compareCanonicalStrings(left.sourceContentHash, right.sourceContentHash),
    );
}

function filterReasons(document: CatalogSearchDocument, query: CatalogSearchQuery): string[] {
  const reasons: string[] = [];
  if (
    query.constraints.maximumTriangles !== undefined &&
    document.metric.triangleCount > query.constraints.maximumTriangles
  )
    reasons.push("triangle_budget");
  if (
    query.constraints.maximumSourceBytes !== undefined &&
    document.metric.sourceBytes > query.constraints.maximumSourceBytes
  )
    reasons.push("source_byte_budget");
  if (query.constraints.commercialUseRequired && !document.rights.commercialUsePermitted)
    reasons.push("commercial_rights");
  if (query.constraints.redistributionRequired && !document.rights.redistributionPermitted)
    reasons.push("redistribution_rights");
  if (query.constraints.maximumSizeMeters)
    for (const axis of ["x", "y", "z"] as const)
      if (
        BigInt(document.metric.sizeMeters[axis]) > BigInt(query.constraints.maximumSizeMeters[axis])
      )
        reasons.push(`size_${axis}`);
  return [...new Set(reasons)].sort(compareCanonicalStrings);
}
