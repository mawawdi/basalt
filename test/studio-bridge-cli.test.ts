import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { contentHash, stableJson } from "../packages/contracts/src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(here, "..", "..");
const exportDir = resolve(here, "fixtures/scene-conformance");
const cliEntry = resolve(repositoryRoot, "dist/packages/cli/src/index.js");

function emissionManifest() {
  const chunkMaterial = {
    kind: "BasaltWorldChunkDelta" as const,
    chunkId: "chunk_cli",
    worldPlanHash: contentHash("world"),
    populationHash: contentHash("population"),
    surfaceIds: [],
    instanceIds: [],
    roadSegmentIds: [],
    bounds: {
      minimum: { x: 0, y: 0, z: 0 },
      maximum: { x: 4, y: 4, z: 4 },
    },
  };
  const chunkHash = contentHash(stableJson(chunkMaterial));
  const chunk = {
    ...chunkMaterial,
    id: `basalt_chunk_${chunkHash.slice(0, 24)}`,
    transactionId: `basalt_tx_${chunkHash.slice(0, 32)}`,
    hash: chunkHash,
  };
  const manifestMaterial = {
    kind: "BasaltWorldEmissionManifest" as const,
    abi: "basalt-world-emission@1" as const,
    worldPlanHash: contentHash("world"),
    populationHash: contentHash("population"),
    chunks: [chunk],
  };
  return { ...manifestMaterial, hash: contentHash(stableJson(manifestMaterial)) };
}

async function waitForHealth(port: number): Promise<void> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch {
      if (Date.now() > deadline) throw new Error("Bridge CLI did not become healthy");
      await new Promise((resolveSleep) => setTimeout(resolveSleep, 100));
    }
  }
}

test("Studio bridge CLI serves an export dir with sidecar and material map", async () => {
  const manifest = JSON.parse(readFileSync(join(exportDir, "scene-manifest.json"), "utf8")) as {
    hash: string;
    payloads: Array<{ contentHash: string; mediaType: string; byteLength: number }>;
  };
  const meshEntry = manifest.payloads.find((entry) => entry.mediaType === "model/gltf-binary")!;
  const scratch = mkdtempSync(join(tmpdir(), "basalt-bridge-cli-"));
  const emissionPath = join(scratch, "emission.json");
  const sidecarPath = join(scratch, "sidecar.json");
  const materialMapPath = join(scratch, "material-map.json");
  const discoveryPath = join(scratch, "discovery.json");
  writeFileSync(emissionPath, `${stableJson(emissionManifest())}\n`);
  writeFileSync(
    sidecarPath,
    `${stableJson({
      kind: "BasaltEngineSidecar",
      abi: "basalt-engine-sidecar@1",
      engine: "roblox",
      exportHash: manifest.hash,
      bindings: [
        {
          contentHash: meshEntry.contentHash,
          assetId: "12345",
          uploadedAt: "2026-09-12T00:00:00.000Z",
          budgets: { triangles: 1, bytes: meshEntry.byteLength, watertight: false },
        },
      ],
    })}\n`,
  );
  writeFileSync(
    materialMapPath,
    `${stableJson({
      kind: "BasaltMaterialMap",
      abi: "basalt-material-map@1",
      engine: "roblox",
      exportHash: manifest.hash,
      bindings: [{ materialId: "exportMaterial", robloxMaterial: "Grass" }],
    })}\n`,
  );
  const port = 18_787;
  const child: ChildProcess = spawn(
    process.execPath,
    [
      cliEntry,
      "studio",
      "bridge",
      "--manifest",
      emissionPath,
      "--revision",
      "0".repeat(64),
      "--export-dir",
      exportDir,
      "--sidecar",
      sidecarPath,
      "--material-map",
      materialMapPath,
      "--port",
      String(port),
      "--discovery",
      discoveryPath,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  try {
    await waitForHealth(port);
    const base = `http://127.0.0.1:${port}`;
    const status = (await (await fetch(`${base}/health`)).json()) as { exportHash: string };
    assert.equal(status.exportHash, manifest.hash);
    const exported = (await (await fetch(`${base}/export`)).json()) as { hash: string };
    assert.equal(exported.hash, manifest.hash);
    const sidecar = (await (await fetch(`${base}/sidecar`)).json()) as {
      bindings: Array<{ assetId: string }>;
    };
    assert.equal(sidecar.bindings[0]!.assetId, "12345");
    const materialMap = (await (await fetch(`${base}/material-map`)).json()) as {
      bindings: Array<{ robloxMaterial: string }>;
    };
    assert.equal(materialMap.bindings[0]!.robloxMaterial, "Grass");
    const expected = new Uint8Array(
      readFileSync(join(exportDir, "payloads", `${meshEntry.contentHash}.glb`)),
    );
    const fetched = new Uint8Array(
      await (await fetch(`${base}/payload/${meshEntry.contentHash}`)).arrayBuffer(),
    );
    assert.deepEqual(fetched, expected);
  } finally {
    child.kill("SIGTERM");
    await new Promise<void>((resolveExit) => {
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        resolveExit();
      }, 5000);
      child.once("exit", () => {
        clearTimeout(timeout);
        resolveExit();
      });
    });
  }
});

test("Studio bridge CLI rejects adapter docs without an export dir", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "basalt-bridge-cli-"));
  const emissionPath = join(scratch, "emission.json");
  writeFileSync(emissionPath, `${stableJson(emissionManifest())}\n`);
  const child = spawn(
    process.execPath,
    [
      cliEntry,
      "studio",
      "bridge",
      "--manifest",
      emissionPath,
      "--revision",
      "0".repeat(64),
      "--sidecar",
      join(scratch, "missing.json"),
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const code = await new Promise<number | null>((resolveExit) =>
    child.once("exit", (exitCode) => resolveExit(exitCode)),
  );
  assert.equal(code, 2);
  assert.match(stderr, /require --export-dir/);
});
