#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, extname, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertRuntimeBuildCurrent } from "./runtime-build-manifest.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(dirname(scriptPath), "..");
const defaultRoot = resolve(repositoryRoot, "3d-assets");
const defaultOutput = resolve(repositoryRoot, ".basalt/kenney-catalog-v1.json");
const MAXIMUM_MODEL_BYTES = 256 * 1024 * 1024;
const MAXIMUM_LICENSE_BYTES = 64 * 1024;

function usage() {
  return [
    "Usage: node scripts/index-kenney-assets.mjs",
    "  [--root <3d-assets directory>] [--output <catalog.json>]",
  ].join("\n");
}

function parseArguments(values) {
  const options = new Map();
  const permitted = new Set(["--root", "--output"]);
  if (values.length % 2 !== 0) throw new Error(usage());
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index];
    const value = values[index + 1];
    if (!permitted.has(name) || !value || options.has(name)) throw new Error(usage());
    options.set(name, resolve(value));
  }
  return {
    root: options.get("--root") ?? defaultRoot,
    output: options.get("--output") ?? defaultOutput,
  };
}

async function canonicalDirectory(path, label) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(path)) !== path)
    throw new Error(`${label} must be a canonical directory: ${path}`);
  return path;
}

async function canonicalFile(path, label, maximumBytes) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > maximumBytes)
    throw new Error(`${label} must be a bounded regular file: ${path}`);
  if ((await realpath(path)) !== path) throw new Error(`${label} must not be a symlink: ${path}`);
  return { path, bytes: info.size };
}

async function sha256(path) {
  const hash = createHash("sha256");
  const bytes = await readFile(path);
  hash.update(bytes);
  return hash.digest("hex");
}

function slug(value) {
  return (
    value
      .normalize("NFC")
      .toLocaleLowerCase("en-US")
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-+|-+$/gu, "") || "asset"
  );
}

function tagsFor(kit, file) {
  const tokens = `${kit} ${file}`
    .replace(/\.[a-z0-9]+$/iu, "")
    .split(/[^a-z0-9]+/iu)
    .map((value) => value.toLocaleLowerCase("en-US"))
    .filter((value) => value.length > 1);
  return [...new Set(tokens)].sort((left, right) => left.localeCompare(right));
}

function insideRoot(root, child) {
  const rootPrefix = `${root}${sep}`;
  return child.startsWith(rootPrefix) && !child.includes(`${sep}..${sep}`);
}

async function findModels(kitRoot) {
  const result = [];
  const pending = [kitRoot];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (!directory) continue;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        pending.push(path);
        continue;
      }
      if (entry.isFile() && extname(entry.name).toLocaleLowerCase("en-US") === ".glb")
        result.push(path);
    }
  }
  return result.sort((left, right) => left.localeCompare(right));
}

async function main() {
  const { root, output } = parseArguments(process.argv.slice(2));
  await assertRuntimeBuildCurrent(repositoryRoot);
  await canonicalDirectory(root, "Kenney asset root");
  const kits = [];
  for (const entry of (await readdir(root, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const kitRoot = resolve(root, entry.name);
    const licensePath = resolve(kitRoot, "License.txt");
    const license = await canonicalFile(
      licensePath,
      `${entry.name} license`,
      MAXIMUM_LICENSE_BYTES,
    );
    const licenseText = (await readFile(licensePath, "utf8")).normalize("NFC");
    if (!/Creative Commons Zero|CC0/iu.test(licenseText))
      throw new Error(`Kenney kit does not retain an explicit CC0 license: ${entry.name}`);
    const models = await findModels(kitRoot);
    const licenseHash = await sha256(licensePath);
    const modelEntries = [];
    for (const modelPath of models) {
      const model = await canonicalFile(modelPath, "Kenney model", MAXIMUM_MODEL_BYTES);
      if (!insideRoot(root, model.path)) throw new Error(`Model escaped asset root: ${model.path}`);
      const relativePath = relative(root, model.path).split(sep).join("/");
      const fileName = modelPath.slice(modelPath.lastIndexOf(sep) + 1);
      const recordId = `kenney_${slug(entry.name)}_${slug(fileName.replace(/\.glb$/iu, ""))}`;
      modelEntries.push({
        id: recordId,
        kit: entry.name,
        relativePath,
        bytes: model.bytes,
        sha256: await sha256(model.path),
        licenseId: "CC0-1.0",
        licenseSha256: licenseHash,
        attribution: "Kenney (www.kenney.nl)",
        tags: tagsFor(entry.name, fileName),
      });
    }
    kits.push({
      id: `kenney_kit_${slug(entry.name)}`,
      name: entry.name,
      license: {
        id: "CC0-1.0",
        relativePath: `${entry.name}/License.txt`,
        bytes: license.bytes,
        sha256: licenseHash,
        attribution: "Kenney (www.kenney.nl)",
      },
      modelCount: modelEntries.length,
      models: modelEntries,
    });
  }
  const material = {
    kind: "KenneyRetrievalCatalog",
    abi: "basalt-kenney-retrieval-catalog@1",
    sourceRoot: "3d-assets",
    licensePolicy: "every-kit-explicit-cc0-1.0",
    preferredFormat: "glb",
    kits,
    modelCount: kits.reduce((sum, kit) => sum + kit.modelCount, 0),
  };
  const { contentHash, stableJson } = await import(
    pathToFileURL(resolve(repositoryRoot, "dist/packages/contracts/src/index.js")).href
  );
  const catalog = { ...material, hash: contentHash(stableJson(material)) };
  await writeFile(output, `${stableJson(catalog)}\n`, { encoding: "utf8", mode: 0o600 });
  process.stdout.write(
    `${JSON.stringify({ output, hash: catalog.hash, kits: kits.length, models: catalog.modelCount }, null, 2)}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(
    `Kenney catalog indexing failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
