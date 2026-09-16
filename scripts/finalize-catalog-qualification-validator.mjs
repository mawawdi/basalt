import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  CATALOG_QUALIFICATION_DEVELOPMENT_VALIDATOR_CASE_SET_SCHEMA,
  requireCatalogQualificationDevelopmentValidatorDecision,
  requireReviewedCatalogQualificationDevelopmentValidatorVerdictSet,
  sealCatalogQualificationDevelopmentValidatorDecision,
  sealReviewedCatalogQualificationDevelopmentValidatorVerdictSet,
} from "../packages/catalog-authoring/dist/index.js";

const root = resolve(".");
const options = parseOptions(process.argv.slice(2));
const decisionInput = options.get("--decision");
if (!decisionInput) throw new Error("Validator finalization requires --decision <downloaded-json>");
const caseSetPath =
  options.get("--cases") ?? "registry/qualifications/catalog-development-validator-case-set.json";
const decisionOutputPath =
  options.get("--output-decision") ??
  "registry/qualifications/catalog-development-validator-decision.json";
const verdictOutputPath =
  options.get("--output-verdicts") ??
  "registry/qualifications/catalog-development-validator-verdict-set.json";

const caseSet = CATALOG_QUALIFICATION_DEVELOPMENT_VALIDATOR_CASE_SET_SCHEMA.parse(
  await readJson(caseSetPath),
);
const rawDecision = await readJson(decisionInput);
if (rawDecision.kind !== "CatalogQualificationDevelopmentValidatorDecision")
  throw new Error("Validator decision has the wrong artifact kind");
if (Object.hasOwn(rawDecision, "hash"))
  throw new Error("Validator decision input must be an unsealed review draft");
const decision = sealCatalogQualificationDevelopmentValidatorDecision({
  caseSetHash: rawDecision.caseSetHash,
  relevanceDecisionHash: rawDecision.relevanceDecisionHash,
  reviewer: rawDecision.reviewer,
  reviewMethod: rawDecision.reviewMethod,
  reviewerStatement: rawDecision.reviewerStatement,
  reviewedAt: rawDecision.reviewedAt,
  coverage: rawDecision.coverage,
  cases: rawDecision.cases,
});
requireCatalogQualificationDevelopmentValidatorDecision({ caseSet, decision });
await writeJson(decisionOutputPath, decision);

let verdictSet;
if (decision.status === "reviewed") {
  verdictSet = sealReviewedCatalogQualificationDevelopmentValidatorVerdictSet({
    caseSet,
    decision,
  });
  requireReviewedCatalogQualificationDevelopmentValidatorVerdictSet({
    caseSet,
    decision,
    verdictSet,
  });
  await writeJson(verdictOutputPath, verdictSet);
}

process.stdout.write(
  `${JSON.stringify(
    {
      status: decision.status,
      completedStage: "independent_validator_verdict_review",
      nextStage: decision.nextStage,
      decision: resolve(root, decisionOutputPath),
      decisionArtifactHash: decision.hash,
      ...(verdictSet
        ? {
            verdictSet: resolve(root, verdictOutputPath),
            verdictSetHash: verdictSet.hash,
            verdictCounts: verdictSet.verdictCounts,
          }
        : {}),
      qualificationExecutionAuthorized: decision.qualificationExecutionAuthorized,
    },
    null,
    2,
  )}\n`,
);

async function readJson(path) {
  return JSON.parse(await readFile(resolve(root, path), "utf8"));
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
    if (!key?.startsWith("--") || !value || value.startsWith("--"))
      throw new Error(`Invalid option near ${key ?? "end of input"}`);
    result.set(key, value);
  }
  return result;
}
