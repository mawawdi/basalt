import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  CATALOG_SEARCH_METADATA_JSON_SCHEMA_HASH,
  CATALOG_VISUAL_VALIDATION_JSON_SCHEMA_HASH,
  metadataViewIds,
  sealAssetMetricPromptSummary,
  sealCatalogQualificationCandidatePool,
  sealCatalogQualificationFixture,
  sealCatalogSearchQuery,
  sealCatalogSearchValidationRequest,
} from "../packages/catalog-authoring/dist/index.js";
import { contentHash, stableJson } from "../packages/contracts/dist/index.js";
import { CATALOG_METADATA_PREPROCESSOR_IMPLEMENTATION_HASH } from "../packages/cli/dist/catalog-metadata.js";

const root = resolve(".");
const readJson = async (path) => JSON.parse(await readFile(resolve(root, path), "utf8"));
const compare = (left, right) => left.localeCompare(right);
const canonical = (values, key) =>
  [...values].sort((left, right) => compare(key(left), key(right)));

const sourceManifest = await readJson("registry/source-manifest.json");
const measurements = await readJson(".basalt/catalog/measurements.json");
const renders = await readJson(".basalt/catalog/review/index.json");
const sourceNames = await readJson(".basalt/catalog/metadata/source-name-hints.json");
const calibration = await readJson("registry/calibration-split.json");
const leakage = await readJson("registry/leakage-analysis.json");
const smoke = await readJson("registry/catalog-search-smoke.json");
const qualificationPolicy = await readJson("registry/qualification-policy.json");
const searchPolicy = await readJson("registry/search-policy.json");
const decisionPolicy = await readJson("registry/candidate-decision-policy.json");
const declarations = await readJson("registry/catalog-models.json");
const rolePolicy = await readJson("registry/catalog-model-policy.json");
const metadataPrompt = (
  await readFile(resolve(root, "registry/prompts/catalog-search-metadata.txt"), "utf8")
).trim();
const validationPrompt = (
  await readFile(resolve(root, "registry/prompts/catalog-search-validation.txt"), "utf8")
).trim();
const protocol = (
  await readFile(resolve(root, "registry/qualifications/catalog-adjudication-protocol.md"), "utf8")
).trim();

const measurementBySource = new Map(
  measurements.assets.map((entry) => [entry.source.contentHash, entry]),
);
const renderBySource = new Map(renders.items.map((entry) => [entry.sourceContentHash, entry]));
const hintBySource = new Map(sourceNames.items.map((entry) => [entry.sourceContentHash, entry]));
const provenance = await readJson("registry/source-provenance.json");
const provenanceBySource = new Map(
  provenance.records.map((entry) => [entry.sourceContentHash, entry]),
);
const groupBySource = new Map(
  calibration.groups.flatMap((group) =>
    group.sourceContentHashes.map((sourceContentHash) => [sourceContentHash, group.hash]),
  ),
);
const roleByGroup = new Map(calibration.assignments.map((entry) => [entry.groupHash, entry.role]));
const smokeBySource = new Map(smoke.assets.map((entry) => [entry.sourceContentHash, entry]));
const smokeGroups = new Set(
  smoke.assets.map((entry) => groupBySource.get(entry.sourceContentHash)).filter(Boolean),
);

const baseSplitByRole = {
  calibration: "model_selection",
  development: "development",
  evaluation: "holdout",
};
const splitByGroup = new Map(
  calibration.groups.map((group) => {
    const role = roleByGroup.get(group.hash);
    if (!role) throw new Error(`Leakage group ${group.hash} has no calibration assignment`);
    return [group.hash, smokeGroups.has(group.hash) ? "development" : baseSplitByRole[role]];
  }),
);

const records = sourceManifest.assets.map((source) => {
  const groupHash = groupBySource.get(source.contentHash);
  const measurement = measurementBySource.get(source.contentHash);
  const render = renderBySource.get(source.contentHash);
  const hint = hintBySource.get(source.contentHash);
  const provenance = provenanceBySource.get(source.contentHash);
  if (!groupHash || !measurement || !render || !hint || !provenance)
    throw new Error(`Qualification input is incomplete for ${source.contentHash}`);
  const filename = hint.observations.map((entry) => entry.originalFilename).join(" ");
  return {
    sourceContentHash: source.contentHash,
    groupHash,
    split: splitByGroup.get(groupHash),
    measurement,
    render,
    hint,
    provenance,
    filename,
    normalized: filename
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim(),
  };
});

