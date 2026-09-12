import { z } from "zod";
import { contentHash, stableJson } from "../../contracts/src/index.js";
import { createMurmurHash3Random } from "../../spatial-core/src/primitives.js";
import { dequantizeQ32_32 } from "../../basalt-types/src/fixed.js";
import type { AssemblyRecipe, ModularKitRequirement } from "../../asset-factory/src/index.js";
import { rotateY90Steps } from "../../catalog-intelligence/src/index.js";
import { WORLD_VECTOR3_SCHEMA } from "../../world-planning/src/contracts.js";
import { VOXEL_CELL_SIZE_STUDS } from "../../world-planning/src/voxels.js";
import { DENSITY_AREA_NORMALIZATION_STUDS2, type WorldFamilyPopulationPlan } from "./contracts.js";
import { compareWorldStrings, worldEntityId, worldHash } from "./primitives.js";
import { groundingKindFromSpan, type GroundingArchetypeEvidence } from "./grounding.js";
import { allocateProportionalCounts, clearanceRadius, type CrossFamilySpacing } from "./spacing.js";

export const ROOM_PROGRAM_ABI = "basalt-room-program@1" as const;
export const ROOM_GRAPH_ABI = "basalt-room-graph@1" as const;

/** Base heights within this band belong to one floor plate. */
export const ROOM_PLATE_LEVEL_EPSILON_STUDS = 1e-6;
/** Attach sockets steeper than this carry floors; the rest is dressing. */
export const ROOM_VERTICAL_SOCKET_NORMAL_Y = 0.9;
/** Shared-wall touches below this carry no door portal. */
export const MIN_PORTAL_WIDTH_STUDS = 2;
/** Clutter centers keep this far beyond the portal half-width. */
export const ROOM_PORTAL_KEEPOUT_STUDS = 2;
/** Clutter centers rest this far beyond their clearance off room walls. */
export const ROOM_CLUTTER_WALL_INSET_STUDS = 0.5;
/** Steepest stair the solver emits, as rise over run. Walkthrough-proven. */
export const MAX_STAIRCASE_SLOPE_RISE_OVER_RUN = 1;
/** Program role that hosts a stair run. Vocabulary of the sealed program. */
export const ROOM_STAIRCASE_ROLE = "stair";
const ROOM_VOLUME_EPSILON = 1e-9;

export class RoomContradictionError extends Error {}

const roomSpecSchema = z
  .object({
    role: z.string().trim().min(1).max(64),
    minWidthStuds: z.number().finite().positive(),
    minDepthStuds: z.number().finite().positive(),
  })
  .strict();

const programFloorSchema = z
  .object({
    level: z.number().int().nonnegative(),
    layout: z.enum(["bisect", "strips_x", "strips_z"]).default("bisect"),
    rooms: z.array(roomSpecSchema).min(1).max(32),
  })
  .strict();

const roomProgramMaterial = z
  .object({
    kind: z.literal("RoomProgram"),
    abi: z.literal(ROOM_PROGRAM_ABI),
    id: worldEntityId,
    floors: z.array(programFloorSchema).min(1).max(16),
    doorWidthStuds: z.number().finite().positive(),
    stairMaterialId: worldEntityId,
    entrance: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("door_component"), familyId: worldEntityId }).strict(),
      z.object({ kind: z.literal("open") }).strict(),
    ]),
    stair: z
      .object({
        maxRiserStuds: z.number().finite().positive(),
        minTreadStuds: z.number().finite().positive(),
        widthStuds: z.number().finite().positive(),
      })
      .strict()
      .nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    const levels = value.floors.map((floor) => floor.level);
    if (new Set(levels).size !== levels.length)
      context.addIssue({ code: "custom", path: ["floors"], message: "Room levels must be unique" });
    const canonical = [...value.floors].sort((left, right) => left.level - right.level);
    if (stableJson(canonical) !== stableJson(value.floors))
      context.addIssue({
        code: "custom",
        path: ["floors"],
        message: "Room floors must be canonical by level",
      });
  });
export const ROOM_PROGRAM_SCHEMA = roomProgramMaterial.safeExtend({ hash: worldHash }).strict();
export type RoomProgram = z.infer<typeof ROOM_PROGRAM_SCHEMA>;

export function sealRoomProgram(input: z.input<typeof roomProgramMaterial>): RoomProgram {
  const material = roomProgramMaterial.parse({
    ...input,
    floors: [...input.floors].sort((left, right) => left.level - right.level),
  });
  return Object.freeze({ ...material, hash: contentHash(stableJson(material)) });
}

export function assertRoomProgramIdentity(value: unknown): asserts value is RoomProgram {
  const program = ROOM_PROGRAM_SCHEMA.parse(value);
  const { hash, ...material } = program;
  if (hash !== contentHash(stableJson(material)))
    throw new Error("Room program identity is invalid");
}

const roomRecordSchema = z
  .object({
    roomId: worldEntityId,
    role: z.string().trim().min(1).max(64),
    minX: z.number().finite(),
    minZ: z.number().finite(),
    maxX: z.number().finite(),
    maxZ: z.number().finite(),
  })
  .strict();

const graphFloorSchema = z
  .object({
    level: z.number().int().nonnegative(),
    baseYStuds: z.number().finite(),
    ceilingYStuds: z.number().finite(),
    rooms: z.array(roomRecordSchema).min(1).max(32),
  })
  .strict();

const portalRecordSchema = z.discriminatedUnion("kind", [
  z
    .object({
      portalId: worldEntityId,
      kind: z.literal("interior"),
      roomA: worldEntityId,
      roomB: worldEntityId,
      position: WORLD_VECTOR3_SCHEMA,
      yawStepsY90: z.number().int().min(0).max(3),
      widthStuds: z.number().finite().positive(),
    })
    .strict(),
  z
    .object({
      portalId: worldEntityId,
      kind: z.literal("entrance"),
      roomA: worldEntityId,
      position: WORLD_VECTOR3_SCHEMA,
      yawStepsY90: z.number().int().min(0).max(3),
      widthStuds: z.number().finite().positive(),
      boundComponentId: worldEntityId.optional(),
    })
    .strict(),
]);

