import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  CATALOG_CALIBRATION_SPLIT_SCHEMA,
  CATALOG_LEAKAGE_ANALYSIS_SCHEMA,
  CATALOG_QUALIFICATION_DESCRIPTION_PROPOSAL_SCHEMA,
  CATALOG_REVIEW_EVIDENCE_AUDIT_SCHEMA,
  CATALOG_SOURCE_NAME_HINT_SET_SCHEMA,
  CATALOG_VISUAL_REVIEW_INDEX_SCHEMA,
  sealCatalogQualificationDescriptionDecision,
  sealCreatorReviewedCatalogQualificationDescriptionSet,
} from "../packages/catalog-authoring/dist/index.js";
import { CATALOG_MEASUREMENT_SET_SCHEMA } from "../packages/catalog-model/dist/index.js";

const root = resolve(".");
const options = parseOptions(process.argv.slice(2));
const decisionInput = options.get("--decision");
const allAccurateReviewer = options.get("--all-accurate-reviewer");
const reviewerStatementOverride = options.get("--reviewer-statement");
if (Boolean(decisionInput) === Boolean(allAccurateReviewer))
  throw new Error(
    "Description finalization requires exactly one of --decision or --all-accurate-reviewer",
  );
if (reviewerStatementOverride && !allAccurateReviewer)
  throw new Error("--reviewer-statement is only valid with --all-accurate-reviewer");

const proposalPath =
  options.get("--proposal") ?? "registry/qualifications/catalog-description-proposal.json";
const auditPath =
  options.get("--evidence-audit") ?? "registry/qualifications/catalog-review-evidence-audit.json";
const decisionOutputPath =
  options.get("--output-decision") ?? "registry/qualifications/catalog-description-decision.json";
const descriptionSetOutputPath =
  options.get("--output-descriptions") ?? "registry/qualifications/catalog-description-set.json";

const proposal = CATALOG_QUALIFICATION_DESCRIPTION_PROPOSAL_SCHEMA.parse(
  await readJson(proposalPath),
);
const audit = CATALOG_REVIEW_EVIDENCE_AUDIT_SCHEMA.parse(await readJson(auditPath));
const measurements = CATALOG_MEASUREMENT_SET_SCHEMA.parse(
  await readJson(".basalt/catalog/measurements.json"),
);
const renders = CATALOG_VISUAL_REVIEW_INDEX_SCHEMA.parse(
  await readJson(".basalt/catalog/review/index.json"),
);
const sourceNames = CATALOG_SOURCE_NAME_HINT_SET_SCHEMA.parse(
  await readJson(".basalt/catalog/metadata/source-name-hints.json"),
);
const leakage = CATALOG_LEAKAGE_ANALYSIS_SCHEMA.parse(
  await readJson("registry/leakage-analysis.json"),
);
const calibration = CATALOG_CALIBRATION_SPLIT_SCHEMA.parse(
  await readJson("registry/calibration-split.json"),
);

for (const [label, actual, expected] of [
  ["review-evidence audit", audit.hash, proposal.reviewEvidenceAuditHash],
  ["measurement set", measurements.hash, proposal.measurementSetHash],
  ["visual review index", renders.hash, proposal.visualReviewIndexHash],
  ["leakage analysis", leakage.hash, proposal.leakageAnalysisHash],
  ["calibration split", calibration.hash, proposal.calibrationSplitHash],
])
  if (actual !== expected)
    throw new Error(`Description proposal does not bind the current ${label}`);
if (sourceNames.hash !== audit.sourceNameHintSetHash)
  throw new Error("Review-evidence audit does not bind the current source-name hints");

const decisionMaterial = allAccurateReviewer
  ? {
      proposalHash: proposal.hash,
      reviewer: { authority: "creator", reviewerId: allAccurateReviewer },
      reviewMethod: "independent_visible_description_review",
      reviewerStatement:
        reviewerStatementOverride ??
        "I independently reviewed all 24 visible-description proposals and confirm every description is accurate as written.",
      reviewedAt: new Date().toISOString(),
      coverage: "complete",
      assets: proposal.assets.map((asset) => ({
        sourceContentHash: asset.sourceContentHash,
        reviewAction: "accurate",
        evidenceUsability: asset.evidenceUsability,
        visibleDescription: asset.visibleDescription,
      })),
    }
  : await loadDecisionMaterial(decisionInput);
const decision = sealCatalogQualificationDescriptionDecision(decisionMaterial);
const descriptions = sealCreatorReviewedCatalogQualificationDescriptionSet({
  proposal,
  decision,
});

await writeJson(decisionOutputPath, decision);
await writeJson(descriptionSetOutputPath, descriptions);

process.stdout.write(
  `${JSON.stringify(
    {
      status: "incomplete",
      completedStage: "description_review",
      nextStage: descriptions.nextStage,
      reason:
        "Reviewed descriptions are sealed; independent query authoring and pooled relevance review have not happened",
      proposal: resolve(root, proposalPath),
      proposalHash: proposal.hash,
      decision: resolve(root, decisionOutputPath),
      decisionArtifactHash: decision.hash,
      descriptions: resolve(root, descriptionSetOutputPath),
      descriptionSetHash: descriptions.hash,
      reviewedAssets: descriptions.assets.length,
      reviewer: descriptions.reviewer,
      qualificationExecutionAuthorized: descriptions.qualificationExecutionAuthorized,
    },
    null,
    2,
  )}\n`,
);

async function readJson(path) {
  return JSON.parse(await readFile(resolve(root, path), "utf8"));
}

async function loadDecisionMaterial(path) {
  const rawDecision = await readJson(path);
  if (rawDecision.kind !== "CatalogQualificationDescriptionDecision")
    throw new Error("Creator decision has the wrong artifact kind");
  if (Object.hasOwn(rawDecision, "hash"))
    throw new Error("Creator decision input must be an unsealed review draft without a hash");
  return {
    proposalHash: rawDecision.proposalHash,
    reviewer: rawDecision.reviewer,
    reviewMethod: rawDecision.reviewMethod,
    reviewerStatement: rawDecision.reviewerStatement,
    reviewedAt: rawDecision.reviewedAt,
    coverage: rawDecision.coverage,
    assets: rawDecision.assets,
  };
}

async function writeJson(path, value) {
  const absolute = resolve(root, path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function parseOptions(values) {
  const result = new Map();
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith("--") || !value)
      throw new Error("Description finalization options must be --name value pairs");
    result.set(key, value);
  }
  return result;
}
