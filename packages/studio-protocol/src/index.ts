import { contentHash, stableJson, type Hash } from "../../contracts/src/index.js";

/** The only Studio protocol Basalt exposes: bounded world-chunk delivery. */
export const BASALT_STUDIO_PROTOCOL_ABI = "basalt-studio-protocol@1" as const;
export const BASALT_WORLD_TRANSACTION_ABI = "basalt-world-transaction@1" as const;
export const BASALT_WORLD_READBACK_ABI = "basalt-world-readback@1" as const;
export const MAX_WORLD_CHUNKS_PER_MANIFEST = 4096 as const;
export const MAX_WORLD_INSTANCES_PER_CHUNK = 65_536 as const;
export const MAX_WORLD_ROAD_SEGMENTS_PER_CHUNK = 16_384 as const;
export const MAX_WORLD_READBACK_VOXEL_SPOTS = 16_384 as const;
export const MAX_WORLD_READBACK_IMPORT_FACTORS = 16_384 as const;

export type BasaltWorldBounds = Readonly<{
  minimum: Readonly<{ x: number; y: number; z: number }>;
  maximum: Readonly<{ x: number; y: number; z: number }>;
}>;

/** Metadata emitted by the compiler and consumed by the connector. */
export interface BasaltWorldChunkDelta {
  readonly kind: "BasaltWorldChunkDelta";
  readonly id: string;
  readonly chunkId: string;
  readonly worldPlanHash: Hash;
  readonly populationHash: Hash;
  readonly surfaceIds: readonly string[];
  readonly instanceIds: readonly string[];
  readonly roadSegmentIds: readonly string[];
  readonly bounds: BasaltWorldBounds;
  readonly transactionId: string;
  readonly hash: Hash;
}

export interface BasaltWorldEmissionManifest {
  readonly kind: "BasaltWorldEmissionManifest";
  readonly abi: "basalt-world-emission@1";
  readonly worldPlanHash: Hash;
  readonly populationHash: Hash;
  readonly chunks: readonly BasaltWorldChunkDelta[];
  readonly hash: Hash;
}

export type BasaltWorldTransactionPhase = "preflight" | "apply" | "commit" | "rollback";

/** One detached preflight or ChangeHistory-bounded chunk write. */
export interface BasaltWorldChunkTransaction {
  readonly kind: "BasaltWorldChunkTransaction";
  readonly abi: typeof BASALT_WORLD_TRANSACTION_ABI;
  readonly transactionId: string;
  readonly manifestHash: Hash;
  readonly worldPlanHash: Hash;
  readonly chunkHash: Hash;
  readonly chunkId: string;
  readonly instanceIds: readonly string[];
  readonly roadSegmentIds: readonly string[];
  readonly phase: BasaltWorldTransactionPhase;
  readonly expectedRevisionHash: Hash;
  readonly payloadHash: Hash;
  readonly hash: Hash;
}

/**
 * One Studio-observed voxel cell: 0-based cell coordinates plus the live
 * occupancy and engine material name read back after lowering. Coordinates
 * address the sealed field dimensions; the host replays them against the
 * sealed payload, so only applied readbacks may carry spots.
 */
export interface BasaltVoxelSpotObservation {
  readonly surfaceId: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly occupancy: number;
  readonly material: string;
}

/** Studio-measured imported-studs-per-source-unit for one uploaded part. */
export interface BasaltImportFactorObservation {
  readonly contentHash: Hash;
  readonly factor: number;
}

/** Host-sealed drift key over one surface's observed spots. */
export interface BasaltVoxelSpotHash {
  readonly surfaceId: string;
  readonly spotHash: Hash;
}

export interface BasaltWorldReadback {
  readonly kind: "BasaltWorldReadback";
  readonly abi: typeof BASALT_WORLD_READBACK_ABI;
  readonly transactionHash: Hash;
  readonly chunkId: string;
  readonly phase: "preflighted" | "applied" | "committed" | "rolled_back";
  readonly observedRevisionHash: Hash;
  readonly observedInstanceIds: readonly string[];
  readonly observedRoadSegmentIds: readonly string[];
  readonly observedVoxelSpots: readonly BasaltVoxelSpotObservation[];
  readonly observedImportFactors: readonly BasaltImportFactorObservation[];
  readonly spotHashes: readonly BasaltVoxelSpotHash[];
  readonly exportHash?: Hash;
  readonly hash: Hash;
}

