import type { CatalogRequirement } from "@basalt/catalog-model";
import { contentHash, quantizeQ32_32 } from "@basalt/contracts";
import {
  createSemanticDependencyClosure,
  sealSemanticAssertionBundle,
  type SemanticModule,
} from "@basalt/semantic-kernel";
import {
  sealConstructionProgram,
  sealSpatialWorldPlan,
  sealWorldVisualEnvironment,
  type ConstructionProgram,
  type WorldRoute,
} from "@basalt/world-planning";
import { catalogFirstUseFixture } from "./catalog-first-use-fixture.js";
import { observationTowerProgram } from "./observation-tower-fixture.js";

export const FIRST_FINISHED_REGION_OUTPUT_ROOT = ".basalt/evals/first-finished-region";
export const FIRST_FINISHED_REGION_ID = "FirstFinishedRegion";
export const FIRST_FINISHED_REGION_SURFACE_ID = "FirstFinishedRegionGround";
export const FIRST_FINISHED_REGION_ROUTE_ENTITY_ID = "FirstFinishedRegionRouteEntity";
export const FIRST_FINISHED_REGION_TOWER_ENTRY_ROUTE_ID = "TowerSpur";
export const FIRST_FINISHED_REGION_OVERLOOK_ROUTE_ID = "SummitOverlook";
export const FIRST_FINISHED_REGION_RAVINE_OVERLOOK_ROUTE_ID = "RavineOverlookSpur";
export const FIRST_FINISHED_REGION_SIZE_METERS = 96;
export const FIRST_FINISHED_REGION_STYLE_HASH = contentHash(
  "first-finished-region-stylized-low-poly-nature",
);
export const FIRST_FINISHED_REGION_VISUAL_ENVIRONMENT = sealWorldVisualEnvironment({
  clockTimeHours: 16.35,
  geographicLatitudeDegrees: 35,
  brightness: 2.2,
  exposureCompensation: -0.12,
  shadowSoftness: 0.22,
  environmentDiffuseScale: 0.42,
  environmentSpecularScale: 0.5,
  ambientSrgb: { red: 27, green: 33, blue: 40 },
  outdoorAmbientSrgb: { red: 78, green: 88, blue: 84 },
  colorShiftTopSrgb: { red: 20, green: 9, blue: 3 },
  colorShiftBottomSrgb: { red: 3, green: 8, blue: 14 },
  atmosphere: {
    colorSrgb: { red: 190, green: 211, blue: 224 },
    decaySrgb: { red: 76, green: 96, blue: 110 },
    density: 0.2,
    offset: 0.12,
    haze: 1.3,
    glare: 0.05,
  },
  colorGrade: {
    brightness: -0.03,
    contrast: 0.2,
    saturation: 0.11,
    tintSrgb: { red: 255, green: 247, blue: 235 },
  },
  sunRays: { intensity: 0.025, spread: 0.78 },
});

