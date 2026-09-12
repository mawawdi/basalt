import { createMurmurHash3Random } from "../../spatial-core/src/primitives.js";
import { dequantizeQ32_32 } from "../../basalt-types/src/fixed.js";
import {
  sealAssemblyRecipe,
  type AssemblyRecipe,
  type ModularKitRequirement,
} from "../../asset-factory/src/index.js";
import {
  jointsMateFrames,
  rotateY90Steps,
  type JointFrame,
  type JointTolerances,
} from "../../catalog-intelligence/src/index.js";
import { WORLD_POPULATION_INSTANCE_SCHEMA, type WorldPopulationInstance } from "./contracts.js";
import { compareWorldStrings } from "./primitives.js";
import { solveWfc } from "./wfc.js";

/**
 * Lot assemblies from kit specs: a seeded anchor choice, greedy stacked
 * floors, and a WFC insert fill over the open sockets. Anchor and floor
 * selection are seeded weighted choice (footprint area fills lots); only
 * the insert fill runs collapse, because only inserts constrain each
 * other (volume exclusion between neighbors). Placements derive from
 * measured socket geometry — face-center coincidence under Y
 * quarter-turns — and every placement re-verifies mating, volumes, and
 * lot containment before the recipe seals.
 *
 * Deliberate v1 limits, all honest to the evidence: single centered
 * anchor per lot (no compounds); no procedural roof (open tops unless
 * kit rules cap them); no below-ground or soffit inserts; doors and
 * windows protrude from facades (the data carries no opening/recess
 * evidence for flush mounting).
 */

export interface AssemblyLot {
  readonly lotId: string;
  readonly minX: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxZ: number;
  readonly groundHeightStuds: number;
}

export interface AssembleLotOptions {
  readonly seed: number;
  readonly maxFloors?: number;
  readonly maxProtrusionStuds?: number;
  readonly emptyWeight?: number;
  readonly maxRestarts?: number;
}

export const DEFAULT_ASSEMBLY_MAX_FLOORS = 2;
export const DEFAULT_ASSEMBLY_MAX_PROTRUSION_STUDS = 4;
export const DEFAULT_ASSEMBLY_EMPTY_WEIGHT = 4;
/** Ground-contact stability cone: downward sockets face within ~26 degrees of straight down. */
export const ASSEMBLY_GROUND_NORMAL_Y = -0.9;
/** Stack contact cone: slab sockets face within ~26 degrees of straight up. */
export const ASSEMBLY_STACK_NORMAL_Y = 0.9;
/** Sockets facing further down than this never take inserts (no soffits v1). */
export const ASSEMBLY_INSERT_MIN_UP_Y = -0.5;
/** Inserts may embed this far below grade (thresholds); deeper is burial. */
export const ASSEMBLY_MAX_EMBED_STUDS = 0.5;

export class AssemblyContradictionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssemblyContradictionError";
  }
}

interface Vector3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

interface ArchetypePlacement {
  readonly frames: ReadonlyArray<JointFrame>;
  readonly boundsMin: Vector3;
  readonly boundsMax: Vector3;
  readonly footprintArea: number;
}

interface PlacedPiece {
  readonly archetypeIndex: number;
  readonly rotationSteps: number;
  readonly position: Vector3;
  readonly boundsMin: Vector3;
  readonly boundsMax: Vector3;
  readonly usedSockets: ReadonlySet<number>;
  readonly attachSocket: number | null;
}

function archetypePlacement(
  kit: ModularKitRequirement,
  archetypeIndex: number,
): ArchetypePlacement {
  const archetype = kit.archetypes[archetypeIndex]!;
  const frames = archetype.sockets.map((socket) => ({
    normal: {
      x: dequantizeQ32_32(socket.normal.x),
      y: dequantizeQ32_32(socket.normal.y),
      z: dequantizeQ32_32(socket.normal.z),
    },
    origin: {
      x: dequantizeQ32_32(socket.localOrigin.x),
      y: dequantizeQ32_32(socket.localOrigin.y),
      z: dequantizeQ32_32(socket.localOrigin.z),
    },
    radius: dequantizeQ32_32(socket.boundaryRadius),
  }));
  const [sizeX, sizeY, sizeZ] = archetype.boundingEnvelope;
  const [centerX, centerY, centerZ] = archetype.boundsCenterStuds;
  const boundsMin = { x: centerX - sizeX / 2, y: centerY - sizeY / 2, z: centerZ - sizeZ / 2 };
  const boundsMax = { x: centerX + sizeX / 2, y: centerY + sizeY / 2, z: centerZ + sizeZ / 2 };
  return { frames, boundsMin, boundsMax, footprintArea: sizeX * sizeZ };
}

