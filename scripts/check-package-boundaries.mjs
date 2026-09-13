import { readFile, readdir } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packagesRoot = resolve(root, "packages");
const allowed = new Map(
  Object.entries({
    contracts: [],
    "artifact-store": ["contracts"],
    "spatial-core": ["contracts"],
    "semantic-kernel": ["contracts"],
    "catalog-model": ["contracts", "semantic-kernel"],
    "catalog-authoring": ["contracts", "catalog-model", "semantic-kernel"],
    "asset-inspection": ["catalog-model", "contracts", "spatial-core"],
    "asset-production": ["contracts"],
    "asset-factory": ["contracts", "catalog-model"],
    "neural-asset": ["asset-factory", "contracts"],
    "reference-image": ["contracts"],
    "authoring-graph": ["artifact-store", "contracts", "spatial-core"],
    "world-planning": ["catalog-model", "contracts", "semantic-kernel", "spatial-core"],
    "region-composition": ["contracts", "world-planning"],
    "world-compiler": [
      "catalog-model",
      "contracts",
      "semantic-kernel",
      "spatial-core",
      "world-planning",
    ],
    roblox: ["artifact-store", "contracts", "spatial-core", "world-compiler"],
    cli: [
      "artifact-store",
      "asset-inspection",
      "catalog-authoring",
      "catalog-model",
      "contracts",
      "neural-asset",
      "roblox",
      "semantic-kernel",
      "world-compiler",
      "world-planning",
    ],
  }),
);
const removed = [
  "basalt-types",
  "catalog-intelligence",
  "prepared-asset",
  "studio-bridge",
  "studio-protocol",
  "visual-catalog",
];
const failures = [];
const schemaOwners = new Map();

for (const [packageName, allowedDependencies] of allowed) {
  const directory = resolve(packagesRoot, packageName);
  const manifest = JSON.parse(await readFile(resolve(directory, "package.json"), "utf8"));
  if (manifest.name !== `@basalt/${packageName}` || manifest.private !== true)
    failures.push(`${packageName}: manifest identity or private flag is invalid`);
  const declared = Object.keys(manifest.dependencies ?? {})
    .filter((name) => name.startsWith("@basalt/"))
    .map((name) => name.slice("@basalt/".length))
    .sort();
  if (JSON.stringify(declared) !== JSON.stringify([...allowedDependencies].sort()))
    failures.push(`${packageName}: declared Basalt dependencies differ from the architecture`);
  for (const path of await sourceFiles(resolve(directory, "src"))) {
    const source = await readFile(path, "utf8");
    if (
      !["roblox", "cli"].includes(packageName) &&
      /\b(?:ROBLOX|Roblox|studs?|Studs?)\b/u.test(source)
    )
      failures.push(`${relative(root, path)}: Roblox units or identity escaped the adapter`);
    if (/\b(?:abi|schemaVersion|parentRevision)\b|@2/u.test(source))
      failures.push(`${relative(root, path)}: Basalt-owned contract versioning is forbidden`);
    if (/from\s+["'][^"']*(?:\/test\/|\/scripts\/|\/fixtures\/)/u.test(source))
      failures.push(`${relative(root, path)}: production code imports a fixture or tool`);
    for (const match of source.matchAll(/export\s+const\s+([A-Z][A-Z0-9_]*_SCHEMA)\b/gu)) {
      const owner = schemaOwners.get(match[1]);
      if (owner && owner !== packageName)
        failures.push(`${match[1]} has duplicate owners: ${owner}, ${packageName}`);
      schemaOwners.set(match[1], packageName);
    }
    for (const match of source.matchAll(/from\s+["']([^"']+)["']/gu)) {
      const specifier = match[1];
      if (specifier.startsWith("@basalt/")) {
        const dependency = specifier.slice("@basalt/".length).split("/")[0];
        if (specifier !== `@basalt/${dependency}`)
          failures.push(`${relative(root, path)}: internal package deep import ${specifier}`);
        if (!allowedDependencies.includes(dependency))
          failures.push(`${relative(root, path)}: forbidden edge ${packageName} -> ${dependency}`);
      } else if (specifier.startsWith(".")) {
        const target = resolve(dirname(path), specifier);
        const relation = relative(directory, target);
        if (relation === ".." || relation.startsWith(`..${sep}`))
          failures.push(`${relative(root, path)}: relative import crosses a package boundary`);
      }
    }
  }
}

for (const packageName of removed)
  if ((await sourceFiles(resolve(packagesRoot, packageName))).length > 0)
    failures.push(`removed package still owns source: ${packageName}`);

if (failures.length > 0) {
  for (const failure of [...new Set(failures)].sort()) console.error(failure);
  process.exitCode = 1;
} else {
  console.log(
    `Package boundaries are valid (${allowed.size} workspaces, ${schemaOwners.size} public schemas).`,
  );
}

async function sourceFiles(directory) {
  try {
    const files = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === "dist") continue;
      const child = resolve(directory, entry.name);
      if (entry.isDirectory()) files.push(...(await sourceFiles(child)));
      else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(child);
    }
    return files.sort();
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}
