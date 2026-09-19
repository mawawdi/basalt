import { z } from "zod";
import { contentHash, deepFreezeJson, stableJson, HASH_SCHEMA } from "@basalt/contracts";
import { createVegetationIntents } from "./vegetation.js";
import {
  SPATIAL_WORLD_PLAN_SCHEMA,
  WORLD_AABB_SCHEMA,
  WORLD_ENTITY_ID_SCHEMA,
  WORLD_POINT2_SCHEMA,
  WORLD_POLYGON_SCHEMA,
  WORLD_ROUTE_SCHEMA,
  ROUTE_JUNCTION_SCHEMA,
  TERRAIN_OPERATION_SCHEMA,
  WORLD_VECTOR3_SCHEMA,
  sealSpatialWorldPlan,
  type SpatialWorldPlan,
} from "./contracts.js";

const id = WORLD_ENTITY_ID_SCHEMA;
const number = z.number().finite();
const projectedBoundsArea = (bounds: z.output<typeof WORLD_AABB_SCHEMA>) =>
  (bounds.max.x - bounds.min.x) * (bounds.max.z - bounds.min.z);
const clearing = z
  .object({ boundsMeters: WORLD_AABB_SCHEMA, falloffMeters: number.min(0).max(32) })
  .strict();

/** A prepared palette and technical defaults, with no example composition. */
export const REGION_AUTHORING_PROFILE_SCHEMA = z
  .object({
    profileId: id,
    catalogSnapshotHash: HASH_SCHEMA,
    basePlan: SPATIAL_WORLD_PLAN_SCHEMA,
    routeTemplate: WORLD_ROUTE_SCHEMA,
    junctionTemplate: ROUTE_JUNCTION_SCHEMA,
    placementToleranceMeters: number.min(0).max(8),
    allowedTerrainMaterialIds: z.array(id).min(1).max(32),
    palette: z
      .array(
        z
          .object({
            requirementId: id,
            description: z.string().min(1).max(1024),
            boundsMeters: WORLD_AABB_SCHEMA,
          })
          .strict(),
      )
      .min(1)
      .max(256),
  })
  .strict()
  .superRefine((p, c) => {
    const b = p.basePlan;
    if (
      b.regions.length !== 1 ||
      b.placementSurfaces.length !== 1 ||
      b.terrainPlans.length !== 1 ||
      b.realizationIntents.length ||
      b.routes.length ||
      b.routeJunctions.length ||
      b.constructionPrograms.length ||
      b.structuralPrograms.length ||
      b.lotPolicies.length ||
      b.cameras.length ||
      b.terrainPlans[0]!.operations.length
    )
      c.addIssue({
        code: "custom",
        message:
          "A region authoring profile requires one empty terrain region; example layouts are forbidden",
      });
    const ids = p.palette.map((p) => p.requirementId);
    if (
      new Set(ids).size !== ids.length ||
      ids.length !== b.catalogRequirements.length ||
      b.catalogRequirements.some((r) => !ids.includes(r.requirementId))
    )
      c.addIssue({
        code: "custom",
        message: "Profile palette must match its prepared requirements exactly",
      });
  });
export type RegionAuthoringProfile = z.output<typeof REGION_AUTHORING_PROFILE_SCHEMA>;