function worldBounds(
  placement: ArchetypePlacement,
  rotationSteps: number,
  position: Vector3,
): { minimum: Vector3; maximum: Vector3 } {
  const corners = [
    { x: placement.boundsMin.x, y: placement.boundsMin.y, z: placement.boundsMin.z },
    { x: placement.boundsMax.x, y: placement.boundsMin.y, z: placement.boundsMin.z },
    { x: placement.boundsMin.x, y: placement.boundsMax.y, z: placement.boundsMin.z },
    { x: placement.boundsMax.x, y: placement.boundsMax.y, z: placement.boundsMax.z },
    { x: placement.boundsMin.x, y: placement.boundsMin.y, z: placement.boundsMax.z },
    { x: placement.boundsMax.x, y: placement.boundsMin.y, z: placement.boundsMax.z },
    { x: placement.boundsMin.x, y: placement.boundsMax.y, z: placement.boundsMax.z },
    { x: placement.boundsMax.x, y: placement.boundsMax.y, z: placement.boundsMax.z },
  ].map((corner) => {
    const rotated = rotateY90Steps(corner, rotationSteps);
    return { x: rotated.x + position.x, y: rotated.y + position.y, z: rotated.z + position.z };
  });
  return {
    minimum: {
      x: Math.min(...corners.map((corner) => corner.x)),
      y: Math.min(...corners.map((corner) => corner.y)),
      z: Math.min(...corners.map((corner) => corner.z)),
    },
    maximum: {
      x: Math.max(...corners.map((corner) => corner.x)),
      y: Math.max(...corners.map((corner) => corner.y)),
      z: Math.max(...corners.map((corner) => corner.z)),
    },
  };
}

function worldFrame(frame: JointFrame, rotationSteps: number, position: Vector3): JointFrame {
  const normal = rotateY90Steps(frame.normal, rotationSteps);
  const origin = rotateY90Steps(frame.origin, rotationSteps);
  return {
    normal,
    origin: { x: origin.x + position.x, y: origin.y + position.y, z: origin.z + position.z },
    radius: frame.radius,
  };
}

const VOLUME_EPSILON = 1e-9;

function volumesDisjoint(aMin: Vector3, aMax: Vector3, bMin: Vector3, bMax: Vector3): boolean {
  return (
    bMin.x >= aMax.x - VOLUME_EPSILON ||
    aMin.x >= bMax.x - VOLUME_EPSILON ||
    bMin.y >= aMax.y - VOLUME_EPSILON ||
    aMin.y >= bMax.y - VOLUME_EPSILON ||
    bMin.z >= aMax.z - VOLUME_EPSILON ||
    aMin.z >= bMax.z - VOLUME_EPSILON
  );
}

function pickWeighted<T>(
  rng: () => number,
  candidates: ReadonlyArray<{ value: T; weight: number }>,
): T {
  const total = candidates.reduce((sum, candidate) => sum + candidate.weight, 0);
  let draw = rng() * total;
  let picked = candidates[candidates.length - 1]!.value;
  for (const candidate of candidates) {
    draw -= candidate.weight;
    if (draw <= 0) {
      picked = candidate.value;
      break;
    }
  }
  return picked;
}

interface AssemblyModel {
  readonly kit: ModularKitRequirement;
  readonly placements: ReadonlyArray<ArchetypePlacement>;
  readonly tolerances: JointTolerances;
  /** Mating facts keyed both orders: "ai|si>aj|sj". */
  readonly rules: ReadonlyMap<string, number>;
}

function ruleKey(aIndex: number, aSocket: number, bIndex: number, bSocket: number): string {
  return `${aIndex}|${aSocket}>${bIndex}|${bSocket}`;
}

