#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, readdir, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const trustedRoot = resolve(repositoryRoot, "registry");
const manifestPath = resolve(trustedRoot, "source-manifest.json");

function argument(name, args, required = true) {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (required && (!value || value.startsWith("--"))) throw new Error(`Missing ${name}`);
  return value;
}

async function filesUnder(root) {
  const output = [];
  const visit = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        const info = await lstat(path);
        if (info.isSymbolicLink() || (await realpath(path)) !== path)
          throw new Error(`Symlinked source file rejected: ${path}`);
        output.push(path);
      }
    }
  };
  await visit(root);
  return output.sort((left, right) => left.localeCompare(right));
}

async function main() {
  const args = process.argv.slice(2);
  const packageId = argument("--package-id", args);
  const rootArgument = argument("--root", args);
  const sourceKind = argument("--source-kind", args, false) ?? "commercial_pack";
  const licenseId = argument("--license-id", args, false) ?? "commercial-use-permitted";
  const attribution =
    argument("--attribution", args, false) ??
    "Creator-provided commercial rights; no vendor attribution requested";
  const archivePaths = args.flatMap((value, index) =>
    value === "--archive" && args[index + 1] ? [args[index + 1]] : [],
  );
  const root = resolve(repositoryRoot, rootArgument);
  const trustedPrefix = `${trustedRoot}${sep}`;
  if (!root.startsWith(trustedPrefix)) throw new Error("--root must be inside registry");
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(root)) !== root)
    throw new Error("Source root must be a canonical directory");
  const files = await filesUnder(root);
  const records = [];
  for (const path of files) {
    const bytes = await readFile(path);
    records.push({
      relativePath: relative(repositoryRoot, path).split(sep).join("/"),
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  let manifest = {
    kind: "TrustedSourceManifest",
    abi: "basalt-trusted-sources@2",
    rightsNotice: "registry/rights-note.md",
    packages: [],
  };
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const packageEntry = {
    packageId,
    archivePaths,
    assetRoots: [relative(repositoryRoot, root).split(sep).join("/")],
    sourceKind,
    licenseId,
    commercialUsePermitted: true,
    redistributionPermitted: true,
    attribution,
    files: records,
  };
  const packages = manifest.packages.filter((entry) => entry.packageId !== packageId);
  packages.push(packageEntry);
  manifest = {
    ...manifest,
    packages: packages.sort((left, right) => left.packageId.localeCompare(right.packageId)),
  };
  await mkdir(trustedRoot, { recursive: true, mode: 0o700 });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  process.stdout.write(
    `${JSON.stringify({ manifest: manifestPath, packageId, files: records.length }, null, 2)}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(
    `Source registration failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
