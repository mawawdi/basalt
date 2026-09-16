import { z } from "zod";
import {
  COMPILATION_STATUS_SCHEMA,
  HASH_SCHEMA,
  compareCanonicalStrings,
  contentAddressedEntityId,
  contentHash,
  deepFreezeJson,
  stableJson,
} from "@basalt/contracts";
import { SPATIAL_AABB_SCHEMA, SPATIAL_VECTOR3_SCHEMA } from "@basalt/spatial-core";
import {
  ROUTE_APPEARANCE_SCHEMA,
  ROUTE_ELEVATION_REFERENCE_SCHEMA,
  ROUTE_JUNCTION_SCHEMA,
  WORLD_POINT2_SCHEMA,
  WORLD_ENTITY_ID_SCHEMA,
  resolveRouteAlignment,
  sampleRouteAlignment,
  type RouteAlignmentSpan,
  type RouteJunction,
  type SpatialWorldPlan,
  type WorldPoint2,
  type WorldRoute,
  type WorldVector3,
} from "@basalt/world-planning";
import {
  sampleBaseTerrainFieldElevation,
  terrainFieldMinimumSpacing,
  type BaseTerrainFieldArtifact,
} from "./terrain-foundation.js";

const finite = z.number().finite();
const nonnegative = finite.nonnegative();
const MAXIMUM_PROFILE_DEFLECTION_RADIANS = Math.PI / 180;
const MAXIMUM_PROFILE_REFINEMENT_ITERATIONS = 12;

export const ROUTE_PROFILE_STATION_SCHEMA = z
  .object({
    stationIndex: z.number().int().nonnegative().max(1_000_000),
    stationMeters: nonnegative,
    fraction: finite.min(0).max(1),
    centerTopMeters: SPATIAL_VECTOR3_SCHEMA,
    baseTerrainElevationMeters: finite,
  })
  .strict();
export type RouteProfileStation = z.output<typeof ROUTE_PROFILE_STATION_SCHEMA>;

const routeVertex = z
  .object({ positionMeters: SPATIAL_VECTOR3_SCHEMA, normal: SPATIAL_VECTOR3_SCHEMA })
  .strict();

export const ROUTE_SURFACE_SEGMENT_SCHEMA = z
  .object({
    segmentId: WORLD_ENTITY_ID_SCHEMA,
    sourceSpanIndex: z.number().int().nonnegative().max(65_535),
    kind: z.enum(["surface_span", "step_tread", "step_landing"]),
    startStationMeters: nonnegative,
    endStationMeters: nonnegative,
    gradeRatio: finite,
    startPlanMiterMeters: nonnegative,
    endPlanMiterMeters: nonnegative,
    startProfileMiterMeters: nonnegative,
    endProfileMiterMeters: nonnegative,
    vertices: z.array(routeVertex).length(4),
    boundsMeters: SPATIAL_AABB_SCHEMA,
  })
  .strict()
  .refine(
    (value) => value.endStationMeters > value.startStationMeters,
    "Route surface segments require positive station extent",
  );
export type RouteSurfaceSegment = z.output<typeof ROUTE_SURFACE_SEGMENT_SCHEMA>;

export const ROUTE_BEND_SCHEMA = z
  .object({
    bendId: WORLD_ENTITY_ID_SCHEMA,
    sourceVertexIndex: z.number().int().nonnegative().max(65_535),
    startStationMeters: nonnegative,
    endStationMeters: nonnegative,
    centerMeters: WORLD_POINT2_SCHEMA,
    startMeters: WORLD_POINT2_SCHEMA,
    endMeters: WORLD_POINT2_SCHEMA,
    radiusMeters: finite.positive(),
    turnDirection: z.enum(["left", "right"]),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyHash(value, "hash", context);
    if (value.endStationMeters <= value.startStationMeters)
      context.addIssue({ code: "custom", message: "Route bends require positive station extent" });
  });
export type RouteBend = z.output<typeof ROUTE_BEND_SCHEMA>;

export const ROUTE_SUPPORT_SCHEMA = z
  .object({
    supportId: WORLD_ENTITY_ID_SCHEMA,
    stationMeters: nonnegative,
    centerMeters: SPATIAL_VECTOR3_SCHEMA,
    radiusMeters: finite.positive(),
    heightMeters: finite.positive(),
    appearance: ROUTE_APPEARANCE_SCHEMA,
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => verifyHash(value, "hash", context));

export const ROUTE_EDGE_RAIL_SCHEMA = z
  .object({
    railId: WORLD_ENTITY_ID_SCHEMA,
    side: z.enum(["left", "right"]),
    level: z.enum(["mid", "top"]),
    startStationMeters: nonnegative,
    endStationMeters: nonnegative,
    thicknessMeters: finite.positive(),
    vertices: z.array(routeVertex).length(4),
    boundsMeters: SPATIAL_AABB_SCHEMA,
    appearance: ROUTE_APPEARANCE_SCHEMA,
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyHash(value, "hash", context);
    if (value.endStationMeters <= value.startStationMeters)
      context.addIssue({ code: "custom", message: "Route edge rails require positive extent" });
  });
export type RouteEdgeRail = z.output<typeof ROUTE_EDGE_RAIL_SCHEMA>;

export const ROUTE_EDGE_POST_SCHEMA = z
  .object({
    postId: WORLD_ENTITY_ID_SCHEMA,
    side: z.enum(["left", "right"]),
    stationMeters: nonnegative,
    centerMeters: SPATIAL_VECTOR3_SCHEMA,
    radiusMeters: finite.positive(),
    heightMeters: finite.positive(),
    appearance: ROUTE_APPEARANCE_SCHEMA,
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => verifyHash(value, "hash", context));
export type RouteEdgePost = z.output<typeof ROUTE_EDGE_POST_SCHEMA>;

export const ROUTE_MATERIAL_MASK_SCHEMA = z
  .object({
    maskId: WORLD_ENTITY_ID_SCHEMA,
    routeId: WORLD_ENTITY_ID_SCHEMA,
    routeProfileHash: HASH_SCHEMA,
    terrainMaterialId: WORLD_ENTITY_ID_SCHEMA,
    halfWidthMeters: nonnegative,
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => verifyHash(value, "hash", context));

export const ROUTE_VEGETATION_MASK_SCHEMA = z
  .object({
    maskId: WORLD_ENTITY_ID_SCHEMA,
    routeId: WORLD_ENTITY_ID_SCHEMA,
    routeProfileHash: HASH_SCHEMA,
    halfWidthMeters: nonnegative,
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => verifyHash(value, "hash", context));

export const ROUTE_TERRAIN_TREATMENT_SCHEMA = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("preserve") }).strict(),
  z
    .object({
      kind: z.literal("grade"),
      sourceTreatment: z.enum(["follow_surface", "cut_fill", "stepped"]),
      routeProfileHash: HASH_SCHEMA,
      coreHalfWidthMeters: finite.positive(),
      surfaceRevealMeters: nonnegative,
      shoulderWidthMeters: nonnegative,
      blendWidthMeters: nonnegative,
      maximumCutDepthMeters: nonnegative,
      maximumFillDepthMeters: nonnegative,
      groundingToleranceMeters: nonnegative,
      crossfallRatio: finite.min(-0.25).max(0.25),
      terrainMaterialId: WORLD_ENTITY_ID_SCHEMA,
      priority: z.number().int().min(-1_000_000).max(1_000_000),
    })
    .strict(),
]);
export type RouteTerrainTreatment = z.output<typeof ROUTE_TERRAIN_TREATMENT_SCHEMA>;

export const ROUTE_JUNCTION_TERRAIN_TREATMENT_SCHEMA = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("preserve") }).strict(),
  z
    .object({
      kind: z.literal("grade"),
      surfaceRevealMeters: nonnegative,
      groundingToleranceMeters: nonnegative,
      terrainMaterialId: WORLD_ENTITY_ID_SCHEMA,
      priority: z.number().int().min(-1_000_000).max(1_000_000),
    })
    .strict(),
]);
export type RouteJunctionTerrainTreatment = z.output<
  typeof ROUTE_JUNCTION_TERRAIN_TREATMENT_SCHEMA
>;