const classificationRules = [
  ["collision_companion", /collision\b/, "collision companion"],
  ["attachment", /\battach\b/, "attachment"],
  ["aggregate", /\b(patch|cluster|pile|row|group|grove)\b/, "object aggregate"],
  [
    "vegetation",
    /\b(tree|palm|bush|grass|plant|flower|mushroom|stump|log|undergrowth|hedge)\b/,
    null,
  ],
  [
    "modular_piece",
    /\b(wall|floor|door|window|stairs|roof|pillar|bridge|fence|railing|tile|corner)\b/,
    null,
  ],
  [
    "out_of_kernel",
    /\b(bone|weapon|rifle|pistol|musket|character|vehicle|cow|pig|chicken)\b/,
    null,
  ],
  ["misleading_name", /\b(socket|round|trim|dressing|separate|preset|generic)\b/, null],
  [
    "whole_object",
    /\b(crate|barrel|bench|cart|wheel|sign|torch|campfire|table|chair|bed|desk|chest)\b/,
    null,
  ],
  ["style_contrast", /.*/, null],
];

const nounRules = [
  [/palm.*tree|tree.*palm/, "palm tree"],
  [/tree.*patch|tree.*cluster/, "tree cluster"],
  [/\btree\b/, "tree"],
  [/rock.*pillar/, "rock pillar"],
  [/rock.*(cluster|pile)/, "rock cluster"],
  [/\b(boulder|rock)\b/, "rock"],
  [/palm.*bush/, "palm bush"],
  [/\b(bush|hedge)\b/, "bush"],
  [/\bgrass\b/, "grass"],
  [/\bflower\b/, "flower"],
  [/\bmushroom\b/, "mushroom"],
  [/\bstump\b/, "tree stump"],
  [/\blog\b/, "log"],
  [/\bplant\b|undergrowth/, "plant"],
  [/\bbridge\b/, "bridge"],
  [/\bfence\b/, "fence"],
  [/\bwall\b/, "wall section"],
  [/\bfloor\b|floor.*tile/, "floor section"],
  [/\bdoor\b/, "door"],
  [/\bwindow\b/, "window"],
  [/\bstairs\b/, "stairs"],
  [/\broof\b/, "roof section"],
  [/\bpillar\b/, "pillar"],
  [/\bcrate\b/, "crate"],
  [/\bbarrel\b/, "barrel"],
  [/\bbench\b/, "bench"],
  [/\bcart\b/, "cart"],
  [/\bwheel\b/, "wheel"],
  [/\bsign\b/, "sign"],
  [/\btorch\b/, "torch"],
  [/camp.*fire/, "campfire"],
  [/\bbone\b/, "bone"],
  [/\bchair\b/, "chair"],
  [/\btable\b/, "table"],
  [/\bbed\b/, "bed"],
  [/\bdesk\b/, "desk"],
  [/\bchest\b/, "chest"],
];

function classify(record) {
  const smokeEntry = smokeBySource.get(record.sourceContentHash);
  if (smokeEntry) {
    const stratum = smokeEntry.outsideSemanticKernel
      ? "out_of_kernel"
      : smokeEntry.misleadingName
        ? "misleading_name"
        : smokeEntry.stratum === "aggregate_or_collision"
          ? /collision\b/.test(record.normalized)
            ? "collision_companion"
            : "aggregate"
          : smokeEntry.stratum === "component_or_attachment"
            ? /\battach\b/.test(record.normalized)
              ? "attachment"
              : "modular_piece"
            : smokeEntry.stratum === "organic_or_environment"
              ? "vegetation"
              : smokeEntry.stratum === "style_contrast"
                ? "style_contrast"
                : "whole_object";
    return {
      stratum,
      nouns: [...smokeEntry.acceptablePrimaryNouns].map(normalizeLabel).sort(compare),
    };
  }
  const [stratum, , forcedNoun] = classificationRules.find(([, pattern]) =>
    pattern.test(record.normalized),
  );
  const noun =
    forcedNoun ?? nounRules.find(([pattern]) => pattern.test(record.normalized))?.[1] ?? "object";
  const qualifiers = [
    record.provenance.originId === "polygon-nature" ? "stylized nature" : null,
    /snow/.test(record.normalized) ? "snow-covered" : null,
    /broken|cracked|dead/.test(record.normalized) ? "damaged" : null,
  ].filter(Boolean);
  return { stratum, nouns: [noun, ...qualifiers.map((value) => `${value} ${noun}`)].sort(compare) };
}

for (const record of records) Object.assign(record, classify(record));

const desired = {
  vegetation: 16,
  whole_object: 10,
  aggregate: 7,
  modular_piece: 10,
  attachment: 4,
  collision_companion: 4,
  misleading_name: 4,
  out_of_kernel: 4,
  style_contrast: 5,
};

