#!/usr/bin/env node
// Deterministic evidence-driven family cohort proposals. Reads the sealed
// inventory plus the declaration and quarantine records; emits cohort
// proposals for human review. Output is advisory: families exist only
// through authored declarations.
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertRuntimeBuildCurrent } from "./runtime-build-manifest.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const inventoryPath = resolve(repositoryRoot, ".basalt/catalog-cache/source-inventory.json");
const quarantinePath = resolve(repositoryRoot, "registry/quarantine.json");
const outputPath = resolve(repositoryRoot, ".basalt/catalog-cache/family-proposals.json");

function evidenceOf(asset) {
  return {
    assetId: asset.record.assetId,
    boundsStuds: asset.measurement.boundsStuds,
    triangleCount: asset.measurement.triangleCount,
    submeshCount: asset.measurement.submeshCount,
    primaryContact: asset.measurement.primaryContact,
    hasManifoldTopology: asset.measurement.hasManifoldTopology,
    topologicalGenus: asset.measurement.topologicalGenus,
    materialAppearanceHashes: asset.measurement.materialAppearanceHashes ?? [],
    sourceFileHash: asset.record.sourceFileHash,
  };
}

async function main() {
  await assertRuntimeBuildCurrent(repositoryRoot);
  const { stableJson } = await import(
    pathToFileURL(resolve(repositoryRoot, "dist/packages/contracts/src/index.js")).href
  );
  const { proposeFamilyCohorts } = await import(
    pathToFileURL(
      resolve(repositoryRoot, "dist/packages/catalog-intelligence/src/family-proposals.js"),
    ).href
  );
  const inventory = JSON.parse(await readFile(inventoryPath, "utf8"));
  const quarantine = JSON.parse(await readFile(quarantinePath, "utf8"));
  const memberIds = new Set(
    inventory.familyDeclarations.flatMap((declaration) =>
      declaration.members.map((member) => member.assetId),
    ),
  );
  const confined = new Set(quarantine.entries.map((entry) => entry.relativePath));
  const eligible = inventory.assets.filter(
    (asset) =>
      asset.measurement.status === "measured" &&
      asset.measurement.renderable &&
      !memberIds.has(asset.record.assetId) &&
      !confined.has(asset.source.relativePath),
  );
  const evidence = eligible.map(evidenceOf);

  // Byte-identical files: keep the lexicographically first path, flag the rest.
  const byHash = new Map();
  for (const asset of eligible) {
    const hash = asset.record.sourceFileHash;
    if (!byHash.has(hash)) byHash.set(hash, []);
    byHash.get(hash).push(asset);
  }
  const duplicateFlags = [];
  for (const [hash, group] of [...byHash.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (group.length < 2) continue;
    const ordered = [...group].sort((a, b) =>
      a.source.relativePath.localeCompare(b.source.relativePath),
    );
    for (const asset of ordered.slice(1))
      duplicateFlags.push({
        assetId: asset.record.assetId,
        relativePath: asset.source.relativePath,
        reason: `Byte-identical duplicate (sha256 ${hash.slice(0, 16)}) of ${ordered[0].source.relativePath}.`,
      });
  }

  const { cohorts, singletons, excluded } = proposeFamilyCohorts(evidence);
  const byId = new Map(eligible.map((asset) => [asset.record.assetId, asset]));
  const summarize = (assetId) => {
    const asset = byId.get(assetId);
    return {
      assetId,
      relativePath: asset.source.relativePath,
      boundsStuds: asset.measurement.boundsStuds.map((v) => Math.round(v * 100) / 100),
    };
  };
  const detailed = cohorts.map((cohort) => ({
    ...cohort,
    members: cohort.members.map(summarize),
  }));
  const proposals = {
    kind: "BasaltFamilyCohortProposals",
    abi: "basalt-family-proposals@1",
    inventoryHash: inventory.hash,
    eligibleAssets: eligible.length,
    cohorts: detailed,
    duplicateFlags,
    singletons: singletons.map(summarize),
    excluded: excluded.map((entry) => ({
      ...entry,
      relativePath: byId.get(entry.assetId).source.relativePath,
    })),
  };
  await writeFile(outputPath, `${stableJson(proposals)}\n`, { encoding: "utf8", mode: 0o600 });

  const lines = [
    `Family proposals: ${eligible.length} eligible assets -> ${detailed.length} cohorts, ${duplicateFlags.length} duplicate flags, ${singletons.length} singletons, ${excluded.length} excluded`,
  ];
  const bySize = [...detailed].sort(
    (a, b) => b.members.length - a.members.length || a.cohortId.localeCompare(b.cohortId),
  );
  const fmt = (bounds) => bounds.map((v) => v.toFixed(1)).join("x");
  for (const cohort of bySize)
    lines.push(
      `${cohort.cohortId} n=${cohort.members.length} aspect=${cohort.aspectCentroid.map((v) => v.toFixed(2)).join(",")} size=${fmt(cohort.sizeRange.minBounds)}..${fmt(cohort.sizeRange.maxBounds)} treat=${cohort.compatibleTreatments.join(",")}${cohort.splitCandidate ? " SPLIT-CANDIDATE" : ""}`,
    );
  process.stdout.write(`${lines.join("\n")}\n`);
}

main().catch((error) => {
  process.stderr.write(
    `Family proposal failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