export const ROUTE_JUNCTION_ARTIFACT_SCHEMA = z
  .object({
    kind: z.literal("RouteJunctionArtifact"),
    junctionId: WORLD_ENTITY_ID_SCHEMA,
    junctionHash: HASH_SCHEMA,
    surfaceId: WORLD_ENTITY_ID_SCHEMA,
    surfaceEvidenceHash: HASH_SCHEMA,
    centerTopMeters: SPATIAL_VECTOR3_SCHEMA,
    radiusMeters: finite.positive(),
    thicknessMeters: finite.positive(),
    appearance: ROUTE_APPEARANCE_SCHEMA,
    terrainTreatment: ROUTE_JUNCTION_TERRAIN_TREATMENT_SCHEMA,
    participants: ROUTE_JUNCTION_SCHEMA.shape.participants,
    targetHash: HASH_SCHEMA.optional(),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => verifyHash(value, "hash", context));
export type RouteJunctionArtifact = z.output<typeof ROUTE_JUNCTION_ARTIFACT_SCHEMA>;

export const ROUTE_CONSTRUCTION_ARTIFACT_SCHEMA = z
  .object({
    kind: z.literal("RouteConstructionArtifact"),
    status: COMPILATION_STATUS_SCHEMA,
    routeId: WORLD_ENTITY_ID_SCHEMA,
    routeHash: HASH_SCHEMA,
    surfaceId: WORLD_ENTITY_ID_SCHEMA,
    baseTerrainFieldHash: HASH_SCHEMA,
    treatmentKind: z.enum(["follow_surface", "cut_fill", "elevated", "stepped"]),
    appearance: ROUTE_APPEARANCE_SCHEMA,
    thicknessMeters: finite.positive(),
    widthMeters: finite.positive(),
    maximumGradeRatio: finite.positive().optional(),
    profile: z.array(ROUTE_PROFILE_STATION_SCHEMA).min(2).max(1_000_000),
    profileHash: HASH_SCHEMA,
    travelSegments: z.array(ROUTE_SURFACE_SEGMENT_SCHEMA).max(1_000_000),
    bends: z.array(ROUTE_BEND_SCHEMA).max(65_536),
    supports: z.array(ROUTE_SUPPORT_SCHEMA).max(1_000_000),
    edgeRails: z.array(ROUTE_EDGE_RAIL_SCHEMA).max(1_000_000),
    edgePosts: z.array(ROUTE_EDGE_POST_SCHEMA).max(1_000_000),
    terrainTreatment: ROUTE_TERRAIN_TREATMENT_SCHEMA,
    materialMask: ROUTE_MATERIAL_MASK_SCHEMA.optional(),
    vegetationMask: ROUTE_VEGETATION_MASK_SCHEMA,
    junctions: z
      .array(z.object({ junctionId: WORLD_ENTITY_ID_SCHEMA, junctionHash: HASH_SCHEMA }).strict())
      .max(65_536),
    diagnostics: z.array(z.string().trim().min(1).max(1_024)).max(65_536),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyHash(value, "hash", context);
    if (contentHash(stableJson(value.profile)) !== value.profileHash)
      context.addIssue({
        code: "custom",
        path: ["profileHash"],
        message: "Route profile hash mismatch",
      });
    for (let index = 1; index < value.profile.length; index += 1)
      if (value.profile[index]!.stationMeters <= value.profile[index - 1]!.stationMeters)
        context.addIssue({
          code: "custom",
          path: ["profile", index, "stationMeters"],
          message: "Route profile stations must be strictly ordered",
        });
    if (value.status === "eligible" && value.travelSegments.length === 0)
      context.addIssue({ code: "custom", message: "Eligible routes require travel geometry" });
    if (value.status !== "eligible" && value.diagnostics.length === 0)
      context.addIssue({ code: "custom", message: "Unresolved routes require diagnostics" });
    if (value.status !== "eligible" && value.terrainTreatment.kind !== "preserve")
      context.addIssue({
        code: "custom",
        message: "An unresolved route cannot modify the final terrain",
      });
    if (
      new Set(value.travelSegments.map((entry) => entry.segmentId)).size !==
      value.travelSegments.length
    )
      context.addIssue({ code: "custom", message: "Route segment IDs must be unique" });
    for (const [index, segment] of value.travelSegments.entries()) {
      if (
        segment.kind !== "surface_span" &&
        (Math.abs(segment.gradeRatio) > 1e-12 ||
          segment.startPlanMiterMeters > 1e-12 ||
          segment.endPlanMiterMeters > 1e-12 ||
          segment.startProfileMiterMeters > 1e-12 ||
          segment.endProfileMiterMeters > 1e-12)
      )
        context.addIssue({
          code: "custom",
          path: ["travelSegments", index],
          message: "Stepped route geometry cannot carry continuous-profile miters",
        });
      if (index === 0) continue;
      const previous = value.travelSegments[index - 1]!;
      if (Math.abs(previous.endStationMeters - segment.startStationMeters) > 1e-8)
        context.addIssue({
          code: "custom",
          path: ["travelSegments", index, "startStationMeters"],
          message: "Route travel segments must be station-continuous",
        });
      if (
        Math.abs(previous.endPlanMiterMeters - segment.startPlanMiterMeters) > 1e-9 ||
        Math.abs(previous.endProfileMiterMeters - segment.startProfileMiterMeters) > 1e-9
      )
        context.addIssue({
          code: "custom",
          path: ["travelSegments", index],
          message: "Adjacent route spans must agree on their join miters",
        });
      if (previous.kind !== "surface_span" || segment.kind !== "surface_span") continue;
      const profileDeflection = Math.abs(
        Math.atan(segment.gradeRatio) - Math.atan(previous.gradeRatio),
      );
      const expectedProfileMiter = value.thicknessMeters * Math.tan(profileDeflection / 2);
      if (Math.abs(segment.startProfileMiterMeters - expectedProfileMiter) > 1e-9)
        context.addIssue({
          code: "custom",
          path: ["travelSegments", index, "startProfileMiterMeters"],
          message: "Route profile miter does not match its pitch deflection",
        });
      if (
        (value.treatmentKind === "cut_fill" || value.treatmentKind === "elevated") &&
        profileDeflection > MAXIMUM_PROFILE_DEFLECTION_RADIANS + 1e-10
      )
        context.addIssue({
          code: "custom",
          path: ["travelSegments", index, "gradeRatio"],
          message: "Smooth route profile exceeds its pitch tessellation bound",
        });
    }
    if (new Set(value.bends.map((entry) => entry.bendId)).size !== value.bends.length)
      context.addIssue({ code: "custom", message: "Route bend IDs must be unique" });
    if (new Set(value.supports.map((entry) => entry.supportId)).size !== value.supports.length)
      context.addIssue({ code: "custom", message: "Route support IDs must be unique" });
    if (new Set(value.edgeRails.map((entry) => entry.railId)).size !== value.edgeRails.length)
      context.addIssue({ code: "custom", message: "Route edge-rail IDs must be unique" });
    if (new Set(value.edgePosts.map((entry) => entry.postId)).size !== value.edgePosts.length)
      context.addIssue({ code: "custom", message: "Route edge-post IDs must be unique" });
    if (
      value.treatmentKind !== "elevated" &&
      (value.edgeRails.length > 0 || value.edgePosts.length > 0)
    )
      context.addIssue({
        code: "custom",
        message: "Only elevated routes can emit edge protection",
      });
    if (
      value.terrainTreatment.kind === "grade" &&
      value.terrainTreatment.routeProfileHash !== value.profileHash
    )
      context.addIssue({
        code: "custom",
        message: "Route terrain treatment binds the wrong profile",
      });
    if (value.vegetationMask.routeProfileHash !== value.profileHash)
      context.addIssue({
        code: "custom",
        message: "Route vegetation mask binds the wrong profile",
      });
    if (value.materialMask && value.materialMask.routeProfileHash !== value.profileHash)
      context.addIssue({ code: "custom", message: "Route material mask binds the wrong profile" });
    if (new Set(value.junctions.map((entry) => entry.junctionId)).size !== value.junctions.length)
      context.addIssue({ code: "custom", message: "Route junction IDs must be unique" });
  });
export type RouteConstructionArtifact = z.output<typeof ROUTE_CONSTRUCTION_ARTIFACT_SCHEMA>;

export interface RouteConstructionResult {
  readonly junctions: readonly RouteJunctionArtifact[];
  readonly routes: readonly RouteConstructionArtifact[];
}

export function resolveRouteConstructions(
  plan: SpatialWorldPlan,
  baseTerrainFields: readonly BaseTerrainFieldArtifact[],
): RouteConstructionResult {
  const junctions = plan.routeJunctions.map((junction) =>
    sealRouteJunctionArtifact(junction, plan, baseTerrainFields),
  );
  const routes = plan.routes.map((route) => {
    const base = requireRouteTerrain(route, baseTerrainFields);
    return resolveRouteConstruction(route, base, junctions);
  });
  return {
    junctions: [...junctions].sort((left, right) =>
      compareCanonicalStrings(left.junctionId, right.junctionId),
    ),
    routes: [...routes].sort((left, right) => compareCanonicalStrings(left.routeId, right.routeId)),
  };
}

export function sealRouteJunctionArtifact(
  junction: RouteJunction,
  plan: SpatialWorldPlan,
  baseTerrainFields: readonly BaseTerrainFieldArtifact[],
): RouteJunctionArtifact {
  const routes = junction.participants.map((participant) => {
    const route = plan.routes.find((candidate) => candidate.routeId === participant.routeId);
    if (!route) throw new Error(`Route junction ${junction.junctionId} has an unknown route`);
    return route;
  });
  const surfaceId = routes[0]!.surfaceId;
  if (routes.some((route) => route.surfaceId !== surfaceId))
    throw new Error(`Route junction ${junction.junctionId} crosses placement surfaces`);
  const base = requireRouteTerrain(routes[0]!, baseTerrainFields);
  const topY = resolveElevationReference(junction.surfaceElevation, junction.positionMeters, base);
  const thicknessMeters = Math.max(...routes.map((route) => route.thicknessMeters));
  const groundedRoutes = routes.filter((route) => route.construction.kind !== "elevated");
  const terrainTreatment: RouteJunctionTerrainTreatment =
    groundedRoutes.length === 0
      ? { kind: "preserve" }
      : junctionTerrainTreatment(junction, groundedRoutes);
  const material = {
    kind: "RouteJunctionArtifact" as const,
    junctionId: junction.junctionId,
    junctionHash: contentHash(stableJson(junction)),
    surfaceId,
    surfaceEvidenceHash: base.hash,
    centerTopMeters: { x: junction.positionMeters.x, y: topY, z: junction.positionMeters.z },
    radiusMeters: junction.radiusMeters,
    thicknessMeters,
    appearance: junction.appearance,
    terrainTreatment,
    participants: [...junction.participants].sort((left, right) =>
      compareCanonicalStrings(
        `${left.routeId}:${left.endpoint}`,
        `${right.routeId}:${right.endpoint}`,
      ),
    ),
    ...(junction.targetHash ? { targetHash: junction.targetHash } : {}),
  };
  return deepFreezeJson(
    ROUTE_JUNCTION_ARTIFACT_SCHEMA.parse({
      ...material,
      hash: contentHash(stableJson(material)),
    }),
  );
}

function junctionTerrainTreatment(
  junction: RouteJunction,
  routes: readonly WorldRoute[],
): RouteJunctionTerrainTreatment {
  const treatments = routes.map((route) => {
    const treatment = route.construction;
    if (treatment.kind === "elevated")
      throw new Error(`Junction ${junction.junctionId} received an elevated grounded treatment`);
    return treatment;
  });
  const reveal = treatments[0]!.surfaceRevealMeters;
  if (treatments.some((entry) => Math.abs(entry.surfaceRevealMeters - reveal) > 1e-9))
    throw new Error(`Junction ${junction.junctionId} has incompatible surface reveals`);
  return {
    kind: "grade",
    surfaceRevealMeters: reveal,
    groundingToleranceMeters: Math.min(
      ...treatments.map((entry) => entry.groundingToleranceMeters),
    ),
    terrainMaterialId: junction.terrainMaterialId,
    priority: Math.max(...routes.map((route) => route.terrainPriority)),
  };
}

export function resolveRouteConstruction(
  route: WorldRoute,
  baseTerrain: BaseTerrainFieldArtifact,
  junctions: readonly RouteJunctionArtifact[],
): RouteConstructionArtifact {
  const routeHash = contentHash(stableJson(route));
  const routeJunctions = junctions.filter((junction) =>
    junction.participants.some((participant) => participant.routeId === route.routeId),
  );
  const alignmentMeters = route.alignmentMeters.map((point) => ({ ...point }));
  for (const junction of routeJunctions) {
    const participant = junction.participants.find((entry) => entry.routeId === route.routeId)!;
    const index = participant.endpoint === "start" ? 0 : alignmentMeters.length - 1;
    alignmentMeters[index] = { x: junction.centerTopMeters.x, z: junction.centerTopMeters.z };
  }
  const resolvedRoute = { ...route, alignmentMeters };
  const maximumSpanMeters = Math.min(
    route.maximumSegmentLengthMeters,
    terrainFieldMinimumSpacing(baseTerrain) / 2,
  );
  const resolvedAlignment = resolveRouteAlignment(resolvedRoute, maximumSpanMeters);
  const totalLengthMeters = resolvedAlignment.totalLengthMeters;
  let controlElevations = route.elevationControls.map((control) => {
    const frame = sampleRouteAlignment(resolvedRoute, control.stationFraction);
    return {
      fraction: control.stationFraction,
      elevationMeters: resolveElevationReference(
        control.surfaceElevation,
        frame.position,
        baseTerrain,
      ),
    };
  });
  for (const junction of routeJunctions) {
    const participant = junction.participants.find((entry) => entry.routeId === route.routeId)!;
    const endpointFraction = participant.endpoint === "start" ? 0 : 1;
    const landingFraction = junctionLandingFraction(
      participant.endpoint,
      junction.radiusMeters,
      totalLengthMeters,
    );
    controlElevations = controlElevations.filter(
      (entry) =>
        Math.abs(entry.fraction - endpointFraction) > 1e-12 &&
        Math.abs(entry.fraction - landingFraction) > 1e-12,
    );
    controlElevations.push(
      { fraction: endpointFraction, elevationMeters: junction.centerTopMeters.y },
      { fraction: landingFraction, elevationMeters: junction.centerTopMeters.y },
    );
  }
  controlElevations.sort((left, right) => left.fraction - right.fraction);
  const junctionLandingStations = routeJunctions.map((junction) => {
    const participant = junction.participants.find((entry) => entry.routeId === route.routeId)!;
    return (
      junctionLandingFraction(participant.endpoint, junction.radiusMeters, totalLengthMeters) *
      totalLengthMeters
    );
  });
  let spans = splitAlignmentSpansAtStations(resolvedAlignment.spans, [
    ...route.elevationControls.map((control) => control.stationFraction * totalLengthMeters),
    ...junctionLandingStations,
  ]);
  const buildProfile = (candidateSpans: readonly RouteAlignmentSpan[]) =>
    buildRouteProfile(
      route,
      candidateSpans,
      baseTerrain,
      controlElevations,
      routeJunctions,
      totalLengthMeters,
    );
  let profile = buildProfile(spans);
  if (route.construction.kind === "cut_fill" || route.construction.kind === "elevated") {
    const refined = refineVerticalProfile(route.routeId, spans, profile, buildProfile);
    spans = refined.spans;
    profile = refined.profile;
  }
  const diagnostics = validateProfile(route, profile, spans, baseTerrain);
  const profileHash = contentHash(stableJson(profile));
  const eligible = diagnostics.length === 0;
  const travelSegments = eligible ? buildTravelSegments(route, profile, spans) : [];
  const bends = eligible ? buildBends(route, resolvedAlignment.bends) : [];
  const supports = eligible
    ? buildSupports(resolvedRoute, profile, baseTerrain, routeJunctions)
    : [];
  const edgeProtection = eligible
    ? buildEdgeProtection(resolvedRoute, profile, routeJunctions)
    : { edgeRails: [], edgePosts: [] };
  const resolvedTerrainTreatment = eligible
    ? buildTerrainTreatment(route, profileHash)
    : ({ kind: "preserve" } as const);
  const materialMask =
    eligible && resolvedTerrainTreatment.kind === "grade"
      ? sealRouteMaterialMask({
          routeId: route.routeId,
          routeProfileHash: profileHash,
          terrainMaterialId: resolvedTerrainTreatment.terrainMaterialId,
          halfWidthMeters:
            resolvedTerrainTreatment.coreHalfWidthMeters +
            resolvedTerrainTreatment.shoulderWidthMeters,
        })
      : undefined;
  const vegetationClearanceMeters = route.construction.vegetationClearanceMeters;
  const vegetationMask = sealRouteVegetationMask({
    routeId: route.routeId,
    routeProfileHash: profileHash,
    halfWidthMeters: route.widthMeters / 2 + vegetationClearanceMeters,
  });
  const material = {
    kind: "RouteConstructionArtifact" as const,
    status: (eligible ? "eligible" : "incomplete") as "eligible" | "incomplete",
    routeId: route.routeId,
    routeHash,
    surfaceId: route.surfaceId,
    baseTerrainFieldHash: baseTerrain.hash,
    treatmentKind: route.construction.kind,
    appearance: route.appearance,
    thicknessMeters: route.thicknessMeters,
    widthMeters: route.widthMeters,
    ...(route.construction.kind !== "stepped"
      ? { maximumGradeRatio: route.construction.maximumGradeRatio }
      : {}),
    profile,
    profileHash,
    travelSegments,
    bends,
    supports,
    edgeRails: edgeProtection.edgeRails,
    edgePosts: edgeProtection.edgePosts,
    terrainTreatment: resolvedTerrainTreatment,
    ...(materialMask ? { materialMask } : {}),
    vegetationMask,
    junctions: routeJunctions
      .map((entry) => ({ junctionId: entry.junctionId, junctionHash: entry.hash }))
      .sort((left, right) => compareCanonicalStrings(left.junctionId, right.junctionId)),
    diagnostics: diagnostics.sort(compareCanonicalStrings),
  };
  return deepFreezeJson(
    ROUTE_CONSTRUCTION_ARTIFACT_SCHEMA.parse({
      ...material,
      hash: contentHash(stableJson(material)),
    }),
  );
}

function buildRouteProfile(
  route: WorldRoute,
  spans: readonly RouteAlignmentSpan[],
  baseTerrain: BaseTerrainFieldArtifact,
  controlElevations: readonly { readonly fraction: number; readonly elevationMeters: number }[],
  routeJunctions: readonly RouteJunctionArtifact[],
  totalLengthMeters: number,
): RouteProfileStation[] {
  let profile = uniqueStationInputs(spans).map((station, stationIndex) => {
    const fraction =
      totalLengthMeters === 0
        ? 0
        : Math.max(0, Math.min(1, station.stationMeters / totalLengthMeters));
    const baseTerrainElevationMeters = sampleBaseTerrainFieldElevation(
      baseTerrain,
      station.position.x,
      station.position.z,
    );
    const centerTopY =
      route.construction.kind === "follow_surface"
        ? baseTerrainElevationMeters + interpolatedTerrainClearance(route, fraction)
        : interpolateControlElevation(
            controlElevations,
            fraction,
            route.construction.kind === "cut_fill" || route.construction.kind === "elevated",
          );
    return {
      stationIndex,
      stationMeters: station.stationMeters,
      fraction,
      centerTopMeters: { x: station.position.x, y: centerTopY, z: station.position.z },
      baseTerrainElevationMeters,
    };
  });
  if (route.construction.kind === "follow_surface")
    profile = applySurfaceFollowingJunctionTransitions(
      profile,
      route.routeId,
      routeJunctions,
      totalLengthMeters,
    );
  for (const junction of routeJunctions) {
    const participant = junction.participants.find((entry) => entry.routeId === route.routeId)!;
    const index = participant.endpoint === "start" ? 0 : profile.length - 1;
    const endpointStationMeters = participant.endpoint === "start" ? 0 : totalLengthMeters;
    profile = profile.map((station) =>
      Math.abs(station.stationMeters - endpointStationMeters) <= junction.radiusMeters + 1e-9
        ? {
            ...station,
            centerTopMeters: {
              x: station.centerTopMeters.x,
              y: junction.centerTopMeters.y,
              z: station.centerTopMeters.z,
            },
          }
        : station,
    );
    profile[index] = { ...profile[index]!, centerTopMeters: { ...junction.centerTopMeters } };
  }
  return profile;
}

/**
 * The elevation functions used by cut/fill and elevated routes are continuous,
 * but a fixed horizontal chord budget can still undersample their curvature.
 * Refine only the spans adjacent to an excessive pitch deflection. This is the
 * vertical counterpart of angle-bounded horizontal arc sampling and leaves
 * terrain-following and deliberately stepped profiles semantically unchanged.
 */
function refineVerticalProfile(
  routeId: string,
  initialSpans: readonly RouteAlignmentSpan[],
  initialProfile: RouteProfileStation[],
  buildProfile: (spans: readonly RouteAlignmentSpan[]) => RouteProfileStation[],
): { readonly spans: readonly RouteAlignmentSpan[]; readonly profile: RouteProfileStation[] } {
  let spans = [...initialSpans];
  let profile = initialProfile;
  for (let iteration = 0; iteration <= MAXIMUM_PROFILE_REFINEMENT_ITERATIONS; iteration += 1) {
    const pitches = spans.map((span) => Math.atan(routeSpanGradeRatio(span, profile)));
    const probeSpans = spans.flatMap((span) => subdivideRouteAlignmentSpan(span, 4));
    const probeProfile = buildProfile(probeSpans);
    const probePitches = probeSpans.map((span) =>
      Math.atan(routeSpanGradeRatio(span, probeProfile)),
    );
    const splitIndices = new Set<number>();
    for (let index = 0; index < spans.length; index += 1) {
      const localPitches = probePitches.slice(index * 4, index * 4 + 4);
      if (
        Math.max(...localPitches) - Math.min(...localPitches) >
        MAXIMUM_PROFILE_DEFLECTION_RADIANS + 1e-10
      )
        splitIndices.add(index);
    }
    for (let index = 1; index < pitches.length; index += 1) {
      const emittedDeflection = Math.abs(pitches[index]! - pitches[index - 1]!);
      const sampledBoundaryDeflection = Math.abs(
        probePitches[index * 4]! - probePitches[index * 4 - 1]!,
      );
      if (
        Math.max(emittedDeflection, sampledBoundaryDeflection) >
        MAXIMUM_PROFILE_DEFLECTION_RADIANS + 1e-10
      ) {
        splitIndices.add(index - 1);
        splitIndices.add(index);
      }
    }
    if (splitIndices.size === 0) return { spans, profile };
    if (iteration === MAXIMUM_PROFILE_REFINEMENT_ITERATIONS)
      throw new Error(`Route ${routeId} vertical profile tessellation did not converge`);
    spans = spans.flatMap((span, index) =>
      splitIndices.has(index) ? subdivideRouteAlignmentSpan(span, 2) : [span],
    );
    if (spans.length > 1_000_000)
      throw new Error(`Route ${routeId} vertical profile exceeds the segment budget`);
    profile = buildProfile(spans);
  }
  throw new Error(`Route ${routeId} vertical profile refinement terminated unexpectedly`);
}

function subdivideRouteAlignmentSpan(
  span: RouteAlignmentSpan,
  count: number,
): readonly RouteAlignmentSpan[] {
  return Array.from({ length: count }, (_, index) => {
    const startAmount = index / count;
    const endAmount = (index + 1) / count;
    return {
      ...span,
      startStationMeters:
        span.startStationMeters + (span.endStationMeters - span.startStationMeters) * startAmount,
      endStationMeters:
        span.startStationMeters + (span.endStationMeters - span.startStationMeters) * endAmount,
      start: interpolate2(span.start, span.end, startAmount),
      end: interpolate2(span.start, span.end, endAmount),
    };
  });
}

function routeSpanGradeRatio(
  span: RouteAlignmentSpan,
  profile: readonly RouteProfileStation[],
): number {
  const start = profileAtStation(profile, span.startStationMeters);
  const end = profileAtStation(profile, span.endStationMeters);
  return (
    (end.centerTopMeters.y - start.centerTopMeters.y) /
    (span.endStationMeters - span.startStationMeters)
  );
}

function validateProfile(
  route: WorldRoute,
  profile: readonly RouteProfileStation[],
  spans: readonly RouteAlignmentSpan[],
  baseTerrain: BaseTerrainFieldArtifact,
): string[] {
  const diagnostics: string[] = [];
  if (route.construction.kind !== "stepped") {
    for (let index = 1; index < profile.length; index += 1) {
      const start = profile[index - 1]!;
      const end = profile[index]!;
      const run = end.stationMeters - start.stationMeters;
      const grade = Math.abs(end.centerTopMeters.y - start.centerTopMeters.y) / run;
      if (grade > route.construction.maximumGradeRatio + 1e-9)
        diagnostics.push(
          `route:${route.routeId}:grade:${grade.toFixed(6)} exceeds ${route.construction.maximumGradeRatio.toFixed(6)}`,
        );
    }
  }
  if (route.construction.kind === "cut_fill") {
    const grades = profile.slice(1).map((station, index) => {
      const previous = profile[index]!;
      return (
        (station.centerTopMeters.y - previous.centerTopMeters.y) /
        (station.stationMeters - previous.stationMeters)
      );
    });
    for (let index = 1; index < grades.length; index += 1) {
      const spanMeters =
        (profile[index + 1]!.stationMeters - profile[index - 1]!.stationMeters) / 2;
      const change = Math.abs(grades[index]! - grades[index - 1]!) / spanMeters;
      if (change > route.construction.maximumGradeChangePerMeter + 1e-9)
        diagnostics.push(
          `route:${route.routeId}:grade_change:${change.toFixed(6)} exceeds ${route.construction.maximumGradeChangePerMeter.toFixed(6)}`,
        );
    }
  }
  if (
    route.construction.kind === "follow_surface" ||
    route.construction.kind === "cut_fill" ||
    route.construction.kind === "stepped"
  ) {
    const construction = route.construction;
    for (const span of spans) {
      const start = profileAtStation(profile, span.startStationMeters);
      const end = profileAtStation(profile, span.endStationMeters);
      for (const [point, station] of [
        [span.start, start],
        [span.end, end],
      ] as const)
        for (const sign of [-1, 1] as const) {
          const x = point.x + span.lateral.x * route.widthMeters * 0.5 * sign;
          const z = point.z + span.lateral.z * route.widthMeters * 0.5 * sign;
          const top =
            station.centerTopMeters.y +
            ("crossfallRatio" in construction
              ? construction.crossfallRatio * route.widthMeters * 0.5 * sign
              : 0);
          const bed = top - construction.surfaceRevealMeters;
          const base = sampleBaseTerrainFieldElevation(baseTerrain, x, z);
          const cut = Math.max(0, base - bed);
          const fill = Math.max(0, bed - base);
          if (cut > construction.maximumCutDepthMeters + 1e-9)
            diagnostics.push(
              `route:${route.routeId}:cut:${cut.toFixed(6)} exceeds ${construction.maximumCutDepthMeters.toFixed(6)}`,
            );
          if (fill > construction.maximumFillDepthMeters + 1e-9)
            diagnostics.push(
              `route:${route.routeId}:fill:${fill.toFixed(6)} exceeds ${construction.maximumFillDepthMeters.toFixed(6)}`,
            );
        }
    }
  }
  if (route.construction.kind === "elevated")
    for (const station of profile) {
      const clearance =
        station.centerTopMeters.y - route.thicknessMeters - station.baseTerrainElevationMeters;
      if (clearance <= 1e-9)
        diagnostics.push(
          `route:${route.routeId}:support_height:${clearance.toFixed(6)} is not positive`,
        );
      if (clearance + 1e-9 < route.construction.minimumGroundClearanceMeters)
        diagnostics.push(
          `route:${route.routeId}:deck_clearance:${clearance.toFixed(6)} is below ${route.construction.minimumGroundClearanceMeters.toFixed(6)}`,
        );
      if (clearance > route.construction.maximumSupportHeightMeters + 1e-9)
        diagnostics.push(
          `route:${route.routeId}:support_height:${clearance.toFixed(6)} exceeds ${route.construction.maximumSupportHeightMeters.toFixed(6)}`,
        );
    }
  if (route.construction.kind === "stepped") {
    let distanceSinceLandingMeters = 0;
    for (const span of spans) {
      const start = profileAtStation(profile, span.startStationMeters);
      const end = profileAtStation(profile, span.endStationMeters);
      const rise = Math.abs(end.centerTopMeters.y - start.centerTopMeters.y);
      const run = span.endStationMeters - span.startStationMeters;
      if (rise <= 1e-9) {
        distanceSinceLandingMeters = 0;
        continue;
      }
      distanceSinceLandingMeters += run;
      if (distanceSinceLandingMeters > route.construction.landingIntervalMeters + 1e-9)
        diagnostics.push(
          `route:${route.routeId}:landing_interval:${distanceSinceLandingMeters.toFixed(6)} exceeds ${route.construction.landingIntervalMeters.toFixed(6)}`,
        );
      const count = Math.max(1, Math.ceil(rise / route.construction.maximumRiserHeightMeters));
      const tread = run / count;
      if (tread + 1e-9 < route.construction.minimumTreadDepthMeters)
        diagnostics.push(
          `route:${route.routeId}:tread:${tread.toFixed(6)} is below ${route.construction.minimumTreadDepthMeters.toFixed(6)}`,
        );
    }
  }
  return [...new Set(diagnostics)];
}

function buildTravelSegments(
  route: WorldRoute,
  profile: readonly RouteProfileStation[],
  spans: readonly RouteAlignmentSpan[],
): RouteSurfaceSegment[] {
  const result: RouteSurfaceSegment[] = [];
  const construction = route.construction;
  for (const [spanIndex, span] of spans.entries()) {
    const start = profileAtStation(profile, span.startStationMeters);
    const end = profileAtStation(profile, span.endStationMeters);
    if (construction.kind !== "stepped") {
      const gradeRatio = routeSpanGradeRatio(span, profile);
      const previous =
        spanIndex > 0 ? spans[spanIndex - 1] : route.closed ? spans.at(-1) : undefined;
      const next =
        spanIndex + 1 < spans.length ? spans[spanIndex + 1] : route.closed ? spans[0] : undefined;
      const startPlanMiterMeters = previous
        ? routeMiterExtensionMeters(previous, span, route.widthMeters / 2)
        : 0;
      const endPlanMiterMeters = next
        ? routeMiterExtensionMeters(span, next, route.widthMeters / 2)
        : 0;
      const startProfileMiterMeters = previous
        ? routeProfileMiterExtensionMeters(
            routeSpanGradeRatio(previous, profile),
            gradeRatio,
            route.thicknessMeters,
          )
        : 0;
      const endProfileMiterMeters = next
        ? routeProfileMiterExtensionMeters(
            gradeRatio,
            routeSpanGradeRatio(next, profile),
            route.thicknessMeters,
          )
        : 0;
      result.push(
        sealSurfaceSegment(
          route,
          span.sourceSpanIndex,
          span.startStationMeters,
          span.endStationMeters,
          span.start,
          span.end,
          span.lateral,
          start.centerTopMeters.y,
          end.centerTopMeters.y,
          "crossfallRatio" in construction ? construction.crossfallRatio : 0,
          "surface_span",
          result.length,
          gradeRatio,
          startPlanMiterMeters,
          endPlanMiterMeters,
          startProfileMiterMeters,
          endProfileMiterMeters,
        ),
      );
      continue;
    }
    const rise = end.centerTopMeters.y - start.centerTopMeters.y;
    if (Math.abs(rise) <= 1e-9) {
      result.push(
        sealSurfaceSegment(
          route,
          span.sourceSpanIndex,
          span.startStationMeters,
          span.endStationMeters,
          span.start,
          span.end,
          span.lateral,
          start.centerTopMeters.y,
          end.centerTopMeters.y,
          0,
          "step_landing",
          result.length,
          0,
          0,
          0,
          0,
          0,
        ),
      );
      continue;
    }
    const count = Math.max(1, Math.ceil(Math.abs(rise) / construction.maximumRiserHeightMeters));
    for (let index = 0; index < count; index += 1) {
      const from = interpolate2(span.start, span.end, index / count);
      const to = interpolate2(span.start, span.end, (index + 1) / count);
      const top = start.centerTopMeters.y + rise * ((index + 1) / count);
      const startStation =
        span.startStationMeters +
        (span.endStationMeters - span.startStationMeters) * (index / count);
      const endStation =
        span.startStationMeters +
        (span.endStationMeters - span.startStationMeters) * ((index + 1) / count);
      result.push(
        sealSurfaceSegment(
          route,
          span.sourceSpanIndex,
          startStation,
          endStation,
          from,
          to,
          span.lateral,
          top,
          top,
          0,
          "step_tread",
          result.length,
          0,
          0,
          0,
          0,
          0,
        ),
      );
    }
  }
  return result;
}

function sealSurfaceSegment(
  route: WorldRoute,
  sourceSpanIndex: number,
  startStationMeters: number,
  endStationMeters: number,
  start: WorldPoint2,
  end: WorldPoint2,
  lateral: WorldPoint2,
  startTopY: number,
  endTopY: number,
  crossfallRatio: number,
  kind: RouteSurfaceSegment["kind"],
  ordinal: number,
  gradeRatio: number,
  startPlanMiterMeters: number,
  endPlanMiterMeters: number,
  startProfileMiterMeters: number,
  endProfileMiterMeters: number,
): RouteSurfaceSegment {
  const halfWidth = route.widthMeters / 2;
  const tangent = normalize2({ x: end.x - start.x, z: end.z - start.z });
  const startProfileOffset = profileMiterOffset(startProfileMiterMeters, gradeRatio);
  const endProfileOffset = profileMiterOffset(endProfileMiterMeters, gradeRatio);
  const extendedStart = {
    x: start.x - tangent.x * (startPlanMiterMeters + startProfileOffset.horizontalMeters),
    z: start.z - tangent.z * (startPlanMiterMeters + startProfileOffset.horizontalMeters),
  };
  const extendedEnd = {
    x: end.x + tangent.x * (endPlanMiterMeters + endProfileOffset.horizontalMeters),
    z: end.z + tangent.z * (endPlanMiterMeters + endProfileOffset.horizontalMeters),
  };
  const extendedStartTopY = startTopY - startProfileOffset.verticalMeters;
  const extendedEndTopY = endTopY + endProfileOffset.verticalMeters;
  const startLeft = point3(
    extendedStart,
    lateral,
    -halfWidth,
    extendedStartTopY - crossfallRatio * halfWidth,
  );
  const startRight = point3(
    extendedStart,
    lateral,
    halfWidth,
    extendedStartTopY + crossfallRatio * halfWidth,
  );
  const endLeft = point3(
    extendedEnd,
    lateral,
    -halfWidth,
    extendedEndTopY - crossfallRatio * halfWidth,
  );
  const endRight = point3(
    extendedEnd,
    lateral,
    halfWidth,
    extendedEndTopY + crossfallRatio * halfWidth,
  );
  const direction = normalize3(
    subtract3(midpoint3(endLeft, endRight), midpoint3(startLeft, startRight)),
  );
  const lateral3 = normalize3(subtract3(startRight, startLeft));
  let normal = normalize3(cross3(lateral3, direction));
  if (normal.y < 0) normal = scale3(normal, -1);
  const vertices = [startLeft, startRight, endLeft, endRight].map((positionMeters) => ({
    positionMeters,
    normal,
  }));
  const segmentId = contentAddressedEntityId("RouteSegment", {
    routeId: route.routeId,
    ordinal,
    sourceSpanIndex,
    kind,
    startStationMeters,
    endStationMeters,
  });
  return ROUTE_SURFACE_SEGMENT_SCHEMA.parse({
    segmentId,
    sourceSpanIndex,
    kind,
    startStationMeters,
    endStationMeters,
    gradeRatio,
    startPlanMiterMeters,
    endPlanMiterMeters,
    startProfileMiterMeters,
    endProfileMiterMeters,
    vertices,
    boundsMeters: boundsForRouteSurface(
      vertices.map((entry) => entry.positionMeters),
      normal,
      route.thicknessMeters,
    ),
  });
}

/**
 * Extend adjacent rectangular spans until their outside corners meet. This is
 * the standard miter construction for a constant-width polyline: it closes the
 * triangular hole left by butt-jointed prisms without inventing adapter-only
 * geometry. Circular bends are angle-bounded upstream, so the miter remains
 * short and the outer edge converges smoothly on the authored radius.
 */
function routeMiterExtensionMeters(
  before: RouteAlignmentSpan,
  after: RouteAlignmentSpan,
  halfWidthMeters: number,
): number {
  const dot = Math.max(
    -1,
    Math.min(1, before.tangent.x * after.tangent.x + before.tangent.z * after.tangent.z),
  );
  const turnRadians = Math.acos(dot);
  if (turnRadians <= 1e-9) return 0;
  if (Math.PI - turnRadians <= 1e-8) throw new Error("Route surface cannot miter a reversing span");
  const extensionMeters = halfWidthMeters * Math.tan(turnRadians / 2);
  if (!Number.isFinite(extensionMeters) || extensionMeters < 0)
    throw new Error("Route surface produced an invalid miter extension");
  return extensionMeters;
}

/**
 * Pad both prisms through a pitch change far enough for the outer side of
 * their full-depth profiles to meet. The distance is measured along each
 * segment's sloped travel axis; the top surface remains the route datum.
 */
function routeProfileMiterExtensionMeters(
  beforeGradeRatio: number,
  afterGradeRatio: number,
  thicknessMeters: number,
): number {
  const deflectionRadians = Math.abs(Math.atan(afterGradeRatio) - Math.atan(beforeGradeRatio));
  if (deflectionRadians <= 1e-9) return 0;
  if (Math.PI - deflectionRadians <= 1e-8)
    throw new Error("Route surface cannot miter a reversing vertical profile");
  const extensionMeters = thicknessMeters * Math.tan(deflectionRadians / 2);
  if (!Number.isFinite(extensionMeters) || extensionMeters < 0)
    throw new Error("Route surface produced an invalid profile miter extension");
  return extensionMeters;
}

function profileMiterOffset(
  extensionMeters: number,
  gradeRatio: number,
): { readonly horizontalMeters: number; readonly verticalMeters: number } {
  const normalization = Math.hypot(1, gradeRatio);
  return {
    horizontalMeters: extensionMeters / normalization,
    verticalMeters: (extensionMeters * gradeRatio) / normalization,
  };
}

function buildBends(route: WorldRoute, bends: ReturnType<typeof resolveRouteAlignment>["bends"]) {
  return bends.map((bend) => {
    const input = {
      sourceVertexIndex: bend.sourceVertexIndex,
      startStationMeters: bend.startStationMeters,
      endStationMeters: bend.endStationMeters,
      centerMeters: bend.center,
      startMeters: bend.start,
      endMeters: bend.end,
      radiusMeters: bend.radiusMeters,
      turnDirection: bend.turnDirection,
    };
    const bendId = contentAddressedEntityId("RouteBend", {
      routeId: route.routeId,
      ...input,
    });
    const material = { bendId, ...input };
    return deepFreezeJson(
      ROUTE_BEND_SCHEMA.parse({
        ...material,
        hash: contentHash(stableJson(material)),
      }),
    );
  });
}

function buildSupports(
  route: WorldRoute,
  profile: readonly RouteProfileStation[],
  baseTerrain: BaseTerrainFieldArtifact,
  junctions: readonly RouteJunctionArtifact[],
) {
  if (route.construction.kind !== "elevated") return [];
  const construction = route.construction;
  const total = profile.at(-1)!.stationMeters;
  const { startInsetMeters, finishInsetMeters } = junctionEndpointInsets(
    route.routeId,
    total,
    junctions,
  );
  const usableLengthMeters = total - startInsetMeters - finishInsetMeters;
  if (usableLengthMeters <= 1e-9) return [];
  const intervalCount = Math.max(
    1,
    Math.ceil(usableLengthMeters / construction.supportSpacingMeters),
  );
  const lateralOffsetMeters = Math.max(
    0,
    route.widthMeters / 2 - construction.supportRadiusMeters * 1.5,
  );
  return Array.from({ length: intervalCount + 1 }, (_, index) => {
    const stationMeters = startInsetMeters + (usableLengthMeters * index) / intervalCount;
    const station = interpolateProfileStation(profile, stationMeters);
    const sample = sampleRouteAlignment(route, stationMeters / total);
    const lateral = { x: -sample.tangent.z, z: sample.tangent.x };
    return (["left", "right"] as const).map((side) => {
      const sign = side === "left" ? -1 : 1;
      const x = station.centerTopMeters.x + lateral.x * lateralOffsetMeters * sign;
      const z = station.centerTopMeters.z + lateral.z * lateralOffsetMeters * sign;
      const ground = sampleBaseTerrainFieldElevation(baseTerrain, x, z);
      const supportTop = station.centerTopMeters.y - route.thicknessMeters;
      const heightMeters = supportTop - ground;
      if (heightMeters <= 1e-9)
        throw new Error(
          `Elevated route ${route.routeId} has no positive support height at ${stationMeters.toFixed(6)}m`,
        );
      const input = {
        stationMeters,
        centerMeters: { x, y: ground + heightMeters / 2, z },
        radiusMeters: construction.supportRadiusMeters,
        heightMeters,
        appearance: construction.supportAppearance,
      };
      const supportId = contentAddressedEntityId("RouteSupport", {
        routeId: route.routeId,
        side,
        index,
        ...input,
      });
      const material = { supportId, ...input };
      return deepFreezeJson(
        ROUTE_SUPPORT_SCHEMA.parse({ ...material, hash: contentHash(stableJson(material)) }),
      );
    });
  }).flat();
}

function buildEdgeProtection(
  route: WorldRoute,
  profile: readonly RouteProfileStation[],
  junctions: readonly RouteJunctionArtifact[],
): { readonly edgeRails: readonly RouteEdgeRail[]; readonly edgePosts: readonly RouteEdgePost[] } {
  if (route.construction.kind !== "elevated" || route.construction.edgeProtection.kind === "none")
    return { edgeRails: [], edgePosts: [] };
  const protection = route.construction.edgeProtection;
  const total = profile.at(-1)!.stationMeters;
  const { startInsetMeters, finishInsetMeters } = junctionEndpointInsets(
    route.routeId,
    total,
    junctions,
  );
  const usableLengthMeters = total - startInsetMeters - finishInsetMeters;
  if (usableLengthMeters <= 1e-9) return { edgeRails: [], edgePosts: [] };
  const intervalCount = Math.max(1, Math.ceil(usableLengthMeters / protection.postSpacingMeters));
  const stations = Array.from(
    { length: intervalCount + 1 },
    (_, index) => startInsetMeters + (usableLengthMeters * index) / intervalCount,
  );
  const samples = stations.map((stationMeters) => {
    const station = interpolateProfileStation(profile, stationMeters);
    const alignment = sampleRouteAlignment(route, stationMeters / total);
    const lateral = { x: -alignment.tangent.z, z: alignment.tangent.x };
    return { stationMeters, station, lateral };
  });
  const edgePosts = samples.flatMap((sample, index) =>
    (["left", "right"] as const).map((side) => {
      const sign = side === "left" ? -1 : 1;
      const input = {
        side,
        stationMeters: sample.stationMeters,
        centerMeters: {
          x: sample.station.centerTopMeters.x + sample.lateral.x * route.widthMeters * 0.5 * sign,
          y: sample.station.centerTopMeters.y + protection.heightMeters / 2,
          z: sample.station.centerTopMeters.z + sample.lateral.z * route.widthMeters * 0.5 * sign,
        },
        radiusMeters: protection.postRadiusMeters,
        heightMeters: protection.heightMeters,
        appearance: protection.appearance,
      };
      const postId = contentAddressedEntityId("RouteEdgePost", {
        routeId: route.routeId,
        index,
        ...input,
      });
      const material = { postId, ...input };
      return deepFreezeJson(
        ROUTE_EDGE_POST_SCHEMA.parse({ ...material, hash: contentHash(stableJson(material)) }),
      );
    }),
  );
  const edgeRails = samples.slice(1).flatMap((finish, index) => {
    const start = samples[index]!;
    return (["left", "right"] as const).flatMap((side) =>
      (["mid", "top"] as const).map((level) => {
        const heightMeters = protection.heightMeters * (level === "mid" ? 0.5 : 1);
        return sealEdgeRail(route, protection, side, level, heightMeters, start, finish, index);
      }),
    );
  });
  return { edgeRails, edgePosts };
}

function sealEdgeRail(
  route: WorldRoute,
  protection: Extract<WorldRoute["construction"], { kind: "elevated" }>["edgeProtection"] & {
    readonly kind: "guardrail";
  },
  side: "left" | "right",
  level: "mid" | "top",
  heightMeters: number,
  start: {
    readonly stationMeters: number;
    readonly station: RouteProfileStation;
    readonly lateral: WorldPoint2;
  },
  finish: {
    readonly stationMeters: number;
    readonly station: RouteProfileStation;
    readonly lateral: WorldPoint2;
  },
  index: number,
): RouteEdgeRail {
  const sign = side === "left" ? -1 : 1;
  const startCenter = {
    x: start.station.centerTopMeters.x + start.lateral.x * route.widthMeters * 0.5 * sign,
    y: start.station.centerTopMeters.y + heightMeters,
    z: start.station.centerTopMeters.z + start.lateral.z * route.widthMeters * 0.5 * sign,
  };
  const finishCenter = {
    x: finish.station.centerTopMeters.x + finish.lateral.x * route.widthMeters * 0.5 * sign,
    y: finish.station.centerTopMeters.y + heightMeters,
    z: finish.station.centerTopMeters.z + finish.lateral.z * route.widthMeters * 0.5 * sign,
  };
  const tangent = normalize3(subtract3(finishCenter, startCenter));
  const horizontalLateral = normalize3({ x: -tangent.z, y: 0, z: tangent.x });
  let normal = normalize3(cross3(horizontalLateral, tangent));
  if (normal.y < 0) normal = scale3(normal, -1);
  const halfThickness = protection.railThicknessMeters / 2;
  const vertices = [
    subtract3(startCenter, scale3(horizontalLateral, halfThickness)),
    add3(startCenter, scale3(horizontalLateral, halfThickness)),
    subtract3(finishCenter, scale3(horizontalLateral, halfThickness)),
    add3(finishCenter, scale3(horizontalLateral, halfThickness)),
  ].map((positionMeters) => ({ positionMeters, normal }));
  const input = {
    side,
    level,
    startStationMeters: start.stationMeters,
    endStationMeters: finish.stationMeters,
    thicknessMeters: protection.railThicknessMeters,
    vertices,
    boundsMeters: boundsForRouteSurface(
      vertices.map((entry) => entry.positionMeters),
      normal,
      protection.railThicknessMeters,
    ),
    appearance: protection.appearance,
  };
  const railId = contentAddressedEntityId("RouteEdgeRail", {
    routeId: route.routeId,
    index,
    ...input,
  });
  const material = { railId, ...input };
  return deepFreezeJson(
    ROUTE_EDGE_RAIL_SCHEMA.parse({ ...material, hash: contentHash(stableJson(material)) }),
  );
}

function junctionEndpointInsets(
  routeId: string,
  totalLengthMeters: number,
  junctions: readonly RouteJunctionArtifact[],
): { readonly startInsetMeters: number; readonly finishInsetMeters: number } {
  let startInsetMeters = 0;
  let finishInsetMeters = 0;
  for (const junction of junctions) {
    const participant = junction.participants.find((entry) => entry.routeId === routeId);
    if (!participant) continue;
    if (participant.endpoint === "start")
      startInsetMeters = Math.max(startInsetMeters, junction.radiusMeters);
    else finishInsetMeters = Math.max(finishInsetMeters, junction.radiusMeters);
  }
  return {
    startInsetMeters: Math.min(startInsetMeters, totalLengthMeters / 2),
    finishInsetMeters: Math.min(finishInsetMeters, totalLengthMeters / 2),
  };
}

function buildTerrainTreatment(route: WorldRoute, routeProfileHash: string): RouteTerrainTreatment {
  if (route.construction.kind === "elevated") return { kind: "preserve" };
  const construction = route.construction;
  return {
    kind: "grade",
    sourceTreatment: construction.kind,
    routeProfileHash,
    coreHalfWidthMeters: route.widthMeters / 2,
    surfaceRevealMeters: construction.surfaceRevealMeters,
    shoulderWidthMeters: construction.shoulderWidthMeters,
    blendWidthMeters: construction.blendWidthMeters,
    maximumCutDepthMeters: construction.maximumCutDepthMeters,
    maximumFillDepthMeters: construction.maximumFillDepthMeters,
    groundingToleranceMeters: construction.groundingToleranceMeters,
    crossfallRatio: "crossfallRatio" in construction ? construction.crossfallRatio : 0,
    terrainMaterialId: construction.terrainMaterialId,
    priority: route.terrainPriority,
  };
}

function sealRouteMaterialMask(
  input: Omit<z.output<typeof ROUTE_MATERIAL_MASK_SCHEMA>, "maskId" | "hash">,
) {
  const maskId = contentAddressedEntityId("RouteMaterialMask", input);
  const material = { maskId, ...input };
  return deepFreezeJson(
    ROUTE_MATERIAL_MASK_SCHEMA.parse({ ...material, hash: contentHash(stableJson(material)) }),
  );
}

function sealRouteVegetationMask(
  input: Omit<z.output<typeof ROUTE_VEGETATION_MASK_SCHEMA>, "maskId" | "hash">,
) {
  const maskId = contentAddressedEntityId("RouteVegetationMask", input);
  const material = { maskId, ...input };
  return deepFreezeJson(
    ROUTE_VEGETATION_MASK_SCHEMA.parse({ ...material, hash: contentHash(stableJson(material)) }),
  );
}

function requireRouteTerrain(
  route: WorldRoute,
  fields: readonly BaseTerrainFieldArtifact[],
): BaseTerrainFieldArtifact {
  const matches = fields.filter((field) => field.surfaceId === route.surfaceId);
  if (matches.length !== 1)
    throw new Error(
      `Route ${route.routeId} requires exactly one base terrain field for ${route.surfaceId}`,
    );
  return matches[0]!;
}

function resolveElevationReference(
  reference: z.output<typeof ROUTE_ELEVATION_REFERENCE_SCHEMA>,
  point: WorldPoint2,
  baseTerrain: BaseTerrainFieldArtifact,
): number {
  return reference.kind === "absolute"
    ? reference.elevationMeters
    : sampleBaseTerrainFieldElevation(baseTerrain, point.x, point.z) + reference.clearanceMeters;
}

function interpolatedTerrainClearance(route: WorldRoute, fraction: number): number {
  const controls = route.elevationControls.map((control) => {
    if (control.surfaceElevation.kind !== "terrain_clearance")
      throw new Error(`Route ${route.routeId} has a non-terrain surface-following control`);
    return {
      fraction: control.stationFraction,
      elevationMeters: control.surfaceElevation.clearanceMeters,
    };
  });
  return interpolateControlElevation(controls, fraction, false);
}

function interpolateControlElevation(
  controls: readonly { readonly fraction: number; readonly elevationMeters: number }[],
  fraction: number,
  smooth: boolean,
): number {
  for (let index = 1; index < controls.length; index += 1) {
    const start = controls[index - 1]!;
    const end = controls[index]!;
    if (fraction <= end.fraction || index === controls.length - 1) {
      const amount =
        end.fraction === start.fraction
          ? 0
          : (Math.max(start.fraction, Math.min(end.fraction, fraction)) - start.fraction) /
            (end.fraction - start.fraction);
      const interpolation = smooth ? amount * amount * (3 - 2 * amount) : amount;
      return start.elevationMeters + (end.elevationMeters - start.elevationMeters) * interpolation;
    }
  }
  return controls.at(-1)!.elevationMeters;
}

function junctionLandingFraction(
  endpoint: "start" | "end",
  radiusMeters: number,
  totalLengthMeters: number,
): number {
  const fraction = Math.min(radiusMeters, totalLengthMeters / 2) / totalLengthMeters;
  return endpoint === "start" ? fraction : 1 - fraction;
}

function applySurfaceFollowingJunctionTransitions(
  profile: readonly RouteProfileStation[],
  routeId: string,
  junctions: readonly RouteJunctionArtifact[],
  totalLengthMeters: number,
): RouteProfileStation[] {
  let result = profile.map((entry) => ({
    ...entry,
    centerTopMeters: { ...entry.centerTopMeters },
  }));
  for (const junction of junctions) {
    const participant = junction.participants.find((entry) => entry.routeId === routeId)!;
    const landingStationMeters =
      junctionLandingFraction(participant.endpoint, junction.radiusMeters, totalLengthMeters) *
      totalLengthMeters;
    const landing = profileAtStation(result, landingStationMeters);
    const correction = junction.centerTopMeters.y - landing.centerTopMeters.y;
    result = result.map((station) => {
      const inLanding =
        participant.endpoint === "start"
          ? station.stationMeters <= landingStationMeters + 1e-9
          : station.stationMeters >= landingStationMeters - 1e-9;
      if (inLanding)
        return {
          ...station,
          centerTopMeters: { ...station.centerTopMeters, y: junction.centerTopMeters.y },
        };
      const transitionAmount =
        participant.endpoint === "start"
          ? 1 -
            (station.stationMeters - landingStationMeters) /
              (totalLengthMeters - landingStationMeters)
          : station.stationMeters / landingStationMeters;
      const bounded = Math.max(0, Math.min(1, transitionAmount));
      const weight = bounded * bounded * (3 - 2 * bounded);
      return {
        ...station,
        centerTopMeters: {
          ...station.centerTopMeters,
          y: station.centerTopMeters.y + correction * weight,
        },
      };
    });
  }
  return result;
}

function uniqueStationInputs(spans: readonly RouteAlignmentSpan[]) {
  const result: Array<{ stationMeters: number; position: WorldPoint2 }> = [];
  for (const span of spans) {
    if (
      result.length === 0 ||
      Math.abs(result.at(-1)!.stationMeters - span.startStationMeters) > 1e-9
    )
      result.push({ stationMeters: span.startStationMeters, position: span.start });
    result.push({ stationMeters: span.endStationMeters, position: span.end });
  }
  return result;
}

function splitAlignmentSpansAtStations(
  spans: readonly RouteAlignmentSpan[],
  stations: readonly number[],
): readonly RouteAlignmentSpan[] {
  const result: Array<(typeof spans)[number]> = [];
  for (const span of spans) {
    const cuts = [
      span.startStationMeters,
      ...stations.filter(
        (station) =>
          station > span.startStationMeters + 1e-9 && station < span.endStationMeters - 1e-9,
      ),
      span.endStationMeters,
    ].sort((left, right) => left - right);
    for (let index = 1; index < cuts.length; index += 1) {
      const startStationMeters = cuts[index - 1]!;
      const endStationMeters = cuts[index]!;
      const denominator = span.endStationMeters - span.startStationMeters;
      result.push({
        ...span,
        startStationMeters,
        endStationMeters,
        start: interpolate2(
          span.start,
          span.end,
          (startStationMeters - span.startStationMeters) / denominator,
        ),
        end: interpolate2(
          span.start,
          span.end,
          (endStationMeters - span.startStationMeters) / denominator,
        ),
      });
    }
  }
  return result;
}

function profileAtStation(
  profile: readonly RouteProfileStation[],
  stationMeters: number,
): RouteProfileStation {
  const exact = profile.find((entry) => Math.abs(entry.stationMeters - stationMeters) <= 1e-8);
  if (!exact) throw new Error(`Route profile has no station ${stationMeters.toString()}`);
  return exact;
}

export function interpolateProfileStation(
  profile: readonly RouteProfileStation[],
  stationMeters: number,
): RouteProfileStation {
  if (stationMeters <= profile[0]!.stationMeters) return profile[0]!;
  if (stationMeters >= profile.at(-1)!.stationMeters) return profile.at(-1)!;
  for (let index = 1; index < profile.length; index += 1) {
    const start = profile[index - 1]!;
    const end = profile[index]!;
    if (stationMeters <= end.stationMeters) {
      const amount =
        (stationMeters - start.stationMeters) / (end.stationMeters - start.stationMeters);
      return {
        stationIndex: start.stationIndex,
        stationMeters,
        fraction: start.fraction + (end.fraction - start.fraction) * amount,
        centerTopMeters: {
          x: start.centerTopMeters.x + (end.centerTopMeters.x - start.centerTopMeters.x) * amount,
          y: start.centerTopMeters.y + (end.centerTopMeters.y - start.centerTopMeters.y) * amount,
          z: start.centerTopMeters.z + (end.centerTopMeters.z - start.centerTopMeters.z) * amount,
        },
        baseTerrainElevationMeters:
          start.baseTerrainElevationMeters +
          (end.baseTerrainElevationMeters - start.baseTerrainElevationMeters) * amount,
      };
    }
  }
  throw new Error("Route profile interpolation failed");
}

function point3(
  center: WorldPoint2,
  lateral: WorldPoint2,
  lateralMeters: number,
  y: number,
): WorldVector3 {
  return {
    x: center.x + lateral.x * lateralMeters,
    y,
    z: center.z + lateral.z * lateralMeters,
  };
}

function interpolate2(start: WorldPoint2, end: WorldPoint2, amount: number): WorldPoint2 {
  return {
    x: start.x + (end.x - start.x) * amount,
    z: start.z + (end.z - start.z) * amount,
  };
}

function midpoint3(start: WorldVector3, end: WorldVector3): WorldVector3 {
  return { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2, z: (start.z + end.z) / 2 };
}

function add3(start: WorldVector3, end: WorldVector3): WorldVector3 {
  return { x: start.x + end.x, y: start.y + end.y, z: start.z + end.z };
}

function subtract3(start: WorldVector3, end: WorldVector3): WorldVector3 {
  return { x: start.x - end.x, y: start.y - end.y, z: start.z - end.z };
}

function scale3(value: WorldVector3, amount: number): WorldVector3 {
  return { x: value.x * amount, y: value.y * amount, z: value.z * amount };
}

function cross3(left: WorldVector3, right: WorldVector3): WorldVector3 {
  return {
    x: left.y * right.z - left.z * right.y,
    y: left.z * right.x - left.x * right.z,
    z: left.x * right.y - left.y * right.x,
  };
}

function normalize3(value: WorldVector3): WorldVector3 {
  const length = Math.hypot(value.x, value.y, value.z);
  if (length <= 1e-9) throw new Error("Route surface frame is degenerate");
  return { x: value.x / length, y: value.y / length, z: value.z / length };
}

function normalize2(value: WorldPoint2): WorldPoint2 {
  const length = Math.hypot(value.x, value.z);
  if (!Number.isFinite(length) || length <= 1e-12)
    throw new Error("Route surface segment has a degenerate horizontal direction");
  return { x: value.x / length, z: value.z / length };
}

function boundsForRouteSurface(
  vertices: readonly WorldVector3[],
  normal: WorldVector3,
  thicknessMeters: number,
) {
  const fullVolume = [
    ...vertices,
    ...vertices.map((point) => subtract3(point, scale3(normal, thicknessMeters))),
  ];
  return {
    min: {
      x: Math.min(...fullVolume.map((point) => point.x)),
      y: Math.min(...fullVolume.map((point) => point.y)),
      z: Math.min(...fullVolume.map((point) => point.z)),
    },
    max: {
      x: Math.max(...fullVolume.map((point) => point.x)),
      y: Math.max(...fullVolume.map((point) => point.y)),
      z: Math.max(...fullVolume.map((point) => point.z)),
    },
  };
}

function verifyHash(value: Record<string, unknown>, field: string, context: z.RefinementCtx): void {
  const material = { ...value };
  delete material[field];
  if (contentHash(stableJson(material)) !== value[field])
    context.addIssue({ code: "custom", path: [field], message: "Artifact hash mismatch" });
}
