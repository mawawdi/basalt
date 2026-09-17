#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { lstat, readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  CATALOG_DISPOSITION_SCHEMA,
  CATALOG_MEASUREMENT_SET_SCHEMA,
  SOURCE_PROVENANCE_LEDGER_SCHEMA,
  TRUSTED_SOURCE_MANIFEST_SCHEMA,
  validateSourceAuthority,
} from "@basalt/catalog-model";
import {
  CATALOG_ADMISSION_POLICY_SCHEMA,
  CATALOG_ADMISSION_RUBRIC_SCHEMA,
  CATALOG_AUTHORITY_COMMIT_SCHEMA,
  CATALOG_CALIBRATION_SPLIT_SCHEMA,
  CATALOG_LEAKAGE_ANALYSIS_SCHEMA,
  CATALOG_LEAKAGE_GROUPING_POLICY_SCHEMA,
  CATALOG_MODEL_DECLARATIONS_SCHEMA,
  CATALOG_MODEL_ROLE_POLICY_SCHEMA,
  CATALOG_NEAR_DUPLICATE_SEARCH_SCHEMA,
  CATALOG_CANDIDATE_DECISION_POLICY_SCHEMA,
  CATALOG_QUALIFICATION_POLICY_SCHEMA,
  CATALOG_SEARCH_SMOKE_FIXTURE_SCHEMA,
  CATALOG_SEARCH_METADATA_SHARD_SCHEMA,
  CATALOG_SEARCH_POLICY_SCHEMA,
  CATALOG_SEARCH_REGISTRY_SCHEMA,
  CATALOG_SUBSTITUTION_PROPOSAL_POLICY_SCHEMA,
  CATALOG_VISUAL_REVIEW_INDEX_SCHEMA,
  CATALOG_CREATOR_REVIEW_DECISION_SCHEMA,
  CATALOG_CREATOR_REVIEW_PACKET_SCHEMA,
  validateCatalogCalibrationSplit,
  validateCatalogCreatorReviewDecision,
  validateCatalogModelRolePolicy,
} from "@basalt/catalog-authoring";
import { contentHash, stableJson } from "@basalt/contracts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const execFile = promisify(execFileCallback);
const required = [
  "registry/source-manifest.json",
  "registry/source-provenance.json",
  "registry/semantics/kernel.json",
  "registry/semantics/constraints.json",
  "registry/style-profiles.json",
  "registry/dispositions.json",
  "registry/admission-policy.json",
  "registry/admission-rubric.json",
  "registry/catalog-models.json",
  "registry/catalog-model-policy.json",
  "registry/catalog-search-smoke.json",
  "registry/candidate-decision-policy.json",
  "registry/qualification-policy.json",
  "registry/search-policy.json",
  "registry/substitution-proposal-policy.json",
  "registry/prompts/catalog-search-metadata.txt",
  "registry/prompts/catalog-search-validation.txt",
  "registry/leakage-grouping-policy.json",
  "registry/near-duplicate-search.json",
  "registry/leakage-analysis.json",
  "registry/calibration-split.json",
  "registry/catalog.json",
  "registry/acceptance-audits/README.md",
  "registry/evidence/README.md",
];
const forbidden = [
  ["registry", ["family", "manifest.json"].join("-")].join("/"),
  ["registry", ["kit", "manifest.json"].join("-")].join("/"),
  "registry/catalog-inference-models.json",
  "registry/qualifications/README.md",
  "registry/quarantine.json",
  "registry/trim-sheet.json",
  "workers/catalog-admission/pilot.py",
  "workers/catalog-admission/modal_app.py",
];

for (const path of required) await assertRegular(path);
for (const path of forbidden) {
  const status = await lstat(resolve(root, path)).catch((error) =>
    error?.code === "ENOENT" ? undefined : Promise.reject(error),
  );
  if (status) throw new Error(`Superseded catalog artifact still exists: ${path}`);
}
await rejectClassifierResidue();

const source = TRUSTED_SOURCE_MANIFEST_SCHEMA.parse(
  await readJson("registry/source-manifest.json"),
);
const provenance = SOURCE_PROVENANCE_LEDGER_SCHEMA.parse(
  await readJson("registry/source-provenance.json"),
);
const sourceAuthority = validateSourceAuthority({ manifest: source, provenance });
if (sourceAuthority.status !== "eligible")
  throw new Error(
    `Source authority is ${sourceAuthority.status}: ${stableJson(sourceAuthority.diagnostics)}`,
  );
