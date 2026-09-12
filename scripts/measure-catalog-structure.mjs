#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertRuntimeBuildCurrent } from "./runtime-build-manifest.mjs";

/** Code-unit string order. Locale-aware comparison must never feed sealed output. */
const compareStrings = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const inventoryPath = resolve(repositoryRoot, ".basalt/catalog-cache/source-inventory.json");

function measurementWorkerCount(assetCount) {
  if (assetCount === 0) return 0;
  const defaultCount = Math.max(1, Math.min(4, availableParallelism() - 1));
  const configured = process.env.BASALT_CATALOG_MEASURE_WORKERS;
  const count = configured === undefined ? defaultCount : Number(configured);
  if (!Number.isSafeInteger(count) || count < 1 || count > 16)
    throw new Error("BASALT_CATALOG_MEASURE_WORKERS must be an integer from 1 to 16");
  return Math.min(count, assetCount);
}

function measureAssetsInParallel(assets) {
  const workerCount = measurementWorkerCount(assets.length);
  if (workerCount === 0) return Promise.resolve([]);
  const chunks = Array.from({ length: workerCount }, () => []);
  assets.forEach((asset, index) => chunks[index % workerCount].push(asset));
  return Promise.all(
    chunks.map(
      (chunk) =>
        new Promise((resolveChunk, rejectChunk) => {
          const worker = new Worker(new URL("./measure-catalog-worker.mjs", import.meta.url), {
            workerData: { repositoryRoot, assets: chunk },
          });
          let settled = false;
          worker.on("message", (message) => {
            if (message.fatal) {
              settled = true;
              rejectChunk(new Error(message.fatal));
              return;
            }
            settled = true;
            resolveChunk(message.results ?? []);
          });
          worker.on("error", (error) => {
            if (settled) return;
            settled = true;
            rejectChunk(error);
          });
          worker.on("exit", (code) => {
            if (!settled && code !== 0)
              rejectChunk(new Error(`Measurement worker exited with ${code}`));
          });
        }),
    ),
  ).then((chunks) => chunks.flat());
}

function updateCanonicalRecord(asset, measurement, contentHash, stableJson) {
  const record = asset.record;
  record.boundingBox = {
    min: measurement.boundsMinimumQ32_32,
    max: measurement.boundsMaximumQ32_32,
  };
  record.pivotOffsetFromBottomCenter = measurement.pivotOffsetQ32_32;
  record.triangleCount = measurement.triangleCount;
  record.vertexCount = measurement.vertexCount;
  record.submeshCount = measurement.submeshCount;
  record.materialSlotCount = measurement.materialSlotCount;
  record.textures = measurement.textureFacts;
  record.topologicalGenus = measurement.topologicalGenus;
  record.isManifold = measurement.hasManifoldTopology;
  record.collisionProxy =
    measurement.collision.status === "authored_proxy"
      ? {
          type: "CompoundConvexHulls",
          hullCount: Math.max(1, measurement.collision.convexComponentCount),
          maxTriangles: measurement.triangleCount,
        }
      : { type: "None" };
  record.merkleLeafHash = contentHash(
    stableJson({
      assetId: record.assetId,
      sourceFileHash: record.sourceFileHash,
      boundingBox: record.boundingBox,
      collisionProxy: record.collisionProxy,
    }),
  );
  asset.record = record;
}

