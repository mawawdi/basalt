import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { readBoundedWorkspaceBytes, writeCanonicalWorkspaceJson } from "@basalt/artifact-store";
import { contentHash, stableJson } from "@basalt/contracts";
import {
  ROBLOX_ASSET_BINDING_SCHEMA,
  ROBLOX_ASSET_UPLOAD_LEDGER_SCHEMA,
  createRobloxImportManifest,
  sealRobloxAssetBinding,
} from "@basalt/roblox";
import { WORLD_BUILD_SCHEMA } from "@basalt/world-compiler";
import {
  CATALOG_FIRST_USE_OUTPUT_ROOT,
  catalogFirstUseFixture,
} from "../dist/test/helpers/catalog-first-use-fixture.js";
import { loadSemanticRegistry } from "../dist/test/helpers/semantic-registry.js";
import { verifyRobloxUploadEvidence } from "./verify-roblox-upload-evidence.mjs";

const execFile = promisify(execFileCallback);
const repositoryRoot = resolve(".");
const outputRoot = CATALOG_FIRST_USE_OUTPUT_ROOT;
const catalogPath = "registry/catalog.json";
const planPath = `${outputRoot}/spatial-plan.json`;
const changedPlanPath = `${outputRoot}/requirement-change-spatial-plan.json`;
const worldPath = `${outputRoot}/world-build.json`;
const changedWorldPath = `${outputRoot}/requirement-change-world-build.json`;

const module = await loadSemanticRegistry();
const fixture = await catalogFirstUseFixture(module);
await Promise.all([
  writeGeneratedJson(planPath, fixture.plan),
  writeGeneratedJson(changedPlanPath, fixture.changedPlan),
]);

await runWorldCompile(planPath, worldPath);
await runWorldCompile(changedPlanPath, changedWorldPath);
const world = WORLD_BUILD_SCHEMA.parse(await readJson(worldPath));
const changedWorld = WORLD_BUILD_SCHEMA.parse(await readJson(changedWorldPath));
const uploads = await loadUploads();
const bindings = await loadBindings(uploads);
const importManifest = createRobloxImportManifest(world, bindings.values);

const assetByHash = new Map(fixture.measurements.assets.map((asset) => [asset.hash, asset]));
const sourceByHash = new Map(
  fixture.catalogCommit.sourceManifest.assets.map((source) => [source.contentHash, source]),
);
const useRecords = world.instances.map((instance) => {
  const asset = assetByHash.get(instance.assetHash);
  if (!asset) throw new Error(`World instance lacks retained measurement ${instance.assetHash}`);
  const resolution = world.catalogResolution.bindings.find(
    (entry) => entry.entryHandle === instance.entryHandle && entry.memberId === instance.memberId,
  );
  if (!resolution)
    throw new Error(`World instance lacks exact catalog resolution ${instance.instanceId}`);
  return {
    intentId: instance.intentId,
    requirementId: resolution.requirementId,
    queryEvidence: {
      requirementHash: resolution.requirementHash,
      rankedCandidates: resolution.explanation.rankedCandidates,
    },
    selection: {
      entryHandle: instance.entryHandle,
      entryHash: instance.entryHash,
      memberId: instance.memberId,
      assetHash: instance.assetHash,
      assertionBundleHash: instance.assertionBundleHash,
    },
    source: {
      sourceContentHash: asset.source.contentHash,
      sourceArtifactHash: asset.source.sourceArtifact.artifactHash,
      measurementHash: asset.hash,
    },
    placement: {
      transformMeters: instance.transformMeters,
      sourceBoundsMeters: instance.sourceBoundsMeters,
      boundsMeters: instance.boundsMeters,
      regionId: instance.regionId,
      surfaceId: instance.surfaceId,
    },
  };
});
const catalogUseEvidenceBody = {
  kind: "CatalogFirstUseEvidence",
  catalogCommitHash: fixture.catalogCommit.hash,
  catalogSnapshotHash: fixture.catalogCommit.snapshot.hash,
  measurementSetHash: fixture.measurements.hash,
  planHash: fixture.plan.planHash,
  worldBuildHash: world.worldBuildHash,
  resolutionStatus: world.catalogResolution.status,
  requirements: fixture.requirements.map((requirement) => ({
    requirementId: requirement.requirementId,
    requirementHash: contentHash(stableJson(requirement)),
  })),
  bindings: useRecords,
  gaps: world.catalogResolution.gaps,
};
const catalogUseEvidence = {
  ...catalogUseEvidenceBody,
  hash: contentHash(stableJson(catalogUseEvidenceBody)),
};

