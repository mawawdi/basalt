import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { readBoundedWorkspaceBytes, writeCanonicalWorkspaceJson } from "@basalt/artifact-store";
import { contentHash, stableJson } from "@basalt/contracts";
import {
  ROBLOX_ASSET_BINDING_SCHEMA,
  ROBLOX_ASSET_UPLOAD_LEDGER_SCHEMA,
  createRobloxImportManifest,
  sealRobloxAssetBinding,
} from "@basalt/roblox";
import { compileBasaltWorld } from "@basalt/world-compiler";
import {
  harvestValleyFixture,
  HARVEST_VALLEY_OUTPUT_ROOT,
  HARVEST_VALLEY_SIZE_METERS,
} from "../dist/test/helpers/harvest-valley-fixture.js";
import { loadSemanticRegistry } from "../dist/test/helpers/semantic-registry.js";
import { verifyRobloxBindingCoverage } from "./verify-roblox-binding-coverage.mjs";
import { verifyRobloxUploadEvidence } from "./verify-roblox-upload-evidence.mjs";

const root = resolve(".");
const output = HARVEST_VALLEY_OUTPUT_ROOT;
const json = async (path) => JSON.parse(await readFile(resolve(root, path), "utf8"));
const fixture = await harvestValleyFixture(await loadSemanticRegistry());
const world = compileBasaltWorld(fixture.compileInput);
await writeJson(`${output}/spatial-plan.json`, fixture.plan);
await writeJson(`${output}/world-build.json`, world);
if (world.status !== "eligible")
  throw new Error(
    JSON.stringify(
      {
        status: world.status,
        foundation: world.foundation.diagnostics,
        meso: world.meso.diagnostics,
        micro: world.micro.diagnostics,
        gaps: world.catalogResolution.gaps,
      },
      null,
      2,
    ),
  );
