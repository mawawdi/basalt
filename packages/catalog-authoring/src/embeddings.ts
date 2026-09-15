import { createHash } from "node:crypto";
import { z } from "zod";
import {
  COMPILATION_STATUS_SCHEMA,
  CONTENT_DESCRIPTOR_SCHEMA,
  HASH_SCHEMA,
  contentHash,
  stableJson,
} from "@basalt/contracts";
import {
  canonicalValues,
  requireCanonicalValues,
  sealArtifact,
  verifyArtifactHash,
} from "./artifact.js";

export const CATALOG_EMBEDDING_PURPOSES = ["image_text_retrieval", "shape_similarity"] as const;
export const CATALOG_EMBEDDING_PURPOSE_SCHEMA = z.enum(CATALOG_EMBEDDING_PURPOSES);
export type CatalogEmbeddingPurpose = z.output<typeof CATALOG_EMBEDDING_PURPOSE_SCHEMA>;

export const CATALOG_QUANTIZED_VECTOR_SCHEMA = z
  .object({
    scaleMillionths: z.number().int().positive().max(1_000_000_000),
    values: z.array(z.number().int().min(-32_767).max(32_767)).min(8).max(8_192),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.values.every((entry) => entry === 0))
      context.addIssue({ code: "custom", path: ["values"], message: "Embedding cannot be zero" });
  });
export type CatalogQuantizedVector = z.output<typeof CATALOG_QUANTIZED_VECTOR_SCHEMA>;

const MODEL_COMMIT_SCHEMA = z.string().regex(/^[a-f0-9]{40,64}$/u);

export const CATALOG_EMBEDDING_RECEIPT_SCHEMA = z
  .object({
    kind: z.literal("CatalogEmbeddingReceipt"),
    sourceContentHash: HASH_SCHEMA,
    renderEvidenceHash: HASH_SCHEMA,
    purpose: CATALOG_EMBEDDING_PURPOSE_SCHEMA,
    modelId: z.string().trim().min(1).max(256),
    modelCommitHash: MODEL_COMMIT_SCHEMA,
    modelImplementationHash: HASH_SCHEMA,
    preprocessingImplementationHash: HASH_SCHEMA,
    aggregationImplementationHash: HASH_SCHEMA,
    perViewEvidenceHash: HASH_SCHEMA.optional(),
    aggregate: CATALOG_QUANTIZED_VECTOR_SCHEMA,
    maximumViewDisagreementMillionths: z.number().int().min(0).max(2_000_000),
    gpuMilliseconds: z.number().int().nonnegative().max(86_400_000),
    compilerAuthority: z.literal(false),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => verifyArtifactHash(value, context));
export type CatalogEmbeddingReceipt = z.output<typeof CATALOG_EMBEDDING_RECEIPT_SCHEMA>;

export const CATALOG_EMBEDDING_SET_SCHEMA = z
  .object({
    kind: z.literal("CatalogEmbeddingSet"),
    status: COMPILATION_STATUS_SCHEMA,
    sourceManifestHash: HASH_SCHEMA,
    visualReviewIndexHash: HASH_SCHEMA,
    expected: z
      .array(
        z
          .object({ sourceContentHash: HASH_SCHEMA, purpose: CATALOG_EMBEDDING_PURPOSE_SCHEMA })
          .strict(),
      )
      .max(200_000),
    receipts: z.array(CATALOG_EMBEDDING_RECEIPT_SCHEMA).max(200_000),
    missing: z
      .array(
        z
          .object({ sourceContentHash: HASH_SCHEMA, purpose: CATALOG_EMBEDDING_PURPOSE_SCHEMA })
          .strict(),
      )
      .max(200_000),
    diagnostics: z.array(z.string().trim().min(1).max(2_048)).max(200_000),
    compilerAuthority: z.literal(false),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyArtifactHash(value, context);
    requireCanonicalValues(value.expected, embeddingTargetIdentity, "embedding targets", context);
    requireCanonicalValues(value.receipts, embeddingReceiptIdentity, "embedding receipts", context);
    requireCanonicalValues(value.missing, embeddingTargetIdentity, "missing embeddings", context);
    requireCanonicalValues(value.diagnostics, String, "embedding diagnostics", context);
    const expectedStatus = value.missing.length === 0 ? "eligible" : "incomplete";
    if (value.status !== expectedStatus)
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "Embedding set status mismatch",
      });
  });
export type CatalogEmbeddingSet = z.output<typeof CATALOG_EMBEDDING_SET_SCHEMA>;

const MATRIX_ROW_SCHEMA = z
  .object({ sourceContentHash: HASH_SCHEMA, scaleMillionths: z.number().int().positive() })
  .strict();

