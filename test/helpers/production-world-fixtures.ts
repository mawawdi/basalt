import { contentHash, stableJson } from "../../packages/contracts/src/index.js";
import {
  TERRAIN_PLAN_ABI,
  WORLD_PLAN_ABI,
  WORLD_PLAN_SCHEMA,
  type SpatialWorldPlan,
} from "../../packages/world-planning/src/index.js";

/** A small domain-neutral plan used by compiler tests; it contains no assets. */
export function productionWorldPlanFixture(input: {
  readonly sceneId: string;
  readonly regionId: string;
  readonly surfaceId: string;
  readonly routeId: string;
  readonly anchorId: string;
  readonly cameraId: string;
  readonly materialId: string;
  readonly name: string;
}): SpatialWorldPlan {
  const footprint = [
    { x: -30, z: -30 },
    { x: 30, z: -30 },
    { x: 30, z: 30 },
    { x: -30, z: 30 },
  ];
  return WORLD_PLAN_SCHEMA.parse({
    kind: "SpatialWorldPlan",
    abi: WORLD_PLAN_ABI,
    id: input.sceneId,
    seed: 42017,
    styleContractHash: contentHash(stableJson({ style: "fixture", material: input.materialId })),
    bounds: { center: { x: 0, y: 18, z: 0 }, size: { x: 60, y: 44, z: 60 } },
    references: [
      {
        id: `${input.sceneId}Brief`,
        artifactHash: contentHash(input.name),
        mediaType: "text/plain",
        origin: "creator_supplied",
        producerQualificationHashes: [],
        roles: ["creator_brief"],
        rightsEvidenceHashes: [],
      },
    ],
    creatorClaims: [
      {
        id: `${input.sceneId}Claim`,
        statement: input.name,
        referenceIds: [`${input.sceneId}Brief`],
      },
    ],
    agentHypotheses: [],
    regions: [
      {
        id: input.regionId,
        name: input.name,
        purpose: "Exercise a bounded world region.",
        volume: {
          kind: "extruded_polygon",
          footprint,
          verticalRange: { minimum: -4, maximum: 40 },
        },
        compositionMeasures: [
          {
            id: `${input.sceneId}Composition`,
            purpose: "Measure the test surface.",
            origin: { x: 0, y: 0, z: 0 },
            uAxis: { x: 1, y: 0, z: 0 },
            vAxis: { x: 0, y: 0, z: 1 },
            boundary: footprint.map((point) => ({ u: point.x, v: point.z })),
            densityTarget: 1,
            minimumNegativeSpace: 0,
            surfaceId: input.surfaceId,
          },
        ],
        refinementPriority: 100,
      },
    ],
    regionRelations: [],
    terrainPlans: [
      {
        kind: "TerrainPlan",
        abi: TERRAIN_PLAN_ABI,
        id: `${input.sceneId}Terrain`,
        surfaceId: input.surfaceId,
        seed: 42017,
        bounds: { x: { minimum: -30, maximum: 30 }, z: { minimum: -30, maximum: 30 } },
        resolution: { columns: 31, rows: 31 },
        regions: [
          {
            regionId: input.regionId,
            footprint,
            blendWidth: 4,
            baseElevation: 0,
            noiseLayers: [],
            materialWeights: [{ materialId: input.materialId, weight: 1 }],
          },
        ],
        operations: [],
        navigation: { maximumSlopeDegrees: 30 },
      },
    ],
    constructedSurfaces: [],
    routes: [
      {
        id: input.routeId,
        name: "Test route",
        surfaceId: input.surfaceId,
        regionIds: [input.regionId],
        points: [
          { x: -20, y: 0, z: 0 },
          { x: 20, y: 0, z: 0 },
        ],
        width: 6,
        heightClearance: 8,
        agentRadius: 1,
        agentHeight: 6,
        maximumStepHeight: 1,
        maximumSlopeDegrees: 30,
        closed: false,
        reachableAnchorIds: [input.anchorId],
      },
    ],
    anchors: [
      {
        id: input.anchorId,
        regionId: input.regionId,
        type: "spawn",
        position: { x: -18, y: 0, z: 0 },
        bindingName: `${input.sceneId}Spawn`,
      },
    ],
    collisionProxies: [
      {
        id: `${input.sceneId}Ground`,
        regionId: input.regionId,
        placementAuthority: { kind: "surface_substrate", surfaceId: input.surfaceId },
        shape: "box",
        position: { x: 0, y: -1, z: 0 },
        rotationDegrees: { x: 0, y: 0, z: 0 },
        size: { x: 60, y: 2, z: 60 },
        canCollide: true,
      },
    ],
    cameras: [
      {
        id: input.cameraId,
        name: "Test overview",
        purpose: "Show the bounded test world.",
        evidenceRole: "global_overview",
        position: { x: 28, y: 18, z: 32 },
        lookAt: { x: 4, y: 6, z: 8 },
        up: { x: 0, y: 1, z: 0 },
        fieldOfViewDegrees: 55,
        nearClip: 0.1,
        farClip: 1000,
        width: 1280,
        height: 720,
        regionIds: [input.regionId],
        framingAssetIds: [],
        readabilityIntent: { kind: "art_directed", rationale: "Test readability." },
        declaredState: "Overview",
      },
    ],
    assetRequirements: [],
    tolerances: { support: 0.05, penetration: 0.05, clearance: 1 },
  });
}