export async function firstFinishedRegionFixture(module: SemanticModule) {
  const catalogFixture = await catalogFirstUseFixture(module);
  const routeConcept = requireConcept(module, "bsc_000305");
  const routeClosure = createSemanticDependencyClosure({
    module,
    conceptIds: [routeConcept.conceptId],
  });
  const routeAssertions = sealSemanticAssertionBundle({
    authority: "admitted",
    assertions: [
      {
        assertionKind: "denotation",
        subject: { kind: "planned_entity", id: FIRST_FINISHED_REGION_ROUTE_ENTITY_ID },
        concept: {
          conceptId: routeConcept.conceptId,
          commitmentHash: routeConcept.commitmentHash,
        },
        evidence: {
          level: "declared",
          evidenceHashes: [contentHash("first-finished-region-route-intent")],
        },
      },
    ],
  });
  const regionEntity = catalogFixture.plan.semanticEntities.find(
    (entry) => entry.entityId === "CatalogFirstUseRegionEntity",
  );
  if (!regionEntity) throw new Error("Catalog-first-use plan lacks its region entity");
  const tower = observationTowerProgram({
    semanticDependencyClosureHash: regionEntity.semanticDependencyClosureHash,
    styleProfileHash: FIRST_FINISHED_REGION_STYLE_HASH,
    regionId: FIRST_FINISHED_REGION_ID,
    surfaceId: FIRST_FINISHED_REGION_SURFACE_ID,
    entryRouteId: FIRST_FINISHED_REGION_TOWER_ENTRY_ROUTE_ID,
    anchorPositionMeters: { x: 72, z: 70 },
    towerCenterOffsetMeters: 14.5,
    heightMeters: 13.5,
    widthMeters: 9,
  });
  const pavilion = ridgePavilionProgram({
    semanticDependencyClosureHash: regionEntity.semanticDependencyClosureHash,
    styleProfileHash: FIRST_FINISHED_REGION_STYLE_HASH,
    regionId: FIRST_FINISHED_REGION_ID,
    surfaceId: FIRST_FINISHED_REGION_SURFACE_ID,
    entryRouteId: FIRST_FINISHED_REGION_OVERLOOK_ROUTE_ID,
    anchorPositionMeters: { x: 25, z: 80 },
  });
  const gateway = trailheadGatewayProgram({
    semanticDependencyClosureHash: regionEntity.semanticDependencyClosureHash,
    styleProfileHash: FIRST_FINISHED_REGION_STYLE_HASH,
    regionId: FIRST_FINISHED_REGION_ID,
    surfaceId: FIRST_FINISHED_REGION_SURFACE_ID,
    anchorPositionMeters: { x: 8, z: 8 },
  });
  const ravineOverlook = ravineOverlookProgram({
    semanticDependencyClosureHash: regionEntity.semanticDependencyClosureHash,
    styleProfileHash: FIRST_FINISHED_REGION_STYLE_HASH,
    regionId: FIRST_FINISHED_REGION_ID,
    surfaceId: FIRST_FINISHED_REGION_SURFACE_ID,
    entryRouteId: FIRST_FINISHED_REGION_RAVINE_OVERLOOK_ROUTE_ID,
    anchorPositionMeters: { x: 67, z: 48 },
  });
  const routes = regionRoutes();
  const {
    kind: _kind,
    coordinateSystem: _coordinateSystem,
    planHash: _planHash,
    ...basePlan
  } = catalogFixture.plan;
  const plan = sealSpatialWorldPlan({
    ...basePlan,
    planId: "FirstFinishedRegionCore",
    seed: 2_609_161,
    visualEnvironment: FIRST_FINISHED_REGION_VISUAL_ENVIRONMENT,
    boundsMeters: {
      min: { x: 0, y: -10, z: 0 },
      max: {
        x: FIRST_FINISHED_REGION_SIZE_METERS,
        y: 40,
        z: FIRST_FINISHED_REGION_SIZE_METERS,
      },
    },
    semanticEntities: [
      { ...regionEntity },
      {
        entityId: FIRST_FINISHED_REGION_ROUTE_ENTITY_ID,
        upperSort: "space",
        regionId: FIRST_FINISHED_REGION_ID,
        semanticDependencyClosureHash: routeClosure.hash,
        admittedAssertionBundleHash: routeAssertions.hash,
      },
    ],
    admittedAssertions: [catalogFixture.plan.admittedAssertions[0]!, routeAssertions],
    catalogRequirements: expandedCatalogRequirements(module),
    regions: [
      {
        regionId: FIRST_FINISHED_REGION_ID,
        semanticEntityId: regionEntity.entityId,
        volume: {
          kind: "box",
          bounds: {
            min: { x: 0, y: -10, z: 0 },
            max: {
              x: FIRST_FINISHED_REGION_SIZE_METERS,
              y: 40,
              z: FIRST_FINISHED_REGION_SIZE_METERS,
            },
          },
        },
        refinementPriority: 0,
      },
    ],
    placementSurfaces: [
      {
        surfaceId: FIRST_FINISHED_REGION_SURFACE_ID,
        regionId: FIRST_FINISHED_REGION_ID,
        kind: "terrain",
        bounds: {
          min: { x: 0, y: 0, z: 0 },
          max: {
            x: FIRST_FINISHED_REGION_SIZE_METERS,
            y: 0,
            z: FIRST_FINISHED_REGION_SIZE_METERS,
          },
        },
        normal: { x: 0, y: 1, z: 0 },
        sourceHash: contentHash("first-finished-region-ground-surface"),
      },
    ],
    terrainPlans: [
      {
        terrainPlanId: "FirstFinishedRegionTerrain",
        surfaceId: FIRST_FINISHED_REGION_SURFACE_ID,
        regionIds: [FIRST_FINISHED_REGION_ID],
        boundsMeters: {
          x: { minimum: 0, maximum: FIRST_FINISHED_REGION_SIZE_METERS },
          z: { minimum: 0, maximum: FIRST_FINISHED_REGION_SIZE_METERS },
        },
        resolution: { columns: 97, rows: 97 },
        baseElevationMeters: 0,
        operations: [
          { kind: "raise", center: { x: 48, z: 55 }, radiusMeters: 52, deltaMeters: 4.2 },
          { kind: "raise", center: { x: 71, z: 74 }, radiusMeters: 29, deltaMeters: 10.8 },
          { kind: "raise", center: { x: 25, z: 77 }, radiusMeters: 26, deltaMeters: 7.8 },
          { kind: "raise", center: { x: 50, z: 55 }, radiusMeters: 25, deltaMeters: 3.8 },
          { kind: "carve", center: { x: 17, z: 45 }, radiusMeters: 9, depthMeters: 7.5 },
          { kind: "carve", center: { x: 29, z: 43 }, radiusMeters: 9, depthMeters: 8.5 },
          { kind: "carve", center: { x: 41, z: 41 }, radiusMeters: 9, depthMeters: 9.5 },
          { kind: "carve", center: { x: 53, z: 39 }, radiusMeters: 9, depthMeters: 8.5 },
          { kind: "carve", center: { x: 65, z: 37 }, radiusMeters: 9, depthMeters: 7.5 },
          {
            kind: "flatten",
            polygon: rectangleXZ(3, 3, 15, 16),
            elevationMeters: 0.7,
            blendWidthMeters: 4,
          },
          {
            kind: "flatten",
            polygon: rectangleXZ(58, 57, 91, 94),
            elevationMeters: 15.5,
            blendWidthMeters: 11,
          },
          {
            kind: "flatten",
            polygon: rectangleXZ(15, 68, 38, 94),
            elevationMeters: 11.2,
            blendWidthMeters: 9,
          },
          {
            kind: "flatten",
            polygon: rectangleXZ(61, 45, 73, 55),
            elevationMeters: 8.6,
            blendWidthMeters: 5,
          },
          {
            kind: "flatten",
            polygon: rectangleXZ(43, 49, 60, 62),
            elevationMeters: 8.2,
            blendWidthMeters: 6,
          },
        ],
        materialId: "Grass",
      },
    ],
    routes,
    routeJunctions: [
      routeJunction("RavineLowerLanding", { x: 26, z: 31 }, [
        { routeId: "TrailheadApproach", endpoint: "end" },
        { routeId: "ScenicBoardwalk", endpoint: "start" },
      ]),
      routeJunction("RavineUpperLanding", { x: 52, z: 52 }, [
        { routeId: "ScenicBoardwalk", endpoint: "end" },
        { routeId: "RidgeTrail", endpoint: "start" },
        { routeId: FIRST_FINISHED_REGION_RAVINE_OVERLOOK_ROUTE_ID, endpoint: "start" },
      ]),
      routeJunction("SummitSplit", { x: 66, z: 68 }, [
        { routeId: "RidgeTrail", endpoint: "end" },
        { routeId: FIRST_FINISHED_REGION_TOWER_ENTRY_ROUTE_ID, endpoint: "start" },
        { routeId: "SummitSkywalk", endpoint: "start" },
      ]),
      routeJunction("PavilionLanding", { x: 38, z: 74 }, [
        { routeId: "SummitSkywalk", endpoint: "end" },
        { routeId: FIRST_FINISHED_REGION_OVERLOOK_ROUTE_ID, endpoint: "start" },
      ]),
    ],
    constructionPrograms: [tower, pavilion, gateway, ravineOverlook],
    realizationIntents: [
      {
        kind: "cluster",
        intentId: "PlaceLowerCanopyGrove",
        requirementId: "OutdoorTrees",
        priority: 220,
        regionId: FIRST_FINISHED_REGION_ID,
        surfaceId: FIRST_FINISHED_REGION_SURFACE_ID,
        center: { u: 14, v: 38 },
        radiusMeters: 17,
        minimumCount: 9,
        targetCount: 12,
        minimumSeparationMeters: 3.8,
      },
      {
        kind: "cluster",
        intentId: "PlaceEastCanopyGrove",
        requirementId: "OutdoorTrees",
        priority: 210,
        regionId: FIRST_FINISHED_REGION_ID,
        surfaceId: FIRST_FINISHED_REGION_SURFACE_ID,
        center: { u: 84, v: 53 },
        radiusMeters: 15,
        minimumCount: 9,
        targetCount: 12,
        minimumSeparationMeters: 3.8,
      },
      {
        kind: "cluster",
        intentId: "PlaceWestPineForest",
        requirementId: "OutdoorPines",
        priority: 200,
        regionId: FIRST_FINISHED_REGION_ID,
        surfaceId: FIRST_FINISHED_REGION_SURFACE_ID,
        center: { u: 12, v: 73 },
        radiusMeters: 17,
        minimumCount: 11,
        targetCount: 15,
        minimumSeparationMeters: 3.3,
      },
      {
        kind: "cluster",
        intentId: "PlaceNorthPineForest",
        requirementId: "OutdoorPines",
        priority: 190,
        regionId: FIRST_FINISHED_REGION_ID,
        surfaceId: FIRST_FINISHED_REGION_SURFACE_ID,
        center: { u: 51, v: 88 },
        radiusMeters: 18,
        minimumCount: 8,
        targetCount: 14,
        minimumSeparationMeters: 3.3,
      },
      {
        kind: "cluster",
        intentId: "PlacePavilionUnderstory",
        requirementId: "OutdoorUnderstoryTrees",
        priority: 180,
        regionId: FIRST_FINISHED_REGION_ID,
        surfaceId: FIRST_FINISHED_REGION_SURFACE_ID,
        center: { u: 30, v: 80 },
        radiusMeters: 15,
        minimumCount: 3,
        targetCount: 10,
        minimumSeparationMeters: 2.8,
      },
      {
        kind: "cluster",
        intentId: "PlaceUpperTrailUnderstory",
        requirementId: "OutdoorUnderstoryTrees",
        priority: 170,
        regionId: FIRST_FINISHED_REGION_ID,
        surfaceId: FIRST_FINISHED_REGION_SURFACE_ID,
        center: { u: 48, v: 68 },
        radiusMeters: 14,
        minimumCount: 3,
        targetCount: 9,
        minimumSeparationMeters: 2.8,
      },
      ...[
        ["PlaceMonumentTreeNorthEast", 88, 83],
        ["PlaceMonumentTreeSouthEast", 83, 15],
        ["PlaceMonumentTreeNorthWest", 7, 88],
        ["PlaceMonumentTreeEastRidge", 91, 65],
      ].map(([intentId, u, v], index) => ({
        kind: "single" as const,
        intentId: intentId as string,
        requirementId: "OutdoorMonumentTrees",
        priority: 280 - index,
        regionId: FIRST_FINISHED_REGION_ID,
        surfaceId: FIRST_FINISHED_REGION_SURFACE_ID,
        at: { u: u as number, v: v as number },
      })),
      {
        kind: "cluster",
        intentId: "PlaceLowerBushMass",
        requirementId: "OutdoorBushes",
        priority: 150,
        regionId: FIRST_FINISHED_REGION_ID,
        surfaceId: FIRST_FINISHED_REGION_SURFACE_ID,
        center: { u: 30, v: 55 },
        radiusMeters: 16,
        minimumCount: 10,
        targetCount: 14,
        minimumSeparationMeters: 2.2,
      },
      {
        kind: "cluster",
        intentId: "PlaceSummitBushMass",
        requirementId: "OutdoorBushes",
        priority: 140,
        regionId: FIRST_FINISHED_REGION_ID,
        surfaceId: FIRST_FINISHED_REGION_SURFACE_ID,
        center: { u: 53, v: 82 },
        radiusMeters: 16,
        minimumCount: 8,
        targetCount: 16,
        minimumSeparationMeters: 2.2,
      },
      {
        kind: "cluster",
        intentId: "PlaceRavineBoulders",
        requirementId: "OutdoorBoulders",
        priority: 130,
        regionId: FIRST_FINISHED_REGION_ID,
        surfaceId: FIRST_FINISHED_REGION_SURFACE_ID,
        center: { u: 42, v: 40 },
        radiusMeters: 24,
        minimumCount: 10,
        targetCount: 14,
        minimumSeparationMeters: 3.2,
      },
      {
        kind: "cluster",
        intentId: "PlaceOverlookRoundedRocks",
        requirementId: "OutdoorRoundedRocks",
        priority: 120,
        regionId: FIRST_FINISHED_REGION_ID,
        surfaceId: FIRST_FINISHED_REGION_SURFACE_ID,
        center: { u: 67, v: 42 },
        radiusMeters: 15,
        minimumCount: 10,
        targetCount: 14,
        minimumSeparationMeters: 2.4,
      },
      {
        kind: "cluster",
        intentId: "PlaceTrailheadStoneField",
        requirementId: "OutdoorRocks",
        priority: 110,
        regionId: FIRST_FINISHED_REGION_ID,
        surfaceId: FIRST_FINISHED_REGION_SURFACE_ID,
        center: { u: 19, v: 24 },
        radiusMeters: 14,
        minimumCount: 13,
        targetCount: 18,
        minimumSeparationMeters: 1.8,
      },
      {
        kind: "surface_scatter",
        intentId: "PlaceWestFernFloor",
        requirementId: "OutdoorGroundcover",
        priority: 100,
        regionId: FIRST_FINISHED_REGION_ID,
        surfaceId: FIRST_FINISHED_REGION_SURFACE_ID,
        boundary: rectangle(4, 48, 44, 94),
        minimumCount: 22,
        targetCount: 30,
        minimumSeparationMeters: 1.25,
      },
      {
        kind: "surface_scatter",
        intentId: "PlaceEastFernFloor",
        requirementId: "OutdoorGroundcover",
        priority: 90,
        regionId: FIRST_FINISHED_REGION_ID,
        surfaceId: FIRST_FINISHED_REGION_SURFACE_ID,
        boundary: rectangle(55, 49, 94, 94),
        minimumCount: 18,
        targetCount: 25,
        minimumSeparationMeters: 1.25,
      },
      {
        kind: "surface_scatter",
        intentId: "PlaceLowerGrassMeadow",
        requirementId: "OutdoorGrass",
        priority: 80,
        regionId: FIRST_FINISHED_REGION_ID,
        surfaceId: FIRST_FINISHED_REGION_SURFACE_ID,
        boundary: rectangle(4, 8, 92, 38),
        minimumCount: 24,
        targetCount: 30,
        minimumSeparationMeters: 1.45,
      },
      {
        kind: "along_route",
        intentId: "PlaceRidgeTrailGrassWest",
        requirementId: "OutdoorGrass",
        priority: 309,
        regionId: FIRST_FINISHED_REGION_ID,
        routeId: "RidgeTrail",
        count: 6,
        lateralOffsetMeters: -3.2,
        minimumSeparationMeters: 1.3,
      },
      ...[
        ["PlaceWestLog", 7, 56],
        ["PlacePavilionLog", 39, 88],
        ["PlaceLowerLog", 6, 28],
        ["PlaceEastLog", 90, 24],
        ["PlaceTowerLog", 88, 91],
        ["PlaceRavineLog", 22, 51],
        ["PlaceMeadowLog", 54, 22],
        ["PlaceOverlookLog", 78, 46],
      ].map(([intentId, u, v], index) => ({
        kind: "single" as const,
        intentId: intentId as string,
        requirementId: "OutdoorProps",
        priority: 250 - index,
        regionId: FIRST_FINISHED_REGION_ID,
        surfaceId: FIRST_FINISHED_REGION_SURFACE_ID,
        at: { u: u as number, v: v as number },
      })),
    ],
    cameras: [
      {
        cameraId: "FirstFinishedRegionOverview",
        positionMeters: { x: 48, y: 82, z: 116 },
        lookAtMeters: { x: 48, y: 9, z: 52 },
        up: { x: 0, y: 1, z: 0 },
        fieldOfViewDegrees: 55,
        regionIds: [FIRST_FINISHED_REGION_ID],
        readabilityIntent: {
          kind: "art_directed",
          rationale:
            "Show the directional ascent, two elevated crossings, forest belts, and summit destinations.",
        },
      },
      {
        cameraId: "TrailheadReveal",
        positionMeters: { x: 8, y: 3.2, z: -6 },
        lookAtMeters: { x: 72, y: 25, z: 83 },
        up: { x: 0, y: 1, z: 0 },
        fieldOfViewDegrees: 55,
        regionIds: [FIRST_FINISHED_REGION_ID],
        readabilityIntent: {
          kind: "art_directed",
          rationale:
            "Test whether the tower silhouette reads over the ridge before its entrance is revealed.",
        },
      },
      {
        cameraId: "RavineBoardwalk",
        positionMeters: { x: 14, y: 20, z: 18 },
        lookAtMeters: { x: 42, y: 4, z: 41 },
        up: { x: 0, y: 1, z: 0 },
        fieldOfViewDegrees: 58,
        regionIds: [FIRST_FINISHED_REGION_ID],
        readabilityIntent: {
          kind: "art_directed",
          rationale:
            "Show the elevated boardwalk spanning the carved ravine below the upper ridge.",
        },
      },
      {
        cameraId: "SummitDestinations",
        positionMeters: { x: 49, y: 40, z: 108 },
        lookAtMeters: { x: 51, y: 17, z: 75 },
        up: { x: 0, y: 1, z: 0 },
        fieldOfViewDegrees: 55,
        regionIds: [FIRST_FINISHED_REGION_ID],
        readabilityIntent: {
          kind: "art_directed",
          rationale:
            "Show the pavilion and roofed tower as distinct destinations on layered summits.",
        },
      },
    ],
  });
  return {
    ...catalogFixture,
    plan,
    compileInput: {
      semanticModule: module,
      catalogSnapshot: catalogFixture.catalogCommit.snapshot,
      catalogAssets: catalogFixture.measurements.assets,
      spatialPlan: plan,
    },
  };
}