const sourceManifestHash = contentHash(stableJson(source));
const sourceHashes = source.assets.map((asset) => asset.contentHash);
if (new Set(source.assets.map((asset) => asset.relativePath)).size !== source.assets.length)
  throw new Error("Source manifest repeats canonical payload paths");

const admissionRubric = CATALOG_ADMISSION_RUBRIC_SCHEMA.parse(
  await readJson("registry/admission-rubric.json"),
);
const admissionPolicy = CATALOG_ADMISSION_POLICY_SCHEMA.parse(
  await readJson("registry/admission-policy.json"),
);
if (
  admissionPolicy.automaticAdmissionEnabled ||
  admissionPolicy.automaticallyAdmissibleEntryKinds.length > 0
)
  throw new Error("Search-first catalog authority must keep automatic admission disabled");
const modelDeclarations = CATALOG_MODEL_DECLARATIONS_SCHEMA.parse(
  await readJson("registry/catalog-models.json"),
);
const modelRolePolicy = CATALOG_MODEL_ROLE_POLICY_SCHEMA.parse(
  await readJson("registry/catalog-model-policy.json"),
);
validateCatalogModelRolePolicy(modelRolePolicy, modelDeclarations);
CATALOG_SEARCH_POLICY_SCHEMA.parse(await readJson("registry/search-policy.json"));
CATALOG_CANDIDATE_DECISION_POLICY_SCHEMA.parse(
  await readJson("registry/candidate-decision-policy.json"),
);
CATALOG_QUALIFICATION_POLICY_SCHEMA.parse(await readJson("registry/qualification-policy.json"));
CATALOG_SUBSTITUTION_PROPOSAL_POLICY_SCHEMA.parse(
  await readJson("registry/substitution-proposal-policy.json"),
);

const groupingPolicy = CATALOG_LEAKAGE_GROUPING_POLICY_SCHEMA.parse(
  await readJson("registry/leakage-grouping-policy.json"),
);
const nearDuplicateSearch = CATALOG_NEAR_DUPLICATE_SEARCH_SCHEMA.parse(
  await readJson("registry/near-duplicate-search.json"),
);
const leakageAnalysis = CATALOG_LEAKAGE_ANALYSIS_SCHEMA.parse(
  await readJson("registry/leakage-analysis.json"),
);
const calibrationSplit = CATALOG_CALIBRATION_SPLIT_SCHEMA.parse(
  await readJson("registry/calibration-split.json"),
);
if (
  leakageAnalysis.nearDuplicateSearchHash !== nearDuplicateSearch.hash ||
  nearDuplicateSearch.sourceManifestHash !== sourceManifestHash ||
  stableJson(nearDuplicateSearch.similarityThreshold) !==
    stableJson(groupingPolicy.nearDuplicateSimilarity)
)
  throw new Error("Physical leakage evidence does not bind the current source and policy");
const splitValidation = validateCatalogCalibrationSplit({
  split: calibrationSplit,
  sourceManifest: source,
  groupingPolicy,
  leakageAnalysis,
});
if (splitValidation.status === "rejected")
  throw new Error(`Physical leakage split is rejected: ${stableJson(splitValidation.diagnostics)}`);

const smoke = CATALOG_SEARCH_SMOKE_FIXTURE_SCHEMA.parse(
  await readJson("registry/catalog-search-smoke.json"),
);
if (smoke.authority !== "smoke_only")
  throw new Error("Catalog smoke evidence cannot authorize corpus execution");
const sourceSet = new Set(sourceHashes);
const groupBySource = new Map(
  calibrationSplit.groups.flatMap((group) =>
    group.sourceContentHashes.map((sourceHash) => [sourceHash, group.hash]),
  ),
);
for (const asset of smoke.assets) {
  if (!sourceSet.has(asset.sourceContentHash))
    throw new Error(`Smoke fixture references unknown source ${asset.sourceContentHash}`);
  if (groupBySource.get(asset.sourceContentHash) !== asset.leakageGroupHash)
    throw new Error(`Smoke fixture leakage group is stale for ${asset.sourceContentHash}`);
}

const dispositions = CATALOG_DISPOSITION_SCHEMA.array().parse(
  await readJson("registry/dispositions.json"),
);
const dispositionHashes = dispositions.map((entry) => entry.sourceContentHash);
if (
  new Set(dispositionHashes).size !== dispositionHashes.length ||
  JSON.stringify([...dispositionHashes].sort()) !== JSON.stringify(dispositionHashes)
)
  throw new Error("Catalog dispositions must be unique and canonically ordered");
if (JSON.stringify([...sourceHashes].sort()) !== JSON.stringify(dispositionHashes))
  throw new Error("Every source asset must have exactly one disposition");

