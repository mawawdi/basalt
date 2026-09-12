import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { contentHash, stableJson } from "../packages/contracts/src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(here, "..", "..");
const fixtureDir = resolve(here, "fixtures/scene-conformance");
const uploadScript = resolve(repositoryRoot, "scripts/upload-scene-meshes.mjs");

interface Stub {
  server: Server;
  port: number;
  bodies: Buffer[];
  /** Operation indexes at/after this answer done:false until released. */
  holdAfter: number;
}

const stub: Stub = {
  server: createServer((request, response) => {
    const url = request.url ?? "";
    if (request.method === "POST" && url.endsWith("/assets")) {
      assert.equal(request.headers["x-api-key"], "test-key");
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        const index = stub.bodies.length;
        stub.bodies.push(Buffer.concat(chunks));
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ path: `operations/op${index}` }));
      });
      return;
    }
    const poll = url.match(/\/operations\/op(\d+)$/);
    if (request.method === "GET" && poll) {
      const done = Number(poll[1]) < stub.holdAfter;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        done
          ? JSON.stringify({ done, response: { assetId: String(1000 + Number(poll[1])) } })
          : JSON.stringify({ done }),
      );
      return;
    }
    response.writeHead(404);
    response.end();
  }),
  port: 0,
  bodies: [],
  holdAfter: Number.MAX_SAFE_INTEGER,
};

before(
  () =>
    new Promise<void>((ready) => {
      stub.server.listen(0, "127.0.0.1", () => {
        stub.port = (stub.server.address() as { port: number }).port;
        ready();
      });
    }),
);
after(() => new Promise<void>((done) => stub.server.close(() => done())));

function runUpload(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [uploadScript, "--", ...args], {
      cwd: repositoryRoot,
      env: { ...process.env, BASALT_ROBLOX_API_KEY: "test-key" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("exit", (code) => done({ code: code ?? 1, stdout, stderr }));
  });
}

/**
 * Temp export dir with two distinct glb payloads: the fixture triangle plus a
 * one-bit-mutated copy (still a valid single triangle, new content hash).
 */
function makeExportDir(): { dir: string; sidecar: string; hashes: string[] } {
  const dir = mkdtempSync(join(tmpdir(), "basalt-upload-"));
  const manifest = JSON.parse(readFileSync(join(fixtureDir, "scene-manifest.json"), "utf8"));
  cpSync(join(fixtureDir, "payloads"), join(dir, "payloads"), { recursive: true });
  const original = manifest.parts.find(
    (part: { mediaType: string }) => part.mediaType === "model/gltf-binary",
  );
  const bytes = Buffer.from(readFileSync(join(dir, "payloads", `${original.contentHash}.glb`)));
  const jsonLength = bytes.readUInt32LE(12);
  const binaryStart = 20 + jsonLength + 8;
  bytes[binaryStart] = bytes[binaryStart]! ^ 0x01;
  const mutatedHash = createHash("sha256").update(bytes).digest("hex");
  writeFileSync(join(dir, "payloads", `${mutatedHash}.glb`), bytes);
  manifest.parts.push({ ...original, contentHash: mutatedHash });
  manifest.payloads.push({
    contentHash: mutatedHash,
    byteLength: bytes.byteLength,
    mediaType: "model/gltf-binary",
  });
  manifest.hash = contentHash(stableJson({ ...manifest, hash: undefined }));
  writeFileSync(join(dir, "scene-manifest.json"), JSON.stringify(manifest));
  return { dir, sidecar: join(dir, "sidecar.json"), hashes: [original.contentHash, mutatedHash] };
}

function uploadArgs(target: { dir: string; sidecar: string }): string[] {
  return [
    "--export-dir",
    target.dir,
    "--sidecar-out",
    target.sidecar,
    "--creator-user-id",
    "1048340316",
    "--api-base",
    `http://127.0.0.1:${stub.port}/assets/v1`,
    "--include-incomplete",
    "--poll-interval-ms",
    "1000",
    "--poll-timeout-ms",
    "60000",
  ];
}

function sidecarBindings(sidecar: string): {
  contentHash: string;
  assetId: string;
  importFactor?: number;
}[] {
  return JSON.parse(readFileSync(sidecar, "utf8")).bindings;
}