function regionRoutes(): WorldRoute[] {
  return [
    groundedRoute({
      routeId: "TrailheadApproach",
      alignmentMeters: [
        { x: 8, z: 8 },
        { x: 9, z: 15 },
        { x: 14, z: 21 },
        { x: 20, z: 25 },
        { x: 26, z: 31 },
      ],
      startClearanceMeters: 0.08,
      endClearanceMeters: 0.44,
      terrainPriority: 0,
    }),
    elevatedRoute({
      routeId: "ScenicBoardwalk",
      alignmentMeters: [
        { x: 26, z: 31 },
        { x: 31, z: 34 },
        { x: 36, z: 38 },
        { x: 41, z: 42 },
        { x: 46, z: 47 },
        { x: 52, z: 52 },
      ],
      terrainPriority: 1,
      intermediateClearances: [
        { stationFraction: 0.12, clearanceMeters: 1 },
        { stationFraction: 0.82, clearanceMeters: 1 },
      ],
    }),
    groundedRoute({
      routeId: "RidgeTrail",
      alignmentMeters: [
        { x: 52, z: 52 },
        { x: 49, z: 57 },
        { x: 48, z: 64 },
        { x: 52, z: 69 },
        { x: 57, z: 71 },
        { x: 62, z: 72 },
        { x: 66, z: 68 },
      ],
      startClearanceMeters: 0.44,
      endClearanceMeters: 0.44,
      terrainPriority: 2,
    }),
    groundedRoute({
      routeId: FIRST_FINISHED_REGION_TOWER_ENTRY_ROUTE_ID,
      alignmentMeters: [
        { x: 66, z: 68 },
        { x: 70, z: 68 },
        { x: 72, z: 70 },
      ],
      startClearanceMeters: 0.44,
      endClearanceMeters: 0.08,
      terrainPriority: 3,
    }),
    groundedRoute({
      routeId: FIRST_FINISHED_REGION_OVERLOOK_ROUTE_ID,
      alignmentMeters: [
        { x: 38, z: 74 },
        { x: 32, z: 76 },
        { x: 25, z: 80 },
      ],
      startClearanceMeters: 0.44,
      endClearanceMeters: 0.08,
      terrainPriority: 5,
    }),
    elevatedRoute({
      routeId: "SummitSkywalk",
      alignmentMeters: [
        { x: 66, z: 68 },
        { x: 60, z: 70 },
        { x: 54, z: 73 },
        { x: 46, z: 73 },
        { x: 38, z: 74 },
      ],
      terrainPriority: 4,
      intermediateClearances: [
        { stationFraction: 0.22, clearanceMeters: 1.2 },
        { stationFraction: 0.88, clearanceMeters: 2.1 },
      ],
    }),
    groundedRoute({
      routeId: FIRST_FINISHED_REGION_RAVINE_OVERLOOK_ROUTE_ID,
      alignmentMeters: [
        { x: 52, z: 52 },
        { x: 57, z: 51 },
        { x: 62, z: 49 },
        { x: 67, z: 48 },
      ],
      startClearanceMeters: 0.44,
      endClearanceMeters: 0.08,
      terrainPriority: 6,
    }),
  ];
}