function prepareAssemblyModel(kit: ModularKitRequirement): AssemblyModel {
  const ids = new Map(kit.archetypes.map((archetype, index) => [archetype.archetypeId, index]));
  const rules = new Map<string, number>();
  for (const rule of kit.adjacencyRules) {
    const aIndex = ids.get(rule.sourceArchetypeId);
    const bIndex = ids.get(rule.targetArchetypeId);
    if (aIndex === undefined || bIndex === undefined)
      throw new Error(`Kit ${kit.kitId} rule references an unknown archetype`);
    const aSockets = kit.archetypes[aIndex]!.sockets;
    const bSockets = kit.archetypes[bIndex]!.sockets;
    const aSocket = aSockets.findIndex((socket) => socket.socketId === rule.sourceSocketId);
    const bSocket = bSockets.findIndex((socket) => socket.socketId === rule.targetSocketId);
    if (aSocket < 0 || bSocket < 0)
      throw new Error(`Kit ${kit.kitId} rule references an unknown socket`);
    for (const key of [
      ruleKey(aIndex, aSocket, bIndex, bSocket),
      ruleKey(bIndex, bSocket, aIndex, aSocket),
    ]) {
      const prior = rules.get(key);
      if (prior === undefined || prior < rule.probabilityWeight)
        rules.set(key, rule.probabilityWeight);
    }
  }
  return {
    kit,
    placements: kit.archetypes.map((_, index) => archetypePlacement(kit, index)),
    tolerances: {
      support: kit.tolerances.socketMismatchThreshold,
      penetration: kit.tolerances.maxMeshInterpenetration,
      clearance: kit.tolerances.socketMismatchThreshold,
    },
    rules,
  };
}

interface AnchorCandidate {
  readonly archetypeIndex: number;
  readonly rotationSteps: number;
  readonly position: Vector3;
}

function anchorCandidates(
  model: AssemblyModel,
  lot: AssemblyLot,
): { candidates: AnchorCandidate[]; smallestFootprint: number } {
  const lotWidth = lot.maxX - lot.minX;
  const lotDepth = lot.maxZ - lot.minZ;
  const centerX = (lot.minX + lot.maxX) / 2;
  const centerZ = (lot.minZ + lot.maxZ) / 2;
  const candidates: AnchorCandidate[] = [];
  let smallestFootprint = Number.POSITIVE_INFINITY;
  model.placements.forEach((placement, archetypeIndex) => {
    if (!placement.frames.some((frame) => frame.normal.y <= ASSEMBLY_GROUND_NORMAL_Y)) return;
    const sizeX = placement.boundsMax.x - placement.boundsMin.x;
    const sizeZ = placement.boundsMax.z - placement.boundsMin.z;
    smallestFootprint = Math.min(smallestFootprint, Math.min(sizeX, sizeZ));
    for (let rotationSteps = 0; rotationSteps < 4; rotationSteps += 1) {
      const width = rotationSteps % 2 === 0 ? sizeX : sizeZ;
      const depth = rotationSteps % 2 === 0 ? sizeZ : sizeX;
      if (width > lotWidth + VOLUME_EPSILON || depth > lotDepth + VOLUME_EPSILON) continue;
      const rotatedMin = rotateY90Steps(placement.boundsMin, rotationSteps);
      const rotatedMax = rotateY90Steps(placement.boundsMax, rotationSteps);
      const minY = Math.min(rotatedMin.y, rotatedMax.y);
      candidates.push({
        archetypeIndex,
        rotationSteps,
        position: { x: centerX, y: lot.groundHeightStuds - minY, z: centerZ },
      });
    }
  });
  return { candidates, smallestFootprint };
}

interface StackCandidate extends AnchorCandidate {
  readonly lowerSocket: number;
  readonly upperSocket: number;
}

function stackCandidates(
  model: AssemblyModel,
  lower: PlacedPiece,
  lowerPlacement: ArchetypePlacement,
): StackCandidate[] {
  const candidates: StackCandidate[] = [];
  const lowerMinX = lower.boundsMin.x;
  const lowerMaxX = lower.boundsMax.x;
  const lowerMinZ = lower.boundsMin.z;
  const lowerMaxZ = lower.boundsMax.z;
  lowerPlacement.frames.forEach((lowerFrame, lowerSocket) => {
    if (lower.usedSockets.has(lowerSocket)) return;
    if (lowerFrame.normal.y < ASSEMBLY_STACK_NORMAL_Y) return;
    const lowerWorld = worldFrame(lowerFrame, lower.rotationSteps, lower.position);
    model.placements.forEach((upperPlacement, archetypeIndex) => {
      upperPlacement.frames.forEach((upperFrame, upperSocket) => {
        if (upperFrame.normal.y > ASSEMBLY_GROUND_NORMAL_Y) return;
        const rule = model.rules.get(
          ruleKey(lower.archetypeIndex, lowerSocket, archetypeIndex, upperSocket),
        );
        if (rule === undefined) return;
        for (let rotationSteps = 0; rotationSteps < 4; rotationSteps += 1) {
          const rotatedOrigin = rotateY90Steps(upperFrame.origin, rotationSteps);
          const position = {
            x: lowerWorld.origin.x - rotatedOrigin.x,
            y: lowerWorld.origin.y - rotatedOrigin.y,
            z: lowerWorld.origin.z - rotatedOrigin.z,
          };
          const world = worldBounds(upperPlacement, rotationSteps, position);
          if (
            world.minimum.x < lowerMinX - VOLUME_EPSILON ||
            world.maximum.x > lowerMaxX + VOLUME_EPSILON ||
            world.minimum.z < lowerMinZ - VOLUME_EPSILON ||
            world.maximum.z > lowerMaxZ + VOLUME_EPSILON
          )
            continue;
          const upperWorld = worldFrame(upperFrame, rotationSteps, position);
          if (!jointsMateFrames(lowerWorld, upperWorld, model.tolerances).mates) continue;
          candidates.push({ archetypeIndex, rotationSteps, position, lowerSocket, upperSocket });
        }
      });
    });
  });
  return candidates;
}

