import { z } from "zod";
import { CATALOG_MEASUREMENT_SET_SCHEMA, type CatalogMeasurementSet } from "@basalt/catalog-model";
import { ASCII_ID_SCHEMA, HASH_SCHEMA, stableJson } from "@basalt/contracts";
import {
  CATALOG_SEARCH_METADATA_SCHEMA,
  sealCatalogSearchMetadata,
  type CatalogSearchMetadata,
} from "./metadata.js";
import { CATALOG_VISUAL_REVIEW_INDEX_SCHEMA, type CatalogVisualReviewIndex } from "./render.js";
import {
  canonicalValues,
  requireCanonicalValues,
  sealArtifact,
  verifyArtifactHash,
} from "./artifact.js";

export const CATALOG_METADATA_AUTHORITIES = ["creator", "delegated_ai"] as const;
export const CATALOG_METADATA_AUTHORITY_SCHEMA = z.enum(CATALOG_METADATA_AUTHORITIES);

const AUTHOR_SCHEMA = z
  .object({
    authority: CATALOG_METADATA_AUTHORITY_SCHEMA,
    actorId: z.string().trim().min(1).max(160),
  })
  .strict();

export const CATALOG_AUTHORED_METADATA_CERTAINTY_SCHEMA = z.discriminatedUnion("status", [
  z.object({ status: z.literal("concrete") }).strict(),
  z
    .object({
      status: z.literal("uncertain"),
      reason: z.string().trim().min(16).max(2_048),
    })
    .strict(),
]);
export type CatalogAuthoredMetadataCertainty = z.output<
  typeof CATALOG_AUTHORED_METADATA_CERTAINTY_SCHEMA
>;

const AUTHORED_METADATA_BATCH_ENTRY_SCHEMA = z
  .object({
    sourceContentHash: HASH_SCHEMA,
    measurementHash: HASH_SCHEMA,
    renderEvidenceHash: HASH_SCHEMA,
    authoringCertainty: CATALOG_AUTHORED_METADATA_CERTAINTY_SCHEMA,
    metadata: CATALOG_SEARCH_METADATA_SCHEMA,
  })
  .strict();

export const CATALOG_AUTHORED_METADATA_BATCH_SCHEMA = z
  .object({
    kind: z.literal("CatalogAuthoredMetadataBatch"),
    batchId: ASCII_ID_SCHEMA,
    sourceManifestHash: HASH_SCHEMA,
    measurementSetHash: HASH_SCHEMA,
    visualReviewIndexHash: HASH_SCHEMA,
    producer: AUTHOR_SCHEMA,
    authoringMethod: z.literal("bound_visual_and_measurement_authoring"),
    sourceArtifactHashes: z.array(HASH_SCHEMA),
    entries: z.array(AUTHORED_METADATA_BATCH_ENTRY_SCHEMA).min(1),
    compilerAuthority: z.literal(false),
    qualificationExecutionAuthorized: z.literal(false),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyArtifactHash(value, context);
    requireCanonicalValues(
      value.sourceArtifactHashes,
      String,
      "metadata source artifacts",
      context,
    );
    requireCanonicalValues(
      value.entries,
      (entry) => entry.sourceContentHash,
      "authored metadata entries",
      context,
    );
  });
export type CatalogAuthoredMetadataBatch = z.output<typeof CATALOG_AUTHORED_METADATA_BATCH_SCHEMA>;

const AUTHORED_METADATA_REVIEW_DECISION_SCHEMA = z.discriminatedUnion("action", [
  z
    .object({
      sourceContentHash: HASH_SCHEMA,
      action: z.literal("accept"),
      note: z.string().trim().min(1).max(2_048),
    })
    .strict(),
  z
    .object({
      sourceContentHash: HASH_SCHEMA,
      action: z.literal("revise"),
      metadata: CATALOG_SEARCH_METADATA_SCHEMA,
      authoringCertainty: CATALOG_AUTHORED_METADATA_CERTAINTY_SCHEMA,
      note: z.string().trim().min(1).max(2_048),
    })
    .strict(),
  z
    .object({
      sourceContentHash: HASH_SCHEMA,
      action: z.literal("uncertain"),
      reason: z.string().trim().min(16).max(2_048),
    })
    .strict(),
  z
    .object({
      sourceContentHash: HASH_SCHEMA,
      action: z.literal("reject"),
      reason: z.string().trim().min(16).max(2_048),
    })
    .strict(),
]);