const constructionLiteral = (value: number) => ({ kind: "literal" as const, value });
const constructionVector = (x: number, y: number, z: number) => ({
  x: constructionLiteral(x),
  y: constructionLiteral(y),
  z: constructionLiteral(z),
});

function ridgePavilionProgram(input: {
  readonly semanticDependencyClosureHash: string;
  readonly styleProfileHash: string;
  readonly regionId: string;
  readonly surfaceId: string;
  readonly entryRouteId: string;
  readonly anchorPositionMeters: { readonly x: number; readonly z: number };
}): ConstructionProgram {
  const timber = constructionAppearance("WoodPlanks", { red: 103, green: 70, blue: 39 });
  const darkTimber = constructionAppearance("WoodPlanks", { red: 72, green: 47, blue: 28 });
  const roof = constructionAppearance("Slate", { red: 62, green: 76, blue: 58 });
  return sealConstructionProgram({
    programId: "RidgePavilion",
    regionId: input.regionId,
    semanticDependencyClosureHash: input.semanticDependencyClosureHash,
    styleProfileHash: input.styleProfileHash,
    defaultAppearance: timber,
    anchor: {
      kind: "placement_surface",
      surfaceId: input.surfaceId,
      horizontalPositionMeters: input.anchorPositionMeters,
      elevationOffsetMeters: 0,
    },
    localFrame: {
      originOffsetMeters: { x: 0, y: 0, z: 0 },
      yawQuarterTurns: 0,
    },
    parameters: [],
    operations: [
      {
        operationId: "PavilionDeck",
        kind: "box",
        centerMeters: constructionVector(0, 0.15, 4),
        sizeMeters: constructionVector(7, 0.3, 6),
        templateOnly: false,
      },
      {
        operationId: "PavilionEntrySteps",
        kind: "stair_run",
        originMeters: constructionVector(0, 0, 0),
        direction: "positive_z",
        widthMeters: constructionLiteral(2.2),
        runMeters: constructionLiteral(1),
        riseMeters: constructionLiteral(0.3),
        maximumRiserHeightMeters: constructionLiteral(0.15),
        maximumTreadDepthMeters: constructionLiteral(0.5),
        minimumHeadroomMeters: constructionLiteral(2.2),
        entryRouteId: input.entryRouteId,
        landingOperationId: "PavilionDeck",
      },
      ...([-1, 1] as const).flatMap((xSign) =>
        ([1.35, 6.65] as const).map((z, index) => ({
          operationId: `PavilionPost_${xSign < 0 ? "West" : "East"}_${index === 0 ? "Front" : "Back"}`,
          kind: "cylinder" as const,
          centerMeters: constructionVector(xSign * 3.1, 2.2, z),
          radiusMeters: constructionLiteral(0.2),
          heightMeters: constructionLiteral(4.1),
          sides: 12,
          templateOnly: false,
          appearance: darkTimber,
        })),
      ),
      {
        operationId: "PavilionRoof",
        kind: "box",
        centerMeters: constructionVector(0, 4.35, 4),
        sizeMeters: constructionVector(8, 0.32, 7),
        templateOnly: false,
        appearance: roof,
      },
      {
        operationId: "PavilionRoofCrown",
        kind: "box",
        centerMeters: constructionVector(0, 4.58, 4),
        sizeMeters: constructionVector(7.2, 0.16, 0.32),
        templateOnly: false,
        appearance: darkTimber,
      },
      ...([-1, 1] as const).map((xSign) => ({
        operationId: `PavilionSideRail_${xSign < 0 ? "West" : "East"}`,
        kind: "box" as const,
        centerMeters: constructionVector(xSign * 3.25, 1.05, 4),
        sizeMeters: constructionVector(0.14, 0.14, 5.4),
        templateOnly: false,
        appearance: darkTimber,
      })),
      {
        operationId: "PavilionBackRail",
        kind: "box",
        centerMeters: constructionVector(0, 1.05, 6.85),
        sizeMeters: constructionVector(6.5, 0.14, 0.14),
        templateOnly: false,
        appearance: darkTimber,
      },
      {
        operationId: "PavilionBenchSeat",
        kind: "box",
        centerMeters: constructionVector(0, 0.68, 5.75),
        sizeMeters: constructionVector(4.2, 0.22, 0.85),
        templateOnly: false,
        appearance: darkTimber,
      },
      {
        operationId: "PavilionBenchBack",
        kind: "box",
        centerMeters: constructionVector(0, 1.2, 6.08),
        sizeMeters: constructionVector(4.2, 0.9, 0.18),
        templateOnly: false,
        appearance: darkTimber,
      },
    ],
    contributionEvidenceHashes: [contentHash("first-finished-region-ridge-pavilion")],
  });
}

