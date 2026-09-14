import {
  CATALOG_CANDIDATE_DECISION_POLICY_SCHEMA,
  CATALOG_MODEL_DECLARATIONS_SCHEMA,
  CATALOG_MODEL_ROLE_POLICY_SCHEMA,
  CATALOG_QUALIFICATION_EVIDENCE_SCHEMA,
  CATALOG_QUALIFICATION_FIXTURE_SCHEMA,
  CATALOG_QUALIFICATION_POLICY_SCHEMA,
  CATALOG_SEARCH_POLICY_SCHEMA,
  evaluateCatalogQualification,
  sealCatalogModelRolePolicy,
  validateCatalogModelRolePolicy,
} from "@basalt/catalog-authoring";
import {
  CATALOG_QUALIFICATION_ROOT,
  absolute,
  parseOptions,
  type CatalogCommandContext,
} from "./catalog-command-support.js";

export async function runCatalogQualifyCommand(
  values: readonly string[],
  context: CatalogCommandContext,
): Promise<void> {
  const [stage, ...tail] = values;
  if (!stage || !["prepare", "run", "evaluate"].includes(stage))
    throw new Error("catalog qualify stage must be prepare, run, or evaluate");
  const options = parseOptions(tail);
  if (stage === "prepare") return prepareQualification(options, context);
  if (stage === "run") return acceptQualificationEvidence(options, context);
  return evaluateQualification(options, context);
}

async function prepareQualification(
  options: ReadonlyMap<string, string>,
  context: CatalogCommandContext,
): Promise<void> {
  const fixture = CATALOG_QUALIFICATION_FIXTURE_SCHEMA.parse(
    await context.readJson(options.get("--fixture") ?? "registry/catalog-qualification.json"),
  );
  const searchPolicy = CATALOG_SEARCH_POLICY_SCHEMA.parse(
    await context.readJson(options.get("--search-policy") ?? "registry/search-policy.json"),
  );
  const decisionPolicy = CATALOG_CANDIDATE_DECISION_POLICY_SCHEMA.parse(
    await context.readJson(
      options.get("--decision-policy") ?? "registry/candidate-decision-policy.json",
    ),
  );
  const qualificationPolicy = CATALOG_QUALIFICATION_POLICY_SCHEMA.parse(
    await context.readJson(
      options.get("--qualification-policy") ?? "registry/qualification-policy.json",
    ),
  );
  if (
    fixture.searchPolicyHash !== searchPolicy.hash ||
    fixture.candidateDecisionPolicyHash !== decisionPolicy.hash ||
    fixture.qualificationPolicyHash !== qualificationPolicy.hash
  )
    throw new Error("Qualification fixture does not bind the exact frozen policies");
  const output = options.get("--output") ?? `${CATALOG_QUALIFICATION_ROOT}/fixture.json`;
  await context.writeJson(output, fixture);
  context.print({
    status: "eligible",
    assets: fixture.assets.length,
    queries: fixture.queries.length,
    validationCases: fixture.validationCases.length,
    output: absolute(context.root, output),
    hash: fixture.hash,
  });
}

/**
 * Consolidate already content-addressed writer, retrieval, validator, and decision runs.
 * Live model execution is deliberately separate so a failed shard remains resumable.
 */