function postsFor(hash: string): number {
  return stub.bodies.filter((body) => body.includes(hash)).length;
}

test("Scene upload posts each payload once and rebinds on rerun", async () => {
  stub.bodies.length = 0;
  const target = makeExportDir();
  const first = await runUpload(uploadArgs(target));
  assert.equal(first.code, 0);
  assert.equal(sidecarBindings(target.sidecar).length, 2);
  for (const hash of target.hashes) assert.equal(postsFor(hash), 1);
  assert.ok(!existsSync(`${target.sidecar}.lock`));

  const second = await runUpload(uploadArgs(target));
  assert.equal(second.code, 0);
  const report = JSON.parse(second.stdout);
  assert.equal(report.uploaded, 0);
  assert.equal(report.skippedBound, 2);
  for (const hash of target.hashes) assert.equal(postsFor(hash), 1);
});

test("Scene upload resumes after a kill without duplicating finished uploads", async () => {
  stub.bodies.length = 0;
  stub.holdAfter = 1;
  const target = makeExportDir();
  let child: ChildProcess | undefined;
  try {
    child = spawn(process.execPath, [uploadScript, "--", ...uploadArgs(target)], {
      cwd: repositoryRoot,
      env: { ...process.env, BASALT_ROBLOX_API_KEY: "test-key" },
    });
    const deadline = Date.now() + 30_000;
    for (;;) {
      try {
        if (sidecarBindings(target.sidecar).length === 1) break;
      } catch {
        /* sidecar not written yet */
      }
      if (Date.now() > deadline) throw new Error("First binding was never persisted");
      await new Promise((sleep) => setTimeout(sleep, 100));
    }
    child.kill("SIGKILL");
    await new Promise((done) => child!.on("exit", () => done(undefined)));
  } finally {
    child?.kill("SIGKILL");
  }
  const finished = sidecarBindings(target.sidecar)[0]!.contentHash;
  const inflight = target.hashes.find((hash) => hash !== finished)!;
  assert.equal(postsFor(finished), 1);
  assert.equal(postsFor(inflight), 1);

  stub.holdAfter = Number.MAX_SAFE_INTEGER;
  const resumed = await runUpload(uploadArgs(target));
  assert.equal(resumed.code, 0);
  assert.equal(sidecarBindings(target.sidecar).length, 2);
  assert.equal(postsFor(finished), 1);
  // Only the in-flight upload is orphaned: its operation never completed, so
  // the resume legitimately recreates it.
  assert.equal(postsFor(inflight), 2);
});

test("Scene upload refuses while a live uploader holds the lock", async () => {
  const target = makeExportDir();
  const lockPath = `${target.sidecar}.lock`;
  writeFileSync(lockPath, String(process.pid));
  try {
    const blocked = await runUpload(uploadArgs(target));
    assert.equal(blocked.code, 1);
    assert.match(blocked.stderr, /holds .*\.lock/);
    assert.ok(!existsSync(target.sidecar));
  } finally {
    unlinkSync(lockPath);
  }
});

test("Scene upload reclaims the lock of a dead holder", async () => {
  stub.bodies.length = 0;
  const target = makeExportDir();
  writeFileSync(`${target.sidecar}.lock`, "99999999");
  const resumed = await runUpload(uploadArgs(target));
  assert.equal(resumed.code, 0);
  assert.equal(sidecarBindings(target.sidecar).length, 2);
  assert.ok(!existsSync(`${target.sidecar}.lock`));
});

function sealedReadback(
  exportHash: string,
  factors: Array<{ contentHash: string; factor: number }>,
): string {
  const material = {
    kind: "BasaltWorldReadback",
    abi: "basalt-world-readback@1",
    transactionHash: contentHash(`tx${exportHash}`),
    chunkId: "chunk_a",
    phase: "applied",
    observedRevisionHash: contentHash("revision"),
    observedInstanceIds: [],
    observedRoadSegmentIds: [],
    observedVoxelSpots: [],
    observedImportFactors: factors,
    spotHashes: [],
    exportHash,
  };
  return `${stableJson({ ...material, hash: contentHash(stableJson(material)) })}\n`;
}