const stairRecordSchema = z
  .object({
    stairId: worldEntityId,
    fromLevel: z.number().int().nonnegative(),
    toLevel: z.number().int().nonnegative(),
    fromRoomId: worldEntityId,
    toRoomId: worldEntityId,
    materialId: worldEntityId,
    basePosition: WORLD_VECTOR3_SCHEMA,
    yawStepsY90: z.number().int().min(0).max(3),
    steps: z.number().int().positive(),
    riseStuds: z.number().finite().positive(),
    runLengthStuds: z.number().finite().positive(),
    riserStuds: z.number().finite().positive(),
    treadStuds: z.number().finite().positive(),
    widthStuds: z.number().finite().positive(),
    slopeRiseOverRun: z.number().finite().nonnegative(),
  })
  .strict();

const roomGraphMaterial = z
  .object({
    kind: z.literal("RoomGraph"),
    abi: z.literal(ROOM_GRAPH_ABI),
    id: worldEntityId,
    recipeId: worldEntityId,
    kitId: worldEntityId,
    lotId: worldEntityId,
    regionId: worldEntityId,
    programHash: worldHash,
    entranceRoomId: worldEntityId,
    floors: z.array(graphFloorSchema).min(1).max(16),
    portals: z.array(portalRecordSchema).max(512),
    stairs: z.array(stairRecordSchema).max(64),
  })
  .strict()
  .superRefine((value, context) => {
    const levels = value.floors.map((floor) => floor.level);
    if (new Set(levels).size !== levels.length)
      context.addIssue({ code: "custom", path: ["floors"], message: "Room levels must be unique" });
    const roomIds = value.floors.flatMap((floor) => floor.rooms.map((room) => room.roomId));
    if (new Set(roomIds).size !== roomIds.length)
      context.addIssue({ code: "custom", path: ["floors"], message: "Room IDs must be unique" });
    if (!roomIds.includes(value.entranceRoomId))
      context.addIssue({
        code: "custom",
        path: ["entranceRoomId"],
        message: "Entrance room is not a planned room",
      });
    const portalIds = value.portals.map((portal) => portal.portalId);
    if (new Set(portalIds).size !== portalIds.length)
      context.addIssue({
        code: "custom",
        path: ["portals"],
        message: "Portal IDs must be unique",
      });
    const stairIds = value.stairs.map((stair) => stair.stairId);
    if (new Set(stairIds).size !== stairIds.length)
      context.addIssue({ code: "custom", path: ["stairs"], message: "Stair IDs must be unique" });
    const canonicalPortals = [...value.portals].sort((left, right) =>
      compareWorldStrings(left.portalId, right.portalId),
    );
    if (stableJson(canonicalPortals) !== stableJson(value.portals))
      context.addIssue({
        code: "custom",
        path: ["portals"],
        message: "Portals must be canonical by ID",
      });
    const canonicalStairs = [...value.stairs].sort((left, right) =>
      compareWorldStrings(left.stairId, right.stairId),
    );
    if (stableJson(canonicalStairs) !== stableJson(value.stairs))
      context.addIssue({ code: "custom", path: ["stairs"], message: "Stairs must be canonical" });
  });
export const ROOM_GRAPH_SCHEMA = roomGraphMaterial.safeExtend({ hash: worldHash }).strict();
export type RoomGraph = z.infer<typeof ROOM_GRAPH_SCHEMA>;

export function sealRoomGraph(input: z.input<typeof roomGraphMaterial>): RoomGraph {
  const material = roomGraphMaterial.parse({
    ...input,
    floors: [...input.floors]
      .sort((left, right) => left.level - right.level)
      .map((floor) => ({
        ...floor,
        rooms: [...floor.rooms].sort((left, right) =>
          compareWorldStrings(left.roomId, right.roomId),
        ),
      })),
    portals: [...input.portals].sort((left, right) =>
      compareWorldStrings(left.portalId, right.portalId),
    ),
    stairs: [...input.stairs].sort((left, right) =>
      compareWorldStrings(left.stairId, right.stairId),
    ),
  });
  return Object.freeze({ ...material, hash: contentHash(stableJson(material)) });
}

export function assertRoomGraphIdentity(value: unknown): asserts value is RoomGraph {
  const graph = ROOM_GRAPH_SCHEMA.parse(value);
  const { hash, ...material } = graph;
  if (hash !== contentHash(stableJson(material))) throw new Error("Room graph identity is invalid");
}

export interface PlateRect {
  readonly minX: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxZ: number;
}

export interface RoomSpec {
  readonly role: string;
  readonly minWidthStuds: number;
  readonly minDepthStuds: number;
}

export interface PartitionedRoom extends PlateRect {
  readonly role: string;
}

export type PlateLayout = "bisect" | "strips_x" | "strips_z";

/**
 * Floor-plate partition in program order. Bisect recurses along the
 * longer axis (X wins ties) at room-count fractions; strips divide one
 * axis at equal count fractions with rooms spanning the other — the
 * long runs straight stairs need. Order is intent: reordering the
 * program reorders the layout.
 */
export function partitionPlate(
  rect: PlateRect,
  rooms: readonly RoomSpec[],
  layout: PlateLayout = "bisect",
): PartitionedRoom[] {
  if (!(rect.minX < rect.maxX) || !(rect.minZ < rect.maxZ))
    throw new Error("Room plates must have positive extent");
  if (rooms.length === 0) throw new Error("Room plates need at least one room");
  const checkMinima = (cell: PlateRect, spec: RoomSpec): void => {
    const width = cell.maxX - cell.minX;
    const depth = cell.maxZ - cell.minZ;
    if (width < spec.minWidthStuds || depth < spec.minDepthStuds)
      throw new RoomContradictionError(
        `Room "${spec.role}" needs ${spec.minWidthStuds.toFixed(2)}x${spec.minDepthStuds.toFixed(2)} studs but its plate cell is ${width.toFixed(2)}x${depth.toFixed(2)}`,
      );
  };
  if (layout === "strips_x" || layout === "strips_z") {
    const count = rooms.length;
    return rooms.map((spec, index) => {
      const cell =
        layout === "strips_x"
          ? {
              minX: rect.minX + ((rect.maxX - rect.minX) * index) / count,
              minZ: rect.minZ,
              maxX: rect.minX + ((rect.maxX - rect.minX) * (index + 1)) / count,
              maxZ: rect.maxZ,
            }
          : {
              minX: rect.minX,
              minZ: rect.minZ + ((rect.maxZ - rect.minZ) * index) / count,
              maxX: rect.maxX,
              maxZ: rect.minZ + ((rect.maxZ - rect.minZ) * (index + 1)) / count,
            };
      checkMinima(cell, spec);
      return { role: spec.role, ...cell };
    });
  }
  const split = (cell: PlateRect, specs: readonly RoomSpec[]): PartitionedRoom[] => {
    if (specs.length === 1) {
      const spec = specs[0]!;
      checkMinima(cell, spec);
      return [{ role: spec.role, ...cell }];
    }
    const width = cell.maxX - cell.minX;
    const depth = cell.maxZ - cell.minZ;
    const leftCount = Math.floor(specs.length / 2);
    if (width >= depth) {
      const cut = cell.minX + (width * leftCount) / specs.length;
      return [
        ...split({ ...cell, maxX: cut }, specs.slice(0, leftCount)),
        ...split({ ...cell, minX: cut }, specs.slice(leftCount)),
      ];
    }
    const cut = cell.minZ + (depth * leftCount) / specs.length;
    return [
      ...split({ ...cell, maxZ: cut }, specs.slice(0, leftCount)),
      ...split({ ...cell, minZ: cut }, specs.slice(leftCount)),
    ];
  };
  return split(rect, rooms);
}

