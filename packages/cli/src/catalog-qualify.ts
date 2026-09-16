import { z } from "zod";
import {
  CATALOG_CANDIDATE_DECISION_POLICY_SCHEMA,
  CATALOG_LEAKAGE_ANALYSIS_SCHEMA,
  CATALOG_METADATA_VIEW_SETS,
  CATALOG_MODEL_DECLARATIONS_SCHEMA,
  CATALOG_MODEL_ROLE_POLICY_SCHEMA,
  CATALOG_QUALIFICATION_EVIDENCE_SCHEMA,
  CATALOG_QUALIFICATION_ADJUDICATION_DECISION_SCHEMA,
  CATALOG_QUALIFICATION_DEVELOPMENT_CANDIDATE_POOL_SCHEMA,
  CATALOG_QUALIFICATION_DEVELOPMENT_QUERY_SET_SCHEMA,
  CATALOG_QUALIFICATION_DEVELOPMENT_RELEVANCE_DECISION_SCHEMA,
  CATALOG_QUALIFICATION_DEVELOPMENT_VALIDATOR_CASE_SET_SCHEMA,
  CATALOG_QUALIFICATION_DEVELOPMENT_VALIDATOR_DECISION_SCHEMA,
  CATALOG_QUALIFICATION_DEVELOPMENT_VALIDATOR_VERDICT_SET_SCHEMA,
  CATALOG_QUALIFICATION_DESCRIPTION_DECISION_SCHEMA,
  CATALOG_QUALIFICATION_DESCRIPTION_PROPOSAL_SCHEMA,
  CATALOG_QUALIFICATION_DESCRIPTION_SET_SCHEMA,
  CATALOG_QUALIFICATION_FIXTURE_SCHEMA,
  CATALOG_QUALIFICATION_POLICY_SCHEMA,
  CATALOG_QUALIFICATION_REPORT_SCHEMA,
  CATALOG_QUALIFICATION_SELECTION_SCHEMA,
  CATALOG_QUALIFICATION_SPLIT_SCHEMA,
  CATALOG_QUALIFICATION_REVIEW_PACKET_SCHEMA,
  CATALOG_SEARCH_METADATA_REQUEST_SET_SCHEMA,
  CATALOG_SEARCH_METADATA_SET_SCHEMA,
  CATALOG_SEARCH_METADATA_JSON_SCHEMA_HASH,
  CATALOG_SEARCH_POLICY_SCHEMA,
  CATALOG_VISUAL_REVIEW_INDEX_SCHEMA,
  CATALOG_VISUAL_VALIDATION_JSON_SCHEMA_HASH,
  evaluateCatalogQualification,
  requireCreatorReviewedQualificationFixture,
  requireCatalogQualificationDevelopmentQueryPrerequisites,
  sealCatalogModelRolePolicy,
  sealCatalogQualificationSelection,
  validateCatalogModelRolePolicy,
  validateProductionCatalogQualificationFixture,
} from "@basalt/catalog-authoring";
import {
  CATALOG_MEASUREMENT_SET_SCHEMA,
  TRUSTED_SOURCE_MANIFEST_SCHEMA,
} from "@basalt/catalog-model";
import { contentHash, stableJson } from "@basalt/contracts";
import { runCatalogMetadataCommand } from "./catalog-metadata.js";
import {
  executeDevelopmentCandidatePooling,
  executeDevelopmentValidatorComparison,
} from "./catalog-qualification-development.js";
import {
  executeQualificationSplit,
  loadQualificationArtifacts,
} from "./catalog-qualification-runner.js";
import {
  CATALOG_QUALIFICATION_ROOT,
  absolute,
  fileHash,
  parseOptions,
  readText,
  type CatalogCommandContext,
} from "./catalog-command-support.js";

const DEFAULT_REVIEW_PACKET_PATH =
  "registry/qualifications/catalog-adjudication-review-packet.json";
const DEFAULT_PROPOSAL_FIXTURE_PATH = "registry/qualifications/catalog-qualification-proposal.json";
const DEFAULT_ADJUDICATION_DECISION_PATH =
  "registry/qualifications/catalog-adjudication-decision.json";