function recordArgs(target: { dir: string; sidecar: string }, readbacks: string): string[] {
  return [
    "--export-dir",
    target.dir,
    "--sidecar-out",
    target.sidecar,
    "--record-import-factors",
    readbacks,
  ];
}

test("Scene upload records Studio import factors and preserves them on rerun", async () => {
  stub.bodies.length = 0;
  const target = makeExportDir();
  const manifest = JSON.parse(readFileSync(join(target.dir, "scene-manifest.json"), "utf8"));
  const first = await runUpload(uploadArgs(target));
  assert.equal(first.code, 0);
  for (const binding of sidecarBindings(target.sidecar))
    assert.equal(binding.importFactor, undefined);

  const readbacks = mkdtempSync(join(tmpdir(), "basalt-readbacks-"));
  writeFileSync(
    join(readbacks, "applied.json"),
    sealedReadback(
      manifest.hash,
      target.hashes.map((hash, index) => ({ contentHash: hash, factor: 1 + index })),
    ),
  );
  const recorded = await runUpload(recordArgs(target, readbacks));
  assert.equal(recorded.code, 0);
  const report = JSON.parse(recorded.stdout);
  assert.equal(report.stamped, 2);
  assert.equal(report.unstamped, 0);
  const bindings = sidecarBindings(target.sidecar);
  assert.equal(bindings.length, 2);
  assert.deepEqual(bindings.map((binding) => binding.importFactor).sort(), [1, 2]);

  const again = await runUpload(recordArgs(target, readbacks));
  assert.equal(again.code, 0);
  assert.equal(JSON.parse(again.stdout).alreadyStamped, 2);

  stub.holdAfter = Number.MAX_SAFE_INTEGER;
  const rebound = await runUpload(uploadArgs(target));
  assert.equal(rebound.code, 0);
  assert.deepEqual(
    sidecarBindings(target.sidecar)
      .map((binding) => binding.importFactor)
      .sort(),
    [1, 2],
  );
});

test("Scene upload refuses conflicting or foreign import factors", async () => {
  stub.bodies.length = 0;
  const target = makeExportDir();
  const manifest = JSON.parse(readFileSync(join(target.dir, "scene-manifest.json"), "utf8"));
  const first = await runUpload(uploadArgs(target));
  assert.equal(first.code, 0);
  const before = readFileSync(target.sidecar, "utf8");

  const conflicted = mkdtempSync(join(tmpdir(), "basalt-readbacks-"));
  writeFileSync(
    join(conflicted, "a.json"),
    sealedReadback(manifest.hash, [{ contentHash: target.hashes[0]!, factor: 1 }]),
  );
  writeFileSync(
    join(conflicted, "b.json"),
    sealedReadback(manifest.hash, [{ contentHash: target.hashes[0]!, factor: 1.5 }]),
  );
  const conflict = await runUpload(recordArgs(target, conflicted));
  assert.equal(conflict.code, 1);
  assert.match(conflict.stderr, /conflicting import factors/);
  assert.equal(readFileSync(target.sidecar, "utf8"), before);

  const foreign = mkdtempSync(join(tmpdir(), "basalt-readbacks-"));
  writeFileSync(
    join(foreign, "applied.json"),
    sealedReadback("0".repeat(64), [{ contentHash: target.hashes[0]!, factor: 1 }]),
  );
  const skipped = await runUpload(recordArgs(target, foreign));
  assert.equal(skipped.code, 0);
  assert.equal(JSON.parse(skipped.stdout).stamped, 0);
  assert.equal(readFileSync(target.sidecar, "utf8"), before);

  const tampered = mkdtempSync(join(tmpdir(), "basalt-readbacks-"));
  const parsed = JSON.parse(
    sealedReadback(manifest.hash, [{ contentHash: target.hashes[0]!, factor: 1 }]),
  );
  parsed.observedImportFactors[0].factor = 7;
  writeFileSync(join(tampered, "applied.json"), JSON.stringify(parsed));
  const broken = await runUpload(recordArgs(target, tampered));
  assert.equal(broken.code, 1);
  assert.match(broken.stderr, /seal mismatch/);
});