export interface StairModule {
  readonly maxRiserStuds: number;
  readonly minTreadStuds: number;
  readonly widthStuds: number;
}

export interface VerifiedStairRun {
  readonly steps: number;
  readonly riserStuds: number;
  readonly treadStuds: number;
  readonly slopeRiseOverRun: number;
}

/**
 * Stair arithmetic over measured runs: fewest risers under the module
 * cap, treads from the run, slope against the symbolic maximum. Pure so
 * the bounds stay testable without a building.
 */
export function verifyStairRun(input: {
  readonly riseStuds: number;
  readonly runLengthStuds: number;
  readonly overlapWidthStuds: number;
  readonly stepModule: StairModule;
}): VerifiedStairRun {
  const { riseStuds, runLengthStuds, overlapWidthStuds, stepModule } = input;
  if (!(stepModule.widthStuds <= overlapWidthStuds))
    throw new RoomContradictionError(
      `Stair width ${stepModule.widthStuds} exceeds the ${overlapWidthStuds} stud stair-room overlap`,
    );
  const slopeRiseOverRun = riseStuds / runLengthStuds;
  if (!(slopeRiseOverRun <= MAX_STAIRCASE_SLOPE_RISE_OVER_RUN))
    throw new RoomContradictionError(
      `Stair slope ${slopeRiseOverRun} exceeds maximum ${MAX_STAIRCASE_SLOPE_RISE_OVER_RUN}`,
    );
  const steps = Math.ceil(riseStuds / stepModule.maxRiserStuds);
  const riserStuds = riseStuds / steps;
  const treadStuds = runLengthStuds / steps;
  if (!(treadStuds >= stepModule.minTreadStuds))
    throw new RoomContradictionError(
      `Stair tread ${treadStuds} under minimum ${stepModule.minTreadStuds}`,
    );
  return { steps, riserStuds, treadStuds, slopeRiseOverRun };
}

/** Rooms unreachable from the entrance over portals and stairs, sorted. */
export function findUnreachableRooms(graph: {
  readonly floors: ReadonlyArray<{ readonly rooms: ReadonlyArray<{ readonly roomId: string }> }>;
  readonly portals: ReadonlyArray<{
    readonly kind: "interior" | "entrance";
    readonly roomA: string;
    readonly roomB?: string;
  }>;
  readonly stairs: ReadonlyArray<{ readonly fromRoomId: string; readonly toRoomId: string }>;
  readonly entranceRoomId: string;
}): string[] {
  const roomIds = graph.floors.flatMap((floor) => floor.rooms.map((room) => room.roomId));
  if (!roomIds.includes(graph.entranceRoomId))
    throw new Error("Room connectivity needs a planned entrance room");
  const adjacency = new Map<string, string[]>();
  const link = (left: string, right: string): void => {
    adjacency.set(left, [...(adjacency.get(left) ?? []), right]);
    adjacency.set(right, [...(adjacency.get(right) ?? []), left]);
  };
  for (const portal of graph.portals) {
    if (portal.kind === "interior" && portal.roomB) link(portal.roomA, portal.roomB);
  }
  for (const stair of graph.stairs) link(stair.fromRoomId, stair.toRoomId);
  const reached = new Set<string>([graph.entranceRoomId]);
  const queue = [graph.entranceRoomId];
  while (queue.length > 0) {
    const current = queue.pop()!;
    for (const next of adjacency.get(current) ?? []) {
      if (reached.has(next)) continue;
      reached.add(next);
      queue.push(next);
    }
  }
  return roomIds.filter((roomId) => !reached.has(roomId)).sort(compareWorldStrings);
}

interface ComponentBox extends PlateRect {
  readonly minY: number;
  readonly maxY: number;
}

interface FloorPlate extends PlateRect {
  readonly level: number;
  readonly baseYStuds: number;
  readonly ceilingYStuds: number;
}

function componentBox(
  recipe: AssemblyRecipe,
  kit: ModularKitRequirement,
  componentId: string,
): { box: ComponentBox; sourceFamilyId: string } {
  const component = recipe.socketedComponents.find((entry) => entry.componentId === componentId)!;
  const archetype = kit.archetypes.find((entry) => entry.archetypeId === component.archetypeId);
  if (!archetype) throw new Error(`Recipe ${recipe.id} references unknown archetype`);
  const [sizeX, sizeY, sizeZ] = archetype.boundingEnvelope;
  const [centerX, centerY, centerZ] = archetype.boundsCenterStuds;
  const corners = [
    { x: centerX - sizeX / 2, y: centerY - sizeY / 2, z: centerZ - sizeZ / 2 },
    { x: centerX + sizeX / 2, y: centerY - sizeY / 2, z: centerZ - sizeZ / 2 },
    { x: centerX - sizeX / 2, y: centerY + sizeY / 2, z: centerZ - sizeZ / 2 },
    { x: centerX + sizeX / 2, y: centerY + sizeY / 2, z: centerZ + sizeZ / 2 },
    { x: centerX - sizeX / 2, y: centerY - sizeY / 2, z: centerZ + sizeZ / 2 },
    { x: centerX + sizeX / 2, y: centerY - sizeY / 2, z: centerZ + sizeZ / 2 },
    { x: centerX - sizeX / 2, y: centerY + sizeY / 2, z: centerZ + sizeZ / 2 },
    { x: centerX + sizeX / 2, y: centerY + sizeY / 2, z: centerZ + sizeZ / 2 },
  ].map((corner) => {
    const rotated = rotateY90Steps(corner, component.rotationStepsY90);
    return {
      x: rotated.x + component.position.x,
      y: rotated.y + component.position.y,
      z: rotated.z + component.position.z,
    };
  });
  return {
    box: {
      minX: Math.min(...corners.map((corner) => corner.x)),
      minZ: Math.min(...corners.map((corner) => corner.z)),
      maxX: Math.max(...corners.map((corner) => corner.x)),
      maxZ: Math.max(...corners.map((corner) => corner.z)),
      minY: Math.min(...corners.map((corner) => corner.y)),
      maxY: Math.max(...corners.map((corner) => corner.y)),
    },
    sourceFamilyId: archetype.sourceFamilyId,
  };
}