const baselineStable = world.instances
  .filter((entry) => entry.intentId !== "PlaceOutdoorProp")
  .map(stableInstance);
const changedStable = changedWorld.instances
  .filter((entry) => entry.intentId !== "PlaceOutdoorProp")
  .map(stableInstance);
const stabilityBody = {
  kind: "CatalogFirstUseStabilityCheck",
  baselinePlanHash: fixture.plan.planHash,
  changedPlanHash: fixture.changedPlan.planHash,
  changedRequirementId: "OutdoorProps",
  baselineWorldBuildHash: world.worldBuildHash,
  changedWorldBuildHash: changedWorld.worldBuildHash,
  unrelatedInstanceCount: baselineStable.length,
  unrelatedPlacementsStable: stableJson(baselineStable) === stableJson(changedStable),
  status: baselineStable.length > 0 ? "eligible" : "incomplete",
  diagnostics:
    baselineStable.length > 0
      ? []
      : ["Stability comparison awaits admitted non-prop catalog placements"],
};
if (!stabilityBody.unrelatedPlacementsStable)
  throw new Error("Changing the outdoor-prop requirement changed unrelated catalog placements");
const stability = { ...stabilityBody, hash: contentHash(stableJson(stabilityBody)) };

const missingBindingAssets = [
  ...new Set(
    importManifest.loweringGaps
      .filter((gap) => gap.kind === "asset_binding")
      .map((gap) => gap.subjectHash),
  ),
].sort();
const entryHandleByAsset = new Map(
  fixture.catalogCommit.snapshot.entries.flatMap((entry) =>
    entry.memberAssets.map((member) => [member.assetHash, entry.handle]),
  ),
);
const uploadItems = missingBindingAssets.map((assetHash) =>
  bindingUploadItem(assetHash, uploads, entryHandleByAsset.get(assetHash)),
);
const admittedAssets = [...entryHandleByAsset]
  .map(([assetHash, entryHandle]) => bindingUploadItem(assetHash, uploads, entryHandle))
  .sort((left, right) => left.assetHash.localeCompare(right.assetHash));
const uploadBody = {
  kind: "CatalogFirstUseRobloxUploadPacket",
  status: uploadItems.every((item) => item.uploadStatus === "eligible") ? "eligible" : "incomplete",
  catalogCommitHash: fixture.catalogCommit.hash,
  worldBuildHash: world.worldBuildHash,
  bindingInventory: {
    relativePath: ".basalt/roblox/asset-bindings.json",
    status: bindings.status,
    bindingCount: bindings.values.length,
  },
  publicationInventory: {
    relativePath: ".basalt/roblox/asset-uploads.json",
    status: uploads.status,
    uploadCount: uploads.values.length,
    eligibleCount: uploads.values.filter((entry) => entry.status === "eligible").length,
  },
  missingBindings: uploadItems,
  admittedAssets,
  instructions: bindingInstructions(uploadItems),
};
const uploadPacket = { ...uploadBody, hash: contentHash(stableJson(uploadBody)) };
const bindingDecisionTemplate = {
  kind: "CatalogFirstUseRobloxBindingDecision",
  uploadPacketHash: uploadPacket.hash,
  recordedBy: null,
  reviewerStatement: null,
  recordedAt: null,
  bindings: uploadItems.map((item) => ({
    assetHash: item.assetHash,
    sourceArtifactHash: item.sourceArtifactHash,
    uploadArtifactHash: item.uploadArtifactHash,
    publicationEvidenceHash: item.publicationEvidenceHash,
    robloxAssetId: item.robloxAssetId,
    materialExpectations: null,
  })),
};

