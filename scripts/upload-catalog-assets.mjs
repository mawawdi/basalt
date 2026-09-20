#!/usr/bin/env node
// Derives deterministic Roblox-safe GLBs from exact catalog sources and
// publishes those payloads through Roblox Open Cloud. Publication establishes
// an asset ID only: admission and engine-observed material bindings remain
// separate gates.
import { createHash } from "node:crypto";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ImmutableBinaryArtifactStore,
  readBoundedWorkspaceBytes,
  writeCanonicalWorkspaceJson,
} from "@basalt/artifact-store";
import { inspectGlb } from "@basalt/asset-inspection";
import { HASH_SCHEMA, contentHash, stableJson } from "@basalt/contracts";
import {
  ROBLOX_ASSET_UPLOAD_LEDGER_SCHEMA,
  adaptGlbForRobloxUpload,
  robloxAssetUploadRequestHash,
  sealRobloxAssetUpload,
  sealRobloxAssetUploadLedger,
} from "@basalt/roblox";
import { z } from "zod";
import { readEnvFileKey } from "./read-env-file.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_PACKET = ".basalt/evals/catalog-first-use/roblox-binding-upload-packet.json";
const DEFAULT_LEDGER = ".basalt/roblox/asset-uploads.json";
const DEFAULT_LOCK = ".basalt/roblox/asset-uploads.lock";
const DEFAULT_ARTIFACT_STORE = ".basalt/roblox/upload-artifacts";
const DEFAULT_API_ORIGIN = "https://apis.roblox.com";
const MAX_MODEL_BYTES = 20 * 1024 * 1024;

const uploadItemSchema = z
  .object({
    assetHash: HASH_SCHEMA,
    sourceContentHash: HASH_SCHEMA,
    sourceArtifactHash: HASH_SCHEMA,
    sourceRelativePath: z.string().trim().min(1).max(1024),
    proposedEntryHandle: z.string().trim().min(1).max(160).optional(),
  })
  .passthrough();

const uploadPacketSchema = z
  .object({
    kind: z.literal("CatalogFirstUseRobloxUploadPacket"),
    missingBindings: z.array(uploadItemSchema),
    admittedAssets: z.array(uploadItemSchema),
    hash: HASH_SCHEMA,
  })
  .passthrough();

