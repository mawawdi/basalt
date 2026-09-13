import { z } from "zod";
import {
  HASH_SCHEMA,
  compareCanonicalStrings,
  contentAddressedEntityId,
  contentHash,
  deepFreezeJson,
  stableJson,
} from "@basalt/contracts";
import { CATALOG_REQUIREMENT_SCHEMA, REALIZATION_INTENT_SCHEMA } from "@basalt/catalog-model";
import {
  SEMANTIC_ADMITTED_ASSERTION_BUNDLE_SCHEMA,
  UPPER_SORT_SCHEMA,
} from "@basalt/semantic-kernel";
import { COMPILER_RENDER_READABILITY_INTENT_SCHEMA } from "@basalt/spatial-core";

const finite = z.number().finite();
const positive = finite.positive();
const nonnegative = finite.nonnegative();
export const WORLD_ENTITY_ID_SCHEMA = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u);
export const WORLD_VECTOR3_SCHEMA = z.object({ x: finite, y: finite, z: finite }).strict();
export const WORLD_POINT2_SCHEMA = z.object({ x: finite, z: finite }).strict();
export const WORLD_AABB_SCHEMA = z
  .object({ min: WORLD_VECTOR3_SCHEMA, max: WORLD_VECTOR3_SCHEMA })
  .strict()
  .refine(
    ({ min, max }) => min.x <= max.x && min.y <= max.y && min.z <= max.z,
    "World bounds are inverted",
  );
export type WorldVector3 = z.output<typeof WORLD_VECTOR3_SCHEMA>;
export type WorldPoint2 = z.output<typeof WORLD_POINT2_SCHEMA>;

export const WORLD_POLYGON_SCHEMA = z
  .array(WORLD_POINT2_SCHEMA)
  .min(3)
  .max(4096)
  .superRefine((points, context) => {
    if (Math.abs(polygonArea(points)) <= 1e-9)
      context.addIssue({ code: "custom", message: "World polygon has zero area" });
  });

export const WORLD_REGION_VOLUME_SCHEMA = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("box"), bounds: WORLD_AABB_SCHEMA }).strict(),
  z
    .object({
      kind: z.literal("extruded_polygon"),
      footprint: WORLD_POLYGON_SCHEMA,
      verticalRangeMeters: z.object({ minimum: finite, maximum: finite }).strict(),
    })
    .strict()
    .refine(
      (value) => value.verticalRangeMeters.minimum < value.verticalRangeMeters.maximum,
      "Region vertical range is inverted",
    ),
]);
export type WorldRegionVolume = z.output<typeof WORLD_REGION_VOLUME_SCHEMA>;

export const PLACEMENT_SURFACE_SCHEMA = z
  .object({
    surfaceId: WORLD_ENTITY_ID_SCHEMA,
    regionId: WORLD_ENTITY_ID_SCHEMA,
    kind: z.enum([
      "terrain",
      "constructed_floor",
      "constructed_wall",
      "constructed_ceiling",
      "water",
      "route",
    ]),
    bounds: WORLD_AABB_SCHEMA,
    normal: WORLD_VECTOR3_SCHEMA.refine(
      (value) => Math.hypot(value.x, value.y, value.z) > 1e-9,
      "Surface normal cannot be zero",
    ),
    sourceHash: HASH_SCHEMA,
  })
  .strict();
export type PlacementSurface = z.output<typeof PLACEMENT_SURFACE_SCHEMA>;

export const PLANNED_SEMANTIC_ENTITY_SCHEMA = z
  .object({
    entityId: WORLD_ENTITY_ID_SCHEMA,
    upperSort: UPPER_SORT_SCHEMA,
    regionId: WORLD_ENTITY_ID_SCHEMA.optional(),
    semanticDependencyClosureHash: HASH_SCHEMA,
    admittedAssertionBundleHash: HASH_SCHEMA,
    relationAssertionBundleHash: HASH_SCHEMA.optional(),
  })
  .strict();

const regionSchema = z
  .object({
    regionId: WORLD_ENTITY_ID_SCHEMA,
    semanticEntityId: WORLD_ENTITY_ID_SCHEMA,
    volume: WORLD_REGION_VOLUME_SCHEMA,
    refinementPriority: z.number().int().min(-1_000_000).max(1_000_000),
  })
  .strict();