/**
 * Anchors and vertically attached pieces form floors; side-attached
 * inserts (doors, windows) dress facades and never shape plates.
 */
function isFloorForming(
  recipe: AssemblyRecipe,
  kit: ModularKitRequirement,
  componentId: string,
): boolean {
  const component = recipe.socketedComponents.find((entry) => entry.componentId === componentId)!;
  if (component.socketId === undefined) return true;
  const archetype = kit.archetypes.find((entry) => entry.archetypeId === component.archetypeId);
  const socket = archetype?.sockets.find((entry) => entry.socketId === component.socketId);
  if (!socket) throw new Error(`Recipe ${recipe.id} references an unknown socket`);
  return Math.abs(dequantizeQ32_32(socket.normal.y)) > ROOM_VERTICAL_SOCKET_NORMAL_Y;
}

function snapGroundContact(value: number): number {
  return Math.round(value / VOXEL_CELL_SIZE_STUDS) * VOXEL_CELL_SIZE_STUDS;
}

/** Yaw quarter-turns face +Z, +X, -Z, -X for steps 0 through 3. */
function yawStepsForDirection(dx: number, dz: number): 0 | 1 | 2 | 3 {
  if (Math.abs(dx) >= Math.abs(dz)) return dx >= 0 ? 1 : 3;
  return dz >= 0 ? 0 : 2;
}

/**
 * Rooms consume assembly shells: floor plates from floor-forming
 * components, guillotine rooms per the sealed program, portals on shared
 * walls, stairs across stair-room overlaps, and a connectivity proof
 * from the entrance. v1 plates are single rects; compounds contradict.
 */