const statusBody = {
  kind: "CatalogFirstUseStatus",
  status:
    world.status === "eligible" &&
    stability.status === "eligible" &&
    importManifest.loweringGaps.length === 0
      ? "eligible"
      : "incomplete",
  catalogCommitHash: fixture.catalogCommit.hash,
  worldBuildHash: world.worldBuildHash,
  worldStatus: world.status,
  admittedEntryCount: fixture.catalogCommit.snapshot.entries.length,
  realizedInstanceCount: world.instances.length,
  catalogGapCount: world.catalogResolution.gaps.length,
  robloxLoweringGapCount: importManifest.loweringGaps.length,
  blockers: [
    ...(fixture.catalogCommit.snapshot.entries.length === 0
      ? ["The outdoor tranche is pending the creator admission decision"]
      : []),
    ...(world.catalogResolution.gaps.length > 0
      ? ["One or more real catalog requirements remain unresolved"]
      : []),
    ...(importManifest.loweringGaps.length > 0
      ? ["One or more Roblox asset bindings remain missing"]
      : []),
  ],
};
const status = { ...statusBody, hash: contentHash(stableJson(statusBody)) };

await Promise.all([
  writeGeneratedJson(`${outputRoot}/catalog-use-evidence.json`, catalogUseEvidence),
  writeGeneratedJson(`${outputRoot}/stability-check.json`, stability),
  writeGeneratedJson(`${outputRoot}/roblox-import.json`, importManifest),
  writeGeneratedJson(`${outputRoot}/roblox-binding-upload-packet.json`, uploadPacket),
  writeGeneratedJson(
    `${outputRoot}/roblox-binding-decision-template.json`,
    bindingDecisionTemplate,
  ),
  writeGeneratedJson(`${outputRoot}/status.json`, status),
]);
await writeFile(
  resolve(repositoryRoot, `${outputRoot}/README.md`),
  creatorInstructions(status, uploadPacket),
  "utf8",
);

process.stdout.write(
  `${JSON.stringify(
    {
      status: status.status,
      catalogStatus: fixture.catalogCommit.status,
      catalogEntries: fixture.catalogCommit.snapshot.entries.length,
      worldStatus: world.status,
      instances: world.instances.length,
      catalogGaps: world.catalogResolution.gaps.length,
      robloxLoweringGaps: importManifest.loweringGaps.length,
      outputRoot,
    },
    null,
    2,
  )}\n`,
);

async function runWorldCompile(input, output) {
  await execFile(
    process.execPath,
    ["bin/basalt.js", "world", "compile", input, "--catalog", catalogPath, "--output", output],
    { cwd: repositoryRoot, maxBuffer: 16 * 1024 * 1024 },
  );
}

async function loadBindings(uploads) {
  const path = ".basalt/roblox/asset-bindings.json";
  let raw;
  try {
    raw = await readJson(path);
  } catch (error) {
    if (error?.code === "ENOENT") return { status: "absent", values: [] };
    throw error;
  }
  const values = ROBLOX_ASSET_BINDING_SCHEMA.array().parse(raw);
  for (const binding of values) {
    const resealed = sealRobloxAssetBinding({
      assetHash: binding.assetHash,
      robloxAssetId: binding.robloxAssetId,
      sourceArtifactHash: binding.sourceArtifactHash,
      uploadArtifactHash: binding.uploadArtifactHash,
      publicationEvidenceHash: binding.publicationEvidenceHash,
      materialExpectations: binding.materialExpectations,
    });
    if (resealed.bindingHash !== binding.bindingHash)
      throw new Error(`Roblox binding is not exactly sealed: ${binding.assetHash}`);
    const publication = uploads.bySource.get(binding.sourceArtifactHash);
    if (
      publication?.status !== "eligible" ||
      publication.robloxAssetId !== binding.robloxAssetId ||
      publication.uploadArtifact.artifactHash !== binding.uploadArtifactHash ||
      publication.uploadHash !== binding.publicationEvidenceHash
    )
      throw new Error(
        `Roblox binding lacks its exact eligible publication receipt: ${binding.assetHash}`,
      );
  }
  return { status: "present", values };
}

