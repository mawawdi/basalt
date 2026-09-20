import { readFile } from "node:fs/promises";

const checks = [
  {
    path: "packages/world-compiler/src/construction.ts",
    forbidden: [/65_536/u, /count\s*>\s*\d+/u],
  },
  {
    path: "packages/catalog-authoring/src/context.ts",
    forbidden: [/CATALOG_CONTEXT_MAX_CANDIDATES/u, /slice\(0,\s*31\)/u, /offset\s*\+=\s*32/u],
  },
  {
    path: "packages/catalog-authoring/src/policy.ts",
    forbidden: [
      /lexicalCandidateLimit/u,
      /embeddingCandidateLimit/u,
      /maximumResults/u,
      /maximumValidationCandidates/u,
      /acceptanceNumber:[^\n]+\.max\(/u,
      /maximumCandidatePoolSize/u,
    ],
  },
  {
    path: "packages/catalog-authoring/src/qualification-authoring.ts",
    forbidden: [/\.max\(132\)/u, /\.max\(96\)/u],
  },
  {
    path: "packages/catalog-model/src/requirements.ts",
    forbidden: [/maximumInstances/u],
  },
  {
    path: "packages/catalog-authoring/src/worker-contracts.ts",
    forbidden: [/CATALOG_CONTEXT_MAX_CANDIDATES/u, /CATALOG_WORKER_MAX_ASSETS/u],
  },
  {
    path: "workers/catalog-metadata/worker.py",
    forbidden: [/MAX_CONTEXT_CANDIDATES/u, /MAX_ITEMS/u, /MAX_EVIDENCE_FILES/u],
  },
  {
    path: "packages/asset-inspection/src/placement-geometry.ts",
    forbidden: [/triangles\.length\s*>/u, /Math\.min\(64/u],
  },
  {
    path: "packages/asset-inspection/src/catalog-measurement.ts",
    forbidden: [/fits\.slice\(0/u],
  },
  {
    path: "packages/world-compiler/src/compiler.ts",
    forbidden: [/ring\s*<=\s*4/u, /direction\s*<\s*16/u, /cells\.length\s*\*\s*8/u],
  },
  {
    path: "packages/world-compiler/src/terrain-foundation.ts",
    forbidden: [/probe_budget/u, /requiredProbes/u],
  },
  {
    path: "packages/world-refinement/src/verifiers.ts",
    forbidden: [/probeBudget/u],
  },
  {
    path: "scripts/world-preview-views.mjs",
    forbidden: [/cameras:\s*z\.array\([^\n]+\.max\(/u],
  },
  {
    path: "scripts/preview-world.mjs",
    forbidden: [/100_000/u, /256\s*\*\s*1024\s*\*\s*1024/u, /32\s*\*\s*1024\s*\*\s*1024/u],
  },
  {
    path: "packages/roblox/src/protocol.ts",
    forbidden: [
      /instances:\s*z\.array\([^\n]+\.max\(/u,
      /transactions:\s*z\.array\([^\n]+\.max\(/u,
      /constructedElements:\s*z\.array\([^\n]+\.max\(/u,
    ],
  },
  {
    path: "packages/spatial-core/src/occupancy.ts",
    forbidden: [/narrowPhaseObbs:\s*z\.array\([^\n]+\.max\(/u],
  },
  {
    path: "packages/authoring-graph/src/index.ts",
    forbidden: [
      /dependencies:\s*z\.array\([^\n]+\.max\(/u,
      /intentHandles:\s*z\.array\([^\n]+\.max\(/u,
      /records:\s*z\.array\([^\n]+\.max\(/u,
    ],
  },
  {
    path: "scripts/prompt-region-pilot.mjs",
    forbidden: [/budget-seconds/u, /withinTarget/u],
  },
];

const failures = [];
for (const check of checks) {
  const source = await readFile(check.path, "utf8");
  for (const pattern of check.forbidden)
    if (pattern.test(source))
      failures.push(`${check.path}: forbidden semantic capacity ${pattern}`);
}

if (failures.length > 0) {
  for (const failure of failures) console.error(failure);
  process.exitCode = 1;
} else {
  console.log("Semantic capacity boundaries are policy-driven.");
}
