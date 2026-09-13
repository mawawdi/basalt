#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { lstat, readFile, readdir } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  CATALOG_DISPOSITION_SCHEMA,
  SOURCE_PROVENANCE_LEDGER_SCHEMA,
  TRUSTED_SOURCE_MANIFEST_SCHEMA,
  validateSourceAuthority,
} from "@basalt/catalog-model";
import {
  CATALOG_ADMISSION_RUBRIC_SCHEMA,
  CATALOG_ADMISSION_POLICY_SCHEMA,
  CATALOG_AUTHORITY_COMMIT_SCHEMA,
  CATALOG_CALIBRATION_SPLIT_SCHEMA,
  CATALOG_HYPOTHESIS_REQUEST_SET_SCHEMA,
  CATALOG_LEAKAGE_ANALYSIS_SCHEMA,
  CATALOG_LEAKAGE_GROUPING_POLICY_SCHEMA,
  CATALOG_NEAR_DUPLICATE_SEARCH_SCHEMA,
  CATALOG_SOURCE_NAME_HINT_SET_SCHEMA,
  validateCatalogCalibrationSplit,
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
  "registry/catalog-inference-models.json",
  "registry/leakage-grouping-policy.json",
  "registry/near-duplicate-search.json",
  "registry/leakage-analysis.json",
  "registry/calibration-split.json",
  "registry/catalog.json",
  "registry/acceptance-audits/README.md",
  "registry/qualifications/README.md",
];
const forbidden = [
  `registry/${["family", "manifest"].join("-")}.json`,
  `registry/${["kit", "manifest"].join("-")}.json`,
  "registry/quarantine.json",
  "registry/trim-sheet.json",
];

for (const path of required) await assertRegular(path);
for (const path of forbidden) {
  const status = await lstat(resolve(root, path)).catch((error) =>
    error?.code === "ENOENT" ? undefined : Promise.reject(error),
  );
  if (status) throw new Error(`Superseded catalog artifact still exists: ${path}`);
}

const source = TRUSTED_SOURCE_MANIFEST_SCHEMA.parse(
  JSON.parse(await readFile(resolve(root, required[0]), "utf8")),
);
const provenance = SOURCE_PROVENANCE_LEDGER_SCHEMA.parse(
  JSON.parse(await readFile(resolve(root, "registry/source-provenance.json"), "utf8")),
);
const sourceAuthority = validateSourceAuthority({ manifest: source, provenance });
if (sourceAuthority.status !== "eligible")
  throw new Error(
    `Source authority is ${sourceAuthority.status}: ${stableJson(sourceAuthority.diagnostics)}`,
  );
const sourcePaths = source.assets.map((asset) => asset.relativePath);
if (new Set(sourcePaths).size !== sourcePaths.length)
  throw new Error("Source manifest repeats source paths");
const sourceHashes = source.assets.map((asset) => asset.contentHash);

CATALOG_ADMISSION_RUBRIC_SCHEMA.parse(
  JSON.parse(await readFile(resolve(root, "registry/admission-rubric.json"), "utf8")),
);
const groupingPolicy = CATALOG_LEAKAGE_GROUPING_POLICY_SCHEMA.parse(
  JSON.parse(await readFile(resolve(root, "registry/leakage-grouping-policy.json"), "utf8")),
);
const nearDuplicateSearch = CATALOG_NEAR_DUPLICATE_SEARCH_SCHEMA.parse(
  JSON.parse(await readFile(resolve(root, "registry/near-duplicate-search.json"), "utf8")),
);
const calibrationSplit = CATALOG_CALIBRATION_SPLIT_SCHEMA.parse(
  JSON.parse(await readFile(resolve(root, "registry/calibration-split.json"), "utf8")),
);
const leakageAnalysis = CATALOG_LEAKAGE_ANALYSIS_SCHEMA.parse(
  JSON.parse(await readFile(resolve(root, "registry/leakage-analysis.json"), "utf8")),
);
if (
  leakageAnalysis.nearDuplicateSearchHash !== nearDuplicateSearch.hash ||
  nearDuplicateSearch.sourceManifestHash !== contentHash(stableJson(source)) ||
  stableJson(nearDuplicateSearch.similarityThreshold) !==
    stableJson(groupingPolicy.nearDuplicateSimilarity)
)
  throw new Error("Physical leakage analysis does not bind current near-duplicate evidence");
