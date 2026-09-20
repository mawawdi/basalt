// Creator-operated Studio observation, using the existing authenticated local bridge.
import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import {
  acquireWorkspaceExclusiveLock,
  readBoundedWorkspaceBytes,
  writeCanonicalWorkspaceJson,
} from "@basalt/artifact-store";
import { HASH_SCHEMA, contentHash, stableJson } from "@basalt/contracts";
import {
  ROBLOX_ASSET_UPLOAD_LEDGER_SCHEMA,
  ROBLOX_IMPORT_LOCK_PATH,
  ROBLOX_MATERIAL_EXPECTATION_SCHEMA,
  ROBLOX_PORT_RANGE,
  readRobloxCredential,
} from "@basalt/roblox";
import { verifyRobloxUploadEvidence } from "./verify-roblox-upload-evidence.mjs";
import { verifyRobloxBindingCoverage } from "./verify-roblox-binding-coverage.mjs";

const options = new Map();
for (let i = 2; i < process.argv.length; i += 2) options.set(process.argv[i], process.argv[i + 1]);
const packetPath = options.get("--packet");
if (!packetPath) throw new Error("Provide --packet <roblox-binding-upload-packet.json>");
const root = resolve(".");
const output = options.get("--output") ?? `${dirname(packetPath)}/roblox-binding-decision.json`;
const readJson = async (path) =>
  JSON.parse((await readBoundedWorkspaceBytes(root, path, 64 * 1024 * 1024)).toString("utf8"));