export async function runCatalogQualifyCommand(
  values: readonly string[],
  context: CatalogCommandContext,
): Promise<void> {
  const [stage, ...tail] = values;
  if (!stage || !["prepare", "pool", "validate", "run", "evaluate"].includes(stage))
    throw new Error("catalog qualify stage must be prepare, pool, validate, run, or evaluate");
  const options = parseOptions(tail);
  if (stage === "prepare") return prepareQualification(options, context);
  if (stage === "pool") return poolDevelopmentQualification(options, context);
  if (stage === "validate") return validateDevelopmentQualification(options, context);
  if (stage === "run") return runQualification(options, context);
  return evaluateQualification(options, context);
}

async function poolDevelopmentQualification(
  options: ReadonlyMap<string, string>,
  context: CatalogCommandContext,
): Promise<void> {
  const split = z.literal("development").parse(options.get("--split") ?? "development");
  const executor = z.enum(["local", "modal"]).parse(options.get("--executor") ?? "local");
  const proposal = CATALOG_QUALIFICATION_DESCRIPTION_PROPOSAL_SCHEMA.parse(
    await context.readJson(
      options.get("--description-proposal") ??
        "registry/qualifications/catalog-description-proposal.json",
    ),
  );
  const decision = CATALOG_QUALIFICATION_DESCRIPTION_DECISION_SCHEMA.parse(
    await context.readJson(
      options.get("--description-decision") ??
        "registry/qualifications/catalog-description-decision.json",
    ),
  );
  const descriptions = CATALOG_QUALIFICATION_DESCRIPTION_SET_SCHEMA.parse(
    await context.readJson(
      options.get("--descriptions") ?? "registry/qualifications/catalog-description-set.json",
    ),
  );
  const queries = CATALOG_QUALIFICATION_DEVELOPMENT_QUERY_SET_SCHEMA.parse(
    await context.readJson(
      options.get("--queries") ?? "registry/qualifications/catalog-development-query-set.json",
    ),
  );
  requireCatalogQualificationDevelopmentQueryPrerequisites({
    proposal,
    decision,
    descriptions,
    queries,
  });
  const metadataRequestSet = CATALOG_SEARCH_METADATA_REQUEST_SET_SCHEMA.parse(
    await context.readJson(
      options.get("--metadata-requests") ??
        `${CATALOG_QUALIFICATION_ROOT}/${split}/metadata-requests.json`,
    ),
  );
  const metadata = CATALOG_SEARCH_METADATA_SET_SCHEMA.parse(
    await context.readJson(
      options.get("--metadata") ??
        `${CATALOG_QUALIFICATION_ROOT}/${split}/metadata/qwen3_vl_8b-canonical_twelve.json`,
    ),
  );
  const pool = await executeDevelopmentCandidatePooling({
    queries,
    descriptions,
    metadataRequestSet,
    metadata,
    executor,
    context,
  });
  context.print({
    status: pool.status,
    split,
    queries: pool.queryPools.length,
    reviewPairs: pool.pooledPairCount,
    reviewedCohortCandidates: pool.reviewedCohortCandidateCount,
    backgroundCandidates: pool.backgroundCandidateCount,
    output: absolute(context.root, `${CATALOG_QUALIFICATION_ROOT}/${split}/candidate-pool.json`),
    hash: pool.hash,
    qualificationExecutionAuthorized: false,
  });
}