export const CATALOG_AUTHORED_METADATA_REVIEW_SCHEMA = z
  .object({
    kind: z.literal("CatalogAuthoredMetadataReview"),
    batchHash: HASH_SCHEMA,
    reviewer: AUTHOR_SCHEMA,
    reviewCoverage: z.enum(["complete", "uncertainty_and_sample"]),
    reviewMethod: z.enum(["direct_metadata_review", "imported_visible_description_review"]),
    reviewScope: z.enum(["complete_metadata", "visible_description_only"]),
    reviewIndependence: z.enum(["independent", "same_actor"]),
    basisArtifactHash: HASH_SCHEMA.optional(),
    reviewerStatement: z.string().trim().min(32).max(2_048),
    reviewedAt: z.string().datetime({ offset: true }),
    decisions: z.array(AUTHORED_METADATA_REVIEW_DECISION_SCHEMA).min(1),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyArtifactHash(value, context);
    requireCanonicalValues(
      value.decisions,
      (entry) => entry.sourceContentHash,
      "authored metadata review decisions",
      context,
    );
    if (
      (value.reviewMethod === "imported_visible_description_review") !==
      (value.basisArtifactHash !== undefined)
    )
      context.addIssue({
        code: "custom",
        path: ["basisArtifactHash"],
        message: "Imported review must bind exactly one source decision artifact",
      });
    if (
      value.reviewMethod === "imported_visible_description_review" &&
      value.reviewScope !== "visible_description_only"
    )
      context.addIssue({
        code: "custom",
        path: ["reviewScope"],
        message: "Imported description review can approve only the visible-description field",
      });
  });
export type CatalogAuthoredMetadataReview = z.output<
  typeof CATALOG_AUTHORED_METADATA_REVIEW_SCHEMA
>;

const RECORD_REVIEW_SCHEMA = z.discriminatedUnion("status", [
  z.object({ status: z.literal("unreviewed") }).strict(),
  z
    .object({
      status: z.enum(["accepted", "revised", "uncertain"]),
      decisionArtifactHash: HASH_SCHEMA,
      reviewer: AUTHOR_SCHEMA,
      reviewMethod: z.enum(["direct_metadata_review", "imported_visible_description_review"]),
      reviewScope: z.enum(["complete_metadata", "visible_description_only"]),
      reviewIndependence: z.enum(["independent", "same_actor"]),
      note: z.string().trim().min(1).max(2_048),
    })
    .strict(),
]);