export function planRooms(
  recipe: AssemblyRecipe,
  kit: ModularKitRequirement,
  program: RoomProgram,
  options: { readonly regionId: string },
): RoomGraph {
  if (recipe.kitId !== kit.kitId)
    throw new Error(`Recipe ${recipe.id} names kit ${recipe.kitId}, not ${kit.kitId}`);
  const forming = recipe.socketedComponents
    .filter((component) => isFloorForming(recipe, kit, component.componentId))
    .map((component) => ({
      componentId: component.componentId,
      ...componentBox(recipe, kit, component.componentId),
    }));
  if (forming.length === 0)
    throw new RoomContradictionError(`Recipe ${recipe.id} carries no floor-forming components`);
  const levels: ComponentBox[][] = [];
  for (const piece of [...forming].sort((left, right) => left.box.minY - right.box.minY)) {
    const level = levels[levels.length - 1];
    if (level && Math.abs(piece.box.minY - level[0]!.minY) <= ROOM_PLATE_LEVEL_EPSILON_STUDS)
      level.push(piece.box);
    else levels.push([piece.box]);
  }
  const programLevels = [...program.floors].sort((left, right) => left.level - right.level);
  for (const floor of programLevels)
    if (floor.level >= levels.length)
      throw new RoomContradictionError(
        `Program ${program.id} names level ${floor.level} but recipe ${recipe.id} plates ${levels.length} floors`,
      );
  // Programs may skip unroomed plates (open roof terraces), but the
  // entrance is ground-bound: level 0 always carries rooms.
  if (programLevels[0]!.level !== 0)
    throw new RoomContradictionError(
      `Program ${program.id} names no ground-floor rooms for the entrance`,
    );
  const plates: FloorPlate[] = levels.map((boxes, level) => {
    const plate = {
      minX: Math.min(...boxes.map((box) => box.minX)),
      minZ: Math.min(...boxes.map((box) => box.minZ)),
      maxX: Math.max(...boxes.map((box) => box.maxX)),
      maxZ: Math.max(...boxes.map((box) => box.maxZ)),
    };
    const plateArea = (plate.maxX - plate.minX) * (plate.maxZ - plate.minZ);
    const unionArea = boxes.reduce(
      (sum, box) => sum + (box.maxX - box.minX) * (box.maxZ - box.minZ),
      0,
    );
    let disjoint = true;
    for (let left = 0; left < boxes.length && disjoint; left += 1)
      for (let right = left + 1; right < boxes.length && disjoint; right += 1) {
        const overlapX =
          Math.min(boxes[left]!.maxX, boxes[right]!.maxX) -
          Math.max(boxes[left]!.minX, boxes[right]!.minX);
        const overlapZ =
          Math.min(boxes[left]!.maxZ, boxes[right]!.maxZ) -
          Math.max(boxes[left]!.minZ, boxes[right]!.minZ);
        if (overlapX > ROOM_VOLUME_EPSILON && overlapZ > ROOM_VOLUME_EPSILON) disjoint = false;
      }
    if (!disjoint || Math.abs(unionArea - plateArea) > 1e-6 * Math.max(1, plateArea))
      throw new RoomContradictionError(
        `Recipe ${recipe.id} level ${level} is not a single rectilinear floor plate`,
      );
    const baseYStuds = Math.min(...boxes.map((box) => box.minY));
    const topYStuds = Math.max(...boxes.map((box) => box.maxY));
    const nextBase = levels[level + 1]
      ? Math.min(...levels[level + 1]!.map((box) => box.minY))
      : topYStuds;
    return { ...plate, level, baseYStuds, ceilingYStuds: nextBase };
  });

  const pad = (value: number): string => String(value).padStart(2, "0");
  const floors = programLevels.map((spec) => {
    const plate = plates[spec.level]!;
    const partitioned = partitionPlate(
      { minX: plate.minX, minZ: plate.minZ, maxX: plate.maxX, maxZ: plate.maxZ },
      spec.rooms,
      spec.layout,
    );
    return {
      level: spec.level,
      baseYStuds: plate.baseYStuds,
      ceilingYStuds: plate.ceilingYStuds,
      rooms: partitioned.map((room, index) => ({
        roomId: `room_${pad(spec.level)}_${pad(index)}`,
        ...room,
      })),
    };
  });

  type Portal = RoomGraph["portals"][number];
  const portals: Portal[] = [];
  const sillFor = (level: number, value: number): number =>
    level === 0 ? snapGroundContact(value) : value;
  floors.forEach((floor) => {
    const level = floor.level;
    let portalIndex = 0;
    for (let left = 0; left < floor.rooms.length; left += 1)
      for (let right = left + 1; right < floor.rooms.length; right += 1) {
        const a = floor.rooms[left]!;
        const b = floor.rooms[right]!;
        const shared: Array<{ x: number; z: number }> = [];
        if (Math.abs(a.maxX - b.minX) <= ROOM_VOLUME_EPSILON)
          shared.push({ x: a.maxX, z: (Math.max(a.minZ, b.minZ) + Math.min(a.maxZ, b.maxZ)) / 2 });
        if (Math.abs(a.minX - b.maxX) <= ROOM_VOLUME_EPSILON)
          shared.push({ x: a.minX, z: (Math.max(a.minZ, b.minZ) + Math.min(a.maxZ, b.maxZ)) / 2 });
        if (Math.abs(a.maxZ - b.minZ) <= ROOM_VOLUME_EPSILON)
          shared.push({ x: (Math.max(a.minX, b.minX) + Math.min(a.maxX, b.maxX)) / 2, z: a.maxZ });
        if (Math.abs(a.minZ - b.maxZ) <= ROOM_VOLUME_EPSILON)
          shared.push({ x: (Math.max(a.minX, b.minX) + Math.min(a.maxX, b.maxX)) / 2, z: a.minZ });
        const overlaps = shared.filter((point) => {
          const alongX =
            Math.abs(point.x - a.maxX) <= ROOM_VOLUME_EPSILON ||
            Math.abs(point.x - a.minX) <= ROOM_VOLUME_EPSILON;
          const span = alongX
            ? Math.min(a.maxZ, b.maxZ) - Math.max(a.minZ, b.minZ)
            : Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
          return span >= MIN_PORTAL_WIDTH_STUDS;
        });
        overlaps.sort((p, q) => p.x - q.x || p.z - q.z);
        for (const point of overlaps) {
          const alongX =
            Math.abs(point.x - a.maxX) <= ROOM_VOLUME_EPSILON ||
            Math.abs(point.x - a.minX) <= ROOM_VOLUME_EPSILON;
          const span = alongX
            ? Math.min(a.maxZ, b.maxZ) - Math.max(a.minZ, b.minZ)
            : Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
          const [roomA, roomB] = compareWorldStrings(a.roomId, b.roomId) <= 0 ? [a, b] : [b, a];
          const dx = (roomB.minX + roomB.maxX) / 2 - (roomA.minX + roomA.maxX) / 2;
          const dz = (roomB.minZ + roomB.maxZ) / 2 - (roomA.minZ + roomA.maxZ) / 2;
          portals.push({
            portalId: `portal_${pad(level)}_${pad(portalIndex)}`,
            kind: "interior",
            roomA: roomA.roomId,
            roomB: roomB.roomId,
            position: { x: point.x, y: sillFor(level, floor.baseYStuds), z: point.z },
            yawStepsY90: yawStepsForDirection(dx, dz),
            widthStuds: Math.min(program.doorWidthStuds, span),
          });
          portalIndex += 1;
        }
      }
  });

  const groundPlate = plates[0]!;
  const groundFloor = floors.find((floor) => floor.level === 0)!;
  let entranceRoomId: string;
  const entrance = program.entrance;
  if (entrance.kind === "door_component") {
    const entranceFamilyId = entrance.familyId;
    const doors = recipe.socketedComponents
      .map((component) => ({
        component,
        ...componentBox(recipe, kit, component.componentId),
      }))
      .filter(
        (entry) =>
          entry.sourceFamilyId === entranceFamilyId &&
          Math.abs(entry.box.minY - groundPlate.baseYStuds) <= ROOM_PLATE_LEVEL_EPSILON_STUDS,
      )
      .sort((left, right) =>
        compareWorldStrings(left.component.componentId, right.component.componentId),
      );
    if (doors.length === 0)
      throw new RoomContradictionError(
        `Recipe ${recipe.id} places no ${entranceFamilyId} door for the entrance`,
      );
    const door = doors[0]!;
    const overlaps = groundFloor.rooms.map((room) => ({
      roomId: room.roomId,
      area:
        Math.max(0, Math.min(room.maxX, door.box.maxX) - Math.max(room.minX, door.box.minX)) *
        Math.max(0, Math.min(room.maxZ, door.box.maxZ) - Math.max(room.minZ, door.box.minZ)),
    }));
    const host = overlaps.sort((left, right) => right.area - left.area)[0]!;
    if (!(host.area > 0))
      throw new RoomContradictionError(
        `Entrance door ${door.component.componentId} touches no ground-floor room`,
      );
    entranceRoomId = host.roomId;
    const bounds = [
      { distance: door.component.position.x - groundPlate.minX, yaw: 3 as const },
      { distance: groundPlate.maxX - door.component.position.x, yaw: 1 as const },
      { distance: door.component.position.z - groundPlate.minZ, yaw: 2 as const },
      { distance: groundPlate.maxZ - door.component.position.z, yaw: 0 as const },
    ].sort((left, right) => left.distance - right.distance)[0]!;
    portals.push({
      portalId: `portal_${pad(0)}_en`,
      kind: "entrance",
      roomA: entranceRoomId,
      position: {
        x: door.component.position.x,
        y: snapGroundContact(door.component.position.y),
        z: door.component.position.z,
      },
      yawStepsY90: bounds.yaw,
      widthStuds: program.doorWidthStuds,
      boundComponentId: door.component.componentId,
    });
  } else {
    const areas = groundFloor.rooms.map((room, index) => ({
      room,
      index,
      area: (room.maxX - room.minX) * (room.maxZ - room.minZ),
    }));
    areas.sort((left, right) => right.area - left.area || left.index - right.index);
    const host = areas[0]!.room;
    entranceRoomId = host.roomId;
    const edges = [
      {
        length: host.maxX - host.minX,
        onPlate: Math.abs(host.minZ - groundPlate.minZ) <= ROOM_VOLUME_EPSILON,
        x: (host.minX + host.maxX) / 2,
        z: host.minZ,
        yaw: 2 as const,
      },
      {
        length: host.maxX - host.minX,
        onPlate: Math.abs(host.maxZ - groundPlate.maxZ) <= ROOM_VOLUME_EPSILON,
        x: (host.minX + host.maxX) / 2,
        z: host.maxZ,
        yaw: 0 as const,
      },
      {
        length: host.maxZ - host.minZ,
        onPlate: Math.abs(host.minX - groundPlate.minX) <= ROOM_VOLUME_EPSILON,
        x: host.minX,
        z: (host.minZ + host.maxZ) / 2,
        yaw: 3 as const,
      },
      {
        length: host.maxZ - host.minZ,
        onPlate: Math.abs(host.maxX - groundPlate.maxX) <= ROOM_VOLUME_EPSILON,
        x: host.maxX,
        z: (host.minZ + host.maxZ) / 2,
        yaw: 1 as const,
      },
    ].filter((edge) => edge.onPlate);
    edges.sort((left, right) => right.length - left.length);
    const edge = edges[0]!;
    portals.push({
      portalId: `portal_${pad(0)}_en`,
      kind: "entrance",
      roomA: entranceRoomId,
      position: { x: edge.x, y: snapGroundContact(groundPlate.baseYStuds), z: edge.z },
      yawStepsY90: edge.yaw,
      widthStuds: program.doorWidthStuds,
    });
  }

  type Stair = RoomGraph["stairs"][number];
  const stairs: Stair[] = [];
  if (floors.length > 1) {
    if (!program.stair)
      throw new RoomContradictionError(
        `Program ${program.id} stacks ${floors.length} floors with no stair spec`,
      );
    for (let pair = 0; pair < floors.length - 1; pair += 1) {
      const lower = floors[pair]!;
      const upper = floors[pair + 1]!;
      const level = lower.level;
      if (upper.level !== level + 1)
        throw new RoomContradictionError(
          `Program ${program.id} leaves level ${level + 1} unroomed between floors; stairs need adjacent plates`,
        );
      const lowerStairs = lower.rooms.filter((room) => room.role === ROOM_STAIRCASE_ROLE);
      const upperStairs = upper.rooms.filter((room) => room.role === ROOM_STAIRCASE_ROLE);
      if (lowerStairs.length !== 1 || upperStairs.length !== 1)
        throw new RoomContradictionError(
          `Program ${program.id} needs one stair room per floor between levels ${level} and ${level + 1}`,
        );
      const from = lowerStairs[0]!;
      const to = upperStairs[0]!;
      const overlap = {
        minX: Math.max(from.minX, to.minX),
        minZ: Math.max(from.minZ, to.minZ),
        maxX: Math.min(from.maxX, to.maxX),
        maxZ: Math.min(from.maxZ, to.maxZ),
      };
      if (!(overlap.minX < overlap.maxX) || !(overlap.minZ < overlap.maxZ))
        throw new RoomContradictionError(
          `Stair rooms ${from.roomId} and ${to.roomId} do not overlap in plan`,
        );
      const overlapWidth = overlap.maxX - overlap.minX;
      const overlapDepth = overlap.maxZ - overlap.minZ;
      const alongX = overlapWidth >= overlapDepth;
      const runLengthStuds = alongX ? overlapWidth : overlapDepth;
      const overlapWidthStuds = alongX ? overlapDepth : overlapWidth;
      const riseStuds = upper.baseYStuds - lower.baseYStuds;
      if (!(riseStuds > 0))
        throw new RoomContradictionError(
          `Stair between levels ${level} and ${level + 1} rises ${riseStuds}`,
        );
      const run = verifyStairRun({
        riseStuds,
        runLengthStuds,
        overlapWidthStuds,
        stepModule: program.stair,
      });
      stairs.push({
        stairId: `stair_${pad(level)}_${pad(level + 1)}`,
        fromLevel: level,
        toLevel: level + 1,
        fromRoomId: from.roomId,
        toRoomId: to.roomId,
        materialId: program.stairMaterialId,
        basePosition: {
          x: alongX ? overlap.minX : (overlap.minX + overlap.maxX) / 2,
          y: level === 0 ? snapGroundContact(lower.baseYStuds) : lower.baseYStuds,
          z: alongX ? (overlap.minZ + overlap.maxZ) / 2 : overlap.minZ,
        },
        yawStepsY90: alongX ? 1 : 0,
        steps: run.steps,
        riseStuds,
        runLengthStuds,
        riserStuds: run.riserStuds,
        treadStuds: run.treadStuds,
        widthStuds: program.stair.widthStuds,
        slopeRiseOverRun: run.slopeRiseOverRun,
      });
    }
  }

  const graph = sealRoomGraph({
    kind: "RoomGraph",
    abi: ROOM_GRAPH_ABI,
    id: `roomgraph_${recipe.id}`,
    recipeId: recipe.id,
    kitId: recipe.kitId,
    lotId: recipe.lotId,
    regionId: options.regionId,
    programHash: program.hash,
    entranceRoomId,
    floors,
    portals,
    stairs,
  });
  const unreachable = findUnreachableRooms(graph);
  if (unreachable.length > 0)
    throw new RoomContradictionError(
      `Rooms ${unreachable.join(",")} are cut off from entrance ${entranceRoomId}`,
    );
  return graph;
}

