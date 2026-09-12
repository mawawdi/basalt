import { contentHash, stableJson } from "../../contracts/src/index.js";
import type { RoadAssembly, RoadSegment } from "../../world-planning/src/roads.js";
import type { BasaltWorldFoundation } from "./index.js";
import { worldEntityId, worldHash, compareWorldStrings } from "./primitives.js";
import type { WorldPopulationArtifact } from "./contracts.js";
import type { ChunkedRoomContent } from "./rooms.js";

/** One bounded write unit handed to the Studio connector. */
export interface BasaltWorldChunkDelta {
  readonly kind: "BasaltWorldChunkDelta";
  readonly id: string;
  readonly chunkId: string;
  readonly worldPlanHash: string;
  readonly populationHash: string;
  readonly surfaceIds: readonly string[];
  readonly instanceIds: readonly string[];
  readonly roadSegmentIds: readonly string[];
  readonly stairIds: readonly string[];
  readonly portalIds: readonly string[];
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
  roads: readonly RoadAssembly[] = [],
  rooms: ChunkedRoomContent = { stairs: [], portals: [] },
): BasaltWorldEmissionManifest {
  if (!Number.isFinite(chunkSize) || chunkSize <= 0) throw new Error("Chunk size must be positive");
  if (population.worldPlanHash !== foundation.worldPlanHash)
    throw new Error("Population artifact belongs to a different world plan");
  for (const road of roads) {
    if (!foundation.routeIds.includes(road.routeId))
      throw new Error(`Road assembly belongs to a different world plan: ${road.routeId}`);
    if (!foundation.worldPlan.surfaces.has(road.surfaceId))
      throw new Error(`Road assembly references an unknown surface: ${road.surfaceId}`);
  }
  const records = new Map<
    string,
    {
      instances: WorldPopulationArtifact["chunks"][number]["instances"];
      roadSegments: RoadSegment[];
      stairs: ChunkedRoomContent["stairs"][number][];
      portals: ChunkedRoomContent["portals"][number][];
    }
  >();
  const blankRecord = () =>
    ({ instances: [], roadSegments: [], stairs: [], portals: [] }) as {
      instances: WorldPopulationArtifact["chunks"][number]["instances"];
      roadSegments: RoadSegment[];
      stairs: ChunkedRoomContent["stairs"][number][];
      portals: ChunkedRoomContent["portals"][number][];
    };
  for (const chunk of population.chunks)
    records.set(chunk.chunkId, {
      instances: [...chunk.instances],
      roadSegments: [],
      stairs: [],
      portals: [],
    });
  for (const road of roads)
    for (const segment of road.segments) {
      const record = records.get(segment.chunkId) ?? blankRecord();
      record.roadSegments.push(segment);
      records.set(segment.chunkId, record);
    }
  for (const stair of rooms.stairs) {
    const record = records.get(stair.chunkId) ?? blankRecord();
    record.stairs.push(stair);
    records.set(stair.chunkId, record);
  }
  for (const portal of rooms.portals) {
    const record = records.get(portal.chunkId) ?? blankRecord();
    record.portals.push(portal);
    records.set(portal.chunkId, record);
  }
  const chunks = [...records.entries()]
    .map(([chunkId, record]) => {
      const instances = [...record.instances].sort((a, b) => compareWorldStrings(a.id, b.id));
      const roadSegmentIds = record.roadSegments
        .map((segment) => segment.id)
        .sort(compareWorldStrings);
      const stairIds = record.stairs.map((stair) => stair.id).sort(compareWorldStrings);
      const portalIds = record.portals.map((portal) => portal.id).sort(compareWorldStrings);
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
      for (const segment of record.roadSegments) {
        minimum.x = Math.min(minimum.x, segment.bounds.minimum.x);
        minimum.y = Math.min(minimum.y, segment.bounds.minimum.y);
        minimum.z = Math.min(minimum.z, segment.bounds.minimum.z);
        maximum.x = Math.max(maximum.x, segment.bounds.maximum.x);
        maximum.y = Math.max(maximum.y, segment.bounds.maximum.y);
        maximum.z = Math.max(maximum.z, segment.bounds.maximum.z);
      }
      for (const stair of record.stairs) {
        minimum.x = Math.min(minimum.x, stair.bounds.minimum.x);
        minimum.y = Math.min(minimum.y, stair.bounds.minimum.y);
        minimum.z = Math.min(minimum.z, stair.bounds.minimum.z);
        maximum.x = Math.max(maximum.x, stair.bounds.maximum.x);
        maximum.y = Math.max(maximum.y, stair.bounds.maximum.y);
        maximum.z = Math.max(maximum.z, stair.bounds.maximum.z);
      }
      for (const portal of record.portals) {
        minimum.x = Math.min(minimum.x, portal.portal.position.x);
        minimum.y = Math.min(minimum.y, portal.portal.position.y);
        minimum.z = Math.min(minimum.z, portal.portal.position.z);
        maximum.x = Math.max(maximum.x, portal.portal.position.x);
        maximum.y = Math.max(maximum.y, portal.portal.position.y);
        maximum.z = Math.max(maximum.z, portal.portal.position.z);
      }
      if (
        instances.length === 0 &&
        record.roadSegments.length === 0 &&
        record.stairs.length === 0 &&
        record.portals.length === 0
      ) {
        const [xText, zText] = chunkId.replace(/^chunk_/, "").split("_");
        const x = Number(xText) * chunkSize;
        const z = Number(zText) * chunkSize;
        minimum.x = x;
        maximum.x = x + chunkSize;
        minimum.y = 0;
        maximum.y = 0;
        minimum.z = z;
        maximum.z = z + chunkSize;
      }
      // Surfaces follow the chunk tile, never the content bounds: a sparse
      // chunk must still write every surface its tile touches, or terrain
      // silently never lowers. Shared edge surfaces stay idempotent through
      // the marker skip path.
      const [tileXText, tileZText] = chunkId.replace(/^chunk_/, "").split("_");
      const tileMinimum = {
        x: Number(tileXText) * chunkSize,
        z: Number(tileZText) * chunkSize,
      };
      const tileMaximum = {
        x: Number(tileXText) * chunkSize + chunkSize,
        z: Number(tileZText) * chunkSize + chunkSize,
      };
      const surfaceIds = foundation.worldPlan.surfaces
        .ids()
        .filter((surfaceId) =>
          intersects(
            foundation.worldPlan.surfaces.coordinateBounds(surfaceId),
            tileMinimum,
            tileMaximum,
          ),
        )
        .sort(compareWorldStrings);
      const material = {
        kind: "BasaltWorldChunkDelta" as const,
        chunkId,
        worldPlanHash: foundation.worldPlanHash,
        populationHash: population.hash,
        surfaceIds,
        instanceIds: instances.map((instance) => instance.id),
        roadSegmentIds,
        stairIds,
        portalIds,
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