let activeLockRelease;

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const packetPath = options.values.get("--packet") ?? DEFAULT_PACKET;
  const ledgerPath = options.values.get("--ledger") ?? DEFAULT_LEDGER;
  const lockPath = options.values.get("--lock") ?? DEFAULT_LOCK;
  const artifactStorePath = options.values.get("--artifact-store") ?? DEFAULT_ARTIFACT_STORE;
  const scope = z.enum(["required", "all"]).parse(options.values.get("--scope") ?? "required");
  const dryRun = options.flags.has("--dry-run");
  const retryFailed = options.flags.has("--retry-failed");
  const apiOrigin = validatedApiOrigin(options.values.get("--api-origin") ?? DEFAULT_API_ORIGIN);
  const maxUploads = positiveInteger(
    options.values.get("--max-uploads") ?? String(Number.MAX_SAFE_INTEGER),
    "--max-uploads",
  );
  const pollIntervalMs = positiveInteger(
    options.values.get("--poll-interval-ms") ?? "2000",
    "--poll-interval-ms",
  );
  const pollTimeoutMs = positiveInteger(
    options.values.get("--poll-timeout-ms") ?? "300000",
    "--poll-timeout-ms",
  );
  if (pollTimeoutMs < pollIntervalMs)
    throw new Error("--poll-timeout-ms must be at least --poll-interval-ms");
  if (new URL(apiOrigin).hostname !== "127.0.0.1" && pollIntervalMs < 1000)
    throw new Error("Production polling intervals must be at least 1000 milliseconds");

  const creatorUserId = configuredUserId();
  const packet = uploadPacketSchema.parse(await readWorkspaceJson(packetPath));
  verifySealedJson(packet, "Roblox binding upload packet", "hash");
  validatePacketScopes(packet);
  const selected = await prepareSources(packet, scope, creatorUserId);

  if (dryRun) {
    print({
      status: "eligible",
      dryRun: true,
      scope,
      creator: { userId: creatorUserId },
      uploadPacketHash: packet.hash,
      selectedSources: selected.length,
      selectedBytes: selected.reduce((sum, entry) => sum + entry.bytes.byteLength, 0),
      adaptedSources: selected.filter(
        (entry) => entry.uploadArtifact.artifactHash !== entry.sourceArtifactHash,
      ).length,
      strippedPrimitiveAttributes: selected.reduce(
        (sum, entry) => sum + entry.adaptation.strippedPrimitiveAttributeCount,
        0,
      ),
      expectedPrice: 0,
      networkRequests: 0,
    });
    return;
  }

  const apiKey =
    process.env.BASALT_ROBLOX_API_KEY || readEnvFileKey(repositoryRoot, "BASALT_ROBLOX_API_KEY");
  if (!apiKey) throw new Error("Uploads require BASALT_ROBLOX_API_KEY in the environment or .env");
  await verifyApiKey({ apiOrigin, apiKey, creatorUserId });

  activeLockRelease = await acquireUploadLock(lockPath);
  try {
    const artifactStore = new ImmutableBinaryArtifactStore(
      workspaceAbsolute(artifactStorePath, "Upload artifact store"),
      { maxBytes: MAX_MODEL_BYTES },
    );
    const loaded = await loadLedger(ledgerPath, creatorUserId);
    const uploads = new Map(loaded.uploads.map((entry) => [entry.sourceArtifactHash, entry]));
    let submitted = 0;
    let resumed = 0;
    let reused = 0;
    let refreshed = 0;
    const failures = [];

    for (const source of selected) {
      await persistUploadArtifact(artifactStore, source);
      let upload = uploads.get(source.sourceArtifactHash);
      if (upload && !samePublishedSource(upload, source))
        throw new Error(`Upload ledger source mismatch: ${source.sourceArtifactHash}`);

      try {
        if (upload?.status === "eligible") {
          reused += 1;
          continue;
        }
        if (upload?.status === "pending_moderation") {
          upload = await refreshModeration({ apiOrigin, apiKey, upload });
          uploads.set(source.sourceArtifactHash, upload);
          await persistLedger(ledgerPath, creatorUserId, uploads);
          refreshed += 1;
          if (upload.status === "rejected")
            failures.push({
              sourceArtifactHash: source.sourceArtifactHash,
              reason: `Roblox moderation rejected asset ${upload.robloxAssetId}`,
            });
          continue;
        }
        if (upload?.status === "rejected") {
          failures.push({
            sourceArtifactHash: source.sourceArtifactHash,
            reason: `Roblox moderation rejected asset ${upload.robloxAssetId}`,
          });
          continue;
        }
        if (upload?.status === "failed" && !retryFailed) {
          failures.push({
            sourceArtifactHash: source.sourceArtifactHash,
            reason: "Previous upload failed; inspect the ledger and use --retry-failed",
          });
          continue;
        }
        if (upload?.status === "pending_operation") {
          resumed += 1;
        } else {
          if (submitted >= maxUploads) continue;
          upload = await submitUpload({ apiOrigin, apiKey, source });
          uploads.set(source.sourceArtifactHash, upload);
          await persistLedger(ledgerPath, creatorUserId, uploads);
          submitted += 1;
        }

        const completed = await pollOperation({
          apiOrigin,
          apiKey,
          upload,
          pollIntervalMs,
          pollTimeoutMs,
        });
        if (completed) {
          uploads.set(source.sourceArtifactHash, completed);
          await persistLedger(ledgerPath, creatorUserId, uploads);
          if (completed.status === "rejected")
            failures.push({
              sourceArtifactHash: source.sourceArtifactHash,
              reason: `Roblox moderation rejected asset ${completed.robloxAssetId}`,
            });
        }
      } catch (error) {
        const message = redact(errorMessage(error), apiKey);
        const current = uploads.get(source.sourceArtifactHash);
        if (error instanceof DefinitiveOperationError && current) {
          uploads.set(
            source.sourceArtifactHash,
            sealRobloxAssetUpload({
              ...withoutUploadHash(current),
              status: "failed",
              robloxAssetId: null,
              revisionId: null,
              moderationState: null,
              completedAt: new Date().toISOString(),
              failure: { code: error.code, message },
            }),
          );
          await persistLedger(ledgerPath, creatorUserId, uploads);
        }
        failures.push({ sourceArtifactHash: source.sourceArtifactHash, reason: message });
      }
    }

    const ledger = await persistLedger(ledgerPath, creatorUserId, uploads);
    const selectedStates = selected.map((source) => uploads.get(source.sourceArtifactHash)?.status);
    const report = {
      status:
        failures.length > 0
          ? "failed"
          : selectedStates.every((status) => status === "eligible")
            ? "eligible"
            : "incomplete",
      scope,
      creator: { userId: creatorUserId },
      uploadPacketHash: packet.hash,
      selectedSources: selected.length,
      selectedBytes: selected.reduce((sum, entry) => sum + entry.bytes.byteLength, 0),
      adaptedSources: selected.filter(
        (entry) => entry.uploadArtifact.artifactHash !== entry.sourceArtifactHash,
      ).length,
      strippedPrimitiveAttributes: selected.reduce(
        (sum, entry) => sum + entry.adaptation.strippedPrimitiveAttributeCount,
        0,
      ),
      submitted,
      resumed,
      reused,
      refreshed,
      states: countValues(selectedStates),
      failures,
      ledger: resolve(repositoryRoot, ledgerPath),
      ledgerHash: ledger.ledgerHash,
      artifactStore: workspaceAbsolute(artifactStorePath, "Upload artifact store"),
    };
    print(report);
    if (failures.length > 0) process.exitCode = 1;
  } finally {
    await releaseActiveLock();
  }
}

