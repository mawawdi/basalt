import { readFile, readdir, stat } from "node:fs/promises";
import { extname, resolve } from "node:path";

const roots = ["packages", "workers", "plugin/src", "scripts", "bin"];
const productionConfigFiles = ["package.json", "tsconfig.json"];
const genericRoots = [
  "packages/authoring-graph",
  "packages/asset-factory",
  "packages/asset-production",
  "packages/prepared-asset",
  "packages/world-planning",
  "packages/world-compiler",
  "packages/spatial-core",
  "workers/asset-adaptation",
];
const allowedExtensions = new Set([".ts", ".tsx", ".js", ".mjs", ".py", ".json", ".luau"]);
const forbiddenCreativeAnchors = [
  "last light",
  "landmark.reactor",
  "socket.reactor",
  "connecting the airlock",
  "orchid-canary-v7",
  "glasswhale-canary-v3",
];
const forbiddenDependencyParts = ["/test/", "/benchmarks/", "/fixtures/", "/evaluator/"];
const forbiddenLegacyContracts = [
  {
    pattern: /["'`](?:generated_program|neural|remote_neural)["'`]/u,
    label: "a removed visual route or execution-class literal",
  },
  {
    pattern: /\bRawAssetCandidate\b/u,
    label: "the removed RawAssetCandidate contract",
  },
  {
    pattern: /\basset-composition-factories\b/u,
    label: "a removed visual production package",
  },
  {
    pattern: /\b(?:PreparedAsset@1|basalt-prepared-asset@1)\b/u,
    label: "a removed prepared-asset ABI",
  },
];
const fixtureVocabulary = [
  "harbor",
  "town",
  "quay",
  "medieval",
  "volcanic",
  "extraction",
  "conservatory",
  "orbital",
  "laboratory",
  "watchtower",
  "merchant",
  "mossy",
];
const violations = [];

for (const root of roots) {
  for (const file of await walk(resolve(root))) {
    if (!allowedExtensions.has(extname(file))) continue;
    if (relative(file) === "scripts/check-authoring-generality.mjs") continue;
    const text = await readFile(file, "utf8");
    const lower = text.toLowerCase();
    for (const anchor of forbiddenCreativeAnchors)
      if (lower.includes(anchor))
        violations.push(`${relative(file)} contains creative anchor ${anchor}`);
    checkRemovedContracts(file, text);
    if (file.includes("/packages/")) {
      for (const specifier of importSpecifiers(text)) {
        if (forbiddenDependencyParts.some((part) => specifier.includes(part)))
          violations.push(`${relative(file)} imports forbidden generic dependency ${specifier}`);
      }
    }
  }
}

for (const file of productionConfigFiles.map((path) => resolve(path))) {
  checkRemovedContracts(file, await readFile(file, "utf8"));
}

for (const root of genericRoots) {
  for (const file of await walk(resolve(root))) {
    if (!allowedExtensions.has(extname(file))) continue;
    const text = await readFile(file, "utf8");
    for (const noun of fixtureVocabulary) {
      const pattern = new RegExp(`\\b${noun}\\b`, "iu");
      if (pattern.test(text))
        violations.push(`${relative(file)} contains fixture vocabulary ${noun}`);
    }
  }
}

if (violations.length)
  throw new Error(`Authoring generality boundary failed:\n${violations.join("\n")}`);
process.stdout.write(
  "Authoring generality boundary passed: no evaluator canaries, fixture vocabulary, example anchors, removed visual contracts, or forbidden generic imports.\n",
);

function importSpecifiers(text) {
  const matches = [];
  const pattern =
    /(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/gu;
  for (const match of text.matchAll(pattern)) matches.push(match[1] ?? match[2]);
  return matches;
}

function checkRemovedContracts(file, text) {
  for (const legacy of forbiddenLegacyContracts)
    if (legacy.pattern.test(text)) violations.push(`${relative(file)} contains ${legacy.label}`);
}

async function walk(root) {
  const result = [];
  for (const name of (await readdir(root)).sort()) {
    const path = resolve(root, name);
    const info = await stat(path);
    if (info.isDirectory()) result.push(...(await walk(path)));
    else if (info.isFile()) result.push(path);
  }
  return result;
}

function relative(path) {
  return path.slice(resolve(".").length + 1);
}