function placePiece(
  model: AssemblyModel,
  archetypeIndex: number,
  rotationSteps: number,
  position: Vector3,
  usedSockets: ReadonlySet<number>,
  attachSocket: number | null,
): PlacedPiece {
  const world = worldBounds(model.placements[archetypeIndex]!, rotationSteps, position);
  return {
    archetypeIndex,
    rotationSteps,
    position,
    boundsMin: world.minimum,
    boundsMax: world.maximum,
    usedSockets,
    attachSocket,
  };
}

interface InsertCell {
  readonly id: string;
  readonly pieceIndex: number;
  readonly socketIndex: number;
}

interface InsertTile {
  readonly id: string;
  readonly archetypeIndex: number;
  readonly rotationSteps: number;
  readonly socketIndex: number;
  readonly weight: number;
}

function insertTilesFor(
  model: AssemblyModel,
  cellPiece: PlacedPiece,
  cellSocket: number,
  lot: AssemblyLot,
  placed: ReadonlyArray<PlacedPiece>,
  maxProtrusionStuds: number,
): { tiles: InsertTile[]; reach: number } {
  const placement = model.placements[cellPiece.archetypeIndex]!;
  const cellWorld = worldFrame(
    placement.frames[cellSocket]!,
    cellPiece.rotationSteps,
    cellPiece.position,
  );
  const tiles: InsertTile[] = [];
  let reach = 0;
  model.placements.forEach((insertPlacement, archetypeIndex) => {
    insertPlacement.frames.forEach((insertFrame, socketIndex) => {
      const weight = model.rules.get(
        ruleKey(cellPiece.archetypeIndex, cellSocket, archetypeIndex, socketIndex),
      );
      if (weight === undefined) return;
      for (let rotationSteps = 0; rotationSteps < 4; rotationSteps += 1) {
        const rotatedOrigin = rotateY90Steps(insertFrame.origin, rotationSteps);
        const position = {
          x: cellWorld.origin.x - rotatedOrigin.x,
          y: cellWorld.origin.y - rotatedOrigin.y,
          z: cellWorld.origin.z - rotatedOrigin.z,
        };
        const world = worldBounds(insertPlacement, rotationSteps, position);
        if (world.minimum.y < lot.groundHeightStuds - ASSEMBLY_MAX_EMBED_STUDS - VOLUME_EPSILON)
          continue;
        if (
          world.minimum.x < lot.minX - maxProtrusionStuds - VOLUME_EPSILON ||
          world.maximum.x > lot.maxX + maxProtrusionStuds + VOLUME_EPSILON ||
          world.minimum.z < lot.minZ - maxProtrusionStuds - VOLUME_EPSILON ||
          world.maximum.z > lot.maxZ + maxProtrusionStuds + VOLUME_EPSILON
        )
          continue;
        const insertWorld = worldFrame(insertFrame, rotationSteps, position);
        if (!jointsMateFrames(cellWorld, insertWorld, model.tolerances).mates) continue;
        if (
          !placed.every((piece) =>
            volumesDisjoint(piece.boundsMin, piece.boundsMax, world.minimum, world.maximum),
          )
        )
          continue;
        tiles.push({
          id: `${model.kit.archetypes[archetypeIndex]!.archetypeId}:${rotationSteps}:${socketIndex}`,
          archetypeIndex,
          rotationSteps,
          socketIndex,
          weight,
        });
        const sizeX = insertPlacement.boundsMax.x - insertPlacement.boundsMin.x;
        const sizeY = insertPlacement.boundsMax.y - insertPlacement.boundsMin.y;
        const sizeZ = insertPlacement.boundsMax.z - insertPlacement.boundsMin.z;
        reach = Math.max(reach, Math.sqrt(sizeX * sizeX + sizeY * sizeY + sizeZ * sizeZ) / 2);
      }
    });
  });
  tiles.sort((left, right) => compareWorldStrings(left.id, right.id));
  return { tiles, reach };
}

