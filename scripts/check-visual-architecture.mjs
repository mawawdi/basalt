import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();

const GENERIC_ROOTS = [
  "packages/world-compiler/src",
  "packages/world-planning/src",
  "packages/asset-production/src",
  "packages/asset-factory/src",
  "packages/prepared-asset/src",
];
const SPATIAL_CORE_ROOTS = ["packages/world-compiler/src", "packages/world-planning/src"];
const WORLD_DCC_FORBIDDEN_ROOTS = ["packages/world-compiler/src", "packages/world-planning/src"];

const PRODUCT_INDEX_ROOTS = ["packages"];

const EXPERIMENT_EXPORT_PATTERN = /generative-planner|(?:^|[/\\])experimental(?:[/\\]|$)/i;
const FORBIDDEN_PRODUCT_PATTERNS = [
  {
    pattern: /export\s+\*\s+from\s+["'][^"']*asset-factory\/src\/index/i,
    reason:
      "the world compiler must depend on narrow asset contracts, not re-export an entire package barrel",
  },
  {
    pattern: /compileToRojoProject|run-generative-planner/i,
    reason: "prompt-to-Rojo/place generation creates a parallel visual authority",
  },
  {
    pattern: /\$className\s*:\s*["']Part["']/,
    reason: "visible primitive generation bypasses prepared assets",
  },
  {
    pattern: /\b(?:sanctuary|harbor|lighthouse|volcanic|conservatory|orbital|merchant)\b/i,
    reason: "fixture-specific vocabulary entered generic product code",
  },
  {
    pattern: /from\s+["'][^"']*game-runtime[/]/i,
    reason: "world compiler cannot depend on the deleted gameplay runtime",
  },
  {
    pattern: /compileBlenderScene(?:WithAutomaticRepair)?/i,
    reason: "world compiler cannot require full-scene Blender compilation",
  },
  {
    pattern: /wholeSceneRendering\s*:\s*true/i,
    reason: "asset finishing must never enable whole-scene rendering",
  },
];

const ALLOWED_SCRIPT_FILES = new Set([
  "scripts/check-rojo-builds.mjs",
  "scripts/check-visual-architecture.mjs",
]);

const failures = [];

async function walk(directory) {
  const entries = await fs.readdir(path.join(root, directory), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(relative)));
    else files.push(relative);
  }
  return files;
}

async function readText(relative) {
  return fs.readFile(path.join(root, relative), "utf8");
}

async function checkGenericProductSources() {
  for (const directory of GENERIC_ROOTS) {
    let files;
    try {
      files = await walk(directory);
    } catch {
      continue;
    }
    for (const relative of files) {
      if (!/\.(?:ts|tsx|js|mjs)$/.test(relative)) continue;
      const text = await readText(relative);
      for (const { pattern, reason } of FORBIDDEN_PRODUCT_PATTERNS) {
        if (pattern.test(text)) {
          failures.push(`${relative}: ${reason}`);
        }
      }
    }
  }
}

async function checkSpatialCoreBoundary() {
  for (const directory of SPATIAL_CORE_ROOTS) {
    let files;
    try {
      files = await walk(directory);
    } catch {
      continue;
    }
    for (const relative of files) {
      if (!/\.(?:ts|tsx|js|mjs)$/.test(relative)) continue;
      const text = await readText(relative);
      if (/from\s+["'][^"']*\/game-(?:compiler|composition|identity|ir)[/]/i.test(text))
        failures.push(
          `${relative}: spatial core cannot import gameplay AST or composition packages`,
        );
    }
  }
}

async function checkWorldCompilerDccBoundary() {
  for (const directory of WORLD_DCC_FORBIDDEN_ROOTS) {
    let files;
    try {
      files = await walk(directory);
    } catch {
      continue;
    }
    for (const relative of files) {
      if (!/\.(?:ts|tsx|js|mjs)$/.test(relative)) continue;
      const text = await readText(relative);
      if (/from\s+["'][^"']*blender-compiler\//i.test(text))
        failures.push(
          `${relative}: world compilation must use asset-local finishing contracts, never the full-scene Blender package`,
        );
    }
  }
}

async function checkPackageExports() {
  for (const directory of PRODUCT_INDEX_ROOTS) {
    let files;
    try {
      files = await walk(directory);
    } catch {
      continue;
    }
    for (const relative of files) {
      if (!/\/src\/index\.ts$/.test(relative)) continue;
      const text = await readText(relative);
      if (EXPERIMENT_EXPORT_PATTERN.test(text)) {
        failures.push(`${relative}: experiment code is exported from a product package`);
      }
    }
  }
}

async function checkPromptRojoScripts() {
  let files;
  try {
    files = await walk("scripts");
  } catch {
    return;
  }
  for (const relative of files) {
    if (!/\.(?:js|mjs|ts)$/.test(relative) || ALLOWED_SCRIPT_FILES.has(relative)) continue;
    const text = await readText(relative);
    if (/rojo\s+build/i.test(text) && /prompt|generative|world|scene/i.test(text)) {
      failures.push(
        `${relative}: prompt/world script invokes Rojo directly; use the canonical visual pipeline`,
      );
    }
  }
}

async function checkKnownExperimentLocations() {
  const forbidden = ["scripts/run-generative-planner.mjs", "examples/generative-open-world"];
  for (const relative of forbidden) {
    try {
      await fs.access(path.join(root, relative));
      failures.push(
        `${relative}: generated experiment is in a product path; move it to an explicit research/run directory`,
      );
    } catch {
      // Absent experiment paths are the expected product state.
    }
  }
}

await checkGenericProductSources();
await checkSpatialCoreBoundary();
await checkWorldCompilerDccBoundary();
await checkPackageExports();
await checkPromptRojoScripts();
await checkKnownExperimentLocations();

if (failures.length > 0) {
  console.error("Visual architecture check failed:");
  for (const failure of [...new Set(failures)].sort()) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log("Visual architecture check passed.");
}
