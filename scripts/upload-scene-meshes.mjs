#!/usr/bin/env node
// Uploads scene-export mesh payloads through the Open Cloud Assets API and
// writes the adapter-owned sidecar binding content hashes to asset IDs.
// Creator-run: the API key comes from the environment, falling back to the
// repo-root .env, and is never stored or logged.
// One uploader per sidecar (lockfile); bindings persist per upload so reruns
// rebind finished uploads instead of duplicating them.
// --dry-run reports budget verdicts without touching the network.
// --record-import-factors merges Studio-observed import factors from sealed
// readbacks into the sidecar bindings without touching the network.
import { createHash } from "node:crypto";
import { open, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertRuntimeBuildCurrent } from "./runtime-build-manifest.mjs";
import { readEnvFileKey } from "./read-env-file.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let activeUploadLockRelease;

/** Best-effort release; a missed release self-heals via holder liveness. */
async function releaseActiveUploadLock() {
  const release = activeUploadLockRelease;
  activeUploadLockRelease = undefined;
  if (release) await release();
}

/**
 * Exclusive per-sidecar lock. Refuses when a live process holds it; reclaims
 * the lock when the holder is dead (crashed runs never block the next run).
 */
async function acquireUploadLock(lockPath) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(String(process.pid));
      await handle.close();
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        await unlink(lockPath).catch(() => {});
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const holder = await readFile(lockPath, "utf8").catch(() => "");
      const pid = Number.parseInt(holder.trim(), 10);
      let alive = true;
      if (Number.isSafeInteger(pid)) {
        try {
          process.kill(pid, 0);
        } catch (signal) {
          if (signal?.code === "ESRCH") alive = false;
          else if (signal?.code !== "EPERM") throw signal;
        }
      }
      if (alive) throw new Error(`Another scene-mesh upload holds ${lockPath}`, { cause: error });
      await unlink(lockPath).catch(() => {});
    }
  }
  throw new Error(`Could not acquire the scene-mesh upload lock at ${lockPath}`);
}