async function prepareSources(packet, scope, creatorUserId) {
  const requested = scope === "required" ? packet.missingBindings : packet.admittedAssets;
  const sources = new Map();
  for (const item of requested) {
    const prior = sources.get(item.sourceArtifactHash);
    if (
      prior &&
      (prior.sourceContentHash !== item.sourceContentHash ||
        prior.sourceRelativePath !== item.sourceRelativePath)
    )
      throw new Error(`Conflicting upload packet source: ${item.sourceArtifactHash}`);
    if (prior) continue;
    if (!item.sourceRelativePath.toLowerCase().endsWith(".glb"))
      throw new Error(`Open Cloud catalog uploads require GLB input: ${item.sourceRelativePath}`);
    const sourceBytes = Buffer.from(
      await readBoundedWorkspaceBytes(repositoryRoot, item.sourceRelativePath, MAX_MODEL_BYTES),
    );
    const bytesHash = createHash("sha256").update(sourceBytes).digest("hex");
    if (bytesHash !== item.sourceContentHash || bytesHash !== item.sourceArtifactHash)
      throw new Error(`Upload source hash mismatch: ${item.sourceRelativePath}`);
    const sourceInspection = inspectGlb(sourceBytes, {
      maximumBytes: MAX_MODEL_BYTES,
      allowDeformableGeometry: true,
    });
    const adapted = adaptGlbForRobloxUpload(sourceBytes);
    const bytes = Buffer.from(adapted.bytes);
    const uploadInspection = inspectGlb(bytes, {
      maximumBytes: MAX_MODEL_BYTES,
      allowDeformableGeometry: true,
    });
    if (
      stableJson(uploadInvariantProjection(sourceInspection)) !==
      stableJson(uploadInvariantProjection(uploadInspection))
    )
      throw new Error(
        `Roblox upload adaptation changed visual or geometric evidence: ${item.sourceRelativePath}`,
      );
    const uploadArtifactHash = createHash("sha256").update(bytes).digest("hex");
    const uploadArtifact = {
      locator: `binary-artifacts/${uploadArtifactHash}.bin`,
      artifactHash: uploadArtifactHash,
      bytes: bytes.byteLength,
      mediaType: "model/gltf-binary",
    };
    const creator = { userId: creatorUserId };
    const assetType = "Model";
    const displayName = displayNameFor(item, uploadArtifactHash);
    const description = `Basalt catalog source ${item.sourceArtifactHash}; Roblox payload ${uploadArtifactHash}`;
    const expectedPrice = 0;
    const requestHash = robloxAssetUploadRequestHash({
      creator,
      sourceArtifactHash: item.sourceArtifactHash,
      uploadArtifact,
      adaptation: adapted.adaptation,
      assetType,
      displayName,
      description,
      expectedPrice,
    });
    sources.set(item.sourceArtifactHash, {
      ...item,
      bytes,
      sourceBytes: sourceBytes.byteLength,
      uploadArtifact,
      adaptation: adapted.adaptation,
      creator,
      assetType,
      displayName,
      description,
      expectedPrice,
      requestHash,
    });
  }
  return [...sources.values()].sort((left, right) =>
    left.sourceArtifactHash.localeCompare(right.sourceArtifactHash),
  );
}

