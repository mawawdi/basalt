import { z } from "zod";
import { HASH_SCHEMA } from "@basalt/contracts";
import {
  CATALOG_SEARCH_METADATA_SCHEMA,
  CATALOG_SEARCH_METADATA_SET_SCHEMA,
  type CatalogSearchMetadata,
  type CatalogSearchMetadataSet,
} from "./metadata.js";
import {
  CATALOG_QUALIFICATION_REPORT_SCHEMA,
  type CatalogQualificationReport,
} from "./qualification.js";
import {
  canonicalValues,
  requireCanonicalValues,
  sealArtifact,
  verifyArtifactHash,
} from "./artifact.js";

const MODEL_COMMIT_SCHEMA = z.string().regex(/^[a-f0-9]{40,64}$/u);

export const CATALOG_SEARCH_METADATA_RECORD_SCHEMA = z
  .object({
    sourceContentHash: HASH_SCHEMA,
    metadataReceiptHash: HASH_SCHEMA,
    measurementHash: HASH_SCHEMA,
    renderEvidenceHash: HASH_SCHEMA,
    sourceNameHintHash: HASH_SCHEMA.optional(),
    modelId: z.string().trim().min(1).max(256),
    modelCommitHash: MODEL_COMMIT_SCHEMA,
    metadata: CATALOG_SEARCH_METADATA_SCHEMA,
  })
  .strict();
export type CatalogSearchMetadataRecord = z.output<typeof CATALOG_SEARCH_METADATA_RECORD_SCHEMA>;

export const CATALOG_SEARCH_METADATA_SHARD_SCHEMA = z
  .object({
    kind: z.literal("CatalogSearchMetadataShard"),
    prefix: z.string().regex(/^[a-f0-9]{2}$/u),
    records: z.array(CATALOG_SEARCH_METADATA_RECORD_SCHEMA).min(1),
    compilerAuthority: z.literal(false),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyArtifactHash(value, context);
    requireCanonicalValues(
      value.records,
      (entry) => entry.sourceContentHash,
      "metadata shard records",
      context,
    );
    if (value.records.some((entry) => !entry.sourceContentHash.startsWith(value.prefix)))
      context.addIssue({
        code: "custom",
        path: ["records"],
        message: "Metadata shard contains a source outside its hash prefix",
      });
  });
export type CatalogSearchMetadataShard = z.output<typeof CATALOG_SEARCH_METADATA_SHARD_SCHEMA>;

const SHARD_DESCRIPTOR_SCHEMA = z
  .object({
    prefix: z.string().regex(/^[a-f0-9]{2}$/u),
    relativePath: z
      .string()
      .regex(/^registry\/evidence\/catalog-search-metadata\/[a-f0-9]{2}\.json$/u),
    artifactHash: HASH_SCHEMA,
    bytesHash: HASH_SCHEMA,
    bytes: z.number().int().positive().safe(),
    recordCount: z.number().int().positive().safe(),
  })
  .strict();

export const CATALOG_SEARCH_REGISTRY_SCHEMA = z
  .object({
    kind: z.literal("CatalogSearchRegistry"),
    status: z.literal("eligible"),
    sourceManifestHash: HASH_SCHEMA,
    metadataSetHash: HASH_SCHEMA,
    qualificationReportHash: HASH_SCHEMA,
    modelRolePolicyHash: HASH_SCHEMA,
    promptTemplateHash: HASH_SCHEMA,
    metadataSchemaHash: HASH_SCHEMA,
    writerModelId: z.string().trim().min(1).max(256),
    writerModelCommitHash: MODEL_COMMIT_SCHEMA,
    writerViewSet: z.enum(["canonical_twelve", "cardinal_four"]),
    recordCount: z.number().int().positive().safe(),
    shards: z.array(SHARD_DESCRIPTOR_SCHEMA).min(1),
    binaryPayloadPolicy: z.literal("local_content_addressed"),
    compilerAuthority: z.literal(false),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyArtifactHash(value, context);
    requireCanonicalValues(
      value.shards,
      (entry) => entry.prefix,
      "metadata shard descriptors",
      context,
    );
    if (value.shards.reduce((sum, entry) => sum + entry.recordCount, 0) !== value.recordCount)
      context.addIssue({
        code: "custom",
        path: ["recordCount"],
        message: "Search registry record count does not match its shards",
      });
  });
export type CatalogSearchRegistry = z.output<typeof CATALOG_SEARCH_REGISTRY_SCHEMA>;

