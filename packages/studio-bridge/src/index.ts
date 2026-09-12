import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  assertBasaltWorldReadback,
  assertBasaltWorldReadbackObservation,
  assertBasaltWorldTransaction,
  createBasaltWorldReadback,
  createBasaltWorldTransaction,
  reconcileBasaltWorldReadback,
  sealVoxelSpotHashes,
  type BasaltImportFactorObservation,
  type BasaltVoxelSpotObservation,
  type BasaltWorldChunkDelta,
  type BasaltWorldChunkTransaction,
  type BasaltWorldEmissionManifest,
  type BasaltWorldReadback,
} from "../../studio-protocol/src/index.js";
import { contentHash, stableJson } from "../../contracts/src/index.js";
import {
  parseVoxelField,
  VOXEL_SPOT_OCCUPANCY_TOLERANCE,
  voxelSpotCells,
} from "../../world-planning/src/voxels.js";

export const BASALT_STUDIO_BRIDGE_ABI = "basalt-studio-bridge@1" as const;
/** Hard cap on a single scene payload served over the binary channel. */
export const MAX_SCENE_PAYLOAD_BYTES = 20971520;
/**
 * Relative drift allowed between a Studio-observed import factor and the
 * factor the sidecar recorded for the same part. Mirrors the connector's
 * `IMPORT_SCALE_TOLERANCE`; the two are compared as formatted decimals in
 * failure messages, never as floats across the wire.
 */
export const BRIDGE_IMPORT_FACTOR_TOLERANCE = 0.01 as const;

export interface BasaltScenePayloadEntry {
  readonly contentHash: string;
  readonly byteLength: number;
  readonly mediaType: "model/gltf-binary" | "application/x-basalt-voxels";
}

export interface BasaltSceneExportManifest {
  readonly kind: "BasaltSceneExport";
  readonly abi: "basalt-scene-export@1";
  readonly worldPlanHash: string;
  readonly populationHash: string;
  readonly studMeters: number;
  readonly placementConvention: {
    readonly lengthUnit: "meter";
    readonly upAxis: "+Y";
    readonly handedness: "right-handed";
    readonly instanceComposition: string;
  };
  readonly instances: readonly unknown[];
  readonly assets: readonly unknown[];
  readonly parts: readonly unknown[];
  readonly terrain: readonly unknown[];
  readonly roads: readonly unknown[];
  readonly skirts: readonly unknown[];
  readonly materialIds: readonly string[];
  readonly payloads: readonly BasaltScenePayloadEntry[];
  readonly hash: string;
}

/**
 * Adapter-owned binding of sealed mesh-part bytes to engine handles.
 * Written by the upload tooling, never by the compiler; the bridge serves
 * it so the connector can lower instances without sealed engine handles.
 */
export interface BasaltEngineSidecarBinding {
  readonly contentHash: string;
  /** Bare decimal engine asset id (no URI scheme). */
  readonly assetId: string | number;
  readonly uploadedAt: string;
  readonly budgets: {
    readonly triangles: number;
    readonly bytes: number;
    readonly watertight: boolean;
  };
  /**
   * Studio-measured imported-studs-per-source-unit, merged back after a
   * Studio run. Absent until observed; when present the connector and the
   * bridge both fail closed past the import tolerance.
   */
  readonly importFactor?: number;
}

export interface BasaltEngineSidecar {
  readonly kind: "BasaltEngineSidecar";
  readonly abi: "basalt-engine-sidecar@1";
  readonly engine: "roblox";
  readonly exportHash: string;
  readonly bindings: readonly BasaltEngineSidecarBinding[];
}

/**
 * Adapter-owned mapping of open-vocabulary material ids to engine material
 * names. Creator-authored per region; the bridge validates shape only, and
 * the connector resolves names against the live engine enum.
 */
export interface BasaltMaterialMapBinding {
  readonly materialId: string;
  readonly robloxMaterial: string;
}