/** Unsigned observation returned by the Studio connector; the host seals it. */
export interface BasaltWorldReadbackObservation {
  readonly kind: "BasaltWorldReadbackObservation";
  readonly abi: typeof BASALT_WORLD_READBACK_ABI;
  readonly transactionHash: Hash;
  readonly chunkId: string;
  readonly phase: BasaltWorldReadback["phase"];
  readonly observedRevisionHash: Hash;
  readonly observedInstanceIds: readonly string[];
  readonly observedRoadSegmentIds: readonly string[];
  readonly observedVoxelSpots: readonly BasaltVoxelSpotObservation[];
  readonly observedImportFactors: readonly BasaltImportFactorObservation[];
}

export type BasaltStudioMessage =
  | { readonly type: "world_chunk_preflight"; readonly transaction: BasaltWorldChunkTransaction }
  | { readonly type: "world_chunk_apply"; readonly transaction: BasaltWorldChunkTransaction }
  | { readonly type: "world_chunk_commit"; readonly transaction: BasaltWorldChunkTransaction }
  | { readonly type: "world_chunk_rollback"; readonly transaction: BasaltWorldChunkTransaction }
  | { readonly type: "world_chunk_readback"; readonly readback: BasaltWorldReadback }
  | {
      readonly type: "world_chunk_observation";
      readonly observation: BasaltWorldReadbackObservation;
    };

export function assertBasaltWorldReadbackObservation(
  value: unknown,
): BasaltWorldReadbackObservation {
  if (!isRecord(value) || value.kind !== "BasaltWorldReadbackObservation")
    throw new Error("Invalid Basalt world readback observation");
  const observation = value as unknown as BasaltWorldReadbackObservation;
  if (
    observation.abi !== BASALT_WORLD_READBACK_ABI ||
    !isHash(observation.transactionHash) ||
    !isHash(observation.observedRevisionHash) ||
    !isId(observation.chunkId) ||
    !["preflighted", "applied", "committed", "rolled_back"].includes(observation.phase)
  )
    throw new Error("Invalid Basalt world readback observation fields");
  const observedInstanceIds = canonicalIds(observation.observedInstanceIds, "observedInstanceIds");
  if (stableJson(observedInstanceIds) !== stableJson(observation.observedInstanceIds))
    throw new Error("Basalt readback observation IDs must be canonical");
  const observedRoadSegmentIds = canonicalIds(
    observation.observedRoadSegmentIds,
    "observedRoadSegmentIds",
    MAX_WORLD_ROAD_SEGMENTS_PER_CHUNK,
  );
  if (stableJson(observedRoadSegmentIds) !== stableJson(observation.observedRoadSegmentIds))
    throw new Error("Basalt readback observation road IDs must be canonical");
  const observedVoxelSpots = canonicalVoxelSpots(observation.observedVoxelSpots);
  if (stableJson(observedVoxelSpots) !== stableJson(observation.observedVoxelSpots))
    throw new Error("Basalt readback observation voxel spots must be canonical");
  const observedImportFactors = canonicalImportFactors(observation.observedImportFactors);
  if (stableJson(observedImportFactors) !== stableJson(observation.observedImportFactors))
    throw new Error("Basalt readback observation import factors must be canonical");
  return observation;
}

export function createBasaltWorldTransaction(input: {
  readonly manifestHash: Hash;
  readonly worldPlanHash: Hash;
  readonly chunk: Pick<
    BasaltWorldChunkDelta,
    "chunkId" | "worldPlanHash" | "hash" | "transactionId" | "instanceIds" | "roadSegmentIds"
  >;
  readonly phase: BasaltWorldTransactionPhase;
  readonly expectedRevisionHash: Hash;
  readonly payloadHash?: Hash;
}): BasaltWorldChunkTransaction {
  const material = {
    kind: "BasaltWorldChunkTransaction" as const,
    abi: BASALT_WORLD_TRANSACTION_ABI,
    transactionId: input.chunk.transactionId,
    manifestHash: requireHash(input.manifestHash, "manifestHash"),
    worldPlanHash: requireHash(input.worldPlanHash, "worldPlanHash"),
    chunkHash: requireHash(input.chunk.hash, "chunkHash"),
    chunkId: requireId(input.chunk.chunkId, "chunkId"),
    instanceIds: canonicalIds(input.chunk.instanceIds, "instanceIds"),
    roadSegmentIds: canonicalIds(
      input.chunk.roadSegmentIds,
      "roadSegmentIds",
      MAX_WORLD_ROAD_SEGMENTS_PER_CHUNK,
    ),
    phase: input.phase,
    expectedRevisionHash: requireHash(input.expectedRevisionHash, "expectedRevisionHash"),
    payloadHash: requireHash(input.payloadHash ?? input.chunk.hash, "payloadHash"),
  };
  if (input.chunk.worldPlanHash !== input.worldPlanHash)
    throw new Error("Basalt transaction world plan does not match its chunk");
  return { ...material, hash: contentHash(stableJson(material)) };
}