// Stair records lower to connector step parts: catalog stairs are
// flight meshes that fit no assembly run, so stairs are verified run
// geometry plus a material binding, not instances.

export type RoomStair = RoomGraph["stairs"][number];
export type RoomPortal = RoomGraph["portals"][number];

export interface ChunkedRoomStair {
  /** Export-scoped stair id: graph plus stair record ids. */
  readonly id: string;
  readonly graphId: string;
  readonly stair: RoomStair;
  readonly chunkId: string;
  readonly bounds: {
    readonly minimum: { readonly x: number; readonly y: number; readonly z: number };
    readonly maximum: { readonly x: number; readonly y: number; readonly z: number };
  };
}

export interface ChunkedRoomPortal {
  /** Export-scoped portal id: graph plus portal record ids. */
  readonly id: string;
  readonly graphId: string;
  readonly portal: RoomPortal;
  readonly chunkId: string;
}

export interface ChunkedRoomContent {
  readonly stairs: readonly ChunkedRoomStair[];
  readonly portals: readonly ChunkedRoomPortal[];
}

function stairRunDirection(yawStepsY90: number): { x: number; z: number } {
  const normalized = ((yawStepsY90 % 4) + 4) % 4;
  if (normalized === 0) return { x: 0, z: 1 };
  if (normalized === 1) return { x: 1, z: 0 };
  if (normalized === 2) return { x: 0, z: -1 };
  return { x: -1, z: 0 };
}