async function validateDevelopmentQualification(
  options: ReadonlyMap<string, string>,
  context: CatalogCommandContext,
): Promise<void> {
  const split = z.literal("development").parse(options.get("--split") ?? "development");
  const executor = z.enum(["local", "modal"]).parse(options.get("--executor") ?? "local");
  const queries = CATALOG_QUALIFICATION_DEVELOPMENT_QUERY_SET_SCHEMA.parse(
    await context.readJson(
      options.get("--queries") ?? "registry/qualifications/catalog-development-query-set.json",
    ),
  );
  const pool = CATALOG_QUALIFICATION_DEVELOPMENT_CANDIDATE_POOL_SCHEMA.parse(
    await context.readJson(
      options.get("--candidate-pool") ??
        `${CATALOG_QUALIFICATION_ROOT}/${split}/candidate-pool.json`,
    ),
  );
  const relevanceDecision = CATALOG_QUALIFICATION_DEVELOPMENT_RELEVANCE_DECISION_SCHEMA.parse(
    await context.readJson(
      options.get("--relevance-decision") ??
        "registry/qualifications/catalog-development-relevance-decision.json",
    ),
  );
  const caseSet = CATALOG_QUALIFICATION_DEVELOPMENT_VALIDATOR_CASE_SET_SCHEMA.parse(
    await context.readJson(
      options.get("--validator-cases") ??
        "registry/qualifications/catalog-development-validator-case-set.json",
    ),
  );
  const validatorDecision = CATALOG_QUALIFICATION_DEVELOPMENT_VALIDATOR_DECISION_SCHEMA.parse(
    await context.readJson(
      options.get("--validator-decision") ??
        "registry/qualifications/catalog-development-validator-decision.json",
    ),
  );
  const verdictSet = CATALOG_QUALIFICATION_DEVELOPMENT_VALIDATOR_VERDICT_SET_SCHEMA.parse(
    await context.readJson(
      options.get("--validator-verdicts") ??
        "registry/qualifications/catalog-development-validator-verdict-set.json",
    ),
  );
  const comparison = await executeDevelopmentValidatorComparison({
    queries,
    pool,
    relevanceDecision,
    caseSet,
    validatorDecision,
    verdictSet,
    executor,
    context,
  });
  context.print({
    status: comparison.status,
    split,
    verdictAuthority: comparison.verdictAuthority,
    reviewIndependence: comparison.reviewIndependence,
    metrics: comparison.metrics,
    promotionAuthorized: comparison.promotionAuthorized,
    qualificationExecutionAuthorized: comparison.qualificationExecutionAuthorized,
    output: absolute(
      context.root,
      `${CATALOG_QUALIFICATION_ROOT}/${split}/validator-comparison.json`,
    ),
    hash: comparison.hash,
  });
}

async function prepareQualification(
  options: ReadonlyMap<string, string>,
  context: CatalogCommandContext,
): Promise<void> {
  const fixturePath = options.get("--fixture") ?? "registry/catalog-qualification.json";
  const fixture = CATALOG_QUALIFICATION_FIXTURE_SCHEMA.parse(await context.readJson(fixturePath));
  validateProductionCatalogQualificationFixture(fixture);
  await validateCurrentFixtureLineage(fixture, options, context);
  if (fixture.adjudication.status === "creator_reviewed")
    await loadCreatorAdjudication(fixture, options, context);
  const output = options.get("--output") ?? `${CATALOG_QUALIFICATION_ROOT}/fixture.json`;
  await context.writeJson(output, fixture);

  const quietContext = { ...context, print: (_value: unknown) => undefined };
  for (const split of CATALOG_QUALIFICATION_SPLIT_SCHEMA.options)
    await runCatalogMetadataCommand(
      [
        "prepare",
        "--scope",
        "qualification",
        "--split",
        split,
        "--fixture",
        fixturePath,
        "--view-set",
        [...CATALOG_METADATA_VIEW_SETS].sort().join(","),
        "--output",
        `${CATALOG_QUALIFICATION_ROOT}/${split}/metadata-requests.json`,
      ],
      quietContext,
    );
  context.print({
    status: fixture.adjudication.status === "creator_reviewed" ? "eligible" : "incomplete",
    adjudication: fixture.adjudication,
    cohortAssets: fixture.assets.filter((entry) => entry.population === "cohort").length,
    backgroundAssets: fixture.assets.filter((entry) => entry.population === "background").length,
    queries: fixture.queries.length,
    validationCases: fixture.validationCases.length,
    output: absolute(context.root, output),
    hash: fixture.hash,
  });
}