function validatePacketScopes(packet) {
  const admittedByAsset = new Map();
  for (const item of packet.admittedAssets) {
    if (admittedByAsset.has(item.assetHash))
      throw new Error(`Upload packet repeats admitted asset: ${item.assetHash}`);
    admittedByAsset.set(item.assetHash, item);
  }
  const requiredAssets = new Set();
  for (const item of packet.missingBindings) {
    if (requiredAssets.has(item.assetHash))
      throw new Error(`Upload packet repeats required asset: ${item.assetHash}`);
    requiredAssets.add(item.assetHash);
    const admitted = admittedByAsset.get(item.assetHash);
    if (
      !admitted ||
      admitted.sourceContentHash !== item.sourceContentHash ||
      admitted.sourceArtifactHash !== item.sourceArtifactHash ||
      admitted.sourceRelativePath !== item.sourceRelativePath
    )
      throw new Error(`Required upload is not an exact admitted asset: ${item.assetHash}`);
  }
}

function uploadInvariantProjection(report) {
  const stableReport = { ...report };
  delete stableReport.byteLength;
  delete stableReport.jsonHash;
  delete stableReport.hash;
  const nodes = stableReport.nodes;
  delete stableReport.nodes;
  return {
    ...stableReport,
    nodes: nodes.map((entry) => {
      const node = { ...entry };
      delete node.attributeNames;
      return node;
    }),
  };
}

async function submitUpload({ apiOrigin, apiKey, source }) {
  const form = new FormData();
  form.set(
    "request",
    JSON.stringify({
      assetType: source.assetType,
      displayName: source.displayName,
      description: source.description,
      creationContext: { creator: source.creator, expectedPrice: source.expectedPrice },
    }),
  );
  form.set(
    "fileContent",
    new Blob([source.bytes], { type: "model/gltf-binary" }),
    `${source.uploadArtifact.artifactHash}.glb`,
  );
  const operation = await apiJson(
    `${apiOrigin}/assets/v1/assets`,
    { method: "POST", headers: { "x-api-key": apiKey }, body: form },
    "Asset create",
    apiKey,
  );
  const operationPath = operationPathFrom(operation);
  return sealRobloxAssetUpload({
    status: "pending_operation",
    creator: source.creator,
    sourceContentHash: source.sourceContentHash,
    sourceArtifactHash: source.sourceArtifactHash,
    sourceRelativePath: source.sourceRelativePath,
    sourceBytes: source.sourceBytes,
    uploadArtifact: source.uploadArtifact,
    adaptation: source.adaptation,
    assetType: source.assetType,
    displayName: source.displayName,
    description: source.description,
    expectedPrice: source.expectedPrice,
    requestHash: source.requestHash,
    operationPath,
    robloxAssetId: null,
    revisionId: null,
    moderationState: null,
    startedAt: new Date().toISOString(),
    completedAt: null,
    failure: null,
  });
}