/** Transient model proposal. Only the resulting SpatialWorldPlan reaches the compiler. */
export const REGION_DRAFT_SCHEMA = z
  .object({
    planId: id,
    seed: z.number().int().min(0).max(2_147_483_647),
    unmetRequirements: z
      .array(z.string().min(1).max(512))
      .max(32)
      .describe(
        "Actual requested content impossible with this profile. Empty when representable. Ordinary composition, material choices and implementation assumptions are not missing capabilities.",
      ),
    notes: z
      .array(z.string().min(1).max(512))
      .max(16)
      .describe(
        "Nonblocking assumptions and limitations. These are hypotheses, not compiler authority.",
      ),
    terrainOperations: z.array(TERRAIN_OPERATION_SCHEMA).max(64),
    placements: z
      .array(
        z
          .object({
            placementId: id,
            requirementId: id,
            x: number,
            z: number,
            yawDegrees: number.min(0).lt(360),
            columns: z.number().int().min(1).max(32),
            rows: z.number().int().min(1).max(32),
            spacingXMeters: number.min(0).max(32),
            spacingZMeters: number.min(0).max(32),
            footingElevationMeters: number.nullable(),
          })
          .strict(),
      )
      .max(128),
    routeNodes: z.array(z.object({ nodeId: id, position: WORLD_POINT2_SCHEMA }).strict()).max(48),
    routes: z
      .array(
        z
          .object({
            routeId: id,
            startNodeId: id,
            endNodeId: id,
            waypoints: z.array(WORLD_POINT2_SCHEMA).max(22),
            widthMeters: number.min(1).max(8),
          })
          .strict(),
      )
      .max(24),
    vegetationAreas: z
      .array(
        z
          .object({
            areaId: id,
            boundary: WORLD_POLYGON_SCHEMA,
            patchScaleMeters: number
              .min(4)
              .max(64)
              .describe("Approximate width of coherent planting patches, in meters."),
            clearings: z.array(clearing).max(16),
            palette: z
              .array(
                z
                  .object({
                    plantId: id,
                    requirementId: id,
                    layer: z.enum(["canopy", "understory", "ground_cover"]),
                    maximumCount: z.number().int().min(1).max(2048),
                    spacingMeters: number
                      .min(0.2)
                      .max(20)
                      .describe(
                        "Desired center spacing, before measured geometry and access constraints. Smaller values allow denser planting.",
                      ),
                    weight: number
                      .min(0.1)
                      .max(10)
                      .describe("Relative share of candidate trials within this planting layer."),
                    canopyPreference: z
                      .enum(["neutral", "sheltered", "open"])
                      .describe(
                        "Use neutral for canopy trees; lower plants can prefer shade or open ground.",
                      ),
                  })
                  .strict()
                  .refine(
                    (p) => p.layer !== "canopy" || p.canopyPreference === "neutral",
                    "Canopy must establish itself independently of existing canopy",
                  ),
              )
              .min(1)
              .max(16),
          })
          .strict(),
      )
      .max(12),
    cameras: z
      .array(
        z
          .object({
            cameraId: id,
            positionMeters: WORLD_VECTOR3_SCHEMA,
            lookAtMeters: WORLD_VECTOR3_SCHEMA,
          })
          .strict(),
      )
      .min(2)
      .max(4),
  })
  .strict();
export type RegionDraft = z.output<typeof REGION_DRAFT_SCHEMA>;

