import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { readBoundedWorkspaceBytes, writeCanonicalWorkspaceJson } from "@basalt/artifact-store";
import { HASH_SCHEMA, contentHash, stableJson } from "@basalt/contracts";
import {
  ROBLOX_ASSET_BINDING_SCHEMA,
  ROBLOX_ASSET_UPLOAD_LEDGER_SCHEMA,
  ROBLOX_MATERIAL_EXPECTATION_SCHEMA,
  sealRobloxAssetBinding,
} from "@basalt/roblox";
import { z } from "zod";
import { verifyRobloxUploadEvidence } from "./verify-roblox-upload-evidence.mjs";
import { verifyRobloxBindingCoverage } from "./verify-roblox-binding-coverage.mjs";

const BINDING_DECISION_INPUT_SCHEMA = z
  .object({
    kind: z.literal("CatalogFirstUseRobloxBindingDecision"),
    uploadPacketHash: HASH_SCHEMA,
    recordedBy: z
      .object({ authority: z.literal("creator"), reviewerId: z.string().trim().min(1).max(160) })
      .strict(),
    reviewerStatement: z.string().trim().min(32).max(2_048),
    recordedAt: z.string().datetime({ offset: true }),
    bindings: z
      .array(
        z
          .object({
            assetHash: HASH_SCHEMA,
            robloxAssetId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
            sourceArtifactHash: HASH_SCHEMA,
            uploadArtifactHash: HASH_SCHEMA,
            publicationEvidenceHash: HASH_SCHEMA,
            materialExpectations: z.array(ROBLOX_MATERIAL_EXPECTATION_SCHEMA).min(1).max(100_000),
          })
          .strict(),
      )
      .max(100_000),
  })
  .strict();

const repositoryRoot = resolve(".");
const outputRoot = ".basalt/evals/catalog-first-use";
const bindingsPath = ".basalt/roblox/asset-bindings.json";
const uploadsPath = ".basalt/roblox/asset-uploads.json";
const options = parseOptions(process.argv.slice(2));
const packetPath = options.get("--packet") ?? `${outputRoot}/roblox-binding-upload-packet.json`;
const packetDirectory = dirname(packetPath);
const decisionPath = options.get("--decision") ?? `${packetDirectory}/roblox-binding-decision.json`;
const sealedDecisionPath = `${packetDirectory}/roblox-binding-decision-sealed.json`;

const uploadPacket = await readJson(packetPath);
verifySealedJson(uploadPacket, "Roblox binding upload packet");
const expectedItems = z
  .array(
    z
      .object({
        assetHash: HASH_SCHEMA,
        sourceArtifactHash: HASH_SCHEMA,
        uploadArtifactHash: HASH_SCHEMA,
        robloxAssetId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        publicationEvidenceHash: HASH_SCHEMA,
      })
      .passthrough(),
  )
  .parse(uploadPacket.missingBindings);
const expectedByAsset = new Map(expectedItems.map((entry) => [entry.assetHash, entry]));
const existing = await loadExistingBindings();
const uploadLedger =
  expectedItems.length > 0 || existing.length > 0
    ? ROBLOX_ASSET_UPLOAD_LEDGER_SCHEMA.parse(await readJson(uploadsPath))
    : undefined;
if (uploadLedger) await verifyRobloxUploadEvidence(repositoryRoot, uploadLedger);
const eligibleUploads = new Map(
  (uploadLedger?.uploads ?? [])
    .filter((entry) => entry.status === "eligible")
    .map((entry) => [entry.sourceArtifactHash, entry]),
);

const decisionInput = BINDING_DECISION_INPUT_SCHEMA.parse(await readJson(decisionPath));
if (decisionInput.uploadPacketHash !== uploadPacket.hash)
  throw new Error("Roblox binding decision binds another upload packet");
if (
  new Set(decisionInput.bindings.map((entry) => entry.assetHash)).size !==
  decisionInput.bindings.length
)
  throw new Error("Roblox binding decision contains duplicate assets");
if (
  stableJson(decisionInput.bindings.map((entry) => entry.assetHash).sort()) !==
  stableJson([...expectedByAsset.keys()].sort())
)
  throw new Error("Roblox binding decision must cover exactly every missing binding");

const sealedBindings = [];
for (const entry of decisionInput.bindings) {
  const expected = expectedByAsset.get(entry.assetHash);
  if (
    !expected ||
    entry.sourceArtifactHash !== expected.sourceArtifactHash ||
    entry.uploadArtifactHash !== expected.uploadArtifactHash
  )
    throw new Error(`Roblox binding source artifact mismatch: ${entry.assetHash}`);
  const upload = eligibleUploads.get(entry.sourceArtifactHash);
  if (
    !upload ||
    entry.robloxAssetId !== upload.robloxAssetId ||
    entry.uploadArtifactHash !== upload.uploadArtifact.artifactHash ||
    entry.publicationEvidenceHash !== upload.uploadHash ||
    entry.robloxAssetId !== expected.robloxAssetId ||
    entry.publicationEvidenceHash !== expected.publicationEvidenceHash
  )
    throw new Error(
      `Roblox binding does not match its eligible publication receipt: ${entry.assetHash}`,
    );
  await verifyRobloxBindingCoverage(repositoryRoot, entry, upload);
  sealedBindings.push(sealRobloxAssetBinding(entry));
}
const merged = new Map(existing.map((entry) => [entry.assetHash, entry]));
for (const binding of sealedBindings) {
  merged.set(binding.assetHash, binding);
}
const values = [...merged.values()].sort((left, right) =>
  left.assetHash.localeCompare(right.assetHash),
);
for (const binding of values) {
  const upload = eligibleUploads.get(binding.sourceArtifactHash);
  if (!upload)
    throw new Error(`Existing Roblox binding lacks an eligible upload: ${binding.assetHash}`);
  await verifyRobloxBindingCoverage(repositoryRoot, binding, upload);
}
const canonicalDecisionBody = {
  ...decisionInput,
  bindings: [...decisionInput.bindings].sort((left, right) =>
    left.assetHash.localeCompare(right.assetHash),
  ),
};
const sealedDecision = {
  ...canonicalDecisionBody,
  hash: contentHash(stableJson(canonicalDecisionBody)),
};

await Promise.all([
  writeGeneratedJson(bindingsPath, values),
  writeGeneratedJson(sealedDecisionPath, sealedDecision),
]);
process.stdout.write(
  `${JSON.stringify(
    {
      uploadPacketHash: uploadPacket.hash,
      decisionHash: sealedDecision.hash,
      sealedBindings: sealedBindings.length,
      totalBindings: values.length,
      output: resolve(repositoryRoot, bindingsPath),
    },
    null,
    2,
  )}\n`,
);

async function loadExistingBindings() {
  let raw;
  try {
    raw = await readJson(bindingsPath);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
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
      throw new Error(`Existing Roblox binding is not exactly sealed: ${binding.assetHash}`);
  }
  return values;
}

function verifySealedJson(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.hash !== "string")
    throw new Error(`${label} is not a sealed object`);
  const material = { ...value };
  delete material.hash;
  if (contentHash(stableJson(material)) !== value.hash) throw new Error(`${label} hash mismatch`);
}

function parseOptions(values) {
  const result = new Map();
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith("--") || !value)
      throw new Error("Binding sealer options must be --name value pairs");
    result.set(key, value);
  }
  return result;
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