export const TERRAIN_OPERATION_SCHEMA = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("raise"),
      center: WORLD_POINT2_SCHEMA,
      radiusMeters: positive,
      deltaMeters: finite,
    })
    .strict(),
  z
    .object({
      kind: z.literal("flatten"),
      polygon: WORLD_POLYGON_SCHEMA,
      elevationMeters: finite,
      blendWidthMeters: nonnegative,
    })
    .strict(),
  z
    .object({
      kind: z.literal("carve"),
      center: WORLD_POINT2_SCHEMA,
      radiusMeters: positive,
      depthMeters: positive,
    })
    .strict(),
]);
export const TERRAIN_PLAN_SCHEMA = z
  .object({
    terrainPlanId: WORLD_ENTITY_ID_SCHEMA,
    surfaceId: WORLD_ENTITY_ID_SCHEMA,
    regionIds: z.array(WORLD_ENTITY_ID_SCHEMA).min(1).max(4096),
    boundsMeters: z
      .object({
        x: z.object({ minimum: finite, maximum: finite }).strict(),
        z: z.object({ minimum: finite, maximum: finite }).strict(),
      })
      .strict(),
    resolution: z
      .object({
        columns: z.number().int().min(2).max(8192),
        rows: z.number().int().min(2).max(8192),
      })
      .strict(),
    baseElevationMeters: finite,
    operations: z.array(TERRAIN_OPERATION_SCHEMA).max(65_536),
    materialId: WORLD_ENTITY_ID_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.boundsMeters.x.minimum >= value.boundsMeters.x.maximum ||
      value.boundsMeters.z.minimum >= value.boundsMeters.z.maximum
    )
      context.addIssue({ code: "custom", message: "Terrain bounds must have positive extent" });
  });
export type TerrainPlan = z.output<typeof TERRAIN_PLAN_SCHEMA>;

export const WORLD_ROUTE_SCHEMA = z
  .object({
    routeId: WORLD_ENTITY_ID_SCHEMA,
    semanticEntityId: WORLD_ENTITY_ID_SCHEMA,
    regionIds: z.array(WORLD_ENTITY_ID_SCHEMA).min(1).max(4096),
    surfaceId: WORLD_ENTITY_ID_SCHEMA,
    pointsMeters: z.array(WORLD_VECTOR3_SCHEMA).min(2).max(65_536),
    widthMeters: positive,
    heightClearanceMeters: positive,
    closed: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    for (let index = 1; index < value.pointsMeters.length; index += 1) {
      const left = value.pointsMeters[index - 1]!;
      const right = value.pointsMeters[index]!;
      if (Math.hypot(right.x - left.x, right.y - left.y, right.z - left.z) <= 1e-9)
        context.addIssue({
          code: "custom",
          path: ["pointsMeters", index],
          message: "Route segments cannot have zero length",
        });
    }
    if (value.closed) {
      if (value.pointsMeters.length < 4)
        context.addIssue({
          code: "custom",
          path: ["pointsMeters"],
          message: "A closed route requires at least three vertices and a repeated endpoint",
        });
      const first = value.pointsMeters[0]!;
      const last = value.pointsMeters[value.pointsMeters.length - 1]!;
      if (Math.hypot(last.x - first.x, last.y - first.y, last.z - first.z) > 1e-9)
        context.addIssue({
          code: "custom",
          path: ["pointsMeters", value.pointsMeters.length - 1],
          message: "A closed route must repeat its first point as its final point",
        });
      const unique = new Set(
        value.pointsMeters
          .slice(0, -1)
          .map((point) => `${point.x.toString()},${point.y.toString()},${point.z.toString()}`),
      );
      if (unique.size < 3)
        context.addIssue({
          code: "custom",
          path: ["pointsMeters"],
          message: "A closed route requires at least three distinct vertices",
        });
    }
  });
export type WorldRoute = z.output<typeof WORLD_ROUTE_SCHEMA>;

export const LOT_SUBDIVISION_POLICY_SCHEMA = z
  .object({
    policyId: WORLD_ENTITY_ID_SCHEMA,
    regionId: WORLD_ENTITY_ID_SCHEMA,
    cellMeters: positive.max(1000),
    minimumLotMeters: positive.max(10_000),
    maximumLotMeters: positive.max(10_000),
    routeMarginMeters: nonnegative.max(1000),
    maximumLots: z.number().int().positive().max(100_000),
  })
  .strict()
  .refine((value) => value.minimumLotMeters <= value.maximumLotMeters, "Lot range is inverted");
export type LotSubdivisionPolicy = z.output<typeof LOT_SUBDIVISION_POLICY_SCHEMA>;

const structuralSlotSchema = z
  .object({
    slotId: WORLD_ENTITY_ID_SCHEMA,
    floorIndex: z.number().int().nonnegative().max(255),
    roleSchemeId: z.string().regex(/^brs_[0-9]{6}$/u),
    roleId: z.string().regex(/^bro_[0-9]{6}$/u),
    minimumCount: z.number().int().nonnegative(),
    maximumCount: z.number().int().nonnegative(),
  })
  .strict();
const structuralCellReference = z
  .object({ slotId: WORLD_ENTITY_ID_SCHEMA, ordinal: z.number().int().nonnegative().max(65_535) })
  .strict();