async function runQualification(
  options: ReadonlyMap<string, string>,
  context: CatalogCommandContext,
): Promise<void> {
  const split = requiredSplit(options);
  const executor = z.enum(["local", "modal"]).parse(options.get("--executor") ?? "local");
  const fixture = CATALOG_QUALIFICATION_FIXTURE_SCHEMA.parse(
    await context.readJson(
      options.get("--fixture") ?? `${CATALOG_QUALIFICATION_ROOT}/fixture.json`,
    ),
  );
  const adjudication = await loadCreatorAdjudication(fixture, options, context);
  const frozenSelection =
    split === "holdout"
      ? CATALOG_QUALIFICATION_SELECTION_SCHEMA.parse(
          await context.readJson(
            options.get("--selection") ?? `${CATALOG_QUALIFICATION_ROOT}/selection.json`,
          ),
        )
      : undefined;
  const evidence = await executeQualificationSplit({
    split,
    executor,
    fixture,
    proposalFixture: adjudication.proposal,
    reviewPacket: adjudication.reviewPacket,
    adjudicationDecision: adjudication.decision,
    ...(frozenSelection ? { frozenSelection } : {}),
    context,
  });
  context.print({
    status: "eligible",
    split,
    metadataRuns: evidence.metadataRuns.length,
    embeddingRuns: evidence.embeddingRuns.length,
    indexRuns: evidence.indexRuns.length,
    retrievalRuns: evidence.retrievalRuns.length,
    independentValidationRuns: evidence.independentValidationRuns.length,
    decisionRuns: evidence.decisionRuns.length,
    output: absolute(context.root, `${CATALOG_QUALIFICATION_ROOT}/${split}/evidence.json`),
    hash: evidence.hash,
  });
}

