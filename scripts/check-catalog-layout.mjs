#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { lstat, readFile, readdir } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { CATALOG_DISPOSITION_SCHEMA, TRUSTED_SOURCE_MANIFEST_SCHEMA } from "@basalt/catalog-model";
import {
  CATALOG_ADMISSION_POLICY_SCHEMA,
  CATALOG_AUTHORITY_COMMIT_SCHEMA,
} from "@basalt/catalog-authoring";
import { stableJson } from "@basalt/contracts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const execFile = promisify(execFileCallback);
const required = [
  "registry/source-manifest.json",
  "registry/semantics/kernel.json",
  "registry/semantics/constraints.json",
  "registry/style-profiles.json",
  "registry/dispositions.json",
  "registry/admission-policy.json",
  "registry/catalog.json",
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
if (Object.hasOwn(source, "familyManifest"))
  throw new Error("Source manifest still delegates authority to a family manifest");
const sourcePaths = source.packages.flatMap((pack) =>
  Array.isArray(pack.files) ? pack.files.map((file) => file.relativePath) : [],
);
if (new Set(sourcePaths).size !== sourcePaths.length)
  throw new Error("Source manifest repeats source paths");
const sourceHashes = [
  ...new Set(
    source.packages.flatMap((pack) =>
      Array.isArray(pack.files) ? pack.files.map((file) => file.sha256) : [],
    ),
  ),
];

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
}
for (const path of [
  "registry/catalog.json",
  ...committed.retainedEvidence.map((entry) => entry.relativePath),
])
  await assertGitCommittable(path);
const entriesRoot = resolve(root, "registry/entries");
const entryFiles = (await readdir(entriesRoot, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
  .map((entry) => entry.name)
  .sort();
for (const name of entryFiles) await assertRegular(`registry/entries/${name}`);

for (const pack of source.packages)
  for (const file of pack.files) {
    const path = resolve(root, file.relativePath);
    const relation = relative(root, path);
    if (relation === ".." || relation.startsWith(`..${sep}`))
      throw new Error(`Source escapes the repository: ${file.relativePath}`);
    const status = await lstat(path);
    if (!status.isFile() || status.isSymbolicLink())
      throw new Error(`Source is not a regular non-symlink file: ${file.relativePath}`);
  }

console.log(
  `Catalog layout is valid (${sourcePaths.length} paths / ${sourceHashes.length} content identities, ${entryFiles.length} authored entries, commit ${committed.hash.slice(0, 12)}).`,
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