export function realizeRegionDraft(
  profileInput: RegionAuthoringProfile,
  draftInput: unknown,
): SpatialWorldPlan {
  const profile = REGION_AUTHORING_PROFILE_SCHEMA.parse(profileInput),
    d = REGION_DRAFT_SCHEMA.parse(draftInput);
  if (d.unmetRequirements.length)
    throw new Error(`Unsupported requested content: ${d.unmetRequirements.join("; ")}`);
  const p = structuredClone(profile.basePlan),
    regionId = p.regions[0]!.regionId,
    surfaceId = p.placementSurfaces[0]!.surfaceId;
  const terrain = p.terrainPlans[0]!;
  p.planId = d.planId;
  p.seed = d.seed;
  terrain.operations = [...d.terrainOperations];
  for (const op of terrain.operations)
    if (op.kind === "paint" && !profile.allowedTerrainMaterialIds.includes(op.materialId))
      throw new Error("Ground material is outside the authoring profile");
  const used = new Set<string>();
  const palette = (requirementId: string) => {
    const member = profile.palette.find((m) => m.requirementId === requirementId);
    if (!member)
      throw new Error(`Asset requirement is not in the prepared palette: ${requirementId}`);
    used.add(requirementId);
    return member;
  };
  for (const a of d.placements) {
    const asset = palette(a.requirementId);
    if (a.columns * a.rows > 512) throw new Error("Placement grid exceeds 512 instances");
    const angle = (a.yawDegrees * Math.PI) / 180;
    const cells = Array.from({ length: a.columns * a.rows }, (_, index) => {
      const column = index % a.columns,
        row = Math.floor(index / a.columns);
      const u = column * a.spacingXMeters,
        v = row * a.spacingZMeters;
      return {
        column,
        row,
        x: a.x + Math.cos(angle) * u + Math.sin(angle) * v,
        z: a.z - Math.sin(angle) * u + Math.cos(angle) * v,
      };
    });
    if ((a.columns > 1 && a.spacingXMeters <= 0) || (a.rows > 1 && a.spacingZMeters <= 0))
      throw new Error(`Placement ${a.placementId} needs positive spacing on repeated grid axes`);
    if (a.footingElevationMeters !== null) {
      const w = asset.boundsMeters.max.x - asset.boundsMeters.min.x,
        depth = asset.boundsMeters.max.z - asset.boundsMeters.min.z;
      const tolerance = cells.length === 1 ? profile.placementToleranceMeters : 0;
      const localCenterX = (asset.boundsMeters.min.x + asset.boundsMeters.max.x) / 2,
        localCenterZ = (asset.boundsMeters.min.z + asset.boundsMeters.max.z) / 2;
      const offsetX = Math.cos(angle) * localCenterX + Math.sin(angle) * localCenterZ,
        offsetZ = -Math.sin(angle) * localCenterX + Math.cos(angle) * localCenterZ;
      const hx =
          (Math.abs(Math.cos(angle)) * w + Math.abs(Math.sin(angle)) * depth) / 2 + 0.4 + tolerance,
        hz =
          (Math.abs(Math.sin(angle)) * w + Math.abs(Math.cos(angle)) * depth) / 2 + 0.4 + tolerance;
      const x0 = Math.min(...cells.map((p) => p.x)) + offsetX - hx,
        z0 = Math.min(...cells.map((p) => p.z)) + offsetZ - hz,
        x1 = Math.max(...cells.map((p) => p.x)) + offsetX + hx,
        z1 = Math.max(...cells.map((p) => p.z)) + offsetZ + hz;
      terrain.operations.push({
        kind: "flatten",
        polygon: [
          { x: x0, z: z0 },
          { x: x1, z: z0 },
          { x: x1, z: z1 },
          { x: x0, z: z1 },
        ],
        elevationMeters: a.footingElevationMeters,
        blendWidthMeters: 4,
      });
    }
    const shared = {
      intentId: a.placementId,
      requirementId: a.requirementId,
      priority: 1000,
      regionId,
      surfaceId,
    };
    if (cells.length > 1 && a.yawDegrees !== 0) {
      p.realizationIntents.push(
        ...cells.map((cell) => ({
          ...shared,
          intentId: `${a.placementId}_${cell.row}_${cell.column}`,
          kind: "single" as const,
          at: { u: cell.x, v: cell.z },
          yawDegrees: a.yawDegrees,
          positionToleranceMeters: 0,
        })),
      );
    } else
      p.realizationIntents.push(
        a.columns * a.rows === 1
          ? { ...shared, kind: "single", at: { u: a.x, v: a.z }, yawDegrees: a.yawDegrees }
          : {
              ...shared,
              kind: "surface_grid",
              origin: { u: a.x, v: a.z },
              columns: a.columns,
              rows: a.rows,
              spacingUMeters: a.columns > 1 ? a.spacingXMeters : 1,
              spacingVMeters: a.rows > 1 ? a.spacingZMeters : 1,
            },
      );
    if (cells.length === 1) {
      const intent = p.realizationIntents.at(-1)!;
      if (intent.kind === "single")
        intent.positionToleranceMeters = profile.placementToleranceMeters;
    }
  }
  const nodes = new Map(d.routeNodes.map((n) => [n.nodeId, n.position]));
  if (nodes.size !== d.routeNodes.length) throw new Error("Route node IDs must be unique");
  const reached = new Set<string>();
  if (d.routes[0]) reached.add(d.routes[0].startNodeId);
  for (let pass = 0; pass < d.routes.length; pass++)
    for (const route of d.routes) {
      if (!nodes.has(route.startNodeId) || !nodes.has(route.endNodeId))
        throw new Error(`Route ${route.routeId} references an unknown node`);
      if (route.startNodeId === route.endNodeId)
        throw new Error("A loop needs distinct shared route nodes and two connecting routes");
      if (reached.has(route.startNodeId) || reached.has(route.endNodeId)) {
        reached.add(route.startNodeId);
        reached.add(route.endNodeId);
      }
    }
  if (d.routes.some((r) => !reached.has(r.startNodeId) || !reached.has(r.endNodeId)))
    throw new Error(
      "The regional route graph is disconnected; join routes through shared node IDs",
    );
  const endpoints = new Map<string, Array<{ routeId: string; endpoint: "start" | "end" }>>();
  for (const [index, r] of d.routes.entries()) {
    const points = [nodes.get(r.startNodeId)!, ...r.waypoints, nodes.get(r.endNodeId)!];
    const route = structuredClone(profile.routeTemplate);
    Object.assign(route, {
      routeId: r.routeId,
      alignmentMeters: points,
      widthMeters: r.widthMeters,
      terrainPriority: index,
      regionIds: [regionId],
      surfaceId,
    });
    route.elevationControls = route.elevationControls.map((c, i) => ({
      ...c,
      controlId: `${r.routeId}_${i}`,
    }));
    p.routes.push(route);
    for (const endpoint of ["start", "end"] as const) {
      const pt = endpoint === "start" ? points[0]! : points.at(-1)!;
      const key = `${pt.x}:${pt.z}`;
      endpoints.set(key, [...(endpoints.get(key) ?? []), { routeId: r.routeId, endpoint }]);
    }
  }
  for (const [key, participants] of endpoints) {
    if (participants.length < 2) continue;
    const [x, z] = key.split(":").map(Number);
    p.routeJunctions.push({
      ...profile.junctionTemplate,
      junctionId: `Junction_${p.routeJunctions.length}`,
      positionMeters: { x: x!, z: z! },
      participants,
      radiusMeters: Math.min(
        profile.junctionTemplate.radiusMeters,
        ...participants.map(
          (participant) => p.routes.find((r) => r.routeId === participant.routeId)!.widthMeters / 2,
        ),
      ),
    });
  }
  for (const a of d.vegetationAreas) {
    a.palette.forEach((m) => palette(m.requirementId));
    p.realizationIntents.push(
      ...createVegetationIntents({
        ...a,
        regionId,
        surfaceId,
        densityField: {
          seed: Number.parseInt(contentHash(`${d.seed}:${a.areaId}`).slice(0, 8), 16),
          wavelengthMeters: a.patchScaleMeters,
          edgeFadeMeters: Math.min(8, a.patchScaleMeters * 0.4),
          minimumDensity: 0.35,
          patchContrast: 1.6,
        },
        boundary: a.boundary.map((pt) => ({ u: pt.x, v: pt.z })),
        palette: a.palette.map((m) => ({
          ...m,
          // Broad cover needs room before tiny accents consume its footprint. This is
          // measured size ordering within the ground layer, never noun classification.
          priority:
            m.layer === "canopy"
              ? 200
              : m.layer === "ground_cover"
                ? 100 +
                  Math.min(
                    80,
                    Math.round(
                      10 *
                        Math.log2(1 + projectedBoundsArea(palette(m.requirementId).boundsMeters)),
                    ),
                  )
                : 100,
          // Species are a mix, not permanent per-species quotas. The authoring
          // runtime checks initial layer presence; later clearing edits may remove plants.
          minimumCount: 0,
          // Spacing drives a finite trial budget. Geometry and the requested minimum
          // remain authoritative; rejected trials are never replenished to fill a quota.
          candidateDensityPerSquareMeter: Math.min(
            4,
            (4 * m.weight) /
              (m.spacingMeters ** 2 *
                a.palette.filter((n) => n.layer === m.layer).reduce((sum, n) => sum + n.weight, 0)),
          ),
          spacingMeters: { minimum: m.spacingMeters * 0.7, maximum: m.spacingMeters * 1.2 },
          canopyResponse:
            m.layer === "canopy"
              ? { open: 1, covered: 1 }
              : m.canopyPreference === "sheltered"
                ? { open: 0.15, covered: 1 }
                : m.canopyPreference === "open"
                  ? { open: 1, covered: 0.25 }
                  : { open: 0.85, covered: 0.85 },
        })),
        canopyIntentIds: [],
        maximumSlopeDegrees: 30,
        maximumSupportReliefMeters: 0.35,
        groundEmbedMeters: 0.025,
        routeClearanceHeightMeters: 3,
        minimumSeparationMeters: 0.02,
      }),
    );
  }
  p.catalogRequirements = p.catalogRequirements.filter((r) => used.has(r.requirementId));
  if (!p.realizationIntents.length)
    throw new Error("Region proposal contains no realizable content");
  p.cameras = d.cameras.map((c) => ({
    ...c,
    up: { x: 0, y: 1, z: 0 },
    fieldOfViewDegrees: 58,
    regionIds: [regionId],
    readabilityIntent: {
      kind: "art_directed",
      rationale:
        "Inspect the requested region composition and contact from fixed evidence cameras.",
    },
  }));
  const { kind: _kind, coordinateSystem: _coordinates, planHash: _hash, ...body } = p;
  return sealSpatialWorldPlan(body);
}