async function loadUploads() {
  const path = ".basalt/roblox/asset-uploads.json";
  let raw;
  try {
    raw = await readJson(path);
  } catch (error) {
    if (error?.code === "ENOENT") return { status: "absent", values: [], bySource: new Map() };
    throw error;
  }
  const ledger = ROBLOX_ASSET_UPLOAD_LEDGER_SCHEMA.parse(raw);
  await verifyRobloxUploadEvidence(repositoryRoot, ledger);
  return {
    status: "present",
    values: ledger.uploads,
    bySource: new Map(ledger.uploads.map((entry) => [entry.sourceArtifactHash, entry])),
  };
}

function bindingUploadItem(assetHash, uploads, proposedEntryHandle) {
  const asset = assetByHash.get(assetHash);
  if (!asset) throw new Error(`Roblox lowering gap references unknown asset ${assetHash}`);
  const source = sourceByHash.get(asset.source.contentHash);
  if (!source)
    throw new Error(`Roblox lowering gap references unknown source ${asset.source.contentHash}`);
  const publication = uploads.bySource.get(asset.source.sourceArtifact.artifactHash);
  return {
    assetHash,
    sourceContentHash: asset.source.contentHash,
    sourceRelativePath: source.relativePath,
    sourceArtifactHash: asset.source.sourceArtifact.artifactHash,
    ...(proposedEntryHandle ? { proposedEntryHandle } : {}),
    sourceMaterials: asset.materials,
    sourceParts: asset.parts.map((part) => ({
      partId: part.partId,
      materialHashes: part.materialHashes,
    })),
    uploadStatus: publication?.status ?? "missing",
    robloxDisplayName: publication?.status === "eligible" ? publication.displayName : null,
    robloxAssetId: publication?.status === "eligible" ? publication.robloxAssetId : null,
    uploadArtifactHash:
      publication?.status === "eligible" ? publication.uploadArtifact.artifactHash : null,
    publicationEvidenceHash: publication?.status === "eligible" ? publication.uploadHash : null,
    materialExpectations: null,
  };
}

function stableInstance(instance) {
  return {
    instanceId: instance.instanceId,
    intentId: instance.intentId,
    entryHandle: instance.entryHandle,
    memberId: instance.memberId,
    assetHash: instance.assetHash,
    transformMeters: instance.transformMeters,
    boundsMeters: instance.boundsMeters,
  };
}

function bindingInstructions(uploadItems) {
  return [
    ...(uploadItems.some((item) => item.uploadStatus !== "eligible")
      ? [
          "Run npm run eval:catalog-first-use:upload -- --scope required to publish deterministic Roblox-safe payloads for the required admitted assets, then re-run this materializer.",
        ]
      : []),
    ...(uploadItems.length > 0 && uploadItems.every((item) => item.uploadStatus === "eligible")
      ? [
          "In a creator-owned Studio place, insert each listed published model and inspect every material-bearing MeshPart and SurfaceAppearance.",
          "Record the exact instance path, class, Material, Color, Transparency, Reflectance, TextureID, SurfaceAppearance maps, and AlphaMode in the generated binding decision template.",
          "Seal the decision with npm run eval:catalog-first-use:seal-bindings, re-run this materializer, and require zero asset_binding lowering gaps before starting the import bridge.",
          "After the four-asset creator pilot passes, run npm run eval:catalog-first-use:upload -- --scope all to publish every admitted catalog asset with the same adaptation policy.",
        ]
      : []),
  ];
}

