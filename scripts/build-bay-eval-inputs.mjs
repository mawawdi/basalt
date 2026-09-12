#!/usr/bin/env node
// Build terrain-only bay eval inputs: resolve the scrub/canopy requests to
// population plans, then zero their density so the eval lowers terrain,
// water, grass, tints, and roads with no catalog dependency. The synthetic
// grounding evidence is structurally valid but never places an instance;
// population still requires it to size the spacing grid. Pure and
// deterministic; validates its own output before writing.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertRuntimeBuildCurrent } from "./runtime-build-manifest.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
await assertRuntimeBuildCurrent();
const compiler = await import(
  pathToFileURL(resolve(repositoryRoot, "dist/packages/world-compiler/src/index.js")).href
);

function option(args, name) {
  const index = args.indexOf(name);
  if (index < 0 || index + 1 >= args.length) return undefined;
  return args[index + 1];
}

const args = process.argv.slice(2);
const planPath = option(args, "--plan");
const outDir = option(args, "--out-dir");
if (!planPath || !outDir)
  throw new Error(
    "Usage: node scripts/build-bay-eval-inputs.mjs -- --plan <bay-region.plan.json> --out-dir <dir>",
  );

const plan = JSON.parse(readFileSync(resolve(planPath), "utf8"));
const partitions = plan.regions.map((region) => region.id);
const routeIds = plan.routes.map((route) => route.id);
const registry = compiler.sealWorldAssetFamilyRegistry([
  {
    familyId: "BayScrub",
    semanticTags: ["scrub"],
    styleTags: ["coherent"],
    roleTags: ["scatter"],
    variantCount: 1,
  },
  {
    familyId: "BayCanopy",
    semanticTags: ["canopy"],
    styleTags: ["coherent"],
    roleTags: ["cluster"],
    variantCount: 1,
  },
]);
const plans = compiler.compileResolvedFamilyPopulationPlans({
  registry,
  requests: [
    {
      biomeId: "bay",
      semanticTags: ["scrub"],
      styleTags: ["coherent"],
      roleTags: ["scatter"],
      minimumFamilies: 1,
      maximumFamilies: 1,
      regionIds: partitions,
      surfaceKinds: ["terrain"],
      distribution: "poisson_scatter",
      maximumCount: 400,
      density: { minimum: 0, target: 0, maximum: 0 },
      variationSeed: 11,
      excludedRouteIds: routeIds,
      elevationBandStuds: { minimum: -1 },
      maximumSlopeDegrees: 10,
    },
    {
      biomeId: "bay",
      semanticTags: ["canopy"],
      styleTags: ["coherent"],
      roleTags: ["cluster"],
      minimumFamilies: 1,
      maximumFamilies: 1,
      regionIds: partitions,
      surfaceKinds: ["terrain"],
      distribution: "cluster",
      maximumCount: 200,
      density: { minimum: 0, target: 0, maximum: 0 },
      variationSeed: 23,
      excludedRouteIds: routeIds,
      elevationBandStuds: { minimum: 2 },
    },
  ],
});
const evidenceFor = (familyId) => ({
  familyId,
  archetypes: [
    {
      assetId: `${familyId}_asset_0`,
      boundsMinimumStuds: { x: -1, y: 0, z: -1 },
      boundsMaximumStuds: { x: 1, y: 4, z: 1 },
      contactRadiusStuds: 0.5,
    },
  ],
});
const evidence = compiler.GROUNDING_EVIDENCE_FILE_SCHEMA.parse({
  kind: "BasaltFamilyGroundingEvidence",
  abi: "basalt-family-grounding-evidence@1",
  inventoryHash: "0".repeat(64),
  evidence: [evidenceFor("BayScrub"), evidenceFor("BayCanopy")],
});

mkdirSync(resolve(outDir), { recursive: true });
writeFileSync(resolve(outDir, "families.json"), `${JSON.stringify(plans, null, 2)}\n`);
writeFileSync(resolve(outDir, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
process.stdout.write(`Bay eval inputs: ${plans.length} zero-density plans, 2 evidence entries\n`);
