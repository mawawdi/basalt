import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { readBoundedWorkspaceBytes, writeCanonicalWorkspaceJson } from "@basalt/artifact-store";
import {
  CATALOG_AUTHORED_METADATA_BATCH_SCHEMA,
  CATALOG_AUTHORED_METADATA_REVIEW_SCHEMA,
  CATALOG_VISUAL_REVIEW_INDEX_SCHEMA,
  requireCurrentCatalogAuthoredMetadataEvidence,
  sealCatalogAuthoredMetadataReview,
  validateCatalogAuthoredMetadataReview,
} from "@basalt/catalog-authoring";
import { CATALOG_MEASUREMENT_SET_SCHEMA } from "@basalt/catalog-model";

const repositoryRoot = resolve(".");
const options = parseOptions(process.argv.slice(2));
const batchPath = requireOption("--batch");
const outputPath = requireOption("--output");
const reviewerId = requireOption("--all-accurate-reviewer");
const statement =
  options.get("--reviewer-statement") ??
  "I reviewed every bound visible description in this authored metadata batch and found every caption accurate as written. This decision covers visible descriptions only.";

const [batch, measurements, renders] = await Promise.all([
  readJson(batchPath).then((value) => CATALOG_AUTHORED_METADATA_BATCH_SCHEMA.parse(value)),
  readJson(options.get("--measurements") ?? ".basalt/catalog/measurements.json").then((value) =>
    CATALOG_MEASUREMENT_SET_SCHEMA.parse(value),
  ),
  readJson(options.get("--renders") ?? ".basalt/catalog/review/index.json").then((value) =>
    CATALOG_VISUAL_REVIEW_INDEX_SCHEMA.parse(value),
  ),
]);
requireCurrentCatalogAuthoredMetadataEvidence({ batch, measurements, renders });
if (batch.entries.some((entry) => entry.metadata.caption.status !== "observed"))
  throw new Error("An all-accurate visible-description review requires a caption for every entry");

const existing = await readOptionalReview(outputPath);
const review =
  existing ??
  sealCatalogAuthoredMetadataReview({
    batchHash: batch.hash,
    reviewer: { authority: "creator", actorId: reviewerId },
    reviewCoverage: "complete",
    reviewMethod: "direct_metadata_review",
    reviewScope: "visible_description_only",
    reviewIndependence:
      batch.producer.authority === "creator" && batch.producer.actorId === reviewerId
        ? "same_actor"
        : "independent",
    reviewerStatement: statement,
    reviewedAt: new Date().toISOString(),
    decisions: batch.entries.map((entry) => ({
      sourceContentHash: entry.sourceContentHash,
      action: "accept",
      note: "Creator confirmed the exact visible description as accurate.",
    })),
  });
validateExactAllAccurateReview({ batch, review, reviewerId });
if (!existing)
  await writeCanonicalWorkspaceJson(repositoryRoot, outputPath, review, {
    maxBytes: 16 * 1024 * 1024,
  });

process.stdout.write(
  `${JSON.stringify(
    {
      status: "reviewed",
      batchHash: batch.hash,
      review: resolve(repositoryRoot, outputPath),
      reviewArtifactHash: review.hash,
      reviewer: review.reviewer,
      reviewedEntries: review.decisions.length,
      reviewScope: review.reviewScope,
      reusedExistingDecision: existing !== undefined,
      qualificationExecutionAuthorized: false,
    },
    null,
    2,
  )}\n`,
);

function validateExactAllAccurateReview({ batch, review, reviewerId }) {
  validateCatalogAuthoredMetadataReview({ batch, review });
  if (
    review.reviewer.authority !== "creator" ||
    review.reviewer.actorId !== reviewerId ||
    review.reviewCoverage !== "complete" ||
    review.reviewMethod !== "direct_metadata_review" ||
    review.reviewScope !== "visible_description_only" ||
    review.decisions.length !== batch.entries.length ||
    review.decisions.some((decision) => decision.action !== "accept")
  )
    throw new Error("Existing authored metadata review is not this exact all-accurate decision");
}

async function readOptionalReview(path) {
  try {
    const value = JSON.parse(
      Buffer.from(await readBoundedWorkspaceBytes(repositoryRoot, path, 16 * 1024 * 1024)).toString(
        "utf8",
      ),
    );
    return CATALOG_AUTHORED_METADATA_REVIEW_SCHEMA.parse(value);
  } catch (error) {
    if (error instanceof Error && error.message.includes("missing")) return undefined;
    throw error;
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(resolve(repositoryRoot, path), "utf8"));
}

function requireOption(name) {
  const value = options.get(name);
  if (!value) throw new Error(`Missing required option ${name}`);
  return value;
}

function parseOptions(values) {
  const result = new Map();
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith("--") || !value || value.startsWith("--"))
      throw new Error(`Malformed option near ${key ?? "end of command"}`);
    if (result.has(key)) throw new Error(`Option is repeated: ${key}`);
    result.set(key, value);
  }
  return result;
}