async function pollOperation({ apiOrigin, apiKey, upload, pollIntervalMs, pollTimeoutMs }) {
  const deadline = Date.now() + pollTimeoutMs;
  for (;;) {
    const operationId = upload.operationPath.slice("operations/".length);
    const operation = await apiJson(
      `${apiOrigin}/assets/v1/operations/${encodeURIComponent(operationId)}`,
      { headers: { "x-api-key": apiKey } },
      "Operation poll",
      apiKey,
    );
    if (operation?.error)
      throw new DefinitiveOperationError(
        operation.error.code ?? null,
        String(operation.error.message ?? "Roblox asset operation failed"),
      );
    if (operation?.done === true) return completedUpload(upload, operation.response);
    if (Date.now() >= deadline) return undefined;
    await new Promise((done) => setTimeout(done, pollIntervalMs));
  }
}

async function refreshModeration({ apiOrigin, apiKey, upload }) {
  const asset = await apiJson(
    `${apiOrigin}/assets/v1/assets/${upload.robloxAssetId}`,
    { headers: { "x-api-key": apiKey } },
    "Asset metadata",
    apiKey,
  );
  const returnedId = positiveAssetId(asset?.assetId);
  if (returnedId !== upload.robloxAssetId)
    throw new Error(`Asset metadata returned another ID for ${upload.sourceArtifactHash}`);
  const moderationState = moderationStateFrom(asset);
  return sealRobloxAssetUpload({
    ...withoutUploadHash(upload),
    status: uploadStatusFor(moderationState),
    revisionId: revisionIdFrom(asset),
    moderationState,
  });
}

function completedUpload(upload, response) {
  const robloxAssetId = positiveAssetId(response?.assetId);
  const moderationState = moderationStateFrom(response);
  return sealRobloxAssetUpload({
    ...withoutUploadHash(upload),
    status: uploadStatusFor(moderationState),
    robloxAssetId,
    revisionId: revisionIdFrom(response),
    moderationState,
    completedAt: new Date().toISOString(),
    failure: null,
  });
}

function uploadStatusFor(moderationState) {
  if (/approved/iu.test(moderationState)) return "eligible";
  if (/rejected/iu.test(moderationState)) return "rejected";
  return "pending_moderation";
}

function moderationStateFrom(asset) {
  const state = asset?.moderationResult?.moderationState;
  return typeof state === "string" && state.trim() ? state.trim() : "Unspecified";
}

function revisionIdFrom(asset) {
  const revisionId = asset?.revisionId;
  return typeof revisionId === "string" && /^\d+$/u.test(revisionId) ? revisionId : null;
}

function positiveAssetId(value) {
  const text = String(value ?? "");
  if (!/^[1-9]\d*$/u.test(text)) throw new Error("Roblox response did not contain an asset ID");
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed)) throw new Error("Roblox asset ID exceeds safe integer range");
  return parsed;
}

function operationPathFrom(operation) {
  const value = operation?.path;
  if (typeof value !== "string" || !/^operations\/[A-Za-z0-9_-]{1,256}$/u.test(value))
    throw new Error("Asset create did not return a valid operation path");
  return value;
}

async function verifyApiKey({ apiOrigin, apiKey, creatorUserId }) {
  const introspection = await apiJson(
    `${apiOrigin}/api-keys/v1/introspect`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey }),
    },
    "API key introspection",
    apiKey,
  );
  if (introspection?.enabled !== true || introspection?.expired === true)
    throw new Error("BASALT_ROBLOX_API_KEY is disabled or expired");
  const scopes = Array.isArray(introspection?.scopes) ? introspection.scopes : [];
  const authorized = scopes.some(
    (scope) =>
      scope?.name === "asset" &&
      Array.isArray(scope.operations) &&
      scope.operations.includes("read") &&
      scope.operations.includes("write") &&
      Array.isArray(scope.userIds) &&
      (scope.userIds.includes("*") || scope.userIds.map(String).includes(String(creatorUserId))),
  );
  if (!authorized)
    throw new Error("BASALT_ROBLOX_API_KEY lacks read/write asset access for ROBLOX_USER_ID");
}