const committed = CATALOG_AUTHORITY_COMMIT_SCHEMA.parse(await readJson("registry/catalog.json"));
if (committed.admissionPolicy.hash !== admissionPolicy.hash)
  throw new Error("Committed catalog does not bind the current admission policy");
if (stableJson(committed.sourceManifest) !== stableJson(source))
  throw new Error("Committed catalog does not embed the current source manifest");
if (stableJson(committed.dispositions) !== stableJson(dispositions))
  throw new Error("Committed catalog does not embed the current dispositions");
const referencedReviewHashes = new Set(
  committed.acceptanceAudits.flatMap((audit) => [audit.reviewPacketHash, audit.reviewDecisionHash]),
);
const retainedArtifacts = new Map();
for (const evidence of committed.retainedEvidence) {
  await assertRegular(evidence.relativePath);
  const bytes = await readFile(resolve(root, evidence.relativePath));
  if (bytes.byteLength !== evidence.bytes)
    throw new Error(`Retained catalog evidence byte count changed: ${evidence.relativePath}`);
  if (createHash("sha256").update(bytes).digest("hex") !== evidence.bytesHash)
    throw new Error(`Retained catalog evidence bytes changed: ${evidence.relativePath}`);
  const raw = JSON.parse(bytes.toString("utf8"));
  const artifact = parseRetainedEvidence(raw, evidence.kind);
  if (artifact.hash !== evidence.artifactHash)
    throw new Error(`Retained catalog evidence identity changed: ${evidence.relativePath}`);
  if ("sourceManifestHash" in artifact && artifact.sourceManifestHash !== sourceManifestHash)
    throw new Error(`Retained catalog evidence binds another source: ${evidence.relativePath}`);
  if (
    (evidence.kind === "CatalogCreatorReviewPacket" ||
      evidence.kind === "CatalogCreatorReviewDecision") &&
    !referencedReviewHashes.has(evidence.artifactHash)
  )
    throw new Error(
      `Catalog retained unreferenced creator review evidence: ${evidence.relativePath}`,
    );
  retainedArtifacts.set(evidence.artifactHash, artifact);
}
const measurementEvidence = committed.retainedEvidence.filter(
  (entry) => entry.kind === "CatalogMeasurementSet",
);
const visualEvidence = committed.retainedEvidence.filter(
  (entry) => entry.kind === "CatalogVisualReviewIndex",
);
if (
  measurementEvidence.length !== 1 ||
  measurementEvidence[0]?.artifactHash !== committed.measurementSetHash ||
  visualEvidence.length < 1 ||
  committed.acceptanceAudits.some(
    (audit) =>
      !visualEvidence.some((evidence) => evidence.artifactHash === audit.visualReviewIndexHash),
  )
)
  throw new Error("Catalog authority must retain exact measurement and visual-review evidence");
for (const hash of referencedReviewHashes)
  if (!retainedArtifacts.has(hash))
    throw new Error(`Catalog acceptance audit lacks retained creator evidence ${hash}`);
const validatedReviewPairs = new Set();
for (const audit of committed.acceptanceAudits) {
  if (audit.admissionRubricHash !== admissionRubric.hash)
    throw new Error(`Catalog acceptance audit binds a stale rubric: ${audit.sourceContentHash}`);
  const pair = `${audit.reviewPacketHash}:${audit.reviewDecisionHash}`;
  if (validatedReviewPairs.has(pair)) continue;
  const packet = CATALOG_CREATOR_REVIEW_PACKET_SCHEMA.parse(
    retainedArtifacts.get(audit.reviewPacketHash),
  );
  const decision = CATALOG_CREATOR_REVIEW_DECISION_SCHEMA.parse(
    retainedArtifacts.get(audit.reviewDecisionHash),
  );
  validateCatalogCreatorReviewDecision({ packet, decision, rubric: admissionRubric });
  validatedReviewPairs.add(pair);
}

const optionalSearchRoot = await optionalRegular("registry/catalog-search.json");
const searchPaths = [];
if (optionalSearchRoot) {
  const search = CATALOG_SEARCH_REGISTRY_SCHEMA.parse(
    await readJson("registry/catalog-search.json"),
  );
  if (search.sourceManifestHash !== sourceManifestHash)
    throw new Error("Catalog search registry binds another source manifest");
  for (const descriptor of search.shards) {
    await assertRegular(descriptor.relativePath);
    const bytes = await readFile(resolve(root, descriptor.relativePath));
    if (
      bytes.byteLength !== descriptor.bytes ||
      createHash("sha256").update(bytes).digest("hex") !== descriptor.bytesHash
    )
      throw new Error(`Catalog search shard bytes changed: ${descriptor.relativePath}`);
    const shard = CATALOG_SEARCH_METADATA_SHARD_SCHEMA.parse(JSON.parse(bytes.toString("utf8")));
    if (shard.hash !== descriptor.artifactHash || shard.records.length !== descriptor.recordCount)
      throw new Error(`Catalog search shard identity changed: ${descriptor.relativePath}`);
    searchPaths.push(descriptor.relativePath);
  }
  searchPaths.push("registry/catalog-search.json");
}