const splitValidation = validateCatalogCalibrationSplit({
  split: calibrationSplit,
  sourceManifest: source,
  groupingPolicy,
  leakageAnalysis,
});
if (splitValidation.status === "rejected")
  throw new Error(`Calibration split is rejected: ${stableJson(splitValidation.diagnostics)}`);

const dispositions = CATALOG_DISPOSITION_SCHEMA.array().parse(
  JSON.parse(await readFile(resolve(root, "registry/dispositions.json"), "utf8")),
);
const dispositionHashes = dispositions.map((entry) => entry.sourceContentHash);
if (
  new Set(dispositionHashes).size !== dispositionHashes.length ||
  JSON.stringify([...dispositionHashes].sort()) !== JSON.stringify(dispositionHashes)
)
  throw new Error("Catalog dispositions must be unique and canonically ordered");
if (JSON.stringify([...sourceHashes].sort()) !== JSON.stringify(dispositionHashes))
  throw new Error("Every source asset must have exactly one disposition");
const admissionPolicy = CATALOG_ADMISSION_POLICY_SCHEMA.parse(
  JSON.parse(await readFile(resolve(root, "registry/admission-policy.json"), "utf8")),
);
const committed = CATALOG_AUTHORITY_COMMIT_SCHEMA.parse(
  JSON.parse(await readFile(resolve(root, "registry/catalog.json"), "utf8")),
);
if (committed.admissionPolicy.hash !== admissionPolicy.hash)
  throw new Error("Committed catalog does not bind the current admission policy");
if (stableJson(committed.sourceManifest) !== stableJson(source))
  throw new Error("Committed catalog does not embed the current source manifest");
if (stableJson(committed.dispositions) !== stableJson(dispositions))
  throw new Error("Committed catalog does not embed the current dispositions");
const retainedArtifacts = new Map();
for (const evidence of committed.retainedEvidence) {
  await assertRegular(evidence.relativePath);
  const bytes = await readFile(resolve(root, evidence.relativePath));
  if (bytes.byteLength !== evidence.bytes)
    throw new Error(`Retained catalog evidence byte count changed: ${evidence.relativePath}`);
  if (createHash("sha256").update(bytes).digest("hex") !== evidence.bytesHash)
    throw new Error(`Retained catalog evidence hash changed: ${evidence.relativePath}`);
  const artifact = JSON.parse(bytes.toString("utf8"));
  if (artifact.kind !== evidence.kind || artifact.hash !== evidence.artifactHash)
    throw new Error(`Retained catalog evidence identity changed: ${evidence.relativePath}`);
  retainedArtifacts.set(evidence.kind, artifact);
}
const sourceNameHints = CATALOG_SOURCE_NAME_HINT_SET_SCHEMA.parse(
  retainedArtifacts.get("CatalogSourceNameHintSet"),
);
const hypothesisRequests = CATALOG_HYPOTHESIS_REQUEST_SET_SCHEMA.parse(
  retainedArtifacts.get("CatalogHypothesisRequestSet"),
);
const sourceManifestHash = contentHash(stableJson(source));
if (sourceNameHints.sourceManifestHash !== sourceManifestHash)
  throw new Error("Committed source-name hints do not bind the current source manifest");
if (hypothesisRequests.sourceNameHintSetHash !== sourceNameHints.hash)
  throw new Error("Committed hypothesis requests do not bind the retained source-name hint set");
if (sourceNameHints.items.length !== source.assets.length)
  throw new Error("Committed source-name hints do not cover every canonical source identity");
const sourceNameHintBySource = new Map(
  sourceNameHints.items.map((item) => [item.sourceContentHash, item]),
);
for (const request of hypothesisRequests.requests)
  if (sourceNameHintBySource.get(request.sourceContentHash)?.hash !== request.sourceNameHintHash)
    throw new Error(
      `Hypothesis request does not bind its exact source-name hint: ${request.sourceContentHash}`,
    );
for (const path of [
  ...new Set([...required, ...committed.retainedEvidence.map((entry) => entry.relativePath)]),
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
  `Catalog layout is valid (${sourceHashes.length} canonical identities / ${provenance.records.length} provenance records, ${entryFiles.length} authored entries, calibration ${calibrationSplit.status}, commit ${committed.hash.slice(0, 12)}).`,
);

async function assertRegular(relativePath) {
  const status = await lstat(resolve(root, relativePath));
  if (!status.isFile() || status.isSymbolicLink())
    throw new Error(`Catalog contract must be a regular non-symlink file: ${relativePath}`);
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
  throw new Error(`Catalog authority is ignored by Git: ${relativePath}`);
}