async function evaluateQualification(
  options: ReadonlyMap<string, string>,
  context: CatalogCommandContext,
): Promise<void> {
  const split = requiredSplit(options);
  const fixture = CATALOG_QUALIFICATION_FIXTURE_SCHEMA.parse(
    await context.readJson(
      options.get("--fixture") ?? `${CATALOG_QUALIFICATION_ROOT}/fixture.json`,
    ),
  );
  const adjudication = await loadCreatorAdjudication(fixture, options, context);
  const evidence = CATALOG_QUALIFICATION_EVIDENCE_SCHEMA.parse(
    await context.readJson(
      options.get("--evidence") ?? `${CATALOG_QUALIFICATION_ROOT}/${split}/evidence.json`,
    ),
  );
  const policy = CATALOG_QUALIFICATION_POLICY_SCHEMA.parse(
    await context.readJson(
      options.get("--qualification-policy") ?? "registry/qualification-policy.json",
    ),
  );
  const frozenSelection =
    split === "holdout"
      ? CATALOG_QUALIFICATION_SELECTION_SCHEMA.parse(
          await context.readJson(
            options.get("--selection") ?? `${CATALOG_QUALIFICATION_ROOT}/selection.json`,
          ),
        )
      : undefined;
  const artifacts = await loadQualificationArtifacts({ split, fixture, evidence, context });
  const selectedWriterModelId = options.get("--writer");
  const selectedWriterViewSet = options.get("--writer-views")
    ? z.enum(CATALOG_METADATA_VIEW_SETS).parse(options.get("--writer-views"))
    : undefined;
  const selectedValidatorModelId = options.get("--validator");
  const report = evaluateCatalogQualification({
    split,
    fixture,
    proposalFixture: adjudication.proposal,
    reviewPacket: adjudication.reviewPacket,
    adjudicationDecision: adjudication.decision,
    evidence,
    artifacts,
    policy,
    ...(frozenSelection ? { frozenSelection } : {}),
    ...(selectedWriterModelId ? { selectedWriterModelId } : {}),
    ...(selectedWriterViewSet ? { selectedWriterViewSet } : {}),
    ...(selectedValidatorModelId ? { selectedValidatorModelId } : {}),
  });
  const output = options.get("--output") ?? `${CATALOG_QUALIFICATION_ROOT}/${split}/report.json`;
  await context.writeJson(output, report);

  let selectionPath: string | undefined;
  let modelPolicyPath: string | undefined;
  if (split === "model_selection" && report.status === "eligible") {
    const selection = sealCatalogQualificationSelection({ fixture, report, evidence });
    selectionPath =
      options.get("--output-selection") ?? `${CATALOG_QUALIFICATION_ROOT}/selection.json`;
    await context.writeJson(selectionPath, selection);
  }
  if (split === "holdout" && report.status === "eligible") {
    const currentRolePolicy = CATALOG_MODEL_ROLE_POLICY_SCHEMA.parse(
      await context.readJson(options.get("--model-policy") ?? "registry/catalog-model-policy.json"),
    );
    const declarations = CATALOG_MODEL_DECLARATIONS_SCHEMA.parse(
      await context.readJson(options.get("--models") ?? "registry/catalog-models.json"),
    );
    const modelPolicy = sealCatalogModelRolePolicy({
      metadataWriter: {
        modelId: report.selectedWriterModelId,
        viewSet: report.selectedWriterViewSet,
      },
      requirementValidator: {
        modelId: report.selectedValidatorModelId,
        viewSet: "canonical_twelve",
      },
      challengers: currentRolePolicy.challengers,
      qualificationReportHash: report.hash,
    });
    validateCatalogModelRolePolicy(modelPolicy, declarations);
    modelPolicyPath =
      options.get("--output-model-policy") ?? `${CATALOG_QUALIFICATION_ROOT}/model-policy.json`;
    await context.writeJson(modelPolicyPath, modelPolicy);
    await context.writeJson(`${CATALOG_QUALIFICATION_ROOT}/report.json`, report);
  }
  context.print({
    status: report.status,
    split,
    selected: {
      writerModelId: report.selectedWriterModelId,
      writerViewSet: report.selectedWriterViewSet,
      validatorModelId: report.selectedValidatorModelId,
    },
    candidatePopulations: report.candidatePopulations,
    selectedGpuMilliseconds: report.selectedGpuMilliseconds,
    totalGpuMilliseconds: report.totalGpuMilliseconds,
    gates: report.gates,
    metrics: {
      channels: report.channelMetrics,
      validators: report.validatorMetrics,
      decisions: report.decisionMetrics,
    },
    output: absolute(context.root, output),
    ...(selectionPath ? { selection: absolute(context.root, selectionPath) } : {}),
    ...(modelPolicyPath ? { modelPolicy: absolute(context.root, modelPolicyPath) } : {}),
    hash: report.hash,
  });
}

async function loadCreatorAdjudication(
  fixture: z.output<typeof CATALOG_QUALIFICATION_FIXTURE_SCHEMA>,
  options: ReadonlyMap<string, string>,
  context: CatalogCommandContext,
) {
  if (fixture.adjudication.status !== "creator_reviewed")
    throw new Error(
      "Qualification fixture remains pending creator review and cannot authorize model execution",
    );
  const proposal = CATALOG_QUALIFICATION_FIXTURE_SCHEMA.parse(
    await context.readJson(options.get("--proposal-fixture") ?? DEFAULT_PROPOSAL_FIXTURE_PATH),
  );
  const reviewPacket = CATALOG_QUALIFICATION_REVIEW_PACKET_SCHEMA.parse(
    await context.readJson(options.get("--review-packet") ?? DEFAULT_REVIEW_PACKET_PATH),
  );
  const decision = CATALOG_QUALIFICATION_ADJUDICATION_DECISION_SCHEMA.parse(
    await context.readJson(
      options.get("--adjudication-decision") ?? DEFAULT_ADJUDICATION_DECISION_PATH,
    ),
  );
  requireCreatorReviewedQualificationFixture({ fixture, proposal, reviewPacket, decision });
  return { proposal, reviewPacket, decision };
}

