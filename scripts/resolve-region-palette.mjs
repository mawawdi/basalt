#!/usr/bin/env node
// Resolves one region brief against the sealed catalog: adapts admitted
// families to the tag registry, resolves each brief role once, and emits the
// WorldPlan (palette menu + exploit bindings) plus the CLI registry/requests.
// A role that resolves nothing fails closed here; factory dispatch lands later.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertRuntimeBuildCurrent } from "./runtime-build-manifest.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const inventoryPath = resolve(repositoryRoot, ".basalt/catalog-cache/source-inventory.json");

function option(args, name) {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${name}`);
  return value;
}

async function main() {
  await assertRuntimeBuildCurrent(repositoryRoot);
  const args = process.argv.slice(2);
  const briefPath = option(args, "--brief");
  const outputDir = option(args, "--output");
  if (!briefPath || !outputDir)
    throw new Error(
      "Usage: npm run visual:catalog:palette -- --brief <brief.json> --output <dir> [--max-cards <n>]",
    );
  const maxCards = Number(option(args, "--max-cards") ?? 20);
  if (!Number.isSafeInteger(maxCards) || maxCards < 1 || maxCards > 20)
    throw new Error("--max-cards must be an integer from 1 to 20");
  const {
    adaptSealedCatalogToRegistry,
    assertWorldAssetFamilyRegistry,
    briefMissedFamilyFactoryJobs,
    resolveWorldAssetFamilies,
  } = await import(
    pathToFileURL(resolve(repositoryRoot, "dist/packages/world-compiler/src/index.js")).href
  );
  const { contentHash, stableJson } = await import(
    pathToFileURL(resolve(repositoryRoot, "dist/packages/contracts/src/index.js")).href
  );
  const { assertNeuralFamilyFactoryBatchIdentity, sealNeuralFamilyFactoryBatch } = await import(
    pathToFileURL(resolve(repositoryRoot, "dist/packages/neural-asset/src/factory.js")).href
  );
  const { SPATIAL_ROLES, serializePaletteMenu, worldPlanSchema, worldStyleContractSchema } =
    await import(
      pathToFileURL(resolve(repositoryRoot, "dist/packages/basalt-types/src/index.js")).href
    );
  const { assertCatalogInventoryIdentity } = await import(
    pathToFileURL(resolve(repositoryRoot, "dist/packages/catalog-intelligence/src/index.js")).href
  );
  const brief = JSON.parse(await readFile(resolve(briefPath), "utf8"));
  if (typeof brief?.briefId !== "string" || brief.briefId.length === 0)
    throw new Error("Brief must carry a non-empty briefId");
  const styleContract = worldStyleContractSchema.parse(brief.styleContract);
  if (!Array.isArray(brief.roles) || brief.roles.length === 0)
    throw new Error("Brief must carry a non-empty roles array");
  const inventory = JSON.parse(await readFile(inventoryPath, "utf8"));
  assertCatalogInventoryIdentity(inventory);
  const registry = adaptSealedCatalogToRegistry({
    revisions: inventory.families,
    cards: inventory.familyCards,
    assets: inventory.assets,
  });
  const cardsById = new Map(inventory.familyCards.map((card) => [card.fid, card]));
  const requests = [];
  const bound = [];
  const seenBiomes = new Set();
  for (const role of brief.roles) {
    if (typeof role?.regionId !== "string" || role.regionId.length === 0)
      throw new Error("Each brief role needs a non-empty regionId");
    if (!SPATIAL_ROLES.includes(role.role))
      throw new Error(`Unknown brief role (region ${role.regionId}): ${role.role}`);
    if (!Number.isSafeInteger(role.families) || role.families < 1 || role.families > 5)
      throw new Error(`Role families must be an integer from 1 to 5 (region ${role.regionId})`);
    if (typeof role.targetDensityPerHectare !== "number" || role.targetDensityPerHectare < 0)
      throw new Error(
        `Role needs a non-negative targetDensityPerHectare (region ${role.regionId})`,
      );
    const biomeId = `${role.regionId}__${role.role}`;
    if (seenBiomes.has(biomeId))
      throw new Error(`Duplicate brief role for region: ${role.regionId} ${role.role}`);
    seenBiomes.add(biomeId);
    if (
      role.semanticTags !== undefined &&
      (!Array.isArray(role.semanticTags) ||
        role.semanticTags.some((tag) => typeof tag !== "string"))
    )
      throw new Error(`Role semanticTags must be a string array (region ${role.regionId})`);
    requests.push({
      biomeId,
      regionIds: [role.regionId],
      semanticTags: role.semanticTags ?? [],
      styleTags: [styleContract.style_motif],
      roleTags: [role.role],
      minimumFamilies: role.families,
      maximumFamilies: role.families,
      ...(role.surfaceKinds ? { surfaceKinds: role.surfaceKinds } : {}),
      ...(role.distribution ? { distribution: role.distribution } : {}),
      ...(role.density ? { density: role.density } : {}),
    });
    bound.push({ ...role, biomeId });
  }
  const resolved = {};
  const emittedRequests = [];
  const exploreRequirements = [];
  const factoryJobs = [];
  const missedRoles = [];
  for (const role of bound) {
    const request = requests.find((candidate) => candidate.biomeId === role.biomeId);
    try {
      Object.assign(resolved, resolveWorldAssetFamilies({ registry, requests: [request] }));
      emittedRequests.push(request);
    } catch (error) {
      if (!role.factory) throw error;
      const briefed = briefMissedFamilyFactoryJobs({
        miss: {
          regionId: role.regionId,
          role: role.role,
          suggestedHandle: role.factory.suggestedHandle,
          boundingEnvelopeStuds: role.factory.boundingEnvelopeStuds,
          targetTexelDensity: role.factory.targetTexelDensity,
          minArchetypeCount: role.factory.minArchetypeCount,
          surfaceAffinity: role.factory.surfaceAffinity,
          provider: role.factory.provider,
          referenceHash: role.factory.referenceHash,
          seed: role.factory.seed,
        },
        worldPlanHash: contentHash(brief.briefId),
        styleContractHash: contentHash(stableJson(styleContract)),
      });
      exploreRequirements.push(briefed.requirement);
      factoryJobs.push(...briefed.jobs);
      missedRoles.push(`${role.regionId}/${role.role}`);
    }
  }
  const selected = [];
  const seen = new Set();
  for (const role of bound) {
    for (const familyId of resolved[role.biomeId] ?? []) {
      if (seen.has(familyId)) continue;
      seen.add(familyId);
      const card = cardsById.get(familyId);
      if (!card) throw new Error(`Resolved card is missing from inventory: ${familyId}`);
      selected.push(card);
    }
  }
  if (selected.length > maxCards)
    throw new Error(
      `Brief selects ${selected.length} families, exceeding --max-cards ${maxCards}; narrow the brief`,
    );
  const outDir = resolve(outputDir);
  await mkdir(outDir, { recursive: true });
  if (factoryJobs.length > 0) {
    const batch = sealNeuralFamilyFactoryBatch({
      worldPlanHash: contentHash(brief.briefId),
      styleContractHash: contentHash(stableJson(styleContract)),
      jobs: factoryJobs,
    });
    await writeFile(resolve(outDir, "factory-queue.json"), `${JSON.stringify(batch, null, 2)}\n`);
    assertNeuralFamilyFactoryBatchIdentity(
      JSON.parse(await readFile(resolve(outDir, "factory-queue.json"), "utf8")),
    );
  }
  if (selected.length === 0)
    throw new Error(
      `Brief resolves no families (missed: ${missedRoles.join(", ")}); factory brief written, nothing to compile`,
    );
  const worldPlan = worldPlanSchema.parse({
    world_id: brief.briefId,
    style_contract: styleContract,
    palette_menu: selected,
    exploit_bindings: bound.flatMap((role) =>
      (resolved[role.biomeId] ?? []).map((familyId) => ({
        region_id: role.regionId,
        assigned_fid: familyId,
        target_density_per_hectare: role.targetDensityPerHectare,
      })),
    ),
    explore_requirements: exploreRequirements,
  });
  const registryJson = JSON.stringify(registry, null, 2);
  const requestsJson = JSON.stringify(emittedRequests, null, 2);
  await writeFile(resolve(outDir, "world-plan.json"), `${JSON.stringify(worldPlan, null, 2)}\n`);
  await writeFile(resolve(outDir, "palette-menu.txt"), `${serializePaletteMenu(selected)}\n`);
  await writeFile(resolve(outDir, "family-registry.json"), `${registryJson}\n`);
  await writeFile(resolve(outDir, "family-requests.json"), `${requestsJson}\n`);
  assertWorldAssetFamilyRegistry(JSON.parse(registryJson));
  const replayed = resolveWorldAssetFamilies({
    registry: JSON.parse(registryJson),
    requests: JSON.parse(requestsJson),
  });
  if (stableJson(replayed) !== stableJson(resolved))
    throw new Error("Emitted registry/requests do not reproduce the resolution");
  process.stdout.write(
    `${JSON.stringify({ output: outDir, roles: bound.length, cards: selected.length, bindings: worldPlan.exploit_bindings.length, missedRoles, queuedJobs: factoryJobs.length }, null, 2)}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(
    `Region palette resolution failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