const cohortBySplit = new Map();
for (const split of ["development", "model_selection", "holdout"]) {
  const available = records.filter((entry) => entry.split === split);
  const selected = [];
  const selectedHashes = new Set();
  if (split === "development")
    for (const record of available.filter((entry) => smokeBySource.has(entry.sourceContentHash))) {
      selected.push(record);
      selectedHashes.add(record.sourceContentHash);
    }
  for (const [stratum, target] of Object.entries(desired)) {
    if (selected.length >= 64) break;
    const have = selected.filter((entry) => entry.stratum === stratum).length;
    const candidates = available
      .filter((entry) => entry.stratum === stratum && !selectedHashes.has(entry.sourceContentHash))
      .sort(diversityCompare);
    const remaining = 64 - selected.length;
    for (const record of candidates.slice(0, Math.min(remaining, Math.max(0, target - have)))) {
      selected.push(record);
      selectedHashes.add(record.sourceContentHash);
    }
  }
  for (const record of available.sort(diversityCompare)) {
    if (selected.length >= 64) break;
    if (!selectedHashes.has(record.sourceContentHash)) {
      selected.push(record);
      selectedHashes.add(record.sourceContentHash);
    }
  }
  if (selected.length !== 64) throw new Error(`Could not select 64 ${split} cohort assets`);
  cohortBySplit.set(
    split,
    canonical(selected, (entry) => entry.sourceContentHash),
  );
}

const cohortHashes = new Set(
  [...cohortBySplit.values()].flat().map((entry) => entry.sourceContentHash),
);
const profiles = [
  "basename_and_image_text",
  "basename_and_metadata",
  "basename_only",
  "fully_enriched",
];
const profileBySource = new Map();
for (const split of ["development", "model_selection", "holdout"])
  cohortBySplit
    .get(split)
    .forEach((entry, index) => profileBySource.set(entry.sourceContentHash, profiles[index % 4]));

const assets = canonical(
  records.map((record) => {
    const cohort = cohortHashes.has(record.sourceContentHash);
    return {
      sourceContentHash: record.sourceContentHash,
      leakageGroupHash: record.groupHash,
      split: record.split,
      population: cohort ? "cohort" : "background",
      evidenceExpectation:
        cohort && ["collision_companion", "misleading_name"].includes(record.stratum)
          ? "insufficient"
          : "sufficient",
      mixedEnrichmentProfile: cohort
        ? profileBySource.get(record.sourceContentHash)
        : "basename_only",
      labelBasis: "basename_heuristic_proposal",
      ...(cohort
        ? {
            stratum: record.stratum,
            adjudicatedNouns: [...new Set(record.nouns)].sort(compare),
            adjudicationEvidenceHashes: directEvidence(record),
          }
        : {}),
    };
  }),
  (entry) => entry.sourceContentHash,
);

const candidatePools = [];
for (const split of ["development", "holdout", "model_selection"])
  for (const scenario of ["mixed", "uniform"]) {
    const selected = assets.filter(
      (entry) => entry.split === split && (scenario === "mixed" || entry.population === "cohort"),
    );
    candidatePools.push(
      sealCatalogQualificationCandidatePool({
        split,
        coverageScenario: scenario,
        assets: selected.map((entry) => ({
          sourceContentHash: entry.sourceContentHash,
          enrichmentProfile:
            scenario === "uniform" ? "fully_enriched" : entry.mixedEnrichmentProfile,
        })),
      }),
    );
  }

const absentConcepts = [
  "photorealistic space shuttle",
  "hospital MRI scanner",
  "modern offshore wind turbine",
  "coral reef formation",
  "full-size passenger submarine",
  "roller coaster train",
  "snowmobile",
  "elephant statue",
];
const unverifiableProperties = [
  "safe for a player to climb",
  "rated to support five hundred kilograms",
  "edible without cooking",
  "hollow all the way through",
  "contains a working lock and key",
  "electrically powered in gameplay",
  "native to the intended biome",
  "flammable under the game simulation",
];