export function createBasaltWorldReadback(input: {
  readonly transaction: BasaltWorldChunkTransaction;
  readonly phase: BasaltWorldReadback["phase"];
  readonly observedRevisionHash: Hash;
  readonly observedInstanceIds: readonly string[];
  readonly observedRoadSegmentIds: readonly string[];
  readonly observedVoxelSpots?: readonly BasaltVoxelSpotObservation[];
  readonly observedImportFactors?: readonly BasaltImportFactorObservation[];
  readonly spotHashes?: readonly BasaltVoxelSpotHash[];
  readonly exportHash?: Hash;
}): BasaltWorldReadback {
  assertBasaltWorldTransaction(input.transaction);
  const observedInstanceIds = canonicalIds(input.observedInstanceIds, "observedInstanceIds");
  const observedRoadSegmentIds = canonicalIds(
    input.observedRoadSegmentIds,
    "observedRoadSegmentIds",
    MAX_WORLD_ROAD_SEGMENTS_PER_CHUNK,
  );
  const observedVoxelSpots = canonicalVoxelSpots(input.observedVoxelSpots ?? []);
  const observedImportFactors = canonicalImportFactors(input.observedImportFactors ?? []);
  const spotHashes = canonicalSpotHashes(input.spotHashes ?? []);
  const material = {
    kind: "BasaltWorldReadback" as const,
    abi: BASALT_WORLD_READBACK_ABI,
    transactionHash: input.transaction.hash,
    chunkId: input.transaction.chunkId,
    phase: input.phase,
    observedRevisionHash: requireHash(input.observedRevisionHash, "observedRevisionHash"),
    observedInstanceIds,
    observedRoadSegmentIds,
    observedVoxelSpots,
    observedImportFactors,
    spotHashes,
    ...(input.exportHash === undefined
      ? {}
      : { exportHash: requireHash(input.exportHash, "exportHash") }),
  };
  return { ...material, hash: contentHash(stableJson(material)) };
}

/**
 * Seal one drift key per observed surface. Occupancy quantizes to u8 steps
 * before hashing so engine quantization noise never flips a sealed key; the
 * encoding is integer-only so the hash is exact across runs.
 */
export function sealVoxelSpotHashes(
  spots: readonly BasaltVoxelSpotObservation[],
): BasaltVoxelSpotHash[] {
  const canonical = canonicalVoxelSpots(spots);
  const bySurface = new Map<string, BasaltVoxelSpotObservation[]>();
  for (const spot of canonical) {
    const group = bySurface.get(spot.surfaceId);
    if (group) group.push(spot);
    else bySurface.set(spot.surfaceId, [spot]);
  }
  const sealed: BasaltVoxelSpotHash[] = [];
  for (const [surfaceId, group] of [...bySurface.entries()].sort(([left], [right]) =>
    left < right ? -1 : 1,
  )) {
    const lines = group.map(
      (spot) =>
        `${spot.x},${spot.y},${spot.z},${Math.round(spot.occupancy * 255)},${spot.material}`,
    );
    sealed.push({ surfaceId, spotHash: contentHash(`${surfaceId}\n${lines.join("\n")}`) });
  }
  return sealed;
}

/** Validates a readback before the next transaction phase can be opened. */
export function reconcileBasaltWorldReadback(
  transactionInput: unknown,
  readbackInput: unknown,
  expectedInstanceIds: readonly string[],
  expectedRoadSegmentIds: readonly string[],
): void {
  const transaction = assertBasaltWorldTransaction(transactionInput);
  const readback = assertBasaltWorldReadback(readbackInput);
  if (readback.transactionHash !== transaction.hash || readback.chunkId !== transaction.chunkId)
    throw new Error("Basalt readback does not bind the exact chunk transaction");
  if (readback.observedRevisionHash !== transaction.expectedRevisionHash)
    throw new Error("Basalt Studio revision changed during chunk transaction");
  const expected = canonicalIds(expectedInstanceIds, "expectedInstanceIds");
  if (stableJson(expected) !== stableJson(readback.observedInstanceIds))
    throw new Error("Basalt Studio readback instance set differs from the chunk delta");
  const expectedRoads = canonicalIds(
    expectedRoadSegmentIds,
    "expectedRoadSegmentIds",
    MAX_WORLD_ROAD_SEGMENTS_PER_CHUNK,
  );
  if (stableJson(expectedRoads) !== stableJson(readback.observedRoadSegmentIds))
    throw new Error("Basalt Studio readback road set differs from the chunk delta");
}

