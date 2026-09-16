import { contentHash } from "@basalt/contracts";
import {
  createSemanticDependencyClosure,
  sealSemanticAssertionBundle,
  type SemanticModule,
} from "@basalt/semantic-kernel";
import { sealSpatialWorldPlan, type WorldRoute } from "@basalt/world-planning";
import { catalogFirstUseFixture } from "./catalog-first-use-fixture.js";
import { observationTowerProgram } from "./observation-tower-fixture.js";

export const FIRST_FINISHED_REGION_OUTPUT_ROOT = ".basalt/evals/first-finished-region";
export const FIRST_FINISHED_REGION_ID = "FirstFinishedRegion";
export const FIRST_FINISHED_REGION_SURFACE_ID = "FirstFinishedRegionGround";
export const FIRST_FINISHED_REGION_ROUTE_ENTITY_ID = "FirstFinishedRegionRouteEntity";
export const FIRST_FINISHED_REGION_TOWER_ENTRY_ROUTE_ID = "TowerSpur";
export const FIRST_FINISHED_REGION_STYLE_HASH = contentHash(
  "first-finished-region-stylized-low-poly-nature",
);

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
    anchorPositionMeters: { x: 34, z: 20 },
    towerCenterOffsetMeters: 8,
    heightMeters: 6.5,
    widthMeters: 6.5,
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
    regions: [
      {
        regionId: FIRST_FINISHED_REGION_ID,
        semanticEntityId: regionEntity.entityId,
        volume: {
          kind: "box",
          bounds: { min: { x: 0, y: -4, z: 0 }, max: { x: 48, y: 20, z: 48 } },
        },
        refinementPriority: 0,
      },
    ],
    placementSurfaces: [
      {
        surfaceId: FIRST_FINISHED_REGION_SURFACE_ID,
        regionId: FIRST_FINISHED_REGION_ID,
        kind: "terrain",
        bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 48, y: 0, z: 48 } },
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
          x: { minimum: 0, maximum: 48 },
          z: { minimum: 0, maximum: 48 },
        },
        resolution: { columns: 65, rows: 65 },
        baseElevationMeters: 0,
        operations: [
          { kind: "raise", center: { x: 28, z: 27 }, radiusMeters: 21, deltaMeters: 3.4 },
          { kind: "carve", center: { x: 15, z: 17 }, radiusMeters: 6, depthMeters: 1.1 },
          {
            kind: "flatten",
            polygon: rectangleXZ(2, 3, 10, 12),
            elevationMeters: 0.35,
            blendWidthMeters: 1.5,
          },
          {
            kind: "flatten",
            polygon: rectangleXZ(29, 18, 40, 35),
            elevationMeters: 2.8,
            blendWidthMeters: 2.5,
          },
        ],
        materialId: "Grass",
      },
    ],
    routes,
    routeJunctions: [
      routeJunction("TrailSplit", { x: 8, z: 9 }, [
        { routeId: "TrailheadApproach", endpoint: "end" },
        { routeId: "RidgeTrail", endpoint: "start" },
        { routeId: "ScenicBoardwalk", endpoint: "start" },
      ]),
      routeJunction("TowerMerge", { x: 29, z: 17 }, [
        { routeId: "RidgeTrail", endpoint: "end" },
        { routeId: "ScenicBoardwalk", endpoint: "end" },
        { routeId: FIRST_FINISHED_REGION_TOWER_ENTRY_ROUTE_ID, endpoint: "start" },
      ]),
    ],
    constructionPrograms: [tower],
    realizationIntents: [
      {
        kind: "cluster",
        intentId: "PlaceNorthGrove",
        requirementId: "OutdoorTrees",
        priority: 60,
        regionId: FIRST_FINISHED_REGION_ID,
        surfaceId: FIRST_FINISHED_REGION_SURFACE_ID,
        center: { u: 12, v: 36 },
        radiusMeters: 8,
        minimumCount: 5,
        targetCount: 7,
        minimumSeparationMeters: 3,
      },
      {
        kind: "cluster",
        intentId: "PlaceEastGrove",
        requirementId: "OutdoorTrees",
        priority: 50,
        regionId: FIRST_FINISHED_REGION_ID,
        surfaceId: FIRST_FINISHED_REGION_SURFACE_ID,
        center: { u: 39, v: 37 },
        radiusMeters: 7,
        minimumCount: 3,
        targetCount: 3,
        minimumSeparationMeters: 2,
      },
      {
        kind: "cluster",
        intentId: "PlaceRidgeRocks",
        requirementId: "OutdoorRocks",
        priority: 40,
        regionId: FIRST_FINISHED_REGION_ID,
        surfaceId: FIRST_FINISHED_REGION_SURFACE_ID,
        center: { u: 29, v: 39 },
        radiusMeters: 6,
        minimumCount: 3,
        targetCount: 5,
        minimumSeparationMeters: 2,
      },
      {
        kind: "surface_scatter",
        intentId: "PlaceWoodlandGroundcover",
        requirementId: "OutdoorGroundcover",
        priority: 30,
        regionId: FIRST_FINISHED_REGION_ID,
        surfaceId: FIRST_FINISHED_REGION_SURFACE_ID,
        boundary: rectangle(4, 25, 25, 45),
        minimumCount: 12,
        targetCount: 18,
        minimumSeparationMeters: 1.4,
      },
      {
        kind: "single",
        intentId: "PlaceFallenLog",
        requirementId: "OutdoorProps",
        priority: 20,
        regionId: FIRST_FINISHED_REGION_ID,
        surfaceId: FIRST_FINISHED_REGION_SURFACE_ID,
        at: { u: 21, v: 28 },
      },
    ],
    cameras: [
      {
        cameraId: "FirstFinishedRegionOverview",
        positionMeters: { x: 24, y: 38, z: 55 },
        lookAtMeters: { x: 24, y: 2, z: 24 },
        up: { x: 0, y: 1, z: 0 },
        fieldOfViewDegrees: 55,
        regionIds: [FIRST_FINISHED_REGION_ID],
        readabilityIntent: {
          kind: "art_directed",
          rationale: "Show the approach split, wooded ridge, merge, and observation tower.",
        },
      },
      {
        cameraId: "TrailheadReveal",
        positionMeters: { x: 3, y: 2.2, z: 7 },
        lookAtMeters: { x: 34, y: 6, z: 28 },
        up: { x: 0, y: 1, z: 0 },
        fieldOfViewDegrees: 55,
        regionIds: [FIRST_FINISHED_REGION_ID],
        readabilityIntent: {
          kind: "art_directed",
          rationale:
            "Test whether the tower silhouette reads over the ridge before its entrance is revealed.",
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
        { x: 3, z: 7 },
        { x: 5.5, z: 7.5 },
        { x: 8, z: 9 },
      ],
      startClearanceMeters: 0.08,
      endClearanceMeters: 0.44,
      terrainPriority: 0,
    }),
    groundedRoute({
      routeId: "RidgeTrail",
      alignmentMeters: [
        { x: 8, z: 9 },
        { x: 13, z: 10 },
        { x: 17, z: 13 },
        { x: 20, z: 17 },
        { x: 25, z: 18.5 },
        { x: 29, z: 17 },
      ],
      startClearanceMeters: 0.44,
      endClearanceMeters: 0.44,
      terrainPriority: 1,
    }),
    elevatedRoute({
      routeId: "ScenicBoardwalk",
      alignmentMeters: [
        { x: 8, z: 9 },
        { x: 8, z: 14 },
        { x: 12, z: 18 },
        { x: 18, z: 20 },
        { x: 24, z: 20 },
        { x: 29, z: 17 },
      ],
      terrainPriority: 2,
    }),
    groundedRoute({
      routeId: FIRST_FINISHED_REGION_TOWER_ENTRY_ROUTE_ID,
      alignmentMeters: [
        { x: 29, z: 17 },
        { x: 32, z: 18 },
        { x: 34, z: 20 },
      ],
      startClearanceMeters: 0.44,
      endClearanceMeters: 0.08,
      terrainPriority: 3,
    }),
  ];
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
    appearance: appearance("Ground", { red: 104, green: 82, blue: 55 }),
    construction: {
      kind: "follow_surface",
      surfaceRevealMeters: 0.08,
      crossfallRatio: 0,
      maximumGradeRatio: 0.8,
      shoulderWidthMeters: 0.35,
      blendWidthMeters: 0.8,
      maximumCutDepthMeters: 3,
      maximumFillDepthMeters: 3,
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
}): WorldRoute {
  const routeAppearance = appearance("WoodPlanks", { red: 116, green: 84, blue: 52 });
  return {
    ...commonRoute({
      ...input,
      startClearanceMeters: 0.44,
      endClearanceMeters: 0.44,
    }),
    appearance: routeAppearance,
    construction: {
      kind: "elevated",
      maximumGradeRatio: 0.35,
      minimumGroundClearanceMeters: 0.18,
      supportSpacingMeters: 2.8,
      supportRadiusMeters: 0.17,
      maximumSupportHeightMeters: 5,
      vegetationClearanceMeters: 0.7,
      supportAppearance: routeAppearance,
      edgeProtection: {
        kind: "guardrail",
        heightMeters: 0.95,
        railThicknessMeters: 0.16,
        postSpacingMeters: 1.8,
        postRadiusMeters: 0.07,
        appearance: appearance("WoodPlanks", { red: 96, green: 65, blue: 38 }),
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
}) {
  return {
    routeId: input.routeId,
    semanticEntityId: FIRST_FINISHED_REGION_ROUTE_ENTITY_ID,
    regionIds: [FIRST_FINISHED_REGION_ID],
    surfaceId: FIRST_FINISHED_REGION_SURFACE_ID,
    alignmentMeters: input.alignmentMeters,
    elevationControls: [
      elevationControl(`${input.routeId}Start`, 0, input.startClearanceMeters),
      elevationControl(`${input.routeId}End`, 1, input.endClearanceMeters),
    ],
    widthMeters: 1.8,
    thicknessMeters: 0.16,
    bendRadiusMeters: 1.6,
    maximumSegmentLengthMeters: 0.56,
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
    radiusMeters: 0.9,
    appearance: appearance("WoodPlanks", { red: 116, green: 84, blue: 52 }),
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