for (const path of [
  ...new Set([
    ...required,
    ...committed.retainedEvidence.map((entry) => entry.relativePath),
    ...searchPaths,
  ]),
])
  await assertGitCommittable(path);

const entriesRoot = resolve(root, "registry/entries");
const entryFiles = (await readdir(entriesRoot, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
  .map((entry) => entry.name)
  .sort();
for (const name of entryFiles) {
  await assertRegular(`registry/entries/${name}`);
  await assertGitCommittable(`registry/entries/${name}`);
}

for (const asset of source.assets) {
  const path = resolve(root, asset.relativePath);
  const relation = relative(root, path);
  if (relation === ".." || relation.startsWith(`..${sep}`))
    throw new Error(`Source escapes the repository: ${asset.relativePath}`);
  const status = await lstat(path);
  if (!status.isFile() || status.isSymbolicLink())
    throw new Error(`Source is not a regular non-symlink file: ${asset.relativePath}`);
}

console.log(
  `Catalog layout is valid (${sourceHashes.length} identities, ${entryFiles.length} admitted entries, ${smoke.assets.length}-asset search smoke fixture, authority ${committed.hash.slice(0, 12)}).`,
);

function parseRetainedEvidence(raw, kind) {
  if (kind === "CatalogMeasurementSet") return CATALOG_MEASUREMENT_SET_SCHEMA.parse(raw);
  if (kind === "CatalogVisualReviewIndex") return CATALOG_VISUAL_REVIEW_INDEX_SCHEMA.parse(raw);
  if (kind === "CatalogCreatorReviewPacket") return CATALOG_CREATOR_REVIEW_PACKET_SCHEMA.parse(raw);
  if (kind === "CatalogCreatorReviewDecision")
    return CATALOG_CREATOR_REVIEW_DECISION_SCHEMA.parse(raw);
  throw new Error(`Catalog authority retains unsupported evidence kind ${kind}`);
}

async function readJson(relativePath) {
  return JSON.parse(await readFile(resolve(root, relativePath), "utf8"));
}

async function assertRegular(relativePath) {
  const status = await lstat(resolve(root, relativePath));
  if (!status.isFile() || status.isSymbolicLink())
    throw new Error(`Catalog contract must be a regular non-symlink file: ${relativePath}`);
}

async function optionalRegular(relativePath) {
  const status = await lstat(resolve(root, relativePath)).catch((error) =>
    error?.code === "ENOENT" ? undefined : Promise.reject(error),
  );
  if (status && (!status.isFile() || status.isSymbolicLink()))
    throw new Error(`Optional catalog contract is unsafe: ${relativePath}`);
  return status;
}

async function assertGitCommittable(relativePath) {
  try {
    await execFile("git", ["check-ignore", "--quiet", "--", relativePath], {
      cwd: root,
      maxBuffer: 1024 * 1024,
    });
  } catch (error) {
    if (error?.code === 1) return;
    throw error;
  }
  throw new Error(`Tracked catalog state is ignored by Git: ${relativePath}`);
}

async function rejectClassifierResidue() {
  const patterns = [
    ["CatalogPrediction", "classifier prediction contract"],
    ["noveltyScore", "classifier novelty score"],
    ["softmax_per_facet", "classifier score transformation"],
    ["catalog pilot", "removed pilot command"],
  ];
  const files = [];
  for (const path of [resolve(root, "packages"), resolve(root, "workers", "catalog-metadata")])
    await collectSources(path, files);
  for (const path of files) {
    const source = await readFile(path, "utf8");
    for (const [pattern, label] of patterns)
      if (source.includes(pattern))
        throw new Error(`${relative(root, path)} still contains ${label}`);
  }
}

async function collectSources(directory, files) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink())
      throw new Error(`Catalog source tree contains a symlink: ${entry.name}`);
    if (entry.name === "dist" || entry.name === "__pycache__") continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await collectSources(path, files);
    else if (entry.isFile() && /\.(?:ts|js|py)$/u.test(entry.name)) files.push(path);
  }
}
