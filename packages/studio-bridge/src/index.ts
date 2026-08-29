import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  assertBasaltWorldReadback,
  assertBasaltWorldReadbackObservation,
  assertBasaltWorldTransaction,
  createBasaltWorldReadback,
  createBasaltWorldTransaction,
  reconcileBasaltWorldReadback,
  type BasaltWorldChunkDelta,
  type BasaltWorldChunkTransaction,
  type BasaltWorldEmissionManifest,
  type BasaltWorldReadback,
} from "../../studio-protocol/src/index.js";
import { contentHash, stableJson } from "../../contracts/src/index.js";

export const BASALT_STUDIO_BRIDGE_ABI = "basalt-studio-bridge@1" as const;

export interface BasaltBridgeDiscovery {
  readonly kind: "BasaltStudioBridgeDiscovery";
  readonly bridgeId: string;
  readonly host: "127.0.0.1";
  readonly port: number;
  readonly controlToken: string;
  readonly pid: number;
  readonly startedAt: string;
}

export function defaultBasaltBridgeDiscoveryPath(cwd = process.cwd()): string {
  return resolve(cwd, ".basalt", "basalt-studio-bridge.json");
}

export async function writeBasaltBridgeDiscovery(
  discovery: BasaltBridgeDiscovery,
  filePath = defaultBasaltBridgeDiscoveryPath(),
): Promise<void> {
  assertBasaltBridgeDiscovery(discovery);
  await mkdir(dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(discovery, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, filePath);
}

export async function readBasaltBridgeDiscovery(
  filePath = defaultBasaltBridgeDiscoveryPath(),
): Promise<BasaltBridgeDiscovery> {
  const metadata = await stat(filePath).catch(() => undefined);
  if (!metadata) throw new Error("Basalt Studio bridge is not running");
  if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)
    throw new Error("Basalt bridge discovery permissions are too broad");
  const value: unknown = JSON.parse(await readFile(filePath, "utf8"));
  assertBasaltBridgeDiscovery(value);
  return value;
}

export async function removeBasaltBridgeDiscovery(
  bridgeId: string,
  filePath = defaultBasaltBridgeDiscoveryPath(),
): Promise<void> {
  const current = await readBasaltBridgeDiscovery(filePath).catch(() => undefined);
  if (current?.bridgeId === bridgeId) await rm(filePath, { force: true });
}

export interface BasaltBridgeOptions {
  readonly host?: "127.0.0.1";
  readonly port?: number;
  readonly maxQueue?: number;
}

export interface BasaltBridgeStatus {
  readonly kind: "BasaltStudioBridgeStatus";
  readonly abi: typeof BASALT_STUDIO_BRIDGE_ABI;
  readonly bridgeId: string;
  readonly manifestHash?: string;
  readonly pendingTransactions: number;
  readonly appliedTransactions: number;
  readonly status: "idle" | "ready" | "incomplete";
  readonly hash: string;
}

/**
 * Host-side queue for world chunks. It deliberately has no gameplay, model,
 * render, or Studio-evidence responsibilities. A chunk moves through detached
 * preflight, ChangeHistory-bounded apply, and commit only after exact readback.
 */
export class BasaltStudioBridge {
  readonly bridgeId: string;
  readonly controlToken: string;
  readonly #maxQueue: number;
  readonly #queued: BasaltWorldChunkTransaction[] = [];
  readonly #chunks = new Map<string, BasaltWorldChunkDelta>();
  readonly #settled = new Map<string, BasaltWorldReadback>();
  #manifest?: BasaltWorldEmissionManifest;

  constructor(options: BasaltBridgeOptions = {}) {
    this.bridgeId = `basalt_bridge_${randomBytes(12).toString("hex")}`;
    this.controlToken = randomBytes(24).toString("hex");
    this.#maxQueue = Math.max(1, Math.min(options.maxQueue ?? 4096, 4096));
  }

