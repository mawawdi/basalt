#!/usr/bin/env node
// Advisory review hints (NOT grouping decisions): pre-split evidence cohorts
// by vendor source organization (directory + filename stem) and flag
// same-stem members scattered across cohorts as merge candidates. Hints are
// review aids only: membership is decided by the author and admitted by the
// path-free kind seal, and no hint label ever enters a Basalt contract.
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertRuntimeBuildCurrent } from "./runtime-build-manifest.mjs";

/** Code-unit string order. Locale-aware comparison must never feed sealed output. */
const compareStrings = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const proposalsPath = resolve(repositoryRoot, ".basalt/catalog-cache/family-proposals.json");
const outputPath = resolve(repositoryRoot, ".basalt/catalog-cache/review-hints.json");

function hintKey(relativePath) {
  const segments = relativePath.split("/");
  const dir = segments.length >= 2 ? segments[segments.length - 2] : "";
  let stem = segments[segments.length - 1].replace(/\.glb$/i, "");
  stem = stem.replace(/--[0-9a-f]{6,}$/i, "");
  stem = stem.replace(/_\d+$/, "");
  stem = stem.replace(/^SM_/, "");
  return { dir, stem, label: `${dir}/${stem}` };
}

async function main() {
  await assertRuntimeBuildCurrent(repositoryRoot);
  const { stableJson } = await import(
    pathToFileURL(resolve(repositoryRoot, "dist/packages/contracts/src/index.js")).href
  );
  const proposals = JSON.parse(await readFile(proposalsPath, "utf8"));
  const splits = [];
  const stemCohorts = new Map();
  for (const cohort of proposals.cohorts) {
    const groups = new Map();
    for (const member of cohort.members) {
      const key = hintKey(member.relativePath).label;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(member.assetId);
    }
    for (const key of groups.keys()) {
      if (!stemCohorts.has(key)) stemCohorts.set(key, []);
      stemCohorts.get(key).push(cohort.cohortId);
    }
    if (groups.size < 2) continue;
    splits.push({
      cohortId: cohort.cohortId,
      memberCount: cohort.members.length,
      groups: [...groups.entries()]
        .sort(([a], [b]) => compareStrings(a, b))
        .map(([label, assetIds]) => ({
          label,
          memberCount: assetIds.length,
          members: [...assetIds].sort((a, b) => compareStrings(a, b)),
        })),
    });
  }
  const mergeCandidates = [...stemCohorts.entries()]
    .filter(([, cohortIds]) => new Set(cohortIds).size > 1)
    .sort(([a], [b]) => compareStrings(a, b))
    .map(([label, cohortIds]) => ({
      label,
      cohortIds: [...new Set(cohortIds)].sort((a, b) => compareStrings(a, b)),
    }));
  const hints = {
    kind: "BasaltReviewHints",
    abi: "basalt-review-hints@1",
    inventoryHash: proposals.inventoryHash,
    advisory: true,
    splits,
    mergeCandidates,
  };
  await writeFile(outputPath, `${stableJson(hints)}\n`, { encoding: "utf8", mode: 0o600 });
  const lines = [
    `Review hints (advisory only): ${splits.length} cohorts pre-split, ${mergeCandidates.length} cross-cohort merge candidates`,
  ];
  for (const split of splits)
    lines.push(
      `${split.cohortId} n=${split.memberCount} -> ${split.groups.map((g) => `${g.label}×${g.memberCount}`).join(" ")}`,
    );
  for (const merge of mergeCandidates.slice(0, 20))
    lines.push(`merge? ${merge.label}: ${merge.cohortIds.join(" ")}`);
  if (mergeCandidates.length > 20)
    lines.push(`... +${mergeCandidates.length - 20} more merge candidates in review-hints.json`);
  process.stdout.write(`${lines.join("\n")}\n`);
}

main().catch((error) => {
  process.stderr.write(
    `Review hints failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
