#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertRuntimeBuildCurrent } from "./runtime-build-manifest.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(dirname(scriptPath), "..");
const sourceManifestPath = resolve(repositoryRoot, ".basalt/trusted-sources/source-manifest.json");
const kenneyCatalogPath = resolve(repositoryRoot, ".basalt/kenney-catalog-v1.json");
const outputPath = resolve(repositoryRoot, ".basalt/catalog-cache-v1/source-inventory.json");

function slug(value) {
  return (
    value
      .normalize("NFC")
      .toLocaleLowerCase("en-US")
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-+|-+$/gu, "") || "source"
  );
}

function tagsFor(kit, fileName) {
  return [
    ...new Set(
      `${kit} ${fileName}`
        .replace(/\.[a-z0-9]+$/iu, "")
        .split(/[^a-z0-9]+/iu)
        .map((value) => value.toLocaleLowerCase("en-US"))
        .filter((value) => value.length > 1),
    ),
  ].sort((left, right) => left.localeCompare(right));
}

function catalogAssetId(contentHash, sourceKey) {
  return `catalog_${createHash("sha256").update(`${contentHash}:${sourceKey}`).digest("hex").slice(0, 32)}`;
}

async function main() {
  await assertRuntimeBuildCurrent(repositoryRoot);
  const { contentHash, stableJson } = await import(
    pathToFileURL(resolve(repositoryRoot, "dist/packages/contracts/src/index.js")).href
  );
  const { deriveFamilyHint } = await import(
    pathToFileURL(resolve(repositoryRoot, "dist/packages/catalog-intelligence/src/family-hints.js"))
      .href
  );
  const { sealCatalogInventory } = await import(
    pathToFileURL(resolve(repositoryRoot, "dist/packages/catalog-intelligence/src/contracts.js"))
      .href
  );

  const sourceManifest = JSON.parse(await readFile(sourceManifestPath, "utf8"));
  const kenneyCatalog = JSON.parse(await readFile(kenneyCatalogPath, "utf8"));
  const sourceManifestHash = contentHash(stableJson(sourceManifest));
  const assets = [];
  const familyMembers = new Map();

  const addAsset = (asset, hint) => {
    assets.push(asset);
    const existing = familyMembers.get(hint.familyId) ?? {
      familyId: hint.familyId,
      kitId: hint.kitId,
      familyKey: hint.familyKey,
      memberAssetIds: [],
      roleTags: new Set(),
    };
    existing.memberAssetIds.push(asset.assetId);
    for (const tag of hint.roleTags) existing.roleTags.add(tag);
    familyMembers.set(hint.familyId, existing);
  };

  for (const packageEntry of sourceManifest.packages) {
    const archiveName = basename(packageEntry.archivePath);
    const packageId = `kit_${slug(archiveName.replace(/\[Standard\]\.zip$/iu, ""))}`;
    for (const file of packageEntry.files) {
      if (!/\.gltf$/iu.test(file.relativePath)) continue;
      const tags = tagsFor(archiveName, file.relativePath);
      const hint = deriveFamilyHint({ kit: archiveName, fileName: file.relativePath, tags });
      addAsset(
        {
          kind: "CatalogAssetRecord",
          abi: "basalt-catalog-intelligence@1",
          assetId: catalogAssetId(file.sha256, `${packageId}/${file.relativePath}`),
          source: {
            kind: "quaternius_trusted",
            packageId,
            relativePath: `archive:${archiveName}/${file.relativePath}`,
            contentHash: file.sha256,
            licenseId: "CC0-1.0",
            commercialUsePermitted: true,
            redistributionPermitted: true,
            attribution: packageEntry.attribution,
          },
          tags,
          familyHint: {
            kitId: hint.kitId,
            familyKey: hint.familyKey,
            confidence: "derived_hint",
          },
          measurement: {
            status: "pending",
            reason: "Awaiting fixed offline geometry and material measurement worker",
          },
        },
        hint,
      );
    }
  }

  for (const kit of kenneyCatalog.kits) {
    const kitId = `kit_${slug(kit.name)}`;
    for (const model of kit.models) {
      const tags = model.tags;
      const hint = deriveFamilyHint({ kit: kit.name, fileName: model.relativePath, tags });
      addAsset(
        {
          kind: "CatalogAssetRecord",
          abi: "basalt-catalog-intelligence@1",
          assetId: catalogAssetId(model.sha256, `${kitId}/${model.relativePath}`),
          source: {
            kind: "kenney_cc0",
            packageId: kitId,
            relativePath: `3d-assets/${model.relativePath}`,
            externalId: model.id,
            contentHash: model.sha256,
            licenseId: model.licenseId,
            commercialUsePermitted: true,
            redistributionPermitted: true,
            attribution: model.attribution,
          },
          tags,
          familyHint: {
            kitId: hint.kitId,
            familyKey: hint.familyKey,
            confidence: "derived_hint",
          },
          measurement: {
            status: "pending",
            reason: "Awaiting fixed offline geometry and material measurement worker",
          },
        },
        hint,
      );
    }
  }

  const families = [...familyMembers.values()].map((family) => ({
    kind: "CatalogAssetFamily",
    abi: "basalt-catalog-intelligence@1",
    familyId: family.familyId,
    kitId: family.kitId,
    familyKey: family.familyKey,
    memberAssetIds: family.memberAssetIds,
    roleTags: [...family.roleTags].sort((left, right) => left.localeCompare(right)).slice(0, 64),
    confidence: "derived_hint",
  }));
  const inventory = sealCatalogInventory({
    sourceManifestHashes: [sourceManifestHash, kenneyCatalog.hash],
    assets,
    families,
  });
  await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
  await writeFile(outputPath, `${stableJson(inventory)}\n`, { encoding: "utf8", mode: 0o600 });
  process.stdout.write(
    `${JSON.stringify(
      {
        output: outputPath,
        hash: inventory.hash,
        assets: inventory.assets.length,
        families: inventory.families.length,
        measured: inventory.assets.filter((asset) => asset.measurement.status === "measured")
          .length,
        pending: inventory.assets.filter((asset) => asset.measurement.status === "pending").length,
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(
    `Catalog inventory build failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