const BINARY_DESCRIPTOR_SCHEMA = CONTENT_DESCRIPTOR_SCHEMA.extend({
  kind: z.literal("embedding_matrix"),
  mediaType: z.literal("application/vnd.basalt.quantized-embedding-matrix"),
}).strict();

export const CATALOG_EMBEDDING_MATRIX_SCHEMA = z
  .object({
    kind: z.literal("CatalogEmbeddingMatrix"),
    purpose: CATALOG_EMBEDDING_PURPOSE_SCHEMA,
    sourceManifestHash: HASH_SCHEMA,
    embeddingSetHash: HASH_SCHEMA,
    modelImplementationHash: HASH_SCHEMA,
    preprocessingImplementationHash: HASH_SCHEMA,
    aggregationImplementationHash: HASH_SCHEMA,
    encoding: z.literal("int16_le_unit_vector"),
    dimension: z.number().int().min(8).max(8_192),
    rows: z.array(MATRIX_ROW_SCHEMA).max(100_000),
    blob: BINARY_DESCRIPTOR_SCHEMA,
    compilerAuthority: z.literal(false),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyArtifactHash(value, context);
    requireCanonicalValues(
      value.rows,
      (entry) => entry.sourceContentHash,
      "embedding matrix rows",
      context,
    );
    if (value.blob.sizeBytes !== value.rows.length * value.dimension * 2)
      context.addIssue({
        code: "custom",
        path: ["blob", "sizeBytes"],
        message: "Embedding matrix byte size does not match its rows and dimension",
      });
  });
export type CatalogEmbeddingMatrix = z.output<typeof CATALOG_EMBEDDING_MATRIX_SCHEMA>;