async function acceptQualificationEvidence(
  options: ReadonlyMap<string, string>,
  context: CatalogCommandContext,
): Promise<void> {
  const fixture = CATALOG_QUALIFICATION_FIXTURE_SCHEMA.parse(
    await context.readJson(
      options.get("--fixture") ?? `${CATALOG_QUALIFICATION_ROOT}/fixture.json`,
    ),
  );
  const evidence = CATALOG_QUALIFICATION_EVIDENCE_SCHEMA.parse(
    await context.readJson(
      options.get("--input") ?? `${CATALOG_QUALIFICATION_ROOT}/run-evidence.json`,
    ),
  );
  if (
    evidence.fixtureHash !== fixture.hash ||
    evidence.searchPolicyHash !== fixture.searchPolicyHash ||
    evidence.candidateDecisionPolicyHash !== fixture.candidateDecisionPolicyHash ||
    evidence.qualificationPolicyHash !== fixture.qualificationPolicyHash
  )
    throw new Error("Qualification run evidence differs from the frozen fixture or policies");
  const output = options.get("--output") ?? `${CATALOG_QUALIFICATION_ROOT}/evidence.json`;
  await context.writeJson(output, evidence);
  context.print({
    status: "eligible",
    retrievalRuns: evidence.retrievalRuns.length,
    validationRuns: evidence.validationRuns.length,
    decisionRuns: evidence.decisionRuns.length,
    output: absolute(context.root, output),
    hash: evidence.hash,
  });
}

async function evaluateQualification(
  options: ReadonlyMap<string, string>,
  context: CatalogCommandContext,
): Promise<void> {
  const fixture = CATALOG_QUALIFICATION_FIXTURE_SCHEMA.parse(
    await context.readJson(
      options.get("--fixture") ?? `${CATALOG_QUALIFICATION_ROOT}/fixture.json`,
    ),
  );
  const evidence = CATALOG_QUALIFICATION_EVIDENCE_SCHEMA.parse(
    await context.readJson(
      options.get("--evidence") ?? `${CATALOG_QUALIFICATION_ROOT}/evidence.json`,
    ),
  );
  const qualificationPolicy = CATALOG_QUALIFICATION_POLICY_SCHEMA.parse(
    await context.readJson(
      options.get("--qualification-policy") ?? "registry/qualification-policy.json",
    ),
  );
  const currentRolePolicy = CATALOG_MODEL_ROLE_POLICY_SCHEMA.parse(
    await context.readJson(options.get("--model-policy") ?? "registry/catalog-model-policy.json"),
  );
  const declarations = CATALOG_MODEL_DECLARATIONS_SCHEMA.parse(
    await context.readJson(options.get("--models") ?? "registry/catalog-models.json"),
  );
  validateCatalogModelRolePolicy(currentRolePolicy, declarations);
  const selectedWriterModelId = options.get("--writer") ?? currentRolePolicy.metadataWriter.modelId;
  const selectedWriterViewSet = (options.get("--writer-views") ??
    currentRolePolicy.metadataWriter.viewSet) as "cardinal_four" | "canonical_twelve";
  if (!["cardinal_four", "canonical_twelve"].includes(selectedWriterViewSet))
    throw new Error("Selected writer view set must be cardinal_four or canonical_twelve");
  const selectedValidatorModelId =
    options.get("--validator") ?? currentRolePolicy.requirementValidator.modelId;
  const report = evaluateCatalogQualification({
    fixture,
    evidence,
    policy: qualificationPolicy,
    selectedWriterModelId,
    selectedWriterViewSet,
    selectedValidatorModelId,
  });
  const modelPolicy = sealCatalogModelRolePolicy({
    metadataWriter: {
      modelId: selectedWriterModelId,
      viewSet: selectedWriterViewSet,
    },
    requirementValidator: {
      modelId: selectedValidatorModelId,
      viewSet: "canonical_twelve",
    },
    challengers: currentRolePolicy.challengers,
    qualificationReportHash: report.hash,
  });
  validateCatalogModelRolePolicy(modelPolicy, declarations);
  const output = options.get("--output") ?? `${CATALOG_QUALIFICATION_ROOT}/report.json`;
  const modelPolicyOutput =
    options.get("--output-model-policy") ?? `${CATALOG_QUALIFICATION_ROOT}/model-policy.json`;
  await context.writeJson(output, report);
  await context.writeJson(modelPolicyOutput, modelPolicy);
  context.print({
    status: report.status,
    gates: report.gates,
    output: absolute(context.root, output),
    modelPolicy: absolute(context.root, modelPolicyOutput),
    hash: report.hash,
  });
}