function ravineOverlookProgram(input: {
  readonly semanticDependencyClosureHash: string;
  readonly styleProfileHash: string;
  readonly regionId: string;
  readonly surfaceId: string;
  readonly entryRouteId: string;
  readonly anchorPositionMeters: { readonly x: number; readonly z: number };
}): ConstructionProgram {
  const timber = constructionAppearance("WoodPlanks", { red: 109, green: 74, blue: 42 });
  const darkTimber = constructionAppearance("WoodPlanks", { red: 69, green: 45, blue: 27 });
  const roof = constructionAppearance("Slate", { red: 55, green: 70, blue: 60 });
  return sealConstructionProgram({
    programId: "RavineOverlook",
    regionId: input.regionId,
    semanticDependencyClosureHash: input.semanticDependencyClosureHash,
    styleProfileHash: input.styleProfileHash,
    defaultAppearance: timber,
    anchor: {
      kind: "placement_surface",
      surfaceId: input.surfaceId,
      horizontalPositionMeters: input.anchorPositionMeters,
      elevationOffsetMeters: 0,
    },
    localFrame: {
      originOffsetMeters: { x: 0, y: 0, z: 0 },
      yawQuarterTurns: 2,
    },
    parameters: [],
    operations: [
      {
        operationId: "OverlookDeck",
        kind: "box",
        centerMeters: constructionVector(0, 0.25, 3.1),
        sizeMeters: constructionVector(7.2, 0.5, 6.2),
        templateOnly: false,
      },
      {
        operationId: "OverlookEntrySteps",
        kind: "stair_run",
        originMeters: constructionVector(0, 0, 0),
        direction: "positive_z",
        widthMeters: constructionLiteral(2.2),
        runMeters: constructionLiteral(0.9),
        riseMeters: constructionLiteral(0.5),
        maximumRiserHeightMeters: constructionLiteral(0.25),
        maximumTreadDepthMeters: constructionLiteral(0.45),
        minimumHeadroomMeters: constructionLiteral(2.2),
        entryRouteId: input.entryRouteId,
        landingOperationId: "OverlookDeck",
      },
      ...([-1, 1] as const).flatMap((xSign) =>
        ([1.5, 5.35] as const).map((z, index) => ({
          operationId: `OverlookSupport_${xSign < 0 ? "West" : "East"}_${index === 0 ? "Near" : "Far"}`,
          kind: "cylinder" as const,
          centerMeters: constructionVector(xSign * 3.05, -1.8, z),
          radiusMeters: constructionLiteral(0.22),
          heightMeters: constructionLiteral(4.1),
          sides: 12,
          templateOnly: false,
          appearance: darkTimber,
        })),
      ),
      ...([-1, 1] as const).map((xSign) => ({
        operationId: `OverlookSideRail_${xSign < 0 ? "West" : "East"}`,
        kind: "box" as const,
        centerMeters: constructionVector(xSign * 3.42, 1.1, 3.25),
        sizeMeters: constructionVector(0.16, 0.16, 5.7),
        templateOnly: false,
        appearance: darkTimber,
      })),
      {
        operationId: "OverlookViewRail",
        kind: "box",
        centerMeters: constructionVector(0, 1.1, 5.95),
        sizeMeters: constructionVector(6.85, 0.16, 0.16),
        templateOnly: false,
        appearance: darkTimber,
      },
      ...([-1, 1] as const).map((xSign) => ({
        operationId: `OverlookCanopyPost_${xSign < 0 ? "West" : "East"}`,
        kind: "box" as const,
        centerMeters: constructionVector(xSign * 3.05, 2.15, 1.75),
        sizeMeters: constructionVector(0.24, 3.8, 0.24),
        templateOnly: false,
        appearance: darkTimber,
      })),
      {
        operationId: "OverlookCanopyRoof",
        kind: "box",
        centerMeters: constructionVector(0, 4.08, 1.8),
        sizeMeters: constructionVector(7.8, 0.32, 3.6),
        templateOnly: false,
        appearance: roof,
      },
      {
        operationId: "OverlookBenchSeat",
        kind: "box",
        centerMeters: constructionVector(0, 0.78, 1.75),
        sizeMeters: constructionVector(4.2, 0.22, 0.8),
        templateOnly: false,
        appearance: darkTimber,
      },
      {
        operationId: "OverlookBenchBack",
        kind: "box",
        centerMeters: constructionVector(0, 1.32, 1.42),
        sizeMeters: constructionVector(4.2, 0.9, 0.18),
        templateOnly: false,
        appearance: darkTimber,
      },
    ],
    contributionEvidenceHashes: [contentHash("first-finished-region-ravine-overlook")],
  });
}

