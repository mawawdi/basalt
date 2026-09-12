#!/usr/bin/env node
// Verifies starter-assets/ mirrors the family manifest one-to-one: each declared
// family owns exactly one folder containing exactly its declared members, and
// every undeclared source lives under _pending/. Folders are a verified
// projection of the manifests, never an input: the pipeline infers nothing
// from paths.
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const baseDir = process.argv[4] ? resolve(process.argv[4]) : repositoryRoot;
const root = process.argv[2] ?? join("registry", "starter-assets");
const manifestPath = process.argv[3] ?? join("registry", "family-manifest.json");

function posix(path) {
  return path.split(sep).join("/");
}

async function walkFiles(directory) {
  const entries = await readdir(resolve(baseDir, directory), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const next = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walkFiles(next)));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".glb")) files.push(next);
  }
  return files;
}

const manifest = JSON.parse(await readFile(resolve(baseDir, manifestPath), "utf8"));
const declaredPaths = new Set();
const drift = [];
for (const family of manifest.families) {
  const dir = posix(join(root, family.familyName));
  for (const member of family.members) {
    declaredPaths.add(posix(member.sourcePath));
    if (posix(dirname(member.sourcePath)) !== dir)
      drift.push(`member ${member.sourcePath} is declared outside ${dir}/`);
  }
}

const diskFiles = new Set((await walkFiles(root)).map(posix));
for (const declared of declaredPaths)
  if (!diskFiles.has(declared)) drift.push(`missing on disk: ${declared}`);
for (const disk of diskFiles) {
  if (declaredPaths.has(disk)) continue;
  if (!disk.startsWith(`${posix(root)}/_pending/`))
    drift.push(`undeclared file outside _pending/: ${disk}`);
}
for (const declared of declaredPaths)
  if (declared.startsWith(`${posix(root)}/_pending/`))
    drift.push(`declared member inside _pending/: ${declared}`);

if (drift.length > 0) {
  for (const line of drift) console.error(`drift: ${line}`);
  process.exit(1);
}
process.stdout.write(
  `Catalog layout mirrors ${manifest.families.length} families (${diskFiles.size} files)\n`,
);
