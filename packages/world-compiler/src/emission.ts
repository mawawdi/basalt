import { contentHash, stableJson } from "../../contracts/src/index.js";
import type { BasaltWorldFoundation } from "./index.js";
import { worldEntityId, worldHash, compareWorldStrings } from "./primitives.js";
import type { WorldPopulationArtifact } from "./contracts.js";

/** One bounded write unit handed to the Studio connector. */
export interface BasaltWorldChunkDelta {
  readonly kind: "BasaltWorldChunkDelta";
  readonly id: string;
  readonly chunkId: string;
  readonly worldPlanHash: string;
  readonly populationHash: string;
  readonly surfaceIds: readonly string[];
  readonly instanceIds: readonly string[];
  readonly bounds: {
    readonly minimum: { readonly x: number; readonly y: number; readonly z: number };
    readonly maximum: { readonly x: number; readonly y: number; readonly z: number };
  };
  readonly transactionId: string;
  readonly hash: string;
}

export interface BasaltWorldEmissionManifest {
  readonly kind: "BasaltWorldEmissionManifest";
  readonly abi: "basalt-world-emission@1";
  readonly worldPlanHash: string;
  readonly populationHash: string;
  readonly chunks: readonly BasaltWorldChunkDelta[];
  readonly hash: string;
}

/**
 * Lower the immutable world and population artifacts into bounded, ordered
 * connector deltas. No Studio call happens here; the connector owns writes,
 * ChangeHistory boundaries, preflight, and reconciliation.
 */
export function createBasaltWorldEmission(
  foundation: BasaltWorldFoundation,
  population: WorldPopulationArtifact,
  chunkSize = 128,
): BasaltWorldEmissionManifest {
  if (!Number.isFinite(chunkSize) || chunkSize <= 0) throw new Error("Chunk size must be positive");
  if (population.worldPlanHash !== foundation.worldPlanHash)
    throw new Error("Population artifact belongs to a different world plan");
  const chunks = population.chunks
    .map((chunk) => {
      const instances = [...chunk.instances].sort((a, b) => compareWorldStrings(a.id, b.id));
      const minimum = {
        x: Number.POSITIVE_INFINITY,
        y: Number.POSITIVE_INFINITY,
        z: Number.POSITIVE_INFINITY,
      };
      const maximum = {
        x: Number.NEGATIVE_INFINITY,
        y: Number.NEGATIVE_INFINITY,
        z: Number.NEGATIVE_INFINITY,
      };
      for (const instance of instances) {
        minimum.x = Math.min(minimum.x, instance.position.x);
        minimum.y = Math.min(minimum.y, instance.position.y);
        minimum.z = Math.min(minimum.z, instance.position.z);
        maximum.x = Math.max(maximum.x, instance.position.x);
        maximum.y = Math.max(maximum.y, instance.position.y);
        maximum.z = Math.max(maximum.z, instance.position.z);
      }
      if (instances.length === 0) {
        const [xText, zText] = chunk.chunkId.replace(/^chunk_/, "").split("_");
        const x = Number(xText) * chunkSize;
        const z = Number(zText) * chunkSize;
        minimum.x = x;
        maximum.x = x + chunkSize;
        minimum.y = 0;
        maximum.y = 0;
        minimum.z = z;
        maximum.z = z + chunkSize;
      }
      const surfaceIds = foundation.worldPlan.surfaces
        .ids()
        .filter((surfaceId) =>
          intersects(foundation.worldPlan.surfaces.coordinateBounds(surfaceId), minimum, maximum),
        )
        .sort(compareWorldStrings);
      const material = {
        kind: "BasaltWorldChunkDelta" as const,
        chunkId: chunk.chunkId,
        worldPlanHash: foundation.worldPlanHash,
        populationHash: population.hash,
        surfaceIds,
        instanceIds: instances.map((instance) => instance.id),
        bounds: { minimum, maximum },
      };
      const hash = contentHash(stableJson(material));
      return {
        ...material,
        id: worldEntityId.parse(`basalt_chunk_${hash.slice(0, 24)}`),
        transactionId: `basalt_tx_${hash.slice(0, 32)}`,
        hash,
      };
    })
    .sort((a, b) => compareWorldStrings(a.chunkId, b.chunkId));
  const material = {
    kind: "BasaltWorldEmissionManifest" as const,
    abi: "basalt-world-emission@1" as const,
    worldPlanHash: worldHash.parse(foundation.worldPlanHash),
    populationHash: worldHash.parse(population.hash),
    chunks,
  };
  return { ...material, hash: contentHash(stableJson(material)) };
}

function intersects(
  bounds: {
    readonly u: { readonly minimum: number; readonly maximum: number };
    readonly v: { readonly minimum: number; readonly maximum: number };
  },
  minimum: { readonly x: number; readonly z: number },
  maximum: { readonly x: number; readonly z: number },
): boolean {
  return (
    bounds.u.maximum >= minimum.x &&
    bounds.u.minimum <= maximum.x &&
    bounds.v.maximum >= minimum.z &&
    bounds.v.minimum <= maximum.z
  );
}