const queries = [];
const validationCases = [];
for (const split of ["development", "holdout", "model_selection"]) {
  const cohort = cohortBySplit.get(split);
  const positiveSeeds = cohort.slice(0, 32);
  const positiveQueries = positiveSeeds.map((seed, index) => {
    const noun = seed.nouns[0];
    const relevant = cohort.filter((entry) => entry.nouns[0] === noun).slice(0, 6);
    const confusers = cohort
      .filter((entry) => entry.nouns[0] !== noun)
      .slice(index % 8, (index % 8) + 2);
    return fixtureQuery({
      queryId: `${split}_positive_${String(index + 1).padStart(2, "0")}`,
      split,
      text: queryText(noun, seed),
      expectation: "match",
      judgments: [
        ...relevant.map((entry) => ({
          sourceContentHash: entry.sourceContentHash,
          relevance: "relevant",
        })),
        ...confusers.map((entry) => ({
          sourceContentHash: entry.sourceContentHash,
          relevance: "irrelevant",
        })),
      ],
      evidence: [...relevant, ...confusers].flatMap(directEvidence),
    });
  });
  const noMatchQueries = absentConcepts.map((text, index) => {
    const negatives = [
      cohort[(index * 3) % cohort.length],
      cohort[(index * 3 + 1) % cohort.length],
    ];
    return fixtureQuery({
      queryId: `${split}_no_match_${String(index + 1).padStart(2, "0")}`,
      split,
      text,
      expectation: "no_match",
      judgments: negatives.map((entry) => ({
        sourceContentHash: entry.sourceContentHash,
        relevance: "irrelevant",
      })),
      evidence: negatives.flatMap(directEvidence),
    });
  });
  const insufficientQueries = unverifiableProperties.map((property, index) => {
    const candidate = cohort[(index * 5 + 7) % cohort.length];
    const confuser = cohort[(index * 5 + 8) % cohort.length];
    return fixtureQuery({
      queryId: `${split}_insufficient_${String(index + 1).padStart(2, "0")}`,
      split,
      text: `${candidate.nouns[0]} ${property}`,
      expectation: "evidence_insufficient",
      judgments: [
        { sourceContentHash: candidate.sourceContentHash, relevance: "uncertain" },
        { sourceContentHash: confuser.sourceContentHash, relevance: "irrelevant" },
      ],
      evidence: [candidate, confuser].flatMap(directEvidence),
    });
  });
  const splitQueries = [...positiveQueries, ...noMatchQueries, ...insufficientQueries];
  queries.push(...splitQueries);

  for (let index = 0; index < 16; index += 1) {
    const positive = positiveQueries[index];
    const candidateHash = positive.judgments.find(
      (entry) => entry.relevance === "relevant",
    ).sourceContentHash;
    const candidate = records.find((entry) => entry.sourceContentHash === candidateHash);
    validationCases.push(
      validationCase(
        `${split}_validator_match_${String(index + 1).padStart(2, "0")}`,
        split,
        positive.query,
        candidate,
        "match",
      ),
    );
  }
  for (let index = 0; index < 16; index += 1) {
    const positive = positiveQueries[index + 16];
    const desiredNoun = cohort[index + 16].nouns[0];
    const candidate = cohort.find(
      (entry, candidateIndex) => candidateIndex > index && entry.nouns[0] !== desiredNoun,
    );
    validationCases.push(
      validationCase(
        `${split}_validator_mismatch_${String(index + 1).padStart(2, "0")}`,
        split,
        positive.query,
        candidate,
        "mismatch",
      ),
    );
  }
  for (let index = 0; index < 16; index += 1) {
    const sourceQuery = insufficientQueries[index % insufficientQueries.length];
    const candidateHash = sourceQuery.judgments.find(
      (entry) => entry.relevance === "uncertain",
    ).sourceContentHash;
    const candidate = records.find((entry) => entry.sourceContentHash === candidateHash);
    validationCases.push(
      validationCase(
        `${split}_validator_uncertain_${String(index + 1).padStart(2, "0")}`,
        split,
        sourceQuery.query,
        candidate,
        "uncertain",
      ),
    );
  }
}

const writerModels = declarations.models.filter((entry) =>
  entry.capabilities.includes("metadata_writer"),
);
const validatorModels = declarations.models.filter((entry) =>
  entry.capabilities.includes("requirement_validator"),
);
const fixture = sealCatalogQualificationFixture({
  adjudication: {
    status: "pending_creator_review",
    proposalAuthor: "codex_agent",
    proposalMethod: "basename_heuristic",
  },
  sourceManifestHash: contentHash(stableJson(sourceManifest)),
  measurementSetHash: measurements.hash,
  visualReviewIndexHash: renders.hash,
  leakageAnalysisHash: leakage.hash,
  assets,
  candidatePools,
  queries,
  validationCases,
  writerConfigurations: writerModels.flatMap((model) =>
    ["cardinal_four", "canonical_twelve"].map((viewSet) => ({
      modelId: model.modelId,
      modelCommitHash: model.sourceCommitHash,
      viewSet,
    })),
  ),
  validatorConfigurations: validatorModels.map((model) => ({
    modelId: model.modelId,
    modelCommitHash: model.sourceCommitHash,
  })),
  adjudicationProtocolHash: contentHash(protocol),
  qualificationPolicyHash: qualificationPolicy.hash,
  searchPolicyHash: searchPolicy.hash,
  candidateDecisionPolicyHash: decisionPolicy.hash,
  modelDeclarationsHash: contentHash(stableJson(declarations)),
  modelRolePolicyHash: rolePolicy.hash,
  metadataPromptTemplateHash: contentHash(metadataPrompt),
  validationPromptTemplateHash: contentHash(validationPrompt),
  metadataSchemaHash: CATALOG_SEARCH_METADATA_JSON_SCHEMA_HASH,
  validationSchemaHash: CATALOG_VISUAL_VALIDATION_JSON_SCHEMA_HASH,
  selectionRule:
    "least_gpu_milliseconds_passing_all_gates_retain_twelve_views_when_cost_is_inconclusive",
});