export function assertBasaltWorldTransaction(value: unknown): BasaltWorldChunkTransaction {
  if (!isRecord(value) || value.kind !== "BasaltWorldChunkTransaction")
    throw new Error("Invalid Basalt world transaction");
  const transaction = value as unknown as BasaltWorldChunkTransaction;
  if (
    transaction.abi !== BASALT_WORLD_TRANSACTION_ABI ||
    !isHash(transaction.manifestHash) ||
    !isHash(transaction.worldPlanHash) ||
    !isHash(transaction.chunkHash) ||
    !isHash(transaction.expectedRevisionHash) ||
    !isHash(transaction.payloadHash) ||
    !isHash(transaction.hash) ||
    !isId(transaction.chunkId) ||
    !isId(transaction.transactionId) ||
    !["preflight", "apply", "commit", "rollback"].includes(transaction.phase)
  )
    throw new Error("Invalid Basalt world transaction fields");
  const instanceIds = canonicalIds(transaction.instanceIds, "instanceIds");
  if (stableJson(instanceIds) !== stableJson(transaction.instanceIds))
    throw new Error("Basalt transaction instance IDs must be canonical");
  const roadSegmentIds = canonicalIds(
    transaction.roadSegmentIds,
    "roadSegmentIds",
    MAX_WORLD_ROAD_SEGMENTS_PER_CHUNK,
  );
  if (stableJson(roadSegmentIds) !== stableJson(transaction.roadSegmentIds))
    throw new Error("Basalt transaction road segment IDs must be canonical");
  const { hash, ...material } = transaction;
  if (hash !== contentHash(stableJson(material)))
    throw new Error("Basalt world transaction hash mismatch");
  return transaction;
}

export function assertBasaltWorldReadback(value: unknown): BasaltWorldReadback {
  if (!isRecord(value) || value.kind !== "BasaltWorldReadback")
    throw new Error("Invalid Basalt world readback");
  const readback = value as unknown as BasaltWorldReadback;
  if (
    readback.abi !== BASALT_WORLD_READBACK_ABI ||
    !isHash(readback.transactionHash) ||
    !isHash(readback.observedRevisionHash) ||
    !isHash(readback.hash) ||
    !isId(readback.chunkId) ||
    !["preflighted", "applied", "committed", "rolled_back"].includes(readback.phase)
  )
    throw new Error("Invalid Basalt world readback fields");
  const observedInstanceIds = canonicalIds(readback.observedInstanceIds, "observedInstanceIds");
  if (stableJson(observedInstanceIds) !== stableJson(readback.observedInstanceIds))
    throw new Error("Basalt readback instance IDs must be canonical");
  const observedRoadSegmentIds = canonicalIds(
    readback.observedRoadSegmentIds,
    "observedRoadSegmentIds",
    MAX_WORLD_ROAD_SEGMENTS_PER_CHUNK,
  );
  if (stableJson(observedRoadSegmentIds) !== stableJson(readback.observedRoadSegmentIds))
    throw new Error("Basalt readback road segment IDs must be canonical");
  if (readback.exportHash !== undefined && !isHash(readback.exportHash))
    throw new Error("Basalt readback export hash must be a sha256 hash");
  const observedVoxelSpots = canonicalVoxelSpots(readback.observedVoxelSpots);
  if (stableJson(observedVoxelSpots) !== stableJson(readback.observedVoxelSpots))
    throw new Error("Basalt readback voxel spots must be canonical");
  const observedImportFactors = canonicalImportFactors(readback.observedImportFactors);
  if (stableJson(observedImportFactors) !== stableJson(readback.observedImportFactors))
    throw new Error("Basalt readback import factors must be canonical");
  const spotHashes = canonicalSpotHashes(readback.spotHashes);
  if (stableJson(spotHashes) !== stableJson(readback.spotHashes))
    throw new Error("Basalt readback spot hashes must be canonical");
  const { hash, ...material } = readback;
  if (hash !== contentHash(stableJson(material)))
    throw new Error("Basalt world readback hash mismatch");
  return readback;
}