function trailheadGatewayProgram(input: {
  readonly semanticDependencyClosureHash: string;
  readonly styleProfileHash: string;
  readonly regionId: string;
  readonly surfaceId: string;
  readonly anchorPositionMeters: { readonly x: number; readonly z: number };
}): ConstructionProgram {
  const timber = constructionAppearance("WoodPlanks", { red: 82, green: 54, blue: 31 });
  const sign = constructionAppearance("WoodPlanks", { red: 132, green: 91, blue: 49 });
  return sealConstructionProgram({
    programId: "TrailheadGateway",
    regionId: input.regionId,
    semanticDependencyClosureHash: input.semanticDependencyClosureHash,
    styleProfileHash: input.styleProfileHash,
    defaultAppearance: timber,
    anchor: {
      kind: "placement_surface",
      surfaceId: input.surfaceId,
      horizontalPositionMeters: input.anchorPositionMeters,
      elevationOffsetMeters: 0,
    },
    localFrame: {
      originOffsetMeters: { x: 0, y: 0, z: 0 },
      yawQuarterTurns: 0,
    },
    parameters: [],
    operations: [
      ...([-1, 1] as const).map((xSign) => ({
        operationId: `GatewayPost_${xSign < 0 ? "West" : "East"}`,
        kind: "cylinder" as const,
        centerMeters: constructionVector(xSign * 1.55, 1.7, 0),
        radiusMeters: constructionLiteral(0.2),
        heightMeters: constructionLiteral(3.4),
        sides: 12,
        templateOnly: false,
      })),
      {
        operationId: "GatewayLintel",
        kind: "box",
        centerMeters: constructionVector(0, 3.3, 0),
        sizeMeters: constructionVector(3.5, 0.3, 0.34),
        templateOnly: false,
      },
      {
        operationId: "GatewaySign",
        kind: "box",
        centerMeters: constructionVector(0, 2.72, 0),
        sizeMeters: constructionVector(1.8, 0.58, 0.18),
        templateOnly: false,
        appearance: sign,
      },
      {
        operationId: "GatewayCap",
        kind: "box",
        centerMeters: constructionVector(0, 3.53, 0),
        sizeMeters: constructionVector(3.9, 0.16, 0.48),
        templateOnly: false,
        appearance: sign,
      },
    ],
    contributionEvidenceHashes: [contentHash("first-finished-region-trailhead-gateway")],
  });
}