const output = resolve(root, "registry/catalog-qualification.json");
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
const summary = {
  status: "incomplete",
  adjudication: fixture.adjudication,
  output,
  hash: fixture.hash,
  assets: fixture.assets.length,
  cohort: Object.fromEntries(
    ["development", "model_selection", "holdout"].map((split) => [
      split,
      fixture.assets.filter((entry) => entry.split === split && entry.population === "cohort")
        .length,
    ]),
  ),
  background: Object.fromEntries(
    ["development", "model_selection", "holdout"].map((split) => [
      split,
      fixture.assets.filter((entry) => entry.split === split && entry.population === "background")
        .length,
    ]),
  ),
  queries: fixture.queries.length,
  validationCases: fixture.validationCases.length,
  smokeSourcesInHoldout: fixture.assets.filter(
    (entry) => smokeBySource.has(entry.sourceContentHash) && entry.split === "holdout",
  ).length,
};
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);

function directEvidence(record) {
  return [
    ...new Set([record.measurement.hash, record.render.evidence.hash, record.hint.hash]),
  ].sort(compare);
}

function normalizeLabel(value) {
  return value.toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

function diversityCompare(left, right) {
  const origin = left.provenance.originId.localeCompare(right.provenance.originId);
  return origin || left.sourceContentHash.localeCompare(right.sourceContentHash);
}

function queryText(noun, record) {
  const details = [
    /snow/.test(record.normalized) ? "snow-covered" : null,
    /broken|cracked|dead/.test(record.normalized) ? "visibly damaged" : null,
    record.provenance.originId === "polygon-nature" ? "stylized outdoor" : "stylized",
  ].filter(Boolean);
  return `${details.join(" ")} ${noun}`.trim();
}

function fixtureQuery({ queryId, split, text, expectation, judgments, evidence }) {
  return {
    queryId,
    split,
    query: sealCatalogSearchQuery({
      text,
      styleTerms: ["stylized"],
      rankingMode: "automatic",
      constraints: { commercialUseRequired: true, redistributionRequired: true },
      limit: 100,
      validationLimit: 3,
    }),
    expectation,
    judgmentBasis: "basename_heuristic_proposal",
    judgments: canonical(
      [...new Map(judgments.map((entry) => [entry.sourceContentHash, entry])).values()],
      (entry) => entry.sourceContentHash,
    ),
    adjudicationEvidenceHashes: [...new Set(evidence)].sort(compare),
  };
}

function validationCase(caseId, split, query, candidate, expectedVerdict) {
  if (!candidate) throw new Error(`Missing candidate for ${caseId}`);
  const evidenceByView = new Map(
    candidate.render.evidence.views.map((entry) => [entry.viewId, entry]),
  );
  const request = sealCatalogSearchValidationRequest({
    query,
    candidate: {
      sourceContentHash: candidate.sourceContentHash,
      measurementHash: candidate.measurement.hash,
      renderEvidenceHash: candidate.render.evidence.hash,
      metricSummary: sealAssetMetricPromptSummary(candidate.measurement),
      selectedRgbViews: metadataViewIds("canonical_twelve").map((viewId) => ({
        viewId,
        rgbHash: evidenceByView.get(viewId).rgbHash,
      })),
    },
    promptTemplateHash: contentHash(validationPrompt),
    preprocessingImplementationHash: CATALOG_METADATA_PREPROCESSOR_IMPLEMENTATION_HASH,
  });
  return {
    caseId,
    split,
    request,
    expectedVerdict,
    verdictBasis: "basename_heuristic_proposal",
    adjudicationEvidenceHashes: directEvidence(candidate),
  };
}
