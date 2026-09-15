import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { relative, resolve } from "node:path";
import test from "node:test";
import { contentHash, stableJson } from "@basalt/contracts";
import { ROBLOX_ASSET_UPLOAD_LEDGER_SCHEMA } from "@basalt/roblox";

const repositoryRoot = resolve(".");
const uploadScript = resolve(repositoryRoot, "scripts/upload-catalog-assets.mjs");
const creatorUserId = 1_048_340_316;
const apiKey = "catalog-upload-test-secret";

test("catalog uploader publishes adapted packet sources once and reuses sealed receipts", async () => {
  const fixture = await uploadFixture(2);
  const stub = await startStub();
  try {
    const first = await runUpload(fixture, stub);
    assert.equal(first.code, 0, first.stderr);
    const firstReport = JSON.parse(first.stdout) as {
      status: string;
      submitted: number;
      adaptedSources: number;
      strippedPrimitiveAttributes: number;
      states: Record<string, number>;
    };
    assert.equal(firstReport.status, "eligible");
    assert.equal(firstReport.submitted, 2);
    assert.equal(firstReport.adaptedSources, 1);
    assert.equal(firstReport.strippedPrimitiveAttributes, 1);
    assert.equal(firstReport.states.eligible, 2);
    assert.equal(stub.posts, 2);

    const ledger = ROBLOX_ASSET_UPLOAD_LEDGER_SCHEMA.parse(
      JSON.parse(await readFile(fixture.ledger, "utf8")),
    );
    assert.equal(ledger.creator.userId, creatorUserId);
    assert.equal(ledger.uploads.length, 2);
    assert.ok(ledger.uploads.every((entry) => entry.status === "eligible"));
    assert.equal(
      ledger.uploads.filter((entry) => entry.adaptation.strippedPrimitiveAttributeCount === 1)
        .length,
      1,
    );
    for (const [index, entry] of ledger.uploads.entries()) {
      const source = await readFile(resolve(repositoryRoot, entry.sourceRelativePath));
      const stored = await readFile(resolve(fixture.artifactStore, entry.uploadArtifact.locator));
      assert.equal(
        createHash("sha256").update(stored).digest("hex"),
        entry.uploadArtifact.artifactHash,
      );
      assert.equal(stored.byteLength, entry.uploadArtifact.bytes);
      assert.equal(glbAttributes(stored).includes("COLOR_0"), true);
      assert.equal(glbAttributes(stored).includes("COLOR_1"), false);
      assert.equal(
        entry.uploadArtifact.artifactHash === entry.sourceArtifactHash,
        entry.adaptation.strippedPrimitiveAttributeCount === 0,
      );
      if (entry.adaptation.strippedPrimitiveAttributeCount === 0) assert.deepEqual(stored, source);
      assert.equal(
        createHash("sha256").update(stub.uploadedPayloads[index]!).digest("hex"),
        entry.uploadArtifact.artifactHash,
      );
    }
    assert.ok(!stableJson(ledger).includes(apiKey));
    assert.ok(!first.stdout.includes(apiKey));
    assert.ok(!first.stderr.includes(apiKey));

    const second = await runUpload(fixture, stub);
    assert.equal(second.code, 0, second.stderr);
    const secondReport = JSON.parse(second.stdout) as { submitted: number; reused: number };
    assert.equal(secondReport.submitted, 0);
    assert.equal(secondReport.reused, 2);
    assert.equal(stub.posts, 2);
  } finally {
    await stub.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("catalog uploader resumes a persisted Open Cloud operation without another upload", async () => {
  const fixture = await uploadFixture(1);
  const stub = await startStub({ operationsReady: false });
  try {
    const first = await runUpload(fixture, stub, [
      "--poll-interval-ms",
      "10",
      "--poll-timeout-ms",
      "20",
    ]);
    assert.equal(first.code, 0, first.stderr);
    assert.equal((JSON.parse(first.stdout) as { status: string }).status, "incomplete");
    assert.equal(stub.posts, 1);
    let ledger = ROBLOX_ASSET_UPLOAD_LEDGER_SCHEMA.parse(
      JSON.parse(await readFile(fixture.ledger, "utf8")),
    );
    assert.equal(ledger.uploads[0]?.status, "pending_operation");

    stub.operationsReady = true;
    const resumed = await runUpload(fixture, stub);
    assert.equal(resumed.code, 0, resumed.stderr);
    assert.equal((JSON.parse(resumed.stdout) as { resumed: number }).resumed, 1);
    assert.equal(stub.posts, 1);
    ledger = ROBLOX_ASSET_UPLOAD_LEDGER_SCHEMA.parse(
      JSON.parse(await readFile(fixture.ledger, "utf8")),
    );
    assert.equal(ledger.uploads[0]?.status, "eligible");
  } finally {
    await stub.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("catalog uploader rejects changed source bytes before network access", async () => {
  const fixture = await uploadFixture(1);
  try {
    await writeFile(fixture.sources[0]!, glbBytes({ name: "changed", secondaryColor: false }));
    const result = await runUpload(fixture, undefined, ["--dry-run"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /source hash mismatch/iu);
    assert.ok(!result.stderr.includes(apiKey));
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

async function uploadFixture(count: number) {
  await mkdir(resolve(repositoryRoot, ".basalt"), { recursive: true });
  const directory = await mkdtemp(resolve(repositoryRoot, ".basalt/catalog-upload-test-"));
  const admittedAssets = [];
  const sources: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const bytes = glbBytes({ name: `source-${index}`, secondaryColor: index === 0 });
    const sourceHash = createHash("sha256").update(bytes).digest("hex");
    const source = resolve(directory, `${sourceHash}.glb`);
    await writeFile(source, bytes);
    sources.push(source);
    admittedAssets.push({
      assetHash: contentHash(`asset:${sourceHash}`),
      proposedEntryHandle: `test_source_${index}`,
      sourceArtifactHash: sourceHash,
      sourceContentHash: sourceHash,
      sourceRelativePath: relative(repositoryRoot, source),
    });
  }
  const body = {
    kind: "CatalogFirstUseRobloxUploadPacket",
    status: "incomplete",
    catalogCommitHash: "a".repeat(64),
    worldBuildHash: "b".repeat(64),
    bindingInventory: { relativePath: ".basalt/roblox/asset-bindings.json", status: "absent" },
    missingBindings: [],
    admittedAssets,
    instructions: [],
  };
  const packet = resolve(directory, "packet.json");
  const ledger = resolve(directory, "ledger.json");
  const lock = resolve(directory, "ledger.lock");
  const artifactStore = resolve(directory, "upload-artifacts");
  await writeFile(packet, `${JSON.stringify({ ...body, hash: contentHash(stableJson(body)) })}\n`);
  return { directory, packet, ledger, lock, artifactStore, sources };
}

function glbBytes(options: { name: string; secondaryColor: boolean }): Buffer {
  const binary = Buffer.alloc(options.secondaryColor ? 60 : 48);
  const positions = [0, 0, 0, 1, 0, 0, 0, 1, 0];
  positions.forEach((value, index) => binary.writeFloatLE(value, index * 4));
  binary.fill(255, 36, 48);
  if (options.secondaryColor) {
    binary.fill(0, 48, 60);
    binary[48] = 255;
    binary[52] = 255;
    binary[56] = 255;
  }
  const bufferViews = [
    { buffer: 0, byteOffset: 0, byteLength: 36 },
    { buffer: 0, byteOffset: 36, byteLength: 12 },
    ...(options.secondaryColor ? [{ buffer: 0, byteOffset: 48, byteLength: 12 }] : []),
  ];
  const accessors = [
    {
      bufferView: 0,
      componentType: 5126,
      count: 3,
      type: "VEC3",
      min: [0, 0, 0],
      max: [1, 1, 0],
    },
    { bufferView: 1, componentType: 5121, normalized: true, count: 3, type: "VEC4" },
    ...(options.secondaryColor
      ? [{ bufferView: 2, componentType: 5121, normalized: true, count: 3, type: "VEC4" }]
      : []),
  ];
  const document = {
    asset: { version: "2.0", generator: "Basalt upload test" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: options.name, mesh: 0 }],
    meshes: [
      {
        primitives: [
          {
            attributes: {
              POSITION: 0,
              COLOR_0: 1,
              ...(options.secondaryColor ? { COLOR_1: 2 } : {}),
            },
            mode: 4,
          },
        ],
      },
    ],
    buffers: [{ byteLength: binary.byteLength }],
    bufferViews,
    accessors,
  };
  const json = Buffer.from(JSON.stringify(document));
  const jsonLength = (json.byteLength + 3) & ~3;
  const bytes = Buffer.alloc(12 + 8 + jsonLength + 8 + binary.byteLength, 0x20);
  bytes.writeUInt32LE(0x46546c67, 0);
  bytes.writeUInt32LE(2, 4);
  bytes.writeUInt32LE(bytes.byteLength, 8);
  bytes.writeUInt32LE(jsonLength, 12);
  bytes.writeUInt32LE(0x4e4f534a, 16);
  json.copy(bytes, 20);
  const binaryHeader = 20 + jsonLength;
  bytes.writeUInt32LE(binary.byteLength, binaryHeader);
  bytes.writeUInt32LE(0x004e4942, binaryHeader + 4);
  binary.copy(bytes, binaryHeader + 8);
  return bytes;
}

function glbAttributes(bytes: Buffer): string[] {
  const jsonLength = bytes.readUInt32LE(12);
  const document = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString("utf8")) as {
    meshes: Array<{ primitives: Array<{ attributes: Record<string, number> }> }>;
  };
  return Object.keys(document.meshes[0]!.primitives[0]!.attributes);
}

interface Stub {
  readonly origin: string;
  readonly server: Server;
  posts: number;
  operationsReady: boolean;
  uploadedPayloads: Buffer[];
  close(): Promise<void>;
}

async function startStub(options: { operationsReady?: boolean } = {}): Promise<Stub> {
  const stub = {
    posts: 0,
    operationsReady: options.operationsReady ?? true,
    uploadedPayloads: [] as Buffer[],
  };
  const server = createServer((request, response) => {
    const url = request.url ?? "";
    if (request.method === "POST" && url === "/api-keys/v1/introspect") {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        assert.equal(JSON.parse(Buffer.concat(chunks).toString("utf8")).apiKey, apiKey);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            enabled: true,
            expired: false,
            authorizedUserId: creatorUserId,
            scopes: [
              { name: "asset", operations: ["read", "write"], userIds: ["*"], groupIds: [] },
            ],
          }),
        );
      });
      return;
    }
    if (request.method === "POST" && url === "/assets/v1/assets") {
      assert.equal(request.headers["x-api-key"], apiKey);
      const operation = stub.posts;
      stub.posts += 1;
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        const body = Buffer.concat(chunks);
        const glbStart = body.indexOf(Buffer.from([0x67, 0x6c, 0x54, 0x46]));
        assert.ok(glbStart >= 0);
        const glbLength = body.readUInt32LE(glbStart + 8);
        stub.uploadedPayloads.push(body.subarray(glbStart, glbStart + glbLength));
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ path: `operations/op${operation}` }));
      });
      return;
    }
    const operation = /^\/assets\/v1\/operations\/op(\d+)$/u.exec(url);
    if (request.method === "GET" && operation) {
      assert.equal(request.headers["x-api-key"], apiKey);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        stub.operationsReady
          ? JSON.stringify({
              done: true,
              response: {
                assetId: String(10_000 + Number(operation[1])),
                revisionId: "1",
                moderationResult: { moderationState: "MODERATION_STATE_APPROVED" },
              },
            })
          : JSON.stringify({ done: false }),
      );
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ message: "not found" }));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Upload stub did not bind TCP");
  return Object.assign(stub, {
    origin: `http://127.0.0.1:${address.port}`,
    server,
    close: () => new Promise<void>((done) => server.close(() => done())),
  });
}

function runUpload(
  fixture: Awaited<ReturnType<typeof uploadFixture>>,
  stub?: Stub,
  extra: readonly string[] = [],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const args = [
    uploadScript,
    "--packet",
    fixture.packet,
    "--ledger",
    fixture.ledger,
    "--lock",
    fixture.lock,
    "--artifact-store",
    fixture.artifactStore,
    "--scope",
    "all",
    ...(stub ? ["--api-origin", stub.origin] : []),
    ...extra,
  ];
  return new Promise((done) => {
    const child = spawn(process.execPath, args, {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        BASALT_ROBLOX_API_KEY: apiKey,
        ROBLOX_USER_ID: String(creatorUserId),
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.on("exit", (code) => done({ code: code ?? 1, stdout, stderr }));
  });
}