export const CATALOG_QUERY_EMBEDDING_RECEIPT_SCHEMA = z
  .object({
    kind: z.literal("CatalogQueryEmbeddingReceipt"),
    queryHash: HASH_SCHEMA,
    purpose: z.literal("image_text_retrieval"),
    modelImplementationHash: HASH_SCHEMA,
    preprocessingImplementationHash: HASH_SCHEMA,
    workerOutputHash: HASH_SCHEMA,
    batchGpuMilliseconds: z.number().int().nonnegative().max(86_400_000),
    vector: CATALOG_QUANTIZED_VECTOR_SCHEMA,
    compilerAuthority: z.literal(false),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => verifyArtifactHash(value, context));
export type CatalogQueryEmbeddingReceipt = z.output<typeof CATALOG_QUERY_EMBEDDING_RECEIPT_SCHEMA>;

export function sealCatalogEmbeddingReceipt(
  input: Omit<CatalogEmbeddingReceipt, "kind" | "compilerAuthority" | "hash">,
): CatalogEmbeddingReceipt {
  return sealArtifact(CATALOG_EMBEDDING_RECEIPT_SCHEMA, {
    kind: "CatalogEmbeddingReceipt" as const,
    ...input,
    compilerAuthority: false as const,
  });
}

export function sealCatalogEmbeddingSet(input: {
  readonly sourceManifestHash: string;
  readonly visualReviewIndexHash: string;
  readonly expected: readonly { sourceContentHash: string; purpose: CatalogEmbeddingPurpose }[];
  readonly receipts: readonly CatalogEmbeddingReceipt[];
  readonly diagnostics?: readonly string[];
}): CatalogEmbeddingSet {
  const expected = canonicalValues(input.expected, embeddingTargetIdentity, "embedding targets");
  const receipts = canonicalValues(input.receipts, embeddingReceiptIdentity, "embedding receipts");
  const present = new Set(receipts.map(embeddingReceiptIdentity));
  const missing = expected.filter((entry) => !present.has(embeddingTargetIdentity(entry)));
  return sealArtifact(CATALOG_EMBEDDING_SET_SCHEMA, {
    kind: "CatalogEmbeddingSet" as const,
    status: missing.length === 0 ? ("eligible" as const) : ("incomplete" as const),
    sourceManifestHash: input.sourceManifestHash,
    visualReviewIndexHash: input.visualReviewIndexHash,
    expected,
    receipts,
    missing,
    diagnostics: canonicalValues(
      [
        ...(input.diagnostics ?? []),
        ...(missing.length > 0 ? [`${missing.length} embedding targets are missing`] : []),
      ],
      String,
      "embedding diagnostics",
    ),
    compilerAuthority: false as const,
  });
}

export function encodeCatalogEmbeddingMatrix(input: {
  readonly sourceManifestHash: string;
  readonly embeddingSet: CatalogEmbeddingSet;
  readonly purpose: CatalogEmbeddingPurpose;
}): { readonly matrix: CatalogEmbeddingMatrix; readonly bytes: Uint8Array } {
  const set = CATALOG_EMBEDDING_SET_SCHEMA.parse(input.embeddingSet);
  const receipts = set.receipts.filter((entry) => entry.purpose === input.purpose);
  if (receipts.length === 0) throw new Error(`No ${input.purpose} embeddings are available`);
  const implementations = new Set(
    receipts.map((entry) =>
      stableJson([
        entry.modelImplementationHash,
        entry.preprocessingImplementationHash,
        entry.aggregationImplementationHash,
      ]),
    ),
  );
  if (implementations.size !== 1)
    throw new Error("An embedding matrix requires one exact implementation");
  const dimension = receipts[0]!.aggregate.values.length;
  if (receipts.some((entry) => entry.aggregate.values.length !== dimension))
    throw new Error("Embedding matrix vectors must have one dimension");
  const bytes = new Uint8Array(receipts.length * dimension * 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (const [rowIndex, receipt] of receipts.entries())
    for (const [columnIndex, value] of receipt.aggregate.values.entries())
      view.setInt16((rowIndex * dimension + columnIndex) * 2, value, true);
  const first = receipts[0]!;
  const blobHash = sha256(bytes);
  const matrix = sealArtifact(CATALOG_EMBEDDING_MATRIX_SCHEMA, {
    kind: "CatalogEmbeddingMatrix" as const,
    purpose: input.purpose,
    sourceManifestHash: input.sourceManifestHash,
    embeddingSetHash: set.hash,
    modelImplementationHash: first.modelImplementationHash,
    preprocessingImplementationHash: first.preprocessingImplementationHash,
    aggregationImplementationHash: first.aggregationImplementationHash,
    encoding: "int16_le_unit_vector" as const,
    dimension,
    rows: receipts.map((entry) => ({
      sourceContentHash: entry.sourceContentHash,
      scaleMillionths: entry.aggregate.scaleMillionths,
    })),
    blob: {
      kind: "embedding_matrix" as const,
      contentHash: blobHash,
      sizeBytes: bytes.byteLength,
      mediaType: "application/vnd.basalt.quantized-embedding-matrix" as const,
    },
    compilerAuthority: false as const,
  });
  return { matrix, bytes };
}

export function decodeCatalogEmbeddingMatrix(
  matrixInput: CatalogEmbeddingMatrix,
  bytes: Uint8Array,
): ReadonlyMap<string, CatalogQuantizedVector> {
  const matrix = CATALOG_EMBEDDING_MATRIX_SCHEMA.parse(matrixInput);
  if (bytes.byteLength !== matrix.blob.sizeBytes || sha256(bytes) !== matrix.blob.contentHash)
    throw new Error("Embedding matrix bytes do not match their descriptor");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return new Map(
    matrix.rows.map((row, rowIndex) => [
      row.sourceContentHash,
      {
        scaleMillionths: row.scaleMillionths,
        values: Array.from({ length: matrix.dimension }, (_, columnIndex) =>
          view.getInt16((rowIndex * matrix.dimension + columnIndex) * 2, true),
        ),
      },
    ]),
  );
}

export function sealCatalogQueryEmbeddingReceipt(
  input: Omit<CatalogQueryEmbeddingReceipt, "kind" | "purpose" | "compilerAuthority" | "hash">,
): CatalogQueryEmbeddingReceipt {
  return sealArtifact(CATALOG_QUERY_EMBEDDING_RECEIPT_SCHEMA, {
    kind: "CatalogQueryEmbeddingReceipt" as const,
    ...input,
    purpose: "image_text_retrieval" as const,
    compilerAuthority: false as const,
  });
}

/** Exact integer numerator proportional to the dequantized dot product. */
export function quantizedSimilarityNumerator(
  left: CatalogQuantizedVector,
  right: CatalogQuantizedVector,
): bigint {
  const a = CATALOG_QUANTIZED_VECTOR_SCHEMA.parse(left);
  const b = CATALOG_QUANTIZED_VECTOR_SCHEMA.parse(right);
  if (a.values.length !== b.values.length) throw new Error("Embedding dimensions differ");
  let dot = 0n;
  for (let index = 0; index < a.values.length; index += 1)
    dot += BigInt(a.values[index]!) * BigInt(b.values[index]!);
  return dot * BigInt(a.scaleMillionths) * BigInt(b.scaleMillionths);
}

export function embeddingQueryHash(text: string): string {
  return contentHash(stableJson({ kind: "CatalogEmbeddingQuery", text }));
}

function embeddingTargetIdentity(value: {
  readonly sourceContentHash: string;
  readonly purpose: CatalogEmbeddingPurpose;
}): string {
  return `${value.sourceContentHash}:${value.purpose}`;
}

function embeddingReceiptIdentity(value: CatalogEmbeddingReceipt): string {
  return embeddingTargetIdentity(value);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