  enqueueManifest(manifestInput: unknown, expectedRevisionHash: string): BasaltBridgeStatus {
    const manifest = assertEmissionManifest(manifestInput);
    if (!isHash(expectedRevisionHash)) throw new Error("Expected Studio revision must be a hash");
    this.#manifest = manifest;
    this.#queued.length = 0;
    this.#settled.clear();
    this.#chunks.clear();
    for (const chunk of manifest.chunks) {
      if (this.#queued.length >= this.#maxQueue)
        throw new Error("World manifest exceeds bridge queue");
      this.#chunks.set(chunk.chunkId, chunk);
      this.#queued.push(
        createBasaltWorldTransaction({
          manifestHash: manifest.hash,
          worldPlanHash: manifest.worldPlanHash,
          chunk,
          phase: "preflight",
          expectedRevisionHash,
        }),
      );
    }
    return this.status();
  }

  nextTransaction(): BasaltWorldChunkTransaction | undefined {
    return this.#queued[0];
  }

  /** Return the exact manifest currently queued for the connector. */
  manifest(): BasaltWorldEmissionManifest | undefined {
    return this.#manifest;
  }

  settle(transactionInput: unknown, readbackInput: unknown): BasaltBridgeStatus {
    const transaction = assertBasaltWorldTransaction(transactionInput);
    const readback = sealConnectorReadback(transaction, readbackInput);
    if (readback.transactionHash !== transaction.hash || readback.chunkId !== transaction.chunkId)
      throw new Error("Readback does not bind the queued transaction");
    const queued = this.#queued[0];
    if (!queued || queued.hash !== transaction.hash)
      throw new Error("Transactions must settle in canonical queue order");
    const chunk = this.#chunks.get(transaction.chunkId);
    if (!chunk) throw new Error("Readback references an unknown world chunk");
    const expectedIds = chunk.instanceIds;
    reconcileBasaltWorldReadback(transaction, readback, expectedIds);
    if (readback.phase === "committed" || readback.phase === "rolled_back") {
      if (readback.phase === "committed") {
        if (transaction.phase !== "commit") throw new Error("Commit readback has wrong phase");
      } else if (transaction.phase !== "rollback")
        throw new Error("Rollback readback has wrong phase");
      if (
        stableJson([...readback.observedInstanceIds].sort()) !== stableJson([...expectedIds].sort())
      )
        throw new Error("Committed world chunk readback has an unexpected instance set");
      this.#queued.shift();
      this.#settled.set(transaction.hash, readback);
    } else if (readback.phase === "preflighted" && transaction.phase === "preflight") {
      this.#queued[0] = createBasaltWorldTransaction({
        manifestHash: transaction.manifestHash,
        worldPlanHash: transaction.worldPlanHash,
        chunk,
        phase: "apply",
        expectedRevisionHash: transaction.expectedRevisionHash,
      });
    } else if (readback.phase === "applied" && transaction.phase === "apply") {
      this.#queued[0] = createBasaltWorldTransaction({
        manifestHash: transaction.manifestHash,
        worldPlanHash: transaction.worldPlanHash,
        chunk,
        phase: "commit",
        expectedRevisionHash: transaction.expectedRevisionHash,
      });
    } else {
      throw new Error("Readback phase cannot advance the queued transaction");
    }
    return this.status();
  }

  status(): BasaltBridgeStatus {
    const material = {
      kind: "BasaltStudioBridgeStatus" as const,
      abi: BASALT_STUDIO_BRIDGE_ABI,
      bridgeId: this.bridgeId,
      ...(this.#manifest ? { manifestHash: this.#manifest.hash } : {}),
      pendingTransactions: this.#queued.length,
      appliedTransactions: this.#settled.size,
      status: this.#manifest ? (this.#queued.length === 0 ? "ready" : "ready") : "idle",
    } as const;
    return { ...material, hash: contentHash(stableJson(material)) };
  }

  /** Build the exact readback payload the Luau connector must reproduce. */
  createReadback(
    transactionInput: unknown,
    phase: BasaltWorldReadback["phase"],
    revisionHash: string,
  ) {
    const transaction = assertBasaltWorldTransaction(transactionInput);
    const chunk = this.#chunks.get(transaction.chunkId);
    if (!chunk) throw new Error("Unknown world chunk");
    return createBasaltWorldReadback({
      transaction,
      phase,
      observedRevisionHash: revisionHash,
      observedInstanceIds: chunk.instanceIds,
    });
  }
}