export interface BasaltMaterialMap {
  readonly kind: "BasaltMaterialMap";
  readonly abi: "basalt-material-map@1";
  readonly engine: "roblox";
  readonly exportHash: string;
  readonly bindings: readonly BasaltMaterialMapBinding[];
}

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

export function defaultBasaltBridgeReadbackDir(cwd = process.cwd()): string {
  return resolve(cwd, ".basalt", "readbacks");
}

export interface BasaltBridgeOptions {
  readonly host?: "127.0.0.1";
  readonly port?: number;
  readonly maxQueue?: number;
  /**
   * Directory receiving one sealed readback per settled transaction. Absent
   * keeps readbacks in memory only; the CLI always configures a directory.
   */
  readonly readbackDir?: string;
}

export interface BasaltBridgeStatus {
  readonly kind: "BasaltStudioBridgeStatus";
  readonly abi: typeof BASALT_STUDIO_BRIDGE_ABI;
  readonly bridgeId: string;
  readonly manifestHash?: string;
  readonly exportHash?: string;
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
  #readbackDir?: string;
  readonly #queued: BasaltWorldChunkTransaction[] = [];
  readonly #chunks = new Map<string, BasaltWorldChunkDelta>();
  readonly #settled = new Map<string, BasaltWorldReadback>();
  readonly #payloads = new Map<string, Uint8Array>();
  #manifest?: BasaltWorldEmissionManifest;
  #sceneExport?: BasaltSceneExportManifest;
  #sidecar?: BasaltEngineSidecar;
  #materialMap?: BasaltMaterialMap;

