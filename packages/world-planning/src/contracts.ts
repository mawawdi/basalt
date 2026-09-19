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
import { CONSTRUCTION_PROGRAM_SCHEMA } from "./construction.js";
import { resolveHorizontalAlignment } from "./route-horizontal.js";

const finite = z.number().finite();
const positive = finite.positive();
const nonnegative = finite.nonnegative();
export const WORLD_ENTITY_ID_SCHEMA = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u);
export const WORLD_VECTOR3_SCHEMA = z.object({ x: finite, y: finite, z: finite }).strict();
export const WORLD_POINT2_SCHEMA = z.object({ x: finite, z: finite }).strict();
export const WORLD_SRGB_COLOR_SCHEMA = z
  .object({
    red: z.number().int().min(0).max(255),
    green: z.number().int().min(0).max(255),
    blue: z.number().int().min(0).max(255),
  })
  .strict();
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
      kind: z.literal("paint"),
      polygon: WORLD_POLYGON_SCHEMA,
      materialId: WORLD_ENTITY_ID_SCHEMA,
    })
    .strict(),
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

export const ROUTE_APPEARANCE_SCHEMA = z
  .object({
    materialId: WORLD_ENTITY_ID_SCHEMA,
    styleProfileHash: HASH_SCHEMA,
    baseColorSrgb: z
      .object({
        red: z.number().int().min(0).max(255),
        green: z.number().int().min(0).max(255),
        blue: z.number().int().min(0).max(255),
      })
      .strict(),
  })
  .strict();

export const ROUTE_ELEVATION_REFERENCE_SCHEMA = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("terrain_clearance"),
      clearanceMeters: nonnegative.max(1_000),
    })
    .strict(),
  z
    .object({
      kind: z.literal("absolute"),
      elevationMeters: finite,
    })
    .strict(),
]);

export const ROUTE_ELEVATION_CONTROL_SCHEMA = z
  .object({
    controlId: WORLD_ENTITY_ID_SCHEMA,
    stationFraction: finite.min(0).max(1),
    surfaceElevation: ROUTE_ELEVATION_REFERENCE_SCHEMA,
  })
  .strict();

const groundedRouteTreatment = {
  surfaceRevealMeters: nonnegative.max(10),
  crossfallRatio: finite.min(-0.25).max(0.25),
  maximumGradeRatio: positive.max(4),
  shoulderWidthMeters: nonnegative.max(100),
  blendWidthMeters: nonnegative.max(1_000),
  maximumCutDepthMeters: nonnegative.max(1_000),
  maximumFillDepthMeters: nonnegative.max(1_000),
  groundingToleranceMeters: nonnegative.max(10),
  vegetationClearanceMeters: nonnegative.max(1_000),
  terrainMaterialId: WORLD_ENTITY_ID_SCHEMA,
};

const elevatedEdgeProtection = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z
    .object({
      kind: z.literal("guardrail"),
      heightMeters: positive.max(10),
      railThicknessMeters: positive.max(2),
      postSpacingMeters: positive.max(100),
      postRadiusMeters: positive.max(1),
      appearance: ROUTE_APPEARANCE_SCHEMA,
    })
    .strict(),
]);

/**
 * Construction treatment is deliberately separate from route denotation and
 * appearance. It determines how a resolved travel surface changes, or
 * preserves, the terrain beneath it.
 */
export const ROUTE_CONSTRUCTION_TREATMENT_SCHEMA = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("follow_surface"),
      ...groundedRouteTreatment,
    })
    .strict(),
  z
    .object({
      kind: z.literal("cut_fill"),
      ...groundedRouteTreatment,
      maximumGradeChangePerMeter: nonnegative.max(4),
    })
    .strict(),
  z
    .object({
      kind: z.literal("elevated"),
      maximumGradeRatio: positive.max(4),
      minimumGroundClearanceMeters: nonnegative.max(1_000),
      supportSpacingMeters: positive.max(1_000),
      supportRadiusMeters: positive.max(100),
      maximumSupportHeightMeters: positive.max(10_000),
      vegetationClearanceMeters: nonnegative.max(1_000),
      supportAppearance: ROUTE_APPEARANCE_SCHEMA,
      edgeProtection: elevatedEdgeProtection,
    })
    .strict(),
  z
    .object({
      kind: z.literal("stepped"),
      surfaceRevealMeters: nonnegative.max(10),
      maximumRiserHeightMeters: positive.max(10),
      minimumTreadDepthMeters: positive.max(100),
      landingIntervalMeters: positive.max(1_000),
      shoulderWidthMeters: nonnegative.max(100),
      blendWidthMeters: nonnegative.max(1_000),
      maximumCutDepthMeters: nonnegative.max(1_000),
      maximumFillDepthMeters: nonnegative.max(1_000),
      groundingToleranceMeters: nonnegative.max(10),
      vegetationClearanceMeters: nonnegative.max(1_000),
      terrainMaterialId: WORLD_ENTITY_ID_SCHEMA,
    })
    .strict(),
]);