function creatorInstructions(status, uploadPacket) {
  const missingPublications = uploadPacket.missingBindings.filter(
    (item) => item.uploadStatus !== "eligible",
  );
  const lines = [
    "# Catalog-first-use creator gate",
    "",
    `Status: **${status.status}**. ${status.blockers.join(" ")}`,
    "",
    `Catalog result: ${status.admittedEntryCount} admitted entries, ${status.realizedInstanceCount} realized instances, ${status.catalogGapCount} catalog gaps, and ${status.robloxLoweringGapCount} Roblox lowering gaps.`,
    "",
  ];
  if (status.admittedEntryCount === 0) {
    lines.push(
      "## Next action: creator admission",
      "",
      "Complete the outdoor creator decision, apply it, seal and commit the catalog, then rerun `npm run eval:catalog-first-use`.",
      "",
    );
  } else if (status.catalogGapCount > 0) {
    lines.push(
      "## Next action: resolve catalog requirements",
      "",
      "Inspect `world-build.json` and `catalog-use-evidence.json`; do not substitute unadmitted sources for unresolved requirements.",
      "",
    );
  } else if (status.robloxLoweringGapCount > 0 && missingPublications.length > 0) {
    lines.push(
      "## Next action: publish the bounded replacement pilot",
      "",
      "The earlier publication IDs are not valid binding candidates. Publish the four required source-derived payloads with:",
      "",
      "`npm run eval:catalog-first-use:upload -- --scope required`",
      "",
      "Then rerun `npm run eval:catalog-first-use`; the new receipt-bound IDs will appear here. Do not use `--scope all` until the affected fern/tree and unchanged rock/log controls pass creator inspection.",
      "",
    );
  } else if (status.robloxLoweringGapCount > 0) {
    lines.push(
      "## Next action: creator-observed Roblox bindings",
      "",
      "The exact models are already published and their receipt-bound IDs are:",
      "",
      ...uploadPacket.missingBindings.map(
        (item) =>
          `- \`${item.robloxDisplayName ?? item.sourceContentHash}\` — Roblox asset \`${item.robloxAssetId}\`, Basalt asset \`${item.assetHash}\``,
      ),
      "",
      "1. In Studio, open a scratch Baseplate owned by the same creator. Open **Home → Toolbox → Inventory → My Models**, then click or drag each named model into the viewport.",
      "2. In **Explorer**, expand each inserted model. For every material-bearing `MeshPart`, use **Properties → Appearance** to record its exact instance path, class, Material, Color, Transparency, Reflectance, and TextureID. If it has a `SurfaceAppearance`, also record ColorMap, MetalnessMap, NormalMap, RoughnessMap, and AlphaMode.",
      "3. Put those observations, creator identity, statement, and timestamp into `roblox-binding-decision-template.json`, saved as `roblox-binding-decision.json`. Do not infer fields from the source GLB or upload receipt.",
      "4. Run `npm run eval:catalog-first-use:seal-bindings -- --decision .basalt/evals/catalog-first-use/roblox-binding-decision.json`, then `npm run eval:catalog-first-use`. Require zero lowering gaps.",
      "",
    );
  } else {
    lines.push(
      "## Next action: creator import gate",
      "",
      "Run `npm run plugin:build`, then `node bin/basalt.js roblox import .basalt/evals/catalog-first-use/world-build.json`. In Studio, open the Basalt plugin and choose **Import**. Play-test the trees, rocks, groundcover, props, and materials; stop play and preserve `.basalt/roblox/import-report.json`. Only that creator-run readback establishes engine verification.",
      "",
    );
  }
  return `${lines.join("\n")}\n`;
}

async function readJson(path) {
  return JSON.parse(await readFile(resolve(repositoryRoot, path), "utf8"));
}

async function writeGeneratedJson(path, value) {
  let expectedExistingHash;
  try {
    const current = await readBoundedWorkspaceBytes(repositoryRoot, path);
    expectedExistingHash = createHash("sha256").update(current).digest("hex");
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("missing")) throw error;
  }
  return writeCanonicalWorkspaceJson(repositoryRoot, path, value, {
    maxBytes: 128 * 1024 * 1024,
    ...(expectedExistingHash ? { expectedExistingHash } : {}),
  });
}
