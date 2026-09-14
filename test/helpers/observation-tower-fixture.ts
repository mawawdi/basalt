import { contentHash } from "@basalt/contracts";
import { compileBasaltWorld, type WorldBuild } from "@basalt/world-compiler";
import {
  evaluateTerrainElevation,
  sealConstructionProgram,
  sealSpatialWorldPlan,
  type ConstructionProgram,
  type SpatialWorldPlan,
} from "@basalt/world-planning";
import type { SemanticModule } from "@basalt/semantic-kernel";
import type { WorldDiagnosticCamera, WorldVerifierExpectations } from "@basalt/world-refinement";
import { worldFixture } from "./world-fixture.js";

const literal = (value: number) => ({ kind: "literal" as const, value });
const bind = (parameterId: string, multiplier = 1, offset = 0) => ({
  kind: "parameter_binding" as const,
  parameterId,
  multiplier,
  offset,
});
const vector = (
  x: ReturnType<typeof literal> | ReturnType<typeof bind>,
  y: ReturnType<typeof literal> | ReturnType<typeof bind>,
  z: ReturnType<typeof literal> | ReturnType<typeof bind>,
) => ({ x, y, z });

export const TOWER_PROGRAM_ID = "ObservationTower";
export const TOWER_HEIGHT_PARAMETER_ID = "TowerHeight";
export const TOWER_WIDTH_PARAMETER_ID = "TowerWidth";
export const TOWER_NEURAL_GAP_RECEIPT_HASH = contentHash(
  "observation-tower-deterministic-fake-neural-gap-receipt",
);

export async function observationTowerFixture(module: SemanticModule): Promise<{
  readonly plan: SpatialWorldPlan;
  readonly compileInput: Omit<Parameters<typeof compileBasaltWorld>[0], "spatialPlan">;
}> {
  const fixture = await worldFixture(module);
  const regionClosureHash = fixture.plan.semanticEntities.find(
    (entry) => entry.entityId === "RegionEntity",
  )!.semanticDependencyClosureHash;
  const program = observationTowerProgram({
    semanticDependencyClosureHash: regionClosureHash,
    styleProfileHash: fixture.styleProfile.hash,
    heightMeters: 4,
    widthMeters: 5,
  });
  const {
    kind: _kind,
    coordinateSystem: _coordinateSystem,
    planHash: _planHash,
    ...planInput
  } = fixture.plan;
  const plan = sealSpatialWorldPlan({
    ...planInput,
    terrainPlans: fixture.plan.terrainPlans.map((terrain) => ({
      ...terrain,
      resolution: { columns: 21, rows: 21 },
      operations: [
        ...terrain.operations,
        {
          kind: "flatten" as const,
          polygon: [
            { x: 6, z: 3.5 },
            { x: 14, z: 3.5 },
            { x: 14, z: 16.5 },
            { x: 6, z: 16.5 },
          ],
          elevationMeters: 0.5,
          blendWidthMeters: 2,
        },
      ],
    })),
    routes: fixture.plan.routes.map((route) => ({
      ...route,
      alignmentMeters: [
        { x: 10, z: 0.8 },
        { x: 10, z: 4 },
      ],
      widthMeters: 1.4,
      thicknessMeters: 0.16,
    })),
    catalogRequirements: [],
    realizationIntents: [],
    constructionPrograms: [program],
  });
  return {
    plan,
    compileInput: {
      semanticModule: module,
      catalogSnapshot: fixture.snapshot,
      catalogAssets: [fixture.asset],
    },
  };
}