const EMPTY_INSERT_TILE = "empty";

function insertPlacement(
  model: AssemblyModel,
  cellPiece: PlacedPiece,
  cellSocket: number,
  tile: InsertTile,
): { position: Vector3; boundsMin: Vector3; boundsMax: Vector3 } {
  const placement = model.placements[cellPiece.archetypeIndex]!;
  const cellWorld = worldFrame(
    placement.frames[cellSocket]!,
    cellPiece.rotationSteps,
    cellPiece.position,
  );
  const insertPlacement = model.placements[tile.archetypeIndex]!;
  const rotatedOrigin = rotateY90Steps(
    insertPlacement.frames[tile.socketIndex]!.origin,
    tile.rotationSteps,
  );
  const position = {
    x: cellWorld.origin.x - rotatedOrigin.x,
    y: cellWorld.origin.y - rotatedOrigin.y,
    z: cellWorld.origin.z - rotatedOrigin.z,
  };
  const world = worldBounds(insertPlacement, tile.rotationSteps, position);
  return { position, boundsMin: world.minimum, boundsMax: world.maximum };
}

function insertAssignments(
  model: AssemblyModel,
  placed: ReadonlyArray<PlacedPiece>,
  lot: AssemblyLot,
  options: { seed: number; emptyWeight: number; maxRestarts: number; maxProtrusionStuds: number },
): Map<string, InsertTile | null> {
  const cells: InsertCell[] = [];
  placed.forEach((piece, pieceIndex) => {
    model.placements[piece.archetypeIndex]!.frames.forEach((frame, socketIndex) => {
      if (piece.usedSockets.has(socketIndex)) return;
      if (frame.normal.y < ASSEMBLY_INSERT_MIN_UP_Y) return;
      cells.push({ id: `cell_${pieceIndex}_${socketIndex}`, pieceIndex, socketIndex });
    });
  });
  cells.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  if (cells.length === 0) return new Map();
  const domains = new Map<string, InsertTile[]>();
  const reaches = new Map<string, number>();
  for (const cell of cells) {
    const piece = placed[cell.pieceIndex]!;
    const { tiles, reach } = insertTilesFor(
      model,
      piece,
      cell.socketIndex,
      lot,
      placed,
      options.maxProtrusionStuds,
    );
    domains.set(cell.id, tiles);
    // Conservative: an insert's volume reaches twice its half-diagonal
    // from the cell socket (center offset plus volume extent).
    reaches.set(cell.id, tiles.length === 0 ? 0 : 2 * reach);
  }
  const tilesById = new Map<string, InsertTile>();
  for (const tiles of domains.values()) for (const tile of tiles) tilesById.set(tile.id, tile);
  const tiles = [
    { id: EMPTY_INSERT_TILE, weight: options.emptyWeight },
    ...[...tilesById.values()]
      .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
      .map((tile) => ({ id: tile.id, weight: tile.weight })),
  ];
  const edges: { from: string; to: string; direction: string }[] = [];
  const adjacency: { direction: string; allowed: [string, string][] }[] = [];
  const cellWorlds = new Map(
    cells.map((cell) => {
      const piece = placed[cell.pieceIndex]!;
      const placement = model.placements[piece.archetypeIndex]!;
      return [
        cell.id,
        worldFrame(placement.frames[cell.socketIndex]!, piece.rotationSteps, piece.position),
      ] as const;
    }),
  );
  for (let a = 0; a < cells.length; a += 1) {
    for (let b = a + 1; b < cells.length; b += 1) {
      const left = cells[a]!;
      const right = cells[b]!;
      const leftWorld = cellWorlds.get(left.id)!;
      const rightWorld = cellWorlds.get(right.id)!;
      const distance = Math.sqrt(
        (leftWorld.origin.x - rightWorld.origin.x) ** 2 +
          (leftWorld.origin.y - rightWorld.origin.y) ** 2 +
          (leftWorld.origin.z - rightWorld.origin.z) ** 2,
      );
      // Reach gate: inserts whose bounding spheres cannot meet need no edge.
      if (distance > reaches.get(left.id)! + reaches.get(right.id)! + VOLUME_EPSILON) continue;
      for (const [from, to] of [
        [left, right],
        [right, left],
      ] as const) {
        const direction = `clear:${from.id}>${to.id}`;
        edges.push({ from: from.id, to: to.id, direction });
        const fromTiles = [EMPTY_INSERT_TILE, ...domains.get(from.id)!.map((tile) => tile.id)];
        const toTiles = [EMPTY_INSERT_TILE, ...domains.get(to.id)!.map((tile) => tile.id)];
        const allowed: [string, string][] = [];
        for (const fromTile of fromTiles) {
          for (const toTile of toTiles) {
            if (fromTile === EMPTY_INSERT_TILE || toTile === EMPTY_INSERT_TILE) {
              allowed.push([fromTile, toTile]);
              continue;
            }
            const fromPlaced = insertPlacement(
              model,
              placed[from.pieceIndex]!,
              from.socketIndex,
              tilesById.get(fromTile)!,
            );
            const toPlaced = insertPlacement(
              model,
              placed[to.pieceIndex]!,
              to.socketIndex,
              tilesById.get(toTile)!,
            );
            if (
              volumesDisjoint(
                fromPlaced.boundsMin,
                fromPlaced.boundsMax,
                toPlaced.boundsMin,
                toPlaced.boundsMax,
              )
            )
              allowed.push([fromTile, toTile]);
          }
        }
        allowed.sort((leftPair, rightPair) =>
          leftPair[0] < rightPair[0]
            ? -1
            : leftPair[0] > rightPair[0]
              ? 1
              : leftPair[1] < rightPair[1]
                ? -1
                : leftPair[1] > rightPair[1]
                  ? 1
                  : 0,
        );
        adjacency.push({ direction, allowed });
      }
    }
  }
  const solution = solveWfc({
    graph: { cells: cells.map((cell) => cell.id), edges },
    tiles,
    adjacency,
    seed: options.seed,
    maxRestarts: options.maxRestarts,
    initialDomains: cells.map((cell) => ({
      cell: cell.id,
      tiles: [EMPTY_INSERT_TILE, ...domains.get(cell.id)!.map((tile) => tile.id)],
    })),
  });
  const assignments = new Map<string, InsertTile | null>();
  for (const cell of cells) {
    const tileId = solution.assignments.get(cell.id)!;
    assignments.set(cell.id, tileId === EMPTY_INSERT_TILE ? null : tilesById.get(tileId)!);
  }
  return assignments;
}