function groundedRoute(input: {
  readonly routeId: string;
  readonly alignmentMeters: WorldRoute["alignmentMeters"];
  readonly startClearanceMeters: number;
  readonly endClearanceMeters: number;
  readonly terrainPriority: number;
}): WorldRoute {
  return {
    ...commonRoute(input),
    appearance: appearance("Ground", { red: 88, green: 65, blue: 42 }),
    construction: {
      kind: "follow_surface",
      surfaceRevealMeters: 0.08,
      crossfallRatio: 0,
      maximumGradeRatio: 0.82,
      shoulderWidthMeters: 0.35,
      blendWidthMeters: 0.8,
      maximumCutDepthMeters: 5,
      maximumFillDepthMeters: 5,
      groundingToleranceMeters: 0.12,
      vegetationClearanceMeters: 0.7,
      terrainMaterialId: "Ground",
    },
  };
}

function elevatedRoute(input: {
  readonly routeId: string;
  readonly alignmentMeters: WorldRoute["alignmentMeters"];
  readonly terrainPriority: number;
  readonly intermediateClearances?: readonly {
    readonly stationFraction: number;
    readonly clearanceMeters: number;
  }[];
}): WorldRoute {
  const routeAppearance = appearance("WoodPlanks", { red: 101, green: 68, blue: 39 });
  return {
    ...commonRoute({
      ...input,
      startClearanceMeters: 0.44,
      endClearanceMeters: 0.44,
    }),
    appearance: routeAppearance,
    construction: {
      kind: "elevated",
      maximumGradeRatio: 0.55,
      minimumGroundClearanceMeters: 0.15,
      supportSpacingMeters: 2.8,
      supportRadiusMeters: 0.17,
      maximumSupportHeightMeters: 12,
      vegetationClearanceMeters: 0.7,
      supportAppearance: routeAppearance,
      edgeProtection: {
        kind: "guardrail",
        heightMeters: 0.95,
        railThicknessMeters: 0.16,
        postSpacingMeters: 1.8,
        postRadiusMeters: 0.07,
        appearance: appearance("WoodPlanks", { red: 65, green: 42, blue: 25 }),
      },
    },
  };
}

