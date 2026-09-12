#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertRuntimeBuildCurrent } from "./runtime-build-manifest.mjs";
import { catalogInventoryPath } from "./basalt-paths.mjs";

/** Code-unit string order. Locale-aware comparison must never feed sealed output. */
const compareStrings = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const inventoryPath = catalogInventoryPath(repositoryRoot);
const outputPath = resolve(
  repositoryRoot,
  ".basalt/asset-registry/catalog-admission-manifest.json",
);

async function main() {
  await assertRuntimeBuildCurrent(repositoryRoot);
  if (process.argv.length > 2)
    throw new Error("Usage: npm run visual:catalog:admit (no arguments; emits the full set)");
  const { assertCatalogInventoryIdentity } = await import(
    pathToFileURL(resolve(repositoryRoot, "dist/packages/catalog-intelligence/src/index.js")).href
  );
  const inventory = JSON.parse(await readFile(inventoryPath, "utf8"));
  assertCatalogInventoryIdentity(inventory);
  const candidates = inventory.assets
    .filter((asset) => asset.measurement.status === "measured" && asset.measurement.renderable)
    .sort((left, right) => compareStrings(left.record.assetId, right.record.assetId));
  const entries = candidates.map((asset) => ({
    assetId: asset.record.assetId,
    sourceFileHash: asset.record.sourceFileHash,
    status: asset.record.admissionStatus,
    reason:
      asset.record.admissionStatus === "locally_qualified"
        ? undefined
        : "Admission requires manifold geometry and texture evidence",
    familyIds: inventory.families
      .filter((family) =>
        family.archetypes.some((member) => member.assetId === asset.record.assetId),
      )
      .map((family) => family.familyId),
  }));
  const manifest = {
    kind: "CatalogAdmissionManifest",
    abi: "basalt-catalog-admission@1",
    inventoryHash: inventory.hash,
    entries,
  };
  await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  process.stdout.write(
    `${JSON.stringify({ output: outputPath, candidates: entries.length, locallyQualified: entries.filter((entry) => entry.status === "locally_qualified").length }, null, 2)}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(
    `Catalog admission failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