/**
 * Assign room stairs and portals to emission chunks. One call feeds
 * both emission deltas and the scene export so the two never disagree
 * about which chunk owns a run. Stairs chunk by run center; portals by
 * marker position.
 */
export function chunkRoomGraphContent(
  graphs: readonly RoomGraph[],
  chunkSizeStuds: number,
): ChunkedRoomContent {
  if (!Number.isFinite(chunkSizeStuds) || chunkSizeStuds <= 0)
    throw new Error("Room chunk size must be positive");
  const chunkIdFor = (x: number, z: number): string =>
    `chunk_${Math.floor(x / chunkSizeStuds)}_${Math.floor(z / chunkSizeStuds)}`;
  const stairs: ChunkedRoomStair[] = [];
  const portals: ChunkedRoomPortal[] = [];
  for (const graph of [...graphs].sort((left, right) => compareWorldStrings(left.id, right.id))) {
    for (const stair of graph.stairs) {
      const run = stairRunDirection(stair.yawStepsY90);
      const endX = stair.basePosition.x + run.x * stair.runLengthStuds;
      const endZ = stair.basePosition.z + run.z * stair.runLengthStuds;
      const halfWidth = stair.widthStuds / 2;
      const minimum = {
        x: Math.min(stair.basePosition.x, endX) - (run.x === 0 ? halfWidth : 0),
        y: stair.basePosition.y,
        z: Math.min(stair.basePosition.z, endZ) - (run.z === 0 ? halfWidth : 0),
      };
      const maximum = {
        x: Math.max(stair.basePosition.x, endX) + (run.x === 0 ? halfWidth : 0),
        y: stair.basePosition.y + stair.riseStuds,
        z: Math.max(stair.basePosition.z, endZ) + (run.z === 0 ? halfWidth : 0),
      };
      stairs.push({
        id: `${graph.id}_${stair.stairId}`,
        graphId: graph.id,
        stair,
        chunkId: chunkIdFor((minimum.x + maximum.x) / 2, (minimum.z + maximum.z) / 2),
        bounds: { minimum, maximum },
      });
    }
    for (const portal of graph.portals)
      portals.push({
        id: `${graph.id}_${portal.portalId}`,
        graphId: graph.id,
        portal,
        chunkId: chunkIdFor(portal.position.x, portal.position.z),
      });
  }
  stairs.sort((left, right) => compareWorldStrings(left.id, right.id));
  portals.sort((left, right) => compareWorldStrings(left.id, right.id));
  return { stairs, portals };
}

export interface WallAnchoredPlacement {
  readonly graphId: string;
  readonly roomId: string;
  readonly level: number;
  readonly floorY: number;
  readonly position: { readonly x: number; readonly y: number; readonly z: number };
  readonly yaw: number;
  readonly variant: number;
  readonly scale: number;
  readonly radius: number;
}

function seededRoomRandom(seed: string): () => number {
  return createMurmurHash3Random(Number.parseInt(seed.slice(0, 8), 16) >>> 0);
}

interface ClutterRoom extends PlateRect {
  readonly graphId: string;
  readonly roomId: string;
  readonly level: number;
  readonly floorY: number;
}

/**
 * Wall-anchored interior clutter: per-room seeded scatter along walls,
 * facing into the room, clearing portals and stair runs plus the shared
 * cross-family spacing grid. Counts reuse the density envelope over
 * room area, allocated by wall length.
 */