async function main() {
  await assertRuntimeBuildCurrent(repositoryRoot);
  const { contentHash, stableJson } = await import(
    pathToFileURL(resolve(repositoryRoot, "dist/packages/contracts/src/index.js")).href
  );
  const { quantizeQ32_32, STUD_METERS } = await import(
    pathToFileURL(resolve(repositoryRoot, "dist/packages/basalt-types/src/fixed.js")).href
  );
  const { selectHotspotTrimBand } = await import(
    pathToFileURL(resolve(repositoryRoot, "dist/packages/asset-factory/src/trim-sheet.js")).href
  );
  const { sealCatalogInventory, resolveAdmissionStatus } = await import(
    pathToFileURL(resolve(repositoryRoot, "dist/packages/catalog-intelligence/src/contracts.js"))
      .href
  );
  const { buildAuthoredAssetFamilyRevision } = await import(
    pathToFileURL(
      resolve(repositoryRoot, "dist/packages/catalog-intelligence/src/family-revisions.js"),
    ).href
  );
  const { buildFamilyCard } = await import(
    pathToFileURL(resolve(repositoryRoot, "dist/packages/catalog-intelligence/src/family-cards.js"))
      .href
  );
  const { findSupportEvidenceViolations, measureKindFamilyDiagnostics } = await import(
    pathToFileURL(
      resolve(repositoryRoot, "dist/packages/catalog-intelligence/src/authored-families.js"),
    ).href
  );
  const { pairCollisionCompanions } = await import(
    pathToFileURL(resolve(repositoryRoot, "dist/packages/catalog-intelligence/src/collision.js"))
      .href
  );
  const inventory = JSON.parse(await readFile(inventoryPath, "utf8"));
  const failures = [];
  const normalizedMeshesByAsset = new Map();
  const assetsById = new Map(inventory.assets.map((asset) => [asset.record.assetId, asset]));
  const measurementResults = await measureAssetsInParallel(inventory.assets);
  for (const result of measurementResults) {
    const asset = assetsById.get(result.assetId);
    if (!asset) throw new Error(`Measurement worker returned unknown asset: ${result.assetId}`);
    if (result.error) {
      asset.measurement = { status: "pending", reason: `Measurement failed: ${result.error}` };
      asset.record.admissionStatus = "pending";
      failures.push({ assetId: asset.record.assetId, reason: asset.measurement.reason });
      continue;
    }
    asset.measurement = result.measurement;
    normalizedMeshesByAsset.set(asset.record.assetId, result.pairMesh);
    updateCanonicalRecord(asset, result.measurement, contentHash, stableJson);
    asset.record.admissionStatus = resolveAdmissionStatus({
      isManifold: result.measurement.hasManifoldTopology,
      textureEvidence: result.measurement.textureEvidence,
    });
  }

  const collisionInput = [];
  for (const asset of inventory.assets) {
    if (asset.measurement.status !== "measured") continue;
    const mesh = normalizedMeshesByAsset.get(asset.record.assetId);
    if (!mesh) continue;
    collisionInput.push({
      assetId: asset.record.assetId,
      sourcePath: asset.source.relativePath,
      packageId: asset.source.packageId,
      kind: asset.measurement.renderable ? "render" : "collision",
      mesh,
      triangleCount: asset.measurement.triangleCount,
    });
  }
  const pairing = pairCollisionCompanions(collisionInput);
  for (const binding of pairing.bindings) {
    const render = assetsById.get(binding.renderAssetId);
    const collision = assetsById.get(binding.collisionAssetId);
    if (
      !render ||
      !collision ||
      render.measurement.status !== "measured" ||
      collision.measurement.status !== "measured"
    )
      continue;
    render.measurement.collision = {
      status: "authored_proxy",
      proxyAssetId: collision.record.assetId,
      volumetricInclusionQ32_32: quantizeQ32_32(binding.evidence.volumetricInclusion),
      triangleRatioQ32_32: quantizeQ32_32(binding.evidence.triangleRatio),
      syntacticGate: binding.evidence.syntactic,
      volumetricGate: binding.evidence.volumetric,
      complexityGate: binding.evidence.complexity,
      watertight: binding.evidence.watertight,
      convex: binding.evidence.convex,
      convexComponentCount: binding.evidence.convexComponentCount,
    };
    updateCanonicalRecord(render, render.measurement, contentHash, stableJson);
  }

  let trimMappingsRejectedByEnergy = 0;
  const sealedRevisions = [];
  const flaggedKindFamilies = [];
  const sealEvidenceFor = (declaration) => {
    const evidence = {};
    if (declaration.trimBands?.length) {
      const mappings = [];
      for (const member of declaration.members) {
        const measurement = assetsById.get(member.assetId).measurement;
        const [x, y, z] = measurement.boundsStuds;
        const mapping = selectHotspotTrimBand(
          {
            assetId: member.assetId,
            aspectRatio: Math.max(x, z) / Math.max(y, 1e-6),
            surfaceArea: measurement.surfaceAreaStuds2 * STUD_METERS ** 2,
          },
          declaration.trimBands,
        );
        if (mapping) mappings.push(mapping);
        else trimMappingsRejectedByEnergy += 1;
      }
      evidence.trimMappings = mappings;
    }
    if (declaration.mountSockets) {
      const mountContacts = {};
      for (const member of declaration.members) {
        const measurement = assetsById.get(member.assetId).measurement;
        if (
          measurement.primaryContact === "bottom" &&
          Array.isArray(measurement.supportPlaneFits) &&
          measurement.supportPlaneFits.length > 0
        )
          mountContacts[member.assetId] = {
            supportPlaneFits: measurement.supportPlaneFits,
          };
      }
      evidence.mountContacts = mountContacts;
    }
    return evidence;
  };
  const familyDeclarations = inventory.familyDeclarations.map((declaration) => {
    const complete = declaration.members.every((member) => {
      const asset = assetsById.get(member.assetId);
      return (
        asset?.measurement.status === "measured" &&
        asset.measurement.renderable &&
        !pairing.collisionCandidates.some((candidate) => candidate.assetId === member.assetId)
      );
    });
    if (!complete)
      return {
        ...declaration,
        status: "incomplete",
        reason:
          "A declared family member lacks measured render geometry or is a collision companion",
      };
    const kindMembers = declaration.members.map((member) => {
      const asset = assetsById.get(member.assetId);
      const measurement = asset.measurement;
      return {
        assetId: member.assetId,
        variantName: member.variantName,
        boundsStuds: measurement.boundsStuds,
        triangleCount: measurement.triangleCount,
        submeshCount: measurement.submeshCount,
        primaryContact: measurement.primaryContact,
        hasManifoldTopology: measurement.hasManifoldTopology,
        topologicalGenus: measurement.topologicalGenus,
        materialAppearanceHashes: measurement.materialAppearanceHashes ?? [],
        sourceFileHash: asset.record.sourceFileHash,
      };
    });
    const violations = findSupportEvidenceViolations(kindMembers);
    if (violations.length > 0)
      return {
        ...declaration,
        status: "incomplete",
        reason: `Support evidence violations: ${violations.map((violation) => violation.reason).join("; ")}`,
      };
    const kindDiagnostics = measureKindFamilyDiagnostics(declaration.handle, kindMembers);
    if (
      kindDiagnostics.coherence.outlierVariants.length > 0 ||
      kindDiagnostics.coverage.exceedsHectare
    )
      flaggedKindFamilies.push({
        familyName: declaration.familyName,
        coherenceOutlierVariants: [...kindDiagnostics.coherence.outlierVariants],
        coverageExceedsHectare: kindDiagnostics.coverage.exceedsHectare,
      });
    const revision = buildAuthoredAssetFamilyRevision(
      { ...declaration, status: "declared" },
      declaration.members.map((member) => assetsById.get(member.assetId).record),
      sealEvidenceFor(declaration),
    );
    sealedRevisions.push(revision);
    return { ...declaration, status: "sealed", familyId: revision.familyId };
  });
  const families = sealedRevisions;
  const familyCards = families.map((family) => {
    const members = family.archetypes.map((archetype) => assetsById.get(archetype.assetId));
    return buildFamilyCard(family, {
      surfaceTypes: [
        ...new Set(members.flatMap((member) => member.measurement.supportedSurfaceKinds ?? [])),
      ],
      memberBounds: Object.fromEntries(
        members.map((member) => [member.record.assetId, member.record.boundingBox]),
      ),
    });
  });
  const familyMemberIds = new Set(
    families.flatMap((family) => family.archetypes.map((member) => member.assetId)),
  );
  const incompleteCandidateCount = inventory.assets.filter(
    (asset) =>
      asset.measurement.status === "measured" &&
      asset.measurement.renderable &&
      !pairing.collisionCandidates.some(
        (candidate) => candidate.assetId === asset.record.assetId,
      ) &&
      !familyMemberIds.has(asset.record.assetId),
  ).length;
  const sealed = sealCatalogInventory({
    sourceManifestHashes: inventory.sourceManifestHashes,
    assets: inventory.assets,
    familyDeclarations,
    families,
    familyCards,
    diagnostics: {
      unmatchedCollisionCompanions: pairing.diagnostics.filter(
        (diagnostic) => diagnostic.reason === "unmatched",
      ).length,
      ambiguousCollisionCompanions: pairing.diagnostics.filter(
        (diagnostic) => diagnostic.reason === "ambiguous",
      ).length,
      renderablesWithValidCollisionBindings: pairing.bindings.length,
      trimMappingsRejectedByEnergy,
      incompleteCandidates: incompleteCandidateCount,
      kindFamilyDiagnostics: flaggedKindFamilies.sort((left, right) =>
        compareStrings(left.familyName, right.familyName),
      ),
    },
  });
  await writeFile(inventoryPath, `${stableJson(sealed)}\n`, { encoding: "utf8", mode: 0o600 });
  process.stdout.write(
    `${JSON.stringify({ inventory: inventoryPath, measured: inventory.assets.filter((asset) => asset.measurement.status === "measured").length, declaredFamilies: familyDeclarations.length, sealedFamilies: families.length, incompleteCandidates: incompleteCandidateCount, collisionBindings: pairing.bindings.length, collisionDiagnostics: pairing.diagnostics.length, kindCoherenceFlagged: flaggedKindFamilies.filter((entry) => entry.coherenceOutlierVariants.length > 0).length, kindCoverageExceeded: flaggedKindFamilies.filter((entry) => entry.coverageExceedsHectare).length, failures: failures.length }, null, 2)}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(
    `Catalog measurement failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
