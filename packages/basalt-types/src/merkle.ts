import { contentHash, stableJson } from "../../contracts/src/index.js";
import { handleCore, sanitizeFamilyHandle } from "./taxonomy.js";

const HASH_PATTERN = /^[a-f0-9]{64}$/u;

function requireHash(value: string, label: string): string {
  if (!HASH_PATTERN.test(value)) throw new Error(`${label} must be a lowercase SHA-256 hash`);
  return value;
}

function hashLeaf(value: unknown): string {
  return contentHash(stableJson(value));
}

/**
 * Computes the five-leaf family root. Each input is first reduced to one
 * canonical SHA-256 leaf, then the ordered leaf array is hashed as canonical
 * JSON. This is the Basalt Merkle binding; it is intentionally not a binary
 * tree so every implementation can reproduce it without implicit padding.
 */
export function computeFamilyMerkleRoot(input: {
  readonly handle: string;
  readonly geometryHashes: readonly string[];
  readonly materialTrimHash: string;
  readonly physicsCompanionHash: string;
  readonly socketGrammarHash?: string;
}): string {
  const geometryHashes = [...input.geometryHashes].sort();
  if (geometryHashes.length === 0)
    throw new Error("Family geometry must contain at least one hash");
  geometryHashes.forEach((value) => requireHash(value, "geometry hash"));
  const leaves = [
    hashLeaf(handleCore(input.handle)),
    hashLeaf(geometryHashes),
    requireHash(input.materialTrimHash, "material trim hash"),
    requireHash(input.physicsCompanionHash, "physics companion hash"),
    input.socketGrammarHash
      ? requireHash(input.socketGrammarHash, "socket grammar hash")
      : hashLeaf("no_sockets"),
  ];
  return contentHash(stableJson(leaves));
}

export function computeFamilyMerkleId(input: {
  readonly handle: string;
  readonly geometryHashes: readonly string[];
  readonly materialTrimHash: string;
  readonly physicsCompanionHash: string;
  readonly socketGrammarHash?: string;
}): string {
  const root = computeFamilyMerkleRoot(input);
  return `family_${sanitizeFamilyHandle(handleCore(input.handle))}_${root.slice(0, 12)}`;
}
