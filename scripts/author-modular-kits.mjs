#!/usr/bin/env node
// Authors sealed modular-kit requirements from measured joint evidence.
// Kit definitions (registry/kit-manifest.json) name member families plus
// optional authored adjacency; the gate re-judges every kit from sealed
// measurement, so incoherent kits fail with the gate's reason instead of
// sealing. Outputs land under .basalt/modular-kits/only when every kit
// passes; any failure aborts the whole run.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertRuntimeBuildCurrent } from "./runtime-build-manifest.mjs";
import { catalogInventoryPath } from "./basalt-paths.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = resolve(repositoryRoot, "registry/kit-manifest.json");
const inventoryPath = catalogInventoryPath(repositoryRoot);
const outputRoot = resolve(repositoryRoot, ".basalt/modular-kits");

async function main() {
  await assertRuntimeBuildCurrent(repositoryRoot);
  if (process.argv.length > 2)
    throw new Error("Usage: npm run visual:catalog:author-kits (no arguments; emits all kits)");
  const { contentHash, stableJson } = await import(
    pathToFileURL(resolve(repositoryRoot, "dist/packages/contracts/src/index.js")).href
  );
  const { assertCatalogInventoryIdentity } = await import(
    pathToFileURL(resolve(repositoryRoot, "dist/packages/catalog-intelligence/src/index.js")).href
  );
  const { buildKitRequirement } = await import(
    pathToFileURL(resolve(repositoryRoot, "dist/packages/asset-factory/src/index.js")).href
  );
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.kind !== "BasaltKitManifest" || manifest.abi !== "basalt-kit-manifest@1")
    throw new Error(`Unknown kit manifest identity: ${manifest.kind}/${manifest.abi}`);
  const inventory = JSON.parse(await readFile(inventoryPath, "utf8"));
  assertCatalogInventoryIdentity(inventory);
  const declarations = new Map(
    inventory.familyDeclarations.map((declaration) => [declaration.familyName, declaration]),
  );
  const revisions = new Map(inventory.families.map((family) => [family.familyId, family]));
  const assets = new Map(inventory.assets.map((asset) => [asset.record.assetId, asset]));
  const seenKitIds = new Set();
  const authored = [];
  const failures = [];
  for (const kit of manifest.kits ?? []) {
    try {
      if (seenKitIds.has(kit.kitId)) throw new Error(`Duplicate kit ID: ${kit.kitId}`);
      seenKitIds.add(kit.kitId);
      const kitDeclarations = (kit.families ?? []).map((familyName) => {
        const declaration = declarations.get(familyName);
        if (!declaration) throw new Error(`Kit ${kit.kitId} names unknown family ${familyName}`);
        if (declaration.status !== "sealed")
          throw new Error(`Kit ${kit.kitId} names unsealed family ${familyName}`);
        return declaration;
      });
      const members = kitDeclarations.flatMap((declaration) =>
        declaration.members.map((member, memberIndex) => {
          const asset = assets.get(member.assetId);
          if (!asset) throw new Error(`Kit ${kit.kitId} member is not measured: ${member.assetId}`);
          if (asset.measurement.status !== "measured")
            throw new Error(`Kit ${kit.kitId} member is not measured: ${member.assetId}`);
          return {
            assetId: member.assetId,
            variantName: member.variantName,
            semanticRole: declaration.semanticRole,
            sourceFamilyId: declaration.familyId,
            sourceVariantIndex: memberIndex,
            boundsStuds: asset.measurement.boundsStuds,
            boundsMinimumQ32_32: asset.measurement.boundsMinimumQ32_32,
            boundsMaximumQ32_32: asset.measurement.boundsMaximumQ32_32,
            triangleCount: asset.measurement.triangleCount,
            supportedSurfaceKinds: asset.measurement.supportedSurfaceKinds ?? [],
            jointPlaneFits: asset.measurement.jointPlaneFits ?? [],
            jointPlaneRefusal: asset.measurement.jointPlaneRefusal ?? null,
          };
        }),
      );
      const variantToAsset = new Map(members.map((member) => [member.variantName, member.assetId]));
      const authoredRules = (kit.authoredRules ?? []).map((rule) => {
        const sourceArchetypeId = variantToAsset.get(rule.sourceVariant);
        const targetArchetypeId = variantToAsset.get(rule.targetVariant);
        if (!sourceArchetypeId)
          throw new Error(
            `Kit ${kit.kitId} authored rule names unknown variant ${rule.sourceVariant}`,
          );
        if (!targetArchetypeId)
          throw new Error(
            `Kit ${kit.kitId} authored rule names unknown variant ${rule.targetVariant}`,
          );
        return {
          sourceArchetypeId,
          sourceSocketId: rule.sourceSocketId,
          targetArchetypeId,
          targetSocketId: rule.targetSocketId,
          ...(rule.probabilityWeight === undefined
            ? {}
            : { probabilityWeight: rule.probabilityWeight }),
        };
      });
      const styleHashes = kitDeclarations
        .map((declaration) => revisions.get(declaration.familyId)?.globalStyleContractHash)
        .filter((hash) => typeof hash === "string")
        .sort();
      if (styleHashes.length !== kitDeclarations.length)
        throw new Error(`Kit ${kit.kitId} is missing sealed style contracts`);
      const requirement = buildKitRequirement({
        kitId: kit.kitId,
        name: kit.name,
        styleContractHash: contentHash(stableJson(styleHashes)),
        members,
        ...(kit.modulePitchStuds === undefined ? {} : { modulePitchStuds: kit.modulePitchStuds }),
        ...(authoredRules.length > 0 ? { authoredRules } : {}),
      });
      authored.push({ kitId: kit.kitId, requirement, hash: contentHash(stableJson(requirement)) });
    } catch (error) {
      failures.push({
        kitId: kit?.kitId ?? "unknown",
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (failures.length > 0) {
    for (const failure of failures)
      process.stderr.write(`kit incoherent: ${failure.kitId}: ${failure.reason}\n`);
    throw new Error(`${failures.length} of ${manifest.kits.length} kits failed coherence`);
  }
  await mkdir(outputRoot, { recursive: true, mode: 0o700 });
  for (const kit of authored)
    await writeFile(resolve(outputRoot, `${kit.kitId}.json`), `${stableJson(kit.requirement)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  process.stdout.write(
    `${JSON.stringify(
      {
        output: outputRoot,
        kits: authored.map((kit) => ({
          kitId: kit.kitId,
          archetypes: kit.requirement.archetypes.length,
          adjacencyRules: kit.requirement.adjacencyRules.length,
          modulePitchStuds: kit.requirement.modulePitchStuds,
          hash: kit.hash,
        })),
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(
    `Kit authoring failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
