#!/usr/bin/env node
// Author the coastal bay palette brief: every partition gets canopy,
// groundcover, clutter, and foundation roles with curated catalog tags,
// per-hectare densities, and shoreline/slope/road placement bounds. Roles
// share tags across partitions so resolution dedupes to nine families.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const plan = JSON.parse(
  readFileSync(resolve(repositoryRoot, "test/fixtures/bay-region.plan.json"), "utf8"),
);
const partitions = plan.regions.map((region) => region.id);
const routeIds = plan.routes.map((route) => route.id);

const roleTable = [
  {
    role: "canopy",
    families: 3,
    semanticTags: ["palm_trees", "mangrove_trees", "large_jungle_trees"],
    targetDensityPerHectare: 40,
    distribution: "cluster",
    elevationBandStuds: { minimum: 0 },
    maximumSlopeDegrees: 30,
  },
  {
    role: "groundcover",
    families: 3,
    semanticTags: ["tropical_bushes", "tropical_ferns", "palm_bushes"],
    targetDensityPerHectare: 500,
    distribution: "poisson_scatter",
    elevationBandStuds: { minimum: -1 },
    maximumSlopeDegrees: 35,
  },
  {
    role: "clutter",
    families: 1,
    semanticTags: ["small_rocks"],
    targetDensityPerHectare: 100,
    distribution: "poisson_scatter",
  },
  {
    role: "foundation",
    families: 2,
    semanticTags: ["water_edge_rocks", "medium_rocks"],
    targetDensityPerHectare: 60,
    distribution: "poisson_scatter",
  },
];

const roles = partitions.flatMap((regionId) =>
  roleTable.map((entry) => ({
    regionId,
    role: entry.role,
    families: entry.families,
    semanticTags: entry.semanticTags,
    targetDensityPerHectare: entry.targetDensityPerHectare,
    distribution: entry.distribution,
    ...(entry.elevationBandStuds ? { elevationBandStuds: entry.elevationBandStuds } : {}),
    ...(entry.maximumSlopeDegrees !== undefined
      ? { maximumSlopeDegrees: entry.maximumSlopeDegrees }
      : {}),
    excludedRouteIds: routeIds,
  })),
);

const brief = {
  briefId: "bay_coast",
  styleContract: {
    style_motif: "stylized_low_poly",
    edge_fidelity: "faceted",
    palette_tokens: ["lagoon", "noon"],
    texel_density_target: 16,
  },
  roles,
};

const outputPath = resolve(repositoryRoot, "test/helpers/bay-region.brief.json");
writeFileSync(outputPath, `${JSON.stringify(brief, null, 2)}\n`);
process.stdout.write(`Bay brief: ${roles.length} roles across ${partitions.length} partitions\n`);