function verifyAssembly(
  lot: AssemblyLot,
  placed: ReadonlyArray<PlacedPiece>,
  maxProtrusionStuds: number,
): void {
  const fail = (reason: string): never => {
    throw new Error(`Assembly verification failed on lot ${lot.lotId}: ${reason}`);
  };
  placed.forEach((piece, index) => {
    const strict = index === 0 ? 0 : maxProtrusionStuds;
    if (
      piece.boundsMin.x < lot.minX - strict - VOLUME_EPSILON ||
      piece.boundsMax.x > lot.maxX + strict + VOLUME_EPSILON ||
      piece.boundsMin.z < lot.minZ - strict - VOLUME_EPSILON ||
      piece.boundsMax.z > lot.maxZ + strict + VOLUME_EPSILON
    )
      fail(`component ${index} leaves the lot plus ${strict} studs of protrusion`);
    if (piece.boundsMin.y < lot.groundHeightStuds - ASSEMBLY_MAX_EMBED_STUDS - VOLUME_EPSILON)
      fail(`component ${index} buries below grade`);
    for (let other = index + 1; other < placed.length; other += 1) {
      if (
        !volumesDisjoint(
          piece.boundsMin,
          piece.boundsMax,
          placed[other]!.boundsMin,
          placed[other]!.boundsMax,
        )
      )
        fail(`components ${index} and ${other} interpenetrate`);
    }
  });
}

/**
 * Assemble one lot from a kit spec: seeded anchor, greedy stacked floors,
 * WFC insert fill, verified seal. Throws AssemblyContradictionError when
 * the kit cannot start the lot (no fitting anchor); other failures are
 * solver bugs and throw plain errors.
 */