async function apiJson(url, init, label, apiKey) {
  let response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
  } catch (error) {
    throw new Error(`${label} request failed: ${redact(errorMessage(error), apiKey)}`, {
      cause: error,
    });
  }
  const responseText = await response.text();
  if (!response.ok) {
    const message = redact(responseText.slice(0, 1000).trim(), apiKey);
    throw new Error(`${label} failed with HTTP ${response.status}${message ? `: ${message}` : ""}`);
  }
  try {
    return JSON.parse(responseText);
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
}

async function loadLedger(path, creatorUserId) {
  let raw;
  try {
    raw = await readWorkspaceJson(path);
  } catch (error) {
    if (/missing|does not exist/iu.test(errorMessage(error)))
      return sealRobloxAssetUploadLedger({ creator: { userId: creatorUserId }, uploads: [] });
    throw error;
  }
  const ledger = ROBLOX_ASSET_UPLOAD_LEDGER_SCHEMA.parse(raw);
  if (ledger.creator.userId !== creatorUserId)
    throw new Error("Roblox upload ledger belongs to another ROBLOX_USER_ID");
  return ledger;
}

async function persistLedger(path, creatorUserId, uploads) {
  const ledger = sealRobloxAssetUploadLedger({
    creator: { userId: creatorUserId },
    uploads: [...uploads.values()],
  });
  let expectedExistingHash;
  try {
    const existing = await readBoundedWorkspaceBytes(repositoryRoot, path, 128 * 1024 * 1024);
    expectedExistingHash = createHash("sha256").update(existing).digest("hex");
  } catch (error) {
    if (!/missing|does not exist/iu.test(errorMessage(error))) throw error;
  }
  await writeCanonicalWorkspaceJson(repositoryRoot, path, ledger, {
    maxBytes: 128 * 1024 * 1024,
    ...(expectedExistingHash ? { expectedExistingHash } : {}),
  });
  return ledger;
}

async function acquireUploadLock(path) {
  const absolute = workspaceAbsolute(path, "Upload lock");
  await mkdir(dirname(absolute), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(absolute, "wx", 0o600);
      await handle.writeFile(String(process.pid));
      await handle.close();
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        await unlink(absolute).catch((error) => {
          if (error?.code !== "ENOENT") throw error;
        });
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const holder = await readFile(absolute, "utf8").catch(() => "");
      const pid = Number.parseInt(holder.trim(), 10);
      let alive = Number.isSafeInteger(pid) && pid > 0;
      if (alive) {
        try {
          process.kill(pid, 0);
        } catch (signal) {
          if (signal?.code === "ESRCH") alive = false;
          else if (signal?.code !== "EPERM") throw signal;
        }
      }
      if (alive)
        throw new Error(`Another catalog asset upload holds ${path}`, {
          cause: error,
        });
      await unlink(absolute);
    }
  }
  throw new Error(`Could not acquire catalog asset upload lock ${path}`);
}

function workspaceAbsolute(path, label) {
  const absolute = resolve(repositoryRoot, path);
  const fromRoot = relative(repositoryRoot, absolute);
  if (!fromRoot || fromRoot === ".." || fromRoot.startsWith(`..${sep}`))
    throw new Error(`${label} must be a file inside the repository`);
  return absolute;
}

async function releaseActiveLock() {
  const release = activeLockRelease;
  activeLockRelease = undefined;
  if (release) await release();
}