export const WORLD_ROUTE_SCHEMA = z
  .object({
    routeId: WORLD_ENTITY_ID_SCHEMA,
    semanticEntityId: WORLD_ENTITY_ID_SCHEMA,
    regionIds: z.array(WORLD_ENTITY_ID_SCHEMA).min(1).max(4096),
    surfaceId: WORLD_ENTITY_ID_SCHEMA,
    alignmentMeters: z.array(WORLD_POINT2_SCHEMA).min(2).max(65_536),
    elevationControls: z.array(ROUTE_ELEVATION_CONTROL_SCHEMA).min(2).max(4_096),
    widthMeters: positive,
    thicknessMeters: positive,
    bendRadiusMeters: positive.max(10_000),
    maximumSegmentLengthMeters: positive.max(1_000),
    terrainPriority: z.number().int().min(-1_000_000).max(1_000_000),
    appearance: ROUTE_APPEARANCE_SCHEMA,
    construction: ROUTE_CONSTRUCTION_TREATMENT_SCHEMA,
    closed: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.bendRadiusMeters <= value.widthMeters / 2)
      context.addIssue({
        code: "custom",
        path: ["bendRadiusMeters"],
        message: "Route bend radius must exceed half the travel-surface width",
      });
    for (let index = 1; index < value.alignmentMeters.length; index += 1) {
      const left = value.alignmentMeters[index - 1]!;
      const right = value.alignmentMeters[index]!;
      if (Math.hypot(right.x - left.x, right.z - left.z) <= 1e-9)
        context.addIssue({
          code: "custom",
          path: ["alignmentMeters", index],
          message: "Route segments require non-zero horizontal length",
        });
    }
    if (
      new Set(value.elevationControls.map((entry) => entry.controlId)).size !==
      value.elevationControls.length
    )
      context.addIssue({
        code: "custom",
        path: ["elevationControls"],
        message: "Route elevation control IDs must be unique",
      });
    for (let index = 1; index < value.elevationControls.length; index += 1)
      if (
        value.elevationControls[index]!.stationFraction <=
        value.elevationControls[index - 1]!.stationFraction
      )
        context.addIssue({
          code: "custom",
          path: ["elevationControls", index, "stationFraction"],
          message: "Route elevation controls must be strictly ordered",
        });
    if (
      value.elevationControls[0]?.stationFraction !== 0 ||
      value.elevationControls.at(-1)?.stationFraction !== 1
    )
      context.addIssue({
        code: "custom",
        path: ["elevationControls"],
        message: "Route elevation controls must bind both endpoints",
      });
    if (
      value.construction.kind === "follow_surface" &&
      value.elevationControls.some((entry) => entry.surfaceElevation.kind !== "terrain_clearance")
    )
      context.addIssue({
        code: "custom",
        path: ["elevationControls"],
        message: "Surface-following routes require terrain-clearance controls",
      });
    if (value.closed) {
      if (value.alignmentMeters.length < 4)
        context.addIssue({
          code: "custom",
          path: ["alignmentMeters"],
          message: "A closed route requires at least three vertices and a repeated endpoint",
        });
      const first = value.alignmentMeters[0]!;
      const last = value.alignmentMeters[value.alignmentMeters.length - 1]!;
      if (Math.hypot(last.x - first.x, last.z - first.z) > 1e-9)
        context.addIssue({
          code: "custom",
          path: ["alignmentMeters", value.alignmentMeters.length - 1],
          message: "A closed route must repeat its first point as its final point",
        });
      const unique = new Set(
        value.alignmentMeters
          .slice(0, -1)
          .map((point) => `${point.x.toString()},${point.z.toString()}`),
      );
      if (unique.size < 3)
        context.addIssue({
          code: "custom",
          path: ["alignmentMeters"],
          message: "A closed route requires at least three distinct vertices",
        });
      if (
        stableJson(value.elevationControls[0]?.surfaceElevation) !==
        stableJson(value.elevationControls.at(-1)?.surfaceElevation)
      )
        context.addIssue({
          code: "custom",
          path: ["elevationControls"],
          message: "A closed route must close its elevation profile",
        });
    }
    try {
      resolveHorizontalAlignment({
        routeId: value.routeId,
        points: value.alignmentMeters,
        bendRadiusMeters: value.bendRadiusMeters,
        closed: value.closed,
      });
    } catch (error) {
      context.addIssue({
        code: "custom",
        path: ["alignmentMeters"],
        message: error instanceof Error ? error.message : "Route horizontal alignment is invalid",
      });
    }
  });
