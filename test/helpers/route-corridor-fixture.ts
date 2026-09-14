import { contentHash } from "@basalt/contracts";
import { sealSpatialWorldPlan, type WorldRoute } from "@basalt/world-planning";
import type { SemanticModule } from "@basalt/semantic-kernel";
import { worldFixture } from "./world-fixture.js";

const routeStyleHash = contentHash("route-corridor-eval-style");

/**
 * Crosses a hillside, crest, bend, three-way junction, carved stream, and
 * non-aligned 1.12m Roblox voxel boundaries without entering production code.
 */
export async function routeCorridorFixture(module: SemanticModule) {
  const fixture = await worldFixture(module);
  const {
    kind: _kind,
    coordinateSystem: _coordinateSystem,
    planHash: _planHash,
    ...planInput
  } = fixture.plan;
  const trail = groundedRoute({
    routeId: "WoodlandTrail",
    alignmentMeters: [
      { x: 1.12, z: 5.04 },
      { x: 7.28, z: 7.14 },
      { x: 10, z: 10 },
    ],
    widthMeters: 1.4,
    materialId: "Ground",
    color: { red: 105, green: 85, blue: 60 },
    startClearanceMeters: 0.08,
    endClearanceMeters: 0.68,
    terrainPriority: 0,
    treatment: "follow_surface",
  });
  const paved = groundedRoute({
    routeId: "PavedRoad",
    alignmentMeters: [
      { x: 10, z: 10 },
      { x: 14.56, z: 10.22 },
      { x: 18.48, z: 12.32 },
    ],
    widthMeters: 2,
    materialId: "Asphalt",
    color: { red: 68, green: 70, blue: 74 },
    startClearanceMeters: 0.68,
    endClearanceMeters: 0.08,
    terrainPriority: 1,
    treatment: "cut_fill",
  });
  const boardwalkAppearance = appearance("WoodPlanks", { red: 116, green: 84, blue: 52 });
  const boardwalk: WorldRoute = {
    routeId: "StreamBoardwalk",
    semanticEntityId: "RouteEntity",
    regionIds: ["MainRegion"],
    surfaceId: "GroundSurface",
    alignmentMeters: [
      { x: 10, z: 10 },
      { x: 10.36, z: 14.28 },
      { x: 12.32, z: 18.48 },
    ],
    elevationControls: [
      elevationControl("StreamBoardwalkStart", 0, 0.68),
      elevationControl("StreamBoardwalkEnd", 1, 0.68),
    ],
    widthMeters: 1.4,
    thicknessMeters: 0.16,
    bendRadiusMeters: 2,
    maximumSegmentLengthMeters: 0.56,
    terrainPriority: 2,
    appearance: boardwalkAppearance,
    construction: {
      kind: "elevated",
      maximumGradeRatio: 0.35,
      minimumGroundClearanceMeters: 0.5,
      supportSpacingMeters: 2.8,
      supportRadiusMeters: 0.14,
      maximumSupportHeightMeters: 5,
      vegetationClearanceMeters: 0.5,
      supportAppearance: boardwalkAppearance,
    },
    closed: false,
  };
  const plan = sealSpatialWorldPlan({
    ...planInput,
    terrainPlans: fixture.plan.terrainPlans.map((terrain) => ({
      ...terrain,
      resolution: { columns: 41, rows: 41 },
      operations: [
        {
          kind: "raise" as const,
          center: { x: 10, z: 9 },
          radiusMeters: 8,
          deltaMeters: 1.6,
        },
        {
          kind: "carve" as const,
          center: { x: 10.5, z: 15 },
          radiusMeters: 3,
          depthMeters: 1.2,
        },
      ],
    })),
    routes: [trail, paved, boardwalk],
    routeJunctions: [
      {
        junctionId: "RidgeJunction",
        kind: "intersection",
        positionMeters: { x: 10, z: 10 },
        surfaceElevation: { kind: "terrain_clearance", clearanceMeters: 0.68 },
        participants: [
          { routeId: "PavedRoad", endpoint: "start" },
          { routeId: "StreamBoardwalk", endpoint: "start" },
          { routeId: "WoodlandTrail", endpoint: "end" },
        ],
        maximumSnapDistanceMeters: 0.01,
        radiusMeters: 0.7,
        appearance: appearance("Ground", { red: 94, green: 79, blue: 58 }),
      },
    ],
    lotPolicies: [],
    structuralPrograms: [],
    constructionPrograms: [],
    catalogRequirements: [],
    realizationIntents: [],
    cameras: [],
  });
  return {
    plan,
    compileInput: {
      semanticModule: module,
      catalogSnapshot: fixture.snapshot,
      catalogAssets: [fixture.asset],
      spatialPlan: plan,
    },
  };
}

function groundedRoute(input: {
  readonly routeId: string;
  readonly alignmentMeters: WorldRoute["alignmentMeters"];
  readonly widthMeters: number;
  readonly materialId: string;
  readonly color: { readonly red: number; readonly green: number; readonly blue: number };
  readonly startClearanceMeters: number;
  readonly endClearanceMeters: number;
  readonly terrainPriority: number;
  readonly treatment: "follow_surface" | "cut_fill";
}): WorldRoute {
  const common = {
    routeId: input.routeId,
    semanticEntityId: "RouteEntity",
    regionIds: ["MainRegion"],
    surfaceId: "GroundSurface",
    alignmentMeters: input.alignmentMeters,
    elevationControls: [
      elevationControl(`${input.routeId}Start`, 0, input.startClearanceMeters),
      elevationControl(`${input.routeId}End`, 1, input.endClearanceMeters),
    ],
    widthMeters: input.widthMeters,
    thicknessMeters: 0.16,
    bendRadiusMeters: Math.max(2, input.widthMeters),
    maximumSegmentLengthMeters: 0.56,
    terrainPriority: input.terrainPriority,
    appearance: appearance(input.materialId, input.color),
    closed: false,
  };
  const treatment = {
    surfaceRevealMeters: 0.08,
    crossfallRatio: input.treatment === "cut_fill" ? -0.02 : 0,
    maximumGradeRatio: input.treatment === "cut_fill" ? 0.4 : 0.8,
    shoulderWidthMeters: input.treatment === "cut_fill" ? 0.7 : 0.25,
    blendWidthMeters: input.treatment === "cut_fill" ? 1.4 : 0.6,
    maximumCutDepthMeters: 3,
    maximumFillDepthMeters: 3,
    groundingToleranceMeters: 0.12,
    vegetationClearanceMeters: 0.6,
    terrainMaterialId: input.materialId,
  };
  return input.treatment === "cut_fill"
    ? {
        ...common,
        construction: {
          kind: "cut_fill",
          ...treatment,
          maximumGradeChangePerMeter: 0.25,
        },
      }
    : { ...common, construction: { kind: "follow_surface", ...treatment } };
}

function elevationControl(controlId: string, stationFraction: number, clearanceMeters: number) {
  return {
    controlId,
    stationFraction,
    surfaceElevation: { kind: "terrain_clearance" as const, clearanceMeters },
  };
}

function appearance(
  materialId: string,
  baseColorSrgb: { readonly red: number; readonly green: number; readonly blue: number },
) {
  return { materialId, styleProfileHash: routeStyleHash, baseColorSrgb };
}