function commonRoute(input: {
  readonly routeId: string;
  readonly alignmentMeters: WorldRoute["alignmentMeters"];
  readonly startClearanceMeters: number;
  readonly endClearanceMeters: number;
  readonly terrainPriority: number;
  readonly intermediateClearances?: readonly {
    readonly stationFraction: number;
    readonly clearanceMeters: number;
  }[];
}) {
  return {
    routeId: input.routeId,
    semanticEntityId: FIRST_FINISHED_REGION_ROUTE_ENTITY_ID,
    regionIds: [FIRST_FINISHED_REGION_ID],
    surfaceId: FIRST_FINISHED_REGION_SURFACE_ID,
    alignmentMeters: input.alignmentMeters,
    elevationControls: [
      elevationControl(`${input.routeId}Start`, 0, input.startClearanceMeters),
      ...(input.intermediateClearances ?? []).map((control, index) =>
        elevationControl(
          `${input.routeId}Intermediate${(index + 1).toString()}`,
          control.stationFraction,
          control.clearanceMeters,
        ),
      ),
      elevationControl(`${input.routeId}End`, 1, input.endClearanceMeters),
    ],
    widthMeters: 2.2,
    thicknessMeters: 0.2,
    bendRadiusMeters: 2,
    maximumSegmentLengthMeters: 0.7,
    terrainPriority: input.terrainPriority,
    closed: false,
  };
}

function routeJunction(
  junctionId: string,
  positionMeters: { readonly x: number; readonly z: number },
  participants: {
    routeId: string;
    endpoint: "start" | "end";
  }[],
) {
  return {
    junctionId,
    kind: "intersection" as const,
    positionMeters,
    surfaceElevation: { kind: "terrain_clearance" as const, clearanceMeters: 0.44 },
    participants,
    maximumSnapDistanceMeters: 0.01,
    radiusMeters: 1.1,
    appearance: appearance("WoodPlanks", { red: 101, green: 68, blue: 39 }),
    terrainMaterialId: "Ground",
  };
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
  return { materialId, styleProfileHash: FIRST_FINISHED_REGION_STYLE_HASH, baseColorSrgb };
}

function constructionAppearance(
  materialId: string,
  baseColorSrgb: { readonly red: number; readonly green: number; readonly blue: number },
) {
  return { materialId, baseColorSrgb };
}

function expandedCatalogRequirements(module: SemanticModule): CatalogRequirement[] {
  return [
    catalogRequirement(module, "OutdoorTrees", "bsc_000003", 28),
    catalogRequirement(module, "OutdoorPines", "bsc_000003", 34, [2.46, 7.54, 2.35]),
    catalogRequirement(module, "OutdoorUnderstoryTrees", "bsc_000003", 22, [2.34, 3.85, 1.83]),
    catalogRequirement(module, "OutdoorMonumentTrees", "bsc_000003", 8, [5.82, 9.63, 6.36]),
    catalogRequirement(module, "OutdoorBushes", "bsc_000004", 34, [2.1, 2.05, 2.02]),
    catalogRequirement(module, "OutdoorRocks", "bsc_000012", 22),
    catalogRequirement(module, "OutdoorRoundedRocks", "bsc_000012", 18, [1.37, 0.51, 1.58]),
    catalogRequirement(module, "OutdoorBoulders", "bsc_000013", 18),
    catalogRequirement(module, "OutdoorGroundcover", "bsc_000005", 60),
    catalogRequirement(module, "OutdoorGrass", "bsc_000005", 60, [0.83, 0.7, 0.38]),
    catalogRequirement(module, "OutdoorProps", "bsc_000018", 8),
  ];
}

function catalogRequirement(
  module: SemanticModule,
  requirementId: string,
  conceptId: string,
  maximumInstances: number,
  maximumSizeMeters?: readonly [number, number, number],
): CatalogRequirement {
  const concept = requireConcept(module, conceptId);
  const closure = createSemanticDependencyClosure({
    module,
    conceptIds: [conceptId],
    definitionIds: ["whole"],
  });
  return {
    requirementId,
    semantic: {
      denotation: {
        conceptId,
        commitmentHash: concept.commitmentHash,
        matchMode: "exact",
      },
      realizationForms: ["whole"],
      affordances: [],
      states: [],
      surfaceTreatmentIds: [],
      dependencyClosureHash: closure.hash,
    },
    acceptedEntryKinds: ["substitution_set"],
    styleProfileHandles: ["stylized_low_poly_nature"],
    placement: { requiredSupport: "ground", requiredInterfaceIds: [] },
    metricBounds: maximumSizeMeters
      ? {
          maximumSizeMeters: {
            x: quantizeQ32_32(maximumSizeMeters[0]),
            y: quantizeQ32_32(maximumSizeMeters[1]),
            z: quantizeQ32_32(maximumSizeMeters[2]),
          },
        }
      : {},
    rights: { commercialUseRequired: true, redistributionRequired: true },
    budget: {
      maximumTriangles: 5_000_000,
      maximumSourceBytes: 512 * 1024 * 1024,
      maximumInstances,
    },
    required: true,
  };
}

function requireConcept(module: SemanticModule, conceptId: string) {
  const concept = module.concepts.find((entry) => entry.conceptId === conceptId);
  if (!concept) throw new Error(`First-finished-region concept is missing: ${conceptId}`);
  return concept;
}

function rectangle(minU: number, minV: number, maxU: number, maxV: number) {
  return [
    { u: minU, v: minV },
    { u: maxU, v: minV },
    { u: maxU, v: maxV },
    { u: minU, v: maxV },
  ];
}

function rectangleXZ(minX: number, minZ: number, maxX: number, maxZ: number) {
  return [
    { x: minX, z: minZ },
    { x: maxX, z: minZ },
    { x: maxX, z: maxZ },
    { x: minX, z: maxZ },
  ];
}