export type WorldRoute = z.output<typeof WORLD_ROUTE_SCHEMA>;

const routeEndpoint = z
  .object({
    routeId: WORLD_ENTITY_ID_SCHEMA,
    endpoint: z.enum(["start", "end"]),
  })
  .strict();

export const ROUTE_JUNCTION_SCHEMA = z
  .object({
    junctionId: WORLD_ENTITY_ID_SCHEMA,
    kind: z.enum(["intersection", "entrance"]),
    positionMeters: WORLD_POINT2_SCHEMA,
    surfaceElevation: ROUTE_ELEVATION_REFERENCE_SCHEMA,
    participants: z.array(routeEndpoint).min(1).max(32),
    maximumSnapDistanceMeters: nonnegative.max(1_000),
    radiusMeters: positive.max(1_000),
    appearance: ROUTE_APPEARANCE_SCHEMA,
    terrainMaterialId: WORLD_ENTITY_ID_SCHEMA,
    targetHash: HASH_SCHEMA.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const participantKeys = value.participants.map((entry) => `${entry.routeId}:${entry.endpoint}`);
    if (new Set(participantKeys).size !== participantKeys.length)
      context.addIssue({
        code: "custom",
        path: ["participants"],
        message: "Route junction participants must be unique",
      });
    if (value.kind === "intersection" && value.participants.length < 2)
      context.addIssue({
        code: "custom",
        path: ["participants"],
        message: "An intersection requires at least two route endpoints",
      });
    if (value.kind === "entrance" && value.participants.length !== 1)
      context.addIssue({
        code: "custom",
        path: ["participants"],
        message: "An entrance binds exactly one route endpoint",
      });
    if ((value.kind === "entrance") !== (value.targetHash !== undefined))
      context.addIssue({
        code: "custom",
        path: ["targetHash"],
        message: "Only entrances bind an exact target hash",
      });
  });
export type RouteJunction = z.output<typeof ROUTE_JUNCTION_SCHEMA>;

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

/**
 * Engine-neutral presentation intent. Platform adapters lower this sealed
 * profile transactionally; it never grants semantic or spatial authority.
 */