export function observationTowerProgram(input: {
  readonly semanticDependencyClosureHash: string;
  readonly styleProfileHash: string;
  readonly heightMeters: number;
  readonly widthMeters: number;
}): ConstructionProgram {
  const height = TOWER_HEIGHT_PARAMETER_ID;
  const width = TOWER_WIDTH_PARAMETER_ID;
  const towerCenterZ = 8;
  const halfInset = (sign: -1 | 1) => bind(width, sign * 0.5, sign * -0.2);
  const platformCenterY = bind(height, 1, -0.15);
  const railCenterY = bind(height, 1, 0.7);
  const sideRailSize = vector(literal(0.12), literal(1.4), bind(width));
  return sealConstructionProgram({
    programId: TOWER_PROGRAM_ID,
    regionId: "MainRegion",
    semanticDependencyClosureHash: input.semanticDependencyClosureHash,
    styleProfileHash: input.styleProfileHash,
    defaultMaterialId: "WoodPlanks",
    anchor: {
      kind: "placement_surface",
      surfaceId: "GroundSurface",
      horizontalPositionMeters: { x: 10, z: 4 },
      elevationOffsetMeters: 0,
    },
    localFrame: {
      originOffsetMeters: { x: 0, y: 0, z: 0 },
      yawQuarterTurns: 0,
    },
    parameters: [
      { parameterId: height, kind: "scalar", value: input.heightMeters, minimum: 3, maximum: 8 },
      { parameterId: width, kind: "scalar", value: input.widthMeters, minimum: 4, maximum: 8 },
    ],
    operations: [
      {
        operationId: "BackRailHost",
        kind: "box",
        centerMeters: vector(literal(0), railCenterY, bind(width, 0.5, towerCenterZ - 0.06)),
        sizeMeters: vector(bind(width), literal(1.4), literal(0.12)),
        templateOnly: false,
      },
      {
        operationId: "BackRailOpening",
        kind: "rectangular_opening",
        hostOperationId: "BackRailHost",
        plane: "xy",
        centerOffsetMeters: { horizontal: literal(0), vertical: literal(0.05) },
        sizeMeters: { width: literal(1.5), height: literal(1) },
        portalId: "TowerViewOpening",
        clearanceMeters: literal(0.2),
      },
      {
        operationId: "Landing",
        kind: "box",
        centerMeters: vector(literal(0), platformCenterY, literal(towerCenterZ)),
        sizeMeters: vector(bind(width), literal(0.3), bind(width)),
        templateOnly: false,
      },
      ...([-1, 1] as const).flatMap((xSign) =>
        ([-1, 1] as const).map((zSign) => ({
          operationId: `Post_${xSign < 0 ? "West" : "East"}_${zSign < 0 ? "Front" : "Back"}`,
          kind: "box" as const,
          centerMeters: vector(
            halfInset(xSign),
            bind(height, 0.5),
            bind(width, zSign * 0.5, towerCenterZ + zSign * -0.2),
          ),
          sizeMeters: vector(literal(0.4), bind(height), literal(0.4)),
          templateOnly: false,
        })),
      ),
      {
        operationId: "SideRailEast",
        kind: "box",
        centerMeters: vector(bind(width, 0.5, -0.06), railCenterY, literal(towerCenterZ)),
        sizeMeters: sideRailSize,
        templateOnly: false,
      },
      {
        operationId: "SideRailWest",
        kind: "box",
        centerMeters: vector(bind(width, -0.5, 0.06), railCenterY, literal(towerCenterZ)),
        sizeMeters: sideRailSize,
        templateOnly: false,
      },
      {
        operationId: "TowerStairs",
        kind: "stair_run",
        originMeters: vector(literal(0), literal(0), literal(0)),
        direction: "positive_z",
        widthMeters: literal(1.2),
        runMeters: bind(width, -0.5, towerCenterZ),
        riseMeters: bind(height),
        maximumRiserHeightMeters: literal(0.2),
        maximumTreadDepthMeters: literal(0.28),
        minimumHeadroomMeters: literal(2),
        entryRouteId: "MainRoute",
        landingOperationId: "Landing",
      },
    ],
    contributionEvidenceHashes: [
      contentHash("observation-tower-authored-construction"),
      TOWER_NEURAL_GAP_RECEIPT_HASH,
    ],
  });
}

