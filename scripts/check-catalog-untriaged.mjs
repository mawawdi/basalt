#!/usr/bin/env node
// Every source asset must be declared in a family or recorded in quarantine
// with a reason. Files that are neither are untriaged backlog.
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = join("registry", "starter-assets");
const manifestPath = join("registry", "family-manifest.json");
const quarantinePath = join("registry", "quarantine.json");

const posix = (path) => path.split(sep).join("/");

async function walkFiles(directory) {
  const entries = await readdir(resolve(repositoryRoot, directory), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const next = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walkFiles(next)));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".glb")) files.push(posix(next));
  }
  return files;
}

const manifest = JSON.parse(await readFile(resolve(repositoryRoot, manifestPath), "utf8"));
const quarantine = JSON.parse(await readFile(resolve(repositoryRoot, quarantinePath), "utf8"));
const declared = new Set(
  manifest.families.flatMap((family) => family.members.map((member) => posix(member.sourcePath))),
);
const confinedPaths = quarantine.entries.map((entry) => posix(entry.relativePath));
const confined = new Set(confinedPaths);
const duplicates = confinedPaths.filter((path, index) => confinedPaths.indexOf(path) !== index);
const disk = await walkFiles(root);
const diskSet = new Set(disk);

const untriaged = disk.filter((file) => !declared.has(file) && !confined.has(file)).sort();
const stale = [...confined].filter((file) => !diskSet.has(file)).sort();
const conflict = [...declared].filter((file) => confined.has(file)).sort();

process.stdout.write(
  `Catalog triage: ${disk.length} files, ${declared.size} declared, ${confined.size} quarantined, ${untriaged.length} untriaged\n`,
);
for (const file of untriaged) process.stdout.write(`untriaged: ${file}\n`);
for (const file of stale) console.error(`drift: quarantine entry missing on disk: ${file}`);
for (const file of conflict) console.error(`drift: file both declared and quarantined: ${file}`);
for (const file of duplicates) console.error(`drift: duplicate quarantine entry: ${file}`);
if (untriaged.length > 0 || stale.length > 0 || conflict.length > 0 || duplicates.length > 0)
  process.exit(1);