export const WORLD_VISUAL_ENVIRONMENT_SCHEMA = z
  .object({
    kind: z.literal("WorldVisualEnvironment"),
    clockTimeHours: finite.min(0).lt(24),
    geographicLatitudeDegrees: finite.min(-90).max(90),
    brightness: finite.min(0).max(10),
    exposureCompensation: finite.min(-5).max(5),
    shadowSoftness: finite.min(0).max(1),
    environmentDiffuseScale: finite.min(0).max(1),
    environmentSpecularScale: finite.min(0).max(1),
    ambientSrgb: WORLD_SRGB_COLOR_SCHEMA,
    outdoorAmbientSrgb: WORLD_SRGB_COLOR_SCHEMA,
    colorShiftTopSrgb: WORLD_SRGB_COLOR_SCHEMA,
    colorShiftBottomSrgb: WORLD_SRGB_COLOR_SCHEMA,
    atmosphere: z
      .object({
        colorSrgb: WORLD_SRGB_COLOR_SCHEMA,
        decaySrgb: WORLD_SRGB_COLOR_SCHEMA,
        density: finite.min(0).max(1),
        offset: finite.min(-1).max(1),
        haze: finite.min(0).max(10),
        glare: finite.min(0).max(10),
      })
      .strict(),
    colorGrade: z
      .object({
        brightness: finite.min(-1).max(1),
        contrast: finite.min(-1).max(1),
        saturation: finite.min(-1).max(1),
        tintSrgb: WORLD_SRGB_COLOR_SCHEMA,
      })
      .strict(),
    sunRays: z
      .object({
        intensity: finite.min(0).max(1),
        spread: finite.min(0).max(1),
      })
      .strict(),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => verifyHash(value, "hash", context));
export type WorldVisualEnvironment = z.output<typeof WORLD_VISUAL_ENVIRONMENT_SCHEMA>;

export function sealWorldVisualEnvironment(
  input: Omit<WorldVisualEnvironment, "kind" | "hash">,
): WorldVisualEnvironment {
  const material = { kind: "WorldVisualEnvironment" as const, ...input };
  return deepFreezeJson(
    WORLD_VISUAL_ENVIRONMENT_SCHEMA.parse({
      ...material,
      hash: contentHash(stableJson(material)),
    }),
  );
}

export const DEFAULT_WORLD_VISUAL_ENVIRONMENT = sealWorldVisualEnvironment({
  clockTimeHours: 14.5,
  geographicLatitudeDegrees: 35,
  brightness: 2,
  exposureCompensation: 0,
  shadowSoftness: 0.25,
  environmentDiffuseScale: 0.6,
  environmentSpecularScale: 0.4,
  ambientSrgb: { red: 38, green: 42, blue: 48 },
  outdoorAmbientSrgb: { red: 112, green: 120, blue: 116 },
  colorShiftTopSrgb: { red: 0, green: 0, blue: 0 },
  colorShiftBottomSrgb: { red: 0, green: 0, blue: 0 },
  atmosphere: {
    colorSrgb: { red: 199, green: 216, blue: 229 },
    decaySrgb: { red: 92, green: 111, blue: 125 },
    density: 0.16,
    offset: 0.1,
    haze: 0.8,
    glare: 0.04,
  },
  colorGrade: {
    brightness: 0,
    contrast: 0.08,
    saturation: 0.02,
    tintSrgb: { red: 255, green: 255, blue: 255 },
  },
  sunRays: { intensity: 0.02, spread: 0.8 },
});

export const SPATIAL_WORLD_PLAN_SCHEMA = z
  .object({
    kind: z.literal("SpatialWorldPlan"),
    planId: WORLD_ENTITY_ID_SCHEMA,
    coordinateSystem: z.literal("right_handed_y_up_meters"),
    visualEnvironment: WORLD_VISUAL_ENVIRONMENT_SCHEMA,
    seed: z.number().int().min(0).max(0xffff_ffff),
    boundsMeters: WORLD_AABB_SCHEMA,
    semanticEntities: z.array(PLANNED_SEMANTIC_ENTITY_SCHEMA).max(100_000),
    admittedAssertions: z.array(SEMANTIC_ADMITTED_ASSERTION_BUNDLE_SCHEMA).max(100_000),
    regions: z.array(regionSchema).min(1).max(4096),
    placementSurfaces: z.array(PLACEMENT_SURFACE_SCHEMA).max(65_536),
    terrainPlans: z.array(TERRAIN_PLAN_SCHEMA).max(4096),
    routes: z.array(WORLD_ROUTE_SCHEMA).max(65_536),
    routeJunctions: z.array(ROUTE_JUNCTION_SCHEMA).max(65_536),
    lotPolicies: z.array(LOT_SUBDIVISION_POLICY_SCHEMA).max(4096),
    structuralPrograms: z.array(STRUCTURAL_PROGRAM_SCHEMA).max(4096),
    constructionPrograms: z.array(CONSTRUCTION_PROGRAM_SCHEMA).max(4096),
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
    routeJunctions: by(value.routeJunctions, (entry) => entry.junctionId).map((junction) => ({
      ...junction,
      participants: [...junction.participants].sort((left, right) =>
        compareCanonicalStrings(
          `${left.routeId}:${left.endpoint}`,
          `${right.routeId}:${right.endpoint}`,
        ),
      ),
    })),
    lotPolicies: by(value.lotPolicies, (entry) => entry.policyId),
    structuralPrograms,
    constructionPrograms: by(value.constructionPrograms, (entry) => entry.programId),
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
    value.terrainPlans.map((entry) => entry.surfaceId),
    "Terrain surface",
  );
  unique(
    value.routes.map((entry) => entry.routeId),
    "Route",
  );
  unique(
    value.routeJunctions.map((entry) => entry.junctionId),
    "Route junction",
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
    if (value.terrainPlans.filter((terrain) => terrain.surfaceId === route.surfaceId).length !== 1)
      context.addIssue({
        code: "custom",
        message: `Route ${route.routeId} requires exactly one authored base-terrain field`,
      });
  }
  const routes = new Set(value.routes.map((entry) => entry.routeId));
  const routeById = new Map(value.routes.map((entry) => [entry.routeId, entry]));
  const boundRouteEndpoints = new Set<string>();
  for (const junction of value.routeJunctions) {
    const participantRoutes = junction.participants
      .map((participant) => routeById.get(participant.routeId))
      .filter((route): route is WorldRoute => route !== undefined);
    if (participantRoutes.length !== junction.participants.length)
      context.addIssue({
        code: "custom",
        message: `Route junction ${junction.junctionId} references an unknown route`,
      });
    if (new Set(participantRoutes.map((route) => route.surfaceId)).size > 1)
      context.addIssue({
        code: "custom",
        message: `Route junction ${junction.junctionId} crosses unrelated placement surfaces`,
      });
    const groundedParticipants = participantRoutes.filter(
      (route) => route.construction.kind !== "elevated",
    );
    const groundedSurfaceReveals = groundedParticipants.flatMap((route) =>
      route.construction.kind === "elevated" ? [] : [route.construction.surfaceRevealMeters],
    );
    if (participantRoutes.some((route) => route.closed))
      context.addIssue({
        code: "custom",
        message: `Route junction ${junction.junctionId} cannot bind a closed route endpoint`,
      });
    if (new Set(groundedSurfaceReveals).size > 1)
      context.addIssue({
        code: "custom",
        message: `Route junction ${junction.junctionId} has incompatible surface reveals`,
      });
    if (
      groundedParticipants.length > 0 &&
      junction.radiusMeters >
        Math.min(...groundedParticipants.map((route) => route.widthMeters / 2)) + 1e-9
    )
      context.addIssue({
        code: "custom",
        message: `Route junction ${junction.junctionId} extends beyond its grounded corridor`,
      });
    for (const participant of junction.participants) {
      const key = `${participant.routeId}:${participant.endpoint}`;
      if (boundRouteEndpoints.has(key))
        context.addIssue({
          code: "custom",
          message: `Route endpoint ${key} belongs to more than one junction`,
        });
      boundRouteEndpoints.add(key);
      const route = routeById.get(participant.routeId);
      if (!route) continue;
      const endpoint =
        participant.endpoint === "start"
          ? route.alignmentMeters[0]!
          : route.alignmentMeters.at(-1)!;
      if (
        Math.hypot(endpoint.x - junction.positionMeters.x, endpoint.z - junction.positionMeters.z) >
        junction.maximumSnapDistanceMeters + 1e-9
      )
        context.addIssue({
          code: "custom",
          message: `Route endpoint ${key} lies outside junction ${junction.junctionId}'s snap bound`,
        });
    }
  }
  const lotPolicies = new Set(value.lotPolicies.map((entry) => entry.policyId));
  const programs = new Set(value.structuralPrograms.map((entry) => entry.programId));
  const constructionPrograms = new Set(value.constructionPrograms.map((entry) => entry.programId));
  unique([...constructionPrograms], "Construction program");
  for (const program of value.constructionPrograms) {
    if (!regions.has(program.regionId))
      context.addIssue({
        code: "custom",
        message: `Construction program ${program.programId} has unknown region`,
      });
    if (program.anchor.kind === "placement_surface") {
      const surfaceRegion = surfaceRegionById.get(program.anchor.surfaceId);
      if (surfaceRegion === undefined)
        context.addIssue({
          code: "custom",
          message: `Construction program ${program.programId} has unknown anchor surface`,
        });
      else if (surfaceRegion !== program.regionId)
        context.addIssue({
          code: "custom",
          message: `Construction program ${program.programId} anchor surface belongs to another region`,
        });
    }
    const anchorRegion = value.regions.find((entry) => entry.regionId === program.regionId);
    if (anchorRegion) {
      const anchorPosition =
        program.anchor.kind === "region_point"
          ? program.anchor.positionMeters
          : {
              x: program.anchor.horizontalPositionMeters.x,
              y: Math.max(
                worldRegionVolumeBounds(anchorRegion.volume).min.y,
                Math.min(0, worldRegionVolumeBounds(anchorRegion.volume).max.y),
              ),
              z: program.anchor.horizontalPositionMeters.z,
            };
      if (!worldRegionContainsPoint(anchorRegion, anchorPosition))
        context.addIssue({
          code: "custom",
          message: `Construction program ${program.programId} anchor lies outside its region`,
        });
    }
    for (const stair of program.operations)
      if (stair.kind === "stair_run" && !routes.has(stair.entryRouteId))
        context.addIssue({
          code: "custom",
          message: `Construction stair ${stair.operationId} has unknown entry route`,
        });
  }
  for (const intent of value.realizationIntents) {
    if (intent.kind === "surface_scatter" && intent.vegetation) {
      for (const id of intent.vegetation.canopyIntentIds) {
        const parent = value.realizationIntents.find((entry) => entry.intentId === id);
        if (
          !parent ||
          !("regionId" in parent) ||
          !("surfaceId" in parent) ||
          parent.regionId !== intent.regionId ||
          parent.surfaceId !== intent.surfaceId ||
          (parent.kind !== "single" &&
            !(parent.kind === "surface_scatter" && parent.vegetation?.layer === "canopy"))
        )
          context.addIssue({
            code: "custom",
            message: `Vegetation ${intent.intentId} references an unavailable canopy intent ${id}`,
          });
      }
    }
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
