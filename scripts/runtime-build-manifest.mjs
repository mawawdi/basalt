#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Code-unit string order. Locale-aware comparison must never feed sealed output. */
const compareStrings = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

const scriptPath = fileURLToPath(import.meta.url);
const root = resolve(dirname(scriptPath), "..");
const outputPath = resolve(root, "dist/runtime-build-manifest.json");
const fixedInputs = [
  "bin/basalt.js",
  "package-lock.json",
  "package.json",
  "scripts/runtime-build-manifest.mjs",
  "tsconfig.json",
];
const PRODUCT_PACKAGE_ROOTS = [
  "basalt-types",
  "contracts",
  "artifact-store",
  "spatial-core",
  "world-planning",
  "world-compiler",
  "asset-production",
  "asset-inspection",
  "asset-factory",
  "prepared-asset",
  "visual-catalog",
  "catalog-intelligence",
  "neural-asset",
  "reference-image",
  "region-composition",
  "studio-protocol",
  "studio-bridge",
  "cli",
];

async function sourceFiles() {
  const files = [...fixedInputs];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => compareStrings(left.name, right.name))) {
      const absolute = join(directory, entry.name);
      if (entry.isSymbolicLink())
        throw new Error(`Runtime build input must not be a symlink: ${absolute}`);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile() && entry.name.endsWith(".ts"))
        files.push(relative(root, absolute).split("\\").join("/"));
      else if (!entry.isFile())
        throw new Error(`Runtime build input must be a regular file: ${absolute}`);
    }
  }
  for (const packageName of PRODUCT_PACKAGE_ROOTS)
    await visit(resolve(root, "packages", packageName));
  return [...new Set(files)].sort();
}

function field(value) {
  const bytes = Buffer.from(value, "utf8");
  return Buffer.concat([Buffer.from(`${bytes.length}:`, "ascii"), bytes]);
}

export async function currentRuntimeBuildManifest() {
  const files = await sourceFiles();
  const hash = createHash("sha256");
  hash.update(field("basalt-world-compiler-build-v1"));
  for (const path of files) {
    const absolute = resolve(root, path);
    const status = await lstat(absolute);
    if (!status.isFile() || status.isSymbolicLink())
      throw new Error(`Runtime build input must be a regular non-symlink file: ${absolute}`);
    const bytes = await readFile(absolute);
    hash.update(field(path));
    hash.update(Buffer.from(`${bytes.length}:`, "ascii"));
    hash.update(bytes);
  }
  return Object.freeze({
    kind: "BasaltRuntimeBuildManifest",
    sourceHash: hash.digest("hex"),
    fileCount: files.length,
  });
}

export async function assertRuntimeBuildCurrent() {
  let status;
  try {
    status = await lstat(outputPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error("Basalt runtime build manifest is missing", {
        cause: error,
      });
    }
    throw error;
  }
  if (!status.isFile() || status.isSymbolicLink())
    throw new Error("Basalt runtime build manifest must be a regular non-symlink file");
  let stored;
  try {
    stored = JSON.parse(await readFile(outputPath, "utf8"));
  } catch {
    throw new Error("Basalt runtime build manifest is invalid");
  }
  const current = await currentRuntimeBuildManifest();
  if (
    stored?.kind !== current.kind ||
    stored?.sourceHash !== current.sourceHash ||
    stored?.fileCount !== current.fileCount
  )
    throw new Error("Basalt compiled runtime is stale");
  return current;
}

async function writeRuntimeBuildManifest() {
  const manifest = await currentRuntimeBuildManifest();
  await mkdir(dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.${process.pid}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporaryPath, outputPath);
  } finally {
    await unlink(temporaryPath).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(scriptPath)) {
  const option = process.argv[2];
  if (option === "--write" && process.argv.length === 3) await writeRuntimeBuildManifest();
  else if (option === "--check" && process.argv.length === 3) await assertRuntimeBuildCurrent();
  else throw new Error("Usage: node scripts/runtime-build-manifest.mjs --write|--check");
}
