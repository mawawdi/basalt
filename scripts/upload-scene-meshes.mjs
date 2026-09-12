#!/usr/bin/env node
// Uploads scene-export mesh payloads through the Open Cloud Assets API and
// writes the adapter-owned sidecar binding content hashes to asset IDs.
// Creator-run: the API key comes from the environment and is never stored.
// --dry-run reports budget verdicts without touching the network.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertRuntimeBuildCurrent } from "./runtime-build-manifest.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function option(args, name) {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${name}`);
  return value;
}

function usage() {
  return "Usage: npm run scene:upload -- --export-dir <dir> --sidecar-out <sidecar.json> [--dry-run] [--creator-user-id <id> | --creator-group-id <id>] [--api-key-env <NAME>] [--api-base <url>] [--max-uploads <n>] [--include-incomplete] [--poll-interval-ms <ms>] [--poll-timeout-ms <ms>]";
}

async function main() {
  await assertRuntimeBuildCurrent(repositoryRoot);
  const args = process.argv.slice(2);
  const exportDir = option(args, "--export-dir");
  const sidecarOut = option(args, "--sidecar-out");
  if (!exportDir || !sidecarOut) throw new Error(usage());
  const dryRun = args.includes("--dry-run");
  const includeIncomplete = args.includes("--include-incomplete");
  const userId = option(args, "--creator-user-id");
  const groupId = option(args, "--creator-group-id");
  if (!dryRun && (userId ? groupId : !groupId))
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
  const { stableJson } = await import(
    pathToFileURL(resolve(repositoryRoot, "dist/packages/contracts/src/index.js")).href
  );

  const manifest = JSON.parse(await readFile(resolve(exportDir, "scene-manifest.json"), "utf8"));
  assertSceneExport(manifest);
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

  const apiKey = process.env[option(args, "--api-key-env") ?? "BASALT_ROBLOX_API_KEY"];
  if (!apiKey) throw new Error("Uploads require the API key environment variable to be set");
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
  const uploadable = verdicts.filter(
    (v) =>
      v.verdict.status === "eligible" || (includeIncomplete && v.verdict.status === "incomplete"),
  );
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
    } catch (error) {
      failures.push({
        contentHash: item.contentHash,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const output = {
    kind: "BasaltEngineSidecar",
    abi: "basalt-engine-sidecar@1",
    engine: "roblox",
    exportHash: manifest.hash,
    bindings: [...bindings.values()].sort((a, b) => (a.contentHash < b.contentHash ? -1 : 1)),
  };
  await writeFile(resolve(sidecarOut), `${stableJson(output)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  process.stdout.write(
    `${stableJson({ sidecar: resolve(sidecarOut), exportHash: manifest.hash, eligible: eligible.length, incomplete: incomplete.length, rejected: rejected.length, uploaded: queue.length - failures.length, skippedBound: alreadyBound, rebound, failures })}\n`,
  );
  if (failures.length > 0) process.exitCode = 1;
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

await main().catch((error) => {
  process.stderr.write(
    `Scene mesh upload failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