export const CATALOG_AUTHORED_SEARCH_METADATA_RECORD_SCHEMA = z
  .object({
    kind: z.literal("CatalogAuthoredSearchMetadataRecord"),
    sourceContentHash: HASH_SCHEMA,
    measurementHash: HASH_SCHEMA,
    renderEvidenceHash: HASH_SCHEMA,
    batchHash: HASH_SCHEMA,
    producer: AUTHOR_SCHEMA,
    authoringCertainty: CATALOG_AUTHORED_METADATA_CERTAINTY_SCHEMA,
    review: RECORD_REVIEW_SCHEMA,
    metadata: CATALOG_SEARCH_METADATA_SCHEMA,
    compilerAuthority: z.literal(false),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => verifyArtifactHash(value, context));
export type CatalogAuthoredSearchMetadataRecord = z.output<
  typeof CATALOG_AUTHORED_SEARCH_METADATA_RECORD_SCHEMA
>;

export const CATALOG_AUTHORED_SEARCH_METADATA_SET_SCHEMA = z
  .object({
    kind: z.literal("CatalogAuthoredSearchMetadataSet"),
    status: z.literal("searchable"),
    batchId: ASCII_ID_SCHEMA,
    batchHash: HASH_SCHEMA,
    reviewArtifactHash: HASH_SCHEMA.optional(),
    sourceManifestHash: HASH_SCHEMA,
    measurementSetHash: HASH_SCHEMA,
    visualReviewIndexHash: HASH_SCHEMA,
    producer: AUTHOR_SCHEMA,
    reviewCoverage: z.enum(["none", "complete", "uncertainty_and_sample"]),
    records: z.array(CATALOG_AUTHORED_SEARCH_METADATA_RECORD_SCHEMA).min(1),
    rejectedSourceContentHashes: z.array(HASH_SCHEMA),
    compilerAuthority: z.literal(false),
    qualificationExecutionAuthorized: z.literal(false),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyArtifactHash(value, context);
    requireCanonicalValues(
      value.records,
      (entry) => entry.sourceContentHash,
      "authored search metadata records",
      context,
    );
    requireCanonicalValues(
      value.rejectedSourceContentHashes,
      String,
      "rejected authored metadata sources",
      context,
    );
    const recordSources = new Set(value.records.map((entry) => entry.sourceContentHash));
    if (value.rejectedSourceContentHashes.some((entry) => recordSources.has(entry)))
      context.addIssue({
        code: "custom",
        path: ["rejectedSourceContentHashes"],
        message: "An authored metadata source cannot be both searchable and rejected",
      });
    if ((value.reviewCoverage === "none") !== (value.reviewArtifactHash === undefined))
      context.addIssue({
        code: "custom",
        path: ["reviewArtifactHash"],
        message: "Review coverage and review artifact presence must agree",
      });
    for (const [index, record] of value.records.entries()) {
      if (
        record.batchHash !== value.batchHash ||
        stableJson(record.producer) !== stableJson(value.producer)
      )
        context.addIssue({
          code: "custom",
          path: ["records", index],
          message: "Authored metadata record does not bind its containing batch and producer",
        });
      if (
        value.reviewArtifactHash !== undefined &&
        record.review.status !== "unreviewed" &&
        record.review.decisionArtifactHash !== value.reviewArtifactHash
      )
        context.addIssue({
          code: "custom",
          path: ["records", index, "review"],
          message: "Authored metadata record binds a different review artifact",
        });
    }
    if (
      value.reviewCoverage === "none" &&
      value.records.some((entry) => entry.review.status !== "unreviewed")
    )
      context.addIssue({
        code: "custom",
        path: ["records"],
        message: "An unreviewed metadata set cannot contain reviewed records",
      });
    if (
      value.reviewCoverage === "complete" &&
      value.records.some((entry) => entry.review.status === "unreviewed")
    )
      context.addIssue({
        code: "custom",
        path: ["records"],
        message: "A complete metadata review cannot leave searchable records unreviewed",
      });
  });
export type CatalogAuthoredSearchMetadataSet = z.output<
  typeof CATALOG_AUTHORED_SEARCH_METADATA_SET_SCHEMA
>;

const AUTHORED_METADATA_SET_RELATIVE_PATH_SCHEMA = z
  .string()
  .regex(/^\.basalt\/catalog\/metadata\/[A-Za-z0-9._/-]+\.json$/u)
  .refine(
    (value) =>
      value
        .split("/")
        .every((segment) => segment.length > 0 && segment !== "." && segment !== ".."),
    "Authored metadata set paths cannot traverse directories",
  );

const AUTHORED_METADATA_SET_REFERENCE_SCHEMA = z
  .object({
    relativePath: AUTHORED_METADATA_SET_RELATIVE_PATH_SCHEMA,
    setHash: HASH_SCHEMA,
  })
  .strict();

export const CATALOG_AUTHORED_METADATA_SET_MANIFEST_SCHEMA = z
  .object({
    kind: z.literal("CatalogAuthoredMetadataSetManifest"),
    sets: z.array(AUTHORED_METADATA_SET_REFERENCE_SCHEMA),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyArtifactHash(value, context);
    requireCanonicalValues(
      value.sets,
      (entry) => entry.relativePath,
      "authored metadata set references",
      context,
    );
    if (new Set(value.sets.map((entry) => entry.setHash)).size !== value.sets.length)
      context.addIssue({
        code: "custom",
        path: ["sets"],
        message: "An authored metadata set cannot be registered at multiple paths",
      });
  });
export type CatalogAuthoredMetadataSetManifest = z.output<
  typeof CATALOG_AUTHORED_METADATA_SET_MANIFEST_SCHEMA
>;

export function sealCatalogAuthoredMetadataSetManifest(input: {
  readonly sets: readonly CatalogAuthoredMetadataSetManifest["sets"][number][];
}): CatalogAuthoredMetadataSetManifest {
  return sealArtifact(CATALOG_AUTHORED_METADATA_SET_MANIFEST_SCHEMA, {
    kind: "CatalogAuthoredMetadataSetManifest" as const,
    sets: canonicalValues(
      input.sets,
      (entry) => entry.relativePath,
      "authored metadata set references",
    ),
  });
}

export function sealCatalogAuthoredMetadataBatch(input: {
  readonly batchId: string;
  readonly sourceManifestHash: string;
  readonly measurementSetHash: string;
  readonly visualReviewIndexHash: string;
  readonly producer: CatalogAuthoredMetadataBatch["producer"];
  readonly sourceArtifactHashes?: readonly string[];
  readonly entries: readonly {
    readonly sourceContentHash: string;
    readonly measurementHash: string;
    readonly renderEvidenceHash: string;
    readonly authoringCertainty: CatalogAuthoredMetadataCertainty;
    readonly metadata: CatalogSearchMetadata;
  }[];
}): CatalogAuthoredMetadataBatch {
  return sealArtifact(CATALOG_AUTHORED_METADATA_BATCH_SCHEMA, {
    kind: "CatalogAuthoredMetadataBatch" as const,
    batchId: input.batchId,
    sourceManifestHash: input.sourceManifestHash,
    measurementSetHash: input.measurementSetHash,
    visualReviewIndexHash: input.visualReviewIndexHash,
    producer: input.producer,
    authoringMethod: "bound_visual_and_measurement_authoring" as const,
    sourceArtifactHashes: canonicalValues(
      input.sourceArtifactHashes ?? [],
      String,
      "metadata source artifacts",
    ),
    entries: canonicalValues(
      input.entries.map((entry) => ({
        ...entry,
        metadata: sealCatalogSearchMetadata(entry.metadata),
      })),
      (entry) => entry.sourceContentHash,
      "authored metadata entries",
    ),
    compilerAuthority: false as const,
    qualificationExecutionAuthorized: false as const,
  });
}

export function sealCatalogAuthoredMetadataReview(
  input: Omit<CatalogAuthoredMetadataReview, "kind" | "hash">,
): CatalogAuthoredMetadataReview {
  return sealArtifact(CATALOG_AUTHORED_METADATA_REVIEW_SCHEMA, {
    kind: "CatalogAuthoredMetadataReview" as const,
    ...input,
    decisions: canonicalValues(
      input.decisions,
      (entry) => entry.sourceContentHash,
      "authored metadata review decisions",
    ),
  });
}

export function validateCatalogAuthoredMetadataReview(input: {
  readonly batch: CatalogAuthoredMetadataBatch;
  readonly review: CatalogAuthoredMetadataReview;
}): void {
  const batch = CATALOG_AUTHORED_METADATA_BATCH_SCHEMA.parse(input.batch);
  const review = CATALOG_AUTHORED_METADATA_REVIEW_SCHEMA.parse(input.review);
  if (review.batchHash !== batch.hash)
    throw new Error("Authored metadata review does not bind the exact batch");
  const producerMatchesReviewer =
    batch.producer.authority === review.reviewer.authority &&
    batch.producer.actorId === review.reviewer.actorId;
  if ((review.reviewIndependence === "same_actor") !== producerMatchesReviewer)
    throw new Error("Authored metadata review independence does not match its actors");
  const entries = new Map(batch.entries.map((entry) => [entry.sourceContentHash, entry] as const));
  for (const decision of review.decisions)
    if (!entries.has(decision.sourceContentHash))
      throw new Error(
        `Authored metadata review names an unproposed source ${decision.sourceContentHash}`,
      );
  const reviewedSources = review.decisions.map((entry) => entry.sourceContentHash);
  const batchSources = batch.entries.map((entry) => entry.sourceContentHash);
  if (
    review.reviewCoverage === "complete" &&
    stableJson(reviewedSources) !== stableJson(batchSources)
  )
    throw new Error("Complete authored metadata review must cover the exact batch identities");
  if (review.reviewCoverage === "uncertainty_and_sample") {
    const reviewed = new Set(reviewedSources);
    const uncertain = batch.entries
      .filter((entry) => entry.authoringCertainty.status === "uncertain")
      .map((entry) => entry.sourceContentHash);
    if (uncertain.some((entry) => !reviewed.has(entry)))
      throw new Error("Targeted metadata review must cover every uncertain authored result");
    const concrete = batch.entries.filter(
      (entry) => entry.authoringCertainty.status === "concrete",
    );
    if (concrete.length > 0 && !concrete.some((entry) => reviewed.has(entry.sourceContentHash)))
      throw new Error("Targeted metadata review must include at least one concrete audit sample");
  }
}

export function sealCatalogAuthoredSearchMetadataSet(input: {
  readonly batch: CatalogAuthoredMetadataBatch;
  readonly review?: CatalogAuthoredMetadataReview;
}): CatalogAuthoredSearchMetadataSet {
  const batch = CATALOG_AUTHORED_METADATA_BATCH_SCHEMA.parse(input.batch);
  const review = input.review
    ? CATALOG_AUTHORED_METADATA_REVIEW_SCHEMA.parse(input.review)
    : undefined;
  if (review) validateCatalogAuthoredMetadataReview({ batch, review });
  const decisions = new Map(
    (review?.decisions ?? []).map((entry) => [entry.sourceContentHash, entry] as const),
  );
  const records: CatalogAuthoredSearchMetadataRecord[] = [];
  const rejectedSourceContentHashes: string[] = [];
  for (const entry of batch.entries) {
    const decision = decisions.get(entry.sourceContentHash);
    if (decision?.action === "reject") {
      rejectedSourceContentHashes.push(entry.sourceContentHash);
      continue;
    }
    const metadata =
      decision?.action === "revise" ? sealCatalogSearchMetadata(decision.metadata) : entry.metadata;
    const authoringCertainty =
      decision?.action === "revise"
        ? decision.authoringCertainty
        : decision?.action === "uncertain"
          ? ({ status: "uncertain", reason: decision.reason } as const)
          : entry.authoringCertainty;
    const recordReview: CatalogAuthoredSearchMetadataRecord["review"] =
      !review || !decision
        ? { status: "unreviewed" }
        : {
            status:
              decision.action === "revise"
                ? "revised"
                : decision.action === "uncertain"
                  ? "uncertain"
                  : "accepted",
            decisionArtifactHash: review.hash,
            reviewer: review.reviewer,
            reviewMethod: review.reviewMethod,
            reviewScope: review.reviewScope,
            reviewIndependence: review.reviewIndependence,
            note:
              decision.action === "uncertain"
                ? decision.reason
                : decision.action === "accept" || decision.action === "revise"
                  ? decision.note
                  : "Rejected entries are not searchable",
          };
    records.push(
      sealArtifact(CATALOG_AUTHORED_SEARCH_METADATA_RECORD_SCHEMA, {
        kind: "CatalogAuthoredSearchMetadataRecord" as const,
        sourceContentHash: entry.sourceContentHash,
        measurementHash: entry.measurementHash,
        renderEvidenceHash: entry.renderEvidenceHash,
        batchHash: batch.hash,
        producer: batch.producer,
        authoringCertainty,
        review: recordReview,
        metadata,
        compilerAuthority: false as const,
      }),
    );
  }
  return sealArtifact(CATALOG_AUTHORED_SEARCH_METADATA_SET_SCHEMA, {
    kind: "CatalogAuthoredSearchMetadataSet" as const,
    status: "searchable" as const,
    batchId: batch.batchId,
    batchHash: batch.hash,
    ...(review ? { reviewArtifactHash: review.hash } : {}),
    sourceManifestHash: batch.sourceManifestHash,
    measurementSetHash: batch.measurementSetHash,
    visualReviewIndexHash: batch.visualReviewIndexHash,
    producer: batch.producer,
    reviewCoverage: review?.reviewCoverage ?? ("none" as const),
    records: canonicalValues(
      records,
      (entry) => entry.sourceContentHash,
      "authored search metadata records",
    ),
    rejectedSourceContentHashes: canonicalValues(
      rejectedSourceContentHashes,
      String,
      "rejected authored metadata sources",
    ),
    compilerAuthority: false as const,
    qualificationExecutionAuthorized: false as const,
  });
}

export function requireCurrentCatalogAuthoredMetadataEvidence(input: {
  readonly batch: CatalogAuthoredMetadataBatch;
  readonly measurements: CatalogMeasurementSet;
  readonly renders: CatalogVisualReviewIndex;
}): void {
  const batch = CATALOG_AUTHORED_METADATA_BATCH_SCHEMA.parse(input.batch);
  const measurements = CATALOG_MEASUREMENT_SET_SCHEMA.parse(input.measurements);
  const renders = CATALOG_VISUAL_REVIEW_INDEX_SCHEMA.parse(input.renders);
  if (
    batch.sourceManifestHash !== measurements.sourceManifestHash ||
    batch.sourceManifestHash !== renders.sourceManifestHash ||
    batch.measurementSetHash !== measurements.hash ||
    batch.visualReviewIndexHash !== renders.hash
  )
    throw new Error("Authored metadata batch binds stale corpus evidence");
  const measurementBySource = new Map(
    measurements.assets.map((entry) => [entry.source.contentHash, entry.hash] as const),
  );
  const renderBySource = new Map(
    renders.items.map((entry) => [entry.sourceContentHash, entry.evidence.hash] as const),
  );
  for (const entry of batch.entries)
    if (
      measurementBySource.get(entry.sourceContentHash) !== entry.measurementHash ||
      renderBySource.get(entry.sourceContentHash) !== entry.renderEvidenceHash
    )
      throw new Error(`Authored metadata evidence is stale for ${entry.sourceContentHash}`);
}