  constructor(options: BasaltBridgeOptions = {}) {
    this.bridgeId = `basalt_bridge_${randomBytes(12).toString("hex")}`;
    this.controlToken = randomBytes(24).toString("hex");
    this.#maxQueue = Math.max(1, Math.min(options.maxQueue ?? 4096, 4096));
    if (options.readbackDir !== undefined) this.#readbackDir = options.readbackDir;
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

  /**
   * Register one scene export and its payload bytes. Every payload is
   * hash-verified against the manifest before it becomes servable; unknown
   * or oversize bytes fail closed here, never at request time.
   */
  enqueueSceneExport(
    manifestInput: unknown,
    payloads: ReadonlyMap<string, Uint8Array>,
  ): BasaltBridgeStatus {
    const manifest = assertSceneExportManifest(manifestInput);
    const verified = new Map<string, Uint8Array>();
    for (const entry of manifest.payloads) {
      const bytes = payloads.get(entry.contentHash);
      if (!bytes) throw new Error(`Scene export is missing payload: ${entry.contentHash}`);
      if (!(bytes instanceof Uint8Array))
        throw new Error(`Scene payload is not bytes: ${entry.contentHash}`);
      if (bytes.byteLength !== entry.byteLength)
        throw new Error(`Scene payload length disagrees with manifest: ${entry.contentHash}`);
      if (bytes.byteLength > MAX_SCENE_PAYLOAD_BYTES)
        throw new Error(`Scene payload exceeds its bound: ${entry.contentHash}`);
      if (sha256Bytes(bytes) !== entry.contentHash)
        throw new Error(`Scene payload hash mismatch: ${entry.contentHash}`);
      verified.set(entry.contentHash, bytes.slice());
    }
    this.#sceneExport = manifest;
    this.#payloads.clear();
    for (const [hash, bytes] of verified) this.#payloads.set(hash, bytes);
    return this.status();
  }

  sceneExport(): BasaltSceneExportManifest | undefined {
    return this.#sceneExport;
  }

  /**
   * Register the adapter-owned upload sidecar. It must bind the exact
   * enqueued scene export; a sidecar for any other export fails closed so
   * the connector can never lower geometry against stale asset ids.
   */
  enqueueSidecar(sidecarInput: unknown): BasaltBridgeStatus {
    const sidecar = assertEngineSidecar(sidecarInput);
    if (!this.#sceneExport) throw new Error("Scene export must be enqueued before its sidecar");
    if (sidecar.exportHash !== this.#sceneExport.hash)
      throw new Error("Engine sidecar binds a different scene export");
    this.#sidecar = sidecar;
    return this.status();
  }

  sidecar(): BasaltEngineSidecar | undefined {
    return this.#sidecar;
  }

  /**
   * Register the adapter-owned material map. It must bind the exact
   * enqueued scene export so terrain and road materials resolve against
   * the material ids the export actually carries.
   */
  enqueueMaterialMap(materialMapInput: unknown): BasaltBridgeStatus {
    const materialMap = assertMaterialMap(materialMapInput);
    if (!this.#sceneExport)
      throw new Error("Scene export must be enqueued before its material map");
    if (materialMap.exportHash !== this.#sceneExport.hash)
      throw new Error("Material map binds a different scene export");
    this.#materialMap = materialMap;
    return this.status();
  }

  materialMap(): BasaltMaterialMap | undefined {
    return this.#materialMap;
  }

  readPayload(contentHash: string): Uint8Array {
    const bytes = this.#payloads.get(contentHash);
    if (!bytes) throw new Error(`Unknown scene payload: ${contentHash}`);
    return bytes.slice();
  }

  settle(transactionInput: unknown, readbackInput: unknown): BasaltBridgeStatus {
    const transaction = assertBasaltWorldTransaction(transactionInput);
    const readback = sealConnectorReadback(transaction, readbackInput, this.#sceneExport?.hash);
    if (readback.transactionHash !== transaction.hash || readback.chunkId !== transaction.chunkId)
      throw new Error("Readback does not bind the queued transaction");
    const queued = this.#queued[0];
    if (!queued || queued.hash !== transaction.hash)
      throw new Error("Transactions must settle in canonical queue order");
    const chunk = this.#chunks.get(transaction.chunkId);
    if (!chunk) throw new Error("Readback references an unknown world chunk");
    const expectedIds = chunk.instanceIds;
    const expectedRoads = chunk.roadSegmentIds;
    reconcileBasaltWorldReadback(transaction, readback, expectedIds, expectedRoads);
    this.assertReadbackEvidence(readback, chunk);
    if (readback.phase === "committed" || readback.phase === "rolled_back") {
      if (readback.phase === "committed") {
        if (transaction.phase !== "commit") throw new Error("Commit readback has wrong phase");
      } else if (transaction.phase !== "rollback")
        throw new Error("Rollback readback has wrong phase");
      if (
        stableJson([...readback.observedInstanceIds].sort()) !== stableJson([...expectedIds].sort())
      )
        throw new Error("Committed world chunk readback has an unexpected instance set");
      if (
        stableJson([...readback.observedRoadSegmentIds].sort()) !==
        stableJson([...expectedRoads].sort())
      )
        throw new Error("Committed world chunk readback has an unexpected road set");
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
    this.persistReadback(readback);
    return this.status();
  }

  /**
   * Evidence gate: only applied readbacks may carry voxel spots or import
   * factors, and an applied readback must account for every chunk surface
   * and every lowered part against the sealed export. Runs before any queue
   * mutation so a failed verification never advances the transaction.
   */
  private assertReadbackEvidence(
    readback: BasaltWorldReadback,
    chunk: BasaltWorldChunkDelta,
  ): void {
    if (readback.phase !== "applied") {
      if (readback.observedVoxelSpots.length > 0 || readback.observedImportFactors.length > 0)
        throw new Error(`A ${readback.phase} readback must not carry observed evidence`);
      return;
    }
    const sceneExport = this.#sceneExport;
    if (!sceneExport) throw new Error("An applied readback needs its scene export");
    const materialMap = this.#materialMap;
    if (!materialMap) throw new Error("An applied readback needs its material map");
    assertSpotEvidence(
      readback.observedVoxelSpots,
      chunk.surfaceIds,
      sceneExport,
      this.#payloads,
      materialMap,
    );
    assertFactorEvidence(
      readback.observedImportFactors,
      chunk.instanceIds,
      sceneExport,
      this.#sidecar,
    );
  }

  /** Append the sealed readback to the on-disk evidence trail when configured. */
  private persistReadback(readback: BasaltWorldReadback): void {
    if (!this.#readbackDir) return;
    mkdirSync(this.#readbackDir, { recursive: true });
    const target = resolve(this.#readbackDir, `${readback.transactionHash}.json`);
    const temporary = `${target}.${process.pid}.tmp`;
    writeFileSync(temporary, `${stableJson(readback)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, target);
  }

  status(): BasaltBridgeStatus {
    const material = {
      kind: "BasaltStudioBridgeStatus" as const,
      abi: BASALT_STUDIO_BRIDGE_ABI,
      bridgeId: this.bridgeId,
      ...(this.#manifest ? { manifestHash: this.#manifest.hash } : {}),
      ...(this.#sceneExport ? { exportHash: this.#sceneExport.hash } : {}),
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
    evidence?: {
      readonly observedVoxelSpots?: readonly BasaltVoxelSpotObservation[];
      readonly observedImportFactors?: readonly BasaltImportFactorObservation[];
    },
  ) {
    const transaction = assertBasaltWorldTransaction(transactionInput);
    const chunk = this.#chunks.get(transaction.chunkId);
    if (!chunk) throw new Error("Unknown world chunk");
    const observedVoxelSpots = evidence?.observedVoxelSpots ?? [];
    return createBasaltWorldReadback({
      transaction,
      phase,
      observedRevisionHash: revisionHash,
      observedInstanceIds: chunk.instanceIds,
      observedRoadSegmentIds: chunk.roadSegmentIds,
      observedVoxelSpots,
      observedImportFactors: evidence?.observedImportFactors ?? [],
      spotHashes: sealVoxelSpotHashes(observedVoxelSpots),
      ...(this.#sceneExport ? { exportHash: this.#sceneExport.hash } : {}),
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
  if (request.method === "GET" && request.url === "/export") {
    sendJson(response, 200, bridge.sceneExport() ?? null);
    return;
  }
  if (request.method === "GET" && request.url === "/sidecar") {
    sendJson(response, 200, bridge.sidecar() ?? null);
    return;
  }
  if (request.method === "GET" && request.url === "/material-map") {
    sendJson(response, 200, bridge.materialMap() ?? null);
    return;
  }
  if (request.method === "GET" && request.url?.startsWith("/payload/")) {
    const contentHash = request.url.slice("/payload/".length);
    if (!/^[0-9a-f]{64}$/.test(contentHash))
      throw new Error("Scene payload requests address a 64-hex content hash");
    sendBytes(response, 200, bridge.readPayload(contentHash));
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
      !Array.isArray(chunk.roadSegmentIds) ||
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
    const roadSegmentIds = canonicalIds(
      chunk.roadSegmentIds,
      "world chunk road segment IDs",
      16_384,
    );
    if (stableJson(instanceIds) !== stableJson(chunk.instanceIds))
      throw new Error("World chunk instance IDs are not canonical");
    if (stableJson(surfaceIds) !== stableJson(chunk.surfaceIds))
      throw new Error("World chunk surface IDs are not canonical");
    if (stableJson(roadSegmentIds) !== stableJson(chunk.roadSegmentIds))
      throw new Error("World chunk road segment IDs are not canonical");
    const chunkMaterial = {
      kind: "BasaltWorldChunkDelta" as const,
      chunkId: chunk.chunkId,
      worldPlanHash: chunk.worldPlanHash,
      populationHash: chunk.populationHash,
      surfaceIds,
      instanceIds,
      roadSegmentIds,
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
  exportHash?: string,
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
      observedRoadSegmentIds: observation.observedRoadSegmentIds,
      observedVoxelSpots: observation.observedVoxelSpots,
      observedImportFactors: observation.observedImportFactors,
      spotHashes: sealVoxelSpotHashes(observation.observedVoxelSpots),
      ...(exportHash === undefined ? {} : { exportHash }),
    });
  }
  return assertBasaltWorldReadback(input);
}

/**
 * Replay every observed voxel spot against the sealed payload: the observed
 * surfaces must equal the chunk surfaces, the observed cells must equal the
 * deterministic spot rule, and each observed value must match the sealed
 * occupancy (within engine quantization) and mapped material.
 */
function assertSpotEvidence(
  spots: readonly BasaltVoxelSpotObservation[],
  surfaceIds: readonly string[],
  sceneExport: BasaltSceneExportManifest,
  payloads: ReadonlyMap<string, Uint8Array>,
  materialMap: BasaltMaterialMap,
): void {
  const observedSurfaces = [...new Set(spots.map((spot) => spot.surfaceId))].sort();
  if (stableJson(observedSurfaces) !== stableJson([...surfaceIds].sort()))
    throw new Error("Applied readback voxel spots do not cover the chunk surfaces");
  const materialById = new Map(
    materialMap.bindings.map((binding) => [binding.materialId, binding.robloxMaterial]),
  );
  for (const surfaceId of surfaceIds) {
    const entry = sceneExport.terrain.find(
      (candidate): candidate is { surfaceId: string; voxelHash: string } =>
        isRecord(candidate) &&
        candidate.surfaceId === surfaceId &&
        typeof candidate.voxelHash === "string",
    );
    if (!entry) throw new Error(`Scene export has no terrain for surface ${surfaceId}`);
    const bytes = payloads.get(entry.voxelHash);
    if (!bytes) throw new Error(`Scene export is missing voxel payload for ${surfaceId}`);
    const field = parseVoxelField(bytes);
    const expected = new Set(voxelSpotCells(field.dimensions).map(([x, y, z]) => `${x},${y},${z}`));
    const observed = spots.filter((spot) => spot.surfaceId === surfaceId);
    const observedKeys = observed.map((spot) => `${spot.x},${spot.y},${spot.z}`).sort();
    if (stableJson(observedKeys) !== stableJson([...expected].sort()))
      throw new Error(`Applied readback voxel spots miss cells of surface ${surfaceId}`);
    const [nx, , nz] = field.dimensions;
    for (const spot of observed) {
      const flat = spot.x + nx * (spot.z + nz * spot.y);
      const sealed = field.occupancy[flat]!;
      if (Math.abs(spot.occupancy - sealed) > VOXEL_SPOT_OCCUPANCY_TOLERANCE)
        throw new Error(
          `Surface ${surfaceId} cell ${spot.x},${spot.y},${spot.z} reads occupancy ` +
            `${spot.occupancy} against sealed ${sealed}`,
        );
      const materialId = field.materials[field.materialIndex[flat]!]!;
      const expectedMaterial = materialById.get(materialId);
      if (!expectedMaterial)
        throw new Error(`Surface ${surfaceId} material ${materialId} has no mapped material`);
      if (spot.material !== expectedMaterial)
        throw new Error(
          `Surface ${surfaceId} cell ${spot.x},${spot.y},${spot.z} reads material ` +
            `${spot.material} against mapped ${expectedMaterial}`,
        );
    }
  }
}

/**
 * Replay every observed import factor against the sealed export: the observed
 * parts must equal the parts the chunk instances lower, and any sidecar
 * recorded factor must agree within the import tolerance.
 */
function assertFactorEvidence(
  factors: readonly BasaltImportFactorObservation[],
  instanceIds: readonly string[],
  sceneExport: BasaltSceneExportManifest,
  sidecar: BasaltEngineSidecar | undefined,
): void {
  const expected = new Set<string>();
  for (const instanceId of instanceIds) {
    const instance = sceneExport.instances.find(
      (candidate): candidate is { id: string; assetId: string } =>
        isRecord(candidate) && candidate.id === instanceId && typeof candidate.assetId === "string",
    );
    if (!instance) throw new Error(`Scene export has no instance ${instanceId}`);
    const asset = sceneExport.assets.find(
      (candidate): candidate is { assetId: string; partHashes: string[] } =>
        isRecord(candidate) &&
        candidate.assetId === instance.assetId &&
        Array.isArray(candidate.partHashes) &&
        candidate.partHashes.every((hash): hash is string => typeof hash === "string"),
    );
    if (!asset) throw new Error(`Scene export has no asset ${instance.assetId}`);
    for (const partHash of asset.partHashes) expected.add(partHash);
  }
  const observed = factors.map((entry) => entry.contentHash).sort();
  if (stableJson(observed) !== stableJson([...expected].sort()))
    throw new Error("Applied readback import factors do not cover the lowered parts");
  const partHashes = new Set(
    sceneExport.parts
      .map((candidate) => (isRecord(candidate) ? candidate.contentHash : undefined))
      .filter((hash): hash is string => typeof hash === "string"),
  );
  const recorded = new Map(
    (sidecar?.bindings ?? [])
      .filter((binding) => typeof binding.importFactor === "number")
      .map((binding) => [binding.contentHash, binding.importFactor!]),
  );
  for (const entry of factors) {
    if (!partHashes.has(entry.contentHash))
      throw new Error(`Applied readback factor references unknown part ${entry.contentHash}`);
    const baseline = recorded.get(entry.contentHash);
    if (baseline === undefined) continue;
    if (Math.abs(entry.factor - baseline) / baseline > BRIDGE_IMPORT_FACTOR_TOLERANCE)
      throw new Error(
        `Part ${entry.contentHash} import factor ${entry.factor} drifts past recorded ${baseline}`,
      );
  }
}

function canonicalIds(values: unknown, label: string, max = 65_536): string[] {
  if (!Array.isArray(values) || values.length > max || !values.every(isId))
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

function sendBytes(response: ServerResponse, status: number, bytes: Uint8Array): void {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/octet-stream");
  response.setHeader("Content-Length", String(bytes.byteLength));
  response.end(Buffer.from(bytes));
}

function assertSceneExportManifest(value: unknown): BasaltSceneExportManifest {
  if (!isRecord(value) || value.kind !== "BasaltSceneExport")
    throw new Error("Invalid Basalt scene export manifest");
  const convention = value.placementConvention;
  if (
    value.abi !== "basalt-scene-export@1" ||
    !isHash(value.worldPlanHash) ||
    !isHash(value.populationHash) ||
    !isHash(value.hash) ||
    value.studMeters !== 0.28 ||
    !isRecord(convention) ||
    convention.lengthUnit !== "meter" ||
    convention.upAxis !== "+Y" ||
    convention.handedness !== "right-handed" ||
    typeof convention.instanceComposition !== "string" ||
    !Array.isArray(value.instances) ||
    !Array.isArray(value.assets) ||
    !Array.isArray(value.parts) ||
    !Array.isArray(value.terrain) ||
    !Array.isArray(value.roads) ||
    !Array.isArray(value.skirts) ||
    !Array.isArray(value.materialIds) ||
    !value.materialIds.every((id) => typeof id === "string" && id.length > 0) ||
    !Array.isArray(value.payloads)
  )
    throw new Error("Invalid Basalt scene export manifest fields");
  for (const entry of value.payloads as BasaltScenePayloadEntry[]) {
    if (
      !isRecord(entry) ||
      !isHash(entry.contentHash) ||
      !Number.isInteger(entry.byteLength) ||
      entry.byteLength <= 0 ||
      entry.byteLength > MAX_SCENE_PAYLOAD_BYTES ||
      (entry.mediaType !== "model/gltf-binary" && entry.mediaType !== "application/x-basalt-voxels")
    )
      throw new Error("Invalid Basalt scene export payload entry");
  }
  const material = {
    kind: value.kind,
    abi: value.abi,
    worldPlanHash: value.worldPlanHash,
    populationHash: value.populationHash,
    studMeters: value.studMeters,
    placementConvention: value.placementConvention,
    instances: value.instances,
    assets: value.assets,
    parts: value.parts,
    terrain: value.terrain,
    roads: value.roads,
    skirts: value.skirts,
    materialIds: value.materialIds,
    payloads: value.payloads,
  };
  if (contentHash(stableJson(material)) !== value.hash)
    throw new Error("Basalt scene export manifest hash mismatch");
  return value as unknown as BasaltSceneExportManifest;
}

function assertEngineSidecar(value: unknown): BasaltEngineSidecar {
  if (!isRecord(value) || value.kind !== "BasaltEngineSidecar")
    throw new Error("Invalid Basalt engine sidecar");
  if (
    value.abi !== "basalt-engine-sidecar@1" ||
    value.engine !== "roblox" ||
    !isHash(value.exportHash) ||
    !Array.isArray(value.bindings) ||
    value.bindings.length > 65_536
  )
    throw new Error("Invalid Basalt engine sidecar fields");
  const seen = new Set<string>();
  for (const binding of value.bindings as BasaltEngineSidecarBinding[]) {
    const budgets: unknown = binding?.budgets;
    const importFactor: unknown = binding?.importFactor;
    if (
      !isRecord(binding) ||
      !isHash(binding.contentHash) ||
      !isAssetId(binding.assetId) ||
      typeof binding.uploadedAt !== "string" ||
      binding.uploadedAt.length === 0 ||
      !isRecord(budgets) ||
      !Number.isInteger(budgets.triangles) ||
      (budgets.triangles as number) < 0 ||
      !Number.isInteger(budgets.bytes) ||
      (budgets.bytes as number) <= 0 ||
      typeof budgets.watertight !== "boolean" ||
      (importFactor !== undefined &&
        (typeof importFactor !== "number" || !Number.isFinite(importFactor) || importFactor <= 0))
    )
      throw new Error("Invalid Basalt engine sidecar binding");
    if (seen.has(binding.contentHash))
      throw new Error("Basalt engine sidecar binds a content hash twice");
    seen.add(binding.contentHash);
  }
  const bindings = value.bindings as BasaltEngineSidecarBinding[];
  const canonical = [...bindings].sort((left, right) =>
    compareIds(left.contentHash, right.contentHash),
  );
  if (stableJson(canonical) !== stableJson(bindings))
    throw new Error("Basalt engine sidecar bindings are not canonical");
  return value as unknown as BasaltEngineSidecar;
}

function assertMaterialMap(value: unknown): BasaltMaterialMap {
  if (!isRecord(value) || value.kind !== "BasaltMaterialMap")
    throw new Error("Invalid Basalt material map");
  if (
    value.abi !== "basalt-material-map@1" ||
    value.engine !== "roblox" ||
    !isHash(value.exportHash) ||
    !Array.isArray(value.bindings) ||
    value.bindings.length > 1024
  )
    throw new Error("Invalid Basalt material map fields");
  const seen = new Set<string>();
  for (const binding of value.bindings as BasaltMaterialMapBinding[]) {
    if (
      !isRecord(binding) ||
      typeof binding.materialId !== "string" ||
      binding.materialId.length === 0 ||
      binding.materialId.length > 256 ||
      typeof binding.robloxMaterial !== "string" ||
      !/^[A-Za-z]{2,32}$/u.test(binding.robloxMaterial)
    )
      throw new Error("Invalid Basalt material map binding");
    if (seen.has(binding.materialId))
      throw new Error("Basalt material map binds a material id twice");
    seen.add(binding.materialId);
  }
  const bindings = value.bindings as BasaltMaterialMapBinding[];
  const canonical = [...bindings].sort((left, right) =>
    compareIds(left.materialId, right.materialId),
  );
  if (stableJson(canonical) !== stableJson(bindings))
    throw new Error("Basalt material map bindings are not canonical");
  return value as unknown as BasaltMaterialMap;
}

function isAssetId(value: unknown): value is string | number {
  return (
    (typeof value === "number" && Number.isInteger(value) && value >= 1) ||
    (typeof value === "string" && /^[0-9]{1,20}$/u.test(value))
  );
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
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
