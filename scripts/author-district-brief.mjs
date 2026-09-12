#!/usr/bin/env node
// Author the district spike brief: every block gets a foundation role
// (whole apartment buildings as scatter), a groundcover role (verge
// bushes), and a portal role (doors as scatter — a deliberate failure
// probe: doors cannot place meaningfully without assembly sockets).
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const plan = JSON.parse(
  readFileSync(resolve(repositoryRoot, "test/fixtures/district-region.plan.json"), "utf8"),
);
const partitions = plan.regions.map((region) => region.id);
const routeIds = plan.routes.map((route) => route.id);

const roleTable = [
  {
    role: "foundation",
    families: 1,
    semanticTags: ["apartment_buildings"],
    targetDensityPerHectare: 15,
    distribution: "poisson_scatter",
    maximumSlopeDegrees: 15,
  },
  {
    role: "groundcover",
    families: 1,
    semanticTags: ["tropical_bushes"],
    targetDensityPerHectare: 60,
    distribution: "poisson_scatter",
    maximumSlopeDegrees: 30,
  },
  {
    role: "portal",
    families: 1,
    semanticTags: ["apartment_doors"],
    targetDensityPerHectare: 10,
    distribution: "poisson_scatter",
    maximumSlopeDegrees: 30,
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
    maximumSlopeDegrees: entry.maximumSlopeDegrees,
    excludedRouteIds: routeIds,
  })),
);

const brief = {
  briefId: "district_spike",
  styleContract: {
    style_motif: "stylized_low_poly",
    edge_fidelity: "faceted",
    palette_tokens: ["plaza", "noon"],
    texel_density_target: 16,
  },
  roles,
};

const outputPath = resolve(repositoryRoot, "test/helpers/district-region.brief.json");
writeFileSync(outputPath, `${JSON.stringify(brief, null, 2)}\n`);
process.stdout.write(
  `District brief: ${roles.length} roles across ${partitions.length} partitions\n`,
);