export const STRUCTURAL_PROGRAM_SCHEMA = z
  .object({
    programId: WORLD_ENTITY_ID_SCHEMA,
    regionId: WORLD_ENTITY_ID_SCHEMA,
    floorCount: z.number().int().positive().max(256),
    floorHeightMeters: positive.max(1000),
    slots: z.array(structuralSlotSchema).min(1).max(4096),
    placements: z
      .array(
        z
          .object({
            cell: structuralCellReference,
            lattice: z
              .object({
                x: z.number().int().min(-65_535).max(65_535),
                y: z.number().int().min(-65_535).max(65_535),
                z: z.number().int().min(-65_535).max(65_535),
                yawQuarterTurns: z.number().int().min(0).max(3),
              })
              .strict(),
          })
          .strict(),
      )
      .min(1)
      .max(65_536),
    connections: z
      .array(
        z
          .object({
            connectionId: WORLD_ENTITY_ID_SCHEMA,
            host: structuralCellReference
              .extend({ interfaceId: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u) })
              .strict(),
            child: structuralCellReference
              .extend({ interfaceId: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u) })
              .strict(),
          })
          .strict(),
      )
      .max(262_144),
    constructedSurfaces: z
      .array(
        z
          .object({
            surfaceId: WORLD_ENTITY_ID_SCHEMA,
            kind: z.enum(["constructed_floor", "constructed_wall", "constructed_ceiling"]),
            source: structuralCellReference,
            localNormal: WORLD_VECTOR3_SCHEMA.refine(
              (value) => Math.hypot(value.x, value.y, value.z) > 1e-9,
              "Constructed surface normal cannot be zero",
            ),
          })
          .strict(),
      )
      .max(65_536),
    portals: z
      .array(
        z
          .object({
            portalId: WORLD_ENTITY_ID_SCHEMA,
            source: structuralCellReference,
            socketId: z.string().trim().min(1).max(128),
            widthMeters: positive,
            heightMeters: positive,
            clearanceMeters: nonnegative,
            adjacentRoomIds: z.array(WORLD_ENTITY_ID_SCHEMA).min(1).max(2),
          })
          .strict(),
      )
      .max(65_536),
    rooms: z
      .array(
        z
          .object({
            roomId: WORLD_ENTITY_ID_SCHEMA,
            floorIndex: z.number().int().nonnegative().max(255),
            semanticEntityId: WORLD_ENTITY_ID_SCHEMA,
            surfaceIds: z.array(WORLD_ENTITY_ID_SCHEMA).min(1).max(4096),
            portalIds: z.array(WORLD_ENTITY_ID_SCHEMA).max(4096),
          })
          .strict(),
      )
      .max(65_536),
    proceduralStairs: z
      .array(
        z
          .object({
            generatorId: WORLD_ENTITY_ID_SCHEMA,
            fromFloor: z.number().int().nonnegative(),
            toFloor: z.number().int().positive(),
            widthMeters: positive,
            treadDepthMeters: positive,
            maximumRiserHeightMeters: positive,
            originLattice: z
              .object({
                x: z.number().int().min(-65_535).max(65_535),
                y: z.number().int().min(-65_535).max(65_535),
                z: z.number().int().min(-65_535).max(65_535),
                yawQuarterTurns: z.number().int().min(0).max(3),
              })
              .strict(),
          })
          .strict(),
      )
      .max(255),
  })
  .strict()
  .superRefine((value, context) => {
    const uniqueAt = (values: readonly string[], path: string, label: string) => {
      if (new Set(values).size !== values.length)
        context.addIssue({ code: "custom", path: [path], message: `${label} must be unique` });
    };
    uniqueAt(
      value.slots.map((slot) => slot.slotId),
      "slots",
      "Structural slot IDs",
    );
    uniqueAt(
      value.connections.map((connection) => connection.connectionId),
      "connections",
      "Connection IDs",
    );
    uniqueAt(
      value.constructedSurfaces.map((surface) => surface.surfaceId),
      "constructedSurfaces",
      "Constructed surface IDs",
    );
    uniqueAt(
      value.portals.map((portal) => portal.portalId),
      "portals",
      "Portal IDs",
    );
    uniqueAt(
      value.rooms.map((room) => room.roomId),
      "rooms",
      "Room IDs",
    );
    uniqueAt(
      value.proceduralStairs.map((stair) => stair.generatorId),
      "proceduralStairs",
      "Procedural stair generator IDs",
    );
    const slots = new Map(value.slots.map((slot) => [slot.slotId, slot]));
    for (const [index, slot] of value.slots.entries())
      if (slot.floorIndex >= value.floorCount)
        context.addIssue({
          code: "custom",
          path: ["slots", index, "floorIndex"],
          message: "Structural slot floor is outside the program",
        });
    const cellKey = (cell: z.output<typeof structuralCellReference>) =>
      `${cell.slotId}:${cell.ordinal}`;
    const expectedCells = value.slots.flatMap((slot) =>
      Array.from({ length: slot.minimumCount }, (_, ordinal) => `${slot.slotId}:${ordinal}`),
    );
    const placedCells = value.placements.map((placement) => cellKey(placement.cell));
    if (
      new Set(placedCells).size !== placedCells.length ||
      stableJson([...placedCells].sort(compareCanonicalStrings)) !==
        stableJson([...expectedCells].sort(compareCanonicalStrings))
    )
      context.addIssue({
        code: "custom",
        path: ["placements"],
        message: "Placements must cover every minimum structural cell exactly once",
      });
    const validCell = (cell: z.output<typeof structuralCellReference>) => {
      const slot = slots.get(cell.slotId);
      return slot !== undefined && cell.ordinal < slot.minimumCount;
    };
    for (const [index, connection] of value.connections.entries()) {
      if (!validCell(connection.host) || !validCell(connection.child))
        context.addIssue({
          code: "custom",
          path: ["connections", index],
          message: "Connection references an unknown structural cell",
        });
      if (cellKey(connection.host) === cellKey(connection.child))
        context.addIssue({
          code: "custom",
          path: ["connections", index],
          message: "Connection cannot join a cell to itself",
        });
    }
    for (const [index, surface] of value.constructedSurfaces.entries()) {
      if (!validCell(surface.source))
        context.addIssue({
          code: "custom",
          path: ["constructedSurfaces", index],
          message: "Constructed surface references an unknown structural cell",
        });
      const normal = surface.localNormal;
      if (surface.kind === "constructed_wall" && Math.abs(normal.y) > 1e-6)
        context.addIssue({
          code: "custom",
          path: ["constructedSurfaces", index, "localNormal"],
          message: "A constructed wall normal must be horizontal",
        });
      if (surface.kind === "constructed_floor" && normal.y <= 0)
        context.addIssue({
          code: "custom",
          path: ["constructedSurfaces", index, "localNormal"],
          message: "A constructed floor normal must face upward",
        });
      if (surface.kind === "constructed_ceiling" && normal.y >= 0)
        context.addIssue({
          code: "custom",
          path: ["constructedSurfaces", index, "localNormal"],
          message: "A constructed ceiling normal must face downward",
        });
    }
    const surfaceFloor = new Map(
      value.constructedSurfaces.map((surface) => [
        surface.surfaceId,
        slots.get(surface.source.slotId)?.floorIndex,
      ]),
    );
    const roomFloor = new Map(value.rooms.map((room) => [room.roomId, room.floorIndex]));
    const portalFloor = new Map(
      value.portals.map((portal) => [portal.portalId, slots.get(portal.source.slotId)?.floorIndex]),
    );
    for (const [index, room] of value.rooms.entries()) {
      if (room.floorIndex >= value.floorCount)
        context.addIssue({
          code: "custom",
          path: ["rooms", index, "floorIndex"],
          message: "Room floor is outside the program",
        });
      if (room.surfaceIds.some((surfaceId) => surfaceFloor.get(surfaceId) !== room.floorIndex))
        context.addIssue({
          code: "custom",
          path: ["rooms", index, "surfaceIds"],
          message: "Room surfaces must belong to the room floor",
        });
      if (room.portalIds.some((portalId) => portalFloor.get(portalId) !== room.floorIndex))
        context.addIssue({
          code: "custom",
          path: ["rooms", index, "portalIds"],
          message: "Room portals must belong to the room floor",
        });
    }
    for (const [index, portal] of value.portals.entries()) {
      const floorIndex = portalFloor.get(portal.portalId);
      if (portal.adjacentRoomIds.some((roomId) => roomFloor.get(roomId) !== floorIndex))
        context.addIssue({
          code: "custom",
          path: ["portals", index, "adjacentRoomIds"],
          message: "Portal-adjacent rooms must share the portal floor",
        });
    }
    const roomIds = new Set(value.rooms.map((room) => room.roomId));
    const surfaceIds = new Set(value.constructedSurfaces.map((surface) => surface.surfaceId));
    const portalIds = new Set(value.portals.map((portal) => portal.portalId));
    for (const [index, portal] of value.portals.entries()) {
      if (!validCell(portal.source))
        context.addIssue({
          code: "custom",
          path: ["portals", index],
          message: "Portal references an unknown structural cell",
        });
      if (portal.adjacentRoomIds.some((roomId) => !roomIds.has(roomId)))
        context.addIssue({
          code: "custom",
          path: ["portals", index, "adjacentRoomIds"],
          message: "Portal references an unknown room",
        });
    }
    for (const [index, room] of value.rooms.entries()) {
      if (room.surfaceIds.some((surfaceId) => !surfaceIds.has(surfaceId)))
        context.addIssue({
          code: "custom",
          path: ["rooms", index, "surfaceIds"],
          message: "Room references an unknown constructed surface",
        });
      if (room.portalIds.some((portalId) => !portalIds.has(portalId)))
        context.addIssue({
          code: "custom",
          path: ["rooms", index, "portalIds"],
          message: "Room references an unknown portal",
        });
    }
    for (const [index, slot] of value.slots.entries())
      if (slot.minimumCount > slot.maximumCount)
        context.addIssue({
          code: "custom",
          path: ["slots", index],
          message: "Structural slot count is inverted",
        });
    for (const [index, stair] of value.proceduralStairs.entries())
      if (
        stair.fromFloor >= value.floorCount ||
        stair.toFloor >= value.floorCount ||
        stair.fromFloor >= stair.toFloor
      )
        context.addIssue({
          code: "custom",
          path: ["proceduralStairs", index],
          message: "Procedural stair floors are invalid",
        });
  });