const itemSchema = z
  .object({
    assetHash: HASH_SCHEMA,
    sourceArtifactHash: HASH_SCHEMA,
    uploadArtifactHash: HASH_SCHEMA,
    publicationEvidenceHash: HASH_SCHEMA,
    robloxAssetId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .passthrough();
const packet = z
  .object({
    kind: z.literal("CatalogFirstUseRobloxUploadPacket"),
    hash: HASH_SCHEMA,
    worldBuildHash: HASH_SCHEMA,
    missingBindings: z.array(itemSchema).min(1),
  })
  .passthrough()
  .parse(await readJson(packetPath));
const { hash: packetHash, ...packetBody } = packet;
if (contentHash(stableJson(packetBody)) !== packetHash)
  throw new Error("Upload packet hash mismatch");
const uploads = ROBLOX_ASSET_UPLOAD_LEDGER_SCHEMA.parse(
  await readJson(".basalt/roblox/asset-uploads.json"),
);
await verifyRobloxUploadEvidence(root, uploads);
const expected = new Map(packet.missingBindings.map((item) => [item.assetHash, item]));
if (expected.size !== packet.missingBindings.length)
  throw new Error("Capture packet repeats assets");
const eligibleUploads = new Map(
  uploads.uploads
    .filter((item) => item.status === "eligible")
    .map((item) => [item.sourceArtifactHash, item]),
);
for (const item of expected.values()) {
  const upload = eligibleUploads.get(item.sourceArtifactHash);
  if (
    !upload ||
    upload.uploadHash !== item.publicationEvidenceHash ||
    upload.robloxAssetId !== item.robloxAssetId ||
    upload.uploadArtifact.artifactHash !== item.uploadArtifactHash
  )
    throw new Error(`Capture lacks exact publication evidence: ${item.assetHash}`);
}
const decisionSchema = z
  .object({
    kind: z.literal("CatalogFirstUseRobloxBindingDecision"),
    uploadPacketHash: HASH_SCHEMA,
    recordedBy: z
      .object({ authority: z.literal("creator"), reviewerId: z.string().regex(/^[1-9][0-9]*$/u) })
      .strict(),
    reviewerStatement: z.string().min(32).max(2048),
    recordedAt: z.string().datetime({ offset: true }),
    bindings: z
      .array(
        z
          .object({
            assetHash: HASH_SCHEMA,
            sourceArtifactHash: HASH_SCHEMA,
            uploadArtifactHash: HASH_SCHEMA,
            publicationEvidenceHash: HASH_SCHEMA,
            robloxAssetId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
            materialExpectations: z.array(ROBLOX_MATERIAL_EXPECTATION_SCHEMA).min(1),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
let expectedExistingHash;
try {
  expectedExistingHash = contentHash(
    await readBoundedWorkspaceBytes(root, output, 16 * 1024 * 1024),
  );
} catch (error) {
  if (!error.message.includes("missing")) throw error;
}
const credential = await readRobloxCredential(root);
const lock = await acquireWorkspaceExclusiveLock(root, ROBLOX_IMPORT_LOCK_PATH);
let state = "pending";
let accepting = false;
const session = () => ({
  kind: "RobloxAssetBindingCapture",
  state,
  worldBuildHash: packet.worldBuildHash,
  sessionHash: packetHash,
  loweringGapCount: 0,
  stage: "asset_binding_capture",
  progress: { complete: state === "complete" ? expected.size : 0, total: expected.size },
});
const send = (response, code, value) => {
  response.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  response.end(JSON.stringify(value));
};
const server = createServer((request, response) => {
  void handle(request, response);
});
async function handle(request, response) {
  try {
    if (request.method === "GET" && request.url === "/health") {
      send(response, 200, { kind: "BasaltBridgeHealth" });
      return;
    }
    const provided = Buffer.from(request.headers.authorization ?? "");
    const wanted = Buffer.from(`Bearer ${credential.token}`);
    if (
      request.headers.origin ||
      provided.length !== wanted.length ||
      !timingSafeEqual(provided, wanted)
    ) {
      send(response, 401, { error: "Unauthorized" });
      return;
    }
    if (request.method === "GET" && request.url === "/session") {
      send(response, 200, session());
      return;
    }
    if (request.method === "GET" && request.url === "/binding-packet") {
      send(response, 200, packet);
      return;
    }
    if (request.method !== "POST" || request.url !== "/binding-capture") {
      send(response, 404, { error: "Unknown capture operation" });
      return;
    }
    if (accepting || state === "complete") {
      send(response, 409, { error: "Capture already recorded or in progress" });
      return;
    }
    accepting = true;
    try {
      const chunks = [];
      let length = 0;
      for await (const chunk of request) {
        length += chunk.length;
        if (length > 16 * 1024 * 1024) throw new Error("Capture exceeds 16 MiB");
        chunks.push(chunk);
      }
      const decision = decisionSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      if (decision.uploadPacketHash !== packetHash) throw new Error("Capture binds another packet");
      if (decision.recordedBy.reviewerId !== String(uploads.creator.userId))
        throw new Error("Studio user differs from the publishing creator");
      if (
        decision.bindings.length !== expected.size ||
        new Set(decision.bindings.map((item) => item.assetHash)).size !== expected.size
      )
        throw new Error("Capture must cover each requested asset exactly once");
      for (const binding of decision.bindings) {
        const item = expected.get(binding.assetHash);
        if (
          !item ||
          [
            "robloxAssetId",
            "sourceArtifactHash",
            "uploadArtifactHash",
            "publicationEvidenceHash",
          ].some((key) => binding[key] !== item[key])
        )
          throw new Error("Capture publication identity mismatch");
        await verifyRobloxBindingCoverage(
          root,
          binding,
          eligibleUploads.get(binding.sourceArtifactHash),
        );
      }
      await writeCanonicalWorkspaceJson(root, output, decision, {
        maxBytes: 16 * 1024 * 1024,
        ...(expectedExistingHash ? { expectedExistingHash } : {}),
      });
      state = "complete";
      send(response, 200, session());
      console.log(
        JSON.stringify({
          status: "eligible",
          observedAssets: expected.size,
          output: resolve(root, output),
          worldEngineVerified: false,
        }),
      );
    } finally {
      accepting = false;
    }
  } catch (error) {
    send(response, 400, { error: error.message.slice(0, 2048) });
  }
}
let port;
try {
  for (
    let candidate = ROBLOX_PORT_RANGE.minimum;
    candidate <= ROBLOX_PORT_RANGE.maximum;
    candidate += 1
  ) {
    try {
      await new Promise((done, fail) => {
        server.once("error", fail);
        server.listen(candidate, "127.0.0.1", () => {
          server.removeListener("error", fail);
          done();
        });
      });
      port = candidate;
      break;
    } catch (error) {
      if (error.code !== "EADDRINUSE") throw error;
    }
  }
  if (!port) throw new Error("No local bridge port is available");
} catch (error) {
  await lock.release();
  throw error;
}
console.log(
  JSON.stringify({
    status: "waiting_for_creator",
    port,
    models: expected.size,
    instruction: "Open the rebuilt Basalt plugin in Studio and click Inspect assets.",
    packetHash,
  }),
);
const stop = async () => {
  server.close();
  await lock.release();
  process.exit(0);
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
process.once("SIGHUP", stop);
