import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  CATALOG_QUALIFICATION_DEVELOPMENT_CANDIDATE_POOL_SCHEMA,
  CATALOG_QUALIFICATION_DEVELOPMENT_QUERY_SET_SCHEMA,
  CATALOG_QUALIFICATION_DEVELOPMENT_RELEVANCE_DECISION_SCHEMA,
  CATALOG_VISUAL_REVIEW_INDEX_SCHEMA,
  CATALOG_VISUAL_VALIDATION_JSON_SCHEMA_HASH,
  metadataViewIds,
  requireCatalogQualificationDevelopmentRelevanceDecision,
  requireCatalogQualificationDevelopmentValidatorCaseSet,
  sealAssetMetricPromptSummary,
  sealCatalogQualificationDevelopmentValidatorCaseSet,
  sealCatalogSearchValidationRequest,
  selectCatalogQualificationDevelopmentValidatorPairs,
} from "../packages/catalog-authoring/dist/index.js";
import { CATALOG_MEASUREMENT_SET_SCHEMA } from "../packages/catalog-model/dist/index.js";
import { contentHash } from "../packages/contracts/dist/index.js";
import { CATALOG_METADATA_PREPROCESSOR_IMPLEMENTATION_HASH } from "../packages/cli/dist/catalog-metadata.js";

const root = resolve(".");
const queryPath = "registry/qualifications/catalog-development-query-set.json";
const poolPath = ".basalt/catalog/qualification/development/candidate-pool.json";
const relevancePath = "registry/qualifications/catalog-development-relevance-decision.json";
const measurementPath = ".basalt/catalog/measurements.json";
const renderPath = ".basalt/catalog/review/index.json";
const promptPath = "registry/prompts/catalog-search-validation.txt";
const outputPath = "registry/qualifications/catalog-development-validator-case-set.json";

const queries = CATALOG_QUALIFICATION_DEVELOPMENT_QUERY_SET_SCHEMA.parse(await readJson(queryPath));
const pool = CATALOG_QUALIFICATION_DEVELOPMENT_CANDIDATE_POOL_SCHEMA.parse(
  await readJson(poolPath),
);
const relevanceDecision = CATALOG_QUALIFICATION_DEVELOPMENT_RELEVANCE_DECISION_SCHEMA.parse(
  await readJson(relevancePath),
);
requireCatalogQualificationDevelopmentRelevanceDecision({
  queries,
  pool,
  decision: relevanceDecision,
});
const measurements = CATALOG_MEASUREMENT_SET_SCHEMA.parse(await readJson(measurementPath));
const renders = CATALOG_VISUAL_REVIEW_INDEX_SCHEMA.parse(await readJson(renderPath));
if (measurements.hash !== pool.measurementSetHash || renders.hash !== pool.visualReviewIndexHash)
  throw new Error("Validator case evidence does not match the reviewed candidate pool");

const prompt = await readFile(resolve(root, promptPath), "utf8");
const validationPromptTemplateHash = contentHash(prompt);
const queryById = new Map(queries.queries.map((entry) => [entry.queryId, entry]));
const measurementBySource = new Map(
  measurements.assets.map((entry) => [entry.source.contentHash, entry]),
);
const renderBySource = new Map(renders.items.map((entry) => [entry.sourceContentHash, entry]));
const selections = selectCatalogQualificationDevelopmentValidatorPairs({
  pool,
  relevanceDecision,
});

const cases = [];
for (const selected of selections) {
  const authored = queryById.get(selected.queryId);
  const measurement = measurementBySource.get(selected.sourceContentHash);
  const render = renderBySource.get(selected.sourceContentHash);
  if (!authored || !measurement || !render)
    throw new Error(`Validator case lacks bound evidence: ${selected.caseId}`);
  if (
    measurement.hash !== selected.measurementHash ||
    render.evidence.hash !== selected.renderEvidenceHash
  )
    throw new Error(`Validator case evidence changed: ${selected.caseId}`);
  const evidenceByView = new Map(render.evidence.views.map((entry) => [entry.viewId, entry]));
  const artifactByView = new Map(render.viewArtifacts.map((entry) => [entry.viewId, entry]));
  const selectedRgbViews = [];
  for (const viewId of metadataViewIds("canonical_twelve")) {
    const evidence = evidenceByView.get(viewId);
    const artifact = artifactByView.get(viewId);
    if (!evidence || !artifact)
      throw new Error(`Validator case ${selected.caseId} lacks ${viewId}`);
    const bytes = await readFile(resolve(root, artifact.rgbRelativePath));
    if (sha256(bytes) !== evidence.rgbHash)
      throw new Error(`Validator case RGB evidence changed: ${selected.caseId}/${viewId}`);
    selectedRgbViews.push({ viewId, rgbHash: evidence.rgbHash });
  }
  const validationRequest = sealCatalogSearchValidationRequest({
    query: authored.request,
    candidate: {
      sourceContentHash: selected.sourceContentHash,
      measurementHash: measurement.hash,
      renderEvidenceHash: render.evidence.hash,
      metricSummary: sealAssetMetricPromptSummary(measurement),
      selectedRgbViews,
    },
    promptTemplateHash: validationPromptTemplateHash,
    preprocessingImplementationHash: CATALOG_METADATA_PREPROCESSOR_IMPLEMENTATION_HASH,
  });
  cases.push({ ...selected, validationRequest });
  await writeJson(
    `.basalt/catalog/qualification/development/artifacts/validation-request/${validationRequest.hash}.json`,
    validationRequest,
  );
}

const caseSet = sealCatalogQualificationDevelopmentValidatorCaseSet({
  querySetHash: queries.hash,
  candidatePoolHash: pool.hash,
  relevanceDecisionHash: relevanceDecision.hash,
  measurementSetHash: measurements.hash,
  visualReviewIndexHash: renders.hash,
  validationPromptTemplateHash,
  validationSchemaHash: CATALOG_VISUAL_VALIDATION_JSON_SCHEMA_HASH,
  preprocessingImplementationHash: CATALOG_METADATA_PREPROCESSOR_IMPLEMENTATION_HASH,
  cases,
});
requireCatalogQualificationDevelopmentValidatorCaseSet({
  queries,
  pool,
  relevanceDecision,
  caseSet,
});
await writeJson(outputPath, caseSet);

process.stdout.write(
  `${JSON.stringify(
    {
      status: caseSet.status,
      output: resolve(root, outputPath),
      hash: caseSet.hash,
      caseCount: caseSet.caseCount,
      proposedVerdictCounts: caseSet.proposedVerdictCounts,
      selectionPolicy: caseSet.selectionPolicy,
      nextStage: caseSet.nextStage,
      qualificationExecutionAuthorized: caseSet.qualificationExecutionAuthorized,
    },
    null,
    2,
  )}\n`,
);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readJson(path) {
  return JSON.parse(await readFile(resolve(root, path), "utf8"));
}

async function writeJson(path, value) {
  const absolute = resolve(root, path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