export type StructuralProgram = z.output<typeof STRUCTURAL_PROGRAM_SCHEMA>;

export const WORLD_CAMERA_SCHEMA = z
  .object({
    cameraId: WORLD_ENTITY_ID_SCHEMA,
    positionMeters: WORLD_VECTOR3_SCHEMA,
    lookAtMeters: WORLD_VECTOR3_SCHEMA,
    up: WORLD_VECTOR3_SCHEMA.refine(
      (value) => Math.hypot(value.x, value.y, value.z) > 1e-9,
      "Camera up cannot be zero",
    ),
    fieldOfViewDegrees: finite.min(1).max(179),
    regionIds: z.array(WORLD_ENTITY_ID_SCHEMA).max(4096),
    readabilityIntent: COMPILER_RENDER_READABILITY_INTENT_SCHEMA,
  })
  .strict();

export const SPATIAL_WORLD_PLAN_SCHEMA = z
  .object({
    kind: z.literal("SpatialWorldPlan"),
    planId: WORLD_ENTITY_ID_SCHEMA,
    coordinateSystem: z.literal("right_handed_y_up_meters"),
    seed: z.number().int().min(0).max(0xffff_ffff),
    boundsMeters: WORLD_AABB_SCHEMA,
    semanticEntities: z.array(PLANNED_SEMANTIC_ENTITY_SCHEMA).max(100_000),
    admittedAssertions: z.array(SEMANTIC_ADMITTED_ASSERTION_BUNDLE_SCHEMA).max(100_000),
    regions: z.array(regionSchema).min(1).max(4096),
    placementSurfaces: z.array(PLACEMENT_SURFACE_SCHEMA).max(65_536),
    terrainPlans: z.array(TERRAIN_PLAN_SCHEMA).max(4096),
    routes: z.array(WORLD_ROUTE_SCHEMA).max(65_536),
    lotPolicies: z.array(LOT_SUBDIVISION_POLICY_SCHEMA).max(4096),
    structuralPrograms: z.array(STRUCTURAL_PROGRAM_SCHEMA).max(4096),
    catalogRequirements: z.array(CATALOG_REQUIREMENT_SCHEMA).max(65_536),
    realizationIntents: z.array(REALIZATION_INTENT_SCHEMA).max(65_536),
    cameras: z.array(WORLD_CAMERA_SCHEMA).max(4096),
    planHash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => validateWorldPlan(value, context));
export type SpatialWorldPlan = z.output<typeof SPATIAL_WORLD_PLAN_SCHEMA>;

export const INTENT_INTERPRETATION_TRACE_SCHEMA = z
  .object({
    kind: z.literal("IntentInterpretationTrace"),
    creatorIntentHash: HASH_SCHEMA,
    semanticModuleHash: HASH_SCHEMA,
    semanticLexiconHash: HASH_SCHEMA,
    hypothesisBundleHashes: z.array(HASH_SCHEMA).max(65_536),
    modelImplementationHash: HASH_SCHEMA,
    compilerAuthority: z.literal(false),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => verifyHash(value, "hash", context));

export function sealSpatialWorldPlan(
  input: Omit<SpatialWorldPlan, "kind" | "coordinateSystem" | "planHash">,
): SpatialWorldPlan {
  const material = canonicalPlan({
    kind: "SpatialWorldPlan" as const,
    coordinateSystem: "right_handed_y_up_meters" as const,
    ...input,
  });
  return deepFreezeJson(
    SPATIAL_WORLD_PLAN_SCHEMA.parse({
      ...material,
      planHash: contentHash(stableJson(material)),
    }),
  ) as SpatialWorldPlan;
}

export function sealIntentInterpretationTrace(
  input: Omit<
    z.output<typeof INTENT_INTERPRETATION_TRACE_SCHEMA>,
    "kind" | "compilerAuthority" | "hash"
  >,
): z.output<typeof INTENT_INTERPRETATION_TRACE_SCHEMA> {
  const material = {
    kind: "IntentInterpretationTrace" as const,
    ...input,
    hypothesisBundleHashes: canonicalUnique(input.hypothesisBundleHashes),
    compilerAuthority: false as const,
  };
  return deepFreezeJson(
    INTENT_INTERPRETATION_TRACE_SCHEMA.parse({
      ...material,
      hash: contentHash(stableJson(material)),
    }),
  );
}

export function worldRegionContainsPoint(
  region: z.output<typeof regionSchema>,
  point: WorldVector3,
): boolean {
  const volume = region.volume;
  if (volume.kind === "box")
    return axes.every(
      (axis) => point[axis] >= volume.bounds.min[axis] && point[axis] <= volume.bounds.max[axis],
    );
  return (
    point.y >= volume.verticalRangeMeters.minimum &&
    point.y <= volume.verticalRangeMeters.maximum &&
    pointInPolygon({ x: point.x, z: point.z }, volume.footprint)
  );
}

export function worldRegionVolumeBounds(
  volume: WorldRegionVolume,
): z.output<typeof WORLD_AABB_SCHEMA> {
  if (volume.kind === "box") return volume.bounds;
  return {
    min: {
      x: Math.min(...volume.footprint.map((entry) => entry.x)),
      y: volume.verticalRangeMeters.minimum,
      z: Math.min(...volume.footprint.map((entry) => entry.z)),
    },
    max: {
      x: Math.max(...volume.footprint.map((entry) => entry.x)),
      y: volume.verticalRangeMeters.maximum,
      z: Math.max(...volume.footprint.map((entry) => entry.z)),
    },
  };
}

function canonicalPlan<T extends Omit<SpatialWorldPlan, "planHash">>(value: T): T {
  const by = <E>(entries: readonly E[], key: (entry: E) => string) =>
    [...entries].sort((a, b) => compareCanonicalStrings(key(a), key(b)));
  const structuralPrograms = by(value.structuralPrograms, (entry) => entry.programId).map(
    (program) => ({
      ...program,
      slots: by(program.slots, (slot) => slot.slotId),
      placements: by(
        program.placements,
        (placement) =>
          `${placement.cell.slotId}:${placement.cell.ordinal.toString().padStart(5, "0")}`,
      ),
      connections: by(program.connections, (connection) => connection.connectionId),
      constructedSurfaces: by(program.constructedSurfaces, (surface) => surface.surfaceId),
      portals: by(program.portals, (portal) => portal.portalId).map((portal) => ({
        ...portal,
        adjacentRoomIds: [...portal.adjacentRoomIds].sort(compareCanonicalStrings),
      })),
      rooms: by(program.rooms, (room) => room.roomId).map((room) => ({
        ...room,
        surfaceIds: [...room.surfaceIds].sort(compareCanonicalStrings),
        portalIds: [...room.portalIds].sort(compareCanonicalStrings),
      })),
      proceduralStairs: [...program.proceduralStairs].sort((left, right) =>
        compareCanonicalStrings(left.generatorId, right.generatorId),
      ),
    }),
  );
  return {
    ...value,
    semanticEntities: by(value.semanticEntities, (entry) => entry.entityId),
    admittedAssertions: by(value.admittedAssertions, (entry) => entry.hash),
    regions: by(value.regions, (entry) => entry.regionId),
    placementSurfaces: by(value.placementSurfaces, (entry) => entry.surfaceId),
    terrainPlans: by(value.terrainPlans, (entry) => entry.terrainPlanId),
    routes: by(value.routes, (entry) => entry.routeId),
    lotPolicies: by(value.lotPolicies, (entry) => entry.policyId),
    structuralPrograms,
    catalogRequirements: by(value.catalogRequirements, (entry) => entry.requirementId),
    realizationIntents: by(value.realizationIntents, (entry) => entry.intentId),
    cameras: by(value.cameras, (entry) => entry.cameraId),
  };
}

function validateWorldPlan(value: SpatialWorldPlan, context: z.RefinementCtx): void {
  const material = { ...value };
  delete (material as Partial<SpatialWorldPlan>).planHash;
  if (contentHash(stableJson(material)) !== value.planHash)
    context.addIssue({ code: "custom", path: ["planHash"], message: "World plan hash mismatch" });
  const unique = (values: readonly string[], label: string) => {
    if (new Set(values).size !== values.length)
      context.addIssue({ code: "custom", message: `${label} IDs must be unique` });
  };
  unique(
    value.semanticEntities.map((entry) => entry.entityId),
    "Semantic entity",
  );
  unique(
    value.regions.map((entry) => entry.regionId),
    "Region",
  );
  unique(
    value.placementSurfaces.map((entry) => entry.surfaceId),
    "Surface",
  );
  unique(
    value.routes.map((entry) => entry.routeId),
    "Route",
  );
  unique(
    value.catalogRequirements.map((entry) => entry.requirementId),
    "Requirement",
  );
  unique(
    value.realizationIntents.map((entry) => entry.intentId),
    "Intent",
  );
  const regions = new Set(value.regions.map((entry) => entry.regionId));
  const generatedSurfaces = value.structuralPrograms.flatMap((program) =>
    program.constructedSurfaces.map((surface) => ({ ...surface, regionId: program.regionId })),
  );
  const generatedSurfaceIds = generatedSurfaces.map((surface) => surface.surfaceId);
  const generatedPortalIds = value.structuralPrograms.flatMap((program) =>
    program.portals.map((portal) => portal.portalId),
  );
  const generatedRoomIds = value.structuralPrograms.flatMap((program) =>
    program.rooms.map((room) => room.roomId),
  );
  const generatedStairIds = value.structuralPrograms.flatMap((program) =>
    program.proceduralStairs.map((stair) => stair.generatorId),
  );
  const foundationSurfaceIds = new Set(value.placementSurfaces.map((entry) => entry.surfaceId));
  const surfaces = new Set([...foundationSurfaceIds, ...generatedSurfaceIds]);
  const surfaceRegionById = new Map<string, string>([
    ...value.placementSurfaces.map((entry) => [entry.surfaceId, entry.regionId] as const),
    ...generatedSurfaces.map((entry) => [entry.surfaceId, entry.regionId] as const),
  ]);
  const entities = new Set(value.semanticEntities.map((entry) => entry.entityId));
  const entityById = new Map(value.semanticEntities.map((entry) => [entry.entityId, entry]));
  const requirements = new Set(value.catalogRequirements.map((entry) => entry.requirementId));
  const requirementById = new Map(
    value.catalogRequirements.map((entry) => [entry.requirementId, entry]),
  );
  const assertionBundles = new Map(value.admittedAssertions.map((entry) => [entry.hash, entry]));
  if (assertionBundles.size !== value.admittedAssertions.length)
    context.addIssue({
      code: "custom",
      message: "Admitted assertion bundle hashes must be unique",
    });
  for (const entity of value.semanticEntities) {
    if (entity.regionId && !regions.has(entity.regionId))
      context.addIssue({
        code: "custom",
        message: `Semantic entity ${entity.entityId} has unknown region`,
      });
    const bundle = assertionBundles.get(entity.admittedAssertionBundleHash);
    if (!bundle)
      context.addIssue({
        code: "custom",
        message: `Semantic entity ${entity.entityId} lacks its admitted assertions`,
      });
    else if (
      !bundle.assertions.some(
        (assertion) =>
          assertion.assertionKind === "denotation" &&
          assertion.subject.kind === "planned_entity" &&
          assertion.subject.id === entity.entityId,
      )
    )
      context.addIssue({
        code: "custom",
        message: `Semantic entity ${entity.entityId} lacks exact denotation authority`,
      });
    if (entity.relationAssertionBundleHash) {
      const relationBundle = assertionBundles.get(entity.relationAssertionBundleHash);
      if (!relationBundle)
        context.addIssue({
          code: "custom",
          message: `Semantic entity ${entity.entityId} lacks its relation assertions`,
        });
      else if (
        !relationBundle.assertions.some(
          (assertion) =>
            assertion.assertionKind === "relation" &&
            assertion.subject.kind === "planned_entity" &&
            assertion.subject.id === entity.entityId,
        )
      )
        context.addIssue({
          code: "custom",
          message: `Semantic entity ${entity.entityId} relation bundle has no exact subject relation`,
        });
    }
  }
  for (const region of value.regions)
    if (!entities.has(region.semanticEntityId))
      context.addIssue({
        code: "custom",
        message: `Region ${region.regionId} has no semantic entity`,
      });
  for (const surface of value.placementSurfaces)
    if (!regions.has(surface.regionId))
      context.addIssue({
        code: "custom",
        message: `Surface ${surface.surfaceId} has unknown region`,
      });
  for (const terrain of value.terrainPlans) {
    if (!foundationSurfaceIds.has(terrain.surfaceId))
      context.addIssue({
        code: "custom",
        message: `Terrain ${terrain.terrainPlanId} has unknown surface`,
      });
    if (terrain.regionIds.some((id) => !regions.has(id)))
      context.addIssue({
        code: "custom",
        message: `Terrain ${terrain.terrainPlanId} has unknown region`,
      });
  }
  for (const route of value.routes) {
    if (!entities.has(route.semanticEntityId))
      context.addIssue({
        code: "custom",
        message: `Route ${route.routeId} has no semantic entity`,
      });
    if (!foundationSurfaceIds.has(route.surfaceId))
      context.addIssue({ code: "custom", message: `Route ${route.routeId} has unknown surface` });
    if (route.regionIds.some((id) => !regions.has(id)))
      context.addIssue({ code: "custom", message: `Route ${route.routeId} has unknown region` });
  }
  const routes = new Set(value.routes.map((entry) => entry.routeId));
  const lotPolicies = new Set(value.lotPolicies.map((entry) => entry.policyId));
  const programs = new Set(value.structuralPrograms.map((entry) => entry.programId));
  for (const intent of value.realizationIntents) {
    if (!requirements.has(intent.requirementId))
      context.addIssue({
        code: "custom",
        message: `Intent ${intent.intentId} has unknown requirement`,
      });
    const requirement = requirementById.get(intent.requirementId);
    const expectedKind =
      intent.kind === "assembly"
        ? "assembly_kit"
        : intent.kind === "route_network"
          ? "route_kit"
          : intent.kind === "socket_attachment" || intent.kind === "wall_attachment"
            ? "attachment_set"
            : intent.kind === "environment_layer"
              ? "environment_realizer"
              : "substitution_set";
    if (requirement && !requirement.acceptedEntryKinds.includes(expectedKind))
      context.addIssue({
        code: "custom",
        message: `Intent ${intent.intentId} requires ${expectedKind}, which its requirement excludes`,
      });
    if (
      (intent.kind === "single" ||
        intent.kind === "surface_scatter" ||
        intent.kind === "cluster" ||
        intent.kind === "surface_grid" ||
        intent.kind === "wall_attachment") &&
      (!regions.has(intent.regionId) || !surfaces.has(intent.surfaceId))
    )
      context.addIssue({
        code: "custom",
        message: `Intent ${intent.intentId} has an unknown region or surface`,
      });
    if (
      "regionId" in intent &&
      "surfaceId" in intent &&
      surfaceRegionById.get(intent.surfaceId) !== intent.regionId
    )
      context.addIssue({
        code: "custom",
        message: `Intent ${intent.intentId} targets a surface in another region`,
      });
    if (
      intent.kind === "along_route" &&
      (!regions.has(intent.regionId) || !routes.has(intent.routeId))
    )
      context.addIssue({
        code: "custom",
        message: `Intent ${intent.intentId} has an unknown region or route`,
      });
    if (
      intent.kind === "along_route" &&
      !value.routes
        .find((route) => route.routeId === intent.routeId)
        ?.regionIds.includes(intent.regionId)
    )
      context.addIssue({
        code: "custom",
        message: `Intent ${intent.intentId} targets a route outside its region`,
      });
    if (intent.kind === "route_network" && intent.routeIds.some((id) => !routes.has(id)))
      context.addIssue({
        code: "custom",
        message: `Intent ${intent.intentId} has an unknown route`,
      });
    if (
      intent.kind === "assembly" &&
      (!regions.has(intent.regionId) ||
        !lotPolicies.has(intent.lotPolicyId) ||
        !programs.has(intent.programId))
    )
      context.addIssue({
        code: "custom",
        message: `Intent ${intent.intentId} has an unknown structural target`,
      });
    if (intent.kind === "assembly") {
      const policy = value.lotPolicies.find(
        (candidate) => candidate.policyId === intent.lotPolicyId,
      );
      const program = value.structuralPrograms.find(
        (candidate) => candidate.programId === intent.programId,
      );
      if (policy?.regionId !== intent.regionId || program?.regionId !== intent.regionId)
        context.addIssue({
          code: "custom",
          message: `Intent ${intent.intentId} structural targets belong to another region`,
        });
    }
    if (intent.kind === "environment_layer" && intent.regionIds.some((id) => !regions.has(id)))
      context.addIssue({
        code: "custom",
        message: `Intent ${intent.intentId} has an unknown region`,
      });
  }
  for (const policy of value.lotPolicies)
    if (!regions.has(policy.regionId))
      context.addIssue({
        code: "custom",
        message: `Lot policy ${policy.policyId} has unknown region`,
      });
  unique(generatedSurfaceIds, "Constructed surface");
  unique(generatedPortalIds, "Portal");
  unique(generatedRoomIds, "Room");
  unique(generatedStairIds, "Procedural stair generator");
  if (generatedSurfaceIds.some((surfaceId) => foundationSurfaceIds.has(surfaceId)))
    context.addIssue({
      code: "custom",
      message: "Constructed surface IDs collide with foundation surfaces",
    });
  for (const program of value.structuralPrograms) {
    if (!regions.has(program.regionId))
      context.addIssue({
        code: "custom",
        message: `Structural program ${program.programId} has unknown region`,
      });
    for (const room of program.rooms) {
      const entity = entityById.get(room.semanticEntityId);
      if (
        !entity ||
        entity.upperSort !== "space" ||
        (entity.regionId !== undefined && entity.regionId !== program.regionId)
      )
        context.addIssue({
          code: "custom",
          message: `Room ${room.roomId} requires a space commitment in its structural region`,
        });
    }
  }
  for (const camera of value.cameras)
    if (camera.regionIds.some((id) => !regions.has(id)))
      context.addIssue({ code: "custom", message: `Camera ${camera.cameraId} has unknown region` });
  for (const assertion of value.admittedAssertions)
    if (assertion.authority !== "admitted")
      context.addIssue({
        code: "custom",
        message: "World plans may contain only admitted assertions",
      });
}

function verifyHash(value: Record<string, unknown>, field: string, context: z.RefinementCtx): void {
  const material = { ...value };
  delete material[field];
  if (contentHash(stableJson(material)) !== value[field])
    context.addIssue({ code: "custom", path: [field], message: "Artifact hash mismatch" });
}

function canonicalUnique(values: readonly string[]): string[] {
  const result = [...values].sort(compareCanonicalStrings);
  if (new Set(result).size !== result.length) throw new Error("Values must be unique");
  return result;
}

function polygonArea(points: readonly WorldPoint2[]): number {
  return (
    points.reduce((sum, point, index) => {
      const next = points[(index + 1) % points.length]!;
      return sum + point.x * next.z - next.x * point.z;
    }, 0) / 2
  );
}

function pointInPolygon(point: WorldPoint2, polygon: readonly WorldPoint2[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!;
    const b = polygon[j]!;
    if (
      a.z > point.z !== b.z > point.z &&
      point.x < ((b.x - a.x) * (point.z - a.z)) / (b.z - a.z) + a.x
    )
      inside = !inside;
  }
  return inside;
}

const axes = ["x", "y", "z"] as const;
export const contentPlanEntityId = contentAddressedEntityId;