export function assembleLotOnKit(
  lot: AssemblyLot,
  kit: ModularKitRequirement,
  options: AssembleLotOptions,
): AssemblyRecipe {
  if (!Number.isInteger(options.seed)) throw new Error("Assembly seed must be an integer");
  const maxFloors = options.maxFloors ?? DEFAULT_ASSEMBLY_MAX_FLOORS;
  if (!Number.isInteger(maxFloors) || maxFloors < 1)
    throw new Error("Assembly floor budget must be a positive integer");
  const maxProtrusionStuds = options.maxProtrusionStuds ?? DEFAULT_ASSEMBLY_MAX_PROTRUSION_STUDS;
  if (!Number.isFinite(maxProtrusionStuds) || maxProtrusionStuds < 0)
    throw new Error("Assembly protrusion budget must be a nonnegative finite number");
  const emptyWeight = options.emptyWeight ?? DEFAULT_ASSEMBLY_EMPTY_WEIGHT;
  if (!Number.isFinite(emptyWeight) || emptyWeight <= 0)
    throw new Error("Assembly empty-insert weight must be a positive finite number");
  if (lot.minX >= lot.maxX || lot.minZ >= lot.maxZ)
    throw new Error(`Assembly lot ${lot.lotId} is degenerate`);
  const recipeId = `recipe_${lot.lotId}_${kit.kitId}`;
  if (recipeId.length > 64)
    throw new Error(`Assembly recipe ID exceeds 64 characters: ${recipeId}`);
  const model = prepareAssemblyModel(kit);
  const rng = createMurmurHash3Random(options.seed >>> 0);
  const { candidates, smallestFootprint } = anchorCandidates(model, lot);
  if (candidates.length === 0) {
    if (!Number.isFinite(smallestFootprint))
      throw new AssemblyContradictionError(
        `Lot ${lot.lotId} fits no ${kit.kitId} anchor: the kit has no ground-contact archetypes`,
      );
    throw new AssemblyContradictionError(
      `Lot ${lot.lotId} fits no ${kit.kitId} anchor: lot is ${(lot.maxX - lot.minX).toFixed(2)}x${(lot.maxZ - lot.minZ).toFixed(2)} studs, smallest ground-contact archetype needs ${smallestFootprint.toFixed(2)} studs on its short side`,
    );
  }
  const anchor = pickWeighted(
    rng,
    [...candidates]
      .sort(
        (left, right) =>
          compareWorldStrings(
            model.kit.archetypes[left.archetypeIndex]!.archetypeId,
            model.kit.archetypes[right.archetypeIndex]!.archetypeId,
          ) || left.rotationSteps - right.rotationSteps,
      )
      .map((candidate) => {
        const placement = model.placements[candidate.archetypeIndex]!;
        const sizeX = placement.boundsMax.x - placement.boundsMin.x;
        const sizeZ = placement.boundsMax.z - placement.boundsMin.z;
        return { value: candidate, weight: Math.max(sizeX * sizeZ, VOLUME_EPSILON) };
      }),
  );
  const placed: PlacedPiece[] = [
    placePiece(
      model,
      anchor.archetypeIndex,
      anchor.rotationSteps,
      anchor.position,
      new Set(),
      null,
    ),
  ];
  const floorsTarget = 1 + Math.floor(rng() * maxFloors);
  while (placed.length < floorsTarget) {
    const lower = placed[placed.length - 1]!;
    const lowerPlacement = model.placements[lower.archetypeIndex]!;
    const options_ = stackCandidates(model, lower, lowerPlacement)
      .sort(
        (left, right) =>
          compareWorldStrings(
            model.kit.archetypes[left.archetypeIndex]!.archetypeId,
            model.kit.archetypes[right.archetypeIndex]!.archetypeId,
          ) ||
          left.rotationSteps - right.rotationSteps ||
          left.lowerSocket - right.lowerSocket ||
          left.upperSocket - right.upperSocket,
      )
      .map((candidate) => {
        const placement = model.placements[candidate.archetypeIndex]!;
        const sizeX = placement.boundsMax.x - placement.boundsMin.x;
        const sizeZ = placement.boundsMax.z - placement.boundsMin.z;
        return { value: candidate, weight: Math.max(sizeX * sizeZ, VOLUME_EPSILON) };
      });
    if (options_.length === 0) break;
    const next = pickWeighted(rng, options_);
    const lowerUsed = new Set(lower.usedSockets);
    lowerUsed.add(next.lowerSocket);
    placed[placed.length - 1] = { ...lower, usedSockets: lowerUsed };
    placed.push(
      placePiece(
        model,
        next.archetypeIndex,
        next.rotationSteps,
        next.position,
        new Set([next.upperSocket]),
        next.upperSocket,
      ),
    );
  }
  const inserts = insertAssignments(model, placed, lot, {
    seed: options.seed,
    emptyWeight,
    maxRestarts: options.maxRestarts ?? 8,
    maxProtrusionStuds,
  });
  const orderedCells = [...inserts.keys()].sort();
  for (const cellId of orderedCells) {
    const tile = inserts.get(cellId)!;
    if (tile === null) continue;
    const [pieceIndexText, socketIndexText] = cellId.replace("cell_", "").split("_");
    const pieceIndex = Number.parseInt(pieceIndexText!, 10);
    const socketIndex = Number.parseInt(socketIndexText!, 10);
    const derivation = insertPlacement(model, placed[pieceIndex]!, socketIndex, tile);
    const host = placed[pieceIndex]!;
    const hostUsed = new Set(host.usedSockets);
    hostUsed.add(socketIndex);
    placed[pieceIndex] = { ...host, usedSockets: hostUsed };
    placed.push(
      placePiece(
        model,
        tile.archetypeIndex,
        tile.rotationSteps,
        derivation.position,
        new Set([tile.socketIndex]),
        tile.socketIndex,
      ),
    );
  }
  verifyAssembly(lot, placed, maxProtrusionStuds);
  // Every attached component re-verifies its recorded joint in world
  // frames: the seal claims assemblies that mate, not placements that
  // merely avoid each other.
  placed.forEach((piece, index) => {
    if (piece.attachSocket === null) return;
    const archetype = kit.archetypes[piece.archetypeIndex]!;
    const own = worldFrame(
      model.placements[piece.archetypeIndex]!.frames[piece.attachSocket]!,
      piece.rotationSteps,
      piece.position,
    );
    const mated = placed.some((other, otherIndex) => {
      if (otherIndex === index) return false;
      return model.placements[other.archetypeIndex]!.frames.some((frame, socketIndex) => {
        const rule = model.rules.get(
          ruleKey(piece.archetypeIndex, piece.attachSocket!, other.archetypeIndex, socketIndex),
        );
        if (rule === undefined) return false;
        const world = worldFrame(frame, other.rotationSteps, other.position);
        return jointsMateFrames(own, world, model.tolerances).mates;
      });
    });
    if (!mated)
      throw new Error(
        `Assembly verification failed on lot ${lot.lotId}: component ${index} (${archetype.archetypeId}) records a joint that mates nothing placed`,
      );
  });
  return sealAssemblyRecipe({
    kind: "AssemblyRecipe",
    abi: "basalt-assembly-recipe@1",
    id: recipeId,
    styleContractHash: kit.styleContractHash,
    kitId: kit.kitId,
    lotId: lot.lotId,
    socketedComponents: placed.map((piece, index) => {
      const archetype = kit.archetypes[piece.archetypeIndex]!;
      return {
        componentId: `cmp_${String(index).padStart(2, "0")}`,
        archetypeId: archetype.archetypeId,
        ...(piece.attachSocket === null
          ? {}
          : { socketId: archetype.sockets[piece.attachSocket]!.socketId }),
        semanticRole: archetype.semanticRole,
        position: { x: piece.position.x, y: piece.position.y, z: piece.position.z },
        rotationStepsY90: piece.rotationSteps as 0 | 1 | 2 | 3,
      };
    }),
  });
}