function option(args, name) {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${name}`);
  return value;
}

function usage() {
  return "Usage: npm run scene:upload -- --export-dir <dir> --sidecar-out <sidecar.json> [--dry-run] [--record-import-factors <readbacks-dir>] [--creator-user-id <id> | --creator-group-id <id>] [--api-key-env <NAME>] [--api-base <url>] [--max-uploads <n>] [--include-incomplete] [--poll-interval-ms <ms>] [--poll-timeout-ms <ms>]";
}

async function main() {
  await assertRuntimeBuildCurrent(repositoryRoot);
  const args = process.argv.slice(2);
  const exportDir = option(args, "--export-dir");
  const sidecarOut = option(args, "--sidecar-out");
  if (!exportDir || !sidecarOut) throw new Error(usage());
  const dryRun = args.includes("--dry-run");
  const recordDir = option(args, "--record-import-factors");
  if (dryRun && recordDir) throw new Error("--dry-run and --record-import-factors are exclusive");
  const includeIncomplete = args.includes("--include-incomplete");
  const userId = option(args, "--creator-user-id");
  const groupId = option(args, "--creator-group-id");
  if (!dryRun && !recordDir && (userId ? groupId : !groupId))
    throw new Error("Uploads require exactly one of --creator-user-id or --creator-group-id");
  const apiBase = option(args, "--api-base") ?? "https://apis.roblox.com/assets/v1";
  const maxUploads = Number(option(args, "--max-uploads") ?? Number.MAX_SAFE_INTEGER);
  if (!Number.isSafeInteger(maxUploads) || maxUploads < 1)
    throw new Error("--max-uploads must be a positive integer");
  const pollIntervalMs = Number(option(args, "--poll-interval-ms") ?? 5000);
  const pollTimeoutMs = Number(option(args, "--poll-timeout-ms") ?? 300000);
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1000)
    throw new Error("--poll-interval-ms must be an integer of at least 1000");
  if (!Number.isSafeInteger(pollTimeoutMs) || pollTimeoutMs < pollIntervalMs)
    throw new Error("--poll-timeout-ms must be an integer of at least the poll interval");

  const { assertSceneExport, assessMeshPartBudget } = await import(
    pathToFileURL(resolve(repositoryRoot, "dist/packages/world-compiler/src/scene-export.js")).href
  );
  const { inspectGlbTopology } = await import(
    pathToFileURL(resolve(repositoryRoot, "dist/packages/asset-inspection/src/glb.js")).href
  );
  const { contentHash, stableJson } = await import(
    pathToFileURL(resolve(repositoryRoot, "dist/packages/contracts/src/index.js")).href
  );

  const manifest = JSON.parse(await readFile(resolve(exportDir, "scene-manifest.json"), "utf8"));
  assertSceneExport(manifest);
  if (recordDir) {
    activeUploadLockRelease = await acquireUploadLock(`${resolve(sidecarOut)}.lock`);
    try {
      await recordImportFactors({ manifest, sidecarOut, recordDir, contentHash, stableJson });
    } finally {
      await releaseActiveUploadLock();
    }
    return;
  }
  const partByHash = new Map(manifest.parts.map((part) => [part.contentHash, part]));
  const verdicts = [];
  for (const entry of [...manifest.payloads].sort((a, b) =>
    a.contentHash < b.contentHash ? -1 : 1,
  )) {
    if (entry.mediaType !== "model/gltf-binary") continue;
    const bytes = new Uint8Array(
      await readFile(resolve(exportDir, "payloads", `${entry.contentHash}.glb`)),
    );
    if (createHash("sha256").update(bytes).digest("hex") !== entry.contentHash)
      throw new Error(`Payload bytes disagree with manifest: ${entry.contentHash}`);
    const part = partByHash.get(entry.contentHash);
    if (!part) throw new Error(`Manifest part missing for payload: ${entry.contentHash}`);
    const topology = inspectGlbTopology(bytes);
    const verdict = assessMeshPartBudget({
      triangleCount: part.triangleCount,
      byteLength: bytes.byteLength,
      boundaryEdgeCount: topology.boundaryEdgeCount,
      nonManifoldEdgeCount: topology.nonManifoldEdgeCount,
    });
    verdicts.push({ contentHash: entry.contentHash, verdict, topology, bytes });
  }

  const eligible = verdicts.filter((v) => v.verdict.status === "eligible");
  const incomplete = verdicts.filter((v) => v.verdict.status === "incomplete");
  const rejected = verdicts.filter((v) => v.verdict.status === "rejected");
  if (dryRun) {
    process.stdout.write(
      `${stableJson({ exportHash: manifest.hash, eligible: eligible.length, incomplete: incomplete.length, rejected: rejected.length, verdicts: verdicts.map((item) => ({ contentHash: item.contentHash, verdict: item.verdict, topology: item.topology })) })}\n`,
    );
    return;
  }

  const apiKeyName = option(args, "--api-key-env") ?? "BASALT_ROBLOX_API_KEY";
  const apiKey = process.env[apiKeyName] || readEnvFileKey(repositoryRoot, apiKeyName);
  if (!apiKey && !recordDir)
    throw new Error("Uploads require the API key environment variable to be set");
  activeUploadLockRelease = await acquireUploadLock(`${resolve(sidecarOut)}.lock`);
  let sidecar;
  let rebound = 0;
  try {
    sidecar = JSON.parse(await readFile(resolve(sidecarOut), "utf8"));
    if (sidecar?.kind !== "BasaltEngineSidecar" || !Array.isArray(sidecar.bindings))
      throw new Error("Existing sidecar has an unexpected shape");
    if (sidecar.exportHash && sidecar.exportHash !== manifest.hash) {
      // Identical bytes reuse their binding: keep only bindings whose content
      // hash the current export still carries, and rebind them to it.
      const carried = new Set(manifest.payloads.map((entry) => entry.contentHash));
      const kept = sidecar.bindings.filter(
        (binding) => carried.has(binding?.contentHash) && binding?.assetId,
      );
      if (sidecar.bindings.length > 0 && kept.length === 0)
        throw new Error("Existing sidecar binds a different scene export with no shared payloads");
      sidecar = { ...sidecar, bindings: kept };
      rebound = kept.length;
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    sidecar = undefined;
  }
  const bindings = new Map((sidecar?.bindings ?? []).map((b) => [b.contentHash, b]));
  const persistSidecar = () =>
    writeFile(
      resolve(sidecarOut),
      `${stableJson({
        kind: "BasaltEngineSidecar",
        abi: "basalt-engine-sidecar@1",
        engine: "roblox",
        exportHash: manifest.hash,
        bindings: [...bindings.values()].sort((a, b) => (a.contentHash < b.contentHash ? -1 : 1)),
      })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
  const seenHashes = new Set();
  const uploadable = verdicts
    .filter(
      (v) =>
        v.verdict.status === "eligible" || (includeIncomplete && v.verdict.status === "incomplete"),
    )
    .filter((v) => {
      if (seenHashes.has(v.contentHash)) return false;
      seenHashes.add(v.contentHash);
      return true;
    });
  const alreadyBound = uploadable.filter((v) => bindings.has(v.contentHash)).length;
  const queue = uploadable.filter((v) => !bindings.has(v.contentHash)).slice(0, maxUploads);
  const failures = [];
  for (const item of queue) {
    try {
      const assetId = await uploadPart(
        {
          apiBase,
          apiKey,
          creator: userId ? { userId } : { groupId },
          item,
        },
        pollIntervalMs,
        pollTimeoutMs,
      );
      bindings.set(item.contentHash, {
        contentHash: item.contentHash,
        assetId,
        uploadedAt: new Date().toISOString(),
        budgets: {
          triangles: partByHash.get(item.contentHash).triangleCount,
          bytes: item.bytes.byteLength,
          watertight:
            item.topology.boundaryEdgeCount === 0 && item.topology.nonManifoldEdgeCount === 0,
        },
      });
      // Persist per upload: a killed run rebinds finished uploads instead of
      // duplicating them, leaving at most the in-flight upload orphaned.
      await persistSidecar();
    } catch (error) {
      failures.push({
        contentHash: item.contentHash,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  await persistSidecar();
  await releaseActiveUploadLock();
  process.stdout.write(
    `${stableJson({ sidecar: resolve(sidecarOut), exportHash: manifest.hash, eligible: eligible.length, incomplete: incomplete.length, rejected: rejected.length, uploaded: queue.length - failures.length, skippedBound: alreadyBound, rebound, failures })}\n`,
  );
  if (failures.length > 0) process.exitCode = 1;
}

/**
 * Stamp Studio-observed import factors onto the sidecar bindings. Only
 * readbacks sealed for the current export contribute; a part observed with
 * two different factors (or disagreeing with a recorded one) fails closed
 * instead of picking a winner, because that disagreement is import drift.
 */
async function recordImportFactors({ manifest, sidecarOut, recordDir, contentHash, stableJson }) {
  let sidecar;
  try {
    sidecar = JSON.parse(await readFile(resolve(sidecarOut), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT")
      throw new Error("Import factors need an uploaded sidecar first", { cause: error });
    throw error;
  }
  if (sidecar?.kind !== "BasaltEngineSidecar" || !Array.isArray(sidecar.bindings))
    throw new Error("Existing sidecar has an unexpected shape");
  if (sidecar.exportHash !== manifest.hash)
    throw new Error("Sidecar binds a different scene export; upload it first");
  const observed = new Map();
  let readbacks = 0;
  let matched = 0;
  for (const name of (await readdir(resolve(recordDir))).sort()) {
    if (!name.endsWith(".json")) continue;
    const readback = JSON.parse(await readFile(resolve(recordDir, name), "utf8"));
    readbacks += 1;
    if (readback?.kind !== "BasaltWorldReadback" || !Array.isArray(readback.observedImportFactors))
      throw new Error(`Readback file is not a sealed readback: ${name}`);
    const { hash, ...material } = readback;
    if (hash !== contentHash(stableJson(material)))
      throw new Error(`Readback seal mismatch: ${name}`);
    if (readback.exportHash !== manifest.hash) continue;
    matched += 1;
    for (const entry of readback.observedImportFactors) {
      if (
        typeof entry?.contentHash !== "string" ||
        typeof entry?.factor !== "number" ||
        !Number.isFinite(entry.factor) ||
        entry.factor <= 0
      )
        throw new Error(`Readback carries an invalid import factor: ${name}`);
      if (observed.has(entry.contentHash) && observed.get(entry.contentHash) !== entry.factor)
        throw new Error(`Part ${entry.contentHash} was observed with conflicting import factors`);
      observed.set(entry.contentHash, entry.factor);
    }
  }
  let stamped = 0;
  let alreadyStamped = 0;
  const bindings = sidecar.bindings.map((binding) => {
    const factor = observed.get(binding?.contentHash);
    if (factor === undefined) return binding;
    if (binding.importFactor !== undefined) {
      if (binding.importFactor !== factor)
        throw new Error(`Part ${binding.contentHash} drifts past its recorded import factor`);
      alreadyStamped += 1;
      return binding;
    }
    stamped += 1;
    return { ...binding, importFactor: factor };
  });
  await writeFile(
    resolve(sidecarOut),
    `${stableJson({
      kind: "BasaltEngineSidecar",
      abi: "basalt-engine-sidecar@1",
      engine: "roblox",
      exportHash: manifest.hash,
      bindings: [...bindings].sort((a, b) => (a.contentHash < b.contentHash ? -1 : 1)),
    })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  process.stdout.write(
    `${stableJson({ sidecar: resolve(sidecarOut), exportHash: manifest.hash, readbacks, matchedReadbacks: matched, stamped, alreadyStamped, unstamped: bindings.length - stamped - alreadyStamped })}\n`,
  );
}

async function uploadPart({ apiBase, apiKey, creator, item }, pollIntervalMs, pollTimeoutMs) {
  const form = new FormData();
  form.set(
    "request",
    JSON.stringify({
      assetType: "Model",
      displayName: `basalt_${item.contentHash.slice(0, 12)}`,
      description: `Basalt scene mesh part ${item.contentHash}`,
      creationContext: { creator },
    }),
  );
  form.set(
    "fileContent",
    new Blob([item.bytes], { type: "model/gltf-binary" }),
    `${item.contentHash}.glb`,
  );
  const created = await fetch(`${apiBase}/assets`, {
    method: "POST",
    headers: { "x-api-key": apiKey },
    body: form,
  });
  if (!created.ok)
    throw new Error(
      `Asset create failed with status ${created.status}: ${(await created.text()).slice(0, 300)}`,
    );
  const operation = await created.json();
  const operationId = String(operation?.path ?? "").replace(/^operations\//, "");
  if (!operationId) throw new Error("Asset create returned no operation");
  const deadline = Date.now() + pollTimeoutMs;
  for (;;) {
    const polled = await fetch(`${apiBase}/operations/${operationId}`, {
      headers: { "x-api-key": apiKey },
    });
    if (!polled.ok) throw new Error(`Operation poll failed with status ${polled.status}`);
    const status = await polled.json();
    if (status?.done === true) {
      const assetId = status?.response?.assetId;
      if (typeof assetId !== "string" || !/^\d+$/.test(assetId))
        throw new Error(
          `Operation finished without an asset id: ${JSON.stringify(status).slice(0, 300)}`,
        );
      return assetId;
    }
    if (
      status?.error ||
      status?.response?.moderationResult?.moderationState === "MODERATION_STATE_REJECTED"
    )
      throw new Error(`Asset rejected: ${JSON.stringify(status).slice(0, 300)}`);
    if (Date.now() >= deadline) throw new Error(`Operation timed out: ${operationId}`);
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

await main().catch(async (error) => {
  await releaseActiveUploadLock().catch(() => {});
  process.stderr.write(
    `Scene mesh upload failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