export function towerExpectations(worldBuild: WorldBuild): WorldVerifierExpectations {
  const structure = worldBuild.meso.constructedStructures[0];
  if (!structure) throw new Error("Observation-tower build has no constructed structure");
  const landing = structure.elements.find((entry) => entry.operationId === "Landing");
  if (!landing) throw new Error("Observation-tower build has no landing");
  const ignoredElementIds = structure.elements
    .filter((entry) => entry.operationId === "TowerStairs")
    .map((entry) => entry.elementId);
  return {
    dimensions: [
      {
        structureId: structure.structureId,
        minimumMeters: { x: 6, y: 7, z: 6 },
        maximumMeters: { x: 8, y: 9.5, z: 13 },
      },
    ],
    access: [
      {
        structureId: structure.structureId,
        routeId: "MainRoute",
        maximumConnectionDistanceMeters: 0.25,
        minimumWidthMeters: 1,
        maximumRiserHeightMeters: 0.2,
        maximumTreadDepthMeters: 0.28,
        minimumHeadroomMeters: 2,
        minimumApproachLengthMeters: 2.5,
        maximumApproachAngleDegrees: 15,
      },
    ],
    viewCorridors: [
      {
        corridorId: "TowerApproachView",
        fromMeters: {
          x: (landing.boundsMeters.min.x + landing.boundsMeters.max.x) / 2,
          y: landing.boundsMeters.max.y + 1.4,
          z: landing.boundsMeters.min.z - 0.1,
        },
        toMeters: {
          x: (landing.boundsMeters.min.x + landing.boundsMeters.max.x) / 2,
          y: landing.boundsMeters.max.y + 1.4,
          z: landing.boundsMeters.min.z - 6,
        },
        ignoredElementIds,
      },
    ],
    styles: [
      {
        structureId: structure.structureId,
        styleProfileHash: structure.elements[0]!.styleProfileHash,
      },
    ],
    minimumNeighborClearanceMeters: 0.2,
  };
}

export function towerDiagnosticCameras(plan: SpatialWorldPlan): readonly WorldDiagnosticCamera[] {
  const program = plan.constructionPrograms.find((entry) => entry.programId === TOWER_PROGRAM_ID)!;
  const height = program.parameters.find(
    (entry) => entry.parameterId === TOWER_HEIGHT_PARAMETER_ID,
  )!.value;
  const width = program.parameters.find(
    (entry) => entry.parameterId === TOWER_WIDTH_PARAMETER_ID,
  )!.value;
  if (program.anchor.kind !== "placement_surface")
    throw new Error("Observation tower must use a placement-surface anchor");
  const anchor = program.anchor;
  const horizontal = anchor.horizontalPositionMeters;
  const terrain = plan.terrainPlans.find((entry) => entry.surfaceId === anchor.surfaceId);
  const surface = plan.placementSurfaces.find((entry) => entry.surfaceId === anchor.surfaceId);
  if (!surface) throw new Error("Observation tower placement surface is missing");
  const baseElevation = terrain
    ? evaluateTerrainElevation(terrain, horizontal.x, horizontal.z)
    : surface.bounds.max.y;
  const center = {
    x: horizontal.x,
    y: baseElevation + anchor.elevationOffsetMeters + height / 2,
    z: horizontal.z + 8,
  };
  const approach = plan.routes.find((entry) => entry.routeId === "MainRoute")!.alignmentMeters[0]!;
  return [
    {
      cameraId: "TowerApproachCamera",
      purpose: "approach",
      positionMeters: { x: approach.x, y: baseElevation + 2, z: approach.z - 0.3 },
      lookAtMeters: center,
      up: { x: 0, y: 1, z: 0 },
      verticalFieldOfViewDegrees: 55,
      widthPixels: 128,
      heightPixels: 96,
    },
    {
      cameraId: "TowerOverviewCamera",
      purpose: "overview",
      positionMeters: { x: 18, y: Math.min(11.5, height + 4), z: 18 },
      lookAtMeters: center,
      up: { x: 0, y: 1, z: 0 },
      verticalFieldOfViewDegrees: 55,
      widthPixels: 128,
      heightPixels: 96,
    },
    {
      cameraId: "TowerPlatformCamera",
      purpose: "platform",
      positionMeters: {
        x: horizontal.x,
        y: baseElevation + anchor.elevationOffsetMeters + height + 1.5,
        z: horizontal.z + 8 - width / 2 + 0.25,
      },
      lookAtMeters: {
        x: approach.x,
        y: baseElevation + anchor.elevationOffsetMeters + Math.max(1.5, height * 0.5),
        z: approach.z,
      },
      up: { x: 0, y: 1, z: 0 },
      verticalFieldOfViewDegrees: 55,
      widthPixels: 128,
      heightPixels: 96,
    },
  ];
}