/**
 * Lower a sealed assembly to population instances. Scale stays 1: kit
 * pieces never rescale (joints would break). Footprints derive from
 * placed bounds with flat drops; terrain-conforming footings arrive
 * with compile wiring.
 */
export function lowerAssemblyToInstances(
  recipe: AssemblyRecipe,
  kit: ModularKitRequirement,
  chunkId: string,
): WorldPopulationInstance[] {
  if (recipe.kitId !== kit.kitId)
    throw new Error(`Recipe ${recipe.id} names kit ${recipe.kitId}, not ${kit.kitId}`);
  const archetypes = new Map(kit.archetypes.map((archetype) => [archetype.archetypeId, archetype]));
  return recipe.socketedComponents.map((component) => {
    const archetype = archetypes.get(component.archetypeId);
    if (!archetype)
      throw new Error(`Recipe ${recipe.id} references unknown archetype ${component.archetypeId}`);
    const yaw = (component.rotationStepsY90 * Math.PI) / 2;
    const [sizeX, , sizeZ] = archetype.boundingEnvelope;
    const width = component.rotationStepsY90 % 2 === 0 ? sizeX : sizeZ;
    const depth = component.rotationStepsY90 % 2 === 0 ? sizeZ : sizeX;
    return WORLD_POPULATION_INSTANCE_SCHEMA.parse({
      id: `asm_${recipe.id}_${component.componentId}`,
      familyId: archetype.sourceFamilyId,
      archetypeId: `${archetype.sourceFamilyId}_archetype_${archetype.sourceVariantIndex}`,
      chunkId,
      position: { ...component.position },
      rotation: [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)] as [number, number, number, number],
      scale: 1,
      footprint: {
        contactRadiusStuds: Math.max(Math.sqrt(width * width + depth * depth) / 2, VOLUME_EPSILON),
        restYStuds: component.position.y,
        dropsStuds: [0, 0, 0, 0],
      },
    });
  });
}