function configuredUserId() {
  const value = process.env.ROBLOX_USER_ID || readEnvFileKey(repositoryRoot, "ROBLOX_USER_ID");
  if (!value || !/^[1-9]\d{0,19}$/u.test(value))
    throw new Error("Uploads require numeric ROBLOX_USER_ID in the environment or .env");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error("ROBLOX_USER_ID exceeds safe integer range");
  return parsed;
}

function validatedApiOrigin(value) {
  const url = new URL(value);
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (url.protocol !== "https:" && !(loopback && url.protocol === "http:"))
    throw new Error("Roblox API origin must use HTTPS unless it is a loopback test server");
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/")
    throw new Error("Roblox API origin must contain only scheme and authority");
  return url.origin;
}

function displayNameFor(item, uploadArtifactHash) {
  const label = item.proposedEntryHandle
    ? item.proposedEntryHandle.replaceAll("_", " ")
    : item.assetHash.slice(0, 16);
  const suffix = uploadArtifactHash.slice(0, 8);
  const maximumLabelLength = 50 - "Basalt  ".length - suffix.length;
  return `Basalt ${label.slice(0, maximumLabelLength).trim()} ${suffix}`;
}

function samePublishedSource(upload, source) {
  return (
    upload.creator.userId === source.creator.userId &&
    upload.sourceContentHash === source.sourceContentHash &&
    upload.sourceArtifactHash === source.sourceArtifactHash &&
    upload.sourceBytes === source.sourceBytes &&
    stableJson(upload.uploadArtifact) === stableJson(source.uploadArtifact) &&
    stableJson(upload.adaptation) === stableJson(source.adaptation)
  );
}

async function persistUploadArtifact(store, source) {
  const stored = await store.write(source.bytes, "model/gltf-binary");
  if (stableJson(stored) !== stableJson(source.uploadArtifact))
    throw new Error(`Upload artifact store mismatch: ${source.sourceArtifactHash}`);
}

function withoutUploadHash(upload) {
  const material = { ...upload };
  delete material.uploadHash;
  return material;
}

function countValues(values) {
  const result = {};
  for (const value of values) {
    const key = value ?? "not_started";
    result[key] = (result[key] ?? 0) + 1;
  }
  return result;
}

function verifySealedJson(value, label, hashField) {
  const material = { ...value };
  delete material[hashField];
  if (contentHash(stableJson(material)) !== value[hashField])
    throw new Error(`${label} hash mismatch`);
}

async function readWorkspaceJson(path) {
  const bytes = await readBoundedWorkspaceBytes(repositoryRoot, path, 128 * 1024 * 1024);
  try {
    return JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw new Error(`Workspace JSON is invalid: ${path}`);
  }
}

function parseOptions(args) {
  const flags = new Set();
  const values = new Map();
  const flagNames = new Set(["--dry-run", "--retry-failed"]);
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (key === "--") continue;
    if (flagNames.has(key)) {
      flags.add(key);
      continue;
    }
    if (!key?.startsWith("--")) throw new Error(`Unexpected argument: ${key}`);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${key}`);
    values.set(key, value);
    index += 1;
  }
  const allowed = new Set([
    "--packet",
    "--ledger",
    "--lock",
    "--artifact-store",
    "--scope",
    "--api-origin",
    "--max-uploads",
    "--poll-interval-ms",
    "--poll-timeout-ms",
  ]);
  for (const key of values.keys()) if (!allowed.has(key)) throw new Error(`Unknown option: ${key}`);
  return { flags, values };
}

function positiveInteger(value, label) {
  if (!/^[1-9]\d*$/u.test(value)) throw new Error(`${label} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${label} exceeds safe integer range`);
  return parsed;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function redact(value, secret) {
  return secret ? value.replaceAll(secret, "[redacted]") : value;
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

class DefinitiveOperationError extends Error {
  constructor(code, message) {
    super(message);
    this.code = typeof code === "number" && Number.isInteger(code) ? code : null;
  }
}

await main().catch(async (error) => {
  await releaseActiveLock().catch(() => {});
  process.stderr.write(`Catalog asset upload failed: ${errorMessage(error)}\n`);
  process.exitCode = 1;
});