async function validateCurrentFixtureLineage(
  fixture: z.output<typeof CATALOG_QUALIFICATION_FIXTURE_SCHEMA>,
  options: ReadonlyMap<string, string>,
  context: CatalogCommandContext,
): Promise<void> {
  const qualificationPolicy = CATALOG_QUALIFICATION_POLICY_SCHEMA.parse(
    await context.readJson(
      options.get("--qualification-policy") ?? "registry/qualification-policy.json",
    ),
  );
  const searchPolicy = CATALOG_SEARCH_POLICY_SCHEMA.parse(
    await context.readJson(options.get("--search-policy") ?? "registry/search-policy.json"),
  );
  const decisionPolicy = CATALOG_CANDIDATE_DECISION_POLICY_SCHEMA.parse(
    await context.readJson(
      options.get("--decision-policy") ?? "registry/candidate-decision-policy.json",
    ),
  );
  const declarations = CATALOG_MODEL_DECLARATIONS_SCHEMA.parse(
    await context.readJson(options.get("--models") ?? "registry/catalog-models.json"),
  );
  const rolePolicy = CATALOG_MODEL_ROLE_POLICY_SCHEMA.parse(
    await context.readJson(options.get("--model-policy") ?? "registry/catalog-model-policy.json"),
  );
  validateCatalogModelRolePolicy(rolePolicy, declarations);
  const sourceManifest = TRUSTED_SOURCE_MANIFEST_SCHEMA.parse(
    await context.readJson(options.get("--source") ?? "registry/source-manifest.json"),
  );
  const measurements = CATALOG_MEASUREMENT_SET_SCHEMA.parse(
    await context.readJson(options.get("--measurements") ?? ".basalt/catalog/measurements.json"),
  );
  const renders = CATALOG_VISUAL_REVIEW_INDEX_SCHEMA.parse(
    await context.readJson(options.get("--renders") ?? ".basalt/catalog/review/index.json"),
  );
  const leakage = CATALOG_LEAKAGE_ANALYSIS_SCHEMA.parse(
    await context.readJson(options.get("--leakage") ?? "registry/leakage-analysis.json"),
  );
  const metadataPrompt = await readText(
    context.root,
    options.get("--metadata-prompt") ?? "registry/prompts/catalog-search-metadata.txt",
  );
  const validationPrompt = await readText(
    context.root,
    options.get("--validation-prompt") ?? "registry/prompts/catalog-search-validation.txt",
  );
  const current = [
    ["qualification policy", qualificationPolicy.hash, fixture.qualificationPolicyHash],
    ["search policy", searchPolicy.hash, fixture.searchPolicyHash],
    ["candidate-decision policy", decisionPolicy.hash, fixture.candidateDecisionPolicyHash],
    ["model declarations", contentHash(stableJson(declarations)), fixture.modelDeclarationsHash],
    ["model-role policy", rolePolicy.hash, fixture.modelRolePolicyHash],
    ["source manifest", contentHash(stableJson(sourceManifest)), fixture.sourceManifestHash],
    ["measurement set", measurements.hash, fixture.measurementSetHash],
    ["visual review index", renders.hash, fixture.visualReviewIndexHash],
    ["leakage analysis", leakage.hash, fixture.leakageAnalysisHash],
    ["metadata prompt", contentHash(metadataPrompt), fixture.metadataPromptTemplateHash],
    ["validation prompt", contentHash(validationPrompt), fixture.validationPromptTemplateHash],
    ["metadata schema", CATALOG_SEARCH_METADATA_JSON_SCHEMA_HASH, fixture.metadataSchemaHash],
    ["validation schema", CATALOG_VISUAL_VALIDATION_JSON_SCHEMA_HASH, fixture.validationSchemaHash],
  ] as const;
  for (const [name, actual, expected] of current)
    if (actual !== expected) throw new Error(`Qualification fixture binds stale ${name}`);
  const workerHash = await fileHash(context.root, "workers/catalog-metadata/worker.py");
  if (workerHash.length !== 64) throw new Error("Catalog worker implementation is unreadable");
}

function requiredSplit(options: ReadonlyMap<string, string>) {
  const value = options.get("--split");
  if (!value) throw new Error("catalog qualify run/evaluate requires --split");
  return CATALOG_QUALIFICATION_SPLIT_SCHEMA.parse(value);
}

export { CATALOG_QUALIFICATION_REPORT_SCHEMA };
