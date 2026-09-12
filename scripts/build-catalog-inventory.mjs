#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertRuntimeBuildCurrent } from "./runtime-build-manifest.mjs";
import {
  catalogInventoryPath,
  sourceManifestPath as resolveSourceManifestPath,
} from "./basalt-paths.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceManifestPath = resolveSourceManifestPath(repositoryRoot);
const outputPath = catalogInventoryPath(repositoryRoot);

function pendingRecord(assetId, fileHash, sourcePath, contentHash, stableJson) {
  const zero = { x: "0", y: "0", z: "0" };
  const recordMaterial = { assetId, sourceFileHash: fileHash, sourcePath };
  return {
    assetId,
    sourceFileHash: fileHash,
    canonicalName: `asset_${fileHash.slice(0, 16)}`,
    boundingBox: { min: zero, max: zero },
    pivotOffsetFromBottomCenter: zero,
    triangleCount: 0,
    vertexCount: 0,
    submeshCount: 0,
    materialSlotCount: 0,
    textures: [],
    collisionProxy: { type: "None" },
    topologicalGenus: 0,
    semanticTags: [],
    isManifold: false,
    admissionStatus: "pending",
    merkleLeafHash: contentHash(stableJson(recordMaterial)),
  };
}

async function main() {
  await assertRuntimeBuildCurrent(repositoryRoot);
  const { contentHash, stableJson } = await import(
    pathToFileURL(resolve(repositoryRoot, "dist/packages/contracts/src/index.js")).href
  );
  const { sealCatalogInventory } = await import(
    pathToFileURL(resolve(repositoryRoot, "dist/packages/catalog-intelligence/src/contracts.js"))
      .href
  );
  const { parseAuthoredFamilyManifest } = await import(
    pathToFileURL(
      resolve(repositoryRoot, "dist/packages/catalog-intelligence/src/authored-families.js"),
    ).href
  );
  const { TRIM_SHEET_SPECIFICATION_SCHEMA } = await import(
    pathToFileURL(resolve(repositoryRoot, "dist/packages/asset-factory/src/trim-sheet.js")).href
  );
  const sourceManifest = JSON.parse(await readFile(sourceManifestPath, "utf8"));
  const familyManifestPath = resolve(repositoryRoot, sourceManifest.familyManifest);
  const familyManifest = parseAuthoredFamilyManifest(
    JSON.parse(await readFile(familyManifestPath, "utf8")),
  );
  const trimSheet = TRIM_SHEET_SPECIFICATION_SCHEMA.parse(
    JSON.parse(await readFile(resolve(repositoryRoot, "registry/trim-sheet.json"), "utf8")),
  );
  const sourceManifestHash = contentHash(stableJson(sourceManifest));
  const familyManifestHash = contentHash(stableJson(familyManifest));
  const trimSheetHash = contentHash(stableJson(trimSheet));
  const assets = [];
  for (const packageEntry of sourceManifest.packages) {
    const packageId =
      packageEntry.packageId ??
      `pack_${contentHash(packageEntry.archivePaths.join("\u0000")).slice(0, 16)}`;
    for (const file of packageEntry.files) {
      if (!/\.(?:glb|gltf)$/iu.test(file.relativePath)) continue;
      const assetId = `catalog_${contentHash(stableJson({ packageId, path: file.relativePath, hash: file.sha256 })).slice(0, 32)}`;
      assets.push({
        kind: "CatalogAssetEnvelope",
        abi: "basalt-catalog-intelligence@2",
        record: pendingRecord(assetId, file.sha256, file.relativePath, contentHash, stableJson),
        source: {
          kind: packageEntry.sourceKind,
          packageId,
          relativePath: file.relativePath,
          contentHash: file.sha256,
          licenseId: packageEntry.licenseId,
          commercialUsePermitted: packageEntry.commercialUsePermitted,
          redistributionPermitted: packageEntry.redistributionPermitted,
          attribution: packageEntry.attribution,
        },
        measurement: {
          status: "pending",
          reason: "Awaiting normalized geometry, texture, and collision evidence",
        },
      });
    }
  }
  const assetsByPath = new Map(assets.map((asset) => [asset.source.relativePath, asset]));
  const familyDeclarations = familyManifest.families.map((family) => ({
    familyName: family.familyName,
    handle: family.handle,
    displayName: family.displayName,
    semanticRole: family.semanticRole,
    styleTokens: [...family.styleTokens].sort(),
    sharedTrimSheetAssetId:
      family.sharedTrimSheetAssetId === "shared_trim_sheet_pending"
        ? trimSheet.id
        : family.sharedTrimSheetAssetId,
    ...(family.trimBands ? { trimBands: family.trimBands } : { trimBands: trimSheet.bands }),
    ...(family.mountSockets ? { mountSockets: family.mountSockets } : {}),
    ...(family.jointSockets ? { jointSockets: family.jointSockets } : {}),
    members: family.members.map((member) => {
      const asset = assetsByPath.get(member.sourcePath);
      if (!asset)
        throw new Error(
          `Authored family member is not in the source inventory: ${member.sourcePath}`,
        );
      return {
        assetId: asset.record.assetId,
        sourcePath: member.sourcePath,
        variantName: member.variantName,
      };
    }),
    status: "declared",
  }));
  const inventory = sealCatalogInventory({
    sourceManifestHashes: [sourceManifestHash, familyManifestHash, trimSheetHash],
    assets,
    familyDeclarations,
    families: [],
    familyCards: [],
    diagnostics: {
      unmatchedCollisionCompanions: 0,
      ambiguousCollisionCompanions: 0,
      renderablesWithValidCollisionBindings: 0,
      trimMappingsRejectedByEnergy: 0,
      incompleteCandidates: assets.length,
      kindFamilyDiagnostics: [],
      modularKitDiagnostics: {
        modularFamilies: 0,
        pendingFamilies: 0,
        quarantinedFamilies: 0,
        quarantined: [],
      },
    },
  });
  await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
  await writeFile(outputPath, `${stableJson(inventory)}\n`, { encoding: "utf8", mode: 0o600 });
  process.stdout.write(
    `${JSON.stringify({ output: outputPath, hash: inventory.hash, assets: assets.length, families: 0 }, null, 2)}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(
    `Catalog inventory build failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