export function buildCatalogSearchMetadataShards(input: {
  readonly metadata: CatalogSearchMetadataSet;
  readonly modelId: string;
  readonly modelCommitHash: string;
}): readonly CatalogSearchMetadataShard[] {
  const metadata = CATALOG_SEARCH_METADATA_SET_SCHEMA.parse(input.metadata);
  if (metadata.status !== "eligible")
    throw new Error("Only a complete metadata set can be committed");
  const groups = new Map<string, CatalogSearchMetadataRecord[]>();
  for (const receipt of metadata.receipts) {
    if (
      receipt.status !== "eligible" ||
      !receipt.metadata ||
      receipt.modelId !== input.modelId ||
      receipt.modelCommitHash !== input.modelCommitHash
    )
      continue;
    const prefix = receipt.sourceContentHash.slice(0, 2);
    const records = groups.get(prefix) ?? [];
    records.push({
      sourceContentHash: receipt.sourceContentHash,
      metadataReceiptHash: receipt.hash,
      measurementHash: receipt.measurementHash,
      renderEvidenceHash: receipt.renderEvidenceHash,
      ...(receipt.sourceNameHintHash ? { sourceNameHintHash: receipt.sourceNameHintHash } : {}),
      modelId: receipt.modelId,
      modelCommitHash: receipt.modelCommitHash,
      metadata: receipt.metadata,
    });
    groups.set(prefix, records);
  }
  if (groups.size === 0)
    throw new Error("Metadata set contains no receipts from the selected model");
  return [...groups]
    .map(([prefix, records]) =>
      sealArtifact(CATALOG_SEARCH_METADATA_SHARD_SCHEMA, {
        kind: "CatalogSearchMetadataShard" as const,
        prefix,
        records: canonicalValues(
          records,
          (entry) => entry.sourceContentHash,
          "metadata shard records",
        ),
        compilerAuthority: false as const,
      }),
    )
    .sort((left, right) => (left.prefix < right.prefix ? -1 : left.prefix > right.prefix ? 1 : 0));
}

export function sealCatalogSearchRegistry(input: {
  readonly sourceManifestHash: string;
  readonly metadata: CatalogSearchMetadataSet;
  readonly qualification: CatalogQualificationReport;
  readonly modelRolePolicyHash: string;
  readonly promptTemplateHash: string;
  readonly metadataSchemaHash: string;
  readonly writerModelId: string;
  readonly writerModelCommitHash: string;
  readonly writerViewSet: "canonical_twelve" | "cardinal_four";
  readonly shards: readonly {
    prefix: string;
    relativePath: string;
    artifactHash: string;
    bytesHash: string;
    bytes: number;
    recordCount: number;
  }[];
}): CatalogSearchRegistry {
  const metadata = CATALOG_SEARCH_METADATA_SET_SCHEMA.parse(input.metadata);
  const qualification = CATALOG_QUALIFICATION_REPORT_SCHEMA.parse(input.qualification);
  if (metadata.status !== "eligible" || qualification.status !== "eligible")
    throw new Error("Search metadata requires an eligible metadata set and qualification report");
  if (
    qualification.selectedWriterModelId !== input.writerModelId ||
    qualification.selectedWriterViewSet !== input.writerViewSet
  )
    throw new Error("Search registry inputs bind different writer evidence");
  return sealArtifact(CATALOG_SEARCH_REGISTRY_SCHEMA, {
    kind: "CatalogSearchRegistry" as const,
    status: "eligible" as const,
    sourceManifestHash: input.sourceManifestHash,
    metadataSetHash: metadata.hash,
    qualificationReportHash: qualification.hash,
    modelRolePolicyHash: input.modelRolePolicyHash,
    promptTemplateHash: input.promptTemplateHash,
    metadataSchemaHash: input.metadataSchemaHash,
    writerModelId: input.writerModelId,
    writerModelCommitHash: input.writerModelCommitHash,
    writerViewSet: input.writerViewSet,
    recordCount: input.shards.reduce((sum, entry) => sum + entry.recordCount, 0),
    shards: canonicalValues(input.shards, (entry) => entry.prefix, "metadata shard descriptors"),
    binaryPayloadPolicy: "local_content_addressed" as const,
    compilerAuthority: false as const,
  });
}

export function metadataRecordIdentity(record: CatalogSearchMetadataRecord): string {
  return record.sourceContentHash;
}

export function validateStoredMetadata(record: CatalogSearchMetadataRecord): CatalogSearchMetadata {
  return CATALOG_SEARCH_METADATA_RECORD_SCHEMA.parse(record).metadata;
}
