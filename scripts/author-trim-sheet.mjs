#!/usr/bin/env node
// Authors the shared quad-strip trim sheet from sealed member measurements.
// Band centers are placed by deterministic greedy set-cover over member
// (aspect, area) points, so the layout regenerates byte-identically from the
// same sealed membership. The 0.45 energy gate decides per member at seal.
// Band material classes are layout placeholders until per-member material
// evidence exists.
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertRuntimeBuildCurrent } from "./runtime-build-manifest.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const inventoryPath = resolve(repositoryRoot, ".basalt/catalog-cache/source-inventory.json");
const outputPath = resolve(repositoryRoot, "registry/trim-sheet.json");

const MAX_BANDS = 128;
const MAX_ENERGY = 0.45;
const MATERIAL_CLASSES = ["wood", "foliage", "metal", "stone"];

async function main() {
  await assertRuntimeBuildCurrent(repositoryRoot);
  const { contentHash, stableJson } = await import(
    pathToFileURL(resolve(repositoryRoot, "dist/packages/contracts/src/index.js")).href
  );
  const { STUD_METERS } = await import(
    pathToFileURL(resolve(repositoryRoot, "dist/packages/basalt-types/src/fixed.js")).href
  );
  const { TRIM_SHEET_SPECIFICATION_SCHEMA, selectHotspotTrimBand } = await import(
    pathToFileURL(resolve(repositoryRoot, "dist/packages/asset-factory/src/trim-sheet.js")).href
  );
  const inventory = JSON.parse(await readFile(inventoryPath, "utf8"));
  const assetsById = new Map(inventory.assets.map((asset) => [asset.record.assetId, asset]));
  const points = inventory.families
    .flatMap((family) =>
      family.archetypes.map((member) => {
        const measurement = assetsById.get(member.assetId)?.measurement;
        const [x, y, z] = measurement.boundsStuds;
        return {
          assetId: member.assetId,
          aspectRatio: Math.max(x, z) / Math.max(y, 1e-6),
          surfaceArea: measurement.surfaceAreaStuds2 * STUD_METERS ** 2,
        };
      }),
    )
    .sort(
      (left, right) => left.aspectRatio - right.aspectRatio || left.surfaceArea - right.surfaceArea,
    );
  const energy = (point, center) =>
    Math.abs(Math.log(point.aspectRatio / center.aspectRatio)) +
    1.5 * Math.abs(point.surfaceArea / center.surfaceArea - 1);
  const covers = points.map((center) => {
    const covered = new Set();
    points.forEach((point, index) => {
      if (energy(point, center) <= MAX_ENERGY) covered.add(index);
    });
    return covered;
  });
  const uncovered = new Set(points.map((_, index) => index));
  const centers = [];
  while (uncovered.size > 0 && centers.length < MAX_BANDS) {
    let best = -1;
    let bestCount = 0;
    for (let candidate = 0; candidate < points.length; candidate += 1) {
      let count = 0;
      for (const index of covers[candidate]) if (uncovered.has(index)) count += 1;
      if (count > bestCount) {
        bestCount = count;
        best = candidate;
      }
    }
    if (best < 0) break;
    centers.push(points[best]);
    for (const index of covers[best]) uncovered.delete(index);
  }
  const bands = centers.map((center, order) => ({
    bandId: `trim_band_${String(order + 1).padStart(3, "0")}`,
    semanticRoles: [MATERIAL_CLASSES[order % MATERIAL_CLASSES.length]],
    uMin: 0,
    vMin: order / centers.length,
    uMax: 1,
    vMax: (order + 1) / centers.length,
    tilingAxis: "v",
    metricWidth: Math.sqrt(center.aspectRatio * center.surfaceArea),
    metricHeight: Math.sqrt(center.surfaceArea / center.aspectRatio),
  }));
  const bandHash = contentHash(stableJson(bands));
  const spec = TRIM_SHEET_SPECIFICATION_SCHEMA.parse({
    kind: "TrimSheetSpecification",
    abi: "basalt-trim-sheet@1",
    id: `shared_trim_sheet_${bandHash.slice(0, 12)}`,
    trimAtlasHandle: bandHash,
    resolution: { width: 2048, height: 2048 },
    targetTexelDensity: 512,
    bands,
  });
  await writeFile(outputPath, `${JSON.stringify(spec, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  let mapped = 0;
  let rejected = 0;
  for (const point of points) {
    const mapping = selectHotspotTrimBand(
      { assetId: point.assetId, aspectRatio: point.aspectRatio, surfaceArea: point.surfaceArea },
      bands,
    );
    if (mapping) mapped += 1;
    else rejected += 1;
  }
  process.stdout.write(
    `${JSON.stringify({ output: outputPath, specId: spec.id, bands: bands.length, mapped, rejected }, null, 2)}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(
    `Trim sheet authoring failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
