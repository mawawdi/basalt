import { contentHash, stableJson, type Hash } from "../../contracts/src/index.js";

/** The only Studio protocol Basalt exposes: bounded world-chunk delivery. */
export const BASALT_STUDIO_PROTOCOL_ABI = "basalt-studio-protocol@1" as const;
export const BASALT_WORLD_TRANSACTION_ABI = "basalt-world-transaction@1" as const;
export const BASALT_WORLD_READBACK_ABI = "basalt-world-readback@1" as const;
export const MAX_WORLD_CHUNKS_PER_MANIFEST = 4096 as const;
export const MAX_WORLD_INSTANCES_PER_CHUNK = 65_536 as const;
export const MAX_WORLD_ROAD_SEGMENTS_PER_CHUNK = 16_384 as const;

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

export interface BasaltWorldReadback {
  readonly kind: "BasaltWorldReadback";
  readonly abi: typeof BASALT_WORLD_READBACK_ABI;
  readonly transactionHash: Hash;
  readonly chunkId: string;
  readonly phase: "preflighted" | "applied" | "committed" | "rolled_back";
  readonly observedRevisionHash: Hash;
  readonly observedInstanceIds: readonly string[];
  readonly observedRoadSegmentIds: readonly string[];
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
}): BasaltWorldReadback {
  assertBasaltWorldTransaction(input.transaction);
  const observedInstanceIds = canonicalIds(input.observedInstanceIds, "observedInstanceIds");
  const observedRoadSegmentIds = canonicalIds(
    input.observedRoadSegmentIds,
    "observedRoadSegmentIds",
    MAX_WORLD_ROAD_SEGMENTS_PER_CHUNK,
  );
  const material = {
    kind: "BasaltWorldReadback" as const,
    abi: BASALT_WORLD_READBACK_ABI,
    transactionHash: input.transaction.hash,
    chunkId: input.transaction.chunkId,
    phase: input.phase,
    observedRevisionHash: requireHash(input.observedRevisionHash, "observedRevisionHash"),
    observedInstanceIds,
    observedRoadSegmentIds,
  };
  return { ...material, hash: contentHash(stableJson(material)) };
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
