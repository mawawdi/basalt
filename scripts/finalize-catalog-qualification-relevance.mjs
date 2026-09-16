import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  CATALOG_QUALIFICATION_DEVELOPMENT_CANDIDATE_POOL_SCHEMA,
  CATALOG_QUALIFICATION_DEVELOPMENT_QUERY_SET_SCHEMA,
  CATALOG_SEARCH_RESULT_SET_SCHEMA,
  requireCatalogQualificationDevelopmentCandidatePool,
  requireCatalogQualificationDevelopmentRelevanceDecision,
  sealCatalogQualificationDevelopmentRelevanceDecision,
} from "../packages/catalog-authoring/dist/index.js";

const root = resolve(".");
const options = parseOptions(process.argv.slice(2));
const decisionInput = options.get("--decision");
if (!decisionInput) throw new Error("Relevance finalization requires --decision <downloaded-json>");

const queryPath =
  options.get("--queries") ?? "registry/qualifications/catalog-development-query-set.json";
const poolPath =
  options.get("--pool") ?? ".basalt/catalog/qualification/development/candidate-pool.json";
const outputPath =
  options.get("--output") ?? "registry/qualifications/catalog-development-relevance-decision.json";

const queries = CATALOG_QUALIFICATION_DEVELOPMENT_QUERY_SET_SCHEMA.parse(await readJson(queryPath));
const pool = CATALOG_QUALIFICATION_DEVELOPMENT_CANDIDATE_POOL_SCHEMA.parse(
  await readJson(poolPath),
);
const resultSetHashes = [
  ...new Set(
    pool.queryPools.flatMap((query) => query.retrievals.map((entry) => entry.resultSetHash)),
  ),
];
const resultSets = await Promise.all(
  resultSetHashes.map(async (hash) =>
    CATALOG_SEARCH_RESULT_SET_SCHEMA.parse(
      await readJson(`.basalt/catalog/qualification/development/artifacts/result-set/${hash}.json`),
    ),
  ),
);
requireCatalogQualificationDevelopmentCandidatePool({ queries, pool, resultSets });

const rawDecision = await readJson(decisionInput);
if (rawDecision.kind !== "CatalogQualificationDevelopmentRelevanceDecision")
  throw new Error("Relevance decision has the wrong artifact kind");
if (Object.hasOwn(rawDecision, "hash"))
  throw new Error("Relevance decision input must be an unsealed review draft");
const decision = sealCatalogQualificationDevelopmentRelevanceDecision({
  candidatePoolHash: rawDecision.candidatePoolHash,
  querySetHash: rawDecision.querySetHash,
  reviewer: rawDecision.reviewer,
  reviewMethod: rawDecision.reviewMethod,
  reviewerStatement: rawDecision.reviewerStatement,
  reviewedAt: rawDecision.reviewedAt,
  coverage: rawDecision.coverage,
  queries: rawDecision.queries,
});
requireCatalogQualificationDevelopmentRelevanceDecision({ queries, pool, decision });
await writeJson(outputPath, decision);

const verdicts = decision.queries.flatMap((query) => query.judgments);
process.stdout.write(
  `${JSON.stringify(
    {
      status: decision.status,
      completedStage: "independent_query_asset_review",
      nextStage: decision.nextStage,
      decision: resolve(root, outputPath),
      decisionArtifactHash: decision.hash,
      acceptedQueries: decision.queries.filter((query) => query.requestDisposition === "accepted")
        .length,
      rejectedQueries: decision.queries.filter(
        (query) => query.requestDisposition === "rejected_for_reauthoring",
      ).length,
      judgments: {
        relevant: verdicts.filter((entry) => entry.verdict === "relevant").length,
        irrelevant: verdicts.filter((entry) => entry.verdict === "irrelevant").length,
        unknown: verdicts.filter((entry) => entry.verdict === "unknown").length,
      },
      validatorVerdictsReviewed: decision.validatorVerdictsReviewed,
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
    if (!key?.startsWith("--") || !value)
      throw new Error("Relevance finalization options must be --name value pairs");
    result.set(key, value);
  }
  return result;
}