const uploads = ROBLOX_ASSET_UPLOAD_LEDGER_SCHEMA.parse(
  await json(".basalt/roblox/asset-uploads.json"),
);
await verifyRobloxUploadEvidence(root, uploads);
const bindings = ROBLOX_ASSET_BINDING_SCHEMA.array().parse(
  await json(".basalt/roblox/asset-bindings.json"),
);
const uploadBySource = new Map(uploads.uploads.map((entry) => [entry.sourceArtifactHash, entry]));
for (const binding of bindings) {
  const bindingBody = {
    assetHash: binding.assetHash,
    robloxAssetId: binding.robloxAssetId,
    sourceArtifactHash: binding.sourceArtifactHash,
    uploadArtifactHash: binding.uploadArtifactHash,
    publicationEvidenceHash: binding.publicationEvidenceHash,
    materialExpectations: binding.materialExpectations,
  };
  if (sealRobloxAssetBinding(bindingBody).bindingHash !== binding.bindingHash)
    throw new Error(`Binding seal mismatch: ${binding.assetHash}`);
  const upload = uploadBySource.get(binding.sourceArtifactHash);
  if (
    upload?.status !== "eligible" ||
    upload.uploadHash !== binding.publicationEvidenceHash ||
    upload.robloxAssetId !== binding.robloxAssetId ||
    upload.uploadArtifact.artifactHash !== binding.uploadArtifactHash
  )
    throw new Error(`Binding upload mismatch: ${binding.assetHash}`);
  await verifyRobloxBindingCoverage(root, binding, upload);
}
const manifest = createRobloxImportManifest(world, bindings);
const assets = new Map(fixture.measurements.assets.map((entry) => [entry.hash, entry]));
const sources = new Map(
  fixture.catalogCommit.sourceManifest.assets.map((entry) => [entry.contentHash, entry]),
);
const missing = new Set(
  manifest.loweringGaps.filter((gap) => gap.kind === "asset_binding").map((gap) => gap.subjectHash),
);
const used = [
  ...new Map(world.instances.map((instance) => [instance.assetHash, instance])).values(),
].sort((a, b) => a.entryHandle.localeCompare(b.entryHandle));
const admittedAssets = used.map((instance) => {
  const asset = assets.get(instance.assetHash);
  const source = sources.get(asset.source.contentHash);
  const upload = uploadBySource.get(asset.source.sourceArtifact.artifactHash);
  return {
    assetHash: asset.hash,
    sourceContentHash: source.contentHash,
    sourceArtifactHash: asset.source.sourceArtifact.artifactHash,
    sourceRelativePath: source.relativePath,
    proposedEntryHandle: instance.entryHandle,
    uploadStatus: upload?.status ?? "missing",
    robloxAssetId: upload?.status === "eligible" ? upload.robloxAssetId : null,
    uploadArtifactHash: upload?.status === "eligible" ? upload.uploadArtifact.artifactHash : null,
    publicationEvidenceHash: upload?.status === "eligible" ? upload.uploadHash : null,
    partCount: asset.parts.length,
    materialExpectations: null,
  };
});
const packetBody = {
  kind: "CatalogFirstUseRobloxUploadPacket",
  catalogCommitHash: fixture.catalogCommit.hash,
  worldBuildHash: world.worldBuildHash,
  missingBindings: admittedAssets.filter((entry) => missing.has(entry.assetHash)),
  admittedAssets,
};
const packet = { ...packetBody, hash: contentHash(stableJson(packetBody)) };
const counts = Object.fromEntries(
  used.map((entry) => [
    entry.entryHandle,
    world.instances.filter((instance) => instance.assetHash === entry.assetHash).length,
  ]),
);
const status = {
  kind: "HarvestValleyStatus",
  regionName: "Harvest Valley",
  dimensionsMeters: { x: HARVEST_VALLEY_SIZE_METERS, z: HARVEST_VALLEY_SIZE_METERS },
  worldBuildHash: world.worldBuildHash,
  compilerStatus: world.status,
  robloxLoweringStatus: manifest.loweringGaps.length === 0 ? "eligible" : "incomplete",
  creatorGateStatus: "incomplete",
  engineVerified: false,
  catalogEntryCount: fixture.catalogCommit.snapshot.entries.length,
  instanceCount: world.instances.length,
  distinctAssetCount: used.length,
  routeCount: fixture.plan.routes.length,
  junctionCount: fixture.plan.routeJunctions.length,
  constructedStructureCount: world.meso.constructedStructures.length,
  missingRobloxBindings: missing.size,
  counts,
  limits: [
    "Static exterior scene; building interiors and interactive props are not asserted.",
    "Studio visual inspection, traversal and readback must be performed by the creator.",
  ],
};
await writeJson(`${output}/roblox-import.json`, manifest);
await writeJson(`${output}/roblox-binding-upload-packet.json`, packet);
await writeJson(`${output}/status.json`, status);
await writeFile(
  resolve(root, `${output}/README.md`),
  [
    "# Harvest Valley",
    "",
    `A ${HARVEST_VALLEY_SIZE_METERS} × ${HARVEST_VALLEY_SIZE_METERS} m wooded farming valley with ${world.instances.length} catalog instances across ${used.length} source models. Detailed farm buildings, fenced crops, a six-tree orchard, working farmyards, a wind pump, a natural rock arch, a market and a campsite connect through ${fixture.plan.routes.length} dirt paths. No constructed towers, buildings or stairs.`,
    "",
    `Compiler: **${world.status}**. Roblox lowering: **${status.robloxLoweringStatus}**. Missing material bindings: **${missing.size}**.`,
    "",
    "Use a separate empty Studio place. Reopen Studio after rebuilding the connector with `npm run plugin:build`.",
    "",
    "```sh",
    `node scripts/capture-catalog-bindings.mjs --packet ${output}/roblox-binding-upload-packet.json`,
    "# In Studio, open Basalt and click Inspect assets. Stop the capture bridge when complete.",
    `node scripts/seal-catalog-first-use-bindings.mjs --packet ${output}/roblox-binding-upload-packet.json --decision ${output}/roblox-binding-decision.json`,
    "npm run eval:harvest-valley",
    `node bin/basalt.js roblox import ${output}/world-build.json`,
    "```",
    "",
    "Click Import in the Basalt panel. Play-test the farm court, barns, campsite and ridge loop, then retain exact connector readback. Static building exteriors and props have no promised interior or interactive behavior. Preview screenshots are approximate WebGL renders, not Studio evidence.",
    "",
  ].join("\n"),
);
console.log(JSON.stringify(status, null, 2));

async function writeJson(path, value) {
  await mkdir(resolve(root, output), { recursive: true });
  const existing = await readBoundedWorkspaceBytes(root, path, 256 * 1024 * 1024).catch((error) => {
    if (error.code === "ENOENT" || error.message.includes("missing")) return undefined;
    throw error;
  });
  await writeCanonicalWorkspaceJson(root, path, value, {
    maxBytes: 256 * 1024 * 1024,
    ...(existing === undefined
      ? {}
      : { expectedExistingHash: createHash("sha256").update(existing).digest("hex") }),
  });
}