export function regionPlanningContext(profile: RegionAuthoringProfile): unknown {
  return deepFreezeJson({
    profileHash: contentHash(stableJson(profile)),
    boundsMeters: profile.basePlan.boundsMeters,
    allowedTerrainMaterialIds: profile.allowedTerrainMaterialIds,
    terrainBaseElevationMeters: profile.basePlan.terrainPlans[0]!.baseElevationMeters,
    placementToleranceMeters: profile.placementToleranceMeters,
    routeConstraints: {
      bendRadiusMeters: profile.routeTemplate.bendRadiusMeters,
      construction: profile.routeTemplate.construction,
      junctionRadiusMeters: profile.junctionTemplate.radiusMeters,
    },
    supportedComposition: [
      "individual grounded objects",
      "rows and rectangular grids of catalog objects",
      "layered natural planting",
      "terrain height operations",
      "terrain material patches",
      "connected curved paths",
    ],
    palette: profile.palette.map((m) => ({
      ...m,
      dimensionsMeters: {
        width: m.boundsMeters.max.x - m.boundsMeters.min.x,
        depth: m.boundsMeters.max.z - m.boundsMeters.min.z,
        height: m.boundsMeters.max.y - m.boundsMeters.min.y,
      },
      projectedBoundsAreaSquareMeters: projectedBoundsArea(m.boundsMeters),
    })),
  });
}