function canonicalIds(
  values: readonly string[],
  label: string,
  max: number = MAX_WORLD_INSTANCES_PER_CHUNK,
): string[] {
  if (!Array.isArray(values) || values.length > max)
    throw new Error(`Basalt ${label} exceeds its bound`);
  const ids = [...values];
  if (!ids.every(isId) || new Set(ids).size !== ids.length)
    throw new Error(`Basalt ${label} must contain unique IDs`);
  ids.sort();
  return ids;
}

function canonicalVoxelSpots(
  values: readonly BasaltVoxelSpotObservation[],
): BasaltVoxelSpotObservation[] {
  if (!Array.isArray(values) || values.length > MAX_WORLD_READBACK_VOXEL_SPOTS)
    throw new Error("Basalt observedVoxelSpots exceeds its bound");
  const spots = values.map((spot) => {
    if (
      !isRecord(spot) ||
      !isId(spot.surfaceId) ||
      !Number.isSafeInteger(spot.x) ||
      (spot.x as number) < 0 ||
      !Number.isSafeInteger(spot.y) ||
      (spot.y as number) < 0 ||
      !Number.isSafeInteger(spot.z) ||
      (spot.z as number) < 0 ||
      typeof spot.occupancy !== "number" ||
      !Number.isFinite(spot.occupancy) ||
      (spot.occupancy as number) < 0 ||
      (spot.occupancy as number) > 1 ||
      typeof spot.material !== "string" ||
      (spot.material as string).length === 0 ||
      (spot.material as string).length > 128
    )
      throw new Error("Basalt observedVoxelSpots carries an invalid spot");
    return {
      surfaceId: spot.surfaceId as string,
      x: spot.x as number,
      y: spot.y as number,
      z: spot.z as number,
      occupancy: spot.occupancy as number,
      material: spot.material as string,
    };
  });
  const keys = spots.map((spot) => `${spot.surfaceId} ${spot.x} ${spot.y} ${spot.z}`);
  if (new Set(keys).size !== keys.length)
    throw new Error("Basalt observedVoxelSpots repeats a surface cell");
  spots.sort((left, right) => {
    if (left.surfaceId !== right.surfaceId) return left.surfaceId < right.surfaceId ? -1 : 1;
    if (left.x !== right.x) return left.x - right.x;
    if (left.y !== right.y) return left.y - right.y;
    return left.z - right.z;
  });
  return spots;
}

function canonicalImportFactors(
  values: readonly BasaltImportFactorObservation[],
): BasaltImportFactorObservation[] {
  if (!Array.isArray(values) || values.length > MAX_WORLD_READBACK_IMPORT_FACTORS)
    throw new Error("Basalt observedImportFactors exceeds its bound");
  const factors = values.map((entry) => {
    if (
      !isRecord(entry) ||
      !isHash(entry.contentHash) ||
      typeof entry.factor !== "number" ||
      !Number.isFinite(entry.factor) ||
      (entry.factor as number) <= 0
    )
      throw new Error("Basalt observedImportFactors carries an invalid factor");
    return { contentHash: entry.contentHash as Hash, factor: entry.factor as number };
  });
  if (new Set(factors.map((entry) => entry.contentHash)).size !== factors.length)
    throw new Error("Basalt observedImportFactors repeats a content hash");
  factors.sort((left, right) => (left.contentHash < right.contentHash ? -1 : 1));
  return factors;
}

function canonicalSpotHashes(values: readonly BasaltVoxelSpotHash[]): BasaltVoxelSpotHash[] {
  if (!Array.isArray(values) || values.length > MAX_WORLD_CHUNKS_PER_MANIFEST)
    throw new Error("Basalt spotHashes exceeds its bound");
  const hashes = values.map((entry) => {
    if (!isRecord(entry) || !isId(entry.surfaceId) || !isHash(entry.spotHash))
      throw new Error("Basalt spotHashes carries an invalid entry");
    return { surfaceId: entry.surfaceId as string, spotHash: entry.spotHash as Hash };
  });
  if (new Set(hashes.map((entry) => entry.surfaceId)).size !== hashes.length)
    throw new Error("Basalt spotHashes repeats a surface");
  hashes.sort((left, right) => (left.surfaceId < right.surfaceId ? -1 : 1));
  return hashes;
}

function requireHash(value: string, label: string): string {
  if (!isHash(value)) throw new Error(`Basalt ${label} must be a sha256 hash`);
  return value;
}

function requireId(value: string, label: string): string {
  if (!isId(value)) throw new Error(`Basalt ${label} is invalid`);
  return value;
}

function isHash(value: unknown): value is Hash {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,255}$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