export function createBasaltStudioBridgeServer(
  bridge: BasaltStudioBridge,
  options: BasaltBridgeOptions = {},
): Server {
  const server = createServer(async (request, response) => {
    try {
      await handleRequest(bridge, request, response);
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  });
  server.listen(options.port ?? 8787, options.host ?? "127.0.0.1");
  return server;
}

async function handleRequest(
  bridge: BasaltStudioBridge,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (request.method === "GET" && request.url === "/health") {
    sendJson(response, 200, bridge.status());
    return;
  }
  if (request.method === "GET" && request.url === "/poll") {
    sendJson(response, 200, bridge.nextTransaction() ?? null);
    return;
  }
  if (request.method === "GET" && request.url === "/manifest") {
    sendJson(response, 200, bridge.manifest() ?? null);
    return;
  }
  if (request.method === "POST" && request.url === "/settle") {
    const body = await readJson(request);
    if (!isRecord(body) || !Object.hasOwn(body, "transaction") || !Object.hasOwn(body, "readback"))
      throw new Error("Settlement requires transaction and readback");
    sendJson(response, 200, bridge.settle(body.transaction, body.readback));
    return;
  }
  sendJson(response, 404, { error: "Basalt bridge route not found" });
}

function assertEmissionManifest(value: unknown): BasaltWorldEmissionManifest {
  if (!isRecord(value) || value.kind !== "BasaltWorldEmissionManifest")
    throw new Error("Invalid Basalt world emission manifest");
  if (
    value.abi !== "basalt-world-emission@1" ||
    !isHash(value.worldPlanHash) ||
    !isHash(value.populationHash) ||
    !isHash(value.hash) ||
    !Array.isArray(value.chunks) ||
    value.chunks.length > 4096
  )
    throw new Error("Invalid Basalt world emission manifest fields");
  const chunks = value.chunks as BasaltWorldChunkDelta[];
  const chunkIds = new Set<string>();
  for (const chunk of chunks) {
    if (
      !isRecord(chunk) ||
      chunk.kind !== "BasaltWorldChunkDelta" ||
      !isId(chunk.chunkId) ||
      !isHash(chunk.hash) ||
      !isHash(chunk.worldPlanHash) ||
      !isHash(chunk.populationHash) ||
      !Array.isArray(chunk.instanceIds) ||
      !Array.isArray(chunk.surfaceIds) ||
      !isId(chunk.id) ||
      !isId(chunk.transactionId) ||
      !isBounds(chunk.bounds) ||
      chunk.worldPlanHash !== value.worldPlanHash ||
      chunk.populationHash !== value.populationHash
    )
      throw new Error("Invalid Basalt world chunk delta");
    if (chunkIds.has(chunk.chunkId)) throw new Error("World chunk IDs must be unique");
    chunkIds.add(chunk.chunkId);
    const instanceIds = canonicalIds(chunk.instanceIds, "world chunk instanceIds");
    const surfaceIds = canonicalIds(chunk.surfaceIds, "world chunk surfaceIds");
    if (stableJson(instanceIds) !== stableJson(chunk.instanceIds))
      throw new Error("World chunk instance IDs are not canonical");
    if (stableJson(surfaceIds) !== stableJson(chunk.surfaceIds))
      throw new Error("World chunk surface IDs are not canonical");
    const chunkMaterial = {
      kind: "BasaltWorldChunkDelta" as const,
      chunkId: chunk.chunkId,
      worldPlanHash: chunk.worldPlanHash,
      populationHash: chunk.populationHash,
      surfaceIds,
      instanceIds,
      bounds: chunk.bounds,
    };
    if (contentHash(stableJson(chunkMaterial)) !== chunk.hash)
      throw new Error(`World chunk hash mismatch: ${chunk.chunkId}`);
  }
  const canonical = [...chunks].sort((left, right) => compareIds(left.chunkId, right.chunkId));
  if (stableJson(canonical) !== stableJson(chunks))
    throw new Error("World chunks are not canonical");
  const manifestMaterial = {
    kind: "BasaltWorldEmissionManifest" as const,
    abi: "basalt-world-emission@1" as const,
    worldPlanHash: value.worldPlanHash,
    populationHash: value.populationHash,
    chunks,
  };
  if (contentHash(stableJson(manifestMaterial)) !== value.hash)
    throw new Error("Basalt world emission manifest hash mismatch");
  return value as unknown as BasaltWorldEmissionManifest;
}

function sealConnectorReadback(
  transaction: ReturnType<typeof assertBasaltWorldTransaction>,
  input: unknown,
): BasaltWorldReadback {
  if (isRecord(input) && input.kind === "BasaltWorldReadbackObservation") {
    const observation = assertBasaltWorldReadbackObservation(input);
    if (
      observation.transactionHash !== transaction.hash ||
      observation.chunkId !== transaction.chunkId
    )
      throw new Error("Readback observation does not bind the transaction");
    return createBasaltWorldReadback({
      transaction,
      phase: observation.phase,
      observedRevisionHash: observation.observedRevisionHash,
      observedInstanceIds: observation.observedInstanceIds,
    });
  }
  return assertBasaltWorldReadback(input);
}

function canonicalIds(values: unknown, label: string): string[] {
  if (!Array.isArray(values) || values.length > 65_536 || !values.every(isId))
    throw new Error(`Basalt ${label} must contain bounded IDs`);
  const ids = [...values];
  if (new Set(ids).size !== ids.length) throw new Error(`Basalt ${label} must be unique`);
  return ids.sort();
}

function isBounds(value: unknown): value is BasaltWorldChunkDelta["bounds"] {
  if (!isRecord(value) || !isVector(value.minimum) || !isVector(value.maximum)) return false;
  return (
    value.minimum.x <= value.maximum.x &&
    value.minimum.y <= value.maximum.y &&
    value.minimum.z <= value.maximum.z
  );
}

function isVector(value: unknown): value is { x: number; y: number; z: number } {
  return (
    isRecord(value) &&
    typeof value.x === "number" &&
    Number.isFinite(value.x) &&
    typeof value.y === "number" &&
    Number.isFinite(value.y) &&
    typeof value.z === "number" &&
    Number.isFinite(value.z)
  );
}

function assertBasaltBridgeDiscovery(value: unknown): asserts value is BasaltBridgeDiscovery {
  if (
    !isRecord(value) ||
    value.kind !== "BasaltStudioBridgeDiscovery" ||
    !isId(value.bridgeId) ||
    value.host !== "127.0.0.1" ||
    typeof value.port !== "number" ||
    !Number.isInteger(value.port) ||
    value.port < 1 ||
    value.port > 65_535 ||
    typeof value.controlToken !== "string" ||
    value.controlToken.length < 24 ||
    typeof value.pid !== "number" ||
    !Number.isInteger(value.pid) ||
    value.pid < 1 ||
    typeof value.startedAt !== "string"
  )
    throw new Error("Invalid Basalt Studio bridge discovery");
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk as Uint8Array);
    bytes += buffer.length;
    if (bytes > 1024 * 1024) throw new Error("Basalt bridge request exceeds 1 MiB");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify(value));
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,255}$/u.test(value);
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