export function placeWallAnchoredClutter(input: {
  readonly graphs: readonly RoomGraph[];
  readonly family: Pick<
    WorldFamilyPopulationPlan,
    | "familyId"
    | "regionIds"
    | "excludedRegionIds"
    | "minimumCount"
    | "maximumCount"
    | "density"
    | "variationSeed"
    | "archetypeCount"
    | "scaleRange"
    | "elevationBandStuds"
  >;
  readonly evidence: ReadonlyMap<string, readonly GroundingArchetypeEvidence[]>;
  readonly planHash: string;
  readonly spacing: CrossFamilySpacing;
  readonly attemptsPerFamily?: number;
}): WallAnchoredPlacement[] {
  const { graphs, family } = input;
  const excluded = new Set(family.excludedRegionIds);
  const rooms: ClutterRoom[] = [];
  for (const graph of graphs) {
    if (!family.regionIds.includes(graph.regionId) || excluded.has(graph.regionId)) continue;
    for (const floor of graph.floors) {
      const band = family.elevationBandStuds;
      if (band?.minimum !== undefined && floor.baseYStuds < band.minimum) continue;
      if (band?.maximum !== undefined && floor.baseYStuds > band.maximum) continue;
      for (const room of floor.rooms)
        rooms.push({
          graphId: graph.id,
          roomId: room.roomId,
          level: floor.level,
          floorY: floor.baseYStuds,
          minX: room.minX,
          minZ: room.minZ,
          maxX: room.maxX,
          maxZ: room.maxZ,
        });
    }
  }
  rooms.sort(
    (left, right) =>
      compareWorldStrings(left.graphId, right.graphId) ||
      compareWorldStrings(left.roomId, right.roomId),
  );
  if (rooms.length === 0) return [];
  const totalArea = rooms.reduce(
    (sum, room) => sum + (room.maxX - room.minX) * (room.maxZ - room.minZ),
    0,
  );
  const estimatedTotal = Math.floor(
    (totalArea / DENSITY_AREA_NORMALIZATION_STUDS2) * family.density.target,
  );
  const totalCount = Math.min(family.maximumCount, Math.max(family.minimumCount, estimatedTotal));
  const allocations = allocateProportionalCounts(
    rooms.map((room) => ({
      key: `${room.graphId} ${room.roomId}`,
      weight: 2 * (room.maxX - room.minX + (room.maxZ - room.minZ)),
    })),
    totalCount,
  );
  const archetypeCount = family.archetypeCount ?? 1;
  const scaleRange = family.scaleRange ?? [0.92, 1.08];
  const attemptsPerFamily = input.attemptsPerFamily ?? 20;
  const graphsById = new Map(graphs.map((graph) => [graph.id, graph]));
  const placed: WallAnchoredPlacement[] = [];
  for (const room of rooms) {
    const count = allocations.get(`${room.graphId} ${room.roomId}`) ?? 0;
    if (count === 0) continue;
    const graph = graphsById.get(room.graphId)!;
    const levelRoomIds = new Set(
      graph.floors.find((floor) => floor.level === room.level)!.rooms.map((entry) => entry.roomId),
    );
    const portals = graph.portals.filter(
      (portal) =>
        levelRoomIds.has(portal.roomA) ||
        (portal.kind === "interior" && levelRoomIds.has(portal.roomB)),
    );
    const runs = graph.stairs
      .filter((stair) => stair.fromLevel === room.level || stair.toLevel === room.level)
      .map((stair) => {
        const alongZ = stair.yawStepsY90 % 2 === 0;
        return alongZ
          ? {
              minX: stair.basePosition.x - stair.widthStuds / 2,
              maxX: stair.basePosition.x + stair.widthStuds / 2,
              minZ: Math.min(stair.basePosition.z, stair.basePosition.z + stair.runLengthStuds),
              maxZ: Math.max(stair.basePosition.z, stair.basePosition.z + stair.runLengthStuds),
            }
          : {
              minX: Math.min(stair.basePosition.x, stair.basePosition.x + stair.runLengthStuds),
              maxX: Math.max(stair.basePosition.x, stair.basePosition.x + stair.runLengthStuds),
              minZ: stair.basePosition.z - stair.widthStuds / 2,
              maxZ: stair.basePosition.z + stair.widthStuds / 2,
            };
      });
    const rng = seededRoomRandom(
      contentHash(stableJson([family.variationSeed, family.familyId, room.graphId, room.roomId])),
    );
    // Walls walk minX, maxX, minZ, maxZ with inward yaw: +X, -X, +Z, -Z.
    const walls = [
      {
        yaw: Math.PI / 2,
        point: (along: number, inset: number) => ({ x: room.minX + inset, z: along }),
      },
      {
        yaw: -Math.PI / 2,
        point: (along: number, inset: number) => ({ x: room.maxX - inset, z: along }),
      },
      { yaw: 0, point: (along: number, inset: number) => ({ x: along, z: room.minZ + inset }) },
      {
        yaw: Math.PI,
        point: (along: number, inset: number) => ({ x: along, z: room.maxZ - inset }),
      },
    ];
    let accepted = 0;
    let attempts = 0;
    while (accepted < count && attempts < Math.max(count * attemptsPerFamily, 32)) {
      attempts += 1;
      const variantSeed = contentHash(
        stableJson([
          family.variationSeed,
          family.familyId,
          room.graphId,
          room.roomId,
          accepted,
          "variant",
        ]),
      );
      const variant = parseInt(variantSeed.slice(0, 8), 16) % archetypeCount;
      const scaleSeed = parseInt(variantSeed.slice(8, 16), 16) / 0xffff_ffff;
      const scale = scaleRange[0]! + (scaleRange[1]! - scaleRange[0]!) * scaleSeed;
      const variantEvidence = input.evidence.get(family.familyId)?.[variant];
      if (!variantEvidence)
        throw new Error(
          `Clutter has no grounding evidence for ${family.familyId} archetype ${variant}`,
        );
      const wall = walls[Math.floor(rng() * walls.length)]!;
      const edge =
        wall.yaw === 0 || wall.yaw === Math.PI
          ? { minimum: room.minX, maximum: room.maxX }
          : { minimum: room.minZ, maximum: room.maxZ };
      const radius = clearanceRadius(variantEvidence.contactRadiusStuds, scale);
      const inset = radius + ROOM_CLUTTER_WALL_INSET_STUDS;
      // Corner margin keeps the placed wall the nearest one; rooms
      // narrower than two insets degrade to center placement.
      const lo = edge.minimum + inset;
      const hi = edge.maximum - inset;
      const along = lo >= hi ? (edge.minimum + edge.maximum) / 2 : lo + rng() * (hi - lo);
      const flat = wall.point(along, inset);
      const position = { x: flat.x, y: room.floorY, z: flat.z };
      const span = {
        x: variantEvidence.boundsMaximumStuds.x - variantEvidence.boundsMinimumStuds.x,
        y: variantEvidence.boundsMaximumStuds.y - variantEvidence.boundsMinimumStuds.y,
        z: variantEvidence.boundsMaximumStuds.z - variantEvidence.boundsMinimumStuds.z,
      };
      const kind = groundingKindFromSpan(span);
      const inside = (x: number, z: number): boolean =>
        x >= room.minX && x <= room.maxX && z >= room.minZ && z <= room.maxZ;
      if (kind === "tall") {
        if (
          !inside(position.x - radius, position.z) ||
          !inside(position.x + radius, position.z) ||
          !inside(position.x, position.z - radius) ||
          !inside(position.x, position.z + radius)
        )
          continue;
      } else {
        const min = variantEvidence.boundsMinimumStuds;
        const max = variantEvidence.boundsMaximumStuds;
        const centerX = (min.x + max.x) / 2;
        const centerZ = (min.z + max.z) / 2;
        const cos = Math.cos(wall.yaw);
        const sin = Math.sin(wall.yaw);
        let cornersInside = true;
        for (const cornerX of [min.x, max.x])
          for (const cornerZ of [min.z, max.z]) {
            const localX = (cornerX - centerX) * scale;
            const localZ = (cornerZ - centerZ) * scale;
            if (
              !inside(
                position.x + localX * cos + localZ * sin,
                position.z - localX * sin + localZ * cos,
              )
            )
              cornersInside = false;
          }
        if (!cornersInside) continue;
      }
      let blocked = false;
      for (const portal of portals) {
        const gap = Math.hypot(position.x - portal.position.x, position.z - portal.position.z);
        if (gap < portal.widthStuds / 2 + ROOM_PORTAL_KEEPOUT_STUDS) blocked = true;
      }
      for (const run of runs) {
        const dx = Math.max(run.minX - position.x, 0, position.x - run.maxX);
        const dz = Math.max(run.minZ - position.z, 0, position.z - run.maxZ);
        if (Math.hypot(dx, dz) < radius) blocked = true;
      }
      if (blocked) continue;
      if (!input.spacing.tryClaim(position.x, position.z, radius)) continue;
      accepted += 1;
      placed.push({
        graphId: room.graphId,
        roomId: room.roomId,
        level: room.level,
        floorY: room.floorY,
        position,
        yaw: wall.yaw,
        variant,
        scale,
        radius,
      });
    }
  }
  return placed;
}
